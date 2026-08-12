import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships a local root-scoped interface, not a hosted demo", async () => {
  const [html, packageSource] = await Promise.all([
    readFile(new URL("dist/index.html", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(html, /<title>Work · One root at a time<\/title>/i);
  assert.equal(JSON.parse(packageSource).bin.work, "bin/work.mjs");
  await assert.rejects(access(new URL(".openai/hosting.json", root)));
});

test("keeps the ADHD usability gates present in the interface", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  // Capture gate: an always-available dock, "/" focuses it, and a plain typed
  // thought is saved as a capture rather than interpreted as navigation.
  assert.match(page, /capture-dock/);
  assert.match(page, /event\.key === "\/"/);
  assert.match(page, /"\/api\/captures"/);

  // Needs you stays a bounded decision surface on Home.
  assert.match(page, /id="needs-you"/);

  // The task form stays calm: one delegation checkbox instead of priority,
  // type, assignee, and estimate theater; rarely-touched fields sit behind
  // one disclosure; a project can render as a plain list.
  assert.match(page, /Hand to an agent/);
  // The delegation toggle exists on both surfaces and explains itself: the
  // task form (field-delegate) and the issue thread (issue-delegate).
  assert.match(page, /issue-delegate/);
  assert.match(page, /An agent runner picks up delegated items on its next pass\./);
  assert.match(page, /task-more-fields/);
  assert.match(page, /project-view-toggle/);
  assert.doesNotMatch(page, /\bpriority\b|\bassignee\b|\bestimate\b/i);

  // Deleting a project requires an inline second confirmation.
  assert.match(page, /project-delete-panel/);
  assert.match(page, /danger-zone-button/);

  // No modal interruptions and no required form fields.
  assert.doesNotMatch(page, /<dialog|window\.alert|window\.confirm|\brequired=/i);

  // Tap targets meet the 44px minimum; motion and focus stay accessible.
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /focus-visible/);
});

test("keeps the usability standard document alive", async () => {
  const standard = await readFile(new URL("docs/ADHD-USABILITY-STANDARD.md", root), "utf8");
  assert.match(standard, /Capture Gate/i);
  assert.match(standard, /Five-Minute Local Workspace Scenario/i);
  assert.match(standard, /No shame language/i);
});
