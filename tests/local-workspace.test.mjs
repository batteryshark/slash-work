import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";
import { createTask, discoverProjects, initializeWorkspace } from "../lib/local-workspace.mjs";
import { chooseWorkspaceDirectory } from "../lib/native-folder-picker.mjs";
import { registerWorkspace } from "../lib/workspace-registry.mjs";
import { normalizeTags, tagHueAngle, tagHueIndex, workspaceTags } from "../lib/tags.mjs";

const temporaryDirectories = [];
const execFile = promisify(execFileCallback);
const repositoryRoot = new URL("../", import.meta.url);
const launcherPath = new URL("../bin/work.mjs", import.meta.url);

// Every fixture lives under tmpdir(), which registration refuses for real
// users. Tests opt out of that guard, and default the registry file to a
// scratch path so no CLI invocation can ever touch ~/.work/roots.json.
process.env.WORK_ALLOW_TEMP_ROOTS = "1";
if (!process.env.WORK_REGISTRY_FILE) {
  process.env.WORK_REGISTRY_FILE = join(tmpdir(), `work-test-default-registry-${process.pid}.json`);
  temporaryDirectories.push(process.env.WORK_REGISTRY_FILE);
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeWorkspaceFixture() {
  const root = await temporaryDirectory("work-root-");
  const outside = await temporaryDirectory("work-outside-");

  await mkdir(join(root, "software", "rekit"), { recursive: true });
  await mkdir(join(root, "research", "unmask", ".project"), { recursive: true });
  await mkdir(join(root, "scratch", "package-only"), { recursive: true });
  await mkdir(join(root, "scratch", "git-only", ".git"), { recursive: true });
  await mkdir(join(outside, "private-project", ".project"), { recursive: true });
  await writeFile(join(root, "software", "rekit", ".project"), "");
  await writeFile(join(root, "software", "rekit", "package.json"), "{}\n");
  await writeFile(join(root, "scratch", "package-only", "package.json"), "{}\n");
  await writeFile(join(outside, "private-project", "secret.md"), "outside\n");
  await symlink(outside, join(root, "outside-link"));

  return { root, outside };
}

async function apiRequest(origin, pathname, { body, ...options } = {}) {
  const response = await fetch(new URL(pathname, origin), {
    ...options,
    headers: body
      ? { "content-type": "application/json", ...options.headers }
      : options.headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

async function launchApiFromCli(root, { cwd = repositoryRoot, registryPath = root ? join(root, ".work-test-roots.json") : null } = {}) {
  if (!registryPath) throw new Error("launchApiFromCli requires a registry path when no root is supplied.");
  if (root) {
    // Serving never registers roots, so the fixture root is registered first.
    await execFile(process.execPath, [launcherPath.pathname, "register", root], {
      cwd: repositoryRoot,
      env: { ...process.env, WORK_REGISTRY_FILE: registryPath },
    });
  }
  const child = spawn(
    process.execPath,
    [launcherPath.pathname, "serve", ...(root ? [root] : []), "--no-ui", "--api-port", "0"],
    {
      cwd,
      env: { ...process.env, WORK_REGISTRY_FILE: registryPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Work did not print a ready URL. stderr: ${stderr}`));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/\[work\] API ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Work exited before becoming ready (${code ?? signal}). stderr: ${stderr}`,
        ),
      );
    });
  });

  return { child, origin };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

function projectPath(project) {
  return project.path ?? project.projectPath ?? project.relativePath;
}

function workspaceRoot(workspace) {
  return workspace.root ?? workspace.rootPath;
}

test("exposes a memorable launcher that resumes the nearest workspace", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.bin.work, "bin/work.mjs");
  assert.equal(packageJson.scripts.work, "node ./bin/work.mjs");

  const help = await execFile(process.execPath, [launcherPath.pathname, "--help"], {
    cwd: repositoryRoot,
  });
  assert.match(help.stdout, /work \[root\]/i);
  assert.match(help.stdout, /--init/);
  assert.match(help.stdout, /work remove <rel-path>/i);
  assert.match(help.stdout, /work projects/i);
  assert.match(help.stdout, /work agent context/i);
  assert.match(help.stdout, /--project <path>.*exact discovered project/i);
  assert.match(help.stdout, /--unassigned.*workspace scope/i);
  assert.match(help.stdout, /--tailscale.*Tailscale IPv4/i);
  assert.match(help.stdout, /--api-port <port>.*43170/i);
  assert.match(help.stdout, /--ui-port <port>.*43171/i);
  assert.doesNotMatch(help.stdout, /--ui-port <port>.*3000/i);

  const root = await temporaryDirectory("work-cli-root-");
  const descendant = join(root, "projects", "one");
  await mkdir(descendant, { recursive: true });

  await execFile(process.execPath, [launcherPath.pathname, "init", root], {
    cwd: repositoryRoot,
  });
  const exactThought = "keep this unassigned even though it mentions ReKit";
  const added = await execFile(
    process.execPath,
    [launcherPath.pathname, "add", exactThought],
    { cwd: descendant },
  );
  assert.match(added.stdout, /Unassigned/);

  const captureFiles = await readdir(join(root, ".work", "captures"));
  assert.equal(captureFiles.length, 1);
  const markdown = await readFile(
    join(root, ".work", "captures", captureFiles[0]),
    "utf8",
  );
  assert.ok(markdown.includes(exactThought));
  assert.match(markdown, /scopePath: "projects\/one"/);
  assert.match(markdown, /projectPath: null/);
  await assert.rejects(readdir(join(descendant, ".work")), { code: "ENOENT" });

  const decision = await execFile(
    process.execPath,
    [
      launcherPath.pathname,
      "decision",
      "Where should the lab live?",
      "--option",
      "Keep unassigned",
      "--option",
      "Assign later",
      "--recommend",
      "Keep unassigned",
    ],
    { cwd: descendant },
  );
  assert.match(decision.stdout, /Created decision/);
  assert.match(decision.stdout, /Unassigned/);
  const decisionFiles = await readdir(join(root, ".work", "decisions"));
  assert.equal(decisionFiles.length, 1);
  const decisionMarkdown = await readFile(
    join(root, ".work", "decisions", decisionFiles[0]),
    "utf8",
  );
  assert.ok(decisionMarkdown.includes("Where should the lab live?"));
  assert.ok(decisionMarkdown.includes("Keep unassigned"));
  assert.match(decisionMarkdown, /recommendedOption: "Keep unassigned"/);
  assert.match(decisionMarkdown, /Keep unassigned — Recommended/);

  const createdTask = await execFile(
    process.execPath,
    [
      launcherPath.pathname,
      "task",
      "Build the operational board",
      "--delegate",
      "--description",
      "The team tracks work in three chat threads and loses it.",
      "--requirement",
      "Show work in flight",
      "--acceptance",
      "Completed work remains visible",
    ],
    { cwd: descendant },
  );
  assert.match(createdTask.stdout, /Created W-0001/);
  assert.match(createdTask.stdout, /handed to an agent/);
  const createdTaskFile = await readFile(join(root, ".work", "tasks", "W-0001.md"), "utf8");
  assert.match(createdTaskFile, /## Description\nThe team tracks work in three chat threads and loses it\./);
  assert.ok(createdTaskFile.indexOf("## Description") < createdTaskFile.indexOf("## Goal"), "Description precedes Goal on disk");
  const updatedTask = await execFile(
    process.execPath,
    [
      launcherPath.pathname,
      "update",
      "W-0001",
      "--description",
      "Work now spans four chat threads.",
      "--goal",
      "One durable board owns the work list.",
    ],
    { cwd: descendant },
  );
  assert.match(updatedTask.stdout, /Updated W-0001/);
  const updatedTaskFile = await readFile(join(root, ".work", "tasks", "W-0001.md"), "utf8");
  assert.match(updatedTaskFile, /## Description\nWork now spans four chat threads\./);
  assert.match(updatedTaskFile, /## Goal\nOne durable board owns the work list\./);
  assert.match(updatedTaskFile, /- \[ \] Show work in flight/, "update leaves unpassed sections untouched");
  await execFile(process.execPath, [launcherPath.pathname, "move", "W-0001", "in_progress"], { cwd: descendant });
  await execFile(process.execPath, [launcherPath.pathname, "log", "W-0001", "Board implementation started"], { cwd: descendant });
  const listedTasks = await execFile(process.execPath, [launcherPath.pathname, "list"], { cwd: descendant });
  assert.match(listedTasks.stdout, /W-0001\s+in_progress/);

  // --project filters rather than being ignored, and a path that matches no
  // project says so instead of printing an empty list that reads as "no work".
  await execFile(process.execPath, [launcherPath.pathname, "new", "Filtered"], { cwd: root });
  const filtered = await execFile(
    process.execPath, [launcherPath.pathname, "list", "--project", "filtered"], { cwd: root });
  assert.match(filtered.stdout, /No work items in filtered\./);
  const unassigned = await execFile(
    process.execPath, [launcherPath.pathname, "list", "--unassigned"], { cwd: root });
  assert.match(unassigned.stdout, /W-0001/, "the root-scoped task is workspace scope, not a project");
  await assert.rejects(
    execFile(process.execPath, [launcherPath.pathname, "list", "--project", "nope"], { cwd: root }),
    /No project at nope/);
  const shownTask = await execFile(process.execPath, [launcherPath.pathname, "show", "W-0001"], { cwd: descendant });
  assert.match(shownTask.stdout, /Board implementation started/);
  assert.match(shownTask.stdout, /Work now spans four chat threads\./);
  assert.match(shownTask.stdout, /One durable board owns the work list\./);

  const launched = await launchApiFromCli(root);
  try {
    const health = await apiRequest(launched.origin, "/api/health");
    assert.equal(health.response.status, 200);
    // A long-lived service keeps its code in memory; it must say so when the
    // files it was started from have moved on, or it serves a stale build
    // silently for as long as it stays up.
    assert.equal(health.payload.service.staleBuild, false);
    const before = await apiRequest(launched.origin, "/api/workspace");
    assert.equal(before.payload.staleBuild, false);

    const { utimes } = await import("node:fs/promises");
    const touched = new URL("../package.json", import.meta.url);
    const future = new Date(Date.now() + 60_000);
    await utimes(touched, future, future);
    await new Promise((resolve) => setTimeout(resolve, 4100));  // fingerprint throttle

    const after = await apiRequest(launched.origin, "/api/workspace");
    assert.equal(after.payload.staleBuild, true);
    assert.notEqual(after.response.headers.get("etag"),
                    before.response.headers.get("etag"),
                    "the fingerprint must invalidate the cached snapshot, or the poll 304s forever");
  } finally {
    await stopChild(launched.child);
  }
});

test("resolves a marked current project for agents and local artifact creation", async () => {
  const root = await temporaryDirectory("work-current-project-");
  const project = join(root, "piu-recomp");
  const nested = join(project, "src", "runtime");
  await execFile(process.execPath, [launcherPath.pathname, "init", root], { cwd: repositoryRoot });
  await mkdir(join(project, ".work"), { recursive: true });
  await mkdir(nested, { recursive: true });
  const canonicalRoot = await realpath(root);

  const bootstrap = await execFile(process.execPath, [launcherPath.pathname, "agent"], { cwd: nested });
  assert.ok(bootstrap.stdout.includes(`Workspace: \`${canonicalRoot}\``));
  assert.match(bootstrap.stdout, /Project: `piu-recomp`/);
  assert.match(bootstrap.stdout, /marker: `\.work`/);
  assert.match(bootstrap.stdout, /Default for new local artifacts: `--project piu-recomp`/);

  const contextResult = await execFile(process.execPath, [launcherPath.pathname, "agent", "context", "--json"], { cwd: nested });
  const context = JSON.parse(contextResult.stdout);
  assert.equal(context.workspace.root, canonicalRoot);
  assert.equal(context.scopePath, "piu-recomp/src/runtime");
  assert.equal(context.project.path, "piu-recomp");
  assert.equal(context.project.marker, ".work");
  assert.equal(context.defaultProjectPath, "piu-recomp");
  assert.deepEqual(await readdir(join(project, ".work")), [], "agent context must not hydrate or mutate an empty project marker");

  const projectsResult = await execFile(process.execPath, [launcherPath.pathname, "projects", "--json"], { cwd: nested });
  const projects = JSON.parse(projectsResult.stdout).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].path, "piu-recomp");
  assert.deepEqual(await readdir(join(project, ".work")), [], "project listing must not hydrate or mutate an empty project marker");

  const capture = await execFile(process.execPath, [launcherPath.pathname, "add", "Preserve current project context"], { cwd: nested });
  assert.match(capture.stdout, /Project: piu-recomp/);
  const decision = await execFile(process.execPath, [launcherPath.pathname, "decision", "Use exact current project?"], { cwd: nested });
  assert.match(decision.stdout, /Project: piu-recomp/);
  const task = await execFile(process.execPath, [launcherPath.pathname, "task", "Route work into this project"], { cwd: nested });
  assert.match(task.stdout, /piu-recomp/);

  assert.equal((await readdir(join(project, ".work", "captures"))).length, 1);
  assert.equal((await readdir(join(project, ".work", "decisions"))).length, 1);
  const projectTasks = await readdir(join(project, ".work", "tasks"));
  assert.equal(projectTasks.length, 1);
  assert.match(await readFile(join(project, ".work", "tasks", projectTasks[0]), "utf8"), /projectPath: "piu-recomp"/);
  assert.deepEqual(await readdir(join(root, ".work", "tasks")), []);

  const unassigned = await execFile(process.execPath, [launcherPath.pathname, "task", "Keep this at workspace scope", "--unassigned"], { cwd: nested });
  assert.match(unassigned.stdout, /Unassigned/);
  const rootTasks = await readdir(join(root, ".work", "tasks"));
  assert.equal(rootTasks.length, 1);
  assert.match(await readFile(join(root, ".work", "tasks", rootTasks[0]), "utf8"), /projectPath: null/);

  await assert.rejects(
    execFile(process.execPath, [launcherPath.pathname, "task", "Conflicting destination", "--project", "piu-recomp", "--unassigned"], { cwd: nested }),
    (error) => /--project and --unassigned cannot be used together/.test(error.stderr),
  );
});

test("refuses to register nested roots in either direction with actionable guidance", async () => {
  const parent = await temporaryDirectory("work-nesting-parent-");
  const nested = join(parent, "data", "build", "orchestra");
  const registryPath = join(parent, "roots.json");
  await mkdir(nested, { recursive: true });
  const canonicalParent = await realpath(parent);
  const environment = { ...process.env, WORK_REGISTRY_FILE: registryPath };

  await execFile(process.execPath, [launcherPath.pathname, "register", parent], { cwd: repositoryRoot, env: environment });

  // Inner direction: a directory inside a registered root cannot become a root.
  await assert.rejects(
    execFile(process.execPath, [launcherPath.pathname, "register", nested], { cwd: repositoryRoot, env: environment }),
    (error) =>
      error.stderr.includes(`${canonicalParent} is already a Work root.`)
      && error.stderr.includes('work new "orchestra" --under data/build')
      && error.stderr.includes("unregister the outer root first"),
  );
  await assert.rejects(readdir(join(nested, ".work")), { code: "ENOENT" });

  // Same refusal when only an ancestor .work/workspace.json exists, without
  // any registry entry for it.
  const initializedOnly = await temporaryDirectory("work-nesting-marker-");
  await initializeWorkspace(initializedOnly, { force: true });
  const canonicalInitialized = await realpath(initializedOnly);
  await mkdir(join(initializedOnly, "inner"), { recursive: true });
  await assert.rejects(
    execFile(process.execPath, [launcherPath.pathname, "register", join(initializedOnly, "inner")], { cwd: repositoryRoot, env: environment }),
    (error) =>
      error.stderr.includes(`${canonicalInitialized} is already a Work root.`)
      && error.stderr.includes('work new "inner"'),
  );

  // Outer direction: a new root cannot swallow already-registered roots.
  const grandparent = await realpath(join(parent, ".."));
  await assert.rejects(
    execFile(process.execPath, [launcherPath.pathname, "register", grandparent], { cwd: repositoryRoot, env: environment }),
    (error) =>
      error.stderr.includes(`would contain the already-registered Work root: ${canonicalParent}`)
      && error.stderr.includes("work roots forget"),
  );

  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).roots.map((entry) => entry.root), [canonicalParent]);
});

