import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("builds a local root-scoped interface instead of a hosted demo", async () => {
  const [html, page, packageSource] = await Promise.all([
    readFile(new URL("dist/index.html", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(html, /<title>Work · One root at a time<\/title>/i);
  assert.match(page, /\/api\/workspace/);
  assert.match(page, /scopePath/);
  assert.match(page, /projectPath: selectedProject\?\.path \?\? null/);
  assert.match(page, /Project names in the thought never reroute it/);
  assert.doesNotMatch(page, /inferProject|hard-coded|ReKit Factory/i);

  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.bin.work, "./bin/work.mjs");
  assert.equal(packageJson.scripts.dev, "vite");
  assert.equal(packageJson.dependencies.next, undefined);
  await assert.rejects(access(new URL(".openai/hosting.json", root)));
});

test("makes captures immediate, durable, and visibly undoable", async () => {
  const [page, css, standard] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("docs/ADHD-USABILITY-STANDARD.md", root), "utf8"),
  ]);

  assert.match(page, /event\.key === "\/"/);
  assert.match(page, /<textarea/);
  assert.match(page, /event\.shiftKey/);
  assert.match(page, /Shift<\/kbd> \+ <kbd>Enter<\/kbd> new line/);
  assert.match(page, /const isMultiline = text\.includes\("\\n"\)/);
  assert.match(page, /role="status"/);
  assert.match(page, /Saved: “\{captureReceipt\.capture\.text\}”/);
  assert.match(page, /Available to agents in this root/);
  assert.match(page, /function openHomeSection/);
  assert.match(page, /setView\("home"\)/);
  assert.match(page, /pendingHomeSection/);
  assert.match(page, /Project inbox:/);
  assert.match(page, /Root inbox:/);
  assert.match(page, /Move to/);
  assert.match(page, /Project inbox ·/);
  assert.match(page, /method: "PATCH"/);
  assert.match(page, /Undo/);
  assert.match(page, /Not saved/);
  assert.match(page, /DELETE/);
  assert.doesNotMatch(page, /localStorage\.setItem\(storageKeys\.captures/);
  assert.match(page, /project\.aliasPaths \?\? \[\]/);
  assert.match(page, /Restart Work/);
  assert.match(page, /Confirm restart/);
  assert.match(page, /\/api\/service\/restart/);
  assert.match(page, /"x-work-restart": "confirm"/);
  assert.match(page, /health\.service\.instanceId !== accepted\.serviceInstanceId/);
  assert.match(page, /Project pulse/);
  assert.match(page, /Current work/);
  assert.match(page, /Latest progress/);
  assert.match(page, /\.slice\(0, 3\)/);
  assert.doesNotMatch(page, /Local files|local-state/);
  assert.doesNotMatch(css, /\.local-state/);
  assert.match(css, /\.pulse-grid/);
  assert.match(css, /\.home-support-grid/);
  assert.match(css, /-webkit-line-clamp:\s*4/);
  assert.doesNotMatch(page, /Last meaningful update/);
  assert.doesNotMatch(css, /\.focus-facts/);
  assert.doesNotMatch(page, /<dialog|window\.alert|window\.confirm|\brequired=/i);

  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /\.capture-list li strong[^}]*white-space:\s*pre-wrap/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /focus-visible/);
  assert.doesNotMatch(css, /\.remember-button\s*\{[^}]*font-size:\s*0/s);

  assert.match(standard, /Capture Gate/i);
  assert.match(standard, /filesystem root/i);
  assert.match(standard, /Five-Minute Local Workspace Scenario/i);
  assert.match(standard, /No shame language/i);
});

