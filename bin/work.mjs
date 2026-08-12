#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  WorkspaceError,
  appendTaskLog,
  createCapture,
  createDecision,
  createProject,
  createTask,
  deleteProject,
  discoverProjects,
  findWorkspaceRoot,
  getTask,
  initializeWorkspace,
  listTasks,
  moveTask,
  projectForScope,
  readWorkspace,
  updateTask,
} from "../lib/local-workspace.mjs";
import {
  listRegisteredWorkspaces,
  pruneRegistry,
  registerWorkspace,
  registryEntries,
  unregisterWorkspace,
  workspaceRegistryPath,
} from "../lib/workspace-registry.mjs";
import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";
import { startMcpSidecar } from "../lib/mcp-sidecar.mjs";
import { createServiceUpdater } from "../lib/service-updater.mjs";
import { discoverTailscaleIPv4 } from "../lib/tailscale-network.mjs";
import {
  getAgentIndex,
  getAgentOperation,
  listAgentOperations,
  renderAgentIndexMarkdown,
  renderAgentOperationMarkdown,
  renderAgentOperationsMarkdown,
} from "../lib/agent-capabilities.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API_PORT = 43170;
const DEFAULT_UI_PORT = 43171;

const HELP = `Work — local, root-scoped project memory

Usage:
  work [root]                         Start the local UI and API
  work serve [root]                   Start the local UI and API
  work init [root]                    Create and register a workspace at this exact root
                                      (add --id-floor N to set or change its task-id floor)
  work register [root]                Register this exact root for the workspace picker
  work unregister <id|root>           Remove a root from the web workspace picker
  work roots                          List registered roots with project counts
  work roots prune                    Drop registered roots whose directory is gone
  work roots forget <path>            Unregister one root without touching its files
  work projects                       List exact projects in the current workspace
  work new "Name" [--under rel/path]  Create a project folder and marker from a name
  work remove <rel-path>              Remove a project from Work (folder deleted only when empty)
  work agent                          Print capabilities and resolved local context
  work agent context                  Print only the resolved local context
  work agent operations               List available task-scoped operations
  work agent instructions <operation> Print instructions for one operation
  work add "thought" [options]        Capture from any workspace descendant
  work decision "question" [options] Create a decision from any descendant
  work task "title" [options]         Create a full Kanban work item
  work list [--project p|--unassigned] List work items; filter to one project or to workspace scope
  work show <id>                       Print a complete work item
  work update <id> [options]           Edit a card's title and sections
  work move <id> <status> [--note n]  Move a card and append to its log
  work log <id> "what happened"        Append a progress entry
  work delegate <id> [--off]           Hand an existing card to an agent (--off takes it back)

Options:
  --root <path>       Select a root (otherwise search upward from the current directory)
  --scope <path>      Override the invocation directory's folder scope
  --under <path>      Parent directory for work new (workspace-relative; default: root)
  --project <path>    Assign to this exact discovered project
  --unassigned        Keep new work at workspace scope instead of the current project
  --kind <kind>       idea, question, or update
  --detail <text>     Decision context
  --option <text>     Decision option; may be repeated
  --recommend <text>  Recommend one exact recorded decision option
  --ref <id>          Link the decision to a Work item; may be repeated
  --delegate          Hand the new task to an agent (human-only signal)
  --tag <tag>         Tag; may be repeated
  --depends-on <id>   Dependency; may be repeated
  --blocked-by <id>   Blocker task; may be repeated
  --status <status>   Initial Kanban status
  --title <text>      Replacement title (update only)
  --description <x>   Description section: background context
  --goal <text>       Goal section: the discrete outcome
  --requirement <x>   Requirement checkbox; may be repeated (update replaces the list)
  --acceptance <x>    Acceptance criterion; may be repeated (update replaces the list)
  --plan <text>       Plan section
  --notes <text>      Notes section
  --note <text>       Status-change note
  --id-floor <n>      Lowest task id this workspace may allocate (init only)
  --api-port <port>   Pin the local API port (default preference: ${DEFAULT_API_PORT})
  --ui-port <port>    Local UI port (default preference: ${DEFAULT_UI_PORT})
  --format <format>   Agent output format: markdown or json
  --json              Shortcut for --format json
  --no-ui             Start only the local API
  --no-open           Do not open the local UI in your browser
  --tailscale         Listen only on this machine's Tailscale IPv4 address
  --mcp               Enable the optional Streamable HTTP MCP endpoint
  --init              Force a new workspace at the selected root
  -h, --help          Show this help

Examples:
  work ~/Projects
  work agent
  work projects
  work add "check whether the release needs a migration" --scope tools
  work add "validate the parser" --scope tools/parser --project tools/parser
  work decision "Where should the lab live?" --option "Keep unassigned" --option "Assign later"
  work task "Implement the board" --project tools/runner --delegate
  work move W-0001 in_progress --note "Agent team started implementation"
  work log W-0001 "API and restart tests pass"
`;

