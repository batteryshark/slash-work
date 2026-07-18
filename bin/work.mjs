#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WorkspaceError,
  appendTaskLog,
  createCapture,
  createDecision,
  createIdea,
  createTask,
  discoverProjects,
  findWorkspaceRoot,
  getTask,
  initializeWorkspace,
  listTasks,
  listIdeas,
  moveTask,
  updateTask,
} from "../lib/local-workspace.mjs";
import {
  listRegisteredWorkspaces,
  registerWorkspace,
  unregisterWorkspace,
  workspaceRegistryPath,
} from "../lib/workspace-registry.mjs";
import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";
import { createServiceUpdater } from "../lib/service-updater.mjs";
import { federationConfigPath } from "../lib/instance-federation.mjs";
import { discoverTailscaleIPv4 } from "../lib/tailscale-network.mjs";
import { createServer as createViteServer } from "vite";
import {
  getAgentIndex,
  getAgentOperation,
  getArtifactSchema,
  listAgentOperations,
  renderAgentIndexMarkdown,
  renderAgentOperationMarkdown,
  renderAgentOperationsMarkdown,
} from "../lib/agent-capabilities.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Work — local, root-scoped project memory

Usage:
  work [root]                         Start the local UI and API
  work serve [root]                   Start the local UI and API
  work init [root]                    Create a workspace at this exact root
  work register [root]                Register this exact root for the workspace picker
  work unregister <id|root>           Remove a root from the web workspace picker
  work roots                          List roots available to the web workspace picker
  work agent                          Print the agent capability bootstrap
  work agent operations               List available task-scoped operations
  work agent instructions <operation> Print instructions for one operation
  work agent schema <artifact>        Print one artifact's JSON Schema
  work add "thought" [options]        Capture from any workspace descendant
  work idea "title" [options]         Record something worth evaluating
  work ideas                           List ideas and their states
  work decision "question" [options] Create a decision from any descendant
  work task "title" [options]         Create a full Kanban work item
  work list                            List work items in the current root
  work show <id>                       Print a complete work item
  work move <id> <status> [--note n]  Move a card and append to its log
  work assign <id> [name]             Assign or unassign a card
  work log <id> "what happened"        Append a progress entry

Options:
  --root <path>       Select a root (otherwise search upward from the current directory)
  --scope <path>      Override the invocation directory's folder scope
  --project <path>    Assign to this exact discovered project (never inferred)
  --kind <kind>       idea, question, or update
  --detail <text>     Decision context
  --option <text>     Decision option; may be repeated
  --recommend <text>  Recommend one exact recorded decision option
  --type <type>       task, bug, feature, research, admin, epic, or idea
  --priority <level>  critical, high, medium, low, or none
  --assignee <name>   Human owner
  --agent <name>      Agent or team; may be repeated
  --tag <tag>         Tag; may be repeated
  --depends-on <id>   Dependency; may be repeated
  --blocked-by <id>   Blocker task; may be repeated
  --status <status>   Initial Kanban status
  --goal <text>       Goal section
  --requirement <x>   Requirement checkbox; may be repeated
  --acceptance <x>    Acceptance criterion; may be repeated
  --plan <text>       Plan section
  --notes <text>      Notes section
  --note <text>       Status-change note
  --api-port <port>   Pin the local API port (default preference: 43170)
  --ui-port <port>    Local UI port (default: 3000)
  --format <format>   Agent output format: markdown or json
  --json              Shortcut for --format json
  --no-ui             Start only the local API
  --no-open           Do not open the local UI in your browser
  --tailscale         Listen only on this machine's Tailscale IPv4 address
  --init              Force a new workspace at the selected root
  -h, --help          Show this help

Examples:
  work ~/Projects
  work add "check whether the release needs a migration" --scope tools
  work add "validate the parser" --scope tools/parser --project tools/parser
  work idea "Federate remote Work instances" --detail "Explore read-only project trees across servers"
  work decision "Where should the lab live?" --option "Keep unassigned" --option "Assign later"
  work task "Implement the board" --project tools/runner --type feature --priority high
  work move W-0001 in_progress --note "Agent team started implementation"
  work log W-0001 "API and restart tests pass"
