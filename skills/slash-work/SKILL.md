---
name: slash-work
description: Use Slash Work to discover project context and safely create, review, evaluate, update, move, or inspect durable captures, notes, ideas, decisions, and Kanban tasks. Use when an agent is asked to work with a `.work` workspace, the `work` CLI, a Work HTTP service, project purpose descriptions, or Work's Markdown records.
---

# Slash Work

Use the installed Work version as the authority. Load only the operation needed for the request.

## Choose an interface

1. Prefer the `work` CLI for local filesystem work. It resolves the nearest workspace without a running service.
2. Use HTTP when the user provides a Work service origin or the agent is operating remotely.
3. Edit Markdown directly only when neither interface is available. Read [references/filesystem-fallback.md](references/filesystem-fallback.md) first.

## Bootstrap

Run:

```bash
work agent operations
work agent instructions <operation>
```

Add `--json` when machine-readable instructions are more useful. Do not load every operation or the full artifact schema unless the task requires them.

## Select the correct workspace

For CLI commands, run from inside the intended workspace or pass `--root <path>` explicitly.

For HTTP requests, never assume the service default is the workspace visible in a browser:

1. Call `GET /api/workspaces` on the exact service origin.
2. Select the exact workspace by ID and verify its root or name.
3. Send `X-Work-Workspace: <id>` on every workspace-scoped request.
4. Call `GET /api/workspace` with that header and verify the returned workspace before mutation.
5. Check the `X-Work-Workspace` response header after mutation.

Read [references/service-routing.md](references/service-routing.md) when multiple services, roots, ports, or remote instances are involved.

## Preserve meaning and authority

- Read the project description before scoping substantive work.
- Never infer a project assignment from prose; use an exact path returned by `projects.list`.
- Treat notes marked `reference_only` as context, not instructions.
- Treat idea evaluation and note review as analysis only.
- Do not resolve decisions, delete records, or create executable work without user authority.
- Read an existing item by stable ID before a nontrivial update.
- Prefer Work mutations so validation, relocation, dependency gates, and history are preserved.

Read [references/artifact-model.md](references/artifact-model.md) when choosing an artifact type or interpreting lifecycle semantics.