const repeatable = () => ({ type: "string", multiple: true, default: [] });
const CLI_FLAGS = {
  root: { type: "string" },
  scope: { type: "string" },
  under: { type: "string" },
  project: { type: "string" },
  kind: { type: "string" },
  detail: { type: "string" },
  option: repeatable(),
  recommend: { type: "string" },
  ref: repeatable(),
  delegate: { type: "boolean" },
  off: { type: "boolean" },
  tag: repeatable(),
  "depends-on": repeatable(),
  "blocked-by": repeatable(),
  status: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  goal: { type: "string" },
  requirement: repeatable(),
  acceptance: repeatable(),
  plan: { type: "string" },
  notes: { type: "string" },
  note: { type: "string" },
  "id-floor": { type: "string" },
  "api-port": { type: "string" },
  "ui-port": { type: "string" },
  format: { type: "string" },
  "no-ui": { type: "boolean" },
  "no-open": { type: "boolean" },
  tailscale: { type: "boolean" },
  mcp: { type: "boolean" },
  unassigned: { type: "boolean" },
  init: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const CLI_FLAG_NAMES = {
  "depends-on": "dependsOn",
  "blocked-by": "blockedBy",
  "id-floor": "idFloor",
  "api-port": "apiPort",
  "ui-port": "uiPort",
  "no-ui": "noUi",
  "no-open": "noOpen",
  init: "forceInit",
};

function parseArguments(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: CLI_FLAGS, allowPositionals: true });
  } catch (error) {
    throw new WorkspaceError(error.message.split("\n")[0]);
  }
  const options = {};
  for (const [flag, value] of Object.entries(parsed.values)) options[CLI_FLAG_NAMES[flag] ?? flag] = value;
  return { options, positionals: parsed.positionals };
}

function parsePort(value, fallback, label) {
  if (value == null) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new WorkspaceError(`${label} must be an integer between 0 and 65535.`);
  }
  return port;
}

async function invocationScope(workspace) {
  const currentDirectory = await realpath(process.cwd());
  const rel = relative(workspace.root, currentDirectory);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return ".";
  return rel.split(sep).join("/");
}

function markerForProject(project) {
  if (project.markers.includes(".work/project.json")) return ".work/project.json";
  if (project.markers.includes(".work")) return ".work";
  return project.markers[0] ?? null;
}

async function resolveLocalContext(options) {
  const invocationPath = await realpath(process.cwd());
  const candidate = options.root ?? invocationPath;
  const workspaceRoot = await findWorkspaceRoot(candidate);
  if (!workspaceRoot) {
    return {
      available: false,
      invocationPath,
      reason: "No ancestor contains .work/workspace.json.",
    };
  }
  const workspace = await readWorkspace(workspaceRoot);
  const projects = await discoverProjects(workspace.root);
  const scopePath = await invocationScope(workspace);
  const match = projectForScope(projects, scopePath);
  return {
    available: true,
    invocationPath,
    workspace: { id: workspace.id, name: workspace.name, root: workspace.root },
    scopePath,
    project: match
      ? {
          id: match.project.projectId,
          name: match.project.name,
          path: match.project.path,
          description: match.project.description,
          marker: markerForProject(match.project),
          matchedPath: match.matchedPath,
        }
      : null,
    defaultProjectPath: match?.project.path ?? null,
  };
}

