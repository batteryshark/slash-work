# FastMCP server plan

## Status

This document is an implementation handoff, not an implemented feature.

The intended user-facing command is:

```sh
work --tailscale --mcp
```

It keeps the existing browser and iOS interfaces and adds a Streamable HTTP MCP
endpoint:

```text
Web:  http://100.x.y.z:43171/
API:  http://100.x.y.z:43170/
MCP:  http://100.x.y.z:43170/mcp
```

The selected ports are examples. Work must continue printing the actual URLs
when a preferred port is unavailable.

## Goals

1. Give MCP-capable agent harnesses a small, typed interface to Work.
2. Make the interface reachable across the user's tailnet when Work is launched
   with `--tailscale`.
3. Keep the web app, native iOS app, REST API, CLI, and MCP tools on the same
   workspace and artifact model.
4. Reuse Work's existing validation, history, project routing, and
   authorization rules.
5. Let agents inspect safely exposed project files without requiring direct
   filesystem traversal.
6. Add no second public port and never bind a service to `0.0.0.0` or an
   ordinary LAN address.
7. Keep MCP optional so the normal npm installation and startup path remain
   unchanged for users who do not enable it.

## Non-goals for the first release

- Replacing the REST API used by the web and iOS clients.
- Giving MCP clients unrestricted filesystem access.
- Allowing an MCP client to select an arbitrary host path.
- Exposing update, restart, folder-picker, or credential operations.
- Supporting destructive deletion tools.
- Resolving human decisions without an explicit human choice.
- Supporting MCP prompts, sampling, elicitation, apps, subscriptions, or
  server-initiated notifications.
- Creating a hosted relay or making a Work instance internet-accessible.
- Adding OAuth in the first tailnet-only release.

## Product behavior

### Startup

Add an opt-in `--mcp` flag to the existing `serve` behavior:

```sh
# Loopback-only browser, REST, and MCP
work --mcp

# Tailnet browser, REST, and MCP
work --tailscale --mcp

# Tailnet REST and MCP without the Vite UI
work --tailscale --mcp --no-ui
```

`--mcp` does not imply `--tailscale`. Without `--tailscale`, every public
listener remains on `127.0.0.1`.

Startup succeeds only after both the Work API and the private FastMCP sidecar
are ready. Work then prints the MCP URL and a small configuration example.

If the MCP runtime cannot start, `work --mcp` fails with an actionable error
and closes the API and UI it started. Work must not claim that MCP is ready or
continue in a partially enabled state.

Startup without `--mcp` must not inspect Python, invoke `uv`, create a Python
environment, or add measurable delay.

### Shutdown and restart

The Node parent owns the FastMCP child process.

- `SIGINT`, `SIGTERM`, an in-app restart, an update restart, or an API startup
  failure closes the UI, FastMCP child, and REST API.
- Graceful shutdown gets a short bounded deadline before the child is
  terminated.
- A child that exits unexpectedly makes `/mcp` return a clear `503` and writes
  one useful diagnostic to Work's stderr.
- Work may attempt one bounded child restart. It must not enter an unbounded
  crash loop.

## Architecture

FastMCP is a Python framework and Work is a Node/npm application. The design
therefore uses two private processes but presents one public Work service:

```text
MCP client on loopback or tailnet
            |
            | Streamable HTTP
            v
http://<work-host>:<api-port>/mcp
            |
            | raw HTTP proxy
            v
FastMCP sidecar on 127.0.0.1:<ephemeral-port>
            |
            | bounded HTTP calls
            v
existing Work REST API
            |
            v
local-workspace functions and .work storage
```

### Why the sidecar calls REST

The Python code must not parse or write `.work` files. It must call the existing
REST operations so that MCP uses the same:

- workspace IDs and `X-Work-Workspace` selection;
- input validation and error codes;
- exact project paths;
- artifact relocation and history;
- agent-note ownership rules;
- workspace routing;
- read-only file containment and secret filtering.

The REST API and `lib/agent-capabilities.mjs` remain the source of truth. MCP is
an adapter, not a second backend.

