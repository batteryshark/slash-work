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
  assert.match(page, /\/api\/workspaces\/pick/);
  assert.match(page, /Choose folder…/);
  assert.match(page, /created automatically/);
  assert.match(page, /Remove from list\? Files stay untouched/);
  assert.match(page, /"x-work-unregister": "confirm"/);
  assert.match(page, /scopePath/);
  assert.match(page, /projectPath: selectedProject\?\.path \?\? null/);
  assert.match(page, /Project names in the thought never reroute it/);
  assert.doesNotMatch(page, /inferProject|hard-coded|ReKit Factory/i);

  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.bin.work, "bin/work.mjs");
  assert.equal(packageJson.scripts.dev, "vite");
  assert.equal(packageJson.dependencies.next, undefined);
  await assert.rejects(access(new URL(".openai/hosting.json", root)));
});

test("makes captures immediate, durable, and visibly undoable", async () => {
  const [page, css, standard, server] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("docs/ADHD-USABILITY-STANDARD.md", root), "utf8"),
    readFile(new URL("server/local-api.mjs", root), "utf8"),
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
  assert.match(page, /health\.service\.instanceId !== serviceInstanceId/);
  assert.match(page, /Install & restart/);
  assert.match(page, /Check now/);
  assert.match(page, /Open Work system menu/);
  assert.match(page, /Work system controls/);
  assert.match(page, /Select workspace root\. Current:/);
  assert.match(page, /workspace-current-name/);
  assert.match(page, /\{data\.workspace\.name\}/);
  assert.match(css, /\.system-menu/);
  assert.match(page, /6 \* 60 \* 60 \* 1000/);
  assert.match(page, /"x-work-update": "confirm"/);
  assert.match(page, /update-available-dot/);
  assert.match(server, /\/api\/service\/update/);
  assert.match(server, /update_confirmation_required/);
  assert.match(page, /Project pulse/);
  assert.match(page, /Project purpose/);
  assert.match(page, /Why this project exists/);
  assert.match(page, /\/api\/projects\/profile/);
  assert.match(server, /updateProjectDescription/);
  assert.match(page, /Current work/);
  assert.match(page, /Latest progress/);
  assert.match(page, /\.slice\(0, 3\)/);
  assert.doesNotMatch(page, /Local files|local-state/);
  assert.doesNotMatch(page, /flow-rail|root-boundary|Your working flow/);
  assert.doesNotMatch(css, /\.local-state/);
  assert.doesNotMatch(css, /\.flow-rail|\.rail-step|\.rail-line|\.root-boundary/);
  assert.match(css, /\.main-content\s*\{[^}]*width:\s*min\(1720px, calc\(100% - 64px\)\)[^}]*margin:\s*0 auto/);
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

  assert.match(page, /type AppView = "home" \| "board" \| "ideas" \| "notes" \| "files" \| "activity"/);
  assert.match(page, /function NotesView/);
  assert.match(page, /role="listbox"/);
  assert.match(page, /aria-label="Note title"/);
  assert.match(page, /aria-label="Note text"/);
  assert.match(page, /Plain-text working notes/);
  assert.match(page, /Delete this note\?/);
  assert.match(page, /Save now/);
  assert.match(page, /Ask agent to review/);
  assert.match(page, /Clear review request/);
  assert.match(page, /should not treat it as a request or task/);
  assert.match(page, /not authorization to execute work/);
  assert.match(page, /setTimeout\(\(\) =>/);
  assert.match(page, /\/api\/notes/);
  assert.match(css, /\.notes-workspace[^}]*grid-template-columns:\s*300px minmax\(0, 1fr\)/);
  assert.match(css, /\.note-body-field textarea/);
  assert.match(store, /notesPath/);
  assert.match(store, /export async function createNote/);
  assert.match(store, /export async function updateNote/);
  assert.match(store, /export async function deleteNote/);
  assert.match(store, /agentIntent.*reference_only/);
  assert.match(store, /review_requested/);
  assert.match(server, /url\.pathname === "\/api\/notes"/);
  assert.match(standard, /plain-text notes autosave/i);
  assert.match(standard, /passive reference material/i);
});

