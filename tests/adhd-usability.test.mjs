import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships a local root-scoped interface, not a hosted demo", async () => {
  const [html, packageSource] = await Promise.all([
    readFile(new URL("dist/index.html", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(html, /<title>Work<\/title>/i);
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

  // Rarely-touched fields (due date, parent, tags, depends on) live inside the
  // shared "More details" disclosure, rendered by both the create panel and
  // the detail panel. Eye level keeps none of them.
  const moreFields = page.slice(page.indexOf("function TaskMoreFields"), page.indexOf("function CreateTaskPanel"));
  assert.match(moreFields, /task-more-fields/);
  for (const field of ["Due date", "Parent task ID", "Tags"]) assert.ok(moreFields.includes(field), `${field} sits behind the disclosure`);
  assert.equal(page.match(/<TaskMoreFields/g).length, 2);
  const detailDisclosure = page.slice(page.lastIndexOf("<TaskMoreFields"), page.indexOf("</TaskMoreFields>"));
  assert.match(detailDisclosure, /Depends on task IDs/);
  const eyeLevel = page.slice(page.indexOf("function TaskFields"), page.indexOf("function TaskMoreFields"));
  assert.doesNotMatch(eyeLevel, /Due date|Parent task ID|Tags|Depends on/);

  // Project assignment is chosen when the work item is created, not changed
  // from an existing item's detail card.
  const createPanel = page.slice(page.indexOf("function CreateTaskPanel"), page.indexOf("function TaskDetailPanel"));
  const detailPanel = page.slice(page.indexOf("function TaskDetailPanel"), page.indexOf("function TaskChecklist"));
  assert.match(createPanel, /<span>Project<\/span><select/);
  assert.doesNotMatch(detailPanel, /<span>Project<\/span><select/);
  assert.doesNotMatch(detailPanel, /projectPath: fields\.projectPath/);

  // Open questions surface on the task card only while an unresolved linked
  // decision exists; a card with none renders no open-questions markup.
  assert.match(page, /selectedTaskQuestions\.length > 0 \? \(/);
  assert.match(page, /Open questions/);
  assert.match(page, /task-open-questions/);
  assert.match(page, /card-questions/);

  // The rail replaced the dropdown pickers: the project tree is always visible,
  // groups collapse by first path segment and remember what was expanded, and
  // the roots live in one dropdown at the top of the same rail.
  assert.match(page, /function groupByFirstSegment/);
  assert.match(page, /wb-grouphead/);
  assert.match(page, /aria-expanded=\{expandedGroups\.includes\(group\.key\)\}/);
  assert.match(page, /work\.projectGroups\./);
  assert.match(page, /work\.recentProjects\./);
  assert.match(css, /\.wb-grouphead \{/);
  assert.match(page, /wb-rootbtn/);
  // Scoped tabs gate what needs a project: issues and files ask for one.
  assert.match(page, /Pick a project — issues live on a project/);
  assert.match(page, /Pick a project to browse its files/);

  // Two windows can sit on two projects: where you are looking is per-window,
  // what you looked at last is shared so a new window opens where you left off.
  assert.match(page, /function rememberedValue/);
  // A window keeps the workspace it is on: the poll must not re-derive it and
  // fall back to the server's boot root, which silently moved the window.
  assert.match(page, /workspaceIdRef\.current \?\? rememberedValue/);
  assert.match(page, /activeWorkspaceId \?\? rememberedValue/);
  assert.match(page, /sessionStorage\.getItem\(key\)/);
  assert.match(page, /sessionStorage\.setItem\(key, value\);\n  localStorage\.setItem\(key, value\)/);
  assert.match(css, /\.project-menu-roots button\.selected \{/);

  // Tags live in exactly three places: edited in the project header strip,
  // browsed in the Projects overview with a tag filter, and shown as hue
  // chips. The rail stays tag-free so it never grows taller than its tree.
  assert.match(page, /function WbProjectsOverview/);
  assert.match(page, /wb-tagfilter/);
  assert.match(page, /projectTagFilter/);
  // Chips carry their colour as a hue custom property, never as text colour
  // alone, and the tag name always shows.
  assert.match(css, /\.tag-chip \{/);
  assert.match(css, /--tag-h/);
  assert.match(page, /tagHueAngle\(tag\)/);
  // Editing lives in the project header strip, beside the project name.
  assert.match(page, /function ProjectTagEditor/);
  assert.match(page, /<ProjectTagEditor/);
  assert.match(page, /project-tag-suggestions/);
  // Tags stay a project attribute: tasks never inherit them.
  assert.doesNotMatch(page, /project\.tags.*task\.tags|task\.tags.*project\.tags/);

  // Deleting a project requires an inline second confirmation.
  assert.match(page, /project-delete-panel/);
  assert.match(page, /danger-zone-button/);

  // Rapid task entry: one quick-add row at the foot of the list view and one
  // under every board column, Enter creating the task without leaving the
  // keyboard, and Tab filing the next task under the row above.
  assert.match(page, /function QuickAddRow/);
  assert.match(page, /className="quick-add-input"/);
  const listView = page.slice(page.indexOf("function TaskListView"), page.indexOf("function KanbanBoard"));
  const board = page.slice(page.indexOf("function KanbanBoard"), page.indexOf("function ActivityView"));
  assert.match(listView, /<QuickAddRow status="backlog"/, "the list view files quick adds into backlog");
  // Quick-add belongs to the list view. The board has "New work item"; a
  // second way to do the same thing on the same screen is just clutter.
  assert.doesNotMatch(board, /QuickAddRow/, "the board creates through the full form");
  const quickAdd = page.slice(page.indexOf("function QuickAddRow"), page.indexOf("function TaskListView"));
  assert.match(quickAdd, /event\.key === "Enter"/);
  assert.match(quickAdd, /event\.key === "Tab" && !event\.shiftKey/);
  assert.match(quickAdd, /event\.key === "Tab" && event\.shiftKey/);
  assert.match(quickAdd, /splitTaskTitles\(value\)/, "a pasted list becomes one task per line");
  // The pending indent is visible and announced before the task exists.
  assert.match(quickAdd, /Subtask of \$\{parentId\}/);
  assert.match(quickAdd, /aria-live="polite"/);
  assert.match(css, /\.quick-add\.indented \.quick-add-input \{/);
  // Touch has no Tab key, so the same two moves get buttons.
  assert.match(quickAdd, /aria-label="Indent: file the next task under the one above"/);
  assert.match(quickAdd, /aria-label="Outdent: file the next task on its own"/);
  assert.match(css, /\.quick-add-indent-controls button \{[^}]*min-height: 44px/);
  // Subtasks render nested under their parent in the list view.
  assert.match(listView, /task-list-children/);
  assert.match(css, /\.task-list-children \{/);
  // The dock's task shortcut is named where the dock explains itself.
  assert.match(page, /task-prefix-hint/);
  assert.match(page, /Start a line <kbd>task:<\/kbd>/);

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