### Public and private listeners

The public `/mcp` route is served by Work's existing API listener. The listener
already permits only:

- `127.0.0.1`; or
- this machine's Tailscale IPv4 address.

The FastMCP sidecar binds only to `127.0.0.1` on an operating-system-assigned
ephemeral port. It never binds directly to the Tailscale address, an ordinary
LAN address, or a wildcard address.

The Python process should create and retain the port-zero socket before
starting its ASGI server. It reports readiness to the Node parent through a
small structured handshake. Do not select a "free" port by probing and then
reopening it; that introduces a bind race.

The parent generates an unguessable per-process proxy secret. Every proxied
request carries that secret to private ASGI middleware, and the sidecar rejects
direct requests without it. The secret is inherited through the child
environment, never printed, and never sent to an MCP client.

### `/mcp` proxy requirements

The Node proxy owns both `/mcp` and `/mcp/`. It must:

- forward only supported MCP methods;
- stream requests and responses rather than buffering arbitrary bodies;
- preserve MCP content types and protocol headers;
- remove hop-by-hop headers;
- add the private proxy-authentication header;
- apply explicit request-body and header-size limits;
- propagate client disconnect and cancellation;
- return `503` when the sidecar is unavailable;
- avoid logging request bodies, authorization headers, or the proxy secret.

The initial FastMCP server uses stateless Streamable HTTP with JSON responses.
This keeps each tool call request/response-oriented and avoids sticky sessions,
long-lived SSE connections, and proxy buffering behavior. A later feature that
actually needs notifications, sampling, or elicitation must revisit this
decision explicitly.

## FastMCP runtime and packaging

Create a small Python project inside the npm package, for example:

```text
mcp/
  pyproject.toml
  uv.lock
  src/slash_work_mcp/__init__.py
  src/slash_work_mcp/__main__.py
  src/slash_work_mcp/server.py
  src/slash_work_mcp/work_client.py
  tests/
```

Add `mcp/` to the npm `files` allowlist.

Use `uv` to create and run the isolated environment. The Node launcher should
use the equivalent of:

```sh
uv run --project <installed-package>/mcp --locked python -m slash_work_mcp
```

Requirements:

- Pin FastMCP and all direct Python dependencies through `uv.lock`.
- Select an exact released FastMCP version during implementation.
- Do not use a floating range, a Git branch, or documentation-only unreleased
  APIs. FastMCP's documentation follows its `main` branch and can describe
  features that have not been released.
- Record and test the supported Python version.
- Do not silently install `uv`.
- If `uv` is missing, fail `--mcp` with the exact install prerequisite and
  leave ordinary Work startup unaffected.
- Document that the first `--mcp` start may need network access to provision
  the pinned Python environment. Subsequent starts should use the locked cache.
- Include the Python dependency licenses in the release review.

Using FastMCP introduces a Python/uv runtime requirement that the normal Node
application does not otherwise have. This is an accepted constraint of the
FastMCP decision, but it must stay isolated behind `--mcp`.

Relevant FastMCP documentation:

