import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";
import { initializeWorkspace } from "../lib/local-workspace.mjs";

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "work-agent-task-gate-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function requestJson(origin, pathname, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(new URL(pathname, origin), {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

test("agent task creation is gated to children of delegated tasks", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  const api = await startLocalApi({ root, port: 0 });
  const agent = { "x-work-agent": "dromond/brisk_otter" };

  try {
    // Humans set up one delegated goal and one plain task.
    const goal = await requestJson(api.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Delegated goal", delegated: true },
    });
    assert.equal(goal.response.status, 201);
    const plain = await requestJson(api.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Plain human task" },
    });
    assert.equal(plain.response.status, 201);

    // (a) An agent cannot create a top-level task.
    const topLevel = await requestJson(api.origin, "/api/tasks", {
      method: "POST",
      headers: agent,
      body: { title: "Unparented agent task" },
    });
    assert.equal(topLevel.response.status, 403);
    assert.equal(topLevel.payload.error.code, "agent_task_parent_required");

    // (b) An agent can create a child of a delegated task; delegated is forced false.
    const child = await requestJson(api.origin, "/api/tasks", {
      method: "POST",
      headers: agent,
      body: { title: "Follow-on work", parentId: goal.payload.id },
    });
    assert.equal(child.response.status, 201);
    assert.equal(child.payload.parentId, goal.payload.id);
    assert.equal(child.payload.delegated, false);

    // (c) A child of a non-delegated task is rejected.
    const badParent = await requestJson(api.origin, "/api/tasks", {
      method: "POST",
      headers: agent,
      body: { title: "Child of plain task", parentId: plain.payload.id },
    });
    assert.equal(badParent.response.status, 403);
    assert.equal(badParent.payload.error.code, "agent_task_parent_not_delegated");

    // (d) delegated:true from an agent is still rejected, parent or not.
    const selfDelegated = await requestJson(api.origin, "/api/tasks", {
      method: "POST",
      headers: agent,
      body: { title: "Self-delegated", parentId: goal.payload.id, delegated: true },
    });
    assert.equal(selfDelegated.response.status, 403);
    assert.equal(selfDelegated.payload.error.code, "agent_delegation_forbidden");
  } finally {
    await closeLocalApi(api.server);
  }
});
