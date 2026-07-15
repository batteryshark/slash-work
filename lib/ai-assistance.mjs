import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import {
  WorkspaceError,
  discoverProjects,
  getTask,
  listDecisions,
  listIdeas,
  listTasks,
} from "./local-workspace.mjs";

const CONFIG_VERSION = 2;
const LEGACY_CONFIG_VERSION = 1;
const PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PROVIDERS = new Set(["openai-compatible", "anthropic-compatible"]);
const TERMINAL_TASKS = new Set(["done", "cancelled", "archived"]);
const CLOSED_IDEAS = new Set(["adopted", "declined"]);
const CREDENTIAL_SERVICE = "slash-work";
const CREDENTIAL_ACCOUNT = "ai-provider-api-key";
let insecureDispatcherPromise = null;

const FIELD_LABELS = {
  title: "Title",
  priority: "Priority",
  tags: "Tags",
  estimate: "Estimate",
  goal: "Goal",
  plan: "Plan",
  notes: "Notes",
  requirements: "Requirements",
  acceptanceCriteria: "Acceptance criteria",
  completionSummary: "Completion summary",
  opportunity: "Opportunity",
  whyItMightMatter: "Why it might matter",
  hypothesis: "Hypothesis",
  unknowns: "Unknowns",
  potentialShape: "Potential shape",
  evidence: "Evidence",
  risksAndConstraints: "Risks and constraints",
  nextEvaluation: "Next evaluation",
  outcome: "Outcome",
};

const OPERATIONS = {
  task: {
    draft: ["title", "priority", "tags", "estimate", "goal", "requirements", "acceptanceCriteria", "plan", "notes"],
    review: ["goal", "requirements", "acceptanceCriteria", "plan", "notes", "completionSummary"],
  },
  idea: {
    expand: ["title", "tags", "opportunity", "whyItMightMatter", "hypothesis", "unknowns", "potentialShape", "evidence", "risksAndConstraints", "nextEvaluation"],
    evaluate: ["whyItMightMatter", "hypothesis", "unknowns", "evidence", "risksAndConstraints", "nextEvaluation", "outcome"],
  },
};

export function aiConfigPath() {
  return process.env.WORK_AI_CONFIG_FILE ?? join(homedir(), ".work", "ai.json");
}

export function systemAiCredentialStore() {
  async function entry() {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT);
  }
  return {
    async get() {
      return (await (await entry()).getPassword()) ?? null;
    },
    async set(value) {
      await (await entry()).setPassword(value);
    },
    async delete() {
      return (await entry()).deleteCredential();
    },
  };
}

const defaultCredentialStore = systemAiCredentialStore();

function cleanBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceError("AI base URL is required.", { code: "invalid_ai_settings" });
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new WorkspaceError("AI base URL must be a valid HTTP or HTTPS URL.", { code: "invalid_ai_settings" });
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new WorkspaceError("AI base URL must use HTTP or HTTPS.", { code: "invalid_ai_settings" });
  }
  return parsed.toString().replace(/\/$/, "");
}

function cleanModel(value) {
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceError("AI model is required.", { code: "invalid_ai_settings" });
  if (value.trim().length > 200) throw new WorkspaceError("AI model is too long.", { code: "invalid_ai_settings" });
  return value.trim();
}

function cleanProvider(value) {
  const provider = value ?? "openai-compatible";
  if (!PROVIDERS.has(provider)) throw new WorkspaceError("Choose an OpenAI-compatible or Anthropic-compatible provider format.", { code: "invalid_ai_settings" });
  return provider;
}

async function readStoredConfig(pathname = aiConfigPath()) {
  try {
    const parsed = JSON.parse(await readFile(pathname, "utf8"));
    if (![CONFIG_VERSION, LEGACY_CONFIG_VERSION].includes(parsed?.version)) throw new Error("Unsupported version");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new WorkspaceError("AI settings are not valid JSON.", { code: "invalid_ai_config", status: 500 });
  }
}

