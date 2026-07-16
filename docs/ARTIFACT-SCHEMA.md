# Work Artifact Markdown Contract

This is the authoring contract for automations that create or update Work's
filesystem artifacts. Validate the logical artifact against
[`schemas/work-artifact.schema.json`](../schemas/work-artifact.schema.json),
then serialize it using the rules and templates below.

The schema covers five Markdown artifact types: `capture`, `note`, `idea`,
`decision`, and `task`. The workspace and project marker files are JSON, not
Markdown, and are outside this schema.

## Storage and ownership

| Artifact | Unassigned location | Project-owned location | Filename |
| --- | --- | --- | --- |
| Capture | `.work/captures/` | `<project>/.work/captures/` | `<capture id>.md` |
| Note | `.work/notes/` | `<project>/.work/notes/` | `<note id>.md` |
| Idea | `.work/ideas/` | `<project>/.work/ideas/` | `<idea id>.md` |
| Decision | `.work/decisions/` | `<project>/.work/decisions/` | `<decision id>.md` |
| Task | `.work/tasks/` | `<project>/.work/tasks/` | `<task id>.md` |

`projectPath: null` means the artifact is owned by the workspace root. A
non-null project path must exactly match a discovered, root-relative project
path. Store project-owned records inside that project's `.work/` directory;
do not merely set the metadata while leaving the file at the root.

IDs and filenames must agree. Capture, note, idea, and decision IDs use these
forms:

```text
capture_<8-to-81 lowercase letters, digits, underscores, or hyphens>
note_<8-to-81 lowercase letters, digits, underscores, or hyphens>
idea_<8-to-81 lowercase letters, digits, underscores, or hyphens>
decision_<8-to-81 lowercase letters, digits, underscores, or hyphens>
```

Task IDs use `W-` followed by 4–10 digits, such as `W-0001`. Before allocating
a task ID, scan every root and project task store and choose one greater than
the highest existing numeric suffix. Never reuse an ID. Duplicate IDs across
stores are an error.

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
set `createdAt`/`created_at` and `updatedAt`/`updated_at` to the same instant.
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
createdAt: "2026-07-13T14:30:00.000Z"
updatedAt: "2026-07-13T14:30:00.000Z"
---

Should the release include the migration?
```

## Note

A note is longer reference material. Its body is plain text: do not require or
inject headings. An empty body is valid.

`agentIntent` is semantically important:

- `reference_only`: context, not an instruction or authorization to act.
- `review_requested`: asks an agent to review promptly, but still does not
  authorize execution.

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
agentIntent: "reference_only"
createdBy: {"kind":"human","name":null}
createdAt: "2026-07-13T14:30:00.000Z"
updatedAt: "2026-07-13T14:30:00.000Z"
---

The migration must remain reversible.
Keep this note as context for release work.
```

## Idea

An idea is a possibility worth evaluating before anyone decides or authorizes
work. It sits between a raw capture and a decision or task. Reading, editing,
or evaluating an idea never grants permission to implement it.

Statuses are `open`, `exploring`, `deferred`, `proposed`, `adopted`, and
`declined`. The UI labels `deferred` as **Not now** and `declined` as
**Closed**. Moving to either of those states requires a written reason. Every
state transition appends `{from,to,reason,at}` to `history`; never discard prior
reasons. `revisitAt` is optional and is especially useful for deferred ideas.

`agentIntent` is either:

- `consideration_only`: preserve this possibility; it is not a request.
- `evaluation_requested`: assess feasibility, value, unknowns, risks, and
  possible approaches, but do not implement anything.