async function existingWorkspace(options) {
  const candidate = options.root ?? process.cwd();
  const workspaceRoot = await findWorkspaceRoot(candidate);
  if (!workspaceRoot) throw new WorkspaceError("No Work workspace was found. Run from a workspace or pass --root <path>.");
  return readWorkspace(workspaceRoot);
}

function renderLocalContext(context) {
  if (!context.available) {
    return `## Current local context\n\nNo workspace resolved from \`${context.invocationPath}\`. ${context.reason}\n`;
  }
  const project = context.project
    ? `- Project: \`${context.project.path}\` (${context.project.name}; marker: \`${context.project.marker}\`)\n- Default for new local artifacts: \`--project ${context.project.path}\``
    : "- Project: none at this scope\n- Default for new local artifacts: workspace scope";
  return `## Current local context\n\n- Invocation: \`${context.invocationPath}\`\n- Workspace: \`${context.workspace.root}\` (${context.workspace.name})\n- Scope: \`${context.scopePath}\`\n${project}\n\nUse \`--unassigned\` only when the user explicitly wants workspace-level work instead of the resolved current project.\n`;
}

async function defaultProjectPath(options, workspace, projects) {
  if (options.project != null && options.unassigned) {
    throw new WorkspaceError("--project and --unassigned cannot be used together.");
  }
  if (options.unassigned) return null;
  if (options.project != null) return options.project;
  const scopePath = options.scope ?? await invocationScope(workspace);
  return projectForScope(projects, scopePath)?.project.path ?? null;
}

async function runInit(options, positionals) {
  if (positionals.length > 1) throw new WorkspaceError("init accepts only one root path.");
  const root = options.root ?? positionals[0] ?? process.cwd();
  // init is the explicit registration path: serve never registers on its own.
  const workspace = await registerWorkspace(root, { force: true, idFloor: options.idFloor == null ? null : Number(options.idFloor) });
  console.log(`Initialized Work at ${workspace.root}`);
  console.log(`Data: ${workspace.dataDir}`);
  if (workspace.idFloor > 0) console.log(`Task ids start at W-${String(workspace.idFloor).padStart(4, "0")}`);
}

async function runRegister(options, positionals) {
  if (positionals.length > 1) throw new WorkspaceError("register accepts only one root path.");
  const workspace = await registerWorkspace(options.root ?? positionals[0] ?? process.cwd(), { force: true });
  console.log(`Registered ${workspace.name}`);
  console.log(`Root: ${workspace.root}`);
}

async function runUnregister(options, positionals) {
  if (options.root || positionals.length !== 1) throw new WorkspaceError("unregister requires one workspace id or root path.");
  await unregisterWorkspace(positionals[0]);
  console.log(`Unregistered ${positionals[0]}`);
}

async function runRoots(options, positionals) {
  if (options.root) throw new WorkspaceError("roots does not accept --root.");
  const [subcommand, ...rest] = positionals;
  if (subcommand === "prune") {
    if (rest.length > 0) throw new WorkspaceError("roots prune does not accept arguments.");
    const removed = await pruneRegistry();
    if (removed.length === 0) {
      console.log("No dead roots to prune.");
      return;
    }
    for (const entry of removed) console.log(`Pruned ${entry.root}`);
    return;
  }
  if (subcommand === "forget") {
    if (rest.length !== 1) throw new WorkspaceError("roots forget requires exactly one root path or id.");
    await unregisterWorkspace(rest[0]);
    console.log(`Forgot ${rest[0]}. Its files were not touched.`);
    return;
  }
  if (subcommand != null) throw new WorkspaceError(`Unknown roots command: ${subcommand}. Use prune or forget.`);
  const entries = await registryEntries();
  if (entries.length === 0) {
    console.log("No roots registered. Run: work init /path/to/root");
    return;
  }
  for (const entry of entries) {
    let projects = null;
    try {
      projects = await discoverProjects(entry.root);
    } catch (error) {
      if (error?.code !== "missing_root" && error?.code !== "ENOENT") throw error;
    }
    const detail = projects ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : "(unreachable)";
    console.log(`${entry.name}\t${entry.root}\t${detail}`);
  }
  console.log(`Registry: ${workspaceRegistryPath()}`);
}

