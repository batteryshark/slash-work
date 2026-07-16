import { readFileSync } from "node:fs";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ARTIFACT_SCHEMA = JSON.parse(readFileSync(new URL("../schemas/work-artifact.schema.json", import.meta.url), "utf8"));

export const AGENT_PROTOCOL_VERSION = "1";

const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const nullableString = (description) => ({ oneOf: [string(description), { type: "null" }] });
const stringList = (description) => ({ type: "array", description, items: { type: "string", minLength: 1 } });
const agentHeaders = { "X-Work-Agent": string("Stable agent or harness name used to stamp and enforce note ownership.", { minLength: 1, maxLength: 120 }) };
const object = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties,
});

const projectPath = {
  oneOf: [string("Exact project path returned by projects.list."), { type: "null" }],
  description: "Use null to keep the artifact unassigned. Never infer this value from prose.",
};
const scopePath = string("Workspace-relative directory scope. Use '.' for the workspace root.", { default: "." });
const taskId = string("Stable task identifier.", { pattern: "^W-[0-9]{4,10}$" });
const recordId = (prefix) => string(`Stable ${prefix} identifier.`, { pattern: `^${prefix}_[a-z0-9][a-z0-9_-]{7,80}$` });

const operations = [
  {
    id: "workspaces.list",
    category: "service",
    scope: "service",
    summary: "List the independent workspace roots exposed by this Work service.",
    mutation: false,
    transport: { api: { method: "GET", path: "/api/workspaces" } },
    rules: ["Treat defaultWorkspaceId as a fallback, not a globally active browser selection.", "Choose the exact workspace before any workspace-scoped request."],
  },
  {
    id: "projects.list",
    category: "workspace",
    summary: "Discover exact project paths before assigning work.",
    mutation: false,
    transport: { api: { method: "GET", path: "/api/projects" } },
    rules: ["Read each project's description before scoping substantive work.", "Use only paths returned by this operation for projectPath.", "Do not infer project ownership from titles or body text."],
  },
  {
    id: "projects.update-profile",
    category: "workspace",
    summary: "Update the display name or durable high-level purpose of one exact project.",
    mutation: true,
    transport: { api: { method: "PATCH", path: "/api/projects/profile" } },
    inputSchema: { ...object({ projectPath: string("Exact path returned by projects.list."), name: string("Human-friendly display name. This never changes the filesystem path or project identity.", { maxLength: 120 }), description: string("What the project is, who it serves, and why it exists.", { maxLength: 20000 }) }, ["projectPath"]), anyOf: [{ required: ["name"] }, { required: ["description"] }] },
    rules: ["Provide at least one of name or description.", "Describe enduring purpose, not current tasks or status.", "Read projects.list first and preserve the user's meaning."],
    example: { projectPath: "software/rekit", name: "ReKit", description: "A local-first project manager that gives people and agents one durable operational workspace." },
  },
  {
    id: "projects.update-description",
    category: "workspace",
    recipeFor: "projects.update-profile",
    summary: "Set the durable high-level purpose of one exact project.",
    mutation: true,
    transport: { api: { method: "PATCH", path: "/api/projects/profile" } },
    inputSchema: object({ projectPath: string("Exact path returned by projects.list."), description: string("What the project is, who it serves, and why it exists.", { maxLength: 20000 }) }, ["projectPath", "description"]),
    rules: ["Describe enduring purpose, not current tasks or status.", "Read projects.list first and preserve the user's meaning."],
    example: { projectPath: "software/rekit", description: "A local-first project manager that gives people and agents one durable operational workspace." },
  },
  {
    id: "captures.list",
    category: "captures",
    artifactType: "capture",
    summary: "List untriaged thoughts across the selected workspace.",
    mutation: false,
    transport: { api: { method: "GET", path: "/api/captures" } },
    rules: ["Preserve the distinction between unassigned scope and an explicit project assignment."],
  },
  {
    id: "captures.create",
    category: "captures",
    artifactType: "capture",
    summary: "Preserve a thought immediately without forcing it into executable work.",
    mutation: true,
    transport: { cli: "work add \"thought\" [--scope path] [--project exact/path]", api: { method: "POST", path: "/api/captures" } },
    inputSchema: object({ text: string("The thought to preserve.", { minLength: 1 }), kind: { enum: ["idea", "question", "update"] }, scopePath, projectPath }, ["text"]),
    rules: ["Preserve the user's wording.", "Leave projectPath null unless an exact project was explicitly selected."],
    example: { text: "Check whether the release needs a migration", scopePath: ".", projectPath: null },
  },
  {
    id: "captures.assign",
    category: "captures",
    artifactType: "capture",
    summary: "Move an existing capture to an exact project or workspace scope.",
    mutation: true,
    transport: { api: { method: "PATCH", path: "/api/captures/{id}" } },
    parameters: { id: recordId("capture") },
    inputSchema: object({ projectPath, scopePath }),
    rules: ["Use projects.list before assigning a project.", "Use projectPath null to keep the capture unassigned."],
    example: { projectPath: "software/rekit" },
  },
  {
    id: "captures.delete",
    category: "captures",
    artifactType: "capture",
    summary: "Delete a capture the user no longer wants.",
    mutation: true,
    destructive: true,
    transport: { api: { method: "DELETE", path: "/api/captures/{id}" } },
    parameters: { id: recordId("capture") },
    rules: ["Delete only with explicit user authorization."],
  },
  {
    id: "notes.list",
    category: "notes",
    artifactType: "note",
    summary: "List notes, including those explicitly waiting for agent review.",
    mutation: false,
    transport: { api: { method: "GET", path: "/api/notes" } },
    rules: ["Treat reference_only notes as context, not instructions.", "Prioritize notes whose agentIntent is review_requested when asked to process reviews."],
  },
  {
    id: "notes.create",
    category: "notes",
    artifactType: "note",
    summary: "Create durable project reference material with visible agent provenance.",
    mutation: true,
    transport: { api: { method: "POST", path: "/api/agent/notes" } },
    headers: agentHeaders,
    inputSchema: object({
      title: string("Short note title.", { maxLength: 300 }),
      text: string("Plain-text note content."),
      scopePath,
      projectPath,
      agentIntent: { const: "reference_only", default: "reference_only" },
    }),
    rules: ["Create a note only when the result is durable reference material, not a disposable status update.", "Use the exact projectPath returned by projects.list; keep it unassigned only when the user explicitly wants a workspace note.", "Agent-created notes are visibly attributed and remain reference_only."],
    example: { title: "Release constraints", text: "Keep upgrades reversible.", agentIntent: "reference_only", projectPath: null },
  },
  {
    id: "notes.update",
    category: "notes",
    artifactType: "note",
    summary: "Update a note created by this same agent without replacing unspecified fields.",
    mutation: true,
    transport: { api: { method: "PATCH", path: "/api/agent/notes/{id}" } },
    headers: agentHeaders,
    parameters: { id: recordId("note") },
    inputSchema: object({ title: string("Replacement title.", { maxLength: 300 }), text: string("Replacement note text."), agentIntent: { enum: ["reference_only", "review_requested"] } }),
    rules: ["Send only fields that should change.", "The service rejects changes to human notes and notes owned by another agent.", "Do not treat review_requested as authorization to modify the project."],
    example: { agentIntent: "review_requested" },
  },
  {
    id: "notes.request-review",
    category: "notes",
    artifactType: "note",
    summary: "Save the current note and request prompt agent review without authorizing changes.",
    mutation: true,
    recipeFor: "notes.update",
    transport: { api: { method: "PATCH", path: "/api/agent/notes/{id}" } },
    headers: agentHeaders,
    parameters: { id: recordId("note") },
    inputSchema: object({ agentIntent: { const: "review_requested" }, title: string("Optional latest title."), text: string("Optional latest text; include unsaved edits before requesting review.") }, ["agentIntent"]),
    rules: ["Persist any current edits in the same request.", "Review is analysis only; create a separate task or decision before implementation."],
    example: { text: "Evaluate whether this constraint still applies.", agentIntent: "review_requested" },
  },
  {
    id: "notes.delete",
    category: "notes",
    artifactType: "note",
    summary: "Delete a note created by this same agent when the user explicitly authorizes it.",
    mutation: true,
    destructive: true,
    transport: { api: { method: "DELETE", path: "/api/agent/notes/{id}" } },
    headers: agentHeaders,
    parameters: { id: recordId("note") },
    rules: ["Delete only with explicit user authorization.", "The service rejects deletion of human notes and notes owned by another agent."],
  },
  {
    id: "ideas.list",
    category: "ideas",
    artifactType: "idea",
    summary: "List ideas and find explicit evaluation requests.",
    mutation: false,
    transport: { cli: "work ideas", api: { method: "GET", path: "/api/ideas" } },
    rules: ["agentIntent evaluation_requested authorizes analysis only.", "Do not turn an idea into implementation without a separate authorized task."],
  },
  {
    id: "ideas.create",
    category: "ideas",
    artifactType: "idea",
    summary: "Record a possibility for later evaluation without turning it into executable work.",
    mutation: true,
    transport: { cli: "work idea \"title\" [--detail opportunity]", api: { method: "POST", path: "/api/ideas" } },
    inputSchema: object({
      title: string("One-line idea title.", { minLength: 1, maxLength: 500 }), scopePath, projectPath, tags: stringList("Searchable tags."), source: nullableString("Where the idea came from."),
      opportunity: string("What could be possible."), whyItMightMatter: string("Potential value."), hypothesis: string("What would have to be true."), unknowns: string("Questions to investigate."), potentialShape: string("A possible implementation shape."), evidence: string("Supporting or contrary evidence."), risksAndConstraints: string("Known risks and constraints."), nextEvaluation: string("The next useful evaluation step."), outcome: string("Current evaluation outcome."),
    }, ["title"]),
    rules: ["An idea never authorizes implementation.", "Leave unknown sections empty rather than inventing content."],
    example: { title: "Federate remote Work instances", opportunity: "See project trees across servers.", projectPath: null },
  },
  {
    id: "ideas.update",
    category: "ideas",
    artifactType: "idea",
    summary: "Update an idea, transition its state, or request evaluation.",
    mutation: true,
    transport: { api: { method: "PATCH", path: "/api/ideas/{id}" } },
    parameters: { id: recordId("idea") },
    inputSchema: object({
      title: string("Replacement one-line title."), projectPath, scopePath, tags: stringList("Replacement tags."), revisitAt: nullableString("ISO date/time to revisit."),
      agentIntent: { enum: ["consideration_only", "evaluation_requested"] }, status: { enum: ["open", "exploring", "deferred", "proposed", "adopted", "declined"] }, reason: string("Required when deferring or declining."),
      opportunity: string("Updated opportunity."), whyItMightMatter: string("Updated potential value."), hypothesis: string("Updated hypothesis."), unknowns: string("Updated unknowns."), potentialShape: string("Updated possible shape."), evidence: string("Updated evidence."), risksAndConstraints: string("Updated risks."), nextEvaluation: string("Updated next evaluation."), outcome: string("Updated outcome."),
    }),
    rules: ["Send only fields that should change.", "Deferred and declined transitions require a reason.", "Adopted means the idea was accepted conceptually; executable work still belongs in a task."],
    example: { status: "deferred", reason: "Remote authentication is not designed yet.", revisitAt: "2027-01-15T12:00:00.000Z" },
  },
  {
    id: "ideas.request-evaluation",
    category: "ideas",
    artifactType: "idea",
    summary: "Save current idea edits and explicitly request agent evaluation.",
    mutation: true,
    recipeFor: "ideas.update",
    transport: { api: { method: "PATCH", path: "/api/ideas/{id}" } },
    parameters: { id: recordId("idea") },
    inputSchema: object({ agentIntent: { const: "evaluation_requested" }, status: { enum: ["open", "exploring", "proposed"] }, opportunity: string("Optional latest opportunity."), unknowns: string("Optional latest unknowns."), nextEvaluation: string("Optional evaluation request.") }, ["agentIntent"]),
    rules: ["Persist current edits before or with the request.", "Evaluation authorizes analysis only, never implementation."],
    example: { status: "exploring", agentIntent: "evaluation_requested", nextEvaluation: "Assess feasibility and identify the smallest useful experiment." },
  },
  {
    id: "ideas.delete",
    category: "ideas",
    artifactType: "idea",
    summary: "Delete an idea the user abandoned before it became durable project history.",
    mutation: true,
    destructive: true,
    transport: { api: { method: "DELETE", path: "/api/ideas/{id}" } },
    parameters: { id: recordId("idea") },
    rules: ["Prefer deferred or declined when the evaluation outcome is worth retaining.", "Delete only with explicit user authorization."],
  },
  {
    id: "decisions.list",
    category: "decisions",
    artifactType: "decision",
    summary: "List decision records and identify choices still waiting for a human.",
    mutation: false,
    transport: { api: { method: "GET", path: "/api/decisions" } },
    rules: ["An open decision records a pending choice, not approval.", "Do not resolve a decision without the human's explicit choice.", "When options are present, record the selected option; otherwise record the human's written response."],
  },
  {
    id: "decisions.create",
    category: "decisions",
    artifactType: "decision",
    summary: "Create an explicit human decision request.",
    mutation: true,
    transport: { cli: "work decision \"question\" --option \"choice\"", api: { method: "POST", path: "/api/decisions" } },
    inputSchema: object({ title: string("One-line decision question.", { minLength: 1 }), detail: string("Decision context."), projectPath, options: stringList("Explicit choices."), recommendedOption: nullableString("Optional recommendation. When set, it must exactly match one recorded option.") }, ["title"]),
    rules: ["Creating a decision does not imply approval.", "Recommend an option when the available context supports a useful recommendation; otherwise leave recommendedOption null.", "A recommendation must exactly match one recorded option and never preselects it for the human.", "Keep it unassigned unless the project is explicit."],
    example: { title: "Where should the lab live?", options: ["Keep unassigned", "Assign later"], recommendedOption: "Keep unassigned", projectPath: null },
  },
  {
    id: "decisions.resolve",
    category: "decisions",
    artifactType: "decision",
    summary: "Record an explicit action on an existing decision.",
    mutation: true,
    transport: { api: { method: "POST", path: "/api/decisions/{id}/actions" } },
    parameters: { id: recordId("decision") },
    inputSchema: object({ action: { enum: ["approve", "reject", "defer", "cancel", "assign", "keep_unassigned", "reopen"] }, choice: { type: ["object", "null"] }, note: nullableString("Reason or context for the action.") }, ["action"]),
    rules: ["Record only an action the human explicitly chose.", "Do not translate discussion, a recommendation, or an open card into approval.", "For an option decision, approve with choice.option set to the exact recorded option. Use choice.option Other with the human's required written answer in note when none fit. For a decision without options, put the human's written response in note."],
    example: { action: "defer", choice: { until: "2027-01-15T12:00:00.000Z" }, note: "Revisit after authentication work." },
  },
  {
    id: "tasks.list",
    category: "tasks",
    artifactType: "task",
    summary: "List board items and their stable identifiers.",
    mutation: false,
    transport: { cli: "work list", api: { method: "GET", path: "/api/tasks" } },
    rules: ["Use stable IDs for every later update."],
  },
  {
    id: "tasks.get",
    category: "tasks",
    artifactType: "task",
    summary: "Read one complete board item before changing it.",
    mutation: false,
    transport: { cli: "work show W-0001", api: { method: "GET", path: "/api/tasks/{id}" } },
    parameters: { id: taskId },
    rules: ["Read the current item before applying a nontrivial update."],
  },
  {
    id: "tasks.create",
    category: "tasks",
    artifactType: "task",
    summary: "Create a durable, executable Kanban item.",
    mutation: true,
    transport: { cli: "work task \"title\" [options]", api: { method: "POST", path: "/api/tasks" } },
    inputSchema: object({
      title: string("One-line actionable title.", { minLength: 1, maxLength: 500 }), projectPath, type: { enum: ["task", "bug", "feature", "research", "admin", "epic", "idea"] }, status: string("Configured board status."), priority: { enum: ["critical", "high", "medium", "low", "none"] }, assignee: nullableString("Human owner."), agents: stringList("Agent or team owners."), tags: stringList("Searchable tags."), dependsOn: stringList("Task IDs that must finish first."), blockedBy: stringList("Task IDs currently blocking this item."), blockedReason: nullableString("Why the item is blocked."), parentId: { oneOf: [taskId, { type: "null" }] }, dueAt: nullableString("ISO date/time."), estimate: nullableString("Human-readable estimate."), source: nullableString("Origin of the task."), goal: string("Desired outcome."), requirements: stringList("Requirement checklist text."), acceptanceCriteria: stringList("Observable completion criteria."), plan: string("Current execution plan."), notes: string("Supporting context."),
    }, ["title"]),
    rules: ["Create executable work only when action is authorized.", "Use projects.list before assigning projectPath.", "Write observable acceptance criteria.", "Do not mark dependencies complete implicitly."],
    example: { title: "Implement agent capability discovery", type: "feature", priority: "high", projectPath: null, goal: "Let fresh agents discover scoped Work instructions.", acceptanceCriteria: ["CLI prints task-scoped instructions", "API serves the same catalog"] },
  },
  {
    id: "tasks.update",
    category: "tasks",
    artifactType: "task",
    summary: "Patch selected task fields while retaining lifecycle history.",
    mutation: true,
    transport: { api: { method: "PATCH", path: "/api/tasks/{id}" } },
    parameters: { id: taskId },
    inputSchema: object({ title: string("Replacement title."), projectPath, type: { enum: ["task", "bug", "feature", "research", "admin", "epic", "idea"] }, status: string("New configured status."), statusNote: string("Context for the status transition."), priority: { enum: ["critical", "high", "medium", "low", "none"] }, assignee: nullableString("Human owner."), agents: stringList("Agent owners."), tags: stringList("Replacement tags."), dependsOn: stringList("Replacement dependency IDs."), blockedBy: stringList("Replacement blocker IDs."), blockedReason: nullableString("Blocker context."), parentId: { oneOf: [taskId, { type: "null" }] }, dueAt: nullableString("ISO date/time."), estimate: nullableString("Estimate."), goal: string("Replacement goal."), requirements: stringList("Replacement requirements."), acceptanceCriteria: stringList("Replacement acceptance criteria."), plan: string("Replacement plan."), notes: string("Replacement notes."), completionSummary: string("Summary of completed work.") }),
    rules: ["Read the current task first.", "Send only fields that should change.", "Use tasks.move for a status-only transition."],
    example: { priority: "high", plan: "Add one shared catalog module, then expose two adapters." },
  },
  {
    id: "tasks.move",
    category: "tasks",
    artifactType: "task",
    summary: "Transition a task to another board state and append lifecycle history.",
    mutation: true,
    transport: { cli: "work move W-0001 in_progress --note \"Started\"", api: { method: "POST", path: "/api/tasks/{id}/move" } },
    parameters: { id: taskId },
    inputSchema: object({ status: string("Configured destination status."), note: string("Optional transition context.") }, ["status"]),
    rules: ["Do not move a task to done while dependencies are unfinished.", "Verify and check every requirement and acceptance criterion before moving to review.", "Include a note when the reason is not obvious."],
    example: { status: "in_progress", note: "Agent began implementation." },
  },
  {
    id: "tasks.checklist",
    category: "tasks",
    artifactType: "task",
    summary: "Check or reopen one requirement or acceptance criterion.",
    mutation: true,
    transport: { api: { method: "POST", path: "/api/tasks/{id}/checklist" } },
    parameters: { id: taskId },
    inputSchema: object({ section: { enum: ["requirements", "acceptance"] }, index: { type: "integer", minimum: 0 }, checked: { type: "boolean" } }, ["section", "index", "checked"]),
    rules: ["Read the current task to obtain the checklist index.", "Change only the item whose result has been verified.", "All requirements and acceptance criteria must be verified and checked before moving a task to review."],
    example: { section: "acceptance", index: 0, checked: true },
  },
  {
    id: "tasks.log",
    category: "tasks",
    artifactType: "task",
    summary: "Append a durable progress entry without changing task state.",
    mutation: true,
    transport: { cli: "work log W-0001 \"Tests pass\"", api: { method: "POST", path: "/api/tasks/{id}/log" } },
    parameters: { id: taskId },
    inputSchema: object({ message: string("Concise factual progress update.", { minLength: 1, maxLength: 20000 }) }, ["message"]),
    rules: ["Append new information; do not rewrite prior log entries."],
    example: { message: "CLI and API capability tests pass." },
  },
];

