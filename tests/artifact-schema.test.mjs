import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("../schemas/work-artifact.schema.json", import.meta.url);
const contractUrl = new URL("../docs/ARTIFACT-SCHEMA.md", import.meta.url);

test("publishes a machine-readable schema for every Markdown artifact type", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(
    schema.oneOf.map((entry) => entry.$ref),
    ["#/$defs/capture", "#/$defs/note", "#/$defs/decision", "#/$defs/task"],
  );
  assert.deepEqual(schema.$defs.capture.properties.kind.enum, ["idea", "question", "update"]);
  assert.deepEqual(schema.$defs.note.properties.agentIntent.enum, ["reference_only", "review_requested"]);
  assert.ok(schema.$defs.decision.properties.status.enum.includes("kept_unassigned"));
  assert.deepEqual(
    schema.$defs.task.properties.taskType.enum,
    ["task", "bug", "feature", "research", "admin", "epic", "idea"],
  );
});

test("documents exact storage, envelope, and body grammar for automations", async () => {
  const contract = await readFile(contractUrl, "utf8");

  for (const heading of ["## Capture", "## Note", "## Decision", "## Task"]) {
    assert.ok(contract.includes(heading), `missing ${heading}`);
  }
  for (const requiredRule of [
    "key: <JSON value>",
    "projectPath: null",
    "- [ ] text",
    "- <ISO timestamp> — <message>",
    "temporary\nsibling file followed by an atomic rename",
  ]) {
    assert.ok(contract.includes(requiredRule), `missing contract rule: ${requiredRule}`);
  }
});
