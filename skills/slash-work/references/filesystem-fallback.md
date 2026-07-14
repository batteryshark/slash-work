# Filesystem fallback

Use direct Markdown access only when the Work CLI and HTTP API are unavailable.

1. Locate the nearest ancestor `.work/workspace.json`; never cross that root.
2. Read `docs/ARTIFACT-SCHEMA.md` and `schemas/work-artifact.schema.json` from the installed package or repository.
3. Discover only explicit projects and use their exact canonical paths.
4. Allocate stable unique IDs and match filenames to IDs.
5. Preserve unknown metadata and sections during updates.
6. Advance timestamps and append required history rather than rewriting it.
7. Write through a temporary sibling followed by atomic rename.
8. Reread and validate the resulting record.

Do not copy instruction manuals into `.work`. Workspace data should remain portable and version-independent; behavior belongs to the installed Work version.
