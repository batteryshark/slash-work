import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const skillRoot = new URL("../skills/slash-work/", import.meta.url);

test("ships a vendor-neutral progressively disclosed Slash Work skill", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
  assert.match(skill, /^---\nname: slash-work\ndescription: .+\n---/);
  assert.match(skill, /work agent operations/);
  assert.match(skill, /X-Work-Workspace/);
  assert.match(skill, /references\/service-routing\.md/);
  assert.match(skill, /references\/artifact-model\.md/);
  assert.match(skill, /references\/filesystem-fallback\.md/);
  assert.doesNotMatch(skill, /OpenAI|Claude|Codex/i);

  for (const reference of ["service-routing.md", "artifact-model.md", "filesystem-fallback.md"]) {
    await access(new URL(`references/${reference}`, skillRoot));
  }
  await assert.rejects(access(new URL("agents/openai.yaml", skillRoot)));
});
