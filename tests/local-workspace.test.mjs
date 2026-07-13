import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";
import { discoverProjects } from "../lib/local-workspace.mjs";

const temporaryDirectories = [];
const execFile = promisify(execFileCallback);
const repositoryRoot = new URL("../", import.meta.url);
const launcherPath = new URL("../bin/work.mjs", import.meta.url);

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

async function launchApiFromCli(root) {
  const child = spawn(
    process.execPath,
    [launcherPath.pathname, "serve", root, "--no-ui", "--api-port", "0"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, WORK_REGISTRY_FILE: join(root, ".work-test-roots.json") },
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
  assert.equal(packageJson.bin.work, "./bin/work.mjs");
  assert.equal(packageJson.scripts.work, "node ./bin/work.mjs");

  const help = await execFile(process.execPath, [launcherPath.pathname, "--help"], {
    cwd: repositoryRoot,
  });
  assert.match(help.stdout, /work \[root\]/i);
  assert.match(help.stdout, /--init/);
  assert.match(help.stdout, /--project <path>.*never inferred/i);

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

  const createdTask = await execFile(
    process.execPath,
    [
      launcherPath.pathname,
      "task",
      "Build the operational board",
      "--priority",
      "high",
      "--requirement",
      "Show work in flight",
      "--acceptance",
      "Completed work remains visible",
    ],
    { cwd: descendant },
  );
  assert.match(createdTask.stdout, /Created W-0001/);
  await execFile(process.execPath, [launcherPath.pathname, "move", "W-0001", "in_progress"], { cwd: descendant });
  await execFile(process.execPath, [launcherPath.pathname, "log", "W-0001", "Board implementation started"], { cwd: descendant });
  const listedTasks = await execFile(process.execPath, [launcherPath.pathname, "list"], { cwd: descendant });
  assert.match(listedTasks.stdout, /W-0001\s+in_progress\s+high/);
  const shownTask = await execFile(process.execPath, [launcherPath.pathname, "show", "W-0001"], { cwd: descendant });
  assert.match(shownTask.stdout, /Board implementation started/);

  const launched = await launchApiFromCli(root);
  try {
    const health = await apiRequest(launched.origin, "/api/health");
    assert.equal(health.response.status, 200);
  } finally {
    const exited = once(launched.child, "exit");
    launched.child.kill("SIGTERM");
    await exited;
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

    const paths = result.payload.projects.map(projectPath).sort();
    assert.deepEqual(paths, ["research/unmask", "software/rekit"]);
    assert.equal(paths.some((path) => path.startsWith("outside-link")), false);

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
  const forcedNested = await startLocalApi({
    root: nestedRoot,
    port: 0,
    forceNewWorkspace: true,
  });
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

test("offers registered roots and resolves every request inside the selected workspace", async () => {
  const firstRoot = await temporaryDirectory("work-picker-home-");
  const secondRoot = await temporaryDirectory("work-picker-lab-");
  const launched = await startLocalApi({ root: firstRoot, roots: [firstRoot, secondRoot], port: 0 });

  try {
    const directory = await apiRequest(launched.origin, "/api/workspaces");
    assert.equal(directory.response.status, 200);
    assert.equal(directory.payload.workspaces.length, 2);

    const canonicalSecondRoot = await realpath(secondRoot);
    const second = directory.payload.workspaces.find((workspace) => workspace.root === canonicalSecondRoot);
    assert.ok(second);
    const selectedHeaders = { "x-work-workspace": second.id };
    const snapshot = await apiRequest(launched.origin, "/api/workspace", { headers: selectedHeaders });
    assert.equal(snapshot.payload.workspace.root, canonicalSecondRoot);

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
    assert.equal(created.payload.agentIntent, "reference_only");
    noteId = created.payload.id;

    const pathname = join(root, "software", "rekit", ".work", "notes", `${noteId}.md`);
    const stored = await readFile(pathname, "utf8");
    assert.match(stored, /type: "note"/);
    assert.match(stored, /title: "Strategy fragments"/);
    assert.match(stored, /agentIntent: "reference_only"/);
    assert.ok(stored.includes("Questions to revisit:\nKeep this as ordinary text."));
    assert.deepEqual(await readdir(join(root, ".work", "notes")), []);

    const legacyNoteId = "note_legacy1234";
    await writeFile(join(root, "software", "rekit", ".work", "notes", `${legacyNoteId}.md`), `---
id: "${legacyNoteId}"
type: "note"
title: "Older note"
scopePath: "software/rekit"
projectPath: "software/rekit"
createdAt: "2026-01-01T00:00:00.000Z"
updatedAt: "2026-01-01T00:00:00.000Z"
---

Existing notes must remain passive by default.
`);
    const listed = await apiRequest(first.origin, "/api/notes");
    assert.equal(listed.payload.notes.find((note) => note.id === legacyNoteId)?.agentIntent, "reference_only");
    assert.match(await readFile(join(root, "software", "rekit", ".work", "notes", `${legacyNoteId}.md`), "utf8"), /agentIntent: "reference_only"/);
    const removedLegacy = await apiRequest(first.origin, `/api/notes/${legacyNoteId}`, { method: "DELETE" });
    assert.equal(removedLegacy.response.status, 204);

    const updated = await apiRequest(first.origin, `/api/notes/${encodeURIComponent(noteId)}`, {
      method: "PATCH",
      body: {
        title: "Strategy notes",
        text: "A revised thought.\n\nA second paragraph.",
        agentIntent: "review_requested",
      },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.title, "Strategy notes");
    assert.equal(updated.payload.text, "A revised thought.\n\nA second paragraph.");
    assert.equal(updated.payload.agentIntent, "review_requested");

    const invalidIntent = await apiRequest(first.origin, `/api/notes/${encodeURIComponent(noteId)}`, {
      method: "PATCH",
      body: { agentIntent: "execute_now" },
    });
    assert.equal(invalidIntent.response.status, 400);

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
    assert.equal(note.agentIntent, "review_requested");

    const removed = await apiRequest(restarted.origin, `/api/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
    assert.equal(removed.response.status, 204);
    assert.deepEqual(await readdir(join(root, "software", "rekit", ".work", "notes")), []);
  } finally {
    await closeLocalApi(restarted.server);
  }
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
      },
    });
    assert.equal(created.response.status, 201);
    decisionId = created.payload.id;

    const unchanged = await apiRequest(first.origin, "/api/workspace");
    const openDecision = unchanged.payload.decisions.find(
      (decision) => decision.id === decisionId,
    );
    assert.equal(openDecision.status, "open");

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
        type: "feature",
        priority: "high",
        assignee: "human",
        agents: ["codex-team"],
        tags: ["kanban", "storage"],
        goal: "Persist complete project state in Markdown.",
        requirements: ["One file per task", "Append-only progress log"],
        acceptanceCriteria: ["Survives restart", "Board reflects status"],
        plan: "Build schema, API, then UI.",
      },
    });
    assert.equal(foundation.response.status, 201);
    assert.equal(foundation.payload.id, "W-0001");
    assert.equal(foundation.payload.status, "backlog");
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

    const updated = await apiRequest(first.origin, `/api/tasks/${foundation.payload.id}`, {
      method: "PATCH",
      body: { status: "review", priority: "critical", notes: "Ready for the dependency gate test." },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.status, "review");
    assert.equal(updated.payload.priority, "critical");

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
    assert.match(taskFile, /priority: "critical"/);
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
