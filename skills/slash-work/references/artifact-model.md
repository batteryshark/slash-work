# Artifact model

Choose the smallest durable record matching the user's intent:

- **Capture**: preserve a raw thought immediately; assignment is optional.
- **Note**: durable reference context. `review_requested` authorizes review, not execution.
- **Idea**: a possibility to evaluate. `evaluation_requested` authorizes analysis only.
- **Decision**: an explicit human choice with recorded alternatives and resolution history.
- **Task**: authorized executable work with status, ownership, requirements, acceptance criteria, dependencies, and progress history.

Projects have a durable description explaining what they are, who they serve, and why they exist. Read it before creating or assigning substantive work. Do not replace enduring purpose with current status or a task list.

Use `work agent instructions <operation>` for current input fields and rules. Use `work agent schema <artifact>` only when direct serialization or complete logical validation is required.
