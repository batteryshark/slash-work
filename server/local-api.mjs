import { createServer, request as httpRequest } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  WorkspaceError,
  appendTaskLog,
  applyDecisionAction,
  createCapture,
  createDecision,
  createIdea,
  createIssue,
  createNote,
  createProject,
  createTask,
  deleteCapture,
  deleteIdea,
  deleteNote,
  discoverProjects,
  getIssue,
  initializeWorkspace,
  getTask,
  initializeProject,
  listCaptures,
  listDecisions,
  listIdeas,
  listIssues,
  listNotes,
  listTasks,
  moveTask,
  claimIssue,
  replyToIssue,
  toggleTaskChecklist,
  updateCaptureDestination,
  updateIdea,
  updateIssue,
  updateIssueState,
  updateNote,
  updateProjectProfile,
  updateTask,
  validateProjectScopePath,
  workspaceSnapshot,
} from "../lib/local-workspace.mjs";
import { listFiles, readFilePreview } from "../lib/file-browser.mjs";
import { chooseWorkspaceDirectory } from "../lib/native-folder-picker.mjs";
import { registerWorkspace, unregisterWorkspace } from "../lib/workspace-registry.mjs";
import {
  getAgentIndex,
  getAgentOpenApi,
  getAgentOperation,
  getArtifactSchema,
  listAgentOperations,
} from "../lib/agent-capabilities.mjs";
import { isTailscaleIPv4 } from "../lib/tailscale-network.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 43170;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_MCP_BODY_BYTES = 1024 * 1024;
const UPDATE_CACHE_MS = 15 * 60 * 1000;
const CLIENT_API_VERSION = 1;
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function requestOrigin(request) {
  const origin = request.headers.origin;
  return typeof origin === "string" ? origin : null;
}

function responseHeaders(request, extra = {}) {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
  const origin = requestOrigin(request);
  if (origin && (LOCAL_ORIGIN.test(origin) || request.workBrowserOrigin === origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Expose-Headers"] = "ETag, X-Work-Workspace";
    headers.Vary = "Origin";
  }
  if (request.workWorkspaceId) {
    headers["X-Work-Workspace"] = request.workWorkspaceId;
    headers.Vary = headers.Vary ? `${headers.Vary}, X-Work-Workspace` : "X-Work-Workspace";
  }
  return headers;
}

function sendJson(request, response, status, body, extraHeaders = {}) {
  const content = `${JSON.stringify(body)}\n`;
  response.writeHead(
    status,
    responseHeaders(request, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(content),
      ...extraHeaders,
    }),
  );
  response.end(content);
}

function entityTag(content, prefix) {
  const digest = createHash("sha256").update(content).digest("base64url");
  return `"${prefix}-${digest}"`;
}

function sendWorkspaceSnapshot(request, response, snapshot) {
  const serialized = `${JSON.stringify(snapshot)}\n`;
  const etag = entityTag(serialized, "workspace-v1");
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, responseHeaders(request, { ETag: etag }));
    response.end();
    return;
  }
  sendJson(request, response, 200, snapshot, { ETag: etag });
}

function sendEmpty(request, response, status = 204) {
  response.writeHead(status, responseHeaders(request));
  response.end();
}

function isAllowedBrowserOrigin(origin, host) {
  if (LOCAL_ORIGIN.test(origin)) return true;
  try {
    const url = new URL(origin);
    return new Set(["http:", "https:"]).has(url.protocol) && url.hostname === host;
  } catch {
    return false;
  }
}

