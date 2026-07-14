# ADHD Usability Standard

This is a product acceptance standard, not a medical assessment. It turns the
needs described for Work into observable interface constraints. A feature does
not pass merely because it looks calm; it must reduce memory, initiation, and
recovery costs.

## 1. Capture Gate

- A thought can be preserved from the default screen with one focus action,
  typing, and Enter.
- `/` focuses the universal input from anywhere that is not already editable.
- `Shift+Enter` adds a line without leaving capture; Enter saves the complete
  multiline thought.
- Capturing never requires a title, project, type, priority, date, or owner.
- Ambiguity cannot block capture. The current scope supplies a safe default.
- Project assignment is optional. An ambiguous root-level thought is preserved
  in the root inbox and can be triaged later.
- The exact original wording is preserved.
- Success is confirmed in place without a modal or focus theft.
- A success confirmation is shown only after the durable local write succeeds.

**Pass condition:** `/`, type, Enter records a thought, clears the input, shows
where it went, and the thought remains after a server restart.

## 2. Resume Gate

- The initial project view exposes a ranked current-work list capped at three
  items, with one clear route to the full board.
- Recent progress is visible without opening a detail view, but a verbose log
  entry is clamped to four lines and cannot determine the dashboard's height.
- Wide screens use adjacent summary regions instead of stretching sparse cards
  or leaving an empty equal-height panel beside long text.
- Context can be revealed progressively without leaving the screen.
- Empty or quiet projects are allowed and are not framed as failures.

**Pass condition:** a returning user can identify current work and recent
progress without a click, reconstructing prior history, or reading a wall of
text.

## 3. Attention Gate

- The default `Needs you` queue contains decisions and blockers only.
- It is capped at three visible items in the default experience.
- Ordinary work, notifications, activity, and stale ideas do not enter this
  queue.
- Details stay collapsed until requested.
- A decision presents the actual alternatives, including **Decide later** when
  deferral is safe. A lone action button may not masquerade as approval.
- Expanding a decision does not resolve it. Choosing an option produces a
  visible, durable result.

**Pass condition:** no more than one primary action and three human-attention
items compete in the first project viewport.

## 4. Scope Gate

- The current zoom level is always named in a breadcrumb.
- The capture target is stated beside the universal input.
- The workspace menu opens a native folder picker; it does not require a path
  to be remembered or typed. Selecting an ordinary folder initializes it as a
  Work root and switches to it without a service restart.
- Zooming out never changes the identity of project records.
- An ambiguous portfolio capture goes to an inbox instead of opening a form.
- A running workspace never reveals a project, record, or search result outside
  its selected filesystem root.

**Pass condition:** a user can answer “what am I viewing?” and “where will this
thought go?” without remembering prior navigation.

## 5. Recovery Gate

- Captures, assignments, and resolved attention items persist as local
  human-readable files. Browser storage is not their source of truth.
- Project-owned records live in that project's `.work/` directory, so ordinary
  folder moves cannot silently separate the project from its working memory.
- Longer plain-text notes autosave independently of the quick-capture inbox and
  remain selectable and editable after a restart.
- Notes default to passive reference material. Requesting agent review is a
  separate explicit action, persists in the note metadata, and does not imply
  authorization to execute work.
- The last harmless interface scope may persist on the device.
- Removing a non-current root from the recent list requires confirmation and
  never deletes its directory or `.work/` records.
- Capture offers an immediate Undo action.
- Escape clears an unfinished command without saving it.
- Destructive or irreversible actions are not part of the quick-capture path;
  deleting a note requires a second explicit confirmation.

**Pass condition:** interruption, refresh, process restart, or accidental
capture does not force the user to rebuild context or lose work.

## 6. Progressive Disclosure Gate

- The default screen shows current work, a bounded progress summary, attention,
  and capture.
- Project context, captured history, the note editor, decision details, and
  portfolio grids are disclosed only on request.
- The read-only file tree and source preview appear only in **Files**. The tree
  is contextual to that view rather than occupying permanent workspace width.
- No full activity feed, telemetry wall, or equal-weight backlog is present.

**Pass condition:** secondary information remains available without competing
with the next action.

## 7. Motor and Keyboard Gate

- Primary interactive targets are at least 44 CSS pixels high where applicable.
- Every interaction is keyboard reachable with a visible focus indicator.
- Capture does not depend on drag-and-drop.
- Mobile layouts keep the capture path and next action usable.

## 8. Sensory Gate

- Reduced-motion preferences disable nonessential motion.
- Color is never the sole indicator of state.
- Contrast remains legible in the warm-neutral palette.
- No flashing, celebratory motion, notification badge storm, or visual timer is
  used to create urgency.

## 9. Language Gate

- No shame language: no “overdue,” “failed streak,” “you ignored,” or punitive
  red status merely because time passed.
