# Agent Capability Contract

Work exposes a small, versioned bootstrap so a fresh CLI agent can discover how
to create and update artifacts without loading the complete Markdown contract
into context. The installed npm package is the source of truth; no instruction
manual is copied into individual `.work/` directories.

## Bootstrap from any directory

The discovery commands do not need a workspace or running service and never
initialize the current directory:

```bash
work agent
work agent context
work projects --json
work agent operations
work agent instructions tasks.create
```

The default format is concise Markdown; `--json` returns a machine-readable
response. Inside a workspace, `work agent` appends a read-only context block
with the workspace root, invocation scope, exact marked project, and default
`--project` routing; `work agent context` returns only that block. An agent
verifies this context, lists projects for exact paths, then loads only the
operation guide relevant to the request. The operation index intentionally
omits input schemas and examples to keep discovery inexpensive.

## Discover through the service

The loopback service renders the same catalog:

| Route | Purpose |
| --- | --- |
| `GET /api/agent` | Versioned bootstrap, links, and universal safety rules |
| `GET /api/agent/operations` | Compact operation index |
| `GET /api/agent/operations/{operation}` | One task-scoped operation guide |
| `GET /api/openapi.json` | OpenAPI 3.1 description of canonical API operations |

Call `GET /api/workspaces`, select the exact workspace ID, and send it as
`X-Work-Workspace` on every workspace-scoped request; responses echo the
resolved ID in the same header. The catalog declares `protocolVersion` and
`serviceVersion`, so instructions update atomically with the installed Work
version.

## Safety and authority

Capability discovery is read-only. Instructions explain how to perform an
operation but never authorize it. In particular:

- Do not infer a project assignment from prose. Use `work agent context` and
  `work projects` (or `projects.list`) for exact paths; pass `--unassigned` or
  a null project only when workspace-level work is intentional.
- Notes are reference material; a note never authorizes implementation.
- Filing an issue authorizes investigation and replies only. Dedicated agent
  issue routes require `X-Work-Agent`; an agent may note another occurrence on
  a queued, unclaimed issue without claiming it, or may claim, reply, request a
  human response, or mark an issue resolved with a summary.
- Agents cannot close, delete, archive, lock, or prevent replies to an issue.
  Only a human may close it, and a human may always reopen it.
- Agent note mutations use the dedicated `/api/agent/notes` routes and require
  `X-Work-Agent`. The service stamps that name into the note and refuses agent
  changes to human notes or notes owned by another agent.
- Creating executable work, resolving a decision, or deleting an artifact
  requires the user's authority.
- Prefer CLI or API mutations over direct Markdown writes so Work applies
  validation, physical relocation, dependency gates, and lifecycle history.
  The filesystem serialization remains documented in
  [`ARTIFACT-SCHEMA.md`](ARTIFACT-SCHEMA.md) for offline automations.

## Portable skill

`skills/slash-work/SKILL.md` is a vendor-neutral skill for the stable bootstrap
workflow. It delegates changing operation schemas to the installed `work agent`
catalog and progressively discloses service routing, artifact semantics, and
direct-filesystem fallback rules.