`;

function parseArguments(argv) {
  const options = { option: [], agent: [], tag: [], dependsOn: [], blockedBy: [], requirement: [], acceptance: [] };
  const positionals = [];
  const valueOptions = new Map([
    ["--root", "root"],
    ["--scope", "scope"],
    ["--project", "project"],
    ["--kind", "kind"],
    ["--detail", "detail"],
    ["--option", "option"],
    ["--recommend", "recommend"],
    ["--type", "type"],
    ["--priority", "priority"],
    ["--assignee", "assignee"],
    ["--agent", "agent"],
    ["--tag", "tag"],
    ["--depends-on", "dependsOn"],
    ["--blocked-by", "blockedBy"],
    ["--status", "status"],
    ["--goal", "goal"],
    ["--requirement", "requirement"],
    ["--acceptance", "acceptance"],
    ["--plan", "plan"],
    ["--notes", "notes"],
    ["--note", "note"],
    ["--api-port", "apiPort"],
    ["--ui-port", "uiPort"],
    ["--format", "format"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "--no-ui") {
      options.noUi = true;
      continue;
    }
    if (token === "--no-open") {
      options.noOpen = true;
      continue;
    }
    if (token === "--tailscale") {
      options.tailscale = true;
      continue;
    }
    if (token === "--init") {
      options.forceInit = true;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    const optionName = valueOptions.get(token);
    if (optionName) {
      const value = argv[index + 1];
      if (value == null || value.startsWith("--")) throw new WorkspaceError(`${token} requires a value.`);
      if (["option", "agent", "tag", "dependsOn", "blockedBy", "requirement", "acceptance"].includes(optionName)) options[optionName].push(value);
      else options[optionName] = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) throw new WorkspaceError(`Unknown option: ${token}`);
    positionals.push(token);
  }
  return { options, positionals };
}

function parsePort(value, fallback, label) {
  if (value == null) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new WorkspaceError(`${label} must be an integer between 0 and 65535.`);
  }
  return port;
}

async function selectedRoot(options, positionalRoot) {
  return options.root ?? positionalRoot ?? process.cwd();
}

async function invocationScope(workspace) {
  const currentDirectory = await realpath(process.cwd());
  const rel = relative(workspace.root, currentDirectory);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return ".";
  return rel.split(sep).join("/");
}

async function runInit(options, positionals) {
  if (positionals.length > 1) throw new WorkspaceError("init accepts only one root path.");
  const root = await selectedRoot(options, positionals[0]);
  const workspace = await initializeWorkspace(root, { force: true });
  console.log(`Initialized Work at ${workspace.root}`);
  console.log(`Data: ${workspace.dataDir}`);
}

async function runRegister(options, positionals) {
  if (positionals.length > 1) throw new WorkspaceError("register accepts only one root path.");
  const workspace = await registerWorkspace(await selectedRoot(options, positionals[0]), { force: true });
  console.log(`Registered ${workspace.name}`);
  console.log(`Root: ${workspace.root}`);
}

async function runUnregister(options, positionals) {
  if (options.root || positionals.length !== 1) throw new WorkspaceError("unregister requires one workspace id or root path.");
  await unregisterWorkspace(positionals[0]);
  console.log(`Unregistered ${positionals[0]}`);
}

async function runRoots(options, positionals) {
  if (options.root || positionals.length > 0) throw new WorkspaceError("roots does not accept a root argument.");
  const workspaces = await listRegisteredWorkspaces({ initialize: false });
  if (workspaces.length === 0) {
    console.log("No roots registered. Run: work register /path/to/root");
    return;
  }
  for (const workspace of workspaces) console.log(`${workspace.id}\t${workspace.name}\t${workspace.root}`);
  console.log(`Registry: ${workspaceRegistryPath()}`);
}

function agentOutputFormat(options, fallback = "markdown") {
  const format = options.json ? "json" : options.format ?? fallback;
  if (!new Set(["markdown", "json"]).has(format)) {
    throw new WorkspaceError("--format must be markdown or json.");
  }
  return format;
}

async function runAgent(options, positionals) {
  const [command, value, ...extra] = positionals;
  if (extra.length > 0) throw new WorkspaceError("agent accepts only a command and one operation or artifact name.");

  if (command == null) {
    if (value != null) throw new WorkspaceError("Unexpected agent argument.");
    const format = agentOutputFormat(options);
    process.stdout.write(format === "json" ? `${JSON.stringify(getAgentIndex(), null, 2)}\n` : renderAgentIndexMarkdown());
    return;
  }

  if (command === "operations") {
    if (value != null) throw new WorkspaceError("agent operations does not accept an operation name.");
    const format = agentOutputFormat(options);
    process.stdout.write(format === "json" ? `${JSON.stringify(listAgentOperations(), null, 2)}\n` : renderAgentOperationsMarkdown());
    return;
  }

  if (command === "instructions") {
    if (!value) throw new WorkspaceError("agent instructions requires an operation name. Run `work agent operations` first.");
    const operation = getAgentOperation(value);
    if (!operation) throw new WorkspaceError(`Unknown agent operation: ${value}. Run \`work agent operations\` first.`);
    const format = agentOutputFormat(options);
    process.stdout.write(format === "json" ? `${JSON.stringify(operation, null, 2)}\n` : renderAgentOperationMarkdown(value));
    return;
  }

  if (command === "schema") {
    if (!value) throw new WorkspaceError("agent schema requires capture, note, idea, decision, or task.");
    const schema = getArtifactSchema(value);
    if (!schema) throw new WorkspaceError(`Unknown artifact type: ${value}.`);
    const format = agentOutputFormat(options, "json");
    const json = JSON.stringify(schema, null, 2);
    process.stdout.write(format === "json" ? `${json}\n` : `# ${value} artifact schema\n\n\`\`\`json\n${json}\n\`\`\`\n`);
    return;
  }

  throw new WorkspaceError(`Unknown agent command: ${command}. Use operations, instructions, or schema.`);
}