async function runProjects(options, positionals) {
  if (positionals.length > 0) throw new WorkspaceError("projects does not accept positional arguments.");
  const workspace = await existingWorkspace(options);
  const projects = await discoverProjects(workspace.root);
  if (options.json || options.format === "json") {
    process.stdout.write(`${JSON.stringify({ workspace: { id: workspace.id, name: workspace.name, root: workspace.root }, projects }, null, 2)}\n`);
    return;
  }
  if (options.format && options.format !== "markdown") throw new WorkspaceError("--format must be markdown or json.");
  if (projects.length === 0) {
    console.log("No projects discovered in this workspace.");
    return;
  }
  for (const project of projects) {
    console.log(`${project.path}\t${project.name}\t${markerForProject(project) ?? "unknown marker"}`);
  }
}

function agentOutputFormat(options) {
  const format = options.json ? "json" : options.format ?? "markdown";
  if (!new Set(["markdown", "json"]).has(format)) {
    throw new WorkspaceError("--format must be markdown or json.");
  }
  return format;
}

async function runAgent(options, positionals) {
  const [command, value, ...extra] = positionals;
  if (extra.length > 0) throw new WorkspaceError("agent accepts only a command and one operation name.");
  const emit = (json, markdown) => process.stdout.write(agentOutputFormat(options) === "json" ? `${JSON.stringify(json, null, 2)}\n` : markdown);

  if (command == null) {
    const context = await resolveLocalContext(options);
    return emit({ ...getAgentIndex(), localContext: context }, `${renderAgentIndexMarkdown()}\n${renderLocalContext(context)}`);
  }
  if (command === "context") {
    if (value != null) throw new WorkspaceError("agent context does not accept an operation name.");
    const context = await resolveLocalContext(options);
    return emit(context, renderLocalContext(context));
  }
  if (command === "operations") {
    if (value != null) throw new WorkspaceError("agent operations does not accept an operation name.");
    return emit(listAgentOperations(), renderAgentOperationsMarkdown());
  }
  if (command === "instructions") {
    if (!value) throw new WorkspaceError("agent instructions requires an operation name. Run `work agent operations` first.");
    const operation = getAgentOperation(value);
    if (!operation) throw new WorkspaceError(`Unknown agent operation: ${value}. Run \`work agent operations\` first.`);
    return emit(operation, renderAgentOperationMarkdown(value));
  }
  throw new WorkspaceError(`Unknown agent command: ${command}. Use context, operations, or instructions.`);
}

async function runNew(options, positionals) {
  if (positionals.length === 0) throw new WorkspaceError('new requires a project name in quotes.');
  const workspace = await existingWorkspace(options);
  const project = await createProject(workspace, { name: positionals.join(" "), parentPath: options.under });
  console.log(`Created project ${project.path} (${project.name})`);
  console.log(`Folder: ${workspace.root}/${project.path}`);
}

async function runAdd(options, positionals) {
  if (positionals.length === 0) throw new WorkspaceError("add requires a thought in quotes.");
  const text = positionals.join(" ");
  const workspace = await currentWorkspace(options);
  const projects = await discoverProjects(workspace.root);
  const scopePath = options.scope ?? (await invocationScope(workspace));
  const projectPath = await defaultProjectPath(options, workspace, projects);
  const capture = await createCapture(
    workspace,
    {
      text,
      kind: options.kind,
      scopePath,
      projectPath,
    },
    projects,
  );
  console.log(`Captured ${capture.id}`);
  console.log(`Scope: ${capture.scopePath}${capture.projectPath ? ` · Project: ${capture.projectPath}` : " · Unassigned"}`);
}

async function runDecision(options, positionals) {
  if (positionals.length === 0) throw new WorkspaceError("decision requires a question in quotes.");
  const title = positionals.join(" ");
  const workspace = await currentWorkspace(options);
  const projects = await discoverProjects(workspace.root);
  const projectPath = await defaultProjectPath(options, workspace, projects);
  const decision = await createDecision(
    workspace,
    {
      title,
      detail: options.detail ?? "",
      projectPath,
      options: options.option,
      recommendedOption: options.recommend ?? null,
      refs: options.ref,
    },
    projects,
  );
  console.log(`Created decision ${decision.id}`);
  console.log(decision.projectPath ? `Project: ${decision.projectPath}` : "Unassigned");
}

