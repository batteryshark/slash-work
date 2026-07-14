import { execFile as execFileCallback } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PACKAGE_NAME = "slash-work";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart == null || bPart == null) return aPart == null ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return Number(aPart) > Number(bPart) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function createServiceUpdater({
  packageRoot,
  fetchImpl = globalThis.fetch,
  runCommand = execFile,
  platform = process.platform,
  now = () => new Date(),
} = {}) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const currentVersion = manifest.version;
  parseVersion(currentVersion);
  const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
  let installable = false;
  try {
    const [{ stdout }, resolvedPackageRoot] = await Promise.all([
      runCommand(npmCommand, ["root", "--global"], { encoding: "utf8", timeout: 15_000 }),
      realpath(packageRoot),
    ]);
    const globalRoot = await realpath(String(stdout).trim());
    installable = isContained(globalRoot, resolvedPackageRoot);
  } catch {
    // Update checks remain useful in source checkouts and restricted installs.
  }

  async function checkForUpdate() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    timeout.unref?.();
    try {
      const response = await fetchImpl(REGISTRY_URL, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`npm registry returned ${response.status}.`);
      const payload = await response.json();
      const latestVersion = typeof payload?.version === "string" ? payload.version : "";
      parseVersion(latestVersion);
      return {
        currentVersion,
        latestVersion,
        updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
        installable,
        checkedAt: now().toISOString(),
      };
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("The npm update check timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function installUpdate(version) {
    parseVersion(version);
    if (!installable) {
      throw new Error("This Work process is running from a source checkout and cannot update itself through npm.");
    }
    await runCommand(
      npmCommand,
      ["install", "--global", `${PACKAGE_NAME}@${version}`, "--no-audit", "--no-fund"],
      { encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 },
    );
    return { installedVersion: version };
  }

  return { currentVersion, installable, checkForUpdate, installUpdate };
}
