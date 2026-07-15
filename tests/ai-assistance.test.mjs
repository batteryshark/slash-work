import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "work-ai-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "product", ".project"), { recursive: true });
  await writeFile(join(root, "product", ".project", "marker"), "");
  return { root, configPath: join(root, "private", "ai.json") };
}

async function apiRequest(origin, pathname, { body, ...options } = {}) {
  const response = await fetch(new URL(pathname, origin), {
    ...options,
    headers: body ? { "content-type": "application/json", ...options.headers } : options.headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, payload: response.status === 204 ? null : await response.json() };
}

function modelEnvelope(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function memoryCredentialStore(initial = null) {
  let value = initial;
  return {
    async get() { return value; },
    async set(next) { value = next; },
    async delete() { value = null; return true; },
    peek() { return value; },
  };
}

test("keeps provider credentials server-side and applies only confirmed proposal fields", async () => {
  const { root, configPath } = await fixture();
  const aiCredentialStore = memoryCredentialStore();
  const calls = [];
  const aiFetch = async (url, options) => {
    calls.push({ url, options, request: JSON.parse(options.body) });
    const prompt = JSON.parse(options.body).messages.at(-1).content;
    if (prompt.includes("Return exactly")) return modelEnvelope({ ok: true });
    return modelEnvelope({
      summary: "A clearer task draft",
      explanation: "The project context supports a narrower outcome.",
      questions: ["Who owns the rollout?"],
      patch: {
        title: "Ship a focused AI drafting flow",
        goal: "Give humans a safe, one-shot drafting assistant.",
        acceptanceCriteria: ["A human previews every change", "Only selected fields are saved"],
        status: "done",
      },
    });
  };
  const api = await startLocalApi({ root, port: 0, aiConfigFile: configPath, aiFetch, aiCredentialStore });

  try {
    const rejectedSettings = await apiRequest(api.origin, "/api/ai/settings", {
      method: "PATCH",
      body: { baseUrl: "https://models.example/v1", model: "draft-1", apiKey: "secret-key" },
    });
    assert.equal(rejectedSettings.response.status, 403);

    const settings = await apiRequest(api.origin, "/api/ai/settings", {
      method: "PATCH",
      headers: { "x-work-ai-settings": "confirm" },
      body: { baseUrl: "https://models.example/v1", model: "draft-1", apiKey: "secret-key" },
    });
    assert.equal(settings.response.status, 200);
    assert.equal(settings.payload.configured, true);
    assert.equal("apiKey" in settings.payload, false);
    const storedSettings = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(storedSettings.version, 2);
    assert.equal(storedSettings.credentialStorage, "system");
    assert.equal("apiKey" in storedSettings, false);
    assert.equal(aiCredentialStore.peek(), "secret-key");
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    const connection = await apiRequest(api.origin, "/api/ai/settings/test", { method: "POST", body: {} });
    assert.equal(connection.response.status, 200);

    await apiRequest(api.origin, "/api/projects/profile", {
      method: "PATCH",
      body: { projectPath: "product", description: "A local-first project manager for humans and agents." },
    });
    const task = await apiRequest(api.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Add AI", projectPath: "product", goal: "Help draft records safely." },
    });
    await apiRequest(api.origin, "/api/tasks", {
      method: "POST",
      body: { title: "Document the release", projectPath: "product" },
    });
    await apiRequest(api.origin, "/api/ideas", {
      method: "POST",
      body: { title: "Provider presets", opportunity: "Make compatible endpoints easier to configure.", projectPath: "product" },
    });
    await apiRequest(api.origin, "/api/decisions", {
      method: "POST",
      body: { title: "Choose context limits", detail: "Set explicit item and text limits.", projectPath: "product" },
    });

    const proposed = await apiRequest(api.origin, "/api/ai/proposals", {
      method: "POST",
      body: { artifactType: "task", artifactId: task.payload.id, operation: "draft" },
    });
    assert.equal(proposed.response.status, 200);
    assert.deepEqual(proposed.payload.fields.map((field) => field.field), ["title", "goal", "acceptanceCriteria"]);
    assert.equal(proposed.payload.fields.some((field) => field.field === "status"), false);
    const providerCall = calls.at(-1);
    assert.equal(providerCall.options.headers.authorization, "Bearer secret-key");
    assert.equal(providerCall.options.dispatcher, undefined);
    assert.match(providerCall.request.messages.at(-1).content, /local-first project manager/);
    assert.match(providerCall.request.messages.at(-1).content, /Document the release/);
    assert.match(providerCall.request.messages.at(-1).content, /Choose context limits/);
    assert.match(providerCall.request.messages.at(-1).content, /Provider presets/);

    const rejectedApply = await apiRequest(api.origin, "/api/ai/apply", {
      method: "POST",
      body: { proposal: proposed.payload, selectedFields: ["goal"], confirm: true },
    });
    assert.equal(rejectedApply.response.status, 403);

    const applied = await apiRequest(api.origin, "/api/ai/apply", {
      method: "POST",
      headers: { "x-work-ai-apply": "confirm" },
      body: { proposal: proposed.payload, selectedFields: ["goal"], confirm: true },
    });
    assert.equal(applied.response.status, 200);
    assert.equal(applied.payload.title, "Add AI");
    assert.equal(applied.payload.sections.goal, "Give humans a safe, one-shot drafting assistant.");

    const staleApply = await apiRequest(api.origin, "/api/ai/apply", {
      method: "POST",
      headers: { "x-work-ai-apply": "confirm" },
      body: { proposal: proposed.payload, selectedFields: ["title"], confirm: true },
    });
    assert.equal(staleApply.response.status, 409);
    assert.equal(staleApply.payload.error.code, "stale_ai_proposal");
  } finally {
    await closeLocalApi(api.server);
  }
});

test("reports malformed provider output and bounded request timeouts", async () => {
  for (const scenario of ["malformed", "timeout"]) {
    const { root, configPath } = await fixture();
    const aiCredentialStore = memoryCredentialStore();
    const aiFetch = scenario === "malformed"
      ? async () => new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 })
      : async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const api = await startLocalApi({ root, port: 0, aiConfigFile: configPath, aiFetch, aiRequestTimeoutMs: 5, aiCredentialStore });
    try {
      await apiRequest(api.origin, "/api/ai/settings", {
        method: "PATCH",
        headers: { "x-work-ai-settings": "confirm" },
        body: { baseUrl: "https://models.example/v1", model: "draft-1", apiKey: "secret-key" },
      });
      const task = await apiRequest(api.origin, "/api/tasks", { method: "POST", body: { title: "Draft me", projectPath: "product" } });
      const result = await apiRequest(api.origin, "/api/ai/proposals", {
        method: "POST",
        body: { artifactType: "task", artifactId: task.payload.id, operation: "draft" },
      });
      if (scenario === "malformed") {
        assert.equal(result.response.status, 502);
        assert.equal(result.payload.error.code, "ai_invalid_response");
      } else {
        assert.equal(result.response.status, 504);
        assert.equal(result.payload.error.code, "ai_timeout");
      }
    } finally {
      await closeLocalApi(api.server);
    }
  }
});

