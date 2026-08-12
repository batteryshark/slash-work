---
name: refine-work-item
description: Turn a rough Work backlog item into defined work through conversation — fill in description, goal, requirements, acceptance criteria, plan, and open questions, then leave it for the human to promote. Use when asked to refine, flesh out, define, scope, or "work out" a Work task or issue, or when a backlog item is too vague to act on.
---

# Refine a work item

A backlog item is allowed to be a stub: a title and some context written at
11pm with no thinking. Refining turns that into work an agent or a human can
actually pick up. It is a conversation, not a form-filling exercise.

## Rules

1. **Never promote the item yourself.** Refining ends with the item still in
   `backlog`. Only the human moves it to `ready`. That move is their
   statement that the definition is good.
2. **Never tick `delegated`.** Handing work to automation is human-only, and
   Work rejects it from an agent identity anyway.
3. **Ask before you write.** One round of questions, then write. Do not
   invent requirements to fill space — an empty section is better than a
   fabricated one.
4. **Preserve what is there.** The human's words in the description are
   context you clarify, never text you replace.

## The five parts, and what each is for

| Section | Answers | Written when |
|---|---|---|
| **Description** | What is this, what is the situation? Background. | Can be written before anything is understood |
| **Goal** | What do we want to do about it? One discrete outcome. | Needs a decision |
| **Requirements** | What must be true of the solution? | After the goal is settled |
| **Acceptance criteria** | How will we know it is done? Checkable. | After requirements |
| **Plan** | What should someone know to accomplish it? | Optional; skip when the goal is obvious |

If the goal is not decidable yet, say so and stop. An item whose goal reads
"decide whether to do X" is a legitimate, well-defined piece of work.

## Open questions

Work has no dedicated field for these, and does not need one. Record them as
a bullet list under `## Notes`, each starting with `Q:`, and resolve them by
editing the line to start with `A:` when answered:

```
## Notes
- Q: Does this need to work offline, or is a live connection assumed?
- A: Live connection is fine — the phone is always on the tailnet.
```

An unanswered `Q:` is the signal that the item is not ready, no matter how
complete the other sections look.

## Procedure

1. Read the item: `work show <id>` (add `--json` when you need the fields
   exactly). Read the project's purpose too if the item's context is thin.
2. Restate what you understand in two or three sentences, and list what you
   do not know as candidate `Q:` lines.
3. Ask the human the questions that actually block definition. Skip the ones
   you can answer from the repository or the project itself — look first.
4. Write the sections back with `work update <id>`: `--description`,
   `--goal`, `--plan`, `--notes` take one value each; `--requirement` and
   `--acceptance` repeat, once per list entry, and replace the whole list
   when passed. Only the flags you pass are touched. Run `work --help` when
   a flag is not behaving as described here — the installed version is the
   authority.
5. Report what you filled, what you left empty and why, and which questions
   remain open. End by telling the human the item is ready for them to
   promote — do not promote it.

## When not to use this

- The item is already defined. Refining a defined item just churns it.
- The work is a one-liner. A task that says "bump the dependency" needs no
  goal statement; leave it alone.
- The human asked you to *do* the work, not define it.