async function runRemove(options, positionals) {
  if (positionals.length !== 1) throw new WorkspaceError("remove requires exactly one project path.");
  const workspace = await currentWorkspace(options);
  const removed = await deleteProject(workspace, positionals[0]);
  if (removed.folderRemoved) {
    console.log(`Removed project ${removed.projectPath}. The empty folder was deleted.`);
  } else {
    console.log(`Removed project ${removed.projectPath} from Work. The folder was kept because it still has files.`);
  }
}

async function currentWorkspace(options) {
  const root = options.root ?? process.cwd();
  if (!(await findWorkspaceRoot(root))) {
    throw new WorkspaceError("No Work workspace contains this directory. Run `work init` first, or run this command from inside a workspace.");
  }
  return initializeWorkspace(root);
}

async function runTask(options, positionals) {
  if (positionals.length === 0) throw new WorkspaceError("task requires a title in quotes.");
  const workspace = await currentWorkspace(options);
  const projects = await discoverProjects(workspace.root);
  const projectPath = await defaultProjectPath(options, workspace, projects);
  const task = await createTask(workspace, {
    title: positionals.join(" "),
    projectPath,
    delegated: options.delegate === true,
    tags: options.tag,
    dependsOn: options.dependsOn,
    blockedBy: options.blockedBy,
    status: options.status,
    description: options.description,
    goal: options.goal,
    requirements: options.requirement,
    acceptanceCriteria: options.acceptance,
    plan: options.plan,
    notes: options.notes,
  }, projects);
  console.log(`Created ${task.id}: ${task.title}`);
  console.log(`${task.status} · ${task.projectPath ?? "Unassigned"}${task.delegated ? " · handed to an agent" : ""}`);
}

async function runList(options, positionals) {
  if (positionals.length > 0) throw new WorkspaceError("list does not accept positional arguments.");
  if (options.project && options.unassigned) {
    throw new WorkspaceError("Use either --project or --unassigned, not both.");
  }
  const workspace = await currentWorkspace(options);
  let tasks = await listTasks(workspace);
  let scope = "this root";
  if (options.unassigned) {
    tasks = tasks.filter((task) => !task.projectPath);
    scope = "the workspace scope";
  } else if (options.project) {
    // An unknown path used to return silently, which reads as "no work here"
    // rather than "you named a project that does not exist".
    const projects = await discoverProjects(workspace.root);
    const match = projects.find((project) => project.path === options.project);
    if (!match) {
      throw new WorkspaceError(
        `No project at ${options.project}. Run \`work projects\` to see the exact paths.`);
    }
    tasks = tasks.filter((task) => task.projectPath === match.path);
    scope = match.path;
  }
  if (tasks.length === 0) {
    console.log(`No work items in ${scope}.`);
    return;
  }
  for (const task of tasks) {
    console.log(`${task.id}\t${task.status}\t${task.projectPath ?? "-"}\t${task.title}`);
  }
}

async function runShow(options, positionals) {
  if (positionals.length !== 1) throw new WorkspaceError("show requires exactly one task id.");
  console.log(JSON.stringify(await getTask(await currentWorkspace(options), positionals[0]), null, 2));
}

async function runMove(options, positionals) {
  if (positionals.length !== 2) throw new WorkspaceError("move requires a task id and status.");
  const task = await moveTask(await currentWorkspace(options), positionals[0], { status: positionals[1], note: options.note });
  console.log(`${task.id} → ${task.status}`);
}

async function runLog(options, positionals) {
  if (positionals.length < 2) throw new WorkspaceError("log requires a task id and message.");
  const task = await appendTaskLog(await currentWorkspace(options), positionals[0], { message: positionals.slice(1).join(" ") });
  console.log(`Logged progress on ${task.id}`);
}

async function runUpdate(options, positionals) {
  if (positionals.length !== 1) throw new WorkspaceError("update requires exactly one task id.");
  const input = {};
  for (const key of ["title", "description", "goal", "plan", "notes"]) {
    if (options[key] != null) input[key] = options[key];
  }
  if (options.requirement.length > 0) input.requirements = options.requirement;
  if (options.acceptance.length > 0) input.acceptanceCriteria = options.acceptance;
  if (Object.keys(input).length === 0) {
    throw new WorkspaceError("update requires at least one of --title, --description, --goal, --plan, --notes, --requirement, or --acceptance.");
  }
  const task = await updateTask(await currentWorkspace(options), positionals[0], input);
  console.log(`Updated ${task.id}: ${task.title}`);
}

