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
    ["#/$defs/capture", "#/$defs/note", "#/$defs/issue", "#/$defs/decision", "#/$defs/task"],
  );
  assert.deepEqual(schema.$defs.capture.properties.kind.enum, ["idea", "question", "update"]);
  assert.equal("agentIntent" in schema.$defs.note.properties, false);
  assert.ok(schema.$defs.note.required.includes("createdBy"));
  assert.equal(schema.$defs.note.properties.createdBy.oneOf[1].properties.kind.const, "agent");
  // Ideas merged into notes: the idea record type no longer exists.
  assert.equal("idea" in schema.$defs, false);
  assert.equal("ideaEvent" in schema.$defs, false);
  assert.doesNotMatch(schema.$defs.recordId.pattern, /idea/);
  assert.deepEqual(schema.$defs.issue.properties.state.enum, ["queued", "in_progress", "needs_human", "resolved", "closed"]);
  assert.equal(schema.$defs.issue.properties.claimedBy.oneOf[0].properties.kind.const, "agent");
  assert.ok(schema.$defs.issue.required.includes("stateHistory"));
  assert.equal(schema.$defs.issueStateEvent.properties.actor.$ref, "#/$defs/issueActor");
  assert.ok(schema.$defs.decision.properties.status.enum.includes("kept_unassigned"));
  assert.ok(schema.$defs.decision.required.includes("recommendedOption"));
  assert.equal(schema.$defs.decision.properties.recommendedOption.oneOf[1].type, "null");
  assert.deepEqual(
    schema.$defs.task.properties.taskType.enum,
    ["task", "bug", "feature", "research", "admin", "epic", "idea"],
  );
});

test("documents exact storage, envelope, and body grammar for automations", async () => {
  const contract = await readFile(contractUrl, "utf8");

  for (const heading of ["## Capture", "## Note", "## Issue", "## Decision", "## Task"]) {
    assert.ok(contract.includes(heading), `missing ${heading}`);
  }
  assert.ok(!contract.includes("## Idea"), "the idea artifact section should be gone");
  for (const requiredRule of [
    "key: <JSON value>",
    "projectPath: null",
    "- [ ] text",
    "- <ISO timestamp> — <message>",
    "Ideas were merged into notes",
    "Only a human may move an\nissue to `closed`",
    "Agents cannot\ndelete, archive, lock, or prevent replies",
    "temporary\nsibling file followed by an atomic rename",
  ]) {
    assert.ok(contract.includes(requiredRule), `missing contract rule: ${requiredRule}`);
  }
});