test("speaks the Anthropic messages protocol when selected", async () => {
  const { root, configPath } = await fixture();
  const aiCredentialStore = memoryCredentialStore();
  let request;
  const aiFetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ summary: "Expanded", explanation: "", questions: [], patch: { opportunity: "A clearer opportunity." } }) }],
    }), { status: 200 });
  };
  const api = await startLocalApi({ root, port: 0, aiConfigFile: configPath, aiFetch, aiCredentialStore });
  try {
    await apiRequest(api.origin, "/api/ai/settings", {
      method: "PATCH",
      headers: { "x-work-ai-settings": "confirm" },
      body: { provider: "anthropic-compatible", baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M3", apiKey: "anthropic-secret", allowSelfSigned: true },
    });
    const idea = await apiRequest(api.origin, "/api/ideas", { method: "POST", body: { title: "Explore this", projectPath: "product" } });
    const proposal = await apiRequest(api.origin, "/api/ai/proposals", {
      method: "POST",
      body: { artifactType: "idea", artifactId: idea.payload.id, operation: "expand" },
    });
    assert.equal(proposal.response.status, 200);
    assert.equal(proposal.payload.fields[0].field, "opportunity");
    assert.equal(request.url, "https://api.minimax.io/anthropic/v1/messages");
    assert.equal(request.options.headers["x-api-key"], "anthropic-secret");
    assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
    assert.ok(request.options.dispatcher, "self-signed HTTPS opt-in should use a scoped dispatcher");
    assert.equal(typeof request.body.system, "string");
    assert.deepEqual(request.body.messages.map((message) => message.role), ["user"]);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("migrates a 0.2.9 plaintext key into the credential store and scrubs JSON", async () => {
  const { root, configPath } = await fixture();
  const aiCredentialStore = memoryCredentialStore();
  await mkdir(join(root, "private"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    model: "draft-1",
    apiKey: "legacy-plaintext-key",
    updatedAt: "2026-07-15T00:00:00.000Z",
  }, null, 2)}\n`, { mode: 0o600 });
  const api = await startLocalApi({ root, port: 0, aiConfigFile: configPath, aiCredentialStore });
  try {
    const settings = await apiRequest(api.origin, "/api/ai/settings");
    assert.equal(settings.response.status, 200);
    assert.equal(settings.payload.configured, true);
    assert.equal(settings.payload.credentialSource, "system");
    assert.equal(aiCredentialStore.peek(), "legacy-plaintext-key");
    const migrated = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.credentialStorage, "system");
    assert.equal("apiKey" in migrated, false);
    assert.doesNotMatch(await readFile(configPath, "utf8"), /legacy-plaintext-key/);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("never falls back to plaintext when the credential store is unavailable", async () => {
  const { root, configPath } = await fixture();
  const aiCredentialStore = {
    async get() { throw new Error("locked"); },
    async set() { throw new Error("locked"); },
    async delete() { throw new Error("locked"); },
  };
  const api = await startLocalApi({ root, port: 0, aiConfigFile: configPath, aiCredentialStore });
  try {
    const settings = await apiRequest(api.origin, "/api/ai/settings", {
      method: "PATCH",
      headers: { "x-work-ai-settings": "confirm" },
      body: { baseUrl: "https://models.example/v1", model: "draft-1", apiKey: "must-not-land-on-disk" },
    });
    assert.equal(settings.response.status, 503);
    assert.equal(settings.payload.error.code, "ai_credential_store_unavailable");
    await assert.rejects(readFile(configPath, "utf8"), { code: "ENOENT" });
  } finally {
    await closeLocalApi(api.server);
  }
});