async function runAdd(options, positionals) {
  if (positionals.length === 0) throw new WorkspaceError("add requires a thought in quotes.");
  const text = positionals.join(" ");
  const workspace = await initializeWorkspace(await selectedRoot(options));
  const projects = await discoverProjects(workspace.root);
  const scopePath = options.scope ?? (await invocationScope(workspace));
  const capture = await createCapture(
    workspace,
    {
      text,
      kind: options.kind,
      scopePath,
      projectPath: options.project ?? null,
    },
    projects,
  );
  console.log(`Captured ${capture.id}`);
  console.log(`Scope: ${capture.scopePath}${capture.projectPath ? ` · Project: ${capture.projectPath}` : " · Unassigned"}`);
}

async function runDecision(options, positionals) {
  if (positionals.length === 0) throw new WorkspaceError("decision requires a question in quotes.");
  const title = positionals.join(" ");
  const workspace = await initializeWorkspace(await selectedRoot(options));
  const projects = await discoverProjects(workspace.root);
  const decision = await createDecision(
    workspace,
    {
      title,
      detail: options.detail ?? "",
      projectPath: options.project ?? null,
      options: options.option,
      recommendedOption: options.recommend ?? null,
    },
    projects,
  );
  console.log(`Created decision ${decision.id}`);
  console.log(decision.projectPath ? `Project: ${decision.projectPath}` : "Unassigned");
}

async function runIdea(options, positionals) {
  if (positionals.length === 0) throw new WorkspaceError("idea requires a title in quotes.");
  const workspace = await initializeWorkspace(await selectedRoot(options));
  const projects = await discoverProjects(workspace.root);
  const scopePath = options.scope ?? (await invocationScope(workspace));
  const idea = await createIdea(workspace, {
    title: positionals.join(" "),
    opportunity: options.detail ?? "",
    scopePath,
    projectPath: options.project ?? null,
    tags: options.tag,
  }, projects);
  console.log(`Created idea ${idea.id}: ${idea.title}`);
  console.log(`${idea.status} · ${idea.projectPath ?? idea.scopePath}`);
}

async function runIdeas(options, positionals) {
  if (positionals.length > 0) throw new WorkspaceError("ideas does not accept positional arguments.");
  const ideas = await listIdeas(await currentWorkspace(options));
  if (ideas.length === 0) {
    console.log("No ideas in this root.");
    return;
  }
  for (const idea of ideas) console.log(`${idea.id}\t${idea.status}\t${idea.projectPath ?? idea.scopePath}\t${idea.title}`);
}

async function currentWorkspace(options) {
  return initializeWorkspace(await selectedRoot(options));
}

async function runTask(options, positionals) {
  if (positionals.length === 0) throw new WorkspaceError("task requires a title in quotes.");
  const workspace = await currentWorkspace(options);
  const projects = await discoverProjects(workspace.root);
  const task = await createTask(workspace, {
    title: positionals.join(" "),
    projectPath: options.project ?? null,
    type: options.type,
    priority: options.priority,
    assignee: options.assignee,
    agents: options.agent,
    tags: options.tag,
    dependsOn: options.dependsOn,
    blockedBy: options.blockedBy,
    status: options.status,
    goal: options.goal,
    requirements: options.requirement,
    acceptanceCriteria: options.acceptance,
    plan: options.plan,
    notes: options.notes,
  }, projects);
  console.log(`Created ${task.id}: ${task.title}`);
  console.log(`${task.status} · ${task.projectPath ?? "Unassigned"} · ${task.priority}`);
}

