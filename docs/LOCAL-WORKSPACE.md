# Local Workspace Contract

Work is a local control surface over one selected filesystem root. People and
agents read and write the same files without a hosted service.

## One request, one root

```bash
npm run work -- /path/to/root
```

If no path is supplied, resolution first searches upward from the current
directory for the nearest `.work/workspace.json`. If none exists, Work opens
the most recently registered root; only when the registry is empty does it
initialize the current directory. An explicit path uses the same
nearest-ancestor rule and registers the result.
`--init` deliberately creates a new workspace at the exact target instead. The
server binds only to a loopback address, prints the local URL it selected, and
opens it in the default browser unless `--no-open` is supplied.

One process may expose several pre-registered canonical roots to its web
picker, but every API request resolves to exactly one of them. Every discovered
project, read, write, search result, and scope identifier must resolve inside
the selected root.
Paths containing `..`, absolute paths supplied through the API, and symbolic
links that escape the root are rejected rather than normalized into another
workspace.

The registry at `~/.work/roots.json` is an allowlist, not a remotely addressable
filesystem browser. A person can add a root with `work register` or by pressing
**Choose folder…** in the local UI. That explicit action asks the loopback Work
process to open the operating system's native folder picker; the web client
cannot supply an arbitrary path. A newly selected directory is initialized as
its own top-level Work root and registered. A non-current root can be removed
from the recent list after inline confirmation; removal changes only the
registry and never deletes its directory or `.work/` data. The client sends the
selected root's ID on every request, so switching one browser does not change
the workspace selected in another browser and records from multiple roots are
never merged into one response.

## Recursive project discovery

Work scans downward from the selected root and can show several nested projects
at once. Discovery follows these rules:

1. A directory is a project only when it contains an explicit marker. An empty
   `.work/` directory opts it in; Work then creates the canonical
   `.work/project.json`. An existing empty `.project` file or `.project/`
   directory is also accepted and receives the same project-local store during
   initialization. Git repositories, package manifests, Makefiles, and other
   tool metadata do not opt a directory in automatically.
2. Discovery is recursive; projects may be deeper than one directory below the
   workspace root.
3. Infrastructure and generated directories such as `.git`, `.project`, `.work`,
   `node_modules`, build outputs, and cache directories are never traversed as
   candidate projects.
4. A project marker carries a stable ID while its current scope path is derived
   from the directory's physical location. Two projects with the same final
   directory name remain distinct, and moving one updates its visible path
   without orphaning its records.
5. Linked Git worktrees are aliases of one logical project. When several
   discovered paths share a Git common directory, including when that shared
   directory and the primary checkout live outside the selected root, Work
   lists the repository once and shows how many linked worktrees were grouped.
   It uses the primary worktree as the canonical record store when it is inside
   the root; otherwise it uses one stable linked path. Operations launched from
   any alias resolve back to that store, and tracked `.work/` copies in linked
   worktrees are never treated as competing live stores.
6. Refreshing discovery does not delete captures or rewrite project history.
7. A descendant containing its own `.work/workspace.json` is a nested root and
   stops parent discovery at that boundary.

Discovery is inventory, not authorization. Finding a repository does not let
Work run its code, invoke an agent, change Git state, or publish anything.

## Read-only file reference

The **Files** view is a bounded observability surface, not an editor. It lists
one directory at a time under the currently selected workspace scope and reads
text only after the user selects a file. The API exposes `GET` routes for
directory listings and text previews; it has no file-write route.

The viewer never follows symbolic links and rejects absolute paths, `..`
segments, and any canonical path outside the selected scope. It omits internal,
generated, dependency, and cache directories such as `.git`, `.work`,
`node_modules`, `dist`, and `target`. Conventional environment, credential, and
key files remain visible as non-previewable entries so their existence is not
misrepresented, but their contents are never returned. Binary and oversized
files are also refused.

When the selected scope is safely inside a Git repository that is itself inside
the workspace root, Work may run read-only `git status` commands to label
modified, added, renamed, deleted, conflicted, and untracked paths. It never
stages, restores, commits, or otherwise changes Git state. Language badges are
derived from filenames and extensions; preview content is always rendered as
text rather than executable markup.

Linked worktrees remain one logical project in project navigation, task
ownership, notes, and history. Inside **Files** only, an explicit **Checkout**
selector can switch the read-only tree between the primary checkout and each
linked worktree because their source contents and Git changes may legitimately
differ.

## Durable, inspectable files

There is one storage-folder shape: `.work/`. At the selected root it contains
`workspace.json`, format metadata, Kanban column order, and records that are not
assigned to a project. Inside a project it contains `project.json` and that
project's `tasks/`, `captures/`, `ideas/`, `notes/`, and `decisions/`. For example, a
ReKit card is stored at `software/rekit/.work/tasks/W-0001.md`, not centralized
at the root. Record files use small machine-readable headers where stable
identifiers or relationships are needed. Their bodies preserve the human's
original wording; notes remain plain text.