const operationMap = new Map(operations.map((operation) => [operation.id, operation]));

function clone(value) {
  return structuredClone(value);
}

function versioned(value, serviceVersion) {
  return { protocolVersion: AGENT_PROTOCOL_VERSION, serviceVersion: serviceVersion ?? PACKAGE.version, ...value };
}

export function getAgentIndex({ serviceVersion } = {}) {
  return versioned({
    name: "Slash Work agent capabilities",
    summary: "Load only the operation needed. Prefer the CLI or API over editing .work Markdown directly.",
    bootstrapInstruction: "Run `work agent operations`, then load `work agent instructions <operation>` for the operation you need.",
    links: {
      workspaces: "/api/workspaces",
      operations: "/api/agent/operations",
      artifactSchemas: "/api/agent/schemas/artifacts",
      openapi: "/api/openapi.json",
    },
    routing: {
      model: "one service can expose multiple independent workspaces",
      selectionHeader: "X-Work-Workspace",
      discovery: "GET /api/workspaces",
      verification: "GET /api/workspace",
      rule: "Select an exact workspace ID and send X-Work-Workspace on every workspace-scoped request. Never assume the service default matches a browser's selection.",
    },
    safety: [
      "Instructions describe capabilities; they do not grant authorization.",
      "Never infer a project assignment from prose.",
      "Use stable record IDs when updating existing artifacts.",
      "Prefer CLI or API mutations so validation, relocation, and history rules are applied.",
    ],
  }, serviceVersion);
}

