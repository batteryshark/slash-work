import { createServer } from "node:http";
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
  createNote,
  createTask,
  deleteCapture,
  deleteIdea,
  deleteNote,
  discoverProjects,
  initializeWorkspace,
  getTask,
  listCaptures,
  listDecisions,
  listIdeas,
  listNotes,
  listTasks,
  moveTask,
  toggleTaskChecklist,
  updateCaptureDestination,
  updateIdea,
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
import {
  createAiProposal,
  getAiSettings,
  saveAiSettings,
  selectedProposalPatch,
  testAiSettings,
} from "../lib/ai-assistance.mjs";
import { FederationManager } from "../lib/instance-federation.mjs";
import { isTailscaleIPv4 } from "../lib/tailscale-network.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 43170;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 4 * 1024 * 1024;
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

function isFederatedWorkspacePath(pathname) {
  return [
    /^\/api\/health$/,
    /^\/api\/workspace$/,
    /^\/api\/projects(?:\/profile)?$/,
    /^\/api\/files\/(?:directory|content)$/,
    /^\/api\/(?:captures|notes|ideas|decisions|tasks)(?:\/[^/]+(?:\/(?:actions|move|checklist|log))?)?$/,
    /^\/api\/agent\/notes(?:\/[^/]+)?$/,
    /^\/api\/ai\/(?:proposals|apply)$/,
  ].some((pattern) => pattern.test(pathname));
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

async function readRawBody(request) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new WorkspaceError("Request body is too large.", { code: "body_too_large", status: 413 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new WorkspaceError("Request body is too large.", { code: "body_too_large", status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
    throw new WorkspaceError("Agent note operations require X-Work-Agent.", { code: "agent_identity_required", status: 400 });
  }
  const name = value.trim();
  if (name.length > 120 || /[\r\n]/.test(name)) {
    throw new WorkspaceError("X-Work-Agent must be a one-line name of at most 120 characters.", { code: "invalid_agent_identity" });
  }
  return name;
}

function publicWorkspace(workspace) {
  return { id: workspace.id, name: workspace.name, root: workspace.root, location: "local", available: true };
}

function publicFederationSettings(service) {
  return {
    ...service.federation.settings(),
    network: {
      mode: isTailscaleIPv4(service.host) ? "tailscale" : "loopback",
      reachableUrl: isTailscaleIPv4(service.host) ? service.origin ?? null : null,
    },
  };
}

function proxyHeaders(request, remoteWorkspaceId, sourceName) {
  const headers = {
    authorization: null,
    "x-work-federation-hop": "1",
    "x-work-federation-source": sourceName,
    "x-work-workspace": remoteWorkspaceId,
  };
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value !== "string") continue;
    if (new Set(["accept", "content-type", "if-none-match"]).has(name)
      || (name.startsWith("x-work-") && !new Set(["x-work-workspace", "x-work-federation-hop", "x-work-federation-source"]).has(name))) {
      headers[name] = value;
    }
  }
  return headers;
}

async function proxyFederatedRequest(service, remoteWorkspace, url, request, response) {
  const token = await service.federation.peerToken(remoteWorkspace.peer.id);
  const body = new Set(["GET", "HEAD"]).has(request.method ?? "GET") ? null : await readRawBody(request);
  const headers = proxyHeaders(request, remoteWorkspace.remoteWorkspaceId, service.federation.config.name);
  headers.authorization = `Bearer ${token}`;
  let upstream;
  try {
    upstream = await service.federation.fetch(`${remoteWorkspace.peer.baseUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(body?.length ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(service.federation.timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new WorkspaceError(
      timedOut ? `${remoteWorkspace.peer.name} did not respond in time.` : `${remoteWorkspace.peer.name} is unavailable: ${error.message}`,
      { code: timedOut ? "peer_timeout" : "peer_unavailable", status: timedOut ? 504 : 502 },
    );
  }
  const declaredLength = Number(upstream.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_RESPONSE_BYTES) {
    throw new WorkspaceError("The remote Work response is too large.", { code: "peer_response_too_large", status: 502 });
  }
  let content = Buffer.from(await upstream.arrayBuffer());
  if (content.length > MAX_PROXY_RESPONSE_BYTES) {
    throw new WorkspaceError("The remote Work response is too large.", { code: "peer_response_too_large", status: 502 });
  }
  const contentType = upstream.headers.get("content-type") ?? "application/json; charset=utf-8";
  if (upstream.ok && contentType.includes("application/json") && new Set(["/api/workspace", "/api/health"]).has(url.pathname)) {
    try {
      const payload = JSON.parse(content.toString("utf8"));
      if (payload?.workspace && typeof payload.workspace === "object") {
        payload.workspace = {
          ...payload.workspace,
          id: remoteWorkspace.id,
          root: remoteWorkspace.root,
          location: "remote",
          available: true,
          peer: remoteWorkspace.peer,
        };
      }
      content = Buffer.from(`${JSON.stringify(payload)}\n`);
    } catch {
      throw new WorkspaceError("The remote Work instance returned invalid JSON.", { code: "invalid_peer_response", status: 502 });
    }
  }
  request.workWorkspaceId = remoteWorkspace.id;
  response.writeHead(upstream.status, responseHeaders(request, {
    "Content-Type": contentType,
    "Content-Length": content.length,
    ...(upstream.headers.get("etag") ? { ETag: upstream.headers.get("etag") } : {}),
  }));
  response.end(content);
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

async function handleRequest(workspaces, service, request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const method = request.method ?? "GET";
  const defaultWorkspace = service.defaultWorkspace;
  const federationHop = request.headers["x-work-federation-hop"];
  let federationGrant = null;
  if (federationHop != null) {
    if (federationHop !== "1" || requestOrigin(request)) {
      throw new WorkspaceError("Federation requests must be direct server-to-server calls.", { code: "invalid_federation_hop", status: 403 });
    }
    if (url.pathname !== "/api/federation/manifest" && !isFederatedWorkspacePath(url.pathname)) {
      throw new WorkspaceError("That service operation is not available through federation.", { code: "federation_route_forbidden", status: 403 });
    }
    const requestedWorkspaceId = url.pathname === "/api/federation/manifest" ? null : request.headers["x-work-workspace"];
    if (url.pathname !== "/api/federation/manifest" && (typeof requestedWorkspaceId !== "string" || !requestedWorkspaceId)) {
      throw new WorkspaceError("Federated workspace requests require one exact workspace id.", { code: "invalid_workspace", status: 400 });
    }
    federationGrant = await service.federation.authorize(request.headers.authorization, requestedWorkspaceId);
  } else {
    assertLocalRequest(request, service.host);
  }

  if (method === "OPTIONS") {
    response.writeHead(
      204,
      responseHeaders(request, {
        "Access-Control-Allow-Headers": "Content-Type, If-None-Match, X-Work-Agent, X-Work-AI-Apply, X-Work-AI-Settings, X-Work-Federation-Settings, X-Work-Folder-Picker, X-Work-Restart, X-Work-Unregister, X-Work-Workspace",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Max-Age": "600",
      }),
    );
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/api/federation/manifest") {
    if (!federationGrant) throw new WorkspaceError("Federation discovery requires an authenticated peer request.", { code: "federation_unauthorized", status: 401 });
    sendJson(request, response, 200, service.federation.manifest(federationGrant));
    return;
  }

  if (method === "GET" && url.pathname === "/api/workspaces") {
    const forceRefresh = url.searchParams.get("refresh") === "1";
    if (forceRefresh) {
      await service.federation.refreshPeers({ force: true });
    } else {
      void service.federation.refreshPeers().catch((error) => console.error("[work] Connected-instance refresh failed:", error));
    }
    sendJson(request, response, 200, {
      defaultWorkspaceId: defaultWorkspace.id,
      activeWorkspaceId: defaultWorkspace.id,
      workspaces: [...workspaces.values()].map(publicWorkspace).concat(service.federation.remoteWorkspaces()),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/federation") {
    await service.federation.refreshPeers({ force: url.searchParams.get("refresh") === "1" });
    sendJson(request, response, 200, publicFederationSettings(service));
    return;
  }
  if (method === "PATCH" && url.pathname === "/api/federation") {
    if (request.headers["x-work-federation-settings"] !== "confirm") {
      throw new WorkspaceError("Changing federation settings requires explicit local confirmation.", { code: "federation_confirmation_required", status: 403 });
    }
    const body = await readJsonBody(request);
    await service.federation.rename(body.name);
    sendJson(request, response, 200, publicFederationSettings(service));
    return;
  }
  if (method === "POST" && url.pathname === "/api/federation/grants") {
    if (request.headers["x-work-federation-settings"] !== "confirm") {
      throw new WorkspaceError("Creating an access key requires explicit local confirmation.", { code: "federation_confirmation_required", status: 403 });
    }
    sendJson(request, response, 201, await service.federation.createGrant(await readJsonBody(request)));
    return;
  }
  const grantToRevoke = routeId(url.pathname, "federation/grants");
  if (method === "DELETE" && grantToRevoke) {
    if (request.headers["x-work-federation-settings"] !== "confirm") {
      throw new WorkspaceError("Revoking an access key requires explicit local confirmation.", { code: "federation_confirmation_required", status: 403 });
    }
    await service.federation.revokeGrant(grantToRevoke);
    sendEmpty(request, response);
    return;
  }
  if (method === "POST" && url.pathname === "/api/federation/peers") {
    if (request.headers["x-work-federation-settings"] !== "confirm") {
      throw new WorkspaceError("Connecting a Work instance requires explicit local confirmation.", { code: "federation_confirmation_required", status: 403 });
    }
    sendJson(request, response, 201, await service.federation.addPeer(await readJsonBody(request)));
    return;
  }
  const peerToRemove = routeId(url.pathname, "federation/peers");
  if (method === "DELETE" && peerToRemove) {
    if (request.headers["x-work-federation-settings"] !== "confirm") {
      throw new WorkspaceError("Removing a connected instance requires explicit local confirmation.", { code: "federation_confirmation_required", status: 403 });
    }
    await service.federation.removePeer(peerToRemove);
    sendEmpty(request, response);
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

  if (method === "GET" && url.pathname === "/api/ai/settings") {
    sendJson(request, response, 200, await getAiSettings(service.aiConfigFile, service.aiCredentialStore));
    return;
  }

  if (method === "PATCH" && url.pathname === "/api/ai/settings") {
    if (request.headers["x-work-ai-settings"] !== "confirm") {
      throw new WorkspaceError("Saving AI settings requires explicit local confirmation.", { code: "ai_settings_confirmation_required", status: 403 });
    }
    sendJson(request, response, 200, await saveAiSettings(await readJsonBody(request), service.aiConfigFile, service.aiCredentialStore));
    return;
  }

  if (method === "POST" && url.pathname === "/api/ai/settings/test") {
    sendJson(request, response, 200, await testAiSettings(service.aiConfigFile, service.aiFetch, service.aiRequestTimeoutMs, service.aiCredentialStore));
    return;
  }

  const requestedWorkspaceId = request.headers["x-work-workspace"];
  if (typeof requestedWorkspaceId === "string") {
    const remoteWorkspace = service.federation.resolveRemoteWorkspace(requestedWorkspaceId);
    if (remoteWorkspace) {
      await proxyFederatedRequest(service, remoteWorkspace, url, request, response);
      return;
    }
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
      workspace: { id: workspace.id, name: workspace.name, root: workspace.root },
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/workspace") {
    sendWorkspaceSnapshot(request, response, await workspaceSnapshot(workspace));
    return;
  }
  if (method === "GET" && url.pathname === "/api/projects") {
    sendJson(request, response, 200, { projects: await discoverProjects(workspace.root) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/ai/proposals") {
    sendJson(request, response, 200, await createAiProposal(workspace, await readJsonBody(request), {
      configPath: service.aiConfigFile,
      fetchImpl: service.aiFetch,
      timeoutMs: service.aiRequestTimeoutMs,
      credentialStore: service.aiCredentialStore,
    }));
    return;
  }
  if (method === "POST" && url.pathname === "/api/ai/apply") {
    if (request.headers["x-work-ai-apply"] !== "confirm") {
      throw new WorkspaceError("Applying an AI proposal requires explicit confirmation.", { code: "ai_apply_confirmation_required", status: 403 });
    }
    const body = await readJsonBody(request);
    if (body.confirm !== true || !body.proposal || typeof body.proposal !== "object") {
      throw new WorkspaceError("Applying an AI proposal requires confirm: true and the proposal preview.", { code: "ai_apply_confirmation_required" });
    }
    const proposal = body.proposal;
    const projects = await discoverProjects(workspace.root);
    if (proposal.artifactType === "task") {
      const task = await getTask(workspace, proposal.artifactId);
      const patch = selectedProposalPatch(proposal, body.selectedFields, task);
      sendJson(request, response, 200, await updateTask(workspace, task.id, patch, projects));
      return;
    }
    if (proposal.artifactType === "idea") {
      const idea = (await listIdeas(workspace)).find((item) => item.id === proposal.artifactId);
      if (!idea) throw new WorkspaceError(`Idea not found: ${proposal.artifactId}`, { code: "idea_not_found", status: 404 });
      const patch = selectedProposalPatch(proposal, body.selectedFields, idea);
      sendJson(request, response, 200, await updateIdea(workspace, idea.id, patch, projects));
      return;
    }
    throw new WorkspaceError("That AI proposal artifact is not supported.", { code: "invalid_ai_proposal" });
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
    sendJson(request, response, 201, await createNote(workspace, { ...body, agentIntent: "reference_only" }, projects, {
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
    sendJson(request, response, 200, { tasks: await listTasks(workspace) });
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
    sendJson(request, response, 200, await updateTask(workspace, taskId, body, projects));
    return;
  }
  const moveTaskId = routeId(url.pathname, "tasks", "/move");
  if (method === "POST" && moveTaskId) {
    sendJson(request, response, 200, await moveTask(workspace, moveTaskId, await readJsonBody(request)));
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
  aiConfigFile = undefined,
  aiFetch = fetch,
  aiRequestTimeoutMs = 30_000,
  aiCredentialStore = undefined,
  federationConfigFile = null,
  federationCredentialStore = undefined,
  federationFetch = fetch,
  federationRequestTimeoutMs = 5_000,
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
  if (typeof aiFetch !== "function") throw new WorkspaceError("aiFetch must be a function.", { code: "invalid_ai_fetch" });
  if (aiCredentialStore != null && (!["get", "set", "delete"].every((method) => typeof aiCredentialStore[method] === "function"))) {
    throw new WorkspaceError("aiCredentialStore must provide get, set, and delete methods.", { code: "invalid_ai_credential_store" });
  }
  if (!Number.isInteger(aiRequestTimeoutMs) || aiRequestTimeoutMs < 1) throw new WorkspaceError("aiRequestTimeoutMs must be a positive integer.", { code: "invalid_ai_timeout" });
  if (typeof federationFetch !== "function") throw new WorkspaceError("federationFetch must be a function.", { code: "invalid_federation_fetch" });
  if (federationCredentialStore != null && (!["get", "set", "delete"].every((method) => typeof federationCredentialStore[method] === "function"))) {
    throw new WorkspaceError("federationCredentialStore must provide keyed get, set, and delete methods.", { code: "invalid_federation_credential_store" });
  }
  if (!Number.isInteger(federationRequestTimeoutMs) || federationRequestTimeoutMs < 1) {
    throw new WorkspaceError("federationRequestTimeoutMs must be a positive integer.", { code: "invalid_federation_timeout" });
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
  const federation = await new FederationManager({
    configPath: federationConfigFile,
    ...(federationCredentialStore ? { credentialStore: federationCredentialStore } : {}),
    fetchImpl: federationFetch,
    timeoutMs: federationRequestTimeoutMs,
    serviceVersion: version,
    localWorkspaces: () => [...workspaces.values()],
  }).initialize();
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
    aiConfigFile,
    aiFetch,
    aiRequestTimeoutMs,
    aiCredentialStore,
    federation,
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
  service.origin = origin;
  return {
    server,
    origin,
    port: selectedPort,
    workspace,
    workspaces: [...workspaces.values()],
  };
}

export async function closeLocalApi(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}
