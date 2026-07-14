import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
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
  updateTask,
  validateProjectScopePath,
  workspaceSnapshot,
} from "../lib/local-workspace.mjs";
import { listFiles, readFilePreview } from "../lib/file-browser.mjs";
import { chooseWorkspaceDirectory } from "../lib/native-folder-picker.mjs";
import { registerWorkspace, unregisterWorkspace } from "../lib/workspace-registry.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const MAX_BODY_BYTES = 128 * 1024;
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
  if (origin && LOCAL_ORIGIN.test(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

function sendJson(request, response, status, body) {
  const content = `${JSON.stringify(body)}\n`;
  response.writeHead(
    status,
    responseHeaders(request, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(content),
    }),
  );
  response.end(content);
}

function sendEmpty(request, response, status = 204) {
  response.writeHead(status, responseHeaders(request));
  response.end();
}

function assertLocalRequest(request) {
  const host = request.headers.host;
  if (typeof host !== "string") {
    throw new WorkspaceError("A local Host header is required.", { code: "invalid_host", status: 403 });
  }
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    throw new WorkspaceError("Invalid Host header.", { code: "invalid_host", status: 403 });
  }
  if (!isLocalHostname(hostname)) {
    throw new WorkspaceError("This API only accepts loopback requests.", { code: "invalid_host", status: 403 });
  }
  const origin = requestOrigin(request);
  if (origin && !LOCAL_ORIGIN.test(origin)) {
    throw new WorkspaceError("This API only accepts local browser origins.", { code: "invalid_origin", status: 403 });
  }
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

function publicWorkspace(workspace) {
  return { id: workspace.id, name: workspace.name, root: workspace.root };
}

function selectedWorkspace(workspaces, defaultWorkspace, request) {
  const requestedId = request.headers["x-work-workspace"];
  if (requestedId == null || requestedId === "") return defaultWorkspace;
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
  return workspace;
}

async function handleRequest(workspaces, service, request, response) {
  assertLocalRequest(request);
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const method = request.method ?? "GET";
  const defaultWorkspace = service.defaultWorkspace;

  if (method === "OPTIONS") {
    response.writeHead(
      204,
      responseHeaders(request, {
        "Access-Control-Allow-Headers": "Content-Type, X-Work-Folder-Picker, X-Work-Restart, X-Work-Unregister, X-Work-Workspace",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Max-Age": "600",
      }),
    );
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/api/workspaces") {
    sendJson(request, response, 200, {
      activeWorkspaceId: defaultWorkspace.id,
      workspaces: [...workspaces.values()].map(publicWorkspace),
    });
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
    const currentWorkspace = selectedWorkspace(workspaces, defaultWorkspace, request);
    if (workspaceToRemove === currentWorkspace.id) {
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
    await unregisterWorkspace(workspaceToRemove, { registryPath: service.registryPath });
    workspaces.delete(workspaceToRemove);
    if (service.defaultWorkspace.id === workspaceToRemove) {
      service.defaultWorkspace = currentWorkspace;
    }
    sendJson(request, response, 200, {
      removedWorkspaceId: workspaceToRemove,
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

  const workspace = selectedWorkspace(workspaces, defaultWorkspace, request);

  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(request, response, 200, {
      ok: true,
      service: {
        instanceId: service.instanceId,
        restartable: typeof service.onRestart === "function",
      },
      workspace: { id: workspace.id, name: workspace.name, root: workspace.root },
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/workspace") {
    sendJson(request, response, 200, await workspaceSnapshot(workspace));
    return;
  }
  if (method === "GET" && url.pathname === "/api/projects") {
    sendJson(request, response, 200, { projects: await discoverProjects(workspace.root) });
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
  forceNewWorkspace = false,
  onRestart = null,
  pickWorkspaceDirectory = chooseWorkspaceDirectory,
  registryPath = undefined,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new WorkspaceError("port must be an integer between 0 and 65535.", { code: "invalid_port" });
  }
  if (onRestart != null && typeof onRestart !== "function") {
    throw new WorkspaceError("onRestart must be a function.", { code: "invalid_restart_handler" });
  }
  if (typeof pickWorkspaceDirectory !== "function") {
    throw new WorkspaceError("pickWorkspaceDirectory must be a function.", { code: "invalid_folder_picker" });
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
    defaultWorkspace: workspace,
    onRestart,
    restartPending: false,
    pickWorkspaceDirectory,
    registryPath,
  };
  const server = createServer((request, response) => {
    handleRequest(workspaces, service, request, response).catch((error) => errorResponse(request, response, error));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise((resolve, reject) => {
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
    server.listen(port, LOOPBACK_HOST);
  });

  const address = server.address();
  const selectedPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    origin: `http://${LOOPBACK_HOST}:${selectedPort}`,
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