test("serve does not silently restore an unregistered workspace around the launch directory", async () => {
  const parent = await temporaryDirectory("work-unregistered-parent-");
  const selected = join(parent, "data", "build", "project");
  const registryPath = join(parent, "roots.json");
  await mkdir(selected, { recursive: true });
  const canonicalSelected = await realpath(selected);
  // Register the nested selection first, then initialize the parent in-process
  // so the parent workspace exists without any registry entry.
  await execFile(process.execPath, [launcherPath.pathname, "register", selected], {
    cwd: repositoryRoot,
    env: { ...process.env, WORK_REGISTRY_FILE: registryPath },
  });
  await initializeWorkspace(parent, { force: true });

  const launched = await launchApiFromCli(null, { cwd: parent, registryPath });
  try {
    const snapshot = await apiRequest(launched.origin, "/api/workspace");
    assert.equal(snapshot.payload.workspace.root, canonicalSelected);
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).roots.map((entry) => entry.root), [canonicalSelected]);
  } finally {
    await stopChild(launched.child);
  }
});

test("reports the actual UI URL when the requested port is occupied", async () => {
  const root = await temporaryDirectory("work-dynamic-ui-port-");
  const blocker = createServer((_request, response) => response.end("occupied"));
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address === "object");
  const requestedPort = address.port;
  await execFile(process.execPath, [launcherPath.pathname, "register", root], {
    cwd: repositoryRoot,
    env: { ...process.env, WORK_REGISTRY_FILE: join(root, ".work-test-roots.json") },
  });
  const child = spawn(
    process.execPath,
    [launcherPath.pathname, "serve", root, "--no-open", "--api-port", "0", "--ui-port", String(requestedPort)],
    {
      cwd: repositoryRoot,
      env: { ...process.env, WORK_REGISTRY_FILE: join(root, ".work-test-roots.json") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    const actualUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Work did not report a ready UI URL. Output: ${output}`)), 10_000);
      const inspect = () => {
        const match = output.match(/\[work\] UI ready at (http:\/\/127\.0\.0\.1:\d+\/?)/);
        if (!match) return;
        clearTimeout(timeout);
        resolve(match[1]);
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Work exited before the UI was ready (${code}). Output: ${output}`));
      });
    });
    assert.notEqual(new URL(actualUrl).port, String(requestedPort));
    const proxiedHealth = await fetch(new URL("/api/health", actualUrl));
    assert.equal(proxiedHealth.status, 200, "the dynamically selected UI must proxy to the actual API origin");
  } finally {
    await stopChild(child);
    await new Promise((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  }
});

test("falls back to a free API port unless the caller pins the occupied port", async () => {
  const root = await temporaryDirectory("work-dynamic-api-port-");
  const blocker = createServer((_request, response) => response.end("occupied"));
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address === "object");

  const api = await startLocalApi({ root, port: address.port, fallbackOnPortConflict: true });
  try {
    assert.notEqual(api.port, address.port);
    assert.equal((await apiRequest(api.origin, "/api/health")).response.status, 200);
    await assert.rejects(
      startLocalApi({ root, port: address.port }),
      (error) => error?.code === "EADDRINUSE" && error?.port === address.port,
    );
  } finally {
    await closeLocalApi(api.server);
    await new Promise((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  }
});

test("launches on loopback, discovers only explicit projects, and contains the root", async () => {
  const { root } = await makeWorkspaceFixture();
  const first = await startLocalApi({ root, port: 0 });

  try {
    const origin = new URL(first.origin);
    assert.equal(origin.hostname, "127.0.0.1");

    const health = await apiRequest(first.origin, "/api/health");
    assert.equal(health.response.status, 200);

    const result = await apiRequest(first.origin, "/api/workspace");
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("x-work-workspace"), first.workspace.id);

    const paths = result.payload.projects.map(projectPath).sort();
    assert.deepEqual(paths, ["research/unmask", "software/rekit"]);
    assert.equal(paths.some((path) => path.startsWith("outside-link")), false);

    const described = await apiRequest(first.origin, "/api/projects/profile", {
      method: "PATCH",
      body: {
        projectPath: "software/rekit",
        description: "A durable workspace for coordinating people and agents.",
      },
    });
    assert.equal(described.response.status, 200);
    assert.equal(described.payload.description, "A durable workspace for coordinating people and agents.");
    const projectsAfterDescription = await apiRequest(first.origin, "/api/projects");
    assert.equal(projectsAfterDescription.payload.projects.find((project) => project.path === "software/rekit").description, described.payload.description);
    assert.equal(JSON.parse(await readFile(join(root, "software", "rekit", ".work", "project.json"), "utf8")).description, described.payload.description);

    const renamed = await apiRequest(first.origin, "/api/projects/profile", {
      method: "PATCH",
      body: { projectPath: "software/rekit", name: "ReKit Studio" },
    });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.payload.name, "ReKit Studio");
    assert.equal(renamed.payload.path, "software/rekit");
    assert.equal(renamed.payload.description, described.payload.description);
    assert.equal(JSON.parse(await readFile(join(root, "software", "rekit", ".work", "project.json"), "utf8")).name, "ReKit Studio");

    const traversal = await apiRequest(first.origin, "/api/captures", {
      method: "POST",
      body: { text: "This must stay outside", scopePath: "../outside" },
    });
    assert.equal(traversal.response.status, 403);
    assert.equal(typeof traversal.payload.error.message, "string");

    const symlinkEscape = await apiRequest(first.origin, "/api/captures", {
      method: "POST",
      body: { text: "This must not follow the link", scopePath: "outside-link" },
    });
    assert.ok(
      symlinkEscape.response.status === 400 || symlinkEscape.response.status === 403,
      `expected the symlink scope to be rejected, got ${symlinkEscape.response.status}`,
    );
  } finally {
    await closeLocalApi(first.server);
  }

  const fromDescendant = await startLocalApi({
    root: join(root, "software", "rekit"),
    port: 0,
  });
  try {
    const expected = await realpath(root);
    const actual = await realpath(workspaceRoot(fromDescendant.workspace));
    assert.equal(actual, expected, "a descendant launch should resume its nearest workspace");
    const resumed = await apiRequest(fromDescendant.origin, "/api/workspace");
    assert.equal(resumed.payload.workspace.startScopePath, "software/rekit");
  } finally {
    await closeLocalApi(fromDescendant.server);
  }

  const nestedRoot = join(root, "software", "rekit");
  await initializeWorkspace(nestedRoot, { force: true });
  const forcedNested = await startLocalApi({ root: nestedRoot, port: 0 });
  try {
    const expected = await realpath(nestedRoot);
    const actual = await realpath(workspaceRoot(forcedNested.workspace));
    assert.equal(actual, expected, "--init semantics should create the exact nested root");
    const result = await apiRequest(forcedNested.origin, "/api/workspace");
    assert.deepEqual(result.payload.projects.map(projectPath), ["."]);
  } finally {
    await closeLocalApi(forcedNested.server);
  }

  const parentAfterNested = await startLocalApi({ root, port: 0 });
  try {
    const result = await apiRequest(parentAfterNested.origin, "/api/workspace");
    assert.equal(
      result.payload.projects.some((project) => projectPath(project).startsWith("software/rekit")),
      false,
      "a nested workspace is a hard discovery boundary for its parent",
    );
  } finally {
    await closeLocalApi(parentAfterNested.server);
  }
});

