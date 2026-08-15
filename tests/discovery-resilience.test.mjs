import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";
import { discoverProjects, initializeWorkspace } from "../lib/local-workspace.mjs";

async function writeProjectMarker(root, relativePath, id, name) {
  const directory = join(root, relativePath, ".work");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "project.json"), JSON.stringify({
    version: 1, id, name, description: "", createdAt: new Date().toISOString(),
  }));
}

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "work-discovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("discovery never descends into hidden directories", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  await writeProjectMarker(root, "real-project", "11111111-1111-1111-1111-111111111111", "Real Project");

  // The outage shape: a tool's hidden working directory holding a full copy
  // of a project, marker and all.
  await cp(join(root, "real-project"), join(root, ".claude", "worktrees", "agent-x", "real-project"), { recursive: true });

  const projects = await discoverProjects(root, { forceRefresh: true });
  assert.deepEqual(projects.map((project) => project.path), ["real-project"]);
});

test("a duplicate project id degrades to a warning instead of refusing boot", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  await writeProjectMarker(root, "original", "22222222-2222-2222-2222-222222222222", "Original");
  // A visible copy (backup folder, drag-and-drop duplicate) with the same id.
  await cp(join(root, "original"), join(root, "original-backup"), { recursive: true });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(" "));
  let api;
  try {
    api = await startLocalApi({ root, port: 0 });
    const response = await fetch(new URL("/api/projects", api.origin));
    const payload = await response.json();
    assert.equal(response.status, 200);
    // Both folders are still visible as projects; the boot simply survived.
    const paths = payload.projects.map((project) => project.path).sort();
    assert.deepEqual(paths, ["original", "original-backup"]);
    assert.ok(warnings.some((line) => line.includes("Duplicate project id")), warnings.join("\n"));
  } finally {
    console.warn = originalWarn;
    if (api) await closeLocalApi(api.server);
  }
});