function assertLocalRequest(request, allowedHost) {
  const requestHost = request.headers.host;
  if (typeof requestHost !== "string") {
    throw new WorkspaceError("A local Host header is required.", { code: "invalid_host", status: 403 });
  }
  let hostname;
  try {
    hostname = new URL(`http://${requestHost}`).hostname;
  } catch {
    throw new WorkspaceError("Invalid Host header.", { code: "invalid_host", status: 403 });
  }
  if (!isLocalHostname(hostname) && hostname !== allowedHost) {
    throw new WorkspaceError("This API only accepts requests for its configured interface.", { code: "invalid_host", status: 403 });
  }
  const origin = requestOrigin(request);
  if (origin && !isAllowedBrowserOrigin(origin, allowedHost)) {
    throw new WorkspaceError("This API only accepts browser origins for its configured interface.", { code: "invalid_origin", status: 403 });
  }
  if (origin) request.workBrowserOrigin = origin;
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new WorkspaceError("Content-Type must be application/json.", {
      code: "invalid_content_type",
      status: 415,
    });
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new WorkspaceError("Request body is too large.", { code: "body_too_large", status: 413 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new WorkspaceError("Request body is too large.", { code: "body_too_large", status: 413 });
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    throw new WorkspaceError("A JSON request body is required.", { code: "invalid_json" });
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected object");
    return body;
  } catch {
    throw new WorkspaceError("Request body must be a JSON object.", { code: "invalid_json" });
  }
}

function routeId(pathname, resource, suffix = "") {
  const pattern = new RegExp(`^/api/${resource}/([^/]+)${suffix}$`);
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new WorkspaceError("Invalid record id.", { code: "invalid_id" });
  }
}

function requiredAgentName(request) {
  const value = request.headers["x-work-agent"];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceError("Agent operations require X-Work-Agent.", { code: "agent_identity_required", status: 400 });
  }
  const name = value.trim();
  if (name.length > 120 || /[\r\n]/.test(name)) {
    throw new WorkspaceError("X-Work-Agent must be a one-line name of at most 120 characters.", { code: "invalid_agent_identity" });
  }
  return name;
}

function optionalAgentName(request) {
  return request.headers["x-work-agent"] == null ? null : requiredAgentName(request);
}

function updatedSinceCutoff(url) {
  const value = url.searchParams.get("updatedSince");
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new WorkspaceError("updatedSince must be an ISO-8601 date/time.", { code: "invalid_input" });
  }
  return parsed.getTime();
}

// ponytail: filters after reading every record; parse per-record frontmatter (or index updated timestamps) if polling cost matters.
function filterUpdatedSince(records, cutoff) {
  if (cutoff == null) return records;
  return records.filter((record) => new Date(record.updatedAt ?? 0).getTime() > cutoff);
}

function publicWorkspace(workspace) {
  return { id: workspace.id, name: workspace.name, root: workspace.root };
}

function selectedWorkspace(workspaces, defaultWorkspace, request) {
  const requestedId = request.headers["x-work-workspace"];
  if (requestedId == null || requestedId === "") {
    request.workWorkspaceId = defaultWorkspace.id;
    return defaultWorkspace;
  }
  if (typeof requestedId !== "string") {
    throw new WorkspaceError("A single workspace id is required.", { code: "invalid_workspace", status: 400 });
  }
  const workspace = workspaces.get(requestedId);
  if (!workspace) {
    throw new WorkspaceError("That workspace is not registered with this Work server.", {
      code: "workspace_not_found",
      status: 404,
    });
  }
  request.workWorkspaceId = workspace.id;
  return workspace;
}

