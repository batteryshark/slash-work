import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
  // realpath because the workspace resolves its root (macOS /var → /private/var)
  // and this suite compares absolute paths out of payloads.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "work-attachments-")));
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

test("project records keep their attachments beside the record, and payloads resolve them", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, ".project"), "");
  const api = await startLocalApi({ root, port: 0 });

  try {
    const created = await requestJson(api.origin, "/api/issues", {
      method: "POST",
      body: { title: "Tile lippage on the north wall", body: "", projectPath: "project", scopePath: "project", attachments: [
        { name: "lippage", contentType: "image/png", data: PNG_BASE64 },
      ] },
    });
    assert.equal(created.response.status, 201);
    const issueId = created.payload.id;

    // The bytes live in the PROJECT's .work, exactly where the record's
    // relative ../attachments/… reference points — not at the workspace root.
    const beside = join(root, "project", ".work", "attachments", issueId, "lippage.png");
    assert.deepEqual(await readFile(beside), PNG_BYTES);
    await assert.rejects(readdir(join(root, ".work", "attachments", issueId)), { code: "ENOENT" });

    // The create response and every later read resolve the refs to absolute
    // paths, so an agent never has to reconstruct the record's directory.
    assert.deepEqual(created.payload.attachments, [{ name: "lippage.png", path: beside }]);
    const read = await requestJson(api.origin, `/api/issues/${issueId}`);
    assert.deepEqual(read.payload.attachments, [{ name: "lippage.png", path: beside }]);

    // The byte route finds project-homed files too.
    const fetched = await fetch(new URL(`/api/attachments?record=${issueId}&name=lippage.png`, api.origin));
    assert.equal(fetched.status, 200);
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), PNG_BYTES);

    // Legacy trees wrote project records' files to the workspace root; the
    // byte route still serves those.
    await mkdir(join(root, ".work", "attachments", "note_legacy_home"), { recursive: true });
    await writeFile(join(root, ".work", "attachments", "note_legacy_home", "old.png"), PNG_BYTES);
    const legacy = await fetch(new URL("/api/attachments?record=note_legacy_home&name=old.png", api.origin));
    assert.equal(legacy.status, 200);
    assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), PNG_BYTES);

    // Notes: same home, same payload resolution.
    const note = await requestJson(api.origin, "/api/notes", {
      method: "POST",
      body: { title: "Grout picks", text: "Warm gray.", projectPath: "project", attachments: [
        { name: "grout", contentType: "image/png", data: PNG_BASE64 },
      ] },
    });
    assert.equal(note.response.status, 201);
    const notePath = join(root, "project", ".work", "attachments", note.payload.id, "grout.png");
    assert.deepEqual(await readFile(notePath), PNG_BYTES);
    assert.deepEqual(note.payload.attachments, [{ name: "grout.png", path: notePath }]);

    // Deleting the note removes the project-homed folder with it.
    await requestJson(api.origin, `/api/notes/${note.payload.id}`, { method: "DELETE" });
    await assert.rejects(readdir(join(root, "project", ".work", "attachments", note.payload.id)), { code: "ENOENT" });
  } finally {
    await closeLocalApi(api.server);
  }
});

test("agent issue payloads rewrite ../attachments/ refs to absolute paths", async () => {
  const root = await temporaryDirectory();
  await initializeWorkspace(root);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, ".project"), "");
  const api = await startLocalApi({ root, port: 0 });

  try {
    const created = await requestJson(api.origin, "/api/issues", {
      method: "POST",
      body: { title: "Pasted screenshot", body: "", projectPath: "project", scopePath: "project", attachments: [
        { name: "shot", contentType: "image/png", data: PNG_BASE64 },
        { name: "second", contentType: "image/png", data: PNG_BASE64 },
      ] },
    });
    assert.equal(created.response.status, 201);
    const issueId = created.payload.id;
    const shotPath = join(root, "project", ".work", "attachments", issueId, "shot.png");
    const secondPath = join(root, "project", ".work", "attachments", issueId, "second.png");

    // A reply can carry its own pasted image; the ref lives in the message body.
    await requestJson(api.origin, `/api/issues/${issueId}/replies`, {
      method: "POST",
      body: { body: "close-up", attachments: [{ name: "closeup", contentType: "image/png", data: PNG_BASE64 }] },
    });
    const closeupPath = join(root, "project", ".work", "attachments", issueId, "closeup.png");

    // Human payloads keep the portable relative refs for markdown viewers.
    const human = await requestJson(api.origin, `/api/issues/${issueId}`);
    assert.match(human.payload.body, new RegExp(`!\\[shot\\.png\\]\\(\\.\\./attachments/${issueId}/shot\\.png\\)`));
    assert.match(human.payload.body, new RegExp(`!\\[second\\.png\\]\\(\\.\\./attachments/${issueId}/second\\.png\\)`));
    assert.match(human.payload.messages.at(-1).body, new RegExp(`!\\[closeup\\.png\\]\\(\\.\\./attachments/${issueId}/closeup\\.png\\)`));

    // Agent payloads resolve every ref to the absolute path on this machine,
    // so a work item snapshot opens the image from the project directory.
    const agentHeaders = { "x-work-agent": "test-agent" };
    const detail = await requestJson(api.origin, `/api/agent/issues/${issueId}`, { headers: agentHeaders });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.payload.body, `![shot.png](${shotPath})\n![second.png](${secondPath})`);
    assert.equal(detail.payload.messages.at(-1).body, `close-up\n\n![closeup.png](${closeupPath})`);
    assert.deepEqual(detail.payload.attachments, [
      { name: "shot.png", path: shotPath },
      { name: "second.png", path: secondPath },
      { name: "closeup.png", path: closeupPath },
    ]);
    for (const path of [shotPath, secondPath, closeupPath]) {
      assert.deepEqual(await readFile(path), PNG_BYTES);
    }

    // The list endpoint (what the sweeper renders into the snapshot) resolves
    // the same way.
    const list = await requestJson(api.origin, "/api/agent/issues", { headers: agentHeaders });
    const listed = list.payload.issues.find((issue) => issue.id === issueId);
    assert.equal(listed.body, `![shot.png](${shotPath})\n![second.png](${secondPath})`);
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
