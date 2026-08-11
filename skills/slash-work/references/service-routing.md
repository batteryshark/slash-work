# Service and workspace routing

Keep these identities separate:

- A **service origin** identifies the one Work server the current agent calls.
- A **workspace** identifies one independent filesystem root registered with
  that service.
- A **project** is an explicit project inside one workspace.
- A **scope** is the directory view used for queries and unassigned captures.

The UI and API have different origins. The UI prefers port 43171 and the API
prefers port 43170, but each automatically chooses another free port when that
preference is occupied. Either may be configured differently, and an SSH or IDE
forwarding layer may assign yet another client-side port. Use the URLs printed
by `work serve` or supplied by the user. Never send API requests to a port
merely because it looks familiar.

## HTTP selection sequence

```bash
curl -sS "$WORK_ORIGIN/api/workspaces"
curl -sS -H "X-Work-Workspace: $WORKSPACE_ID" "$WORK_ORIGIN/api/workspace"
curl -sS -H "X-Work-Workspace: $WORKSPACE_ID" "$WORK_ORIGIN/api/projects"
```

`defaultWorkspaceId` is only the server fallback for requests that omit the header. It is not a global selection and does not necessarily match a browser tab. `activeWorkspaceId` may appear for compatibility and has the same fallback meaning.

Send the workspace header on every workspace-scoped read and write. Verify the `X-Work-Workspace` response header. If a workspace cannot be selected unambiguously, stop and ask the user rather than writing to the fallback root.

Service-scoped discovery endpoints such as `/api/agent`, `/api/workspaces`, and `/api/openapi.json` do not require a workspace header.
