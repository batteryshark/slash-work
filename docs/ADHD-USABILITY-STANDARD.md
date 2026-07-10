# ADHD Usability Standard

This is a product acceptance standard, not a medical assessment. It turns the
needs described for Work into observable interface constraints. A feature does
not pass merely because it looks calm; it must reduce memory, initiation, and
recovery costs.

## 1. Capture Gate

- A thought can be preserved from the default screen with one focus action,
  typing, and Enter.
- `/` focuses the universal input from anywhere that is not already editable.
- Capturing never requires a title, project, type, priority, date, or owner.
- Ambiguity cannot block capture. The current scope supplies a safe default.
- The exact original wording is preserved.
- Success is confirmed in place without a modal or focus theft.

**Pass condition:** `/`, type, Enter records a thought and clears the input.

## 2. Resume Gate

- The initial project view exposes exactly one dominant continuation.
- The last meaningful update and next action are visible without opening a
  detail view.
- Context can be revealed progressively without leaving the screen.
- Empty or quiet projects are allowed and are not framed as failures.

**Pass condition:** a returning user can identify what to do next without a
click or reconstructing prior history.

## 3. Attention Gate

- The default `Needs you` queue contains decisions and blockers only.
- It is capped at three visible items in the default experience.
- Ordinary work, notifications, activity, and stale ideas do not enter this
  queue.
- Details stay collapsed until requested.

**Pass condition:** no more than one primary action and three human-attention
items compete in the first project viewport.

## 4. Scope Gate

- The current zoom level is always named in a breadcrumb.
- The capture target is stated beside the universal input.
- Zooming out never changes the identity of project records.
- An ambiguous portfolio capture goes to an inbox instead of opening a form.

**Pass condition:** a user can answer “what am I viewing?” and “where will this
thought go?” without remembering prior navigation.

## 5. Recovery Gate

- The last scope, selected project, resolved attention items, and captured
  thoughts persist on the device.
- Capture offers an immediate Undo action.
- Escape clears an unfinished command without saving it.
- Destructive or irreversible actions are not part of the quick-capture path.

**Pass condition:** interruption, refresh, or accidental capture does not force
the user to rebuild context.

## 6. Progressive Disclosure Gate

- The default screen shows continuation, attention, and capture.
- Project context, captured history, decision details, and portfolio grids are
  disclosed only on request.
- No full activity feed, telemetry wall, or equal-weight backlog is present.

**Pass condition:** secondary information remains available without competing
with the next action.

## 7. Motor and Keyboard Gate

- Primary interactive targets are at least 44 CSS pixels high where applicable.
- Every interaction is keyboard reachable with a visible focus indicator.
- Capture does not depend on drag-and-drop.
- Mobile layouts keep the capture path and next action usable.

## 8. Sensory Gate

- Reduced-motion preferences disable nonessential motion.
- Color is never the sole indicator of state.
- Contrast remains legible in the warm-neutral palette.
- No flashing, celebratory motion, notification badge storm, or visual timer is
  used to create urgency.

## 9. Language Gate

- No shame language: no “overdue,” “failed streak,” “you ignored,” or punitive
  red status merely because time passed.
- Staleness, when introduced, must be described factually as “last meaningfully
  updated.”
- Confirmations say what happened and what did not happen.

## Current MVP Audit

| Gate | Result | Evidence |
| --- | --- | --- |
| Capture | Pass | Universal `/work` input, `/` shortcut, no required metadata |
| Resume | Pass | One continuation with last update and next action |
| Attention | Pass | Three decision-only items with collapsed details |
| Scope | Pass | Clickable breadcrumb and explicit capture target |
| Recovery | Pass | Local persistence, Escape cancel, capture Undo |
| Disclosure | Pass | Context, captures, details, and portfolio are opt-in |
| Motor/keyboard | Pass | 44px targets, focus-visible styles, keyboard capture |
| Sensory | Pass | Reduced motion and restrained non-color labels |
| Language | Pass | Neutral, factual, non-punitive copy |

## Required Human Scenario Test

Before a release, repeat this scenario without coaching:

1. Leave the app on a project, refresh, and identify the next action.
2. Capture a messy thought using only the keyboard.
3. Undo it, then capture it again.
4. Zoom out to all projects and back into a different project.
5. Resolve one `Needs you` item.
6. Return after a context switch and explain what changed.

Any moment that requires remembering hidden syntax, reconstructing scope, or
completing metadata before preservation is a release blocker.
