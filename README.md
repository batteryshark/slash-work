# Work

Work is a calm, zoomable shared memory for many projects. The first vertical
slice focuses on three things: resume one meaningful thread, surface only real
human decisions, and capture any thought without a form.

## Local development

```bash
npm install
npm run dev
```

The app opens at `http://localhost:3000`.

## Validation

```bash
npm run build
node --test tests/*.test.mjs
```

The product acceptance criteria live in
[`docs/ADHD-USABILITY-STANDARD.md`](docs/ADHD-USABILITY-STANDARD.md).

## Current behavior

- `/` focuses the universal `/work` input.
- Natural-language navigation handles requests such as “show all work” and
  “focus ReKit.”
- Other input is preserved as an idea, question, or update.
- Current scope, captures, and resolved decisions persist in browser storage.
- Breadcrumbs zoom from all work to Software to a project.
- Decisions expand in place and never open a modal.
