import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { compareVersions, createServiceUpdater } from "../lib/service-updater.mjs";

const directories = [];

after(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(version = "0.2.3") {
  const root = await mkdtemp(join(tmpdir(), "work-updater-"));
  directories.push(root);
  const globalRoot = join(root, "node_modules");
  const packageRoot = join(globalRoot, "slash-work");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "slash-work", version })}\n`);
  return { globalRoot, packageRoot };
}

test("compares stable and prerelease semantic versions", () => {
  assert.equal(compareVersions("0.2.4", "0.2.3"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.2"), 1);
  assert.equal(compareVersions("0.2.3", "0.2.3"), 0);
});

test("checks npm and installs only the fixed package version from a global install", async () => {
  const { globalRoot, packageRoot } = await fixture();
  const commands = [];
  const updater = await createServiceUpdater({
    packageRoot,
    now: () => new Date("2026-07-14T17:00:00.000Z"),
    fetchImpl: async (url) => {
      assert.equal(url, "https://registry.npmjs.org/slash-work/latest");
      return { ok: true, json: async () => ({ version: "0.2.4" }) };
    },
    runCommand: async (command, args) => {
      commands.push([command, args]);
      if (args[0] === "root") return { stdout: `${globalRoot}\n`, stderr: "" };
      return { stdout: "updated", stderr: "" };
    },
  });

  assert.equal(updater.installable, true);
  assert.deepEqual(await updater.checkForUpdate(), {
    currentVersion: "0.2.3",
    latestVersion: "0.2.4",
    updateAvailable: true,
    installable: true,
    checkedAt: "2026-07-14T17:00:00.000Z",
  });
  await updater.installUpdate("0.2.4");
  assert.deepEqual(commands.at(-1), ["npm", ["install", "--global", "slash-work@0.2.4", "--no-audit", "--no-fund"]]);
});

test("does not self-install when Work is running from a source checkout", async () => {
  const { globalRoot } = await fixture();
  const sourceRoot = await mkdtemp(join(tmpdir(), "work-source-updater-"));
  directories.push(sourceRoot);
  await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify({ name: "slash-work", version: "0.2.3" })}\n`);
  const updater = await createServiceUpdater({
    packageRoot: sourceRoot,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: "0.2.4" }) }),
    runCommand: async (_command, args) => args[0] === "root" ? { stdout: `${globalRoot}\n`, stderr: "" } : { stdout: "", stderr: "" },
  });
  assert.equal(updater.installable, false);
  await assert.rejects(() => updater.installUpdate("0.2.4"), /source checkout/);
});
