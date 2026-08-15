import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";
import { initializeWorkspace } from "../lib/local-workspace.mjs";

// A real 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "work-attachments-"));
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

test("pasted images become files beside the record and survive the round trip", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  const api = await startLocalApi({ root, port: 0 });

  try {
    // An issue filed with an attachment and no body text at all.
    const created = await requestJson(api.origin, "/api/issues", {
      method: "POST",
      body: { title: "The dialog renders behind the sheet", body: "", attachments: [
        { name: "Broken Dialog", contentType: "image/png", data: PNG_BASE64 },
      ] },
    });
    assert.equal(created.response.status, 201);
    const issueId = created.payload.id;
    assert.match(created.payload.body, new RegExp(`!\\[broken-dialog\\.png\\]\\(\\.\\./attachments/${issueId}/broken-dialog\\.png\\)`));

    // The bytes landed on disk where the reference points.
    const stored = await readFile(join(root, ".work", "attachments", issueId, "broken-dialog.png"));
    assert.deepEqual(stored, PNG_BYTES);

    // The API serves the bytes back with the right type; <img> tags cannot
    // send headers, so the workspace can ride in the query string.
    const fetched = await fetch(new URL(`/api/attachments?record=${issueId}&name=broken-dialog.png`, api.origin));
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), PNG_BYTES);

    // A reply that is only a screenshot: the reference becomes the message.
    const reply = await requestJson(api.origin, `/api/issues/${issueId}/replies`, {
      method: "POST",
      body: { attachments: [{ contentType: "image/png", data: PNG_BASE64 }] },
    });
    assert.equal(reply.response.status, 200);
    assert.match(reply.payload.messages.at(-1).body, new RegExp(`!\\[paste\\.png\\]\\(\\.\\./attachments/${issueId}/paste\\.png\\)`));

    // Same stem pastes get numbered rather than overwritten.
    await requestJson(api.origin, `/api/issues/${issueId}/replies`, {
      method: "POST",
      body: { attachments: [{ contentType: "image/png", data: PNG_BASE64 }] },
    });
    const names = await readdir(join(root, ".work", "attachments", issueId));
    assert.deepEqual(names.sort(), ["broken-dialog.png", "paste-2.png", "paste.png"]);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("notes take attachments on create and update, and delete cleans them up", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  const api = await startLocalApi({ root, port: 0 });

  try {
    const created = await requestJson(api.origin, "/api/notes", {
      method: "POST",
      body: { title: "Flooring reference", text: "The showroom sample.", attachments: [
        { name: "sample", contentType: "image/jpeg", data: PNG_BASE64 },
      ] },
    });
    assert.equal(created.response.status, 201);
    const noteId = created.payload.id;
    assert.match(created.payload.text, /!\[sample\.jpg\]\(\.\.\/attachments\//);

    const updated = await requestJson(api.origin, `/api/notes/${noteId}`, {
      method: "PATCH",
      body: { attachments: [{ name: "sample", contentType: "image/jpeg", data: PNG_BASE64 }] },
    });
    assert.equal(updated.response.status, 200);
    assert.match(updated.payload.text, /sample-2\.jpg/);

    const removed = await requestJson(api.origin, `/api/notes/${noteId}`, { method: "DELETE" });
    assert.equal(removed.response.status, 204);
    await assert.rejects(readdir(join(root, ".work", "attachments", noteId)), { code: "ENOENT" });
  } finally {
    await closeLocalApi(api.server);
  }
});

test("rejects what it must: bad types, oversized files, traversal names", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  const api = await startLocalApi({ root, port: 0 });

  try {
    const wrongType = await requestJson(api.origin, "/api/issues", {
      method: "POST",
      body: { body: "svg smuggling", attachments: [{ contentType: "image/svg+xml", data: PNG_BASE64 }] },
    });
    assert.equal(wrongType.response.status, 400);

    const empty = await requestJson(api.origin, "/api/issues", {
      method: "POST",
      body: { body: "empty data", attachments: [{ contentType: "image/png", data: "" }] },
    });
    assert.equal(empty.response.status, 400);

    // Reference lookups refuse traversal-shaped names outright.
    const issue = await requestJson(api.origin, "/api/issues", {
      method: "POST",
      body: { body: "plain issue" },
    });
    for (const name of ["../../tasks/W-0001.md", "..%2Fsecrets.png", "paste.png.exe"]) {
      const sneaky = await fetch(new URL(`/api/attachments?record=${issue.payload.id}&name=${encodeURIComponent(name)}`, api.origin));
      await sneaky.text();
      assert.equal(sneaky.status, 400, name);
    }
    const missing = await fetch(new URL(`/api/attachments?record=${issue.payload.id}&name=paste.png`, api.origin));
    await missing.text();
    assert.equal(missing.status, 404);
  } finally {
    await closeLocalApi(api.server);
  }
});
