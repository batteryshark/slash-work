# Work Artifact Markdown Contract

This is the authoring contract for automations that create or update Work's
filesystem artifacts. Serialize each artifact using the rules and templates
below; the enforced input rules for each mutation are published by
`work agent instructions <operation>` and `GET /api/agent/operations/{id}`.

This contract covers five Markdown artifact types: `capture`, `note`,
`issue`, `decision`, and `task`. The workspace and project marker files are
JSON, not Markdown, and are outside this schema. Ideas were merged into notes:
legacy records in `.work/ideas/` load as notes and are rewritten into the notes
store on first read, with idea-only metadata preserved as plain text lines in
the note body.

## Storage and ownership

| Artifact | Unassigned location | Project-owned location | Filename |
| --- | --- | --- | --- |
| Capture | `.work/captures/` | `<project>/.work/captures/` | `<capture id>.md` |
| Note | `.work/notes/` | `<project>/.work/notes/` | `<note id>.md` |
| Issue | `.work/issues/` | `<project>/.work/issues/` | `<short issue id>.md` |
| Decision | `.work/decisions/` | `<project>/.work/decisions/` | `<decision id>.md` |
| Task | `.work/tasks/` | `<project>/.work/tasks/` | `<task id>.md` |

`projectId: null` means the artifact is owned by the workspace root. A
project-owned artifact stores the immutable ID from the project's
`.work/project.json`; `projectPath` is its current discovered, root-relative
location and may change when the directory moves. Store project-owned records
inside that project's `.work/` directory; do not merely set the metadata while
leaving the file at the root. Legacy records without `projectId` are matched by
their exact `projectPath` once and upgraded.

IDs and filenames must agree. Capture, note, and decision IDs use
these forms:

```text
capture_<8-to-81 lowercase letters, digits, underscores, or hyphens>
note_<8-to-81 lowercase letters, digits, underscores, or hyphens>
decision_<8-to-81 lowercase letters, digits, underscores, or hyphens>
```

Issue IDs use `I-` and task IDs use `W-`, each followed by 4–10 digits, such
as `I-0001` and `W-0001`. Each issue also keeps its original generated
`issue_...` value in `longId` as a permanent lookup alias. Before allocating a
short ID, scan every root and project store of that artifact type and choose
one greater than the highest existing numeric suffix, honoring the workspace
`idFloor`. Never reuse an ID. Duplicate IDs across stores are an error.

## Common serialization rules

Every file is UTF-8 Markdown with LF line endings and this envelope:

```markdown
---
key: <JSON value>
---

<body>
```

The header resembles YAML but Work deliberately encodes every value as compact
JSON. Use JSON string escaping, `null`, JSON booleans, arrays, and objects. Do
not emit YAML-only syntax, multiline header values, comments, or nested YAML.
Preserve the canonical key spelling and order shown in the templates.

Use ISO 8601 UTC timestamps such as `2026-07-13T14:30:00.000Z`. On creation,
set `createdAt` and `updatedAt` to the same instant.
On mutation, preserve the creation timestamp and advance the update timestamp.
End the file with one newline.

Prefer Work's API or CLI for updates because those paths validate project
ownership, move files atomically, preserve unknown metadata and task sections,
and append lifecycle history. When writing files directly, use a temporary
sibling file followed by an atomic rename; never expose a half-written record.

## Capture

A capture is a short, low-friction thought. Its body is the capture text and
has no required Markdown headings. Preserve the writer's wording.

`kind` is exactly one of `idea`, `question`, or `update`. `scopePath` is an
existing root-relative directory (`.` means the root). If `projectPath` is not
null, both `scopePath` and the physical project store should identify that
project.

```markdown
---
id: "capture_mabc1234_ab12cd34ef56"
type: "capture"
kind: "question"
scopePath: "."
projectPath: null
projectId: null
createdAt: "2026-07-13T14:30:00.000Z"
updatedAt: "2026-07-13T14:30:00.000Z"
---

Should the release include the migration?
```

## Note

A note is longer reference material. Its body is plain text: do not require or
inject headings. An empty body is valid. A note is context, not an instruction
or authorization to act.

`createdBy` records durable provenance. Existing and UI-created notes use
`{"kind":"human","name":null}`. Agent note routes stamp
`{"kind":"agent","name":"<harness name>"}` from `X-Work-Agent`. Agents may
update or delete only notes bearing their own exact agent name; humans retain
control of every note in the UI.

```markdown
---
id: "note_mabc1234_ab12cd34ef56"
type: "note"
title: "Release context"
scopePath: "software/rekit"
projectPath: "software/rekit"
projectId: "550e8400-e29b-41d4-a716-446655440000"
createdBy: {"kind":"human","name":null}
createdAt: "2026-07-13T14:30:00.000Z"
updatedAt: "2026-07-13T14:30:00.000Z"
---

The migration must remain reversible.
Keep this note as context for release work.
```

## Issue

