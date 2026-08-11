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
work agent instructions issues.reply
work agent schema task
```

The default instruction format is concise Markdown. Use `--json` or
`--format json` for a machine-readable response. Artifact schemas default to
JSON and accept `--format markdown` when a fenced representation is useful.

When invoked inside a workspace, plain `work agent` appends a read-only current
context block with the workspace root, invocation scope, exact marked project,
and default `--project` routing. `work agent context` returns only that block;
`--json` makes either form machine-readable. A descendant `.work` directory is
a project marker, while `.work/workspace.json` identifies the enclosing root.
Context discovery does not initialize a directory or hydrate an empty project
marker.

An agent should verify this context, list projects with `work projects` when it
needs other exact paths, then list operations and load only the operation
relevant to the request. The operation index intentionally omits input schemas,
examples, and detailed rules to keep discovery inexpensive.

## Discover through the service

The loopback service renders the same catalog:

| Route | Purpose |
| --- | --- |
| `GET /api/agent` | Versioned bootstrap, links, and universal safety rules |
| `GET /api/agent/operations` | Compact operation index |
| `GET /api/agent/operations/{operation}` | One task-scoped operation guide |
| `GET /api/agent/schemas/artifacts` | Complete Markdown artifact authoring schema |
| `GET /api/agent/schemas/artifacts/{type}` | Schema for one artifact type |
| `GET /api/openapi.json` | OpenAPI 3.1 description of canonical API operations |

One service can expose local roots plus workspace roots owned by explicitly
paired Work instances. Call
`GET /api/workspaces`, select the exact ID, and send it as
`X-Work-Workspace` on every workspace-scoped request. `defaultWorkspaceId` is
only a fallback and may not match a browser tab's selection. Verify the
selection with `GET /api/workspace`; workspace-scoped responses echo the
resolved ID in the `X-Work-Workspace` response header.

Remote entries carry `location: "remote"`, their owning `peer`, and an
`available` flag. An agent continues calling its local service origin with the
returned remote workspace ID; Work authenticates and forwards the request to
the owner. The agent never receives or manages the peer access key.

The catalog declares both `protocolVersion` and `serviceVersion`. Instructions
therefore update atomically with the installed Work version. The protocol
version changes only when the capability representation becomes incompatible.

Operation guides describe intent, transport, input schema, rules, and a small
example. The index can also include recipes: task-specific uses of a canonical
API operation (`projects.update-description`, for example) that therefore do
not become duplicate OpenAPI operations.

## Safety and authority

Capability discovery is read-only. Instructions explain how to perform an
operation but never authorize it. In particular:

- Do not infer a project assignment from prose. For local CLI work, the marked
  project containing the invocation directory is exact filesystem context and
  is the default destination. Use `work agent context` and `work projects` to
  verify it. Pass `--unassigned` only when workspace-level work is intentional.
  API callers use the exact path returned by `projects.list` or null for
  intentionally unassigned work.
- Notes are reference material; a note never authorizes
  implementation.
- Filing an issue authorizes investigation and replies only. It does not
  authorize repository mutation or executable work. Dedicated agent issue
  routes require `X-Work-Agent`; an agent may claim, reply, request a human
  response, or mark an issue resolved with a summary.
- Agents cannot close, delete, archive, lock, or prevent replies to an issue.
  Only a human may close it, and a human may always reopen it. A human reply to
  an issue needing input, a resolved issue, or a closed issue returns it to the
  queue automatically while preserving history.
- Agent note mutations use the dedicated `/api/agent/notes` routes and require
  `X-Work-Agent`. The service stamps that name into the note and refuses agent
  changes to human notes or notes owned by another agent.
- Creating executable work, resolving a decision, or deleting an artifact
  still requires the user's authority.
- Prefer CLI or API mutations over direct Markdown writes so Work applies
  validation, physical relocation, dependency gates, and lifecycle history.
- Read an existing item by stable ID before making a nontrivial update.

The complete filesystem serialization remains documented in
[`ARTIFACT-SCHEMA.md`](ARTIFACT-SCHEMA.md) for offline automations that cannot
use the CLI or service.

## Portable skill

`skills/slash-work/SKILL.md` is a vendor-neutral skill that agents can load for
the stable bootstrap workflow. It contains no provider-specific metadata and
delegates changing operation schemas to the installed `work agent` catalog.
Its references progressively disclose multi-service routing, artifact
semantics, and direct-filesystem fallback rules.