```markdown
---
id: "idea_mabc1234_ab12cd34ef56"
type: "idea"
title: "Federate remote Work instances"
status: "exploring"
scopePath: "."
projectPath: null
tags: ["remote","architecture"]
source: null
revisitAt: null
agentIntent: "evaluation_requested"
history: [{"from":"open","to":"exploring","reason":"Evaluation requested.","at":"2026-07-14T14:30:00.000Z"}]
createdAt: "2026-07-14T14:25:00.000Z"
updatedAt: "2026-07-14T14:30:00.000Z"
---

## Opportunity
See project trees from several Work servers in one place.

## Why It Might Matter
Reduce context switching across machines.

## Hypothesis
Read-only federation may provide most of the value without distributed writes.

## Unknowns
Authentication, offline behavior, and ownership boundaries.

## Potential Shape
Store approved remote endpoints and show each server as a separate boundary.

## Evidence

## Risks and Constraints
Remote access changes Work's current loopback-only security model.

## Next Evaluation
Assess whether read-only discovery is useful before designing synchronization.

## Outcome
```

Emit all nine canonical sections in that order, even when empty. Preserve
unrecognized metadata and extra sections on update. An adopted idea may lead to
a decision, epic, or tasks, but that promotion must be an explicit separate
action.

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

A task is a full Kanban work item. Unlike the other artifacts, it has no
top-level `type` discriminator: `task_type` is the work classification and the
`W-...` ID plus directory identify the record as a task.

The default active statuses are `backlog`, `ready`, `in_progress`, `blocked`,
`review`, and `done`; `cancelled` and `archived` are reserved terminal states.
An automation must read `.work/workspace.json` and use its configured
`statuses` rather than assuming only the defaults.

`task_type` is one of `task`, `bug`, `feature`, `research`, `admin`, `epic`, or
`idea`. `priority` is one of `critical`, `high`, `medium`, `low`, or `none`.
Task relationships contain valid task IDs. A task cannot become `done` while a
`depends_on` ID is missing or not itself `done`. A task cannot enter `review`
while any requirement or acceptance criterion is unchecked; this invariant is
enforced by the shared workspace API rather than by harness-specific hooks.

```markdown
---
id: "W-0001"
title: "Build the operational board"
status: "in_progress"
project_path: "software/rekit"
task_type: "feature"
assignee: "human-owner"
agents: ["codex-team","review-team"]
priority: "high"
tags: ["kanban","release"]
depends_on: []
blocked_by: []
blocked_reason: null
parent_id: null
due_at: null
estimate: "3 points"
source: null
created_at: "2026-07-13T14:30:00.000Z"
updated_at: "2026-07-13T14:35:00.000Z"
started_at: "2026-07-13T14:35:00.000Z"
completed_at: null
cancelled_at: null
---

## Goal
What this item accomplishes.

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

Emit all seven canonical `##` sections in that order, even when empty. Checklist
lines must be exactly `- [ ] text` or `- [x] text`. Progress lines must be
exactly `- <ISO timestamp> — <message>` using an em dash surrounded by spaces.
Append a progress entry when creating, editing, moving, checking or reopening a
checklist item, or recording manual progress. Do not silently rewrite prior log
entries.

Set `started_at` the first time a task enters `in_progress`. Set `completed_at`
when it enters `done`, and clear it if it leaves `done`. Set `cancelled_at` when
it enters `cancelled`, and clear it if it leaves `cancelled`. Preserve
unrecognized metadata and extra `##` sections when updating an existing task.

## Automation checklist

Before writing an artifact:

1. Locate the nearest ancestor `.work/workspace.json`; never cross that root.
2. Discover explicit projects and use an exact canonical project path, or keep
   the record unassigned. Never infer ownership from prose.
3. Validate the logical object with `schemas/work-artifact.schema.json`.
4. Allocate a globally unique ID and make the filename match it.
5. Serialize header values as compact JSON and the body with the exact grammar
   above.
6. Put the file in the physical store implied by `projectPath`/`project_path`.
7. Preserve unknown fields and content on update, advance the update timestamp,
   and append required history.
8. Write atomically, then reread and validate the resulting file.

If the local Work API or `work` CLI is available, prefer it for mutations. It
implements these validation, relocation, dependency, and history rules and
reduces the chance of creating a record that is syntactically readable but
semantically inconsistent.