test("provides durable selectable plain-text notes without turning capture into a form", async () => {
  const [page, css, store, server, standard] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("lib/local-workspace.mjs", root), "utf8"),
    readFile(new URL("server/local-api.mjs", root), "utf8"),
    readFile(new URL("docs/ADHD-USABILITY-STANDARD.md", root), "utf8"),
  ]);

  assert.match(page, /type AppView = "home" \| "board" \| "notes" \| "activity"/);
  assert.match(page, /function NotesView/);
  assert.match(page, /role="listbox"/);
  assert.match(page, /aria-label="Note title"/);
  assert.match(page, /aria-label="Note text"/);
  assert.match(page, /Plain-text working notes/);
  assert.match(page, /Delete this note\?/);
  assert.match(page, /Save now/);
  assert.match(page, /setTimeout\(\(\) =>/);
  assert.match(page, /\/api\/notes/);
  assert.match(css, /\.notes-workspace[^}]*grid-template-columns:\s*300px minmax\(0, 1fr\)/);
  assert.match(css, /\.note-body-field textarea/);
  assert.match(store, /notesPath/);
  assert.match(store, /export async function createNote/);
  assert.match(store, /export async function updateNote/);
  assert.match(store, /export async function deleteNote/);
  assert.match(server, /url\.pathname === "\/api\/notes"/);
  assert.match(standard, /plain-text notes autosave/i);
});

test("does not replace an active note draft with an autosave response", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  const notesView = page.slice(page.indexOf("function NotesView"), page.indexOf("function statusLabel"));

  assert.match(notesView, /await onUpdate\(selectedNote\.id/);
  assert.match(notesView, /revisionRef\.current === revision/);
  assert.doesNotMatch(notesView, /setDraftTitle\(updated\.title\)/);
  assert.doesNotMatch(notesView, /setDraftText\(updated\.text\)/);
});

test("requires an explicit recorded choice for every human decision", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  assert.match(page, /Assign to a project/);
  assert.match(page, /Keep unassigned/);
  assert.match(page, /Decide later/);
  assert.match(page, /Cancel this item/);
  assert.match(page, /Confirm decision/);
  assert.match(page, /Close without changes/);
  assert.match(page, /action: "reopen"/);
  assert.match(page, /disabled=\{!canConfirm/);
  assert.doesNotMatch(page, /resolveAttention|resolvedAttention/);
});

test("ships a scoped Kanban, complete cards, lifecycle history, and retained terminal work", async () => {
  const [page, css, store] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("lib/local-workspace.mjs", root), "utf8"),
  ]);

  assert.match(page, /function KanbanBoard/);
  assert.match(page, /function TaskDetailPanel/);
  assert.match(page, /function ActivityView/);
  assert.match(page, /Backlog/);
  assert.match(page, /In flight/);
  assert.match(page, /Completed/);
  assert.match(page, /cancelled/);
  assert.match(page, /archived/);
  assert.match(page, /Human owner/);
  assert.match(page, /Agents or teams/);
  assert.match(page, /Depends on task IDs/);
  assert.match(page, /Requirements/);
  assert.match(page, /Acceptance criteria/);
  assert.match(page, /Completion summary/);
  assert.match(page, /Progress log/);
  assert.match(page, /draggable/);
  assert.match(page, /\/api\/tasks/);
  assert.match(page, /\/checklist/);
  assert.match(page, /\/log/);
  assert.match(page, /task\|todo/);

  assert.match(css, /\.kanban-grid/);
  assert.match(css, /\.board-view\s*\{[^}]*width:\s*calc\(100vw - 365px\)/);
  assert.match(css, /@container\s*\(max-width:\s*210px\)/);
  assert.match(page, /Select a card for full details/);
  assert.match(page, /title=\{hoverSummary\}/);
  assert.match(page, /Logical projects are listed once/);
  assert.match(page, /linked worktree.*grouped/i);
  assert.match(css, /\.task-panel/);
  assert.match(css, /\.activity-list/);

  for (const field of ["project_path", "task_type", "assignee", "agents", "priority", "tags", "depends_on", "blocked_by", "parent_id", "created_at", "updated_at", "started_at", "completed_at", "cancelled_at"]) {
    assert.ok(store.includes(field), `task store should persist ${field}`);
  }
  assert.match(store, /appendProgress/);
  assert.match(store, /unfinished dependencies/);
});
