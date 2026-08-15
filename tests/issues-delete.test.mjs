import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";
import { initializeWorkspace } from "../lib/local-workspace.mjs";

// A real 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "work-issues-delete-"));
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

test("deleting an issue removes the record and its attachments", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  const api = await startLocalApi({ root, port: 0 });

  try {
    const created = await requestJson(api.origin, "/api/issues", {
      method: "POST",
      body: { title: "The dialog renders behind the sheet", body: "", attachments: [
        { name: "Broken Dialog", contentType: "image/png", data: PNG_BASE64 },
      ] },
    });
    assert.equal(created.response.status, 201);
    const issueId = created.payload.id;
    await stat(join(root, ".work", "issues", `${issueId}.md`));
    await stat(join(root, ".work", "attachments", issueId));

    const removed = await requestJson(api.origin, `/api/issues/${issueId}`, { method: "DELETE" });
    assert.equal(removed.response.status, 204);
    await assert.rejects(stat(join(root, ".work", "issues", `${issueId}.md`)), { code: "ENOENT" });
    await assert.rejects(readdir(join(root, ".work", "attachments", issueId)), { code: "ENOENT" });

    const gone = await requestJson(api.origin, `/api/issues/${issueId}`);
    assert.equal(gone.response.status, 404);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("deleting an unknown issue is a 404", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  const api = await startLocalApi({ root, port: 0 });

  try {
    const missing = await requestJson(api.origin, "/api/issues/I-9999", { method: "DELETE" });
    assert.equal(missing.response.status, 404);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("agents cannot delete issues", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  const api = await startLocalApi({ root, port: 0 });

  try {
    const created = await requestJson(api.origin, "/api/issues", {
      method: "POST",
      body: { title: "Agent-proof", body: "Humans only." },
    });
    assert.equal(created.response.status, 201);
    const issueId = created.payload.id;

    const refused = await requestJson(api.origin, `/api/issues/${issueId}`, {
      method: "DELETE",
      headers: { "x-work-agent": "someagent" },
    });
    assert.equal(refused.response.status, 403);
    assert.equal(refused.payload.error.code, "agent_issue_delete_forbidden");

    // The record is untouched.
    await stat(join(root, ".work", "issues", `${issueId}.md`));
  } finally {
    await closeLocalApi(api.server);
  }
});
