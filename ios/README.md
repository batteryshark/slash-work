# Work for iOS

A first-class SwiftUI client for a Work instance reachable on your tailnet. The app uses the existing Work HTTP API; it does not embed the web UI.

## Run it

1. Start the service on a trusted machine with `work --tailscale`.
2. Open `Work.xcodeproj` in Xcode.
3. Select your Apple development team if Xcode does not pick it automatically.
4. Run on an iPhone or iPad that is connected to the same tailnet.
5. Enter the API URL printed by Work, such as `http://100.x.y.z:43170`.

The initial build targets iOS 17 and uses the same development team configured by the Orchestra app. Its bundle identifier is `com.batteryshark.slashwork`.

## Current native surface

- Saved Work instances with explicit HTTP or HTTPS URLs
- Workspace discovery across the instance's registered local workspaces
- Project-scoped Home, Board, Capture, and More tabs
- Needs You decision flows with recommendations, Other, written responses, reject, and defer
- Task creation, lifecycle moves, checklist confirmation, and progress updates
- Due dates on task cards and an upcoming-date strip
- Project creation and deletion (deletion is human-only and asks for confirmation)
- Named issue filing, visible issue IDs, human-only delegation, Markdown
  conversation threads, state history, closure, and reopening
- Human note creation and a capture inbox
- Conditional workspace refreshes using ETags
- Last-snapshot caching with clearly marked read-only offline mode

## Trust and transport

The first release relies on Tailscale ACLs as the access boundary and does not store Work credentials. iOS App Transport Security is intentionally configured to permit a user-entered HTTP Tailnet endpoint. The app rejects embedded URL credentials and non-HTTP schemes. A future release should prefer valid HTTPS through Tailscale MagicDNS; it should never add a generic trust-all handler for self-signed certificates.

Cached snapshots live in the app's Application Support container. Mutations are disabled while displaying cached data, so the app does not queue conflicting offline changes.

Issues are included in the cached workspace snapshot and remain readable
offline. Filing, replying, closing, and reopening require a live connection.
Replying to an issue in **Needs you**, **Resolved**, or **Closed** atomically
returns it to **Queued** on the server.

## Issue API contract

The native client expects `issues` in `GET /api/workspace` and also supports
`GET /api/issues` (an `{issues: [...]}` response). It creates issues with `POST /api/issues` using
`{title?, body, scopePath, projectPath}`, changes human-only delegation with
`PATCH /api/issues/:id` using `{delegated}`, replies with
`POST /api/issues/:id/replies` using `{body}`, and changes state with
`POST /api/issues/:id/state` using `{state}`. Reopen sends `queued`; human
Close sends `closed`. The server is responsible for automatically returning an
issue in `needs_human`, `resolved`, or `closed` to `queued` when accepting a
human reply.

Wire states are `queued`, `in_progress`, `needs_human`, `resolved`, and
`closed`; the app presents the middle two as **Agent working** and
**Needs you**. Older cached workspace responses without an `issues` member
remain compatible and decode as an empty issue list.

## Command-line verification

```sh
xcodebuild \
  -project ios/Work.xcodeproj \
  -scheme Work \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  CODE_SIGNING_ALLOWED=NO \
  test
```
