# Changelog

## 1.0.1 - 2026-08-15

### Fixed

- Attachments for project records were written to the workspace root's
  `.work` while the record's `../attachments/…` reference pointed at the
  project's own `.work`. Files now land beside their record; the byte route
  still serves legacy locations.
- Issue and note payloads carry an `attachments` array of `{name, path}`
  with each image's absolute path, so agents read the field instead of
  reconstructing directories from markdown.
- Promoting an inbox capture to a task or note now removes the capture; it
  previously stayed in the inbox and invited duplicate triage.

## 1.0.0 - 2026-08-15

### Breaking

- The workbench UI replaces the old layout. One frame: left rail, scoped
  tabs (Today, Work, Issues, Notes, Files, Activity), read-first panels.
- Issue states collapse to open/closed. The API and MCP server still accept
  `resolved` as a legacy input alias and store it as `closed`; readers that
  matched `resolved` must match `closed`.
- Agent task creation is gated: agents can only create tasks as children of
  delegated goals, never top-level.

### Added

- Attachments: paste a screenshot into any record and it is stored as a
  plain file beside the record. Served via `GET /api/attachments`.
- Capture accepts a `task:` prefix to file a task instead of a note.
- Multi-root id floors: each root has an id floor, so `W-####` ranges never
  collide when trees meet.

### Fixed

- Discovery skips dot-directories and `._*` files.
- A duplicate project id degrades to a warning instead of killing boot.
- Workspace snapshots never reference an unlisted project.

[1.0.1]: https://github.com/batteryshark/slash-work/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/batteryshark/slash-work/compare/v0.2.22...v1.0.0