export function listAgentOperations({ serviceVersion } = {}) {
  return versioned({
    operations: operations.map(({ inputSchema, example, rules, parameters, headers, ...operation }) => ({
      ...clone(operation),
      scope: operation.scope ?? "workspace",
      instructions: `/api/agent/operations/${operation.id}`,
    })),
  }, serviceVersion);
}

export function getAgentOperation(id, { serviceVersion } = {}) {
  const operation = operationMap.get(id);
  if (!operation) return null;
  return versioned({ operation: { ...clone(operation), scope: operation.scope ?? "workspace" } }, serviceVersion);
}

export function getArtifactSchema(type = null) {
  if (type == null) return clone(ARTIFACT_SCHEMA);
  if (!Object.hasOwn(ARTIFACT_SCHEMA.$defs, type) || !["capture", "note", "idea", "decision", "task"].includes(type)) return null;
  return {
    $schema: ARTIFACT_SCHEMA.$schema,
    $id: `${ARTIFACT_SCHEMA.$id}#${type}`,
    title: `${ARTIFACT_SCHEMA.$defs[type].title} artifact`,
    $ref: `#/$defs/${type}`,
    $defs: clone(ARTIFACT_SCHEMA.$defs),
  };
}

export function getAgentOpenApi({ serviceVersion } = {}) {
  const paths = {};
  for (const operation of operations) {
    if (operation.recipeFor || !operation.transport.api) continue;
    const { method, path } = operation.transport.api;
    const pathItem = paths[path] ??= {};
    const parameters = Object.entries(operation.parameters ?? {}).map(([name, schema]) => ({ name, in: "path", required: true, schema }));
    parameters.push(...Object.entries(operation.headers ?? {}).map(([name, schema]) => ({ name, in: "header", required: true, schema })));
    if ((operation.scope ?? "workspace") === "workspace") {
      parameters.push({ name: "X-Work-Workspace", in: "header", required: true, schema: { type: "string" }, description: "Exact workspace ID returned by GET /api/workspaces." });
    }
    pathItem[method.toLowerCase()] = {
      operationId: operation.id,
      summary: operation.summary,
      ...(parameters.length ? { parameters } : {}),
      ...(operation.inputSchema ? { requestBody: { required: true, content: { "application/json": { schema: operation.inputSchema } } } } : {}),
      responses: {
        [method === "POST" && !path.includes("/move") && !path.includes("/log") && !path.includes("/checklist") && !path.includes("/actions") ? "201" : method === "DELETE" ? "204" : "200"]: { description: "Successful response" },
        default: { description: "Work API error", content: { "application/json": { schema: { type: "object" } } } },
      },
      "x-work-rules": clone(operation.rules ?? []),
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Slash Work local API", version: serviceVersion ?? PACKAGE.version, description: "Local-first artifact operations. Instructions describe capabilities and do not grant authorization." },
    servers: [{ url: "/", description: "The current Work service" }],
    paths,
    "x-work-protocol-version": AGENT_PROTOCOL_VERSION,
    "x-work-capabilities": "/api/agent",
  };
}

export function renderAgentIndexMarkdown({ serviceVersion } = {}) {
  const index = getAgentIndex({ serviceVersion });
  return `# ${index.name}\n\nProtocol ${index.protocolVersion} · Work ${index.serviceVersion}\n\n${index.summary}\n\n## Bootstrap\n\n${index.bootstrapInstruction}\n\n## Service and workspace routing\n\nOne service can expose multiple independent workspaces. Call \`${index.routing.discovery}\`, choose the exact workspace ID, send \`${index.routing.selectionHeader}\` on every workspace-scoped request, and verify with \`${index.routing.verification}\`. The service default is only a fallback and may not match a browser tab.\n\n## Safety\n\n${index.safety.map((rule) => `- ${rule}`).join("\n")}\n`;
}

export function renderAgentOperationsMarkdown({ serviceVersion } = {}) {
  const catalog = listAgentOperations({ serviceVersion });
  const groups = Map.groupBy(catalog.operations, (operation) => operation.category);
  const sections = [...groups].map(([category, entries]) => `## ${category}\n\n${entries.map((entry) => `- \`${entry.id}\` — ${entry.summary}`).join("\n")}`);
  return `# Slash Work operations\n\nProtocol ${catalog.protocolVersion} · Work ${catalog.serviceVersion}\n\nLoad one operation with \`work agent instructions <operation>\`.\n\n${sections.join("\n\n")}\n`;
}