An issue is a durable asynchronous conversation between a human and an agent.
Its initial `body` is free-form Markdown and is the only required user input.
Preserve that exact body. `title` is a one-line navigation label derived from
the first meaningful line when the human does not provide one; title
classification must never block submission.

States are `queued`, `in_progress`, `needs_human`, `resolved`, and `closed`.
The UI labels `in_progress` as **Agent working** and `needs_human` as
**Needs you**. Filing an issue authorizes investigation and replies only, not
repository changes or other executable work.

`delegated` is a boolean, human-only exactly as on tasks: it is the only way
an issue enters an orchestrator's queue, agents cannot set it, and a legacy
non-empty `agents` list reads as `delegated: true` and is dropped on the next
write. `claimedBy` is null or an agent actor. An agent may append an attributed
observation to a queued, unclaimed issue without changing its state, claim, or
delegation. An agent may also claim a queued issue, reply,
move it to `needs_human` with a concrete question or blocker, and move it to
`resolved` only with a non-empty `resolutionSummary`. Only a human may move an
issue to `closed`. A human may always move a resolved or closed issue back to
`queued`; appending a human reply while the issue needs human input, is
resolved, or is closed performs that transition automatically. Agents cannot
delete, archive, lock, or prevent replies.

Every reply is appended to `messages` as
`{id,body,author,createdAt}`. Every state transition is appended to
`stateHistory` as
`{from,to,actor,at,reason,resolutionSummary}`. Never discard or rewrite prior
messages or transitions. Human actors have `name: null`; agent actors carry the
stable name supplied through `X-Work-Agent`.

The header is canonical. Mirror it as readable Markdown in the body: one
`## Issue` section followed by the exact initial body, then an optional
`## Replies` section whose `###` headings identify each author and timestamp.
Keep the header and rendered transcript synchronized.

````markdown
---
id: "I-0001"
longId: "issue_mabc1234_ab12cd34ef56"
type: "issue"
title: "The save indicator disappears too early"
body: "The save indicator disappears too early.\n\n```text\nExpected: Saved\nActual: blank\n```"
state: "resolved"
scopePath: "software/rekit"
projectPath: "software/rekit"
projectId: "550e8400-e29b-41d4-a716-446655440000"
delegated: true
claimedBy: {"kind":"agent","name":"codex-team"}
resolutionSummary: "The indicator now remains visible after the durable write."
messages: [{"id":"message_mabc1235_ab12cd34ef56","body":"I reproduced the race and traced it to the optimistic state reset.","author":{"kind":"agent","name":"codex-team"},"createdAt":"2026-07-14T14:35:00.000Z"}]
stateHistory: [{"from":null,"to":"queued","actor":{"kind":"human","name":null},"at":"2026-07-14T14:30:00.000Z","reason":"Issue filed.","resolutionSummary":null},{"from":"queued","to":"in_progress","actor":{"kind":"agent","name":"codex-team"},"at":"2026-07-14T14:32:00.000Z","reason":"Issue claimed.","resolutionSummary":null},{"from":"in_progress","to":"resolved","actor":{"kind":"agent","name":"codex-team"},"at":"2026-07-14T14:40:00.000Z","reason":null,"resolutionSummary":"The indicator now remains visible after the durable write."}]
createdAt: "2026-07-14T14:30:00.000Z"
updatedAt: "2026-07-14T14:40:00.000Z"
---

# The save indicator disappears too early

## Issue

The save indicator disappears too early.

```text
Expected: Saved
Actual: blank
```

## Replies

### Agent: codex-team · 2026-07-14T14:35:00.000Z

I reproduced the race and traced it to the optimistic state reset.
````

## Decision

A decision records a question, its alternatives, and explicit resolution
history. The title must be one line. Options are one-line strings, with at most
50 entries. The header's `options` array is authoritative; mirror it in the
body for people to read. `recommendedOption` is null or exactly matches one
recorded option. A recommendation is context for the human; it never preselects
or approves the option.

Statuses are `open`, `approved`, `rejected`, `deferred`, `cancelled`,
`assigned`, and `kept_unassigned`. A new decision starts `open`, with a null
resolution and empty history. Do not infer a decision from prose or resolve it
by merely opening it.

```markdown
---
id: "decision_mabc1234_ab12cd34ef56"
type: "decision"
title: "Where should the release task live?"
projectPath: null
projectId: null
options: ["Keep unassigned","Assign to software/rekit"]
recommendedOption: "Keep unassigned"
status: "open"
resolution: null
history: []
createdAt: "2026-07-13T14:30:00.000Z"
updatedAt: "2026-07-13T14:30:00.000Z"
---

# Where should the release task live?

Choose ownership before implementation begins.

## Options

- Keep unassigned
- Assign to software/rekit
```

Each action appends an event to `history`; the latest non-`reopen` event is
also `resolution`. Event shape is:

```json
{"action":"defer","choice":{"until":"2026-07-20T14:30:00.000Z"},"note":null,"at":"2026-07-13T14:35:00.000Z"}
```

