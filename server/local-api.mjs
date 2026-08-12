import { createServer, request as httpRequest } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  WorkspaceError,
  appendTaskLog,
  applyDecisionAction,
  createCapture,
  createDecision,
  createIssue,
  createNote,
  createProject,
  createTask,
  deleteCapture,
  deleteNote,
  deleteProject,
  discoverProjects,
  getIssue,
  initializeWorkspace,
  getTask,
  initializeProject,
  listCaptures,
  listDecisions,
  listIssues,
  listNotes,
  listTasks,
  moveTask,
  claimIssue,
  replyToIssue,
  toggleTaskChecklist,
  updateCaptureDestination,
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
import { buildFingerprint } from "../lib/build-fingerprint.mjs";
import {
  getAgentIndex,
  getAgentOpenApi,
  getAgentOperation,
  listAgentOperations,
} from "../lib/agent-capabilities.mjs";
import { isTailscaleIPv4 } from "../lib/tailscale-network.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 43170;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_MCP_BODY_BYTES = 1024 * 1024;
const UPDATE_CACHE_MS = 15 * 60 * 1000;
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

// ponytail: filters after reading every record; parse per-record frontmatter (or index updated timestamps) if polling cost matters.
function filterUpdatedSince(records, url) {
  const value = url.searchParams.get("updatedSince");
  if (value == null || value === "") return records;
  const cutoff = new Date(value);
  if (Number.isNaN(cutoff.valueOf())) {
    throw new WorkspaceError("updatedSince must be an ISO-8601 date/time.", { code: "invalid_input" });
  }
  return records.filter((record) => new Date(record.updatedAt ?? 0).getTime() > cutoff.getTime());
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

// Routes are matched in table order; keep more specific patterns (and the
// agent/… prefixes) above their generic siblings, exactly like the old
// if-chain. A handler either returns [status, body, extraHeaders?] for a JSON
// response or writes the response itself and returns nothing.
function route(method, pattern, handler) {
  const match = pattern.includes("{id}") ? new RegExp(`^${pattern.replace("{id}", "([^/]+)")}$`) : null;
  return { method, pattern, match, handler };
}

async function dispatch(routes, context) {
  const { request, url } = context;
  for (const { method, pattern, match, handler } of routes) {
    let id = null;
    if (match) {
      const found = url.pathname.match(match);
      if (!found) continue;
      try {
        id = decodeURIComponent(found[1]);
      } catch {
        throw new WorkspaceError("Invalid record id.", { code: "invalid_id" });
      }
    } else if (url.pathname !== pattern) {
      continue;
    }
    if ((request.method ?? "GET") !== method) continue;
    const result = await handler({ ...context, id });
    if (result) sendJson(request, context.response, result[0], result[1], result[2]);
    return true;
  }
  return false;
}

const SERVICE_ROUTES = [
  route("GET", "/api/workspaces", (c) => [200, {
    defaultWorkspaceId: c.service.defaultWorkspace.id,
    activeWorkspaceId: c.service.defaultWorkspace.id,
    workspaces: [...c.workspaces.values()].map(publicWorkspace),
  }]),
  route("GET", "/api/agent", (c) => [200, getAgentIndex({ serviceVersion: c.service.version })]),
  route("GET", "/api/agent/operations", (c) => [200, listAgentOperations({ serviceVersion: c.service.version })]),
  route("GET", "/api/agent/operations/{id}", (c) => {
    const operation = getAgentOperation(c.id, { serviceVersion: c.service.version });
    if (!operation) throw new WorkspaceError("Agent operation not found.", { code: "not_found", status: 404 });
    return [200, operation];
  }),
  route("GET", "/api/openapi.json", (c) => [200, getAgentOpenApi({ serviceVersion: c.service.version })]),
  route("POST", "/api/workspaces/pick", async (c) => {
    if (c.request.headers["x-work-folder-picker"] !== "confirm") {
      throw new WorkspaceError("Opening the folder picker requires explicit local confirmation.", {
        code: "folder_picker_confirmation_required",
        status: 403,
      });
    }
    if ((await c.body()).confirm !== true) {
      throw new WorkspaceError("Opening the folder picker requires confirm: true.", {
        code: "folder_picker_confirmation_required",
        status: 400,
      });
    }
    const selectedDirectory = await c.service.pickWorkspaceDirectory();
    if (!selectedDirectory) return [200, { cancelled: true }];
    const added = await registerWorkspace(selectedDirectory, {
      force: true,
      registryPath: c.service.registryPath,
    });
    c.workspaces.set(added.id, added);
    return [201, {
      cancelled: false,
      workspace: publicWorkspace(added),
      workspaces: [...c.workspaces.values()].map(publicWorkspace),
    }];
  }),
  route("DELETE", "/api/workspaces/{id}", async (c) => {
    if (c.request.headers["x-work-unregister"] !== "confirm") {
      throw new WorkspaceError("Removing a workspace root requires explicit local confirmation.", {
        code: "workspace_removal_confirmation_required",
        status: 403,
      });
    }
    const currentWorkspaceId = typeof c.request.headers["x-work-workspace"] === "string"
      ? c.request.headers["x-work-workspace"]
      : c.service.defaultWorkspace.id;
    if (c.id === currentWorkspaceId) {
      throw new WorkspaceError("Switch to another workspace before removing this root from the list.", {
        code: "cannot_remove_current_workspace",
        status: 409,
      });
    }
    if (!c.workspaces.has(c.id)) {
      throw new WorkspaceError("That workspace root is not in the list.", {
        code: "workspace_not_found",
        status: 404,
      });
    }
    if (c.workspaces.size === 1) {
      throw new WorkspaceError("Keep at least one local workspace registered with this Work server.", {
        code: "cannot_remove_last_local_workspace",
        status: 409,
      });
    }
    await unregisterWorkspace(c.id, { registryPath: c.service.registryPath });
    c.workspaces.delete(c.id);
    if (c.service.defaultWorkspace.id === c.id) {
      c.service.defaultWorkspace = [...c.workspaces.values()][0];
    }
    return [200, {
      removedWorkspaceId: c.id,
      defaultWorkspaceId: c.service.defaultWorkspace.id,
      activeWorkspaceId: c.service.defaultWorkspace.id,
      workspaces: [...c.workspaces.values()].map(publicWorkspace),
    }];
  }),
  route("POST", "/api/service/restart", async (c) => {
    const service = c.service;
    if (typeof service.onRestart !== "function") {
      throw new WorkspaceError("This Work process cannot restart itself.", { code: "restart_unavailable", status: 409 });
    }
    if (c.request.headers["x-work-restart"] !== "confirm") {
      throw new WorkspaceError("Restart requires explicit local confirmation.", { code: "restart_confirmation_required", status: 403 });
    }
    if (service.restartPending) {
      throw new WorkspaceError("Work is already restarting.", { code: "restart_pending", status: 409 });
    }
    if ((await c.body()).confirm !== true) {
      throw new WorkspaceError("Restart requires confirm: true.", { code: "restart_confirmation_required", status: 400 });
    }
    service.restartPending = true;
    setTimeout(() => {
      Promise.resolve(service.onRestart()).catch((error) => console.error("[work] Restart failed:", error));
    }, 100).unref();
    return [202, { restarting: true, serviceInstanceId: service.instanceId }];
  }),
  route("GET", "/api/service/update", async (c) => {
    const service = c.service;
    if (typeof service.checkForUpdate !== "function") {
      throw new WorkspaceError("This Work process cannot check for npm updates.", { code: "update_check_unavailable", status: 409 });
    }
    const force = c.url.searchParams.get("force") === "1";
    const cachedAt = service.updateStatus?.checkedAt ? new Date(service.updateStatus.checkedAt).getTime() : 0;
    if (force || !service.updateStatus || Date.now() - cachedAt >= UPDATE_CACHE_MS) {
      service.updateStatus = await service.checkForUpdate();
    }
    return [200, service.updateStatus];
  }),
  route("POST", "/api/service/update", async (c) => {
    const service = c.service;
    if (typeof service.onUpdate !== "function" || typeof service.onRestart !== "function") {
      throw new WorkspaceError("This Work process cannot install and restart after an npm update.", {
        code: "update_unavailable",
        status: 409,
      });
    }
    if (c.request.headers["x-work-update"] !== "confirm") {
      throw new WorkspaceError("Installing an update requires explicit local confirmation.", {
        code: "update_confirmation_required",
        status: 403,
      });
    }
    if (service.updatePending || service.restartPending) {
      throw new WorkspaceError("Work is already updating or restarting.", { code: "update_pending", status: 409 });
    }
    if ((await c.body()).confirm !== true) {
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
      setTimeout(() => {
        Promise.resolve(service.onRestart()).catch((error) => console.error("[work] Restart after update failed:", error));
      }, 100).unref();
      return [202, { updating: true, installedVersion: update.latestVersion, serviceInstanceId: service.instanceId }];
    } catch (error) {
      service.updatePending = false;
      throw new WorkspaceError(`The npm update could not be installed: ${error.message}`, {
        code: "update_install_failed",
        status: 502,
      });
    }
  }),
];

function isStaleBuild(service) {
  return Boolean(service.bootFingerprint) && buildFingerprint() !== service.bootFingerprint;
}

const WORKSPACE_ROUTES = [
  route("GET", "/api/health", (c) => [200, {
    ok: true,
    service: {
      instanceId: c.service.instanceId,
      restartable: typeof c.service.onRestart === "function",
      version: c.service.version,
      updatePending: c.service.updatePending,
      staleBuild: isStaleBuild(c.service),
    },
    ...(c.service.mcp ? { mcp: { enabled: true, ready: c.service.mcp.ready, path: "/mcp" } } : {}),
    workspace: publicWorkspace(c.workspace),
  }]),
  route("GET", "/api/workspace", async (c) => {
    const snapshot = { ...await workspaceSnapshot(c.workspace), staleBuild: isStaleBuild(c.service) };
    const serialized = `${JSON.stringify(snapshot)}\n`;
    // The fingerprint rides in the ETag so a code change alone invalidates the
    // cached snapshot; otherwise the poll 304s and never learns it is stale.
    const etag = `"workspace-v1-${createHash("sha256").update(serialized).digest("base64url")}"`;
    if (c.request.headers["if-none-match"] === etag) {
      c.response.writeHead(304, responseHeaders(c.request, { ETag: etag }));
      c.response.end();
      return;
    }
    return [200, snapshot, { ETag: etag }];
  }),
  route("GET", "/api/needs-you", async (c) => {
    const [tasks, issues, decisions] = await Promise.all([
      listTasks(c.workspace),
      listIssues(c.workspace),
      listDecisions(c.workspace),
    ]);
    const entries = [
      ...tasks.filter((task) => task.status === "blocked").map((task) => ({ type: "task", id: task.id, title: task.title, updatedAt: task.updatedAt, projectPath: task.projectPath })),
      ...issues.filter((issue) => issue.state === "needs_human").map((issue) => ({ type: "issue", id: issue.id, title: issue.title, updatedAt: issue.updatedAt, projectPath: issue.projectPath })),
      ...decisions.filter((decision) => decision.status === "open").map((decision) => ({ type: "decision", id: decision.id, title: decision.title, updatedAt: decision.updatedAt, projectPath: decision.projectPath })),
    ].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
    return [200, { entries }];
  }),
  route("GET", "/api/projects", async (c) => [200, { projects: await c.projects() }]),
  route("POST", "/api/projects", async (c) => {
    const body = await c.body();
    return [201, body?.projectPath == null && body?.name != null
      ? await createProject(c.workspace, { name: body.name, parentPath: body.parentPath })
      : await initializeProject(c.workspace, body?.projectPath)];
  }),
  route("DELETE", "/api/projects", async (c) => {
    // Human-only: a request carrying X-Work-Agent is rejected inside
    // deleteProject with project_delete_forbidden (same guard style as
    // agent_task_edit_forbidden in updateTask).
    const agentName = optionalAgentName(c.request);
    const projectPath = c.url.searchParams.get("projectPath") ?? (await c.body())?.projectPath;
    return [200, await deleteProject(c.workspace, projectPath, { agentName })];
  }),
  route("PATCH", "/api/projects/profile", async (c) => {
    const body = await c.body();
    return [200, await updateProjectProfile(c.workspace, body?.projectPath, body, await c.projects())];
  }),
  route("GET", "/api/files/directory", async (c) => [200, await listFiles(c.workspace, {
    scopePath: c.url.searchParams.get("scopePath") ?? ".",
    path: c.url.searchParams.get("path") ?? ".",
  })]),
  route("GET", "/api/files/content", async (c) => [200, await readFilePreview(c.workspace, {
    scopePath: c.url.searchParams.get("scopePath") ?? ".",
    path: c.url.searchParams.get("path"),
  })]),
  route("GET", "/api/captures", async (c) => [200, { captures: await listCaptures(c.workspace) }]),
  route("POST", "/api/captures", async (c) => [201, await createCapture(c.workspace, await c.body(), await c.projects())]),
  route("PATCH", "/api/captures/{id}", async (c) => [200, await updateCaptureDestination(c.workspace, c.id, await c.body(), await c.projects())]),
  route("DELETE", "/api/captures/{id}", async (c) => {
    await deleteCapture(c.workspace, c.id);
    sendEmpty(c.request, c.response);
  }),
  route("GET", "/api/notes", async (c) => [200, { notes: await listNotes(c.workspace) }]),
  route("POST", "/api/agent/notes", async (c) => {
    const agentName = requiredAgentName(c.request);
    return [201, await createNote(c.workspace, await c.body(), await c.projects(), {
      createdBy: { kind: "agent", name: agentName },
    })];
  }),
  route("PATCH", "/api/agent/notes/{id}", async (c) => {
    const agentName = requiredAgentName(c.request);
    return [200, await updateNote(c.workspace, c.id, await c.body(), { agentName })];
  }),
  route("DELETE", "/api/agent/notes/{id}", async (c) => {
    const agentName = requiredAgentName(c.request);
    await deleteNote(c.workspace, c.id, { agentName });
    sendEmpty(c.request, c.response);
  }),
  route("POST", "/api/notes", async (c) => [201, await createNote(c.workspace, await c.body(), await c.projects())]),
  route("PATCH", "/api/notes/{id}", async (c) => [200, await updateNote(c.workspace, c.id, await c.body())]),
  route("DELETE", "/api/notes/{id}", async (c) => {
    await deleteNote(c.workspace, c.id);
    sendEmpty(c.request, c.response);
  }),
  route("GET", "/api/issues", async (c) => [200, { issues: filterUpdatedSince(await listIssues(c.workspace), c.url) }]),
  route("POST", "/api/issues", async (c) => [201, await createIssue(c.workspace, await c.body(), await c.projects())]),
  route("GET", "/api/agent/issues", async (c) => {
    requiredAgentName(c.request);
    return [200, { issues: filterUpdatedSince(await listIssues(c.workspace), c.url) }];
  }),
  route("POST", "/api/agent/issues", async (c) => {
    const agentName = requiredAgentName(c.request);
    return [201, await createIssue(c.workspace, await c.body(), await c.projects(), { agentName })];
  }),
  route("POST", "/api/issues/{id}/replies", async (c) => [200, await replyToIssue(c.workspace, c.id, await c.body())]),
  route("POST", "/api/issues/{id}/state", async (c) => [200, await updateIssueState(c.workspace, c.id, await c.body())]),
  route("POST", "/api/agent/issues/{id}/claim", async (c) => [200, await claimIssue(c.workspace, c.id, requiredAgentName(c.request))]),
  route("POST", "/api/agent/issues/{id}/replies", async (c) => {
    const agentName = requiredAgentName(c.request);
    return [200, await replyToIssue(c.workspace, c.id, await c.body(), { agentName })];
  }),
  route("POST", "/api/agent/issues/{id}/state", async (c) => {
    const agentName = requiredAgentName(c.request);
    return [200, await updateIssueState(c.workspace, c.id, await c.body(), { agentName })];
  }),
  route("GET", "/api/agent/issues/{id}", async (c) => {
    requiredAgentName(c.request);
    return [200, await getIssue(c.workspace, c.id)];
  }),
  route("GET", "/api/issues/{id}", async (c) => [200, await getIssue(c.workspace, c.id)]),
  route("PATCH", "/api/issues/{id}", async (c) => [200, await updateIssue(c.workspace, c.id, await c.body(), { agentName: optionalAgentName(c.request) })]),
  route("GET", "/api/decisions", async (c) => [200, { decisions: await listDecisions(c.workspace) }]),
  route("POST", "/api/decisions", async (c) => [201, await createDecision(c.workspace, await c.body(), await c.projects())]),
  route("POST", "/api/decisions/{id}/actions", async (c) => [200, await applyDecisionAction(c.workspace, c.id, await c.body(), await c.projects())]),
  route("GET", "/api/tasks", async (c) => [200, { tasks: filterUpdatedSince(await listTasks(c.workspace), c.url) }]),
  route("POST", "/api/tasks", async (c) => [201, await createTask(c.workspace, await c.body(), await c.projects(), { agentName: optionalAgentName(c.request) })]),
  route("GET", "/api/tasks/{id}", async (c) => [200, await getTask(c.workspace, c.id)]),
  route("PATCH", "/api/tasks/{id}", async (c) => [200, await updateTask(c.workspace, c.id, await c.body(), await c.projects(), { agentName: optionalAgentName(c.request) })]),
  route("POST", "/api/tasks/{id}/move", async (c) => {
    const agentName = optionalAgentName(c.request);
    return [200, await moveTask(c.workspace, c.id, await c.body(), { agentName })];
  }),
  route("POST", "/api/tasks/{id}/checklist", async (c) => [200, await toggleTaskChecklist(c.workspace, c.id, await c.body())]),
  route("POST", "/api/tasks/{id}/log", async (c) => [200, await appendTaskLog(c.workspace, c.id, await c.body())]),
];

async function handleRequest(workspaces, service, request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  assertLocalRequest(request, service.host);

  if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
    proxyMcpRequest(service, request, response);
    return;
  }

  if (request.method === "OPTIONS") {
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

  const base = { request, response, url, service, workspaces, body: () => readJsonBody(request) };
  if (await dispatch(SERVICE_ROUTES, base)) return;

  const workspace = selectedWorkspace(workspaces, service.defaultWorkspace, request);
  if (await dispatch(WORKSPACE_ROUTES, { ...base, workspace, projects: () => discoverProjects(workspace.root) })) return;

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
  const requestedDirectory = await realpath(root);
  const initialRoots = Array.isArray(roots) && roots.length > 0 ? roots : [root];
  const initialized = [];
  for (const candidate of initialRoots) {
    initialized.push(await initializeWorkspace(candidate));
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
    bootFingerprint: buildFingerprint(),
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