export function renderAgentOperationMarkdown(id, { serviceVersion } = {}) {
  const result = getAgentOperation(id, { serviceVersion });
  if (!result) return null;
  const { operation } = result;
  const transport = [operation.transport.cli ? `- CLI: \`${operation.transport.cli}\`` : null, operation.transport.api ? `- API: \`${operation.transport.api.method} ${operation.transport.api.path}\`` : null, operation.scope === "workspace" ? "- Scope: workspace; send `X-Work-Workspace` with the exact selected ID" : "- Scope: service; no workspace header required"].filter(Boolean).join("\n");
  return `# ${operation.id}\n\n${operation.summary}\n\nProtocol ${result.protocolVersion} · Work ${result.serviceVersion}\n\n## Interface\n\n${transport}\n\n## Rules\n\n${(operation.rules ?? []).map((rule) => `- ${rule}`).join("\n")}\n${operation.parameters ? `\n## Path parameters\n\n\`\`\`json\n${JSON.stringify(operation.parameters, null, 2)}\n\`\`\`\n` : ""}${operation.inputSchema ? `\n## Input schema\n\n\`\`\`json\n${JSON.stringify(operation.inputSchema, null, 2)}\n\`\`\`\n` : ""}${operation.example ? `\n## Example input\n\n\`\`\`json\n${JSON.stringify(operation.example, null, 2)}\n\`\`\`\n` : ""}`;
}