- Staleness, when introduced, must be described factually as “last meaningfully
  updated.”
- Confirmations say what happened and what did not happen.

## 10. Operational State Gate

- The calm home is a lens over the work model, not a replacement for it.
- A scoped Kanban shows Backlog, Ready, In flight, Blocked, Review, and
  Completed without mixing another filesystem root into the board.
- Cancelled and archived work remains inspectable and never has to masquerade
  as deletion.
- Every card exposes its project, type, priority, human owner, agent teams,
  tags, dependencies, blockers, requirements, acceptance criteria, plan,
  notes, completion summary, lifecycle timestamps, and progress log.
- Status changes are available through both drag movement and an accessible
  select control.
- Completing a task with unfinished dependencies is rejected with the blocking
  task IDs named.
- Creation, edits, status changes, checklist changes, and manual progress notes
  append durable history automatically.

**Pass condition:** after an interruption, a user can determine what was added,
what is ready, what is in flight, what is blocked, what completed, and why from
the Board and Activity views without reconstructing agent conversations.

## Automated MVP Audit

These results record automated contract coverage and the live launch checks
completed for the current source tree. They do not replace the timed manual
scenario below, which remains a tagged-release check.

| Gate | Result | Evidence |
| --- | --- | --- |
| Capture | Covered | Universal `/work` input, `/` shortcut, no required metadata, durable write |
| Resume | Covered | Three-item current-work list and four-line progress summary |
| Attention | Covered | Decision-only items, explicit alternatives, deferral, durable result |
| Scope | Covered | Clickable breadcrumb, explicit capture target, filesystem-root boundary |
| Recovery | Covered | File-backed persistence, process restart, note autosave and confirmation, Escape cancel, capture Undo |
| Disclosure | Covered | Context, captures, notes, files, details, and portfolio are opt-in |
| Motor/keyboard | Covered | 44px targets, focus-visible styles, keyboard capture |
| Sensory | Covered | Reduced motion and restrained non-color labels |
| Language | Covered | Neutral, factual, non-punitive copy |
| Operational state | Covered | Scoped Kanban, full cards, dependency gate, terminal states, durable activity |

## Five-Minute Local Workspace Scenario

Before a tagged release, run this scenario from a clean temporary root without
coaching. It is a release blocker if it takes longer than five minutes or if
the tester needs hidden syntax after launch.

1. Create a root with two nested project repositories, mark one with an empty
   `.work/` directory and the other with a legacy `.project` marker, and place
   one unrelated unmarked repository beside them. Launch with
   `npm run work -- /path/to/root`.
2. Confirm both nested projects appear and the unrelated directory does not.
   Open the workspace menu, choose a separate ordinary folder with no `.work/`
   directory, and confirm Work initializes and switches to it. Switch back using
   the recent-root list.
3. From **All work**, press `/`, type `Do not assign the IDA lab to ReKit
   Factory yet`, and press Enter. Confirm immediately that the exact wording was
   saved to the root inbox as unassigned. Mentioning a project name, including
   in a negated sentence, must not silently assign it.
4. Refresh. Confirm the exact thought remains. Undo it, then capture it again.
5. Zoom into one project and capture a project-specific thought. Zoom out and
   back into the other project without losing either record or confusing their
   scope.
6. Open the IDA ownership item. Confirm that opening it changes nothing and that
   **Assign to a project**, **Keep unassigned**, **Decide later**, and **Cancel
   this item** are keyboard reachable. Choose **Keep unassigned** and confirm
   the recorded outcome. For another item, choose **Decide later** and confirm
   it remains available rather than being called resolved.
7. Open **Notes**, create a project note with multiple paragraphs, switch to a
   second note, and return to the first. Confirm the text autosaved, the note is
   labelled as passive reference, **Ask agent to review** is an explicit action,
   and deleting the note requires a separate confirmation.
8. Stop the server with `Ctrl-C`, launch the same root again, and explain what
   changed. Both thoughts, the note, and the recorded decision must remain.
9. Launch against a different empty root. None of the first root's projects or
   work may appear.
10. Create two dependent cards. Confirm all card fields and both checklist
   sections are visible. Attempt to complete the dependent card first and
   confirm the dependency gate names the unfinished card.
11. Move one card through In flight and Review, check a requirement, append a
    progress note, and complete it. Confirm every event appears in Activity and
    survives restart.
12. Cancel another card. Confirm it leaves the active columns but remains
    visible when **Show cancelled & archived** is enabled.
13. Open **Files** in a Git-backed project. Expand a folder, select a text file,
    and confirm language and change hints are visible. Confirm **Changed only**
    reduces the tree, secret and binary files cannot be previewed, and no edit
    or save-file control exists.

Any moment that requires remembering hidden syntax, reconstructing scope, or
completing metadata before preservation is a release blocker. So is a success
message for data that does not survive the restart.