test("browses project files without exposing writes, secrets, binaries, or paths outside the scope", async () => {
  const { root, outside } = await makeWorkspaceFixture();
  const project = join(root, "software", "rekit");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "app.ts"), "export const state = 'initial';\n");
  await writeFile(join(project, "obsolete.txt"), "remove me\n");
  await execFile("git", ["init", "-b", "main"], { cwd: project });
  await execFile("git", ["config", "user.name", "Work Tests"], { cwd: project });
  await execFile("git", ["config", "user.email", "work-tests@example.invalid"], { cwd: project });
  await execFile("git", ["add", ".project", "package.json", "src/app.ts", "obsolete.txt"], { cwd: project });
  await execFile("git", ["commit", "-m", "Initial project"], { cwd: project });

  await writeFile(join(project, "src", "app.ts"), "export const state = 'being built';\n");
  await writeFile(join(project, "src", "worker.py"), "print('working')\n");
  await writeFile(join(project, ".env"), "SECRET=do-not-preview\n");
  await writeFile(join(project, "image.bin"), Buffer.from([0, 1, 2, 3]));
  await unlink(join(project, "obsolete.txt"));
  await symlink(outside, join(project, "outside-source"));

  const api = await startLocalApi({ root, port: 0 });
  try {
    const rootListing = await apiRequest(api.origin, "/api/files/directory?scopePath=software%2Frekit&path=.");
    assert.equal(rootListing.response.status, 200);
    assert.equal(rootListing.payload.git.available, true);
    assert.ok(rootListing.payload.entries.some((entry) => entry.name === "src" && entry.kind === "directory" && entry.gitStatus));
    assert.equal(rootListing.payload.entries.some((entry) => entry.name === ".git" || entry.name === ".work" || entry.name === ".project"), false);
    assert.equal(rootListing.payload.entries.find((entry) => entry.name === ".env")?.previewable, false);
    assert.equal(rootListing.payload.entries.find((entry) => entry.name === "image.bin")?.previewable, false);
    assert.equal(rootListing.payload.entries.find((entry) => entry.path === "obsolete.txt")?.gitStatus, "deleted");
    assert.equal(rootListing.payload.entries.find((entry) => entry.path === "obsolete.txt")?.previewable, false);
    assert.equal(rootListing.payload.entries.find((entry) => entry.name === "outside-source")?.kind, "symlink");

    const sourceListing = await apiRequest(api.origin, "/api/files/directory?scopePath=software%2Frekit&path=src");
    assert.equal(sourceListing.payload.entries.find((entry) => entry.name === "app.ts")?.gitStatus, "modified");
    assert.equal(sourceListing.payload.entries.find((entry) => entry.name === "worker.py")?.gitStatus, "untracked");

    const preview = await apiRequest(api.origin, "/api/files/content?scopePath=software%2Frekit&path=src%2Fapp.ts");
    assert.equal(preview.response.status, 200);
    assert.equal(preview.payload.language.id, "typescript");
    assert.equal(preview.payload.gitStatus, "modified");
    assert.equal(preview.payload.readOnly, true);
    assert.match(preview.payload.content, /being built/);

    const sensitive = await apiRequest(api.origin, "/api/files/content?scopePath=software%2Frekit&path=.env");
    assert.equal(sensitive.response.status, 403);
    assert.doesNotMatch(JSON.stringify(sensitive.payload), /do-not-preview/);

    const binary = await apiRequest(api.origin, "/api/files/content?scopePath=software%2Frekit&path=image.bin");
    assert.equal(binary.response.status, 415);

    const symlinkPreview = await apiRequest(api.origin, "/api/files/content?scopePath=software%2Frekit&path=outside-source%2Fprivate-project%2Fsecret.md");
    assert.equal(symlinkPreview.response.status, 403);

    const traversal = await apiRequest(api.origin, "/api/files/content?scopePath=software%2Frekit&path=..%2F..%2Fresearch%2Funmask%2F.project");
    assert.equal(traversal.response.status, 403);

    const writeAttempt = await apiRequest(api.origin, "/api/files/content?scopePath=software%2Frekit&path=src%2Fapp.ts", {
      method: "PATCH",
      body: { content: "changed through the browser" },
    });
    assert.equal(writeAttempt.response.status, 404);
    assert.match(await readFile(join(project, "src", "app.ts"), "utf8"), /being built/);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("starts a project from an eligible file-tree folder without crossing workspace boundaries", async () => {
  const { root } = await makeWorkspaceFixture();
  await mkdir(join(root, "nested-workspace", "candidate"), { recursive: true });
  await mkdir(join(root, "nested-workspace", ".work"), { recursive: true });
  await writeFile(
    join(root, "nested-workspace", ".work", "workspace.json"),
    `${JSON.stringify({ version: 1, id: "nested-workspace" })}\n`,
  );

  const api = await startLocalApi({ root, port: 0 });
  try {
    const before = await apiRequest(api.origin, "/api/files/directory?scopePath=.&path=scratch");
    assert.equal(before.response.status, 200);
    assert.equal(
      before.payload.entries.find((entry) => entry.path === "scratch/package-only")?.canInitializeProject,
      true,
    );

    const created = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { projectPath: "scratch/package-only" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.path, "scratch/package-only");
    assert.equal(created.payload.name, "package-only");
    assert.equal(typeof created.payload.projectId, "string");

    const projectDirectory = join(root, "scratch", "package-only", ".work");
    assert.deepEqual(
      (await readdir(projectDirectory)).sort(),
      ["captures", "decisions", "issues", "notes", "project.json", "tasks"],
    );
    assert.equal(JSON.parse(await readFile(join(projectDirectory, "project.json"), "utf8")).name, "package-only");

    const after = await apiRequest(api.origin, "/api/files/directory?scopePath=.&path=scratch");
    assert.equal(
      after.payload.entries.find((entry) => entry.path === "scratch/package-only")?.canInitializeProject,
      false,
    );

    const duplicate = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { projectPath: "scratch/package-only" },
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.payload.error.code, "project_already_initialized");

    const nested = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { projectPath: "nested-workspace/candidate" },
    });
    assert.equal(nested.response.status, 409);
    assert.equal(nested.payload.error.code, "nested_workspace_boundary");

    const traversal = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { projectPath: "../outside" },
    });
    assert.equal(traversal.response.status, 403);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("creates the project folder, marker, and human name from one request", async () => {
  const { root } = await makeWorkspaceFixture();
  const api = await startLocalApi({ root, port: 0 });
  try {
    const created = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { name: "Field Notes!" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.path, "field-notes");
    assert.equal(created.payload.name, "Field Notes!");
    const marker = JSON.parse(await readFile(join(root, "field-notes", ".work", "project.json"), "utf8"));
    assert.equal(marker.name, "Field Notes!");

    const nested = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { name: "Sub Project", parentPath: "software" },
    });
    assert.equal(nested.response.status, 201);
    assert.equal(nested.payload.path, "software/sub-project");

    const duplicate = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { name: "Field Notes" },
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.payload.error.code, "project_already_initialized");

    const escape = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { name: "Escape", parentPath: "../outside" },
    });
    assert.equal(escape.response.status, 403);

    const unusable = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { name: "!!!" },
    });
    assert.equal(unusable.response.status, 400);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("work new creates a named project and work add refuses to invent a workspace", async () => {
  const orphan = await temporaryDirectory("work-orphan-");
  await assert.rejects(
    execFile(process.execPath, [launcherPath.pathname, "add", "stray thought"], { cwd: orphan }),
    (error) => /Run `work init` first/.test(error.stderr),
  );
  await assert.rejects(
    execFile(process.execPath, [launcherPath.pathname, "task", "stray task"], { cwd: orphan }),
    (error) => /Run `work init` first/.test(error.stderr),
  );
  await assert.rejects(readdir(join(orphan, ".work")), { code: "ENOENT" });

  await execFile(process.execPath, [launcherPath.pathname, "init", orphan], { cwd: repositoryRoot });
  const created = await execFile(process.execPath, [launcherPath.pathname, "new", "Field Notes"], { cwd: orphan });
  assert.match(created.stdout, /Created project field-notes \(Field Notes\)/);
  const marker = JSON.parse(await readFile(join(orphan, "field-notes", ".work", "project.json"), "utf8"));
  assert.equal(marker.name, "Field Notes");

  await mkdir(join(orphan, "writing"), { recursive: true });
  const nested = await execFile(
    process.execPath,
    [launcherPath.pathname, "new", "Sub Project", "--under", "writing"],
    { cwd: orphan },
  );
  assert.match(nested.stdout, /Created project writing\/sub-project/);

  const help = await execFile(process.execPath, [launcherPath.pathname, "--help"], { cwd: repositoryRoot });
  assert.match(help.stdout, /work new "Name" \[--under rel\/path\]/);
});

