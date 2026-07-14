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
work agent operations
work agent instructions tasks.create
work agent instructions notes.request-review
work agent instructions ideas.request-evaluation
work agent schema task
```

The default instruction format is concise Markdown. Use `--json` or
`--format json` for a machine-readable response. Artifact schemas default to
JSON and accept `--format markdown` when a fenced representation is useful.

An agent should first list operations, then load only the operation relevant to
the current request. The operation index intentionally omits input schemas,
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

One service can expose multiple independent workspace roots. Call
`GET /api/workspaces`, select the exact ID, and send it as
`X-Work-Workspace` on every workspace-scoped request. `defaultWorkspaceId` is
only a fallback and may not match a browser tab's selection. Verify the
selection with `GET /api/workspace`; workspace-scoped responses echo the
resolved ID in the `X-Work-Workspace` response header.

The catalog declares both `protocolVersion` and `serviceVersion`. Instructions
therefore update atomically with the installed Work version. The protocol
version changes only when the capability representation becomes incompatible.

Operation guides describe intent, transport, input schema, rules, and a small
example. The index can also include recipes such as `notes.request-review`.
A recipe is a task-specific use of a canonical API operation and therefore does
not become a duplicate OpenAPI operation.

## Safety and authority

Capability discovery is read-only. Instructions explain how to perform an
operation but never authorize it. In particular:

- Do not infer a project assignment from prose. Call `projects.list` and use an
  exact returned path, or keep the artifact unassigned.
- Requesting note review or idea evaluation authorizes analysis only.
- Creating executable work, resolving a decision, or deleting an artifact
  still requires the user's authority.
- Prefer CLI or API mutations over direct Markdown writes so Work applies
  validation, physical relocation, dependency gates, and lifecycle history.
- Read an existing item by stable ID before making a nontrivial update.

The complete filesystem serialization remains documented in
[`ARTIFACT-SCHEMA.md`](ARTIFACT-SCHEMA.md) for offline automations that cannot
use the CLI or service.

## Remote compatibility

The current HTTP server remains loopback-only. The capability representation
uses relative links and transport-neutral operation IDs so a future remote Work
service can expose the same protocol over authenticated HTTPS. A remote agent
would discover the server, fetch only its needed operation, and perform that
operation without requiring access to the server's filesystem.

Remote access must add authentication, workspace authorization, and secure
service discovery before the loopback restriction is relaxed. Those concerns
are deliberately separate from this discovery contract.

## Portable skill

`skills/slash-work/SKILL.md` is a vendor-neutral skill that agents can load for
the stable bootstrap workflow. It contains no provider-specific metadata and
delegates changing operation schemas to the installed `work agent` catalog.
Its references progressively disclose multi-service routing, artifact
semantics, and direct-filesystem fallback rules.