- [Welcome and documentation version caveat](https://gofastmcp.com/getting-started/welcome)
- [Streamable HTTP deployment](https://gofastmcp.com/deployment/running-server)
- [HTTP integration and stateless mode](https://gofastmcp.com/v2/deployment/http)
- [CLI inspection and calls](https://gofastmcp.com/cli/overview)

## Canonical operation model

`lib/agent-capabilities.mjs` already defines operation IDs, summaries, JSON
schemas, rules, mutation flags, paths, and headers. Preserve that catalog as the
canonical contract.

Before adding a tool:

1. Ensure the underlying REST operation is represented in the capability
   catalog.
2. Add missing safe file-list and file-read operations to that catalog rather
   than defining MCP-only behavior.
3. Put durable safety instructions in the canonical operation entry.
4. Add the operation ID to a deliberate MCP allowlist.
5. Contract-test the FastMCP tool name, input fields, and result shape against
   the catalog and OpenAPI output.

The Python adapters may use explicit Pydantic models for good FastMCP schemas,
but tests must detect drift from the canonical JSON schema. Do not hand-maintain
unverified duplicate descriptions and validation rules.

## Initial tool surface

Keep tool names stable, verb-first, and unambiguous. Each workspace-scoped tool
accepts `workspace_id`. It may default to the service's
`defaultWorkspaceId`, but the result must always report the workspace ID that
was actually used.

### Discovery and reading

| MCP tool | Canonical operation | Purpose |
| --- | --- | --- |
| `workspaces_list` | `workspaces.list` | List available workspaces and the default ID. |
| `projects_list` | `projects.list` | Return exact project paths before assignment. |
| `tasks_list` | `tasks.list` | List task records in the selected workspace. |
| `task_get` | `tasks.get` | Read one task by stable ID. |
| `decisions_list` | `decisions.list` | Identify explicit choices still waiting for a human. |
| `issues_list` | `issues.list` | List issue conversations available for investigation. |
| `issue_get` | `issues.read` | Read one issue with replies, ownership, and state history. |
| `files_list` | `files.list` | List one contained project directory. |
| `file_read` | `files.read` | Read one safe text file through Work's existing file browser boundary. |

`files_list` and `file_read` must reuse the current REST file-browser
containment, size limits, binary detection, ignored-secret rules, and
read-only behavior. They never accept absolute paths.

### Mutations

| MCP tool | Canonical operation | Purpose |
| --- | --- | --- |
| `project_create` | `projects.create` | Create a new project folder and marker from a human name. |
| `capture_create` | `captures.create` | Preserve a thought without turning it into executable work. |
| `decision_create` | `decisions.create` | Ask a human for an explicit decision. |
| `task_create` | `tasks.create` | Create authorized executable work with acceptance criteria. |
| `task_move` | `tasks.move` | Make an explicit lifecycle transition. |
| `task_log` | `tasks.log` | Append durable progress without changing status. |
| `task_checklist` | `tasks.checklist` | Check or reopen one requirement or acceptance item. |
| `issue_create` | `issues.create` | File a discovered problem, attributed to the agent, with no delegation. |
| `issue_claim` | `issues.claim` | Claim one queued issue and mark it in progress. |
| `issue_reply` | `issues.reply` | Append an attributed reply to a claimed issue. |
| `issue_update_state` | `issues.update-state` | Mark a claimed issue in progress, needing a human, or resolved. |

Tool annotations should accurately mark read-only, mutating, idempotent, and
destructive behavior where FastMCP supports them.

### Deliberately excluded tools

Do not expose these in the initial allowlist:

- artifact deletion;
- `decisions.resolve`;
- note mutation until stable MCP client identity can preserve agent ownership;
- project profile mutation;
- folder picking and workspace registration;
- service restart and self-update;
- credential handling.

They can be added only with a concrete client need and focused authorization
review.

## Workspace and project routing

One Work service can expose multiple local roots. MCP must preserve the
existing routing contract:

1. Call `workspaces_list`.
2. Select an available exact `workspace_id`.
3. Send it to every workspace-scoped tool.
4. The adapter sends `X-Work-Workspace` to the REST API.

Project assignment is equally explicit:

1. Call `projects_list` for the selected workspace.
2. Use an exact returned project path.
3. Use `null` only when unassigned workspace-level work is intentional.
4. Never infer project ownership from a title, note, or filesystem-like string.

The MCP server never accepts an absolute workspace or project path.

## Results and errors

Every successful tool returns:

- concise human-readable text;
- `structuredContent` containing the machine-readable REST result;
- the selected `workspace_id`;
- stable record IDs and exact project paths when relevant.

Do not stringify structured results into prose only.

Map REST failures into MCP tool errors without hiding actionable information:

| REST condition | MCP behavior |
| --- | --- |
| Validation failure | Tool error with the field-level or actionable message. |
| Unknown workspace/project/record | Tool error that names the missing stable ID or exact path. |
| Forbidden or unsafe file | Tool error without leaking the rejected host path. |
| API timeout | Bounded timeout error with operation context. |
| Sidecar or API unavailable | Service-unavailable error; never fabricate an empty result. |

Preserve safe Work error codes in structured error metadata. Mask stack traces,
host paths, environment variables, secrets, and raw upstream response bodies.

## Security model

### First release

The first release follows Work's existing network boundary:

- loopback mode is accessible only on the host;
- tailnet mode binds only to the machine's Tailscale IPv4 address;
- Tailscale membership and ACLs determine who can reach the full Work service;
- `--mcp` is explicit opt-in;
- MCP exposes a smaller allowlist than the REST API;
- the private FastMCP listener has a per-process proxy secret.

Anyone allowed by Tailscale ACLs to reach the MCP endpoint can invoke the
exposed mutation tools. Startup output and documentation must say this plainly.

### Follow-up authentication

Some remote MCP clients require HTTPS and authenticated remote servers.
A later release should evaluate Tailscale HTTPS plus FastMCP bearer-token or
OAuth support. That work must define:

- token issuance, storage, rotation, and revocation;
- tool-level scopes;
- client configuration on iOS-adjacent and remote harnesses;
- migration without weakening the existing tailnet boundary.

Do not bind publicly or add a generic trust-all TLS handler to make a client
connect.

## Limits and resilience

Use explicit bounded defaults and keep one source of truth for them:

- REST call timeout;
- MCP request body limit;
- maximum tool-result payload;
- file-read size limit inherited from the file browser;
- sidecar startup deadline;
- graceful shutdown deadline;
- at most one automatic child restart in a bounded window.

Large lists should gain pagination or filters before the MCP adapter increases
payload limits. Do not silently truncate results without returning a cursor or
an explicit truncation marker.

The sidecar should reuse one bounded async HTTP client pool. It must not retry
mutations automatically. A safe read may receive a small bounded retry only for
a connection failure that occurred before a response was received.

## Observability

- Node logs sidecar lifecycle events with a `[work:mcp]` prefix.
- FastMCP and HTTP-client logs go to stderr.
- Log operation name, duration, status, and a safe workspace identifier.
- Never log tool arguments wholesale, note bodies, file content, credentials,
  authorization headers, or proxy secrets.
- Add MCP readiness to `/api/health` only when `--mcp` is enabled:

```json
{
  "mcp": {
    "enabled": true,
    "ready": true,
    "path": "/mcp"
  }
}
```

Do not expose the private port or proxy secret.

## Proposed implementation areas

### Node

- `bin/work.mjs`
  - parse and document `--mcp`;
  - launch MCP after the REST origin is known;
  - print the public endpoint and client configuration;
  - include MCP in ordered shutdown and restart.
- `lib/mcp-sidecar.mjs`
  - verify `uv`;
  - spawn the locked Python project;
  - perform the structured readiness handshake;
  - own the private proxy secret and bounded restart policy.
- `server/local-api.mjs`
  - reserve `/mcp` and `/mcp/`;
  - proxy to the ready sidecar;
  - report MCP health;
  - preserve existing host restrictions and timeouts.
- `lib/agent-capabilities.mjs`
  - add canonical safe file operations;
  - expose any MCP-specific metadata needed for contract generation.
- `package.json`
  - include `mcp/` in the published package.

### Python

- `mcp/src/slash_work_mcp/server.py`
  - construct `FastMCP(..., stateless_http=True)`;
  - enable JSON response mode;
  - register only the explicit tool allowlist;
  - apply private proxy-authentication middleware.
- `mcp/src/slash_work_mcp/work_client.py`
  - call the existing REST API with bounded timeouts;
  - attach `X-Work-Workspace`;
  - map responses and safe error codes.
- `mcp/src/slash_work_mcp/__main__.py`
  - bind a loopback port-zero socket without a race;
  - emit one machine-readable readiness message;
  - run the ASGI lifecycle and graceful shutdown.

Names may change during implementation, but the boundaries above should not.

## Verification plan

### Unit and contract tests

- `--mcp` parsing and help output.
- Startup without `--mcp` never invokes `uv`.
- Missing `uv` produces an actionable error and cleans up started services.
- Sidecar readiness timeout and early exit are handled.
- The proxy secret is required by the private listener.
- MCP tool schemas match the canonical operation catalog.
- Only allowlisted tools are listed.
- Every workspace-scoped tool sends the selected `X-Work-Workspace`.
- Mutation tools do not retry.
- REST error codes map to safe MCP errors.
- File tools reject absolute paths, traversal, secrets, binaries, oversized
  files, and paths outside the selected project.

### Integration tests

Start Work with loopback API, UI disabled, MCP enabled, and ephemeral test
ports. Use a FastMCP client to:

1. initialize over Streamable HTTP;
2. list tools;
3. list workspaces and projects;
4. create a capture, decision, and task;
5. read, move, and log the task;
6. list and read an allowed project file;
7. verify the underlying Markdown and task history through Work;
8. verify unknown and unavailable workspace behavior;
9. terminate Work and confirm the child exits.

Run the same contract through the Node `/mcp` proxy, not only against the
private FastMCP port.

### Network boundary tests

- Loopback mode refuses access through ordinary LAN addresses.
- Tailnet mode binds only the discovered Tailscale IPv4 address.
- Invalid, wildcard, and ordinary LAN bind requests fail.
- The private FastMCP port is loopback-only and rejects a missing/invalid proxy
  secret.
- An occupied preferred Work API port follows the existing fallback policy,
  and the printed MCP URL uses the actual selected port.
- A pinned occupied API port fails rather than silently moving.

### Release checks

- Existing Node build and test suite.
- Existing iOS tests; the REST contract must remain compatible.
- Python formatting, static checks, and tests.
- `uv lock --check` or the current equivalent.
- `npm pack --dry-run` confirms the complete MCP Python project and lockfile are
  included.
- Install the packed npm artifact into a clean temporary prefix and start MCP
  from that installed artifact.
- Inspect and call the public endpoint with the FastMCP CLI.
- Test from a second tailnet machine, because a host cannot prove the client's
  ACL, route, firewall, or MCP-client URL policy.

## Acceptance criteria

- `work --mcp` exposes a working `http://127.0.0.1:<actual-api-port>/mcp`.
- `work --tailscale --mcp` exposes the same path only on the machine's Tailscale
  IPv4 address.
- The browser and iOS REST clients continue working without contract changes.
- No additional public port is opened.
- The FastMCP child is private, authenticated to the proxy, supervised, and
  stopped with Work.
- A fresh MCP client can discover the small allowlisted tool set without
  reading repository documentation.
- Tools operate on exact workspace IDs and project paths and preserve Work's
  existing validation and history.
- Read-only file tools cannot escape Work's existing file-browser boundary.
- Ordinary startup has no Python or FastMCP dependency.
- The packed npm release can provision and start the exact locked FastMCP
  environment through `uv`.
- Loopback, tailnet, unavailable-peer, occupied-port, child-failure, timeout,
  cancellation, and clean-shutdown boundaries are tested.

## Suggested delivery sequence

1. Add canonical file operations and MCP contract tests.
2. Build the Python REST client and FastMCP tools against a test Work API.
3. Add the private socket, proxy secret, and structured readiness handshake.
4. Add the Node supervisor and `/mcp` proxy.
5. Add `--mcp`, health output, startup text, and documentation.
6. Run installed-package, failure-boundary, and two-machine tailnet tests.
7. Publish as a minor release because it adds a new network interface and
   optional runtime.

## Handoff constraints

The implementing agent should not:

- replace FastMCP with another MCP framework without an explicit product
  decision;
- expose the sidecar port;
- bypass REST by editing `.work` files from Python;
- add a floating Python dependency;
- silently install system prerequisites;
- add tools outside the initial allowlist for convenience;
- weaken Work's bind-address validation;
- declare remote success based only on same-machine tests.