test("keeps ideas explicitly evaluative and separate from executable work", async () => {
  const [page, css, store, server, contract] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("lib/local-workspace.mjs", root), "utf8"),
    readFile(new URL("server/local-api.mjs", root), "utf8"),
    readFile(new URL("docs/ARTIFACT-SCHEMA.md", root), "utf8"),
  ]);

  assert.match(page, /function IdeasView/);
  assert.match(page, /Ask agent to evaluate/);
  assert.match(page, /Delete idea/);
  assert.match(page, /draftPatch\(nextStatus, transitionReason\)/);
  assert.match(page, /Implementation is not authorized/);
  assert.match(page, /Remove from list\? Files stay untouched/);
  assert.match(page, /Make idea/);
  assert.match(page, /Scope as work/);
  assert.match(page, /selectedIdea\.status === "adopted"/);
  assert.match(page, /Why\? Required for this state/);
  assert.match(css, /\.ideas-workspace/);
  assert.match(css, /\.idea-intent\.evaluation-requested/);
  assert.match(store, /const IDEA_STATUSES = new Set\(\["open", "exploring", "deferred", "proposed", "adopted", "declined"\]\)/);
  assert.match(store, /reason_required/);
  assert.match(store, /evaluation_requested/);
  assert.match(store, /export async function deleteIdea/);
  assert.match(server, /url\.pathname === "\/api\/ideas"/);
  assert.match(contract, /sits between a raw capture and a decision or task/i);
  assert.match(contract, /never grants permission to implement it/i);
});

test("provides a scope-bound read-only file reference instead of an embedded editor", async () => {
  const [page, css, browser, server, contract] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("lib/file-browser.mjs", root), "utf8"),
    readFile(new URL("server/local-api.mjs", root), "utf8"),
    readFile(new URL("docs/LOCAL-WORKSPACE.md", root), "utf8"),
  ]);

  assert.match(page, /function FilesView/);
  assert.match(page, /Read-only project reference/);
  assert.match(page, /Changed only/);
  assert.match(page, /Checkout or linked worktree/);
  assert.match(page, /primary checkout/);
  assert.match(page, /linked worktree/);
  assert.match(page, /Read only/);
  assert.match(page, /Work will not edit or save source files/);
  assert.match(page, /role="tree"/);
  assert.match(page, /file\.language\.short|entry\.language\?\.short/);
  assert.match(css, /\.files-workspace[^}]*grid-template-columns:\s*330px minmax\(0, 1fr\)/);
  assert.match(css, /\.file-code-line/);
  assert.match(css, /data-language/);
  assert.match(server, /\/api\/files\/directory/);
  assert.match(server, /\/api\/files\/content/);
  assert.match(browser, /Symbolic links are not followed/);
  assert.match(browser, /validateScopePath/);
  assert.match(browser, /sensitiveReason/);
  assert.match(browser, /MAX_PREVIEW_FILE_BYTES/);
  assert.match(browser, /readOnly:\s*true/);
  assert.match(browser, /import \{ lstat, readFile, readdir, realpath, stat \} from "node:fs\/promises"/);
  assert.match(contract, /Read-only file reference/i);
  assert.match(contract, /no file-write route/i);
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
  assert.match(css, /\.board-view\s*\{[^}]*width:\s*100%/);
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

test("surfaces due dates on cards and keeps a scoped, scrollable upcoming schedule", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(page, /function UpcomingSchedule/);
  assert.match(page, /Dates across this scope/);
  assert.match(page, /Due dates and revisit dates will appear automatically/);
  assert.match(page, /task\.dueAt && !\["done", "cancelled", "archived"\]\.includes\(task\.status\)/);
  assert.match(page, /idea\.revisitAt && !\["adopted", "declined"\]\.includes\(idea\.status\)/);
  assert.match(page, /decision\.status === "deferred"/);
  assert.match(page, /className=\{`card-due/);
  assert.match(page, /scheduleTone/);
  assert.match(page, /Overdue/);
  assert.match(css, /\.upcoming-list\s*\{[^}]*max-height:\s*250px[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.card-due\.overdue/);
});