test("restarts only after explicit local confirmation", async () => {
  const root = await temporaryDirectory("work-restart-");
  let restartCalls = 0;
  let acknowledgeRestart;
  const restarted = new Promise((resolve) => { acknowledgeRestart = resolve; });
  const api = await startLocalApi({
    root,
    port: 0,
    onRestart: () => {
      restartCalls += 1;
      acknowledgeRestart();
    },
  });

  try {
    const health = await apiRequest(api.origin, "/api/health");
    assert.equal(health.payload.service.restartable, true);
    assert.equal(typeof health.payload.service.instanceId, "string");

    const rejected = await apiRequest(api.origin, "/api/service/restart", {
      method: "POST",
      body: { confirm: true },
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(restartCalls, 0);

    const accepted = await apiRequest(api.origin, "/api/service/restart", {
      method: "POST",
      headers: { "x-work-restart": "confirm" },
      body: { confirm: true },
    });
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.payload.restarting, true);
    assert.equal(accepted.payload.serviceInstanceId, health.payload.service.instanceId);
    await restarted;
    assert.equal(restartCalls, 1);

    const duplicate = await apiRequest(api.origin, "/api/service/restart", {
      method: "POST",
      headers: { "x-work-restart": "confirm" },
      body: { confirm: true },
    });
    assert.equal(duplicate.response.status, 409);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("workspace snapshots support explicit conditional refreshes", async () => {
  const root = await temporaryDirectory("work-snapshot-etag-");
  const api = await startLocalApi({ root, port: 0 });

  try {
    const initial = await fetch(new URL("/api/workspace", api.origin));
    assert.equal(initial.status, 200);
    const etag = initial.headers.get("etag");
    assert.match(etag, /^"workspace-v1-[A-Za-z0-9_-]+"$/);
    await initial.arrayBuffer();

    const unchanged = await fetch(new URL("/api/workspace", api.origin), {
      headers: { "if-none-match": etag },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get("etag"), etag);
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("checks, installs, and restarts for a confirmed npm update", async () => {
  const root = await temporaryDirectory("work-update-");
  let checkCalls = 0;
  const installed = [];
  let restartCalls = 0;
  let acknowledgeRestart;
  const restarted = new Promise((resolve) => { acknowledgeRestart = resolve; });
  const api = await startLocalApi({
    root,
    port: 0,
    version: "0.2.3",
    checkForUpdate: async () => {
      checkCalls += 1;
      return {
        currentVersion: "0.2.3",
        latestVersion: "0.2.4",
        updateAvailable: true,
        installable: true,
        checkedAt: new Date().toISOString(),
      };
    },
    onUpdate: async (version) => { installed.push(version); },
    onRestart: () => {
      restartCalls += 1;
      acknowledgeRestart();
    },
  });

  try {
    const available = await apiRequest(api.origin, "/api/service/update");
    assert.equal(available.response.status, 200);
    assert.equal(available.payload.latestVersion, "0.2.4");
    assert.equal(available.payload.updateAvailable, true);
    await apiRequest(api.origin, "/api/service/update");
    assert.equal(checkCalls, 1, "normal checks use the short server cache");
    await apiRequest(api.origin, "/api/service/update?force=1");
    assert.equal(checkCalls, 2, "manual checks bypass the cache");

    const rejected = await apiRequest(api.origin, "/api/service/update", {
      method: "POST",
      body: { confirm: true },
    });
    assert.equal(rejected.response.status, 403);
    assert.deepEqual(installed, []);

    const accepted = await apiRequest(api.origin, "/api/service/update", {
      method: "POST",
      headers: { "x-work-update": "confirm" },
      body: { confirm: true },
    });
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.payload.installedVersion, "0.2.4");
    assert.deepEqual(installed, ["0.2.4"]);
    await restarted;
    assert.equal(restartCalls, 1);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("treats an empty project .work directory as the canonical marker", async () => {
  const root = await temporaryDirectory("work-dot-work-marker-");
  await mkdir(join(root, "projects", "portable", ".work"), { recursive: true });
  await mkdir(join(root, "projects", "unmarked"), { recursive: true });

  const api = await startLocalApi({ root, port: 0 });
  try {
    const result = await apiRequest(api.origin, "/api/workspace");
    assert.deepEqual(result.payload.projects.map(projectPath), ["projects/portable"]);

    const marker = JSON.parse(
      await readFile(join(root, "projects", "portable", ".work", "project.json"), "utf8"),
    );
    assert.equal(marker.version, 1);
    assert.equal(marker.name, "portable");
    assert.equal(typeof marker.id, "string");
  } finally {
    await closeLocalApi(api.server);
  }
});

test("treats linked Git worktrees as aliases of one canonical project store", async () => {
  const root = await temporaryDirectory("work-git-worktrees-");
  const primary = join(root, "rekit-factory");
  const linked = join(root, "rekit-factory-feature");
  await mkdir(join(primary, ".work"), { recursive: true });

  const setup = await startLocalApi({ root, port: 0 });
  try {
    const created = await apiRequest(setup.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Canonical worktree task", projectPath: "rekit-factory" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.id, "W-0001");
  } finally {
    await closeLocalApi(setup.server);
  }

  await execFile("git", ["init", "-b", "main"], { cwd: primary });
  await execFile("git", ["config", "user.name", "Work Tests"], { cwd: primary });
  await execFile("git", ["config", "user.email", "work-tests@example.invalid"], { cwd: primary });
  await execFile("git", ["add", ".work"], { cwd: primary });
  await execFile("git", ["commit", "-m", "Track project work"], { cwd: primary });
  await execFile("git", ["worktree", "add", "-b", "feature", linked], { cwd: primary });
  await writeFile(join(linked, "feature-only.ts"), "export const worktree = true;\n");
  await writeFile(join(root, ".work", "captures", "capture_alias1234.md"), `---
id: "capture_alias1234"
type: "capture"
kind: "idea"
scopePath: "rekit-factory-feature"
projectPath: "rekit-factory-feature"
createdAt: "2026-01-01T00:00:00.000Z"
updatedAt: "2026-01-01T00:00:00.000Z"
---

Migrate this older alias assignment safely.
`);

  const linkedContextResult = await execFile(
    process.execPath,
    [launcherPath.pathname, "agent", "context", "--json"],
    { cwd: linked },
  );
  const linkedContext = JSON.parse(linkedContextResult.stdout);
  assert.equal(linkedContext.scopePath, "rekit-factory-feature");
  assert.equal(linkedContext.project.path, "rekit-factory");
  assert.equal(linkedContext.project.matchedPath, "rekit-factory-feature");
  assert.equal(linkedContext.defaultProjectPath, "rekit-factory");

  const api = await startLocalApi({ root, port: 0 });
  try {
    const snapshot = await apiRequest(api.origin, "/api/workspace");
    assert.equal(snapshot.response.status, 200);
    assert.deepEqual(snapshot.payload.projects.map(projectPath), ["rekit-factory"]);
    assert.deepEqual(snapshot.payload.projects[0].aliasPaths, ["rekit-factory-feature"]);
    assert.equal(snapshot.payload.tasks.length, 1, "a tracked task copied into a linked worktree is indexed once");
    assert.equal(snapshot.payload.captures.find((capture) => capture.id === "capture_alias1234")?.projectPath, "rekit-factory");
    assert.equal((await readdir(join(primary, ".work", "captures"))).includes("capture_alias1234.md"), true);
    assert.equal((await readdir(join(root, ".work", "captures"))).includes("capture_alias1234.md"), false);

    const primaryFiles = await apiRequest(api.origin, "/api/files/directory?scopePath=rekit-factory&path=.");
    const linkedFiles = await apiRequest(api.origin, "/api/files/directory?scopePath=rekit-factory-feature&path=.");
    assert.equal(primaryFiles.payload.entries.some((entry) => entry.name === "feature-only.ts"), false);
    assert.equal(linkedFiles.payload.scopePath, "rekit-factory-feature");
    assert.equal(linkedFiles.payload.entries.find((entry) => entry.name === "feature-only.ts")?.gitStatus, "untracked");

    const logged = await apiRequest(api.origin, "/api/tasks/W-0001/log", {
      method: "POST",
      body: { message: "Updated through the canonical project store" },
    });
    assert.equal(logged.response.status, 200);
    assert.match(await readFile(join(primary, ".work", "tasks", "W-0001.md"), "utf8"), /Updated through the canonical project store/);
    assert.doesNotMatch(await readFile(join(linked, ".work", "tasks", "W-0001.md"), "utf8"), /Updated through the canonical project store/);

    const createdFromAlias = await apiRequest(api.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Created from a linked path", projectPath: "rekit-factory-feature" },
    });
    assert.equal(createdFromAlias.response.status, 201);
    assert.equal(createdFromAlias.payload.projectPath, "rekit-factory");
    assert.equal((await readdir(join(primary, ".work", "tasks"))).includes("W-0002.md"), true);
    assert.equal((await readdir(join(linked, ".work", "tasks"))).includes("W-0002.md"), false);

    const captureFromAlias = await apiRequest(api.origin, "/api/captures", {
      method: "POST",
      body: { text: "Captured while working on the feature branch", scopePath: "rekit-factory-feature" },
    });
    assert.equal(captureFromAlias.response.status, 201);
    assert.equal(captureFromAlias.payload.scopePath, "rekit-factory");

    const noteFromAlias = await apiRequest(api.origin, "/api/notes", {
      method: "POST",
      body: { title: "Feature branch thought", text: "Keep one canonical note", projectPath: "rekit-factory-feature" },
    });
    assert.equal(noteFromAlias.response.status, 201);
    assert.equal(noteFromAlias.payload.projectPath, "rekit-factory");
    assert.equal((await readdir(join(primary, ".work", "notes"))).includes(`${noteFromAlias.payload.id}.md`), true);
    await assert.rejects(readdir(join(linked, ".work", "notes")), { code: "ENOENT" });
  } finally {
    await closeLocalApi(api.server);
  }

  const launchedFromLinked = await startLocalApi({ root: linked, port: 0 });
  try {
    const snapshot = await apiRequest(launchedFromLinked.origin, "/api/workspace");
    assert.equal(snapshot.payload.workspace.startScopePath, "rekit-factory");
    assert.equal(snapshot.payload.tasks.length, 2);
  } finally {
    await closeLocalApi(launchedFromLinked.server);
  }
});

test("groups linked worktrees when the primary checkout is outside the selected root", async () => {
  const container = await temporaryDirectory("work-external-primary-");
  const primary = join(container, "primary-checkout");
  const root = join(container, "selected-root");
  const first = join(root, "rekit-factory");
  const second = join(root, "rekit-factory-mission-control");
  await mkdir(join(primary, ".work"), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(primary, ".work", "project.json"), `${JSON.stringify({
    version: 1,
    id: "project-rekit-factory",
    name: "rekit-factory",
  }, null, 2)}\n`);
  await execFile("git", ["init", "-b", "main"], { cwd: primary });
  await execFile("git", ["config", "user.name", "Work Tests"], { cwd: primary });
  await execFile("git", ["config", "user.email", "work-tests@example.invalid"], { cwd: primary });
  await execFile("git", ["add", ".work"], { cwd: primary });
  await execFile("git", ["commit", "-m", "Track logical project marker"], { cwd: primary });
  await execFile("git", ["worktree", "add", "-b", "feature-one", first], { cwd: primary });
  await execFile("git", ["worktree", "add", "-b", "feature-two", second], { cwd: primary });

  const projects = await discoverProjects(root);
  assert.deepEqual(projects.map(projectPath), ["rekit-factory"]);
  assert.deepEqual(projects[0].aliasPaths, ["rekit-factory-mission-control"]);
});

test("discovers deeply nested projects without an arbitrary depth cutoff", async () => {
  const root = await temporaryDirectory("work-deep-projects-");
  const nested = join(root, "portfolios", "games", "preservation", "recomp", "engine");
  await mkdir(join(nested, ".project"), { recursive: true });

  const projects = await discoverProjects(root);
  assert.deepEqual(projects.map(projectPath), ["portfolios/games/preservation/recomp/engine"]);
});

test("bounds pathological project discovery with an actionable directory limit", async () => {
  const root = await temporaryDirectory("work-project-limit-");
  await mkdir(join(root, "one", "two", "three", "four"), { recursive: true });

  await assert.rejects(
    discoverProjects(root, { maxDirectories: 3 }),
    (error) => error.code === "project_discovery_limit"
      && /3-directory safety limit/i.test(error.message)
      && /nested \.work\/workspace\.json boundary/i.test(error.message),
  );
});

test("offers registered roots and resolves every request inside the selected workspace", async () => {
  const firstRoot = await temporaryDirectory("work-picker-home-");
  const secondRoot = await temporaryDirectory("work-picker-lab-");
  const launched = await startLocalApi({ root: firstRoot, roots: [firstRoot, secondRoot], port: 0 });

  try {
    const directory = await apiRequest(launched.origin, "/api/workspaces");
    assert.equal(directory.response.status, 200);
    assert.equal(directory.payload.workspaces.length, 2);
    assert.equal(directory.payload.defaultWorkspaceId, launched.workspace.id);
    assert.equal(directory.payload.activeWorkspaceId, launched.workspace.id, "legacy activeWorkspaceId remains the default fallback");

    const canonicalSecondRoot = await realpath(secondRoot);
    const second = directory.payload.workspaces.find((workspace) => workspace.root === canonicalSecondRoot);
    assert.ok(second);
    const selectedHeaders = { "x-work-workspace": second.id };
    const snapshot = await apiRequest(launched.origin, "/api/workspace", { headers: selectedHeaders });
    assert.equal(snapshot.payload.workspace.root, canonicalSecondRoot);
    assert.equal(snapshot.response.headers.get("x-work-workspace"), second.id);

    const created = await apiRequest(launched.origin, "/api/captures", {
      method: "POST",
      headers: selectedHeaders,
      body: { text: "Keep this thought in the lab", scopePath: "." },
    });
    assert.equal(created.response.status, 201);
    const firstSnapshot = await apiRequest(launched.origin, "/api/workspace");
    assert.equal(firstSnapshot.payload.captures.length, 0);
    assert.equal((await apiRequest(launched.origin, "/api/workspace", { headers: selectedHeaders })).payload.captures.length, 1);

    const rejected = await apiRequest(launched.origin, "/api/workspace", {
      headers: { "x-work-workspace": "not-registered" },
    });
    assert.equal(rejected.response.status, 404);
  } finally {
    await closeLocalApi(launched.server);
  }
});

test("opens a native folder picker and initializes the selected directory as an exact root", async () => {
  const root = await temporaryDirectory("work-picker-current-");
  // Roots never nest, so the picker fixture selects a sibling directory.
  const selected = await temporaryDirectory("work-picker-selected-");
  const registryPath = join(root, "test-roots.json");
  await registerWorkspace(root, { force: true, registryPath });
  let pickerCalls = 0;
  const api = await startLocalApi({
    root,
    port: 0,
    registryPath,
    pickWorkspaceDirectory: async () => {
      pickerCalls += 1;
      return pickerCalls === 1 ? null : selected;
    },
  });

  try {
    const missingConfirmation = await apiRequest(api.origin, "/api/workspaces/pick", {
      method: "POST",
      body: { confirm: true },
    });
    assert.equal(missingConfirmation.response.status, 403);
    assert.equal(pickerCalls, 0);

    const cancelled = await apiRequest(api.origin, "/api/workspaces/pick", {
      method: "POST",
      headers: { "x-work-folder-picker": "confirm" },
      body: { confirm: true },
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.payload.cancelled, true);

    const opened = await apiRequest(api.origin, "/api/workspaces/pick", {
      method: "POST",
      headers: { "x-work-folder-picker": "confirm" },
      body: { confirm: true },
    });
    assert.equal(opened.response.status, 201);
    assert.equal(opened.payload.cancelled, false);
    assert.equal(opened.payload.workspace.root, await realpath(selected));
    assert.equal(opened.payload.workspaces.length, 2);

    const marker = JSON.parse(await readFile(join(selected, ".work", "workspace.json"), "utf8"));
    assert.equal(marker.id, opened.payload.workspace.id);
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    assert.equal(registry.roots.some((entry) => entry.id === marker.id && entry.root === opened.payload.workspace.root), true);

    const switched = await apiRequest(api.origin, "/api/workspace", {
      headers: { "x-work-workspace": marker.id },
    });
    assert.equal(switched.response.status, 200);
    assert.equal(switched.payload.workspace.root, await realpath(selected));

    const currentRemoval = await apiRequest(api.origin, `/api/workspaces/${marker.id}`, {
      method: "DELETE",
      headers: {
        "x-work-workspace": marker.id,
        "x-work-unregister": "confirm",
      },
    });
    assert.equal(currentRemoval.response.status, 409);
    assert.equal(currentRemoval.payload.error.code, "cannot_remove_current_workspace");

    const removedOriginal = await apiRequest(api.origin, `/api/workspaces/${api.workspace.id}`, {
      method: "DELETE",
      headers: {
        "x-work-workspace": marker.id,
        "x-work-unregister": "confirm",
      },
    });
    assert.equal(removedOriginal.response.status, 200);
    assert.equal(removedOriginal.payload.removedWorkspaceId, api.workspace.id);
    assert.equal(removedOriginal.payload.activeWorkspaceId, marker.id);
    assert.deepEqual(removedOriginal.payload.workspaces.map((workspace) => workspace.id), [marker.id]);
    assert.equal(JSON.parse(await readFile(join(root, ".work", "workspace.json"), "utf8")).id, api.workspace.id, "unregistering must not delete workspace data");
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")).roots.map((entry) => entry.id), [marker.id]);

    const fallback = await apiRequest(api.origin, "/api/workspace");
    assert.equal(fallback.response.status, 200);
    assert.equal(fallback.payload.workspace.id, marker.id);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("uses the operating system folder chooser and treats cancellation as a no-op", async () => {
  let invocation;
  const selected = await chooseWorkspaceDirectory({
    platform: "darwin",
    run: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: "/Users/example/Projects\n" };
    },
  });
  assert.equal(selected, "/Users/example/Projects");
  assert.equal(invocation.command, "osascript");
  assert.match(invocation.args.join(" "), /choose folder/i);

  const cancelled = await chooseWorkspaceDirectory({
    platform: "darwin",
    run: async () => {
      const error = new Error("Command failed");
      error.code = 1;
      error.stderr = "execution error: User canceled. (-128)";
      throw error;
    },
  });
  assert.equal(cancelled, null);

  await assert.rejects(
    chooseWorkspaceDirectory({
      platform: "linux",
      run: async () => {
        const error = new Error("spawn zenity ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    }),
    (error) => error.code === "folder_picker_unavailable" && error.status === 501,
  );
});

test("writes exact Markdown captures and restores them after a restart", async () => {
  const { root } = await makeWorkspaceFixture();
  const exactThought = [
    "Questions for the next strategy session:",
    "- Should the IDA lab stay unassigned?",
    "- What needs to happen before ReKit Factory owns it?",
  ].join("\n");
  const first = await startLocalApi({ root, port: 0 });
  let capture;

  try {
    const created = await apiRequest(first.origin, "/api/captures", {
      method: "POST",
      body: { text: exactThought, scopePath: "." },
    });
    assert.equal(created.response.status, 201);
    capture = created.payload;
    assert.equal(capture.text, exactThought);
    assert.equal(capture.scopePath, ".");
    assert.equal(capture.projectPath, null);

    const captureFiles = await readdir(join(root, ".work", "captures"));
    assert.equal(captureFiles.length, 1);
    const markdown = await readFile(
      join(root, ".work", "captures", captureFiles[0]),
      "utf8",
    );
    assert.match(markdown, /---/);
    assert.ok(markdown.includes(exactThought), "the Markdown body preserves exact wording");
  } finally {
    await closeLocalApi(first.server);
  }

  const restarted = await startLocalApi({ root, port: 0 });
  try {
    const restored = await apiRequest(restarted.origin, "/api/workspace");
    assert.equal(restored.response.status, 200);
    assert.equal(restored.payload.captures.length, 1);
    assert.equal(restored.payload.captures[0].text, exactThought);

    const moved = await apiRequest(
      restarted.origin,
      `/api/captures/${encodeURIComponent(capture.id)}`,
      { method: "PATCH", body: { projectPath: "software/rekit" } },
    );
    assert.equal(moved.response.status, 200);
    assert.equal(moved.payload.projectPath, "software/rekit");
    assert.equal(moved.payload.scopePath, "software/rekit");
    assert.equal(moved.payload.text, exactThought);

    const movedMarkdown = await readFile(join(root, "software", "rekit", ".work", "captures", `${capture.id}.md`), "utf8");
    assert.match(movedMarkdown, /projectPath: "software\/rekit"/);
    assert.ok(movedMarkdown.includes(exactThought), "moving a capture preserves its exact wording");

    const returnedToRoot = await apiRequest(
      restarted.origin,
      `/api/captures/${encodeURIComponent(capture.id)}`,
      { method: "PATCH", body: { projectPath: null, scopePath: "." } },
    );
    assert.equal(returnedToRoot.response.status, 200);
    assert.equal(returnedToRoot.payload.projectPath, null);
    assert.equal(returnedToRoot.payload.scopePath, ".");

    const removed = await apiRequest(
      restarted.origin,
      `/api/captures/${encodeURIComponent(capture.id)}`,
      { method: "DELETE" },
    );
    assert.equal(removed.response.status, 204);
    assert.deepEqual(await readdir(join(root, ".work", "captures")), []);
  } finally {
    await closeLocalApi(restarted.server);
  }

  const otherRoot = await temporaryDirectory("work-other-root-");
  const isolated = await startLocalApi({ root: otherRoot, port: 0 });
  try {
    const result = await apiRequest(isolated.origin, "/api/workspace");
    assert.equal(result.payload.captures.length, 0);
    assert.equal(result.payload.projects.length, 0);
  } finally {
    await closeLocalApi(isolated.server);
  }
});

test("keeps editable plain-text notes alongside their project", async () => {
  const { root } = await makeWorkspaceFixture();
  const first = await startLocalApi({ root, port: 0 });
  let noteId;

  try {
    const created = await apiRequest(first.origin, "/api/notes", {
      method: "POST",
      body: {
        title: "Strategy fragments",
        text: "Questions to revisit:\nKeep this as ordinary text.",
        scopePath: "software/rekit",
        projectPath: "software/rekit",
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.title, "Strategy fragments");
    assert.equal(created.payload.projectPath, "software/rekit");
    assert.equal("agentIntent" in created.payload, false);
    assert.deepEqual(created.payload.createdBy, { kind: "human", name: null });
    noteId = created.payload.id;

    const pathname = join(root, "software", "rekit", ".work", "notes", `${noteId}.md`);
    const stored = await readFile(pathname, "utf8");
    assert.match(stored, /type: "note"/);
    assert.match(stored, /title: "Strategy fragments"/);
    assert.doesNotMatch(stored, /agentIntent/);
    assert.match(stored, /createdBy: \{"kind":"human","name":null\}/);
    assert.ok(stored.includes("Questions to revisit:\nKeep this as ordinary text."));
    assert.deepEqual(await readdir(join(root, ".work", "notes")), []);

    // Legacy record migration: a note written before the schema change (with
    // the removed agentIntent field and no createdBy) must still load and
    // list, and the rewrite-on-read hook drops the removed field.
    const legacyNoteId = "note_legacy1234";
    const legacyNotePath = join(root, "software", "rekit", ".work", "notes", `${legacyNoteId}.md`);
    await writeFile(legacyNotePath, `---
id: "${legacyNoteId}"
type: "note"
title: "Older note"
scopePath: "software/rekit"
projectPath: "software/rekit"
agentIntent: "review_requested"
createdAt: "2026-01-01T00:00:00.000Z"
updatedAt: "2026-01-01T00:00:00.000Z"
---

Existing notes must remain passive by default.
`);
    const listed = await apiRequest(first.origin, "/api/notes");
    const legacyNote = listed.payload.notes.find((note) => note.id === legacyNoteId);
    assert.equal(legacyNote?.title, "Older note");
    assert.equal("agentIntent" in legacyNote, false);
    assert.deepEqual(legacyNote?.createdBy, { kind: "human", name: null });
    const rewritten = await readFile(legacyNotePath, "utf8");
    assert.doesNotMatch(rewritten, /agentIntent/);
    assert.match(rewritten, /createdBy: \{"kind":"human","name":null\}/);
    const removedLegacy = await apiRequest(first.origin, `/api/notes/${legacyNoteId}`, { method: "DELETE" });
    assert.equal(removedLegacy.response.status, 204);

    const updated = await apiRequest(first.origin, `/api/notes/${encodeURIComponent(noteId)}`, {
      method: "PATCH",
      body: {
        title: "Strategy notes",
        text: "A revised thought.\n\nA second paragraph.",
      },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.title, "Strategy notes");
    assert.equal(updated.payload.text, "A revised thought.\n\nA second paragraph.");

    const traversal = await apiRequest(first.origin, "/api/notes", {
      method: "POST",
      body: { title: "Unsafe", text: "No", scopePath: "../outside" },
    });
    assert.equal(traversal.response.status, 403);
  } finally {
    await closeLocalApi(first.server);
  }

  const restarted = await startLocalApi({ root, port: 0 });
  try {
    const snapshot = await apiRequest(restarted.origin, "/api/workspace");
    const note = snapshot.payload.notes.find((item) => item.id === noteId);
    assert.equal(note.title, "Strategy notes");
    assert.equal(note.text, "A revised thought.\n\nA second paragraph.");
    assert.equal(note.projectPath, "software/rekit");
    assert.deepEqual(note.createdBy, { kind: "human", name: null });

    const removed = await apiRequest(restarted.origin, `/api/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
    assert.equal(removed.response.status, 204);
    assert.deepEqual(await readdir(join(root, "software", "rekit", ".work", "notes")), []);
  } finally {
    await closeLocalApi(restarted.server);
  }
});

test("attributes agent-created notes and contains agent mutations to their own notes", async () => {
  const { root } = await makeWorkspaceFixture();
  const api = await startLocalApi({ root, port: 0 });

  try {
    const human = await apiRequest(api.origin, "/api/notes", {
      method: "POST",
      body: { title: "Human plan", text: "Do not rewrite this.", projectPath: "software/rekit" },
    });
    assert.equal(human.response.status, 201);

    const missingIdentity = await apiRequest(api.origin, "/api/agent/notes", {
      method: "POST",
      body: { title: "Unattributed", text: "This must fail.", projectPath: "software/rekit" },
    });
    assert.equal(missingIdentity.response.status, 400);
    assert.equal(missingIdentity.payload.error.code, "agent_identity_required");

    const created = await apiRequest(api.origin, "/api/agent/notes", {
      method: "POST",
      headers: { "x-work-agent": "codex-cli" },
      body: { title: "Investigation result", text: "The parser accepts the new envelope.", projectPath: "software/rekit" },
    });
    assert.equal(created.response.status, 201);
    assert.deepEqual(created.payload.createdBy, { kind: "agent", name: "codex-cli" });

    const agentEditsHuman = await apiRequest(api.origin, `/api/agent/notes/${human.payload.id}`, {
      method: "PATCH",
      headers: { "x-work-agent": "codex-cli" },
      body: { text: "Agent overwrite" },
    });
    assert.equal(agentEditsHuman.response.status, 403);
    assert.equal(agentEditsHuman.payload.error.code, "agent_note_forbidden");

    const otherAgentEdits = await apiRequest(api.origin, `/api/agent/notes/${created.payload.id}`, {
      method: "PATCH",
      headers: { "x-work-agent": "claude-cli" },
      body: { text: "Other agent overwrite" },
    });
    assert.equal(otherAgentEdits.response.status, 403);

    const ownerEdits = await apiRequest(api.origin, `/api/agent/notes/${created.payload.id}`, {
      method: "PATCH",
      headers: { "x-work-agent": "codex-cli" },
      body: { text: "The parser and restart checks accept the new envelope." },
    });
    assert.equal(ownerEdits.response.status, 200);
    assert.equal(ownerEdits.payload.text, "The parser and restart checks accept the new envelope.");
    assert.deepEqual(ownerEdits.payload.createdBy, { kind: "agent", name: "codex-cli" });

    const humanEditsAgent = await apiRequest(api.origin, `/api/notes/${created.payload.id}`, {
      method: "PATCH",
      body: { title: "Reviewed investigation result" },
    });
    assert.equal(humanEditsAgent.response.status, 200);
    assert.deepEqual(humanEditsAgent.payload.createdBy, { kind: "agent", name: "codex-cli" });

    const otherAgentDeletes = await apiRequest(api.origin, `/api/agent/notes/${created.payload.id}`, {
      method: "DELETE",
      headers: { "x-work-agent": "claude-cli" },
    });
    assert.equal(otherAgentDeletes.response.status, 403);

    const ownerDeletes = await apiRequest(api.origin, `/api/agent/notes/${created.payload.id}`, {
      method: "DELETE",
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(ownerDeletes.response.status, 204);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("loads legacy idea records as notes and rewrites them into the notes store", async () => {
  const { root } = await makeWorkspaceFixture();
  const api = await startLocalApi({ root, port: 0 });
  try {
    // A record written before ideas merged into notes.
    await mkdir(join(root, "software", "rekit", ".work", "ideas"), { recursive: true });
    await writeFile(join(root, "software", "rekit", ".work", "ideas", "idea_legacy1234.md"), `---
id: "idea_legacy1234"
type: "idea"
title: "Federate remote Work instances"
status: "exploring"
scopePath: "software/rekit"
projectPath: "software/rekit"
tags: ["remote","architecture"]
source: "capture_example1234"
revisitAt: "2027-01-15T00:00:00.000Z"
history: [{"from":"open","to":"exploring","reason":"Started evaluating.","at":"2026-01-02T00:00:00.000Z"}]
createdAt: "2026-01-01T00:00:00.000Z"
updatedAt: "2026-01-02T00:00:00.000Z"
---

## Opportunity
See project trees from several servers in one place.
`);

    const listed = await apiRequest(api.origin, "/api/notes");
    assert.equal(listed.response.status, 200);
    const migrated = listed.payload.notes.find((note) => note.id === "note_legacy1234");
    assert.equal(migrated?.title, "Federate remote Work instances");
    assert.equal(migrated?.projectPath, "software/rekit");
    assert.equal(migrated?.createdBy.kind, "human");
    // The body keeps the idea sections; idea-only frontmatter survives as
    // plain text lines so nothing is lost.
    assert.match(migrated.text, /## Opportunity\nSee project trees from several servers in one place\./);
    assert.match(migrated.text, /Status: exploring/);
    assert.match(migrated.text, /Tags: remote, architecture/);
    assert.match(migrated.text, /Source: capture_example1234/);
    assert.match(migrated.text, /Revisit at: 2027-01-15T00:00:00\.000Z/);
    assert.match(migrated.text, /History: open → exploring — Started evaluating\. \(2026-01-02T00:00:00\.000Z\)/);

    // The file moved out of the ideas store and into the notes store.
    assert.deepEqual(await readdir(join(root, "software", "rekit", ".work", "ideas")), []);
    const rewritten = await readFile(join(root, "software", "rekit", ".work", "notes", "note_legacy1234.md"), "utf8");
    assert.match(rewritten, /type: "note"/);
    assert.match(rewritten, /Status: exploring/);
    assert.doesNotMatch(rewritten, /type: "idea"/);

    // The migrated record behaves like any other note.
    const updated = await apiRequest(api.origin, "/api/notes/note_legacy1234", {
      method: "PATCH",
      body: { title: "Federated Work instances (merged)" },
    });
    assert.equal(updated.response.status, 200);

    // The migrated note appears in the workspace snapshot.
    const snapshot = await apiRequest(api.origin, "/api/workspace");
    assert.equal(snapshot.payload.notes.some((note) => note.id === "note_legacy1234"), true);

    // A task written before the camelCase frontmatter change — and before
    // priority, type, assignee, estimate, and agents were removed — still
    // loads, and the next write rewrites it without any of those keys.
    await writeFile(join(root, ".work", "tasks", "W-0042.md"), `---
id: "W-0042"
title: "Legacy snake task"
status: "in_progress"
project_path: null
task_type: "bug"
assignee: "orchestra/brisk_otter"
agents: ["maestro"]
priority: "high"
estimate: "3 points"
depends_on: []
blocked_by: []
blocked_reason: "waiting on parser"
parent_id: null
due_at: "2027-01-01T00:00:00.000Z"
created_at: "2026-01-01T00:00:00.000Z"
updated_at: "2026-01-02T00:00:00.000Z"
started_at: "2026-01-01T12:00:00.000Z"
---

## Goal
Keep loading old records.
`);
    const legacyTask = await apiRequest(api.origin, "/api/tasks/W-0042");
    assert.equal(legacyTask.response.status, 200);
    assert.equal(legacyTask.payload.sections.description, "", "a legacy record without a Description section loads with an empty description");
    const untouched = await readFile(join(root, ".work", "tasks", "W-0042.md"), "utf8");
    assert.doesNotMatch(untouched, /## Description/, "reading a legacy record does not rewrite it with new sections");
    assert.equal("priority" in legacyTask.payload, false);
    assert.equal("type" in legacyTask.payload, false);
    assert.equal("assignee" in legacyTask.payload, false);
    assert.equal("estimate" in legacyTask.payload, false);
    assert.equal(legacyTask.payload.delegated, false,
      "a legacy agents list is history, not delegation: it must never hand an old record to a runner");
    assert.equal("agents" in legacyTask.payload, false);
    assert.equal(legacyTask.payload.blockedReason, "waiting on parser");
    assert.equal(legacyTask.payload.dueAt, "2027-01-01T00:00:00.000Z");
    assert.equal(legacyTask.payload.startedAt, "2026-01-01T12:00:00.000Z");
    const logged = await apiRequest(api.origin, "/api/tasks/W-0042/log", {
      method: "POST",
      body: { message: "Rewritten in camelCase." },
    });
    assert.equal(logged.response.status, 200);
    const rewrittenTask = await readFile(join(root, ".work", "tasks", "W-0042.md"), "utf8");
    assert.match(rewrittenTask, /delegated: false/);
    assert.match(rewrittenTask, /blockedReason: "waiting on parser"/);
    assert.match(rewrittenTask, /startedAt: "2026-01-01T12:00:00\.000Z"/);
    assert.doesNotMatch(rewrittenTask, /task_type|project_path|blocked_reason|created_at|updated_at|started_at/);
    assert.doesNotMatch(rewrittenTask, /priority|assignee|estimate|agents|type:/);

    // Setting a description on a legacy record writes it as the first section.
    const described = await apiRequest(api.origin, "/api/tasks/W-0042", {
      method: "PATCH",
      body: { description: "Old parser records predate the Description section." },
    });
    assert.equal(described.response.status, 200);
    assert.equal(described.payload.sections.description, "Old parser records predate the Description section.");
    assert.equal(described.payload.sections.goal, "Keep loading old records.", "setting a description leaves the goal untouched");
    const describedTask = await readFile(join(root, ".work", "tasks", "W-0042.md"), "utf8");
    assert.match(describedTask, /## Description\nOld parser records predate the Description section\./);
    assert.ok(describedTask.indexOf("## Description") < describedTask.indexOf("## Goal"), "Description precedes Goal on disk");
  } finally {
    await closeLocalApi(api.server);
  }
});

test("deletes a project's records for a human while non-empty folders keep their files", async () => {
  const { root } = await makeWorkspaceFixture();
  const api = await startLocalApi({ root, port: 0 });
  try {
    const created = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { projectPath: "scratch/package-only" },
    });
    assert.equal(created.response.status, 201);
    const capture = await apiRequest(api.origin, "/api/captures", {
      method: "POST",
      body: { text: "History that leaves with the project", projectPath: "scratch/package-only" },
    });
    assert.equal(capture.response.status, 201);

    // Agents never delete projects.
    const forbidden = await apiRequest(api.origin, "/api/projects?projectPath=scratch%2Fpackage-only", {
      method: "DELETE",
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.payload.error.code, "project_delete_forbidden");

    const unknown = await apiRequest(api.origin, "/api/projects?projectPath=scratch%2Fnot-a-project", { method: "DELETE" });
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.payload.error.code, "unknown_project");

    // Non-empty folder: the .work records disappear, the files stay.
    const kept = await apiRequest(api.origin, "/api/projects", {
      method: "DELETE",
      body: { projectPath: "scratch/package-only" },
    });
    assert.equal(kept.response.status, 200);
    assert.equal(kept.payload.projectPath, "scratch/package-only");
    assert.equal(kept.payload.folderRemoved, false);
    await assert.rejects(readdir(join(root, "scratch", "package-only", ".work")), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(root, "scratch", "package-only")), ["package.json"]);

    // Empty folder: the folder itself disappears with the project.
    const empty = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { name: "Sandals Trip" },
    });
    assert.equal(empty.response.status, 201);
    assert.equal(empty.payload.path, "sandals-trip");
    const removed = await apiRequest(api.origin, "/api/projects?projectPath=sandals-trip", { method: "DELETE" });
    assert.equal(removed.response.status, 200);
    assert.equal(removed.payload.folderRemoved, true);
    await assert.rejects(readdir(join(root, "sandals-trip")), { code: "ENOENT" });

    // The workspace root is never deletable, even when it carries a marker.
    await writeFile(join(root, ".project"), "");
    const rootRefusal = await apiRequest(api.origin, "/api/projects?projectPath=.", { method: "DELETE" });
    assert.equal(rootRefusal.response.status, 409);
    assert.equal(rootRefusal.payload.error.code, "workspace_root_not_project");
    await unlink(join(root, ".project"));
    assert.deepEqual(await readdir(join(root, ".work", "captures")), []);
  } finally {
    await closeLocalApi(api.server);
  }

  // The CLI reports the same outcomes in plain language.
  await execFile(process.execPath, [launcherPath.pathname, "new", "Empty Project", "--root", root], { cwd: repositoryRoot });
  const removedByCli = await execFile(process.execPath, [launcherPath.pathname, "remove", "empty-project", "--root", root], { cwd: repositoryRoot });
  assert.match(removedByCli.stdout, /Removed project empty-project\. The empty folder was deleted\./);
  await assert.rejects(readdir(join(root, "empty-project")), { code: "ENOENT" });
});

test("keeps project work inside the project when its directory moves", async () => {
  const { root } = await makeWorkspaceFixture();
  const originalProject = join(root, "software", "rekit");
  const first = await startLocalApi({ root, port: 0 });
  let captureId;
  let noteId;
  let taskId;
  try {
    const capture = await apiRequest(first.origin, "/api/captures", {
      method: "POST",
      body: { text: "This history must travel with ReKit", scopePath: "software/rekit", projectPath: "software/rekit" },
    });
    assert.equal(capture.response.status, 201);
    captureId = capture.payload.id;

    const note = await apiRequest(first.origin, "/api/notes", {
      method: "POST",
      body: { title: "Portable project note", text: "Move this note with ReKit", scopePath: "software/rekit", projectPath: "software/rekit" },
    });
    assert.equal(note.response.status, 201);
    noteId = note.payload.id;

    const task = await apiRequest(first.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Portable project task", projectPath: "software/rekit", type: "task" },
    });
    assert.equal(task.response.status, 201);
    taskId = task.payload.id;
  } finally {
    await closeLocalApi(first.server);
  }

  assert.equal((await readdir(join(originalProject, ".work", "captures"))).includes(`${captureId}.md`), true);
  assert.equal((await readdir(join(originalProject, ".work", "notes"))).includes(`${noteId}.md`), true);
  assert.equal((await readdir(join(originalProject, ".work", "tasks"))).includes(`${taskId}.md`), true);
  assert.equal((await readdir(join(root, ".work", "captures"))).includes(`${captureId}.md`), false);
  assert.equal((await readdir(join(root, ".work", "notes"))).includes(`${noteId}.md`), false);
  assert.equal((await readdir(join(root, ".work", "tasks"))).includes(`${taskId}.md`), false);

  await unlink(join(originalProject, ".project"));
  const movedParent = join(root, "active");
  const movedProject = join(movedParent, "rekit-moved");
  await mkdir(movedParent, { recursive: true });
  await rename(originalProject, movedProject);

  const restarted = await startLocalApi({ root, port: 0 });
  try {
    const snapshot = await apiRequest(restarted.origin, "/api/workspace");
    assert.equal(snapshot.response.status, 200);
    assert.equal(snapshot.payload.projects.some((project) => project.path === "active/rekit-moved"), true);
    assert.equal(snapshot.payload.captures.find((capture) => capture.id === captureId)?.projectPath, "active/rekit-moved");
    assert.equal(snapshot.payload.notes.find((note) => note.id === noteId)?.projectPath, "active/rekit-moved");
    assert.equal(snapshot.payload.tasks.find((task) => task.id === taskId)?.projectPath, "active/rekit-moved");
  } finally {
    await closeLocalApi(restarted.server);
  }
});

test("links decisions to work items and logs the answer on the task without touching status", async () => {
  const { root } = await makeWorkspaceFixture();
  const server = await startLocalApi({ root, port: 0 });

  try {
    // API round-trip: a decision carries refs to the work it is about.
    const task = await apiRequest(server.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Ship the parser", status: "in_progress" },
    });
    assert.equal(task.response.status, 201);
    const taskId = task.payload.id;

    const created = await apiRequest(server.origin, "/api/decisions", {
      method: "POST",
      body: {
        title: "Which parser strategy?",
        detail: "The grammar has left recursion.",
        options: ["Recursive descent", "PEG"],
        recommendedOption: "PEG",
        refs: [taskId],
      },
    });
    assert.equal(created.response.status, 201);
    assert.deepEqual(created.payload.refs, [taskId]);

    // File round-trip: refs persist in frontmatter and re-read intact.
    const decisionFiles = await readdir(join(root, ".work", "decisions"));
    assert.equal(decisionFiles.length, 1);
    const markdown = await readFile(join(root, ".work", "decisions", decisionFiles[0]), "utf8");
    assert.match(markdown, new RegExp(`refs: \\["${taskId}"\\]`));
    const workspace = await apiRequest(server.origin, "/api/workspace");
    const listed = workspace.payload.decisions.find((decision) => decision.id === created.payload.id);
    assert.deepEqual(listed.refs, [taskId]);

    // Answering appends one log entry naming question and answer, and the
    // refs survive the resolution write.
    const resolved = await apiRequest(
      server.origin,
      `/api/decisions/${encodeURIComponent(created.payload.id)}/actions`,
      { method: "POST", body: { action: "approve", choice: { option: "PEG" } } },
    );
    assert.equal(resolved.response.status, 200);
    assert.deepEqual(resolved.payload.refs, [taskId]);

    const after = await apiRequest(server.origin, `/api/tasks/${encodeURIComponent(taskId)}`);
    const answerEntries = after.payload.log.filter((entry) =>
      entry.message.includes("Which parser strategy?") && entry.message.includes("PEG"));
    assert.equal(answerEntries.length, 1);
    // The human decides whether an answer unblocks the work.
    assert.equal(after.payload.status, "in_progress");

    // A ref to a missing task never blocks the answer.
    const dangling = await apiRequest(server.origin, "/api/decisions", {
      method: "POST",
      body: { title: "Orphaned question", refs: ["W-9999"] },
    });
    const danglingResolved = await apiRequest(
      server.origin,
      `/api/decisions/${encodeURIComponent(dangling.payload.id)}/actions`,
      { method: "POST", body: { action: "approve", note: "Answered anyway." } },
    );
    assert.equal(danglingResolved.response.status, 200);

    // Invalid refs are rejected with the shared shape rules.
    const invalid = await apiRequest(server.origin, "/api/decisions", {
      method: "POST",
      body: { title: "Bad refs", refs: "W-0001" },
    });
    assert.equal(invalid.response.status, 400);
  } finally {
    await closeLocalApi(server.server);
  }

  // CLI round-trip: `work decision --ref` is repeatable and persists.
  const cliRoot = await temporaryDirectory("work-decision-ref-");
  await execFile(process.execPath, [launcherPath.pathname, "init", cliRoot], { cwd: repositoryRoot });
  const createdTask = await execFile(process.execPath, [launcherPath.pathname, "task", "Card under question"], { cwd: cliRoot });
  const cliTaskId = createdTask.stdout.match(/Created (W-\d{4})/)[1];
  await execFile(
    process.execPath,
    [launcherPath.pathname, "decision", "Keep the flag?", "--option", "Yes", "--option", "No", "--ref", cliTaskId, "--ref", "W-0042"],
    { cwd: cliRoot },
  );
  const cliDecisionFiles = await readdir(join(cliRoot, ".work", "decisions"));
  assert.equal(cliDecisionFiles.length, 1);
  const cliMarkdown = await readFile(join(cliRoot, ".work", "decisions", cliDecisionFiles[0]), "utf8");
  assert.match(cliMarkdown, new RegExp(`refs: \\["${cliTaskId}","W-0042"\\]`));
});

test("records explicit decision actions instead of treating an open card as approval", async () => {
  const { root } = await makeWorkspaceFixture();
  const first = await startLocalApi({ root, port: 0 });
  let decisionId;

  try {
    const created = await apiRequest(first.origin, "/api/decisions", {
      method: "POST",
      body: {
        title: "IDA lab ownership",
        detail: "Choose its home only when the ownership boundary is clear.",
        options: ["Assign to a project", "Keep unassigned"],
        recommendedOption: "Keep unassigned",
      },
    });
    assert.equal(created.response.status, 201);
    decisionId = created.payload.id;
    assert.equal(created.payload.recommendedOption, "Keep unassigned");

    const invalidRecommendation = await apiRequest(first.origin, "/api/decisions", {
      method: "POST",
      body: { title: "Invalid recommendation", options: ["A", "B"], recommendedOption: "C" },
    });
    assert.equal(invalidRecommendation.response.status, 400);
    assert.match(invalidRecommendation.payload.error.message, /exactly match/i);

    const unchanged = await apiRequest(first.origin, "/api/workspace");
    const openDecision = unchanged.payload.decisions.find(
      (decision) => decision.id === decisionId,
    );
    assert.equal(openDecision.status, "open");

    const missingOption = await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      { method: "POST", body: { action: "approve" } },
    );
    assert.equal(missingOption.response.status, 400);
    assert.match(missingOption.payload.error.message, /recorded options/i);

    const selected = await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      {
        method: "POST",
        body: { action: "approve", choice: { option: "Keep unassigned" }, note: "No owner is ready yet." },
      },
    );
    assert.equal(selected.response.status, 200);
    assert.deepEqual(selected.payload.resolution.choice, { option: "Keep unassigned" });
    assert.equal(selected.payload.resolution.note, "No owner is ready yet.");

    await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      { method: "POST", body: { action: "reopen" } },
    );

    const otherWithoutAnswer = await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      { method: "POST", body: { action: "approve", choice: { option: "Other" } } },
    );
    assert.equal(otherWithoutAnswer.response.status, 400);
    assert.match(otherWithoutAnswer.payload.error.message, /write your answer/i);

    const other = await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      { method: "POST", body: { action: "approve", choice: { option: "Other" }, note: "Create a dedicated shared project." } },
    );
    assert.equal(other.response.status, 200);
    assert.deepEqual(other.payload.resolution.choice, { option: "Other" });
    assert.equal(other.payload.resolution.note, "Create a dedicated shared project.");

    await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      { method: "POST", body: { action: "reopen" } },
    );

    const invalidAssignment = await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      {
        method: "POST",
        body: { action: "assign", choice: { projectPath: "missing-project" } },
      },
    );
    assert.equal(invalidAssignment.response.status, 400);

    const deferredUntil = new Date(Date.now() + 86_400_000).toISOString();
    const deferred = await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      {
        method: "POST",
        body: { action: "defer", choice: { until: deferredUntil } },
      },
    );
    assert.equal(deferred.response.status, 200);
    assert.equal(deferred.payload.status, "deferred");

    const reopened = await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      { method: "POST", body: { action: "reopen" } },
    );
    assert.equal(reopened.response.status, 200);
    assert.equal(reopened.payload.status, "open");

    const unassigned = await apiRequest(
      first.origin,
      `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
      { method: "POST", body: { action: "keep_unassigned" } },
    );
    assert.equal(unassigned.response.status, 200);
    assert.equal(unassigned.payload.status, "kept_unassigned");
    assert.equal(unassigned.payload.projectPath, null);

    const decisionFiles = await readdir(join(root, ".work", "decisions"));
    assert.equal(decisionFiles.length, 1);
    const markdown = await readFile(
      join(root, ".work", "decisions", decisionFiles[0]),
      "utf8",
    );
    assert.ok(markdown.includes("IDA lab ownership"));
    assert.match(markdown, /keep_unassigned|unassigned/i);
  } finally {
    await closeLocalApi(first.server);
  }

  const restarted = await startLocalApi({ root, port: 0 });
  try {
    const restored = await apiRequest(restarted.origin, "/api/workspace");
    const decision = restored.payload.decisions.find(
      (item) => item.id === decisionId,
    );
    assert.equal(decision.status, "kept_unassigned");
  } finally {
    await closeLocalApi(restarted.server);
  }
});

test("persists a full Kanban lifecycle with fields, checklists, dependencies, and logs", async () => {
  const { root } = await makeWorkspaceFixture();
  const first = await startLocalApi({ root, port: 0 });

  try {
    const foundation = await apiRequest(first.origin, "/api/tasks", {
      method: "POST",
      body: {
        title: "Build the task store",
        projectPath: "software/rekit",
        delegated: true,
        tags: ["kanban", "storage"],
        description: "The board loses cards across restarts because nothing persists them.",
        goal: "Persist complete project state in Markdown.",
        requirements: ["One file per task", "Append-only progress log"],
        acceptanceCriteria: ["Survives restart", "Board reflects status"],
        plan: "Build schema, API, then UI.",
      },
    });
    assert.equal(foundation.response.status, 201);
    assert.equal(foundation.payload.id, "W-0001");
    assert.equal(foundation.payload.status, "backlog");
    assert.equal(foundation.payload.sections.description, "The board loses cards across restarts because nothing persists them.");
    assert.equal(foundation.payload.requirements.length, 2);

    const dependent = await apiRequest(first.origin, "/api/tasks", {
      method: "POST",
      body: {
        title: "Render the Kanban",
        projectPath: "software/rekit",
        status: "in_progress",
        dependsOn: [foundation.payload.id],
        blockedBy: [foundation.payload.id],
        blockedReason: "The board needs the task store first.",
      },
    });
    assert.equal(dependent.response.status, 201);
    assert.equal(dependent.payload.id, "W-0002");

    const blockedCompletion = await apiRequest(first.origin, `/api/tasks/${dependent.payload.id}/move`, {
      method: "POST",
      body: { status: "done" },
    });
    assert.equal(blockedCompletion.response.status, 409);
    assert.match(blockedCompletion.payload.error.message, /unfinished dependencies/i);

    const checked = await apiRequest(first.origin, `/api/tasks/${foundation.payload.id}/checklist`, {
      method: "POST",
      body: { section: "requirements", index: 0, checked: true },
    });
    assert.equal(checked.response.status, 200);
    assert.equal(checked.payload.requirements[0].checked, true);

    const prematureReview = await apiRequest(first.origin, `/api/tasks/${foundation.payload.id}`, {
      method: "PATCH",
      body: { status: "review", notes: "Ready for the dependency gate test." },
    });
    assert.equal(prematureReview.response.status, 409);
    assert.match(prematureReview.payload.error.message, /unchecked checklist/i);

    for (const [section, index] of [["requirements", 1], ["acceptance", 0], ["acceptance", 1]]) {
      const completedCheck = await apiRequest(first.origin, `/api/tasks/${foundation.payload.id}/checklist`, {
        method: "POST",
        body: { section, index, checked: true },
      });
      assert.equal(completedCheck.response.status, 200);
    }

    const updated = await apiRequest(first.origin, `/api/tasks/${foundation.payload.id}`, {
      method: "PATCH",
      body: { status: "review", notes: "Ready for the dependency gate test." },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.status, "review");
    assert.equal(updated.payload.delegated, true);

    const completedFoundation = await apiRequest(first.origin, `/api/tasks/${foundation.payload.id}/move`, {
      method: "POST",
      body: { status: "done", note: "Storage and restart tests pass." },
    });
    assert.equal(completedFoundation.response.status, 200);
    assert.ok(completedFoundation.payload.completedAt);

    const completedDependent = await apiRequest(first.origin, `/api/tasks/${dependent.payload.id}/move`, {
      method: "POST",
      body: { status: "done" },
    });
    assert.equal(completedDependent.response.status, 200);

    const logged = await apiRequest(first.origin, `/api/tasks/${dependent.payload.id}/log`, {
      method: "POST",
      body: { message: "Verified drag movement and the accessible status control." },
    });
    assert.equal(logged.response.status, 200);
    assert.match(logged.payload.sections.progressLog, /Verified drag movement/);

    const taskFile = await readFile(join(root, "software", "rekit", ".work", "tasks", "W-0001.md"), "utf8");
    assert.match(taskFile, /delegated: true/);
    assert.match(taskFile, /## Description\nThe board loses cards across restarts/);
    assert.ok(taskFile.indexOf("## Description") < taskFile.indexOf("## Goal"), "Description is the first task section");
    assert.match(taskFile, /## Requirements/);
    assert.match(taskFile, /- \[x\] One file per task/);
    assert.match(taskFile, /## Acceptance Criteria/);
    assert.match(taskFile, /## Progress Log/);
    assert.match(taskFile, /Moved from review to done/);
  } finally {
    await closeLocalApi(first.server);
  }

  const restarted = await startLocalApi({ root, port: 0 });
  try {
    const snapshot = await apiRequest(restarted.origin, "/api/workspace");
    assert.equal(snapshot.payload.tasks.length, 2);
    assert.equal(snapshot.payload.tasks.every((task) => task.status === "done"), true);
    assert.deepEqual(snapshot.payload.workspace.statuses, ["backlog", "ready", "in_progress", "blocked", "review", "done"]);
  } finally {
    await closeLocalApi(restarted.server);
  }
});

test("keeps terminal task moves human-only and surfaces one needs-you queue", async () => {
  const { root } = await makeWorkspaceFixture();
  const api = await startLocalApi({ root, port: 0 });

  try {
    const created = await apiRequest(api.origin, "/api/tasks", {
      method: "POST",
      body: {
        title: "Ship the sweeper contract",
        projectPath: "software/rekit",
        status: "ready",
        delegated: true,
        refs: ["issue_auth_timeout"],
      },
    });
    assert.equal(created.response.status, 201);
    assert.deepEqual(created.payload.refs, ["issue_auth_timeout"]);
    const taskFile = await readFile(join(root, "software", "rekit", ".work", "tasks", `${created.payload.id}.md`), "utf8");
    assert.match(taskFile, /refs: \["issue_auth_timeout"\]/);

    const agentStarts = await apiRequest(api.origin, `/api/tasks/${created.payload.id}/move`, {
      method: "POST",
      body: { status: "in_progress" },
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    assert.equal(agentStarts.response.status, 200);

    const agentCompletes = await apiRequest(api.origin, `/api/tasks/${created.payload.id}/move`, {
      method: "POST",
      body: { status: "done" },
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    assert.equal(agentCompletes.response.status, 403);
    assert.equal(agentCompletes.payload.error.code, "task_status_forbidden");

    const agentBlocks = await apiRequest(api.origin, `/api/tasks/${created.payload.id}/move`, {
      method: "POST",
      body: { status: "blocked" },
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    assert.equal(agentBlocks.response.status, 200);

    const retagged = await apiRequest(api.origin, `/api/tasks/${created.payload.id}`, {
      method: "PATCH",
      body: { refs: ["issue_auth_timeout", "W-0001"] },
    });
    assert.deepEqual(retagged.payload.refs, ["issue_auth_timeout", "W-0001"]);

    const decision = await apiRequest(api.origin, "/api/decisions", {
      method: "POST",
      body: { title: "Choose the sweeper interval" },
    });
    assert.equal(decision.response.status, 201);
    const issue = await apiRequest(api.origin, "/api/issues", {
      method: "POST",
      body: { body: "The sweeper misses new comments." },
    });
    await apiRequest(api.origin, `/api/agent/issues/${issue.payload.id}/claim`, {
      method: "POST",
      body: {},
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    await apiRequest(api.origin, `/api/agent/issues/${issue.payload.id}/state`, {
      method: "POST",
      body: { state: "needs_human", reason: "Which interval do you want?" },
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });

    const needsYou = await apiRequest(api.origin, "/api/needs-you");
    assert.equal(needsYou.response.status, 200);
    assert.deepEqual(
      needsYou.payload.entries.map((entry) => entry.type).sort(),
      ["decision", "issue", "task"],
    );
    for (const entry of needsYou.payload.entries) {
      assert.ok(entry.id);
      assert.ok(entry.title);
      assert.ok(entry.updatedAt);
      assert.ok("projectPath" in entry);
    }
    const timestamps = needsYou.payload.entries.map((entry) => entry.updatedAt);
    assert.deepEqual(timestamps, [...timestamps].sort().reverse());

    const stale = await apiRequest(api.origin, `/api/tasks?updatedSince=${encodeURIComponent(retagged.payload.updatedAt)}`);
    assert.deepEqual(stale.payload.tasks, []);
    const fresh = await apiRequest(api.origin, "/api/tasks?updatedSince=2000-01-01T00:00:00Z");
    assert.equal(fresh.payload.tasks.length, 1);
    const invalidCursor = await apiRequest(api.origin, "/api/tasks?updatedSince=not-a-date");
    assert.equal(invalidCursor.response.status, 400);

    const agentPatchCompletes = await apiRequest(api.origin, `/api/tasks/${created.payload.id}`, {
      method: "PATCH",
      body: { status: "done" },
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    assert.equal(agentPatchCompletes.response.status, 403);
    assert.equal(agentPatchCompletes.payload.error.code, "agent_task_edit_forbidden");

    const agentPatchTitle = await apiRequest(api.origin, `/api/tasks/${created.payload.id}`, {
      method: "PATCH",
      body: { title: "Rewritten by an agent" },
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    assert.equal(agentPatchTitle.response.status, 403);
    assert.equal(agentPatchTitle.payload.error.code, "agent_task_edit_forbidden");

    // Delegation is human-only: an agent identity cannot create a task that
    // is already handed to an agent.
    const agentDelegates = await apiRequest(api.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Self-delegated work", delegated: true },
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    assert.equal(agentDelegates.response.status, 403);
    assert.equal(agentDelegates.payload.error.code, "agent_delegation_forbidden");

    const humanCompletes = await apiRequest(api.origin, `/api/tasks/${created.payload.id}/move`, {
      method: "POST",
      body: { status: "done" },
    });
    assert.equal(humanCompletes.response.status, 200);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("persists a per-project view mode with sensible defaults", async () => {
  const { root } = await makeWorkspaceFixture();
  // A marker written before the view key existed reads as the board.
  await mkdir(join(root, "legacy-project", ".work"), { recursive: true });
  await writeFile(
    join(root, "legacy-project", ".work", "project.json"),
    `${JSON.stringify({ version: 1, id: "legacy-view-project", name: "Legacy", description: "", createdAt: "2026-01-01T00:00:00.000Z" }, null, 2)}\n`,
  );
  const api = await startLocalApi({ root, port: 0 });
  try {
    const projects = await apiRequest(api.origin, "/api/projects");
    const legacy = projects.payload.projects.find((project) => project.path === "legacy-project");
    assert.equal(legacy.view, "board");

    // A newly created project starts small, so it starts as a list.
    const created = await apiRequest(api.origin, "/api/projects", {
      method: "POST",
      body: { name: "Fresh Project" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.view, "list");
    const marker = JSON.parse(await readFile(join(root, "fresh-project", ".work", "project.json"), "utf8"));
    assert.equal(marker.view, "list");

    // The profile route flips and persists the mode.
    const flipped = await apiRequest(api.origin, "/api/projects/profile", {
      method: "PATCH",
      body: { projectPath: "fresh-project", view: "board" },
    });
    assert.equal(flipped.response.status, 200);
    assert.equal(flipped.payload.view, "board");
    assert.equal(JSON.parse(await readFile(join(root, "fresh-project", ".work", "project.json"), "utf8")).view, "board");

    const invalid = await apiRequest(api.origin, "/api/projects/profile", {
      method: "PATCH",
      body: { projectPath: "fresh-project", view: "timeline" },
    });
    assert.equal(invalid.response.status, 400);
  } finally {
    await closeLocalApi(api.server);
  }

  // The mode survives a service restart.
  const restarted = await startLocalApi({ root, port: 0 });
  try {
    const projects = await apiRequest(restarted.origin, "/api/projects");
    assert.equal(projects.payload.projects.find((project) => project.path === "fresh-project").view, "board");
    assert.equal(projects.payload.projects.find((project) => project.path === "legacy-project").view, "board");
  } finally {
    await closeLocalApi(restarted.server);
  }
});

test("serve refuses to register a new root and points at work init", async () => {
  const orphan = await temporaryDirectory("work-serve-orphan-");
  const registryPath = join(orphan, "roots.json");
  const environment = { ...process.env, WORK_REGISTRY_FILE: registryPath };

  await assert.rejects(
    execFile(process.execPath, [launcherPath.pathname, "serve", orphan, "--no-ui", "--api-port", "0"], {
      cwd: repositoryRoot,
      env: environment,
    }),
    (error) =>
      error.code === 1
      && error.stderr.includes("serving does not register roots on its own")
      && error.stderr.includes(`work init ${orphan}`),
  );
  // The refusal must not create or register anything.
  await assert.rejects(readdir(join(orphan, ".work")), { code: "ENOENT" });
  await assert.rejects(readFile(registryPath, "utf8"), { code: "ENOENT" });

  // Bare `work` from an unregistered directory refuses the same way.
  await assert.rejects(
    execFile(process.execPath, [launcherPath.pathname, "--no-ui", "--api-port", "0"], {
      cwd: orphan,
      env: environment,
    }),
    (error) => error.code === 1 && error.stderr.includes("serving does not register roots on its own"),
  );
});

test("refuses to register temporary directories as roots unless tests opt in", async () => {
  const root = await temporaryDirectory("work-temp-guard-");
  const registryPath = join(root, "roots.json");
  const environment = { ...process.env, WORK_REGISTRY_FILE: registryPath };
  delete environment.WORK_ALLOW_TEMP_ROOTS;

  for (const command of ["register", "init"]) {
    await assert.rejects(
      execFile(process.execPath, [launcherPath.pathname, command, root], { cwd: repositoryRoot, env: environment }),
      (error) =>
        error.stderr.includes("temporary directory")
        && error.stderr.includes("Choose a durable directory"),
    );
  }
  await assert.rejects(readFile(registryPath, "utf8"), { code: "ENOENT" });
});

test("lists, prunes, and forgets roots without touching workspace files", async () => {
  const keep = await temporaryDirectory("work-roots-keep-");
  const dead = await temporaryDirectory("work-roots-dead-");
  const forgettable = await temporaryDirectory("work-roots-forget-");
  const holder = await temporaryDirectory("work-roots-registry-");
  const registryPath = join(holder, "roots.json");
  const environment = { ...process.env, WORK_REGISTRY_FILE: registryPath };
  const canonicalKeep = await realpath(keep);
  const canonicalDead = await realpath(dead);
  const canonicalForgettable = await realpath(forgettable);

  for (const target of [keep, dead, forgettable]) {
    await execFile(process.execPath, [launcherPath.pathname, "register", target], { cwd: repositoryRoot, env: environment });
  }
  await execFile(process.execPath, [launcherPath.pathname, "new", "Field Notes", "--root", keep], { cwd: repositoryRoot, env: environment });
  await rm(dead, { recursive: true, force: true });
  // An unmounted-volume-style entry must survive pruning.
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.roots.push({ id: "volume-entry", name: "wat", root: "/Volumes/work-test-missing-volume/wat" });
  await writeFile(registryPath, JSON.stringify(registry, null, 2));

  const listed = await execFile(process.execPath, [launcherPath.pathname, "roots"], { cwd: repositoryRoot, env: environment });
  assert.match(listed.stdout, new RegExp(`${canonicalKeep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\t1 project`));
  assert.match(listed.stdout, new RegExp(`${canonicalDead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\t\\(unreachable\\)`));
  assert.match(listed.stdout, /\/Volumes\/work-test-missing-volume\/wat\t\(unreachable\)/);

  const pruned = await execFile(process.execPath, [launcherPath.pathname, "roots", "prune"], { cwd: repositoryRoot, env: environment });
  assert.match(pruned.stdout, new RegExp(`Pruned ${canonicalDead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(pruned.stdout, /Volumes/);
  const afterPrune = JSON.parse(await readFile(registryPath, "utf8")).roots.map((entry) => entry.root);
  assert.ok(!afterPrune.includes(canonicalDead));
  assert.ok(afterPrune.includes("/Volumes/work-test-missing-volume/wat"));

  const again = await execFile(process.execPath, [launcherPath.pathname, "roots", "prune"], { cwd: repositoryRoot, env: environment });
  assert.match(again.stdout, /No dead roots to prune\./);

  const forgotten = await execFile(process.execPath, [launcherPath.pathname, "roots", "forget", forgettable], { cwd: repositoryRoot, env: environment });
  assert.match(forgotten.stdout, /Its files were not touched\./);
  assert.ok(!JSON.parse(await readFile(registryPath, "utf8")).roots.some((entry) => entry.root === canonicalForgettable));
  assert.equal(JSON.parse(await readFile(join(forgettable, ".work", "workspace.json"), "utf8")).version, 1);
});

test("serve auto-prunes dead roots and reports the count on startup", async () => {
  const alive = await temporaryDirectory("work-autoprune-alive-");
  const gone = await temporaryDirectory("work-autoprune-gone-");
  const registryPath = join(alive, "roots.json");
  const environment = { ...process.env, WORK_REGISTRY_FILE: registryPath };
  for (const target of [gone, alive]) {
    await execFile(process.execPath, [launcherPath.pathname, "register", target], { cwd: repositoryRoot, env: environment });
  }
  await rm(gone, { recursive: true, force: true });

  const child = spawn(
    process.execPath,
    [launcherPath.pathname, "serve", alive, "--no-ui", "--api-port", "0"],
    { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No ready line. Output: ${output}`)), 5_000);
      child.stdout.on("data", () => {
        if (/\[work\] API ready at /.test(output)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Work exited early (${code}). Output: ${output}`));
      });
    });
    assert.match(output, /\[work\] Roots available: 1 \(pruned 1 dead root\)/);
    const roots = JSON.parse(await readFile(registryPath, "utf8")).roots.map((entry) => entry.root);
    assert.deepEqual(roots, [await realpath(alive)]);
  } finally {
    await stopChild(child);
  }
});

test("the workspace id floor sets where new task ids start", async () => {
  const floored = await temporaryDirectory("work-idfloor-");
  const workspace = await initializeWorkspace(floored, { force: true, idFloor: 5000 });
  assert.equal(workspace.idFloor, 5000);
  assert.equal(JSON.parse(await readFile(join(floored, ".work", "workspace.json"), "utf8")).idFloor, 5000);

  const first = await createTask(workspace, { title: "First floored task" });
  assert.equal(first.id, "W-5000", "the first id must be the floor itself");
  const second = await createTask(workspace, { title: "Second floored task" });
  assert.equal(second.id, "W-5001");

  // A high-water mark above the floor keeps counting from the mark.
  const lowered = await initializeWorkspace(floored, { force: true, idFloor: 10 });
  assert.equal(lowered.idFloor, 10);
  const third = await createTask(lowered, { title: "Third task" });
  assert.equal(third.id, "W-5002");

  // No floor behaves exactly as before.
  const plain = await temporaryDirectory("work-idfloor-none-");
  const plainWorkspace = await initializeWorkspace(plain, { force: true });
  assert.equal(plainWorkspace.idFloor, 0);
  assert.equal(JSON.parse(await readFile(join(plain, ".work", "workspace.json"), "utf8")).idFloor, undefined);
  assert.equal((await createTask(plainWorkspace, { title: "Unfloored task" })).id, "W-0001");

  // Garbage floors are refused, both as an argument and in the marker.
  for (const bad of [-1, 1.5, "3000"]) {
    await assert.rejects(
      () => initializeWorkspace(plain, { force: true, idFloor: bad }),
      /idFloor .* must be a non-negative integer/,
      `idFloor ${JSON.stringify(bad)} must be rejected`,
    );
  }
  const markerPath = join(plain, ".work", "workspace.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, `${JSON.stringify({ ...marker, idFloor: "many" }, null, 2)}\n`);
  await assert.rejects(() => initializeWorkspace(plain, { force: true }), /idFloor .* must be a non-negative integer/);

  // `work init --id-floor N` is the set path, on a new or an existing workspace.
  const viaCli = await temporaryDirectory("work-idfloor-cli-");
  const registryPath = join(viaCli, "roots.json");
  const environment = { ...process.env, WORK_REGISTRY_FILE: registryPath };
  const cliMarker = join(viaCli, ".work", "workspace.json");
  for (const floor of ["2500", "7000"]) {
    await execFile(process.execPath, [launcherPath.pathname, "init", viaCli, "--id-floor", floor], { cwd: repositoryRoot, env: environment });
    assert.equal(JSON.parse(await readFile(cliMarker, "utf8")).idFloor, Number(floor));
  }
  await assert.rejects(
    () => execFile(process.execPath, [launcherPath.pathname, "init", viaCli, "--id-floor", "later"], { cwd: repositoryRoot, env: environment }),
    /idFloor/,
  );
});

test("project tags are optional, derived, and survive unrelated profile edits", async () => {
  // Pure rules first: one definition shared by the CLI, the API, and the web app.
  assert.deepEqual(normalizeTags([" House ", "house", "", "HOUSE", "yard "]), ["House", "yard"]);
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags(["ok", 7, null]), ["ok"]);
  // Suggestions are the union across projects, deduped case-insensitively.
  assert.deepEqual(workspaceTags([{ tags: ["b", "House"] }, { tags: ["house", "a"] }, {}]), ["a", "b", "House"]);
  assert.deepEqual(workspaceTags([]), []);
  // Colour is a stable pure function of the name, so the phone agrees with the
  // desktop. ios/Work/Models.swift pins these same numbers.
  assert.equal(tagHueIndex("house"), 0);
  assert.equal(tagHueIndex("House"), tagHueIndex("house"));
  assert.equal(tagHueIndex("lvp-repair"), 4);
  assert.equal(tagHueIndex("work"), 1);
  assert.equal(tagHueAngle("lvp-repair"), 190);

  const { root } = await makeWorkspaceFixture();
  const api = await startLocalApi({ root, port: 0 });
  const markerPath = join(root, "software", "rekit", ".work", "project.json");

  try {
    // An untagged project reads as [] and its marker never grows a tags key.
    const before = await apiRequest(api.origin, "/api/projects");
    assert.deepEqual(before.payload.projects.find((project) => project.path === "software/rekit").tags, []);

    const tagged = await apiRequest(api.origin, "/api/projects/profile", {
      method: "PATCH",
      body: { projectPath: "software/rekit", tags: [" House ", "house", "renovation"] },
    });
    assert.equal(tagged.response.status, 200);
    assert.deepEqual(tagged.payload.tags, ["House", "renovation"]);
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")).tags, ["House", "renovation"]);
    const listed = await apiRequest(api.origin, "/api/projects");
    assert.deepEqual(listed.payload.projects.find((project) => project.path === "software/rekit").tags, ["House", "renovation"]);

    // The regression most likely to bite: an unrelated profile edit must not
    // drop the tags.
    const renamed = await apiRequest(api.origin, "/api/projects/profile", {
      method: "PATCH",
      body: { projectPath: "software/rekit", name: "ReKit Studio" },
    });
    assert.equal(renamed.payload.name, "ReKit Studio");
    assert.deepEqual(renamed.payload.tags, ["House", "renovation"]);

    // Tags belong to the project alone: a task in it keeps its own tags.
    const task = await apiRequest(api.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Lay the plank", projectPath: "software/rekit", tags: ["flooring"] },
    });
    assert.deepEqual(task.payload.tags, ["flooring"]);

    // The empty list clears them and leaves the marker in its original shape.
    const cleared = await apiRequest(api.origin, "/api/projects/profile", {
      method: "PATCH",
      body: { projectPath: "software/rekit", tags: [] },
    });
    assert.deepEqual(cleared.payload.tags, []);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(markerPath, "utf8")), "tags"), false);

    const missing = await apiRequest(api.origin, "/api/projects/profile", {
      method: "PATCH",
      body: { projectPath: "software/rekit" },
    });
    assert.equal(missing.response.status, 400);
  } finally {
    await closeLocalApi(api.server);
  }

  // The CLI sets the same list, and omitting --tag clears it.
  const set = await execFile(
    process.execPath,
    [launcherPath.pathname, "project", "software/rekit", "--tag", "house", "--tag", "House", "--tag", "renovation"],
    { cwd: root },
  );
  assert.match(set.stdout, /Tags: house, renovation/);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")).tags, ["house", "renovation"]);

  const clear = await execFile(process.execPath, [launcherPath.pathname, "project", "software/rekit"], { cwd: root });
  assert.match(clear.stdout, /Tags: \(none\)/);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(markerPath, "utf8")), "tags"), false);
});