Allowed actions are `approve`, `reject`, `defer`, `cancel`, `assign`,
`keep_unassigned`, and `reopen`. `assign` uses
`{"projectPath":"exact/discovered/path"}` as its choice; `defer` uses
`{"until":"<ISO timestamp>"}`. When the decision declares options, `approve`
records the exact selected option as `{"option":"the recorded option"}`. The
UI always adds an **Other** choice; it records `{"option":"Other"}` and requires
the human's written answer in `note`. A decision without options also requires
a non-empty written response in `note`.
Other choices are null. `reopen` sets
`resolution` to null but keeps the appended history event. Assignment and
keeping unassigned also move the file to the corresponding physical store.

## Task

A task is a full work item. Unlike the other artifacts, it has no top-level
`type` discriminator: the `W-...` ID plus directory identify the record as a
task.

The default active statuses are `backlog`, `ready`, `in_progress`, `blocked`,
`review`, and `done`; `cancelled` and `archived` are reserved terminal states.
An automation must read `.work/workspace.json` and use its configured
`statuses` rather than assuming only the defaults.

`delegated` is a boolean and is the CONTRACT §2 delegation signal: a human
sets it to hand the item to automation, and Work rejects it from any agent
identity. Legacy records carrying the removed `priority`, `task_type`/`type`,
`assignee`, `estimate`, or `agents` keys still load — a non-empty `agents`
list reads as `delegated: true` — and the removed keys are dropped on the
next write. Pre-0.3 records with snake_case keys (`project_path`, `due_at`, …)
load the same way; the canonical keys are the camelCase ones shown below.
Task relationships contain valid task IDs. A task cannot become `done` while a
`dependsOn` ID is missing or not itself `done`. A task cannot enter `review`
or `blocked` while any requirement or acceptance criterion is neither ticked
nor declined-with-a-reason (CONTRACT §3: handing work back means saying what
was met and why the rest was not); these invariants are enforced by the shared
workspace API rather than by harness-specific hooks, and apply to humans and
agents alike.

```markdown
---
id: "W-0001"
title: "Build the operational board"
status: "in_progress"
projectPath: "software/rekit"
projectId: "550e8400-e29b-41d4-a716-446655440000"
delegated: false
tags: ["kanban","release"]
refs: []
dependsOn: []
blockedBy: []
blockedReason: null
parentId: null
dueAt: null
source: null
createdAt: "2026-07-13T14:30:00.000Z"
updatedAt: "2026-07-13T14:35:00.000Z"
startedAt: "2026-07-13T14:35:00.000Z"
completedAt: null
cancelledAt: null
---

## Description
Background context: what this is and the situation.

## Goal
What this item accomplishes: the discrete outcome.

## Requirements
- [ ] Required behavior

## Acceptance Criteria
- [ ] Observable completion test

## Plan
Implementation or research shape.

## Notes
Supporting context.

## Progress Log
- 2026-07-13T14:30:00.000Z — Created in backlog for software/rekit.
- 2026-07-13T14:35:00.000Z — Moved from backlog to in_progress.

## Completion Summary
```

Emit all eight canonical `##` sections in that order, even when empty. A
checklist item has three states. Checklist lines must be exactly `- [ ] text`
(open), `- [x] text` (verified), or `- [~] text — reason` (declined:
verified-as-not-done, carrying the reason on the same line). The decline
separator is an em dash surrounded by spaces; the parser splits on the
rightmost occurrence, so item text containing the separator round-trips.
Declining through the API or `work check --decline` requires a non-empty
one-line reason. Progress lines must be exactly `- <ISO timestamp> — <message>`
using an em dash surrounded by spaces. Append a progress entry when creating,
editing, moving, checking, declining, or reopening a checklist item, or
recording manual progress. Do not silently rewrite prior log entries.

Set `startedAt` the first time a task enters `in_progress`. Set `completedAt`
when it enters `done`, and clear it if it leaves `done`. Set `cancelledAt` when
it enters `cancelled`, and clear it if it leaves `cancelled`. Preserve
unrecognized metadata and extra `##` sections when updating an existing task.

## Automation checklist

Before writing an artifact:

1. Locate the nearest ancestor `.work/workspace.json`; never cross that root.
2. Discover explicit projects and use an exact canonical project path, or keep
   the record unassigned. Never infer ownership from prose.
3. Check the logical object against the operation's input rules from
   `work agent instructions <operation>`.
4. Allocate a globally unique ID and make the filename match it.
5. Serialize header values as compact JSON and the body with the exact grammar
   above.
6. Persist the project's immutable `projectId` and put the file in that
   project's physical store; treat `projectPath` as its current
   location, not its identity.
7. Preserve unknown fields and content on update, advance the update timestamp,
   and append required history.
8. Write atomically, then reread and validate the resulting file.

If the local Work API or `work` CLI is available, prefer it for mutations. It
implements these validation, relocation, dependency, and history rules and
reduces the chance of creating a record that is syntactically readable but
semantically inconsistent.