Assignment is a physical ownership operation. Assigning or reassigning a
record atomically relocates its file to the destination `.work/`; making it
unassigned relocates it to the root `.work/`. On startup, older centralized
records with a project path are migrated the same way. Because project paths
are derived from where their `.work/project.json` currently lives, moving a
project directory carries its work and immediately changes its scope path.

The file store is the source of truth. A successful capture response means the
record has been written durably, not merely added to React state or browser
storage. Writes use a temporary sibling followed by an atomic rename so a
crash cannot leave a half-written primary record.

Important behavior:

- an unassigned thought is valid and goes to the root inbox;
- project assignment can happen later without changing the original text;
- project records travel with the project directory when it is moved;
- idea evaluation is explicitly non-executable; deferred and declined states
  retain a reason and may retain a revisit date;
- decision actions are explicit: assign, keep unassigned, approve, reject,
  defer, cancel, and reopen as appropriate to that decision;
- resolution records what was chosen and when;
- restarting reads the existing files instead of seeding example data;
- unknown fields and Markdown body content are preserved when possible;
- files remain useful with the app stopped.

## Work-item and Kanban contract

The default active lifecycle is:

`backlog → ready → in_progress → blocked → review → done`

`cancelled` and `archived` are retained terminal states. They are hidden from
the main board by default but can always be shown; cancellation never deletes
history. The configured active statuses live in `.work/workspace.json` and
define the board columns left to right.

Each card is a Markdown task with project and multi-agent fields:

```markdown
---
id: "W-0001"
title: "Build the operational board"
status: "in_progress"
project_path: "software/rekit"
task_type: "feature"
assignee: "human-owner"
agents: ["codex-team", "review-team"]
priority: "high"
tags: ["kanban", "release"]
depends_on: ["W-0000"]
blocked_by: []
blocked_reason: null
parent_id: null
due_at: null
estimate: "3 points"
source: null
created_at: "2026-07-10T20:00:00.000Z"
updated_at: "2026-07-10T21:00:00.000Z"
started_at: "2026-07-10T20:15:00.000Z"
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
- 2026-07-10T20:15:00.000Z — Moved from ready to in_progress.

## Completion Summary
What shipped, changed, or was learned.
```

Moving a card to `done` is rejected while any `depends_on` task is missing or
unfinished. Creating, editing, moving, checking requirements, and manual
progress updates append timestamped entries to `Progress Log`. Opening a card
never changes it.

The `.work/` directory may be committed for shared, versioned coordination or
ignored for private work. Work does not make that privacy choice on the user's
behalf.

## Scope semantics

Scope controls what is visible and where an unqualified capture lands:

| View | Shows | Default capture target |
| --- | --- | --- |
| All work | Every discovered project plus the root inbox | Root inbox |
| Group or directory | Descendant projects plus that group's inbox | Group inbox |
| Project | That project's work only | That project |

Zooming changes the query, not the identity or location of a record. A capture
made at the root remains visible when zoomed out even if it has not been
triaged. Assigning it to a project is an explicit later action.

Every capture stores a root-relative scope path. `.` means the root inbox. A
project destination must be the exact relative path of a project discovered in
the current root; free-text mention of a project name is never enough to assign
work silently.

## Agents use the same contract

An agent can capture, inspect, or update records through the local interface,
but it sees the same selected root and the same durable files as the human. No
harness-specific hook or telemetry integration is required.

A fresh agent should run `work agent operations` and then
`work agent instructions <operation>` to load only the relevant rules. These
commands work without a running server or workspace. The loopback service
exposes the same versioned catalog under `/api/agent`; see
[`AGENT-CAPABILITIES.md`](AGENT-CAPABILITIES.md). The catalog lives in the
installed package, not `.work/`, so instructions stay aligned with upgrades.

The minimal agent instruction is: preserve new information immediately, do not
invent missing project assignments, and use stable record identifiers when
updating an existing item.

Agents and terminal users can use the same store without launching a harness
integration:

```bash
work add "check whether the release needs a migration"
work idea "Federate remote Work instances" --detail "Explore read-only project trees across servers"
work decision "Where should the lab live?" --option "Keep unassigned" --option "Assign later"
work task "Implement the board" --project software/rekit --priority high
work move W-0001 in_progress --note "Agent team started"
work assign W-0001 codex-team
work log W-0001 "Dependency and restart tests pass"
work list
work show W-0001
```

These commands search upward for the nearest workspace. `work add` uses its
invocation directory as the folder scope, but stays unassigned unless
`--project` is given an exact discovered root-relative path; project names
mentioned inside the thought are treated only as text.

## Recovery expectations

After `Ctrl-C`, a crash, a browser refresh, or a computer restart, launching the
same root restores the same work items, captures, ideas, decisions, checklists,
and progress logs. Launching a different root
shows none of them. If `.work/` cannot be read or written, Work reports the
specific local filesystem problem and does not claim that a capture succeeded.

The timed recovery and attention test is in
[`ADHD-USABILITY-STANDARD.md`](ADHD-USABILITY-STANDARD.md#five-minute-local-workspace-scenario).