async function runDelegate(options, positionals) {
  if (positionals.length !== 1) throw new WorkspaceError("delegate requires exactly one task id.");
  const task = await updateTask(await currentWorkspace(options), positionals[0], { delegated: options.off !== true });
  console.log(`${task.id} ${task.delegated ? "handed to an agent" : "back with you"}`);
}

const UI_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

// Serves the prebuilt dist/ statically and proxies /api to the local API,
// mirroring the host discipline of server/local-api.mjs. The API keeps its own
// Host/Origin validation for the proxied requests.
async function startUiServer({ distRoot, host, port, apiOrigin }) {
  await stat(join(distRoot, "index.html")).catch(() => {
    throw new WorkspaceError("The built interface is missing. Run `npm run build` in this checkout first.", { code: "ui_build_missing" });
  });
  const server = createServer((request, response) => {
    void handleUiRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  async function handleUiRequest(request, response) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    let hostname = null;
    try {
      hostname = new URL(`http://${request.headers.host}`).hostname;
    } catch {}
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]" && hostname !== "::1" && hostname !== host) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("This interface only accepts requests for its configured host.");
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const upstream = httpRequest(new URL(url.pathname + url.search, apiOrigin), { method: request.method, headers: request.headers }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
      return;
    }
    const relativePath = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let filePath = join(distRoot, relativePath);
    if (relativePath.split(sep).includes("..")) filePath = join(distRoot, "index.html");
    let info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) {
      if (extname(filePath) && !filePath.endsWith(`${sep}index.html`)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found.");
        return;
      }
      filePath = join(distRoot, "index.html");
      info = await stat(filePath);
    }
    response.writeHead(200, {
      "Content-Type": UI_MIME[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(filePath).pipe(response);
  }
  const listen = (selectedPort) => new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(selectedPort, host);
  });
  try {
    await listen(port);
  } catch (error) {
    // The UI port is a preference, never a hard requirement; any free port
    // still proxies to the pinned API origin.
    if (port === 0 || error?.code !== "EADDRINUSE") throw error;
    await listen(0);
  }
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : port };
}

function openLocalUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => console.error(`[work] Open ${url} in a browser.`));
  child.unref();
}

