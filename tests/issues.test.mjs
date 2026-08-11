import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "work-issues-"));
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

test("lets agents file attributed issues while delegation stays human-only", async () => {
  const root = await temporaryDirectory();
  const api = await startLocalApi({ root, port: 0 });

  try {
    const missingIdentity = await requestJson(api.origin, "/api/agent/issues", {
      method: "POST",
      body: { title: "Flaky retry loop", body: "Discovered while profiling the sweeper." },
    });
    assert.equal(missingIdentity.response.status, 400);
    assert.equal(missingIdentity.payload.error.code, "agent_identity_required");

    const filed = await requestJson(api.origin, "/api/agent/issues", {
      method: "POST",
      body: { title: "Flaky retry loop", body: "Discovered while profiling the sweeper.", agents: ["self-delegated"] },
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    assert.equal(filed.response.status, 201);
    assert.equal(filed.payload.state, "queued");
    assert.equal(filed.payload.claimedBy, null);
    assert.deepEqual(filed.payload.agents, [], "agent-filed issues must start with an empty agents list");
    assert.deepEqual(filed.payload.stateHistory[0].actor, { kind: "agent", name: "orchestra/brisk_otter" });

    const delegated = await requestJson(api.origin, `/api/issues/${filed.payload.id}`, {
      method: "PATCH",
      body: { agents: ["orchestra"], refs: ["W-0001"] },
    });
    assert.equal(delegated.response.status, 200);
    assert.deepEqual(delegated.payload.agents, ["orchestra"]);
    assert.deepEqual(delegated.payload.refs, ["W-0001"]);

    const stored = await readFile(join(root, ".work", "issues", `${filed.payload.id}.md`), "utf8");
    assert.match(stored, /agents: \["orchestra"\]/);
    assert.match(stored, /refs: \["W-0001"\]/);

    const stale = await requestJson(api.origin, `/api/issues?updatedSince=${encodeURIComponent(delegated.payload.updatedAt)}`);
    assert.deepEqual(stale.payload.issues, []);
    const fresh = await requestJson(api.origin, "/api/issues?updatedSince=2000-01-01T00:00:00Z");
    assert.equal(fresh.payload.issues[0].id, filed.payload.id);
    assert.deepEqual(fresh.payload.issues[0].agents, ["orchestra"]);
    const agentStale = await requestJson(api.origin, `/api/agent/issues?updatedSince=${encodeURIComponent(delegated.payload.updatedAt)}`, {
      headers: { "x-work-agent": "orchestra/brisk_otter" },
    });
    assert.deepEqual(agentStale.payload.issues, []);
    const invalidCursor = await requestJson(api.origin, "/api/issues?updatedSince=not-a-date");
    assert.equal(invalidCursor.response.status, 400);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("persists issue conversations and keeps final closure under human control", async () => {
  const root = await temporaryDirectory();
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, ".project"), "");
  const first = await startLocalApi({ root, port: 0 });
  const initialBody = "\n\n# Cache refresh is confusing\n\nThe UI still shows `old-value`.\n\n";
  const markdownReply = "\n\nI reproduced this with:\n\n```sh\nwork start\n```\n\n";
  let issueId;

  try {
    const created = await requestJson(first.origin, "/api/issues", {
      method: "POST",
      body: {
        body: initialBody,
        scopePath: "project",
        projectPath: "project",
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.title, "Cache refresh is confusing");
    assert.equal(created.payload.state, "queued");
    assert.equal(created.payload.body, initialBody);
    assert.equal(created.payload.projectPath, "project");
    assert.equal(created.payload.messages.length, 0);
    assert.deepEqual(created.payload.claimedBy, null);
    assert.deepEqual(created.payload.stateHistory[0], {
      from: null,
      to: "queued",
      actor: { kind: "human", name: null },
      at: created.payload.createdAt,
      reason: "Issue filed.",
      resolutionSummary: null,
    });
    issueId = created.payload.id;

    const storedPath = join(projectRoot, ".work", "issues", `${issueId}.md`);
    const stored = await readFile(storedPath, "utf8");
    assert.match(stored, /type: "issue"/);
    assert.match(stored, /state: "queued"/);
    assert.match(stored, /## Issue/);
    assert.ok(stored.includes("The UI still shows `old-value`."));

    const listed = await requestJson(first.origin, "/api/issues");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.issues[0].id, issueId);
    const detail = await requestJson(first.origin, `/api/issues/${issueId}`);
    assert.equal(detail.payload.body, created.payload.body);

    const missingIdentity = await requestJson(first.origin, `/api/agent/issues/${issueId}/claim`, {
      method: "POST",
      body: {},
    });
    assert.equal(missingIdentity.response.status, 400);
    assert.equal(missingIdentity.payload.error.code, "agent_identity_required");

    const claimed = await requestJson(first.origin, `/api/agent/issues/${issueId}/claim`, {
      method: "POST",
      body: {},
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.payload.state, "in_progress");
    assert.deepEqual(claimed.payload.claimedBy, { kind: "agent", name: "codex-cli" });

    const otherAgentReply = await requestJson(first.origin, `/api/agent/issues/${issueId}/replies`, {
      method: "POST",
      body: { body: "I should not be able to join this claimed thread." },
      headers: { "x-work-agent": "other-agent" },
    });
    assert.equal(otherAgentReply.response.status, 409);
    assert.equal(otherAgentReply.payload.error.code, "issue_claimed_by_other");

    const agentReply = await requestJson(first.origin, `/api/agent/issues/${issueId}/replies`, {
      method: "POST",
      body: { body: markdownReply },
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(agentReply.response.status, 200);
    assert.deepEqual(agentReply.payload.messages[0].author, { kind: "agent", name: "codex-cli" });
    assert.equal(agentReply.payload.messages[0].body, markdownReply);

    const needsHuman = await requestJson(first.origin, `/api/agent/issues/${issueId}/state`, {
      method: "POST",
      body: { state: "needs_human", reason: "Which refresh path did you use?" },
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(needsHuman.payload.state, "needs_human");

    const answered = await requestJson(first.origin, `/api/issues/${issueId}/replies`, {
      method: "POST",
      body: { body: "I used the automatic background refresh." },
    });
    assert.equal(answered.response.status, 200);
    assert.equal(answered.payload.state, "queued");
    assert.equal(answered.payload.claimedBy, null);
    assert.deepEqual(answered.payload.messages.at(-1).author, { kind: "human", name: null });
    assert.equal(answered.payload.stateHistory.at(-1).from, "needs_human");
    assert.equal(answered.payload.stateHistory.at(-1).to, "queued");

    const resumed = await requestJson(first.origin, `/api/agent/issues/${issueId}/claim`, {
      method: "POST",
      body: {},
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(resumed.payload.state, "in_progress");

    const missingResolution = await requestJson(first.origin, `/api/agent/issues/${issueId}/state`, {
      method: "POST",
      body: { state: "resolved" },
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(missingResolution.response.status, 400);

    const agentCloses = await requestJson(first.origin, `/api/agent/issues/${issueId}/state`, {
      method: "POST",
      body: { state: "closed" },
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(agentCloses.response.status, 403);
    assert.equal(agentCloses.payload.error.code, "agent_issue_state_forbidden");

    const resolved = await requestJson(first.origin, `/api/agent/issues/${issueId}/state`, {
      method: "POST",
      body: {
        state: "resolved",
        resolutionSummary: "The refresh completes after the cache generation advances.",
      },
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(resolved.response.status, 200);
    assert.equal(resolved.payload.state, "resolved");
    assert.equal(resolved.payload.resolutionSummary, "The refresh completes after the cache generation advances.");

    const agentReopens = await requestJson(first.origin, `/api/agent/issues/${issueId}/state`, {
      method: "POST",
      body: { state: "in_progress" },
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(agentReopens.response.status, 409);
    assert.equal(agentReopens.payload.error.code, "issue_reopen_forbidden");

    const reopenedByReply = await requestJson(first.origin, `/api/issues/${issueId}/replies`, {
      method: "POST",
      body: { body: "This still happens after the generation changes." },
    });
    assert.equal(reopenedByReply.response.status, 200);
    assert.equal(reopenedByReply.payload.state, "queued");
    assert.equal(reopenedByReply.payload.claimedBy, null);
    assert.equal(reopenedByReply.payload.resolutionSummary, null);
    assert.deepEqual(reopenedByReply.payload.messages.at(-1).author, { kind: "human", name: null });
    assert.equal(reopenedByReply.payload.stateHistory.at(-1).reason, "Human reply reopened the issue.");

    const reclaimed = await requestJson(first.origin, `/api/agent/issues/${issueId}/claim`, {
      method: "POST",
      body: {},
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(reclaimed.payload.state, "in_progress");

    const closed = await requestJson(first.origin, `/api/issues/${issueId}/state`, {
      method: "POST",
      body: { state: "closed", reason: "Closing until I can reproduce again." },
    });
    assert.equal(closed.response.status, 200);
    assert.equal(closed.payload.state, "closed");

    const replyWhileClosed = await requestJson(first.origin, `/api/agent/issues/${issueId}/replies`, {
      method: "POST",
      body: { body: "Agents cannot keep a human-closed issue active." },
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(replyWhileClosed.response.status, 409);

    const reopenedByClosedReply = await requestJson(first.origin, `/api/issues/${issueId}/replies`, {
      method: "POST",
      body: { body: "I have another reproduction after closing this." },
    });
    assert.equal(reopenedByClosedReply.response.status, 200);
    assert.equal(reopenedByClosedReply.payload.state, "queued");
    assert.equal(reopenedByClosedReply.payload.stateHistory.at(-1).from, "closed");
    assert.equal(reopenedByClosedReply.payload.stateHistory.at(-1).to, "queued");

    const closedAgain = await requestJson(first.origin, `/api/issues/${issueId}/state`, {
      method: "POST",
      body: { state: "closed", reason: "Testing the explicit reopen control." },
    });
    assert.equal(closedAgain.response.status, 200);

    const reopened = await requestJson(first.origin, `/api/issues/${issueId}/state`, {
      method: "POST",
      body: { state: "queued" },
    });
    assert.equal(reopened.response.status, 200);
    assert.equal(reopened.payload.state, "queued");

    const deleteAttempt = await requestJson(first.origin, `/api/issues/${issueId}`, { method: "DELETE" });
    assert.equal(deleteAttempt.response.status, 404);
  } finally {
    await closeLocalApi(first.server);
  }

  const projectIssuePath = join(projectRoot, ".work", "issues", `${issueId}.md`);
  const legacyRootPath = join(root, ".work", "issues", `${issueId}.md`);
  await rename(projectIssuePath, legacyRootPath);

  const restarted = await startLocalApi({ root, port: 0 });
  try {
    assert.deepEqual(await readdir(join(root, ".work", "issues")), []);
    assert.deepEqual(await readdir(join(projectRoot, ".work", "issues")), [`${issueId}.md`]);
    const snapshot = await requestJson(restarted.origin, "/api/workspace");
    const issue = snapshot.payload.issues.find((item) => item.id === issueId);
    assert.equal(issue.state, "queued");
    assert.equal(issue.body, initialBody);
    assert.equal(issue.projectPath, "project");
    assert.equal(issue.messages.length, 4);
    assert.equal(issue.messages[0].body, markdownReply);
    assert.ok(issue.stateHistory.length >= 12);

    const agentListMissingIdentity = await requestJson(restarted.origin, "/api/agent/issues");
    assert.equal(agentListMissingIdentity.response.status, 400);
    const agentList = await requestJson(restarted.origin, "/api/agent/issues", {
      headers: { "x-work-agent": "codex-cli" },
    });
    assert.equal(agentList.response.status, 200);
    assert.equal(agentList.payload.issues[0].id, issueId);

    const capability = await requestJson(restarted.origin, "/api/agent/operations/issues.update-state");
    assert.equal(capability.response.status, 200);
    assert.equal(capability.payload.operation.transport.api.path, "/api/agent/issues/{id}/state");
    assert.deepEqual(capability.payload.operation.inputSchema.properties.state.enum, ["in_progress", "needs_human", "resolved"]);
    assert.ok(capability.payload.operation.rules.some((rule) => /cannot close, reopen, delete, archive, or lock/i.test(rule)));

    const schema = await requestJson(restarted.origin, "/api/agent/schemas/artifacts/issue");
    assert.equal(schema.response.status, 200);
    assert.equal(schema.payload.$ref, "#/$defs/issue");
    assert.equal(schema.payload.$defs.issue.properties.state.enum.includes("closed"), true);

    const openapi = await requestJson(restarted.origin, "/api/openapi.json");
    const claimOperation = openapi.payload.paths["/api/agent/issues/{id}/claim"].post;
    assert.equal(claimOperation.operationId, "issues.claim");
    assert.equal(claimOperation.parameters.some((parameter) => parameter.name === "X-Work-Agent"), true);
    const createOperation = openapi.payload.paths["/api/agent/issues"].post;
    assert.equal(createOperation.operationId, "issues.create");
    assert.equal(createOperation.parameters.some((parameter) => parameter.name === "X-Work-Agent"), true);
  } finally {
    await closeLocalApi(restarted.server);
  }
});
