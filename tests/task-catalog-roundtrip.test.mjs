import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

import { getAgentOperation } from "../lib/agent-capabilities.mjs";
import { createProject, createTask, getTask, initializeWorkspace, updateTask } from "../lib/local-workspace.mjs";

const execFile = promisify(execFileCallback);
const launcherPath = new URL("../bin/work.mjs", import.meta.url);
const temporaryDirectories = [];
const DROPPED = ["type", "priority", "assignee", "estimate", "agents"];
const WRITE_ONLY = new Set(["statusNote"]);

process.env.WORK_ALLOW_TEMP_ROOTS = "1";

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "work-catalog-roundtrip-"));
  temporaryDirectories.push(root);
  return { root, workspace: await initializeWorkspace(root) };
}

function schemaFields(id) {
  return Object.keys(getAgentOperation(id).operation.inputSchema.properties);
}

function readBack(task, field) {
  if (field === "requirements" || field === "acceptanceCriteria") {
    return (task[field] ?? []).map((item) => item.text);
  }
  return task[field];
}

test("tasks.create and tasks.update omit the fields the model dropped", () => {
  for (const id of ["tasks.create", "tasks.update"]) {
    const fields = schemaFields(id);
    for (const field of DROPPED) {
      assert.equal(fields.includes(field), false, `${id} still documents ${field}`);
    }
  }
});

test("every documented task field round-trips, and work show returns description and delegated", async () => {
  const { root, workspace } = await workspaceRoot();
  const project = await createProject(workspace, { name: "Probe" });
  const parent = await createTask(workspace, { title: "Parent" });
  const blocker = await createTask(workspace, { title: "Blocker" });

  const createdValues = {
    title: "Round-trip probe",
    projectPath: project.path,
    status: "ready",
    delegated: true,
    tags: ["probe"],
    dependsOn: [blocker.id],
    blockedBy: [blocker.id],
    blockedReason: "waiting on the blocker",
    parentId: parent.id,
    dueAt: "2027-06-01T12:00:00.000Z",
    source: "catalog-probe",
    description: "Background for the probe.",
    goal: "Prove every catalog field survives.",
    requirements: ["Field written"],
    acceptanceCriteria: ["Field read back"],
    plan: "Write, read, compare.",
    notes: "Supporting note.",
  };
  assert.deepEqual(schemaFields("tasks.create").toSorted(), Object.keys(createdValues).toSorted());

  const created = await createTask(workspace, createdValues);
  for (const field of schemaFields("tasks.create")) {
    assert.deepEqual(readBack(created, field), createdValues[field], `create lost ${field}`);
  }

  const updatedValues = {
    title: "Round-trip probe updated",
    projectPath: null,
    status: "in_progress",
    statusNote: "started the probe",
    delegated: false,
    tags: ["probe", "updated"],
    dependsOn: [],
    blockedBy: [],
    blockedReason: null,
    parentId: null,
    dueAt: null,
    description: "Updated background.",
    goal: "Updated goal.",
    requirements: ["Updated requirement"],
    acceptanceCriteria: ["Updated criterion"],
    plan: "Updated plan.",
    notes: "Updated notes.",
    completionSummary: "Not done yet.",
  };
  assert.deepEqual(schemaFields("tasks.update").toSorted(), Object.keys(updatedValues).toSorted());

  const updated = await updateTask(workspace, created.id, updatedValues);
  for (const field of schemaFields("tasks.update")) {
    if (WRITE_ONLY.has(field)) continue;
    assert.deepEqual(readBack(updated, field), updatedValues[field], `update lost ${field}`);
  }

  const shown = JSON.parse((await execFile(process.execPath, [launcherPath.pathname, "show", created.id], { cwd: root })).stdout);
  assert.equal(shown.description, updatedValues.description);
  assert.equal(shown.delegated, false);

  await assert.rejects(
    () => updateTask(workspace, created.id, { delegated: true }, null, { agentName: "dromond/probe" }),
    (error) => error.code === "agent_delegation_forbidden",
  );
});

test("the CLI no longer accepts the dropped task flags", async () => {
  const help = await execFile(process.execPath, [launcherPath.pathname, "--help"]);
  assert.doesNotMatch(help.stdout, /--priority|--estimate|--type <type>/);

  const { root } = await workspaceRoot();
  await assert.rejects(
    () => execFile(process.execPath, [launcherPath.pathname, "task", "x", "--priority", "high"], { cwd: root }),
    /Unknown option '--priority'/,
  );
});