function proxyMcpRequest(service, request, response) {
  const sidecar = service.mcp;
  if (!sidecar?.ready) {
    sendJson(request, response, 503, { error: { code: "mcp_unavailable", message: "The MCP sidecar is unavailable." } });
    return;
  }
  if (!new Set(["GET", "POST", "DELETE"]).has(request.method ?? "GET")) {
    sendJson(request, response, 405, { error: { code: "mcp_method_not_allowed", message: "That MCP method is not supported." } }, { Allow: "GET, POST, DELETE" });
    return;
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_BODY_BYTES) {
    sendJson(request, response, 413, { error: { code: "body_too_large", message: "MCP request body is too large." } });
    return;
  }
  let received = 0;
  const headers = {};
  const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
  for (const [name, value] of Object.entries(request.headers)) {
    if (hopByHop.has(name) || value == null) continue;
    headers[name] = value;
  }
  headers.host = `127.0.0.1:${sidecar.port}`;
  headers["x-work-mcp-proxy"] = sidecar.secret;
  const upstream = httpRequest({ host: "127.0.0.1", port: sidecar.port, method: request.method, path: request.url, headers }, (upstreamResponse) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (!hopByHop.has(name) && value != null) responseHeaders[name] = value;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(15_000, () => upstream.destroy(new Error("MCP sidecar request timed out.")));
  upstream.once("error", () => {
    if (!response.headersSent) sendJson(request, response, 503, { error: { code: "mcp_unavailable", message: "The MCP sidecar is unavailable." } });
    else response.destroy();
  });
  request.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_MCP_BODY_BYTES) request.destroy(new WorkspaceError("MCP request body is too large.", { code: "body_too_large", status: 413 }));
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

async function handleRequest(workspaces, service, request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const method = request.method ?? "GET";
  const defaultWorkspace = service.defaultWorkspace;
  assertLocalRequest(request, service.host);

  if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
    proxyMcpRequest(service, request, response);
    return;
  }

  if (method === "OPTIONS") {
    response.writeHead(
      204,
      responseHeaders(request, {
        "Access-Control-Allow-Headers": "Content-Type, If-None-Match, X-Work-Agent, X-Work-Folder-Picker, X-Work-Restart, X-Work-Unregister, X-Work-Workspace",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Max-Age": "600",
      }),
    );
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/api/workspaces") {
    sendJson(request, response, 200, {
      defaultWorkspaceId: defaultWorkspace.id,
      activeWorkspaceId: defaultWorkspace.id,
      workspaces: [...workspaces.values()].map(publicWorkspace),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/agent") {
    sendJson(request, response, 200, getAgentIndex({ serviceVersion: service.version }));
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/operations") {
    sendJson(request, response, 200, listAgentOperations({ serviceVersion: service.version }));
    return;
  }
  const agentOperationId = routeId(url.pathname, "agent/operations");
  if (method === "GET" && agentOperationId) {
    const operation = getAgentOperation(agentOperationId, { serviceVersion: service.version });
    if (!operation) throw new WorkspaceError("Agent operation not found.", { code: "not_found", status: 404 });
    sendJson(request, response, 200, operation);
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/schemas/artifacts") {
    sendJson(request, response, 200, getArtifactSchema());
    return;
  }
  const artifactSchemaType = routeId(url.pathname, "agent/schemas/artifacts");
  if (method === "GET" && artifactSchemaType) {
    const schema = getArtifactSchema(artifactSchemaType);
    if (!schema) throw new WorkspaceError("Artifact schema not found.", { code: "not_found", status: 404 });
    sendJson(request, response, 200, schema);
    return;
  }
  if (method === "GET" && url.pathname === "/api/openapi.json") {
    sendJson(request, response, 200, getAgentOpenApi({ serviceVersion: service.version }));
    return;
  }

  if (method === "POST" && url.pathname === "/api/workspaces/pick") {
    if (request.headers["x-work-folder-picker"] !== "confirm") {
      throw new WorkspaceError("Opening the folder picker requires explicit local confirmation.", {
        code: "folder_picker_confirmation_required",
        status: 403,
      });
    }
    const body = await readJsonBody(request);
    if (body.confirm !== true) {
      throw new WorkspaceError("Opening the folder picker requires confirm: true.", {
        code: "folder_picker_confirmation_required",
        status: 400,
      });
    }
    const selectedDirectory = await service.pickWorkspaceDirectory();
    if (!selectedDirectory) {
      sendJson(request, response, 200, { cancelled: true });
      return;
    }
    const added = await registerWorkspace(selectedDirectory, {
      force: true,
      registryPath: service.registryPath,
    });
    workspaces.set(added.id, added);
    sendJson(request, response, 201, {
      cancelled: false,
      workspace: publicWorkspace(added),
      workspaces: [...workspaces.values()].map(publicWorkspace),
    });
    return;
  }

  const workspaceToRemove = routeId(url.pathname, "workspaces");
  if (method === "DELETE" && workspaceToRemove) {
    if (request.headers["x-work-unregister"] !== "confirm") {
      throw new WorkspaceError("Removing a workspace root requires explicit local confirmation.", {
        code: "workspace_removal_confirmation_required",
        status: 403,
      });
    }
    const currentWorkspaceId = typeof request.headers["x-work-workspace"] === "string"
      ? request.headers["x-work-workspace"]
      : defaultWorkspace.id;
    if (workspaceToRemove === currentWorkspaceId) {
      throw new WorkspaceError("Switch to another workspace before removing this root from the list.", {
        code: "cannot_remove_current_workspace",
        status: 409,
      });
    }
    if (!workspaces.has(workspaceToRemove)) {
      throw new WorkspaceError("That workspace root is not in the list.", {
        code: "workspace_not_found",
        status: 404,
      });
    }
    if (workspaces.size === 1) {
      throw new WorkspaceError("Keep at least one local workspace registered with this Work server.", {
        code: "cannot_remove_last_local_workspace",
        status: 409,
      });
    }
    await unregisterWorkspace(workspaceToRemove, { registryPath: service.registryPath });
    workspaces.delete(workspaceToRemove);
    if (service.defaultWorkspace.id === workspaceToRemove) {
      service.defaultWorkspace = [...workspaces.values()][0];
    }
    sendJson(request, response, 200, {
      removedWorkspaceId: workspaceToRemove,
      defaultWorkspaceId: service.defaultWorkspace.id,
      activeWorkspaceId: service.defaultWorkspace.id,
      workspaces: [...workspaces.values()].map(publicWorkspace),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/service/restart") {
    if (typeof service.onRestart !== "function") {
      throw new WorkspaceError("This Work process cannot restart itself.", {
        code: "restart_unavailable",
        status: 409,
      });
    }
    if (request.headers["x-work-restart"] !== "confirm") {
      throw new WorkspaceError("Restart requires explicit local confirmation.", {
        code: "restart_confirmation_required",
        status: 403,
      });
    }
    if (service.restartPending) {
      throw new WorkspaceError("Work is already restarting.", {
        code: "restart_pending",
        status: 409,
      });
    }
    const body = await readJsonBody(request);
    if (body.confirm !== true) {
      throw new WorkspaceError("Restart requires confirm: true.", {
        code: "restart_confirmation_required",
        status: 400,
      });
    }
    service.restartPending = true;
    sendJson(request, response, 202, {
      restarting: true,
      serviceInstanceId: service.instanceId,
    });
    setTimeout(() => {
      Promise.resolve(service.onRestart()).catch((error) => console.error("[work] Restart failed:", error));
    }, 100).unref();
    return;
  }

  if (method === "GET" && url.pathname === "/api/service/update") {
    if (typeof service.checkForUpdate !== "function") {
      throw new WorkspaceError("This Work process cannot check for npm updates.", {
        code: "update_check_unavailable",
        status: 409,
      });
    }
    const force = url.searchParams.get("force") === "1";
    const cachedAt = service.updateStatus?.checkedAt ? new Date(service.updateStatus.checkedAt).getTime() : 0;
    if (force || !service.updateStatus || Date.now() - cachedAt >= UPDATE_CACHE_MS) {
      service.updateStatus = await service.checkForUpdate();
    }
    sendJson(request, response, 200, service.updateStatus);
    return;
  }

  if (method === "POST" && url.pathname === "/api/service/update") {
    if (typeof service.onUpdate !== "function" || typeof service.onRestart !== "function") {
      throw new WorkspaceError("This Work process cannot install and restart after an npm update.", {
        code: "update_unavailable",
        status: 409,
      });
    }
    if (request.headers["x-work-update"] !== "confirm") {
      throw new WorkspaceError("Installing an update requires explicit local confirmation.", {
        code: "update_confirmation_required",
        status: 403,
      });
    }
    if (service.updatePending || service.restartPending) {
      throw new WorkspaceError("Work is already updating or restarting.", {
        code: "update_pending",
        status: 409,
      });
    }
    const body = await readJsonBody(request);
    if (body.confirm !== true) {
      throw new WorkspaceError("Installing an update requires confirm: true.", {
        code: "update_confirmation_required",
        status: 400,
      });
    }
    const update = await service.checkForUpdate();
    service.updateStatus = update;
    if (!update.updateAvailable) {
      throw new WorkspaceError("Work is already up to date.", { code: "already_current", status: 409 });
    }
    if (!update.installable) {
      throw new WorkspaceError("This Work process is running from a source checkout. Update that checkout with Git instead.", {
        code: "source_checkout_update",
        status: 409,
      });
    }
    service.updatePending = true;
    try {
      await service.onUpdate(update.latestVersion);
      service.restartPending = true;
      sendJson(request, response, 202, {
        updating: true,
        installedVersion: update.latestVersion,
        serviceInstanceId: service.instanceId,
      });
      setTimeout(() => {
        Promise.resolve(service.onRestart()).catch((error) => console.error("[work] Restart after update failed:", error));
      }, 100).unref();
    } catch (error) {
      service.updatePending = false;
      throw new WorkspaceError(`The npm update could not be installed: ${error.message}`, {
        code: "update_install_failed",
        status: 502,
      });
    }
    return;
  }

  const workspace = selectedWorkspace(workspaces, defaultWorkspace, request);

  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(request, response, 200, {
      ok: true,
      api: {
        version: CLIENT_API_VERSION,
        capabilities: ["workspace-directory", "workspace-snapshot", "workspace-etag", "artifact-mutations"],
      },
      service: {
        instanceId: service.instanceId,
        restartable: typeof service.onRestart === "function",
        version: service.version,
        updatePending: service.updatePending,
      },
      ...(service.mcp ? { mcp: { enabled: true, ready: service.mcp.ready, path: "/mcp" } } : {}),
      workspace: { id: workspace.id, name: workspace.name, root: workspace.root },
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/workspace") {
    sendWorkspaceSnapshot(request, response, await workspaceSnapshot(workspace));
    return;
  }
  if (method === "GET" && url.pathname === "/api/needs-you") {
    const [tasks, issues, decisions] = await Promise.all([
      listTasks(workspace),
      listIssues(workspace),
      listDecisions(workspace),
    ]);
    const entries = [
      ...tasks.filter((task) => task.status === "blocked").map((task) => ({ type: "task", id: task.id, title: task.title, updatedAt: task.updatedAt, projectPath: task.projectPath })),
      ...issues.filter((issue) => issue.state === "needs_human").map((issue) => ({ type: "issue", id: issue.id, title: issue.title, updatedAt: issue.updatedAt, projectPath: issue.projectPath })),
      ...decisions.filter((decision) => decision.status === "open").map((decision) => ({ type: "decision", id: decision.id, title: decision.title, updatedAt: decision.updatedAt, projectPath: decision.projectPath })),
    ].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
    sendJson(request, response, 200, { entries });
    return;
  }
  if (method === "GET" && url.pathname === "/api/projects") {
    sendJson(request, response, 200, { projects: await discoverProjects(workspace.root) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/projects") {
    const body = await readJsonBody(request);
    sendJson(request, response, 201, body?.projectPath == null && body?.name != null
      ? await createProject(workspace, { name: body.name, parentPath: body.parentPath })
      : await initializeProject(workspace, body?.projectPath));
    return;
  }
  if (method === "PATCH" && url.pathname === "/api/projects/profile") {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 200, await updateProjectProfile(workspace, body?.projectPath, body, projects));
    return;
  }
  if (method === "GET" && url.pathname === "/api/files/directory") {
    sendJson(request, response, 200, await listFiles(workspace, {
      scopePath: url.searchParams.get("scopePath") ?? ".",
      path: url.searchParams.get("path") ?? ".",
    }));
    return;
  }
  if (method === "GET" && url.pathname === "/api/files/content") {
    sendJson(request, response, 200, await readFilePreview(workspace, {
      scopePath: url.searchParams.get("scopePath") ?? ".",
      path: url.searchParams.get("path"),
    }));
    return;
  }
  if (method === "GET" && url.pathname === "/api/captures") {
    sendJson(request, response, 200, { captures: await listCaptures(workspace) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/captures") {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 201, await createCapture(workspace, body, projects));
    return;
  }
  const captureId = routeId(url.pathname, "captures");
  if (method === "PATCH" && captureId) {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 200, await updateCaptureDestination(workspace, captureId, body, projects));
    return;
  }
  if (method === "DELETE" && captureId) {
    await deleteCapture(workspace, captureId);
    sendEmpty(request, response);
    return;
  }
  if (method === "GET" && url.pathname === "/api/notes") {
    sendJson(request, response, 200, { notes: await listNotes(workspace) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/notes") {
    const agentName = requiredAgentName(request);
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 201, await createNote(workspace, body, projects, {
      createdBy: { kind: "agent", name: agentName },
    }));
    return;
  }
  const agentNoteId = routeId(url.pathname, "agent/notes");
  if (method === "PATCH" && agentNoteId) {
    const agentName = requiredAgentName(request);
    sendJson(request, response, 200, await updateNote(workspace, agentNoteId, await readJsonBody(request), { agentName }));
    return;
  }
  if (method === "DELETE" && agentNoteId) {
    const agentName = requiredAgentName(request);
    await deleteNote(workspace, agentNoteId, { agentName });
    sendEmpty(request, response);
    return;
  }
  if (method === "POST" && url.pathname === "/api/notes") {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 201, await createNote(workspace, body, projects));
    return;
  }
  const noteId = routeId(url.pathname, "notes");
  if (method === "PATCH" && noteId) {
    sendJson(request, response, 200, await updateNote(workspace, noteId, await readJsonBody(request)));
    return;
  }
  if (method === "DELETE" && noteId) {
    await deleteNote(workspace, noteId);
    sendEmpty(request, response);
    return;
  }
  if (method === "GET" && url.pathname === "/api/issues") {
    sendJson(request, response, 200, { issues: filterUpdatedSince(await listIssues(workspace), updatedSinceCutoff(url)) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/issues") {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 201, await createIssue(workspace, body, projects));
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/issues") {
    requiredAgentName(request);
    sendJson(request, response, 200, { issues: filterUpdatedSince(await listIssues(workspace), updatedSinceCutoff(url)) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/issues") {
    const agentName = requiredAgentName(request);
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 201, await createIssue(workspace, body, projects, { agentName }));
    return;
  }
  const issueReplyId = routeId(url.pathname, "issues", "/replies");
  if (method === "POST" && issueReplyId) {
    sendJson(request, response, 200, await replyToIssue(workspace, issueReplyId, await readJsonBody(request)));
    return;
  }
  const issueStateId = routeId(url.pathname, "issues", "/state");
  if (method === "POST" && issueStateId) {
    sendJson(request, response, 200, await updateIssueState(workspace, issueStateId, await readJsonBody(request)));
    return;
  }
  const agentIssueClaimId = routeId(url.pathname, "agent/issues", "/claim");
  if (method === "POST" && agentIssueClaimId) {
    const agentName = requiredAgentName(request);
    sendJson(request, response, 200, await claimIssue(workspace, agentIssueClaimId, agentName));
    return;
  }
  const agentIssueReplyId = routeId(url.pathname, "agent/issues", "/replies");
  if (method === "POST" && agentIssueReplyId) {
    const agentName = requiredAgentName(request);
    sendJson(request, response, 200, await replyToIssue(workspace, agentIssueReplyId, await readJsonBody(request), { agentName }));
    return;
  }
  const agentIssueStateId = routeId(url.pathname, "agent/issues", "/state");
  if (method === "POST" && agentIssueStateId) {
    const agentName = requiredAgentName(request);
    sendJson(request, response, 200, await updateIssueState(workspace, agentIssueStateId, await readJsonBody(request), { agentName }));
    return;
  }
  const agentIssueId = routeId(url.pathname, "agent/issues");
  if (method === "GET" && agentIssueId) {
    requiredAgentName(request);
    sendJson(request, response, 200, await getIssue(workspace, agentIssueId));
    return;
  }
  const issueId = routeId(url.pathname, "issues");
  if (method === "GET" && issueId) {
    sendJson(request, response, 200, await getIssue(workspace, issueId));
    return;
  }
  if (method === "PATCH" && issueId) {
    sendJson(request, response, 200, await updateIssue(workspace, issueId, await readJsonBody(request)));
    return;
  }
  if (method === "GET" && url.pathname === "/api/ideas") {
    sendJson(request, response, 200, { ideas: await listIdeas(workspace) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/ideas") {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 201, await createIdea(workspace, body, projects));
    return;
  }
  const ideaId = routeId(url.pathname, "ideas");
  if (method === "PATCH" && ideaId) {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 200, await updateIdea(workspace, ideaId, body, projects));
    return;
  }
  if (method === "DELETE" && ideaId) {
    await deleteIdea(workspace, ideaId);
    sendEmpty(request, response);
    return;
  }
  if (method === "GET" && url.pathname === "/api/decisions") {
    sendJson(request, response, 200, { decisions: await listDecisions(workspace) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/decisions") {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 201, await createDecision(workspace, body, projects));
    return;
  }
  const decisionId = routeId(url.pathname, "decisions", "/actions");
  if (method === "POST" && decisionId) {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 200, await applyDecisionAction(workspace, decisionId, body, projects));
    return;
  }

  if (method === "GET" && url.pathname === "/api/tasks") {
    sendJson(request, response, 200, { tasks: filterUpdatedSince(await listTasks(workspace), updatedSinceCutoff(url)) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 201, await createTask(workspace, body, projects));
    return;
  }
  const taskId = routeId(url.pathname, "tasks");
  if (method === "GET" && taskId) {
    sendJson(request, response, 200, await getTask(workspace, taskId));
    return;
  }
  if (method === "PATCH" && taskId) {
    const body = await readJsonBody(request);
    const projects = await discoverProjects(workspace.root);
    sendJson(request, response, 200, await updateTask(workspace, taskId, body, projects, { agentName: optionalAgentName(request) }));
    return;
  }
  const moveTaskId = routeId(url.pathname, "tasks", "/move");
  if (method === "POST" && moveTaskId) {
    const agentName = optionalAgentName(request);
    sendJson(request, response, 200, await moveTask(workspace, moveTaskId, await readJsonBody(request), { agentName }));
    return;
  }
  const checklistTaskId = routeId(url.pathname, "tasks", "/checklist");
  if (method === "POST" && checklistTaskId) {
    sendJson(request, response, 200, await toggleTaskChecklist(workspace, checklistTaskId, await readJsonBody(request)));
    return;
  }
  const logTaskId = routeId(url.pathname, "tasks", "/log");
  if (method === "POST" && logTaskId) {
    sendJson(request, response, 200, await appendTaskLog(workspace, logTaskId, await readJsonBody(request)));
    return;
  }

  sendJson(request, response, 404, { error: { code: "not_found", message: "API route not found." } });
}

function errorResponse(request, response, error) {
  const known = error instanceof WorkspaceError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "internal_error";
  const message = known ? error.message : "The local workspace API could not complete the request.";
  if (!response.headersSent) sendJson(request, response, status, { error: { code, message } });
  else response.destroy();
  if (!known) console.error(error);
}

export async function startLocalApi({
  root = process.cwd(),
  roots = null,
  defaultWorkspaceId = null,
  port = DEFAULT_PORT,
  host = LOOPBACK_HOST,
  forceNewWorkspace = false,
  onRestart = null,
  version = null,
  checkForUpdate = null,
  onUpdate = null,
  pickWorkspaceDirectory = chooseWorkspaceDirectory,
  registryPath = undefined,
  fallbackOnPortConflict = false,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new WorkspaceError("port must be an integer between 0 and 65535.", { code: "invalid_port" });
  }
  if (host !== LOOPBACK_HOST && !isTailscaleIPv4(host)) {
    throw new WorkspaceError("host must be 127.0.0.1 or a Tailscale IPv4 address.", { code: "invalid_listen_host" });
  }
  if (onRestart != null && typeof onRestart !== "function") {
    throw new WorkspaceError("onRestart must be a function.", { code: "invalid_restart_handler" });
  }
  if (checkForUpdate != null && typeof checkForUpdate !== "function") {
    throw new WorkspaceError("checkForUpdate must be a function.", { code: "invalid_update_checker" });
  }
  if (onUpdate != null && typeof onUpdate !== "function") {
    throw new WorkspaceError("onUpdate must be a function.", { code: "invalid_update_handler" });
  }
  if (typeof pickWorkspaceDirectory !== "function") {
    throw new WorkspaceError("pickWorkspaceDirectory must be a function.", { code: "invalid_folder_picker" });
  }
  if (typeof fallbackOnPortConflict !== "boolean") {
    throw new WorkspaceError("fallbackOnPortConflict must be a boolean.", { code: "invalid_port_fallback" });
  }
  const requestedDirectory = await realpath(root);
  const initialRoots = Array.isArray(roots) && roots.length > 0 ? roots : [root];
  const initialized = [];
  for (const candidate of initialRoots) {
    initialized.push(await initializeWorkspace(candidate, {
      force: forceNewWorkspace && resolve(candidate) === resolve(root),
    }));
  }
  const workspaces = new Map(initialized.map((item) => [item.id, item]));
  const workspace = (defaultWorkspaceId && workspaces.get(defaultWorkspaceId)) ?? initialized.find((item) => item.root === requestedDirectory) ?? initialized[0];
  const relativeStart = relative(workspace.root, requestedDirectory);
  const projects = await discoverProjects(workspace.root);
  workspace.startScopePath = relativeStart === ""
    ? "."
    : relativeStart !== ".." && !relativeStart.startsWith(`..${sep}`) && !isAbsolute(relativeStart)
      ? await validateProjectScopePath(workspace.root, relativeStart.split(sep).join("/"), projects)
      : ".";
  const service = {
    instanceId: randomUUID(),
    host,
    defaultWorkspace: workspace,
    onRestart,
    version,
    checkForUpdate,
    onUpdate,
    restartPending: false,
    updatePending: false,
    updateStatus: null,
    pickWorkspaceDirectory,
    registryPath,
    mcp: null,
  };
  const server = createServer((request, response) => {
    handleRequest(workspaces, service, request, response).catch((error) => errorResponse(request, response, error));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  const listen = (selectedPort) => new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(selectedPort, host);
  });

  try {
    await listen(port);
  } catch (error) {
    if (!fallbackOnPortConflict || port === 0 || error?.code !== "EADDRINUSE") throw error;
    await listen(0);
  }

  const address = server.address();
  const selectedPort = typeof address === "object" && address ? address.port : port;
  const origin = `http://${host}:${selectedPort}`;
  return {
    server,
    origin,
    port: selectedPort,
    workspace,
    workspaces: [...workspaces.values()],
    configureMcp(mcp) {
      if (!mcp || !Number.isInteger(mcp.port) || typeof mcp.secret !== "string") {
        throw new WorkspaceError("Invalid MCP sidecar.", { code: "invalid_mcp_sidecar" });
      }
      service.mcp = mcp;
    },
  };
}

export async function closeLocalApi(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}
