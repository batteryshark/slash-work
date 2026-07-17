import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";

const execFile = promisify(execFileCallback);
const launcherPath = new URL("../bin/work.mjs", import.meta.url);
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "work-agent-capabilities-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function requestJson(origin, pathname) {
  const response = await fetch(new URL(pathname, origin));
  return { response, payload: await response.json() };
}

test("serves task-scoped agent instructions from the CLI without a workspace or running service", async () => {
  const cwd = await temporaryDirectory();

  const bootstrap = await execFile(process.execPath, [launcherPath.pathname, "agent"], { cwd });
  assert.match(bootstrap.stdout, /work agent operations/i);
  assert.match(bootstrap.stdout, /local workspaces and explicitly paired remote workspaces/i);
  assert.match(bootstrap.stdout, /same service origin/i);
  assert.match(bootstrap.stdout, /X-Work-Workspace/);
  assert.match(bootstrap.stdout, /Instructions describe capabilities; they do not grant authorization/i);

  const operations = await execFile(process.execPath, [launcherPath.pathname, "agent", "operations"], { cwd });
  assert.match(operations.stdout, /`tasks\.create`/);
  assert.match(operations.stdout, /`notes\.request-review`/);
  assert.match(operations.stdout, /`notes\.list`/);
  assert.match(operations.stdout, /`ideas\.request-evaluation`/);
  assert.doesNotMatch(operations.stdout, /Input schema/);

  const instructions = await execFile(
    process.execPath,
    [launcherPath.pathname, "agent", "instructions", "tasks.create", "--json"],
    { cwd },
  );
  const task = JSON.parse(instructions.stdout);
  assert.equal(task.protocolVersion, "1");
  assert.equal(task.operation.id, "tasks.create");
  assert.equal(task.operation.transport.api.path, "/api/tasks");
  assert.ok(task.operation.rules.some((rule) => /authoriz/i.test(rule)));
  assert.ok(task.operation.inputSchema.required.includes("title"));

  const schema = await execFile(process.execPath, [launcherPath.pathname, "agent", "schema", "task"], { cwd });
  const taskSchema = JSON.parse(schema.stdout);
  assert.equal(taskSchema.$ref, "#/$defs/task");
  assert.equal(taskSchema.$defs.task.properties.artifactType.const, "task");

  assert.deepEqual(await readdir(cwd), [], "agent discovery must not initialize or modify a workspace");
});

test("exposes the same versioned capability catalog and canonical OpenAPI over HTTP", async () => {
  const root = await temporaryDirectory();
  const api = await startLocalApi({ root, port: 0, version: "9.8.7-test" });

  try {
    const index = await requestJson(api.origin, "/api/agent");
    assert.equal(index.response.status, 200);
    assert.equal(index.payload.protocolVersion, "1");
    assert.equal(index.payload.serviceVersion, "9.8.7-test");
    assert.equal(index.payload.links.openapi, "/api/openapi.json");
    assert.equal(index.payload.routing.selectionHeader, "X-Work-Workspace");
    assert.match(index.payload.routing.rule, /keep using this service origin/i);

    const catalog = await requestJson(api.origin, "/api/agent/operations");
    assert.equal(catalog.response.status, 200);
    const taskSummary = catalog.payload.operations.find((operation) => operation.id === "tasks.create");
    assert.equal(taskSummary.instructions, "/api/agent/operations/tasks.create");
    assert.equal("inputSchema" in taskSummary, false, "operation index should stay context-light");
    assert.equal(taskSummary.scope, "workspace");
    assert.equal(catalog.payload.operations.find((operation) => operation.id === "workspaces.list").scope, "service");

    const workspaceInstructions = await requestJson(api.origin, "/api/agent/operations/workspaces.list");
    assert.ok(workspaceInstructions.payload.operation.rules.some((rule) => /remote workspace/i.test(rule)));
    assert.ok(workspaceInstructions.payload.operation.rules.some((rule) => /available field is false/i.test(rule)));

    const task = await requestJson(api.origin, "/api/agent/operations/tasks.create");
    assert.equal(task.response.status, 200);
    assert.equal(task.payload.operation.inputSchema.properties.projectPath.description.includes("Never infer"), true);

    const projectProfile = await requestJson(api.origin, "/api/agent/operations/projects.update-profile");
    assert.equal(projectProfile.response.status, 200);
    assert.equal(projectProfile.payload.operation.inputSchema.properties.name.maxLength, 120);
    assert.deepEqual(projectProfile.payload.operation.inputSchema.anyOf, [{ required: ["name"] }, { required: ["description"] }]);

    const createDecision = await requestJson(api.origin, "/api/agent/operations/decisions.create");
    assert.equal(createDecision.payload.operation.inputSchema.properties.recommendedOption.oneOf[1].type, "null");
    assert.ok(createDecision.payload.operation.rules.some((rule) => /never preselects/i.test(rule)));

    const review = await requestJson(api.origin, "/api/agent/operations/notes.request-review");
    assert.equal(review.payload.operation.recipeFor, "notes.update");
    assert.equal(review.payload.operation.example.agentIntent, "review_requested");
    assert.equal(review.payload.operation.transport.api.path, "/api/agent/notes/{id}");
    assert.equal(review.payload.operation.headers["X-Work-Agent"].maxLength, 120);

    const createNote = await requestJson(api.origin, "/api/agent/operations/notes.create");
    assert.equal(createNote.payload.operation.transport.api.path, "/api/agent/notes");
    assert.equal(createNote.payload.operation.inputSchema.properties.agentIntent.const, "reference_only");

    const schema = await requestJson(api.origin, "/api/agent/schemas/artifacts/idea");
    assert.equal(schema.response.status, 200);
    assert.equal(schema.payload.$ref, "#/$defs/idea");

    const openapi = await requestJson(api.origin, "/api/openapi.json");
    assert.equal(openapi.response.status, 200);
    assert.equal(openapi.payload.openapi, "3.1.0");
    assert.equal(openapi.payload.info.version, "9.8.7-test");
    assert.equal(openapi.payload.paths["/api/tasks"].post.operationId, "tasks.create");
    assert.equal(openapi.payload.paths["/api/tasks"].post.parameters.some((parameter) => parameter.name === "X-Work-Workspace"), true);
    assert.equal(openapi.payload.paths["/api/notes"].get.operationId, "notes.list");
    assert.equal(openapi.payload.paths["/api/agent/notes/{id}"].patch.operationId, "notes.update");
    assert.equal(openapi.payload.paths["/api/agent/notes"].post.operationId, "notes.create");
    assert.equal(openapi.payload.paths["/api/agent/notes"].post.parameters.some((parameter) => parameter.name === "X-Work-Agent" && parameter.in === "header"), true);
    assert.equal(openapi.payload.paths["/api/ideas"].get.operationId, "ideas.list");
    assert.equal(openapi.payload.paths["/api/ideas/{id}"].patch.operationId, "ideas.update");
    assert.equal(openapi.payload.paths["/api/projects/profile"].patch.operationId, "projects.update-profile");

    const missing = await requestJson(api.origin, "/api/agent/operations/unknown.operation");
    assert.equal(missing.response.status, 404);
    assert.equal(missing.payload.error.code, "not_found");
  } finally {
    await closeLocalApi(api.server);
  }
});
