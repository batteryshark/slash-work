import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";

import { WorkspaceError, findWorkspaceRoot, initializeWorkspace, isContained, toPosixPath } from "./local-workspace.mjs";

const REGISTRY_VERSION = 1;

export function workspaceRegistryPath() {
  return process.env.WORK_REGISTRY_FILE ?? join(homedir(), ".work", "roots.json");
}

async function readRegistry(pathname = workspaceRegistryPath()) {
  try {
    const parsed = JSON.parse(await readFile(pathname, "utf8"));
    if (parsed?.version !== REGISTRY_VERSION || !Array.isArray(parsed.roots)) throw new Error("Invalid registry");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: REGISTRY_VERSION, roots: [] };
    throw new WorkspaceError(`Workspace registry is not valid JSON: ${pathname}`, {
      code: "invalid_registry",
      status: 500,
    });
  }
}

async function writeRegistry(registry, pathname = workspaceRegistryPath()) {
  await mkdir(dirname(pathname), { recursive: true, mode: 0o700 });
  const temp = `${pathname}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, pathname);
}

// Temporary directories vanish on reboot, so they are never durable Work
// roots. Tests exercise the CLI against temp fixtures and set
// WORK_ALLOW_TEMP_ROOTS=1 to disable this guard; real installs must not.
const TEMP_PREFIXES = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

function isTempPath(pathname) {
  return TEMP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// ponytail: "temporarily unreachable" means "under /Volumes" (macOS mount
// point for external and network volumes). Ceiling: an offline mount at a
// custom mount point elsewhere still gets pruned. Upgrade path: consult the
// mount table instead of a path prefix.
function looksLikeUnmountedVolume(root) {
  return root === "/Volumes" || root.startsWith("/Volumes/");
}

export async function registryEntries({ registryPath = workspaceRegistryPath() } = {}) {
  return (await readRegistry(registryPath)).roots;
}

export async function pruneRegistry({ registryPath = workspaceRegistryPath() } = {}) {
  const registry = await readRegistry(registryPath);
  const kept = [];
  const removed = [];
  for (const entry of registry.roots) {
    let missing = false;
    try {
      await stat(entry.root);
    } catch (error) {
      missing = error?.code === "ENOENT";
    }
    (missing && !looksLikeUnmountedVolume(entry.root) ? removed : kept).push(entry);
  }
  if (removed.length > 0) await writeRegistry({ version: REGISTRY_VERSION, roots: kept }, registryPath);
  return removed;
}

// Work roots never nest: a directory is either a project of an outer root or
// a root itself, never both. Enforced here so every registration path (CLI,
// folder picker) shares the same guard.
async function assertRegistrableRoot(canonical, registryPath) {
  if (isTempPath(canonical) && process.env.WORK_ALLOW_TEMP_ROOTS !== "1") {
    throw new WorkspaceError(
      `${canonical} is a temporary directory, and temporary paths are erased by the system. Choose a durable directory (for example ~/Projects) as the Work root.`,
      { code: "temp_root_refused" },
    );
  }
  const registry = await readRegistry(registryPath);
  if (registry.roots.some((entry) => entry.root === canonical)) return;
  const outerEntry = registry.roots.find((entry) => entry.root !== canonical && isContained(entry.root, canonical));
  const outer = outerEntry?.root ?? (await findWorkspaceRoot(dirname(canonical)));
  if (outer && outer !== canonical && isContained(outer, canonical)) {
    const under = toPosixPath(relative(outer, dirname(canonical)));
    const underFlag = under === "." ? "" : ` --under ${under}`;
    throw new WorkspaceError(
      `${outer} is already a Work root. Run \`work new "${basename(canonical)}"${underFlag}\` to make this a project of it, or unregister the outer root first (work roots forget ${outer}).`,
      { code: "nested_root_refused" },
    );
  }
  const swallowed = registry.roots.filter((entry) => entry.root !== canonical && isContained(canonical, entry.root));
  if (swallowed.length > 0) {
    throw new WorkspaceError(
      `${canonical} would contain the already-registered Work root${swallowed.length === 1 ? "" : "s"}: ${swallowed.map((entry) => entry.root).join(", ")}. Work roots never nest. Serve those roots directly, or run \`work roots forget <path>\` for each of them first.`,
      { code: "root_contains_roots" },
    );
  }
}

export async function listRegisteredWorkspaces({ initialize = true, registryPath = workspaceRegistryPath() } = {}) {
  const registry = await readRegistry(registryPath);
  const workspaces = [];
  for (const entry of registry.roots) {
    try {
      const workspace = initialize
        ? await initializeWorkspace(entry.root, { force: true })
        : { id: entry.id, name: entry.name, root: await realpath(entry.root) };
      workspaces.push(workspace);
    } catch (error) {
      if (error?.code !== "missing_root" && error?.code !== "ENOENT") throw error;
    }
  }
  return workspaces;
}

export async function registerWorkspace(rootPath, { force = false, registryPath = workspaceRegistryPath() } = {}) {
  let canonical = null;
  try {
    canonical = await realpath(resolve(rootPath));
  } catch {
    // Missing directories fall through to initializeWorkspace's clearer error.
  }
  if (canonical) await assertRegistrableRoot(canonical, registryPath);
  const workspace = await initializeWorkspace(resolve(rootPath), { force });
  const registry = await readRegistry(registryPath);
  const roots = registry.roots.filter((entry) => entry.id !== workspace.id && entry.root !== workspace.root);
  roots.push({ id: workspace.id, name: workspace.name, root: workspace.root });
  await writeRegistry({ version: REGISTRY_VERSION, roots }, registryPath);
  return workspace;
}

export async function unregisterWorkspace(idOrRoot, { registryPath = workspaceRegistryPath() } = {}) {
  const registry = await readRegistry(registryPath);
  let canonical = null;
  try {
    canonical = await realpath(resolve(idOrRoot));
  } catch {
    // An id does not need to be a filesystem path.
  }
  const roots = registry.roots.filter((entry) => entry.id !== idOrRoot && entry.root !== canonical);
  if (roots.length === registry.roots.length) {
    throw new WorkspaceError(`No registered workspace matches: ${idOrRoot}`, { code: "workspace_not_found", status: 404 });
  }
  await writeRegistry({ version: REGISTRY_VERSION, roots }, registryPath);
}