async function runList(options, positionals) {
  if (positionals.length > 0) throw new WorkspaceError("list does not accept positional arguments.");
  const tasks = await listTasks(await currentWorkspace(options));
  if (tasks.length === 0) {
    console.log("No work items in this root.");
    return;
  }
  for (const task of tasks) {
    console.log(`${task.id}\t${task.status}\t${task.priority}\t${task.projectPath ?? "-"}\t${task.title}`);
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

async function runAssign(options, positionals) {
  if (positionals.length < 1 || positionals.length > 2) throw new WorkspaceError("assign requires a task id and optional assignee.");
  const workspace = await currentWorkspace(options);
  const task = await updateTask(workspace, positionals[0], { assignee: positionals[1] ?? null }, await discoverProjects(workspace.root));
  console.log(`${task.id} ${task.assignee ? `assigned to ${task.assignee}` : "unassigned"}`);
}

async function runLog(options, positionals) {
  if (positionals.length < 2) throw new WorkspaceError("log requires a task id and message.");
  const task = await appendTaskLog(await currentWorkspace(options), positionals[0], { message: positionals.slice(1).join(" ") });
  console.log(`Logged progress on ${task.id}`);
}

function openLocalUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => console.error(`[work] Open ${url} in a browser.`));
  child.unref();
}

async function stopUiServer(server) {
  if (!server) return;
  await server.close();
}

async function runServer(options, positionals) {
  if (positionals.length > 1) throw new WorkspaceError("serve accepts only one root path.");
  const explicitRoot = options.root ?? positionals[0] ?? null;
  let registered = await listRegisteredWorkspaces();
  let activeWorkspace;
  if (explicitRoot) {
    activeWorkspace = await registerWorkspace(explicitRoot, { force: options.forceInit === true });
  } else {
    const nearbyRoot = await findWorkspaceRoot(process.cwd());
    activeWorkspace = registered.find((workspace) => workspace.root === nearbyRoot);
    if (!activeWorkspace && nearbyRoot && registered.length === 0) {
      activeWorkspace = await registerWorkspace(nearbyRoot);
    }
  }
  if (!activeWorkspace && registered.length === 0) {
    activeWorkspace = await registerWorkspace(process.cwd(), { force: options.forceInit === true });
    registered = [activeWorkspace];
  }
  activeWorkspace ??= registered.at(-1);
  if (!registered.some((workspace) => workspace.id === activeWorkspace.id)) registered.push(activeWorkspace);
  const root = activeWorkspace.root;
  const apiPort = parsePort(options.apiPort, 43170, "--api-port");
  const uiPort = parsePort(options.uiPort, 3000, "--ui-port");
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
    federationConfigFile: federationConfigPath(),
    fallbackOnPortConflict: options.apiPort == null,
  });
  console.log(`[work] Workspace: ${localApi.workspace.root}`);
  console.log(`[work] Roots available: ${localApi.workspaces.length}`);
  console.log(`[work] API ready at ${localApi.origin}`);
  if (apiPort !== 0 && localApi.port !== apiPort) {
    console.log(`[work] Preferred API port ${apiPort} was occupied; using ${localApi.port} instead.`);
  }
  if (options.tailscale) {
    console.log("[work] Tailnet access is enabled. Anyone permitted by your Tailscale ACLs can use and modify this Work instance.");
  }

  let uiServer = null;
  let shuttingDown = false;

  async function shutdown(exitCode = 0, { restart = false } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopUiServer(uiServer);
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
      uiServer = await createViteServer({
        root: APP_ROOT,
        server: {
          host: listenHost,
          port: uiPort,
          allowedHosts: [listenHost],
          proxy: {
            "/api": {
              target: localApi.origin,
              changeOrigin: false,
            },
          },
        },
      });
      await uiServer.listen();
      const address = uiServer.httpServer?.address();
      const selectedUiPort = typeof address === "object" && address ? address.port : uiPort;
      const uiUrl = `http://${listenHost}:${selectedUiPort}/`;
      console.log(`[work] UI ready at ${uiUrl}`);
      if (!options.noOpen) openLocalUrl(uiUrl);
    } catch (error) {
      console.error(`[work] Could not start the UI: ${error.message}`);
      await shutdown(1);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const knownCommands = new Set(["serve", "init", "register", "unregister", "roots", "agent", "add", "idea", "ideas", "decision", "task", "create", "list", "show", "move", "assign", "log"]);
  const command = knownCommands.has(argv[0]) ? argv.shift() : "serve";
  const { options, positionals } = parseArguments(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (command === "init") return runInit(options, positionals);
  if (command === "register") return runRegister(options, positionals);
  if (command === "unregister") return runUnregister(options, positionals);
  if (command === "roots") return runRoots(options, positionals);
  if (command === "agent") return runAgent(options, positionals);
  if (command === "add") return runAdd(options, positionals);
  if (command === "idea") return runIdea(options, positionals);
  if (command === "ideas") return runIdeas(options, positionals);
  if (command === "decision") return runDecision(options, positionals);
  if (command === "task" || command === "create") return runTask(options, positionals);
  if (command === "list") return runList(options, positionals);
  if (command === "show") return runShow(options, positionals);
  if (command === "move") return runMove(options, positionals);
  if (command === "assign") return runAssign(options, positionals);
  if (command === "log") return runLog(options, positionals);
  return runServer(options, positionals);
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