async function writeStoredConfig(config, pathname) {
  await mkdir(dirname(pathname), { recursive: true, mode: 0o700 });
  const temporary = `${pathname}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, pathname);
}

function credentialError(error, action) {
  return new WorkspaceError(`The operating system credential store could not ${action} the AI API key. Use WORK_AI_API_KEY on a headless system.`, {
    code: "ai_credential_store_unavailable",
    status: 503,
    cause: error,
  });
}

async function credentialGet(store) {
  try {
    return await store.get();
  } catch (error) {
    throw credentialError(error, "read");
  }
}

async function credentialSet(store, value) {
  try {
    await store.set(value);
  } catch (error) {
    throw credentialError(error, "save");
  }
}

async function credentialDelete(store) {
  try {
    await store.delete();
  } catch (error) {
    throw credentialError(error, "remove");
  }
}

async function loadConfig(pathname, credentialStore) {
  const stored = await readStoredConfig(pathname);
  if (!stored || stored.version === CONFIG_VERSION) return stored;
  const legacyKey = typeof stored.apiKey === "string" ? stored.apiKey.trim() : "";
  if (legacyKey) await credentialSet(credentialStore, legacyKey);
  const migrated = {
    version: CONFIG_VERSION,
    provider: stored.provider ?? "openai-compatible",
    baseUrl: stored.baseUrl,
    model: stored.model,
    allowSelfSigned: false,
    credentialStorage: legacyKey ? "system" : null,
    updatedAt: new Date().toISOString(),
  };
  await writeStoredConfig(migrated, pathname);
  return migrated;
}

async function resolveCredential(config, credentialStore) {
  const environmentKey = process.env.WORK_AI_API_KEY?.trim();
  if (environmentKey) return { apiKey: environmentKey, source: "environment" };
  if (config?.credentialStorage !== "system") return { apiKey: "", source: "none" };
  const apiKey = (await credentialGet(credentialStore))?.trim() ?? "";
  return { apiKey, source: apiKey ? "system" : "none" };
}

function publicConfig(config, credential) {
  return {
    configured: Boolean(config?.baseUrl && config?.model && credential.apiKey),
    provider: config?.provider ?? "openai-compatible",
    baseUrl: config?.baseUrl ?? "https://api.openai.com/v1",
    model: config?.model ?? "",
    allowSelfSigned: config?.allowSelfSigned === true,
    hasApiKey: Boolean(credential.apiKey),
    apiKeyHint: credential.apiKey ? `••••${credential.apiKey.slice(-4)}` : null,
    credentialSource: credential.source,
  };
}

export async function getAiSettings(pathname = aiConfigPath(), credentialStore = defaultCredentialStore) {
  const config = await loadConfig(pathname, credentialStore);
  return publicConfig(config, await resolveCredential(config, credentialStore));
}

export async function saveAiSettings(input, pathname = aiConfigPath(), credentialStore = defaultCredentialStore) {
  const current = await loadConfig(pathname, credentialStore);
  let credentialStorage = current?.credentialStorage ?? null;
  if (input?.clearApiKey === true) {
    if (credentialStorage === "system") await credentialDelete(credentialStore);
    credentialStorage = null;
  } else if (typeof input?.apiKey === "string" && input.apiKey.trim()) {
    await credentialSet(credentialStore, input.apiKey.trim());
    credentialStorage = "system";
  }
  const config = {
    version: CONFIG_VERSION,
    provider: cleanProvider(input?.provider),
    baseUrl: cleanBaseUrl(input?.baseUrl),
    model: cleanModel(input?.model),
    allowSelfSigned: input?.allowSelfSigned === true,
    credentialStorage,
    updatedAt: new Date().toISOString(),
  };
  await writeStoredConfig(config, pathname);
  return publicConfig(config, await resolveCredential(config, credentialStore));
}

function endpointFor(config) {
  if (config.provider === "anthropic-compatible") {
    if (config.baseUrl.endsWith("/messages")) return config.baseUrl;
    if (config.baseUrl.endsWith("/v1")) return `${config.baseUrl}/messages`;
    return `${config.baseUrl}/v1/messages`;
  }
  return config.baseUrl.endsWith("/chat/completions") ? config.baseUrl : `${config.baseUrl}/chat/completions`;
}

async function modelRequest(config, apiKey, messages, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!config?.baseUrl || !config?.model || !apiKey) {
    throw new WorkspaceError("Configure an AI base URL, model, and API key first.", { code: "ai_not_configured", status: 409 });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  let response;
  try {
    const anthropic = config.provider === "anthropic-compatible";
    const endpoint = endpointFor(config);
    let requestFetch = fetchImpl;
    let dispatcher;
    if (config.allowSelfSigned === true && endpoint.startsWith("https://")) {
      const { Agent, fetch: undiciFetch } = await import("undici");
      insecureDispatcherPromise ??= Promise.resolve(new Agent({ connect: { rejectUnauthorized: false } }));
      dispatcher = await insecureDispatcherPromise;
      if (fetchImpl === globalThis.fetch) requestFetch = undiciFetch;
    }
    response = await requestFetch(endpoint, {
      method: "POST",
      headers: anthropic
        ? { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(anthropic
        ? {
            model: config.model,
            max_tokens: 4_096,
            temperature: 0.2,
            system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
            messages: messages.filter((message) => message.role !== "system"),
          }
        : { model: config.model, messages, temperature: 0.2, response_format: { type: "json_object" } }),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new WorkspaceError(`The AI request timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`, { code: "ai_timeout", status: 504 });
    throw new WorkspaceError(`The AI endpoint could not be reached: ${error.message}`, { code: "ai_unavailable", status: 502 });
  } finally {
    clearTimeout(timeout);
  }
  const content = await response.text();
  if (Buffer.byteLength(content) > MAX_RESPONSE_BYTES) {
    throw new WorkspaceError("The AI response exceeded the 256 KB limit.", { code: "ai_response_too_large", status: 502 });
  }
  if (!response.ok) {
    throw new WorkspaceError(`The AI endpoint returned HTTP ${response.status}.`, { code: "ai_provider_error", status: 502 });
  }
  let envelope;
  try {
    envelope = JSON.parse(content);
  } catch {
    throw new WorkspaceError("The AI endpoint returned invalid JSON.", { code: "ai_invalid_response", status: 502 });
  }
  const message = config.provider === "anthropic-compatible"
    ? envelope?.content?.find((item) => item?.type === "text")?.text
    : envelope?.choices?.[0]?.message?.content;
  if (typeof message !== "string") throw new WorkspaceError("The AI response did not contain a message.", { code: "ai_invalid_response", status: 502 });
  const unwrapped = message.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unwrapped);
  } catch {
    throw new WorkspaceError("The AI message was not valid structured JSON.", { code: "ai_invalid_response", status: 502 });
  }
}

export async function testAiSettings(pathname = aiConfigPath(), fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, credentialStore = defaultCredentialStore) {
  const config = await loadConfig(pathname, credentialStore);
  const { apiKey } = await resolveCredential(config, credentialStore);
  const result = await modelRequest(config, apiKey, [
    { role: "system", content: "Return JSON only." },
    { role: "user", content: "Return exactly {\"ok\":true}." },
  ], fetchImpl, timeoutMs);
  if (result?.ok !== true) throw new WorkspaceError("The AI endpoint responded, but not with the expected test result.", { code: "ai_test_failed", status: 502 });
  return { ok: true, model: config.model, baseUrl: config.baseUrl };
}

function clip(value, length = 4_000) {
  if (typeof value !== "string") return value;
  return value.length <= length ? value : `${value.slice(0, length)}\n[…truncated]`;
}

function artifactValue(artifactType, artifact, field) {
  if (field === "requirements" || field === "acceptanceCriteria") {
    return artifact[field].map((item) => ({ checked: item.checked, text: item.text }));
  }
  if (artifactType === "task" && new Set(["goal", "plan", "notes", "completionSummary"]).has(field)) return artifact.sections[field];
  if (artifactType === "idea" && field in artifact.sections) return artifact.sections[field];
  return artifact[field] ?? null;
}

function compactTask(task) {
  return { id: task.id, title: task.title, status: task.status, priority: task.priority, dueAt: task.dueAt, blockedBy: task.blockedBy, parentId: task.parentId };
}

function compactDecision(decision) {
  return { id: decision.id, title: decision.title, detail: clip(decision.detail, 600), status: decision.status, options: decision.options };
}

function compactIdea(idea) {
  return { id: idea.id, title: idea.title, status: idea.status, opportunity: clip(idea.sections.opportunity, 600), unknowns: clip(idea.sections.unknowns, 600) };
}

function compactSelectedArtifact(artifactType, artifact) {
  const common = {
    id: artifact.id,
    title: artifact.title,
    projectPath: artifact.projectPath,
    status: artifact.status,
    tags: Array.isArray(artifact.tags) ? artifact.tags.slice(0, 30) : [],
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
  if (artifactType === "task") {
    return {
      ...common,
      priority: artifact.priority,
      estimate: artifact.estimate,
      dueAt: artifact.dueAt,
      parentId: artifact.parentId,
      dependsOn: artifact.dependsOn?.slice(0, 30) ?? [],
      blockedBy: artifact.blockedBy?.slice(0, 30) ?? [],
      requirements: artifact.requirements?.slice(0, 50).map((item) => ({ checked: item.checked, text: clip(item.text, 1_000) })) ?? [],
      acceptanceCriteria: artifact.acceptanceCriteria?.slice(0, 50).map((item) => ({ checked: item.checked, text: clip(item.text, 1_000) })) ?? [],
      sections: Object.fromEntries(Object.entries(artifact.sections ?? {}).map(([key, value]) => [key, clip(value, 4_000)])),
    };
  }
  return {
    ...common,
    horizon: artifact.horizon,
    outcome: clip(artifact.outcome, 4_000),
    sections: Object.fromEntries(Object.entries(artifact.sections ?? {}).map(([key, value]) => [key, clip(value, 4_000)])),
  };
}

async function proposalContext(workspace, artifactType, artifact) {
  const [projects, tasks, decisions, ideas] = await Promise.all([
    discoverProjects(workspace.root), listTasks(workspace), listDecisions(workspace), listIdeas(workspace),
  ]);
  const project = projects.find((item) => item.path === artifact.projectPath) ?? null;
  const sameProject = (item) => item.projectPath === artifact.projectPath;
  const activeTasks = tasks.filter((item) => sameProject(item) && !TERMINAL_TASKS.has(item.status));
  const openDecisions = decisions.filter((item) => sameProject(item) && new Set(["open", "deferred"]).has(item.status));
  const activeIdeas = ideas.filter((item) => sameProject(item) && !CLOSED_IDEAS.has(item.status));
  const relatedIds = artifactType === "task" ? new Set([artifact.parentId, ...artifact.dependsOn, ...artifact.blockedBy].filter(Boolean)) : new Set();
  return {
    workspace: { id: workspace.id, name: workspace.name },
    project: project ? { name: project.name, path: project.path, description: clip(project.description, 3_000) } : null,
    selectedArtifact: compactSelectedArtifact(artifactType, artifact),
    relatedTasks: tasks.filter((item) => relatedIds.has(item.id)).slice(0, 10).map(compactTask),
    activeTasks: activeTasks.filter((item) => item.id !== artifact.id).slice(0, 25).map(compactTask),
    openDecisions: openDecisions.slice(0, 15).map(compactDecision),
    activeIdeas: activeIdeas.filter((item) => item.id !== artifact.id).slice(0, 15).map(compactIdea),
    truncation: {
      activeTasks: { included: Math.min(activeTasks.length, 25), total: activeTasks.length },
      openDecisions: { included: Math.min(openDecisions.length, 15), total: openDecisions.length },
      activeIdeas: { included: Math.min(activeIdeas.length, 15), total: activeIdeas.length },
    },
  };
}

async function selectedArtifact(workspace, artifactType, artifactId) {
  if (artifactType === "task") return getTask(workspace, artifactId);
  if (artifactType === "idea") {
    const idea = (await listIdeas(workspace)).find((item) => item.id === artifactId);
    if (!idea) throw new WorkspaceError(`Idea not found: ${artifactId}`, { code: "idea_not_found", status: 404 });
    return idea;
  }
  throw new WorkspaceError("AI assistance currently supports tasks and ideas.", { code: "unsupported_ai_artifact" });
}

function proposalInstructions(artifactType, operation, allowedFields) {
  const intent = operation === "review"
    ? "Review this task for clarity and readiness. Do not mark checklist items complete or change lifecycle status."
    : operation === "evaluate"
      ? "Evaluate this idea's value, feasibility, unknowns, evidence, risks, and next evaluation without authorizing implementation."
      : `Help the human ${operation} this ${artifactType}.`;
  return `${intent}\nReturn one JSON object with keys summary, explanation, questions, and patch. patch may contain only these fields: ${allowedFields.join(", ")}. Omit fields that do not materially improve. questions must be an array of strings. Preserve facts; do not claim work was completed without evidence. Requirements and acceptanceCriteria must be arrays of concise strings.`;
}

function normalizeProposed(field, value) {
  if (field === "requirements" || field === "acceptanceCriteria") {
    if (!Array.isArray(value)) return null;
    return value.map((item) => typeof item === "string" ? item.trim() : typeof item?.text === "string" ? item.text.trim() : "").filter(Boolean).slice(0, 50).map((text) => ({ checked: false, text }));
  }
  if (field === "tags") {
    if (!Array.isArray(value)) return null;
    return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 30);
  }
  if (field === "priority") return new Set(["critical", "high", "medium", "low", "none"]).has(value) ? value : null;
  if (value == null) return null;
  return typeof value === "string" ? clip(value.trim(), 12_000) : null;
}

export async function createAiProposal(workspace, input, {
  configPath = aiConfigPath(),
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  credentialStore = defaultCredentialStore,
} = {}) {
  const artifactType = input?.artifactType;
  const operation = input?.operation;
  const artifactId = input?.artifactId;
  const allowedFields = OPERATIONS[artifactType]?.[operation];
  if (!allowedFields || typeof artifactId !== "string" || !artifactId) {
    throw new WorkspaceError("Choose a supported AI operation and artifact.", { code: "invalid_ai_operation" });
  }
  const artifact = await selectedArtifact(workspace, artifactType, artifactId);
  const context = await proposalContext(workspace, artifactType, artifact);
  const config = await loadConfig(configPath, credentialStore);
  const { apiKey } = await resolveCredential(config, credentialStore);
  const result = await modelRequest(config, apiKey, [
    { role: "system", content: "You assist with local project records. Return valid JSON only and follow the requested patch allowlist exactly." },
    { role: "user", content: `${proposalInstructions(artifactType, operation, allowedFields)}\n\nCONTEXT JSON:\n${JSON.stringify(context)}` },
  ], fetchImpl, timeoutMs);
  const patch = result?.patch && typeof result.patch === "object" && !Array.isArray(result.patch) ? result.patch : {};
  const fields = [];
  for (const field of allowedFields) {
    if (!(field in patch)) continue;
    const proposed = normalizeProposed(field, patch[field]);
    if (proposed == null) continue;
    const current = artifactValue(artifactType, artifact, field);
    if (JSON.stringify(current) === JSON.stringify(proposed)) continue;
    fields.push({ field, label: FIELD_LABELS[field] ?? field, current, proposed });
  }
  return {
    version: PROTOCOL_VERSION,
    artifactType,
    artifactId,
    artifactUpdatedAt: artifact.updatedAt,
    operation,
    summary: typeof result?.summary === "string" ? clip(result.summary.trim(), 2_000) : "AI proposal ready",
    explanation: typeof result?.explanation === "string" ? clip(result.explanation.trim(), 6_000) : "",
    questions: Array.isArray(result?.questions) ? result.questions.filter((item) => typeof item === "string").map((item) => clip(item.trim(), 1_000)).filter(Boolean).slice(0, 10) : [],
    fields,
    context: { project: context.project, truncation: context.truncation },
  };
}

export function selectedProposalPatch(proposal, selectedFields, currentArtifact) {
  if (proposal?.version !== PROTOCOL_VERSION || typeof proposal?.artifactUpdatedAt !== "string") {
    throw new WorkspaceError("The AI proposal protocol is not supported.", { code: "invalid_ai_proposal" });
  }
  if (currentArtifact.updatedAt !== proposal.artifactUpdatedAt) {
    throw new WorkspaceError("This artifact changed after the AI proposal was created. Generate a fresh proposal before applying it.", { code: "stale_ai_proposal", status: 409 });
  }
  if (!Array.isArray(selectedFields) || selectedFields.length === 0) throw new WorkspaceError("Select at least one proposed field.", { code: "empty_ai_selection" });
  const allowed = new Set(OPERATIONS[proposal.artifactType]?.[proposal.operation] ?? []);
  const selected = new Set(selectedFields);
  const patch = {};
  for (const item of proposal.fields ?? []) {
    if (selected.has(item.field) && allowed.has(item.field)) patch[item.field] = item.proposed;
  }
  if (Object.keys(patch).length === 0) throw new WorkspaceError("No valid proposed fields were selected.", { code: "empty_ai_selection" });
  return patch;
}
