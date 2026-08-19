# Work ↔ Dromond Contract

Version 0.5 — 2026-08-15 — draft for review. (0.5: §3 gains verb 5 — propose
follow-on work; Work enforces it — an agent-created task must be the child of
a delegated goal, never top-level. 0.4: the execution side is named
**Dromond**; this file called it Orchestra. Same party, same verbs, same
schema — only the name moved. 0.3: §3 verb 2 gains the checklist rule — no
task leaves an agent's hands with a criterion unanswered. 0.2: §2 delegation
signal is the `delegated` boolean, replacing the `agents` name list.)

Work is the system of record. Dromond is the execution engine. Dromond
consumes Work items and writes results back. The only coupling between the two
projects is this contract. Change this file first; change code second.

**Boundary test:** if it must survive the run, it belongs in Work. If it dies
with the run, it stays in Dromond.

## 1. Ownership

| Capability | Home | Rule |
|---|---|---|
| Projects, captures, ideas, notes, decisions | Work | Human-first. Agents are clients. |
| Issues and comment threads | Work | Generic threads. Dromond is one more commenter. |
| Tasks and board states | Work | Human owns `completed`. |
| Runs, dispatch, sessions, worktrees | Dromond | Never surfaced in Work UI. |
| Rosters, profiles, teams, inboxes | Dromond | Ephemeral coordination. |
| Findings feed | Dromond | Durable findings get promoted to Work issues (§3, verb 4). |
| Briefings, playbooks, orchestration skills | Dromond | Execution doctrine, not record. |
| Result artifacts | Work | Runs write final artifacts back. |
| Run logs and transcripts | Dromond | Emitted in the shared record format (§5). |

## 2. Interface and item schema

- Dromond talks to Work only through its sanctioned agent surface: the
  `/api/agent/*` HTTP routes carrying an `X-Work-Agent` identity, or the
  `work` CLI, which carries the same identity and exposes its own capability
  catalog (`work agent operations`, `work agent instructions <op>`). A program
  client uses HTTP; an agent inside a harness uses the CLI. Neither ever writes
  Work's files directly. (Amended 2026-08-13: harness agents previously had to
  use MCP. Work still ships an MCP server for clients that want it.)
- The item vocabulary is Work's: captures, notes, issues, decisions, tasks
  (`issue_*`/`note_*` record IDs, `W-####` task IDs; ideas merged into notes
  2026-08-11). The enforced schemas are the operation `inputSchema`s served by
  Work's capability catalog (`/api/agent/operations`). This contract adds no
  parallel schema.
- Delegation signal: the item's `delegated` boolean (tasks and issues both
  carry it; it replaced the earlier `agents` name list, which is history and
  never reads as delegation — treating a legacy `agents` list as
  `delegated: true` once offered 96 finished records to the runner). A human ticks it to hand the item to
  automation; Work rejects the flag from any agent identity. That is the only
  way an item enters Dromond's queue. Dromond never self-selects
  unassigned work.

## 3. Writeback: the five verbs

Dromond may do exactly five things inside Work, nothing else:

1. **Comment** on an item's thread, attributed as the run
   (`dromond/brisk_otter`), never as the human.
2. **Transition** an item using Work's existing vocabulary — tasks:
   `ready → in_progress → review` or `→ blocked`; issues:
   `queued → in_progress → closed` (with a resolution summary) or
   `→ needs_human`. Dromond never sets `done` on tasks; the human closes
   those. Issues are the exception: a run may close its claimed issue with
   a summary, and the human can always reopen. A task carries a third verb
   for this: **check**, which ticks, unticks, or declines one requirement or
   acceptance criterion. Work refuses `review` and `blocked` alike while any
   criterion is neither ticked nor declined-with-a-reason (2026-08-14) —
   handing work back means saying what was met and why the rest was not.
   Declining is always available; only silence is refused.
3. **Attach** a result artifact (note or file) and link it from the closing
   comment.
4. **File** a new issue for a discovered problem, attributed to its run
   identity, with `delegated: false` — the human decides whether it
   becomes work.
5. **Propose follow-on work**: create a task that is always parented to a
   delegated goal item, always `delegated: false`, never top-level,
   attributed to the run.

Forbidden: editing human-authored text, renaming or deleting projects,
touching unassigned items, any state not listed above. (Creating a project is
allowed for a user-driven assistant acting on a direct request; Dromond
runs never create projects.)

## 4. The intervention loop

Work is the async inbox between human and agents. No live messaging window is
required in either direction.

1. Human files an item or comments on a thread at any time (desktop or iOS).
2. The Dromond **sweeper** (cron or loop, interval ~1–5 min) polls Work
   for: (a) newly `delegated` ready items, (b) new human comments on
   in-flight items.
3. New item → sweeper dispatches a run. New comment on in-flight work →
   sweeper delivers it to the owning run as an interrupt/reply.
4. A run that needs the human posts a comment and transitions the item to
   `blocked` (tasks) or `needs_human` (issues). Work surfaces those, plus
   open decisions, as one **needs-you queue** — the single place to check in.
5. Human answers in the thread whenever; the sweeper unblocks the run on the
   next pass. Repeat until the run transitions the item to `review` (tasks)
   or `closed` with a resolution summary (issues).

## 5. Shared record format

Both projects emit durable records as **Markdown with Work's single-line,
JSON-valued frontmatter** (the docs/ARTIFACT-SCHEMA.md format — deliberately
not full YAML). Records may be rewritten atomically, but history arrays
(messages, state history, progress logs) are append-only. Field names follow
Work's existing schema; the contract adds one optional key: `refs`, a list of
related item ids. Minimum shared fields:

```
id: "run_20260811_brisk_otter"          # or Work record/task id
project_path: "my-project"              # workspace-relative, null for root
refs: ["issue_auth_timeout"]            # related item ids, may be empty
created_at: "2026-08-11T14:00:00Z"      # add `ended_at` for runs
```

Body is freeform (brief, result summary, decision text). No other structure
is required. This is the entire knowledge-layer commitment for now: a future
indexer reads these files; nothing else is built until this contract is
stable.

## 6. Non-goals

- No merge of the two projects.
- Work never learns about backends, models, harnesses, or rosters.
- Work embeds no model client. AI writing assistance reaches Work only as an
  MCP client (an agent editing fields on request). Existing built-in AI-assist
  features are removed in the Work cleanup track.
- Dromond never stores intent or renders record-keeping UI.
- No cross-boundary file writes in either direction.
- One Work service and one Dromond service per machine, each with a local
  registry of project roots. No cross-instance federation or proxying in
  either project; reach a remote machine over SSH or its own Tailscale-bound
  instance. Work's existing proxy is removed in the Work cleanup track.
