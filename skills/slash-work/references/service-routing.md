# Service and workspace routing

Keep these identities separate:

- A **service origin** identifies the one Work server the current agent calls.
- A **workspace** identifies one independent filesystem root. It may be local to
  that service or owned by an explicitly paired remote instance.
- A **project** is an explicit project inside one workspace.
- A **scope** is the directory view used for queries and unassigned captures.

The UI and API have different origins. The UI prefers port 43171 and the API
prefers port 43170, but each automatically chooses another free port when that
preference is occupied. Either may be configured differently, and an SSH or IDE
forwarding layer may assign yet another client-side port. Use the URLs printed
by `work serve` or supplied by the user. Never send API requests to a port
merely because it looks familiar.

When one Work instance is paired with another, `work --tailscale` on the owning
machine prints the tailnet API URL used as the peer transport. Agents still call
their local `$WORK_ORIGIN`; they do not call the peer URL or handle its access
key. Tailscale ACLs govern direct access to the full tailnet service, while the
federation grant scopes which roots the local gateway can import.

## HTTP selection sequence

```bash
curl -sS "$WORK_ORIGIN/api/workspaces"
curl -sS -H "X-Work-Workspace: $WORKSPACE_ID" "$WORK_ORIGIN/api/workspace"
curl -sS -H "X-Work-Workspace: $WORKSPACE_ID" "$WORK_ORIGIN/api/projects"
```

`defaultWorkspaceId` is only the server fallback for requests that omit the header. It is not a global selection and does not necessarily match a browser tab. `activeWorkspaceId` may appear for compatibility and has the same fallback meaning.

Send the workspace header on every workspace-scoped read and write. Verify the `X-Work-Workspace` response header. If a workspace cannot be selected unambiguously, stop and ask the user rather than writing to the fallback root.

`GET /api/workspaces` labels federated entries with `location: "remote"`, an
owning `peer`, and current `available` state. Keep using `$WORK_ORIGIN` for those
IDs. The local Work server is the gateway and forwards only Work's allowlisted
workspace operations; agents never need the peer URL or access key. Do not use
an offline entry, do not strip the `remote:...` workspace ID, and do not attempt
transitive routing through a peer.

Service-scoped discovery endpoints such as `/api/agent`, `/api/workspaces`, and `/api/openapi.json` do not require a workspace header.