async function runServer(options, positionals) {
  if (positionals.length > 1) throw new WorkspaceError("serve accepts only one root path.");
  const explicitRoot = options.root ?? positionals[0] ?? null;
  const pruned = await pruneRegistry();
  const registered = await listRegisteredWorkspaces();
  // Serving never registers a new root. Only `work init` and `work register`
  // add roots, so launching Work somewhere unexpected cannot grow the registry.
  const nearbyRoot = await findWorkspaceRoot(explicitRoot ?? process.cwd());
  const activeWorkspace = registered.find((workspace) => workspace.root === nearbyRoot)
    ?? (explicitRoot ? null : registered.at(-1));
  if (!activeWorkspace) {
    const candidate = nearbyRoot ?? (explicitRoot ? resolve(explicitRoot) : process.cwd());
    throw new WorkspaceError(
      `${candidate} is not a registered Work root, and serving does not register roots on its own. Run \`work init ${candidate}\` first, or serve an already-registered root (see \`work roots\`).`,
    );
  }
  const root = activeWorkspace.root;
  const apiPort = parsePort(options.apiPort, DEFAULT_API_PORT, "--api-port");
  const uiPort = parsePort(options.uiPort, DEFAULT_UI_PORT, "--ui-port");
  const listenHost = options.tailscale ? await discoverTailscaleIPv4() : "127.0.0.1";
  const updater = await createServiceUpdater({ packageRoot: APP_ROOT });
  const localApi = await startLocalApi({
    root,
    roots: registered.map((workspace) => workspace.root),
    defaultWorkspaceId: activeWorkspace.id,
    port: apiPort,
    host: listenHost,
    onRestart: restartService,
    version: updater.currentVersion,
    checkForUpdate: updater.checkForUpdate,
    onUpdate: updater.installUpdate,
    fallbackOnPortConflict: options.apiPort == null,
  });
  console.log(`[work] Workspace: ${localApi.workspace.root}`);
  if (pruned.length > 0) {
    console.log(`[work] Roots available: ${localApi.workspaces.length} (pruned ${pruned.length} dead root${pruned.length === 1 ? "" : "s"})`);
  } else {
    console.log(`[work] Roots available: ${localApi.workspaces.length}`);
  }
  console.log(`[work] API ready at ${localApi.origin}`);
  if (apiPort !== 0 && localApi.port !== apiPort) {
    console.log(`[work] Preferred API port ${apiPort} was occupied; using ${localApi.port} instead.`);
  }
  if (options.tailscale) {
    console.log("[work] Tailnet access is enabled. Anyone permitted by your Tailscale ACLs can use and modify this Work instance.");
  }

  let mcpSidecar = null;
  if (options.mcp) {
    try {
      mcpSidecar = await startMcpSidecar({ apiOrigin: localApi.origin, projectRoot: APP_ROOT });
      localApi.configureMcp(mcpSidecar);
      console.log(`[work] MCP ready at ${localApi.origin}/mcp`);
      console.log(`[work] MCP configuration: { "url": "${localApi.origin}/mcp" }`);
      if (options.tailscale) console.log("[work] Tailnet ACLs control who can invoke the exposed MCP tools.");
    } catch (error) {
      await closeLocalApi(localApi.server).catch(() => {});
      throw new WorkspaceError(`Could not start MCP: ${error.message}`, { code: "mcp_start_failed" });
    }
  }

  let uiServer = null;
  let shuttingDown = false;

  async function shutdown(exitCode = 0, { restart = false } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (uiServer?.listening) {
      await new Promise((resolvePromise) => {
        uiServer.close(() => resolvePromise());
        uiServer.closeIdleConnections?.();
      });
    }
    await mcpSidecar?.stop().catch((error) => console.error(`[work:mcp] ${error.message}`));
    await closeLocalApi(localApi.server).catch((error) => console.error(`[work] ${error.message}`));
    if (restart) {
      console.log("[work] Restarting local service…");
      const replacement = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        detached: true,
        env: process.env,
        // A detached replacement must not retain the terminal handles owned by
        // the process that is about to exit. Inheriting them can cause terminal
        // and app launchers to reap the replacement with its parent.
        stdio: "ignore",
      });
      replacement.unref();
    }
    process.exitCode = exitCode;
  }

  async function restartService() {
    await shutdown(0, { restart: true });
  }

  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));

  if (!options.noUi) {
    try {
      const ui = await startUiServer({
        distRoot: join(APP_ROOT, "dist"),
        host: listenHost,
        port: uiPort,
        apiOrigin: localApi.origin,
      });
      uiServer = ui.server;
      const uiUrl = `http://${listenHost}:${ui.port}/`;
      console.log(`[work] UI ready at ${uiUrl}`);
      if (!options.noOpen) openLocalUrl(uiUrl);
    } catch (error) {
      console.error(`[work] Could not start the UI: ${error.message}`);
      await shutdown(1);
    }
  }
}

const COMMANDS = {
  serve: runServer,
  init: runInit,
  register: runRegister,
  unregister: runUnregister,
  roots: runRoots,
  projects: runProjects,
  new: runNew,
  remove: runRemove,
  agent: runAgent,
  add: runAdd,
  decision: runDecision,
  task: runTask,
  create: runTask,
  list: runList,
  show: runShow,
  update: runUpdate,
  move: runMove,
  log: runLog,
  delegate: runDelegate,
};

async function main() {
  const argv = process.argv.slice(2);
  const run = Object.hasOwn(COMMANDS, argv[0]) ? COMMANDS[argv.shift()] : runServer;
  const { options, positionals } = parseArguments(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  return run(options, positionals);
}

main().catch((error) => {
  if (error instanceof WorkspaceError) {
    console.error(`work: ${error.message}`);
  } else if (error?.code === "EADDRINUSE") {
    const address = error.address ? ` on ${error.address}` : "";
    const port = error.port ? ` ${error.port}` : "";
    console.error(`work: The explicitly requested API port${port}${address} is already in use.`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
