import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";

import { WorkspaceError, initializeWorkspace } from "./local-workspace.mjs";

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

export async function listRegisteredWorkspaces({ initialize = true } = {}) {
  const registry = await readRegistry();
  const workspaces = [];
  for (const entry of registry.roots) {
    try {
      const workspace = initialize
        ? await initializeWorkspace(entry.root)
        : { id: entry.id, name: entry.name, root: await realpath(entry.root) };
      workspaces.push(workspace);
    } catch (error) {
      if (error?.code !== "missing_root" && error?.code !== "ENOENT") throw error;
    }
  }
  return workspaces;
}

export async function registerWorkspace(rootPath, { force = false } = {}) {
  const workspace = await initializeWorkspace(resolve(rootPath), { force });
  const registry = await readRegistry();
  const roots = registry.roots.filter((entry) => entry.id !== workspace.id && entry.root !== workspace.root);
  roots.push({ id: workspace.id, name: workspace.name, root: workspace.root });
  await writeRegistry({ version: REGISTRY_VERSION, roots });
  return workspace;
}

export async function unregisterWorkspace(idOrRoot) {
  const registry = await readRegistry();
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
  await writeRegistry({ version: REGISTRY_VERSION, roots });
}
