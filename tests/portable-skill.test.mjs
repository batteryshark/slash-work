import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const skillRoot = new URL("../skills/slash-work/", import.meta.url);

test("ships the Slash Work skill with valid frontmatter and its references", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
  assert.match(skill, /^---\nname: slash-work\ndescription: .+\n---/);

  for (const reference of ["service-routing.md", "artifact-model.md", "filesystem-fallback.md"]) {
    await access(new URL(`references/${reference}`, skillRoot));
  }
});
