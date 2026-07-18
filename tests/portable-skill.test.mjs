import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const skillRoot = new URL("../skills/slash-work/", import.meta.url);
const ideaSkillRoot = new URL("../skills/incubate-work-ideas/", import.meta.url);

test("ships a vendor-neutral progressively disclosed Slash Work skill", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
  assert.match(skill, /^---\nname: slash-work\ndescription: .+\n---/);
  assert.match(skill, /work agent operations/);
  assert.match(skill, /work agent context --json/);
  assert.match(skill, /work projects --json/);
  assert.match(skill, /--unassigned/);
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

test("ships ADHD-friendly guidance for incubating possible projects", async () => {
  const skill = await readFile(new URL("SKILL.md", ideaSkillRoot), "utf8");
  assert.match(skill, /^---\nname: incubate-work-ideas\ndescription: .+\n---/);
  assert.match(skill, /one Idea per distinct possibility/);
  assert.match(skill, /workspace-owned Idea/);
  assert.match(skill, /explicitly adopts/);
  assert.match(skill, /Never require\npriority, urgency, complexity, estimates, due dates/i);
  assert.match(skill, /Set a revisit date only when/);
  assert.match(skill, /ideas\.create/);
  assert.match(skill, /analysis only/);

  const metadata = await readFile(new URL("agents/openai.yaml", ideaSkillRoot), "utf8");
  assert.match(metadata, /display_name: "Incubate Work Ideas"/);
  assert.match(metadata, /\$incubate-work-ideas/);
});
