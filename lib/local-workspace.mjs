import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeTags } from "./tags.mjs";

export const DATA_DIRECTORY = ".work";
export const WORKSPACE_FILE = "workspace.json";
export const PROJECT_FILE = "project.json";
export const DEFAULT_TASK_STATUSES = Object.freeze([
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
]);
export const RESERVED_TASK_STATUSES = Object.freeze(["cancelled", "archived"]);

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  DATA_DIRECTORY,
  ".next",
  ".cache",
  ".cargo",
  ".gradle",
  ".hg",
  ".idea",
  ".mypy_cache",
  ".pnpm-store",
  ".project",
  ".pytest_cache",
  ".ruff_cache",
  ".svn",
  ".terraform",
  ".tox",
  ".turbo",
  ".venv",
  ".vscode",
  ".yarn",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv",
]);
const DEFAULT_PROJECT_SCAN_CONCURRENCY = 32;
const DEFAULT_PROJECT_SCAN_DIRECTORY_LIMIT = 200_000;
const projectDiscoveryFlights = new Map();

const CAPTURE_KINDS = new Set(["idea", "question", "update"]);
const DECISION_STATUSES = new Set([
  "open",
  "approved",
  "rejected",
  "deferred",
  "cancelled",
  "assigned",
  "kept_unassigned",
]);
const DECISION_ACTIONS = new Set([
  "approve",
  "reject",
  "defer",
  "cancel",
  "assign",
  "keep_unassigned",
  "reopen",
]);
const PROJECT_VIEWS = new Set(["board", "list"]);
const ISSUE_STATES = new Set(["queued", "in_progress", "needs_human", "resolved", "closed"]);
const RECORD_ID_PATTERN = /^(capture|decision|issue|note)_[a-z0-9][a-z0-9_-]{7,80}$/;
const ISSUE_MESSAGE_ID_PATTERN = /^message_[a-z0-9][a-z0-9_-]{7,80}$/;
const TASK_ID_PATTERN = /^W-[0-9]{4,10}$/;
const MAX_TEXT_LENGTH = 100_000;

function inferCaptureKind(text) {
  const lower = text.toLowerCase();
  if (text.includes("?") || /\b(should|could|whether|figure out|understand|decide)\b/.test(lower)) return "question";
  if (/\b(done|finished|completed|decided|fixed|shipped|merged)\b/.test(lower)) return "update";
  return "idea";
}

export class WorkspaceError extends Error {
  constructor(message, { code = "workspace_error", status = 400 } = {}) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.status = status;
  }
}

function assertString(value, field, { allowEmpty = false, max = MAX_TEXT_LENGTH, oneLine = false, trim = true } = {}) {
  if (typeof value !== "string") {
    throw new WorkspaceError(`${field} must be a string.`, { code: "invalid_input" });
  }
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) {
    throw new WorkspaceError(`${field} cannot be empty.`, { code: "invalid_input" });
  }
  const result = trim ? normalized : value;
  if (result.length > max) {
    throw new WorkspaceError(`${field} is too long.`, { code: "invalid_input", status: 413 });
  }
  if (oneLine && /[\r\n]/.test(result)) {
    throw new WorkspaceError(`${field} must be one line.`, { code: "invalid_input" });
  }
  return result;
}

export function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function toPosixPath(value) {
  return value.split(sep).join("/") || ".";
}

function fromWorkspacePath(root, workspacePath) {
  const segments = typeof workspacePath === "string" ? workspacePath.split(/[\\/]+/) : [];
  const looksLikeWindowsAbsolute = typeof workspacePath === "string" && /^(?:[a-z]:[\\/]|\\\\)/i.test(workspacePath);
  if (segments.includes("..")) {
    throw new WorkspaceError("Path escapes the workspace root.", { code: "path_escape", status: 403 });
  }
  if (
    typeof workspacePath !== "string" ||
    workspacePath.includes("\0") ||
    isAbsolute(workspacePath) ||
    looksLikeWindowsAbsolute ||
    (segments[0] === DATA_DIRECTORY && workspacePath !== ".")
  ) {
    throw new WorkspaceError("Path must be relative to the workspace root.", { code: "invalid_path" });
  }
  const candidate = resolve(root, workspacePath === "." ? "" : workspacePath);
  if (!isContained(root, candidate)) {
    throw new WorkspaceError("Path escapes the workspace root.", { code: "path_escape", status: 403 });
  }
  return candidate;
}

async function canonicalDirectory(inputPath) {
  const absolute = resolve(inputPath);
  let details;
  try {
    details = await stat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError(`Directory does not exist: ${absolute}`, { code: "missing_root", status: 404 });
    }
    throw error;
  }
  if (!details.isDirectory()) {
    throw new WorkspaceError(`Workspace root is not a directory: ${absolute}`, { code: "invalid_root" });
  }
  return realpath(absolute);
}

async function isRegularFile(pathname) {
  try {
    const details = await lstat(pathname);
    return details.isFile() && !details.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureSafeDirectory(root, pathname) {
  if (!isContained(root, pathname)) {
    throw new WorkspaceError("Storage path escapes the workspace root.", { code: "path_escape", status: 403 });
  }
  try {
    const details = await lstat(pathname);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new WorkspaceError(`Unsafe workspace storage path: ${pathname}`, {
        code: "unsafe_storage",
        status: 409,
      });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(pathname, { recursive: false, mode: 0o755 });
  }
  const canonical = await realpath(pathname);
  if (!isContained(root, canonical)) {
    throw new WorkspaceError("Workspace storage resolves outside the root.", {
      code: "path_escape",
      status: 403,
    });
  }
  return canonical;
}

async function atomicWrite(pathname, content) {
  const directory = dirname(pathname);
  const tempPath = join(directory, `.${basename(pathname)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, pathname);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureStorage(root) {
  const dataPath = await ensureSafeDirectory(root, join(root, DATA_DIRECTORY));
  return ensureRecordStorage(root, dataPath);
}

function recordPaths(dataPath) {
  return {
    dataPath,
    capturesPath: join(dataPath, "captures"),
    decisionsPath: join(dataPath, "decisions"),
    // ideasPath is read-only: ideas merged into notes, and the lazy migration in
    // listNotes still reads legacy .work/ideas/ records. No directory is created.
    ideasPath: join(dataPath, "ideas"),
    issuesPath: join(dataPath, "issues"),
    notesPath: join(dataPath, "notes"),
    tasksPath: join(dataPath, "tasks"),
  };
}

async function ensureRecordStorage(root, dataPath) {
  const paths = recordPaths(dataPath);
  for (const field of ["capturesPath", "decisionsPath", "issuesPath", "notesPath", "tasksPath"]) {
    paths[field] = await ensureSafeDirectory(root, paths[field]);
  }
  return paths;
}

function newProjectMarker(projectRoot, name) {
  return {
    version: 1,
    id: randomUUID(),
    name: name ?? basename(projectRoot),
    description: "",
    // New projects start small: a plain list beats a six-column board.
    // Markers written before this key existed read as "board".
    view: "list",
    createdAt: new Date().toISOString(),
  };
}

function projectViewFrom(marker) {
  return marker?.view === "list" ? "list" : "board";
}

export function slugifyProjectName(name) {
  return name
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 80);
}

async function ensureProjectStorage(workspace, projectPath) {
  const projectRoot = fromWorkspacePath(workspace.root, projectPath);
  const dataPath = await ensureSafeDirectory(workspace.root, join(projectRoot, DATA_DIRECTORY));
  const markerPath = join(dataPath, PROJECT_FILE);
  if (!(await isRegularFile(markerPath))) {
    await atomicWrite(markerPath, `${JSON.stringify(newProjectMarker(projectRoot), null, 2)}\n`);
  }
  return ensureRecordStorage(workspace.root, dataPath);
}

async function existingRecordStorage(workspace, project) {
  const dataPath = join(fromWorkspacePath(workspace.root, project.path), DATA_DIRECTORY);
  if (!(await isRegularFile(join(dataPath, PROJECT_FILE)))) return null;
  try {
    const details = await lstat(dataPath);
    if (!details.isDirectory() || details.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return recordPaths(dataPath);
}

export async function findWorkspaceRoot(startPath = process.cwd()) {
  let current = await canonicalDirectory(startPath);
  for (;;) {
    const marker = join(current, DATA_DIRECTORY, WORKSPACE_FILE);
    if (await isRegularFile(marker)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// A workspace-wide floor for newly allocated task ids, so two Work instances on
// different roots never hand out the same W-#### for different work.
function normalizedIdFloor(value, source) {
  if (value == null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WorkspaceError(`idFloor in ${source} must be a non-negative integer.`, {
      code: "invalid_workspace_marker",
      status: 409,
    });
  }
  return value;
}

export async function readWorkspace(rootPath) {
  const root = await canonicalDirectory(rootPath);
  const dataPath = join(root, DATA_DIRECTORY);
  const markerPath = join(dataPath, WORKSPACE_FILE);
  let workspace;
  try {
    workspace = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError(`No Work workspace exists at ${root}.`, { code: "workspace_not_found", status: 404 });
    }
    throw new WorkspaceError(`Cannot read ${markerPath}.`, { code: "invalid_workspace_marker", status: 409 });
  }
  if (workspace?.version !== 1 || typeof workspace.id !== "string") {
    throw new WorkspaceError(`Unsupported workspace marker at ${markerPath}.`, {
      code: "invalid_workspace_marker",
      status: 409,
    });
  }
  return {
    id: workspace.id,
    name: typeof workspace.name === "string" && workspace.name.trim() ? workspace.name.trim() : basename(root),
    root,
    dataDir: dataPath,
    ...recordPaths(dataPath),
    createdAt: workspace.createdAt ?? null,
    statuses: Array.isArray(workspace.statuses) && workspace.statuses.length > 0
      ? workspace.statuses.map((status) => String(status))
      : [...DEFAULT_TASK_STATUSES],
    idFloor: normalizedIdFloor(workspace.idFloor, markerPath),
  };
}

export async function initializeWorkspace(rootPath, { force = false, idFloor = null } = {}) {
  const requestedRoot = await canonicalDirectory(rootPath);
  const existingRoot = force ? null : await findWorkspaceRoot(requestedRoot);
  const root = existingRoot ?? requestedRoot;
  const storage = await ensureStorage(root);
  const markerPath = join(storage.dataPath, WORKSPACE_FILE);

  const requestedFloor = idFloor == null ? null : normalizedIdFloor(idFloor, "--id-floor");

  let workspace;
  if (await isRegularFile(markerPath)) {
    try {
      workspace = JSON.parse(await readFile(markerPath, "utf8"));
    } catch {
      throw new WorkspaceError(`Cannot read ${markerPath}.`, {
        code: "invalid_workspace_marker",
        status: 409,
      });
    }
    if (requestedFloor != null && workspace?.idFloor !== requestedFloor) {
      workspace = { ...workspace, idFloor: requestedFloor };
      await atomicWrite(markerPath, `${JSON.stringify(workspace, null, 2)}\n`);
    }
  } else {
    const now = new Date().toISOString();
    workspace = {
      version: 1,
      id: randomUUID(),
      name: basename(root),
      statuses: [...DEFAULT_TASK_STATUSES],
      createdAt: now,
      ...(requestedFloor == null ? {} : { idFloor: requestedFloor }),
    };
    await atomicWrite(markerPath, `${JSON.stringify(workspace, null, 2)}\n`);
  }

  if (workspace?.version !== 1 || typeof workspace.id !== "string") {
    throw new WorkspaceError(`Unsupported workspace marker at ${markerPath}.`, {
      code: "invalid_workspace_marker",
      status: 409,
    });
  }

  const initialized = {
    id: workspace.id,
    name: typeof workspace.name === "string" && workspace.name.trim() ? workspace.name.trim() : basename(root),
    root,
    dataDir: storage.dataPath,
    createdAt: workspace.createdAt ?? null,
    statuses: Array.isArray(workspace.statuses) && workspace.statuses.length > 0
      ? workspace.statuses.map((status) => String(status))
      : [...DEFAULT_TASK_STATUSES],
    idFloor: normalizedIdFloor(workspace.idFloor, markerPath),
    ...storage,
  };
  await migrateProjectLocalStorage(initialized);
  return initialized;
}

async function markerNames(directory, entries) {
  const markers = entries.some(
    (entry) =>
      entry.name === ".project" &&
      !entry.isSymbolicLink() &&
      (entry.isFile() || entry.isDirectory()),
  )
    ? [".project"]
    : [];
  const localWork = entries.some((entry) => entry.name === DATA_DIRECTORY && entry.isDirectory() && !entry.isSymbolicLink());
  if (localWork) {
    markers.push(
      await isRegularFile(join(directory, DATA_DIRECTORY, PROJECT_FILE))
        ? `${DATA_DIRECTORY}/${PROJECT_FILE}`
        : DATA_DIRECTORY,
    );
  }
  return markers;
}

async function projectMarker(directory) {
  const pathname = join(directory, DATA_DIRECTORY, PROJECT_FILE);
  if (!(await isRegularFile(pathname))) return null;
  try {
    const marker = JSON.parse(await readFile(pathname, "utf8"));
    return marker && typeof marker.id === "string"
      ? {
          id: marker.id,
          name: typeof marker.name === "string" ? marker.name : null,
          description: typeof marker.description === "string" ? marker.description : "",
          view: projectViewFrom(marker),
          // Absent, malformed, or empty all read as no tags.
          tags: normalizeTags(marker.tags),
        }
      : null;
  } catch {
    return null;
  }
}

function linkedGitCommonDirectory(gitDirectory) {
  const worktreesDirectory = dirname(gitDirectory);
  return basename(worktreesDirectory) === "worktrees"
    ? dirname(worktreesDirectory)
    : null;
}

async function gitWorktreeIdentity(root, directory) {
  const dotGit = join(directory, ".git");
  let details;
  try {
    details = await lstat(dotGit);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink()) return null;
  if (details.isDirectory()) {
    const commonDir = await realpath(dotGit);
    return isContained(root, commonDir) ? { commonDir, primary: true } : null;
  }
  if (!details.isFile()) return null;

  try {
    const pointer = (await readFile(dotGit, "utf8")).trim().match(/^gitdir:\s*(.+)$/i)?.[1];
    if (!pointer) return null;
    const gitDirCandidate = resolve(directory, pointer);
    const externalCommonDir = linkedGitCommonDirectory(gitDirCandidate);
    if (!isContained(root, gitDirCandidate)) {
      // A selected workspace can contain only linked checkouts while the primary
      // repository (and its shared .git directory) lives elsewhere. Git's
      // standard pointer shape is enough to group those paths; do not follow or
      // read the external pointer target.
      return externalCommonDir ? { commonDir: externalCommonDir, primary: false } : null;
    }
    const gitDir = await realpath(gitDirCandidate);
    if (!isContained(root, gitDir)) return null;
    const commonMarker = join(gitDir, "commondir");
    let commonDir = gitDir;
    if (await isRegularFile(commonMarker)) {
      const commonDirCandidate = resolve(gitDir, (await readFile(commonMarker, "utf8")).trim());
      if (!isContained(root, commonDirCandidate)) return null;
      commonDir = await realpath(commonDirCandidate);
      if (!isContained(root, commonDir)) return null;
    }
    return { commonDir, primary: gitDir === commonDir };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function canonicalizeWorktreeProjects(projects) {
  const canonicalProjects = [];
  const worktreeGroups = new Map();
  for (const project of projects) {
    if (!project.gitWorktree) {
      canonicalProjects.push(project);
      continue;
    }
    const group = worktreeGroups.get(project.gitWorktree.commonDir) ?? [];
    group.push(project);
    worktreeGroups.set(project.gitWorktree.commonDir, group);
  }

  for (const group of worktreeGroups.values()) {
    group.sort((left, right) => {
      if (left.gitWorktree.primary !== right.gitWorktree.primary) {
        return left.gitWorktree.primary ? -1 : 1;
      }
      return left.path.localeCompare(right.path);
    });
    const [canonical, ...aliases] = group;
    canonicalProjects.push({
      ...canonical,
      aliasPaths: aliases.map((project) => project.path).sort((left, right) => left.localeCompare(right)),
    });
  }

  return canonicalProjects
    .map(({ gitWorktree: _gitWorktree, ...project }) => project)
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function discoverProjectsFromRoot(root, maxDirectories) {
  const projects = [];
  const queue = [{ directory: root, depth: 0 }];
  let cursor = 0;
  const limitError = () => new WorkspaceError(
    `Project discovery reached the ${maxDirectories.toLocaleString("en-US")}-directory safety limit. Add a nested .work/workspace.json boundary or choose a narrower workspace root.`,
    { code: "project_discovery_limit", status: 503 },
  );

  async function inspect({ directory, depth }) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "EACCES" || error?.code === "EPERM") return [];
      throw error;
    }

    if (
      directory !== root &&
      entries.some((entry) => entry.name === DATA_DIRECTORY && entry.isDirectory() && !entry.isSymbolicLink()) &&
      await isRegularFile(join(directory, DATA_DIRECTORY, WORKSPACE_FILE))
    ) {
      return [];
    }

    const discoveredMarkers = await markerNames(directory, entries);
    const markers = directory === root
      ? discoveredMarkers.filter((marker) => marker !== DATA_DIRECTORY)
      : discoveredMarkers;
    if (markers.length > 0) {
      const rel = toPosixPath(relative(root, directory));
      const [marker, gitWorktree] = await Promise.all([
        projectMarker(directory),
        gitWorktreeIdentity(root, directory),
      ]);
      projects.push({
        id: rel,
        projectId: marker?.id ?? null,
        name: marker?.name || basename(directory),
        description: marker?.description ?? "",
        view: marker?.view ?? "board",
        tags: marker?.tags ?? [],
        path: rel,
        depth,
        markers,
        aliasPaths: [],
        gitWorktree,
      });
    }

    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRECTORIES.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((child) => ({ directory: join(directory, child.name), depth: depth + 1 }));
  }

  while (cursor < queue.length) {
    if (cursor >= maxDirectories) throw limitError();
    const batch = queue.slice(cursor, Math.min(queue.length, cursor + DEFAULT_PROJECT_SCAN_CONCURRENCY, maxDirectories));
    cursor += batch.length;
    const children = await Promise.all(batch.map(inspect));
    for (const group of children) {
      if (queue.length + group.length > maxDirectories) throw limitError();
      queue.push(...group);
    }
  }

  return canonicalizeWorktreeProjects(projects);
}

export async function discoverProjects(rootPath, { maxDirectories = DEFAULT_PROJECT_SCAN_DIRECTORY_LIMIT, forceRefresh = false } = {}) {
  const root = await canonicalDirectory(rootPath);
  const key = `${root}\0${maxDirectories}`;
  // Joining an in-flight scan is what lets a caller receive a project list
  // assembled before a project it is about to read records from existed.
  // forceRefresh starts its own scan so a caller can re-ask for the truth.
  if (forceRefresh) return discoverProjectsFromRoot(root, maxDirectories);
  const active = projectDiscoveryFlights.get(key);
  if (active) return active;

  const flight = discoverProjectsFromRoot(root, maxDirectories)
    .finally(() => {
      if (projectDiscoveryFlights.get(key) === flight) projectDiscoveryFlights.delete(key);
    });
  projectDiscoveryFlights.set(key, flight);
  return flight;
}

export async function createProject(workspace, { name, parentPath } = {}) {
  const projectName = assertString(name, "name", { max: 120 });
  const parent = await validateScopePath(workspace.root, parentPath ?? ".");
  const slug = slugifyProjectName(projectName);
  if (!slug) {
    throw new WorkspaceError("The project name needs at least one letter or number.", { code: "invalid_input" });
  }
  const folderPath = parent === "." ? slug : `${parent}/${slug}`;
  const folderRoot = fromWorkspacePath(workspace.root, folderPath);
  let createdFolder = false;
  try {
    await mkdir(folderRoot, { recursive: false, mode: 0o755 });
    createdFolder = true;
  } catch (error) {
    // An existing plain folder is adopted; initializeProject rejects folders
    // that are already projects.
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    return await initializeProject(workspace, folderPath, { name: projectName });
  } catch (error) {
    if (createdFolder) await rmdir(folderRoot).catch(() => {});
    throw error;
  }
}

export async function initializeProject(workspace, projectPath, { name } = {}) {
  const requestedPath = assertString(projectPath, "projectPath", { max: 4096 });
  const validatedPath = await validateScopePath(workspace.root, requestedPath);
  if (validatedPath === ".") {
    throw new WorkspaceError("The workspace root is already managed by its own .work directory.", {
      code: "workspace_root_not_project",
      status: 409,
    });
  }

  const projectRoot = fromWorkspacePath(workspace.root, validatedPath);
  for (let directory = projectRoot; directory !== workspace.root; directory = dirname(directory)) {
    if (await isRegularFile(join(directory, DATA_DIRECTORY, WORKSPACE_FILE))) {
      throw new WorkspaceError("Projects cannot be initialized inside a nested Work workspace.", {
        code: "nested_workspace_boundary",
        status: 409,
      });
    }
  }

  const dataPath = join(projectRoot, DATA_DIRECTORY);
  try {
    await mkdir(dataPath, { recursive: false, mode: 0o755 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new WorkspaceError("This folder already contains a .work entry.", {
        code: "project_already_initialized",
        status: 409,
      });
    }
    throw error;
  }

  let markerWritten = false;
  try {
    await atomicWrite(
      join(dataPath, PROJECT_FILE),
      `${JSON.stringify(newProjectMarker(projectRoot, name), null, 2)}\n`,
    );
    markerWritten = true;
    await ensureRecordStorage(workspace.root, dataPath);
  } catch (error) {
    if (!markerWritten) await rmdir(dataPath).catch(() => {});
    throw error;
  }

  const project = (await discoverProjects(workspace.root)).find(
    (candidate) => candidate.path === validatedPath || candidate.aliasPaths?.includes(validatedPath),
  );
  if (!project) {
    throw new WorkspaceError("Project metadata was created but the project could not be rediscovered.", {
      code: "project_not_found",
      status: 409,
    });
  }
  return project;
}

export function projectForScope(projects, scopePath = ".") {
  if (!Array.isArray(projects) || typeof scopePath !== "string" || scopePath === ".") return null;
  const matches = projects.flatMap((project) =>
    [project.path, ...(project.aliasPaths ?? [])]
      .filter((candidatePath) => scopePath === candidatePath || scopePath.startsWith(`${candidatePath}/`))
      .map((matchedPath) => ({ project, matchedPath })),
  );
  matches.sort((left, right) => right.matchedPath.length - left.matchedPath.length);
  return matches[0] ?? null;
}

export async function updateProjectProfile(workspace, projectPath, input, projects = null) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const validatedPath = await validateProjectPath(workspace.root, projectPath, knownProjects);
  if (!validatedPath) throw new WorkspaceError("projectPath is required.", { code: "invalid_input" });
  await ensureProjectStorage(workspace, validatedPath);
  const markerPath = join(fromWorkspacePath(workspace.root, validatedPath), DATA_DIRECTORY, PROJECT_FILE);
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new WorkspaceError("Project metadata could not be read.", { code: "invalid_project_marker", status: 409 });
  }
  const hasName = Object.prototype.hasOwnProperty.call(input ?? {}, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(input ?? {}, "description");
  const hasView = Object.prototype.hasOwnProperty.call(input ?? {}, "view");
  const hasTags = Object.prototype.hasOwnProperty.call(input ?? {}, "tags");
  if (!hasName && !hasDescription && !hasView && !hasTags) {
    throw new WorkspaceError("Provide a project name, description, view, or tags to update.", { code: "invalid_input" });
  }
  const name = hasName ? assertString(input.name, "name", { max: 120 }) : marker.name;
  const description = hasDescription
    ? assertString(input.description, "description", { allowEmpty: true, max: 20_000 })
    : marker.description;
  const view = hasView ? assertString(input.view, "view", { max: 10 }).toLowerCase() : projectViewFrom(marker);
  if (!PROJECT_VIEWS.has(view)) {
    throw new WorkspaceError("view must be board or list.", { code: "invalid_input" });
  }
  // stringArray is the same validation task tags get; normalizeTags is the
  // project-side rule on top of it.
  const tags = normalizeTags(hasTags ? stringArray(input.tags, "tags") : marker.tags);
  const next = { ...marker, name, description, view, updatedAt: new Date().toISOString() };
  // An untagged project's marker keeps exactly the shape it has today.
  if (tags.length > 0) next.tags = tags; else delete next.tags;
  await atomicWrite(markerPath, `${JSON.stringify(next, null, 2)}\n`);
  const updated = (await discoverProjects(workspace.root)).find((project) => project.path === validatedPath);
  if (!updated) throw new WorkspaceError("Project could not be rediscovered after updating its profile.", { code: "project_not_found", status: 409 });
  return updated;
}

export async function deleteProject(workspace, projectPath, { agentName = null } = {}) {
  if (agentName) {
    throw new WorkspaceError("Agents cannot delete projects.", { code: "project_delete_forbidden", status: 403 });
  }
  const projects = await discoverProjects(workspace.root);
  const validatedPath = await validateProjectPath(workspace.root, projectPath, projects);
  if (!validatedPath) throw new WorkspaceError("projectPath is required.", { code: "invalid_input" });
  if (validatedPath === ".") {
    throw new WorkspaceError("The workspace root cannot be deleted.", {
      code: "workspace_root_not_project",
      status: 409,
    });
  }
  const projectRoot = fromWorkspacePath(workspace.root, validatedPath);
  await rm(join(projectRoot, DATA_DIRECTORY), { recursive: true, force: true });
  let folderRemoved = false;
  try {
    // Non-recursive on purpose: only a now-empty folder disappears. A folder
    // that still has files fails silently into "folder kept".
    await rmdir(projectRoot);
    folderRemoved = true;
    await syncDirectory(dirname(projectRoot)).catch(() => {});
  } catch {
    // Folder kept: it still contains files that belong to the user.
  }
  return { projectPath: validatedPath, folderRemoved };
}

async function recordStores(workspace, projects = null) {
  const stores = [{ projectPath: null, ...workspace }];
  for (const project of projects ?? await discoverProjects(workspace.root)) {
    const storage = await existingRecordStorage(workspace, project);
    if (storage) stores.push({ projectPath: project.path, ...storage });
  }
  return stores;
}

async function targetRecordStore(workspace, projectPath) {
  return projectPath ? ensureProjectStorage(workspace, projectPath) : workspace;
}

async function listStoredMarkdown(workspace, directoryField, projects = null) {
  const records = [];
  for (const store of await recordStores(workspace, projects)) {
    const directory = store[directoryField];
    let paths;
    try {
      paths = await listMarkdown(directory);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const pathname of paths) records.push({ pathname, projectPath: store.projectPath, store });
  }
  return records;
}

async function findStoredRecord(workspace, directoryField, filename) {
  const matches = [];
  for (const store of await recordStores(workspace)) {
    const pathname = join(store[directoryField], filename);
    if (await isRegularFile(pathname)) matches.push({ pathname, projectPath: store.projectPath, store });
  }
  if (matches.length > 1) {
    const locations = matches
      .map(({ pathname }) => toPosixPath(relative(workspace.root, pathname)))
      .join(", ");
    throw new WorkspaceError(
      `Duplicate record id ${filename} exists at: ${locations}. Work will not choose between distinct project stores.`,
      { code: "duplicate_record", status: 409 },
    );
  }
  return matches[0] ?? null;
}

async function relocateRecord(pathname, destinationDirectory) {
  const destination = join(destinationDirectory, basename(pathname));
  if (pathname === destination) return destination;
  if (await isRegularFile(destination)) {
    throw new WorkspaceError(`Record already exists at ${destination}.`, { code: "duplicate_record", status: 409 });
  }
  await rename(pathname, destination);
  await Promise.all([syncDirectory(dirname(pathname)), syncDirectory(destinationDirectory)]);
  return destination;
}

// A record found in a project store belongs to that project regardless of its
// stored frontmatter. Captures and notes also collapse their scope onto the
// project; issues keep a deeper scope inside the project when they have one.
function assignProject(record, projectPath) {
  record.projectPath = projectPath;
}

function assignProjectScope(record, projectPath) {
  record.projectPath = projectPath;
  record.scopePath = projectPath;
}

function assignIssueProject(issue, projectPath) {
  issue.projectPath = projectPath;
  if (issue.scopePath === "." || !issue.scopePath.startsWith(`${projectPath}/`)) issue.scopePath = projectPath;
}

async function listRecords(workspace, directoryField, fromRecord, projects, { sortKey = "updatedAt", override = assignProject } = {}) {
  const records = [];
  for (const { pathname, projectPath } of await listStoredMarkdown(workspace, directoryField, projects)) {
    let record;
    try {
      record = fromRecord(parseMarkdownRecord(await readFile(pathname, "utf8"), pathname), pathname);
    } catch (error) {
      // One unreadable file used to fail the whole listing, which took the
      // workspace down with it — a single stray file on a volume made every
      // client unable to connect. Skip it loudly and serve the rest; reading
      // that record by id still reports the real error.
      console.warn(`[work] Skipping unreadable record ${pathname}: ${error?.message ?? error}`);
      continue;
    }
    if (projectPath) override(record, projectPath);
    records.push(record);
  }
  return records.sort((left, right) => (right[sortKey] ?? "").localeCompare(left[sortKey] ?? ""));
}

async function readStoredRecord(workspace, directoryField, filename, fromRecord, label, { override = assignProject } = {}) {
  const located = await findStoredRecord(workspace, directoryField, filename);
  if (!located) throw new WorkspaceError(`${label} not found.`, { code: "not_found", status: 404 });
  try {
    const details = await lstat(located.pathname);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Unsafe ${label} record`);
    const record = parseMarkdownRecord(await readFile(located.pathname, "utf8"), located.pathname);
    const value = fromRecord(record, located.pathname);
    if (located.projectPath) override(value, located.projectPath);
    return { value, record, pathname: located.pathname };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError(`${label} not found.`, { code: "not_found", status: 404 });
    }
    throw error;
  }
}

async function deleteRecord(workspace, directoryField, id, label, check = null) {
  const located = await findStoredRecord(workspace, directoryField, `${id}.md`);
  if (!located) throw new WorkspaceError(`${label} not found.`, { code: "not_found", status: 404 });
  try {
    if (check) check(parseMarkdownRecord(await readFile(located.pathname, "utf8"), located.pathname), located.pathname);
    const details = await lstat(located.pathname);
    if (!details.isFile() && !details.isSymbolicLink()) throw new Error("Not a file");
    await unlink(located.pathname);
    await syncDirectory(dirname(located.pathname));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError(`${label} not found.`, { code: "not_found", status: 404 });
    }
    throw error;
  }
}

async function writeRecord(workspace, directoryField, record, content, sourcePath = null) {
  const storage = await targetRecordStore(workspace, record.projectPath);
  const pathname = sourcePath
    ? await relocateRecord(sourcePath, storage[directoryField])
    : join(storage[directoryField], `${record.id}.md`);
  await atomicWrite(pathname, content);
}

export async function migrateProjectLocalStorage(workspace) {
  const projects = await discoverProjects(workspace.root);
  const projectStores = new Map();
  for (const project of projects) {
    const storage = await ensureProjectStorage(workspace, project.path);
    for (const projectPath of [project.path, ...(project.aliasPaths ?? [])]) {
      projectStores.set(projectPath, storage);
    }
  }

  for (const directoryField of ["capturesPath", "decisionsPath", "issuesPath", "notesPath", "tasksPath"]) {
    for (const pathname of await listMarkdown(workspace[directoryField])) {
      const { metadata } = parseMarkdownRecord(await readFile(pathname, "utf8"), pathname);
      const projectPath = metadata.projectPath ?? metadata.project_path;
      if (typeof projectPath !== "string" || !projectStores.has(projectPath)) continue;
      await relocateRecord(pathname, projectStores.get(projectPath)[directoryField]);
    }
  }
}

export async function validateScopePath(rootPath, value = ".") {
  const root = await canonicalDirectory(rootPath);
  const scopePath = value == null || value === "" ? "." : assertString(value, "scopePath", { max: 4096 });
  const candidate = fromWorkspacePath(root, scopePath);
  let canonical;
  try {
    const details = await lstat(candidate);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new WorkspaceError("scopePath must name an existing directory.", { code: "invalid_scope" });
    }
    canonical = await realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("scopePath must name an existing directory.", { code: "invalid_scope" });
    }
    throw error;
  }
  if (!isContained(root, canonical)) {
    throw new WorkspaceError("scopePath resolves outside the workspace root.", {
      code: "path_escape",
      status: 403,
    });
  }
  return toPosixPath(relative(root, canonical));
}

export async function validateProjectPath(rootPath, value, projects) {
  if (value == null || value === "") return null;
  const requestedPath = assertString(value, "projectPath", { max: 4096 });
  const project = projects.find((candidate) =>
    candidate.path === requestedPath || candidate.aliasPaths?.includes(requestedPath),
  );
  if (!project) {
    throw new WorkspaceError("projectPath must exactly match a discovered project.", {
      code: "unknown_project",
    });
  }
  await validateScopePath(rootPath, project.path);
  return project.path;
}

export async function validateProjectScopePath(rootPath, value = ".", projects = []) {
  const scopePath = await validateScopePath(rootPath, value);
  const aliases = projects
    .flatMap((project) => (project.aliasPaths ?? []).map((aliasPath) => ({ aliasPath, project })))
    .sort((left, right) => right.aliasPath.length - left.aliasPath.length);
  const match = aliases.find(({ aliasPath }) =>
    scopePath === aliasPath || scopePath.startsWith(`${aliasPath}/`),
  );
  if (!match) return scopePath;

  const suffix = scopePath === match.aliasPath ? "" : scopePath.slice(match.aliasPath.length + 1);
  const canonicalPath = suffix ? `${match.project.path}/${suffix}` : match.project.path;
  try {
    return await validateScopePath(rootPath, canonicalPath);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "invalid_scope") {
      return match.project.path;
    }
    throw error;
  }
}

function recordId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function encodeScalar(value) {
  return JSON.stringify(value);
}

function decodeScalar(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function markdownRecord(metadata, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(metadata)) lines.push(`${key}: ${encodeScalar(value)}`);
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

function parseMarkdownRecord(source, pathname) {
  const normalizedSource = source.replaceAll("\r\n", "\n");
  const match = normalizedSource.match(/^---\n([\s\S]*?)\n---\n(?:\n)?([\s\S]*)$/);
  if (!match) {
    throw new WorkspaceError(`Invalid Work record: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const metadata = {};
  for (const line of match[1].split("\n")) {
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) continue;
    metadata[line.slice(0, delimiter).trim()] = decodeScalar(line.slice(delimiter + 1).trim());
  }
  return { metadata, body: match[2].trim() };
}

function assertRecordId(id, prefix) {
  if (typeof id !== "string" || !RECORD_ID_PATTERN.test(id) || !id.startsWith(`${prefix}_`)) {
    throw new WorkspaceError(`Invalid ${prefix} id.`, { code: "invalid_id" });
  }
  return id;
}

async function listMarkdown(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && isRecordFilename(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}

/** A record file, as opposed to something the filesystem left beside one.
 *  macOS writes AppleDouble sidecars (`._name.md`) next to every file on
 *  exFAT and network volumes; they match *.md, are not records, and reading
 *  one as a record used to fail the whole workspace. */
function isRecordFilename(name) {
  return name.endsWith(".md") && !name.startsWith("._") && !name.startsWith(".");
}

function captureFromRecord(record, pathname) {
  const { metadata, body } = record;
  if (metadata.type !== "capture" || !RECORD_ID_PATTERN.test(metadata.id ?? "")) {
    throw new WorkspaceError(`Invalid capture record: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  return {
    id: metadata.id,
    text: body,
    kind: metadata.kind,
    scopePath: metadata.scopePath,
    projectPath: metadata.projectPath ?? null,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

function noteFromRecord(record, pathname) {
  const { metadata, body } = record;
  if (metadata.type !== "note" || !RECORD_ID_PATTERN.test(metadata.id ?? "")) {
    throw new WorkspaceError(`Invalid note record: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const createdBy = metadata.createdBy?.kind === "agent" && typeof metadata.createdBy.name === "string" && metadata.createdBy.name.trim()
    ? { kind: "agent", name: metadata.createdBy.name.trim() }
    : { kind: "human", name: null };
  return {
    id: metadata.id,
    title: typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : "Untitled note",
    text: body,
    scopePath: metadata.scopePath,
    projectPath: metadata.projectPath ?? null,
    createdBy,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

function decisionFromRecord(record, pathname) {
  const { metadata } = record;
  if (metadata.type !== "decision" || !RECORD_ID_PATTERN.test(metadata.id ?? "")) {
    throw new WorkspaceError(`Invalid decision record: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const body = record.body;
  const headingMatch = body.match(/^# (.+?)(?:\n\n|$)([\s\S]*)$/);
  const title = headingMatch?.[1]?.trim() ?? metadata.title;
  const remainder = headingMatch?.[2]?.trim() ?? "";
  const optionsMatch = remainder.match(/(?:^|\n\n)## Options\n[\s\S]*$/);
  const detail = optionsMatch?.index == null ? remainder : remainder.slice(0, optionsMatch.index).trim();
  return {
    id: metadata.id,
    title,
    detail,
    projectPath: metadata.projectPath ?? null,
    refs: Array.isArray(metadata.refs) ? metadata.refs : [],
    options: Array.isArray(metadata.options) ? metadata.options : [],
    recommendedOption: typeof metadata.recommendedOption === "string" ? metadata.recommendedOption : null,
    status: metadata.status,
    resolution: metadata.resolution ?? null,
    history: Array.isArray(metadata.history) ? metadata.history : [],
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

function decisionBody(decision) {
  const detail = decision.detail ? `\n\n${decision.detail}` : "";
  const options = decision.options.length
    ? `\n\n## Options\n\n${decision.options.map((option) => `- ${option}${option === decision.recommendedOption ? " — Recommended" : ""}`).join("\n")}`
    : "";
  return `# ${decision.title}${detail}${options}`;
}

function captureMarkdown(capture) {
  return markdownRecord(
    {
      id: capture.id,
      type: "capture",
      kind: capture.kind,
      scopePath: capture.scopePath,
      projectPath: capture.projectPath,
      createdAt: capture.createdAt,
      updatedAt: capture.updatedAt,
    },
    capture.text,
  );
}

export async function listCaptures(workspace, projects = null) {
  return listRecords(workspace, "capturesPath", captureFromRecord, projects, { sortKey: "createdAt", override: assignProjectScope });
}

export async function createCapture(workspace, input, projects = null) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const text = assertString(input?.text, "text");
  const kind = input?.kind == null ? inferCaptureKind(text) : assertString(input.kind, "kind", { max: 20 }).toLowerCase();
  if (!CAPTURE_KINDS.has(kind)) {
    throw new WorkspaceError("kind must be idea, question, or update.", { code: "invalid_input" });
  }
  const scopePath = await validateProjectScopePath(workspace.root, input?.scopePath ?? ".", knownProjects);
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const now = new Date().toISOString();
  const capture = {
    id: recordId("capture"),
    text,
    kind,
    scopePath,
    projectPath,
    createdAt: now,
    updatedAt: now,
  };
  await writeRecord(workspace, "capturesPath", capture, captureMarkdown(capture));
  return capture;
}

export async function updateCaptureDestination(workspace, id, input, projects = null) {
  assertRecordId(id, "capture");
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const { value: capture, pathname } = await readStoredRecord(workspace, "capturesPath", `${id}.md`, captureFromRecord, "Capture");
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const scopePath = projectPath ?? await validateProjectScopePath(workspace.root, input?.scopePath ?? ".", knownProjects);
  const updated = { ...capture, scopePath, projectPath, updatedAt: new Date().toISOString() };
  await writeRecord(workspace, "capturesPath", updated, captureMarkdown(updated), pathname);
  return updated;
}

export async function deleteCapture(workspace, id) {
  assertRecordId(id, "capture");
  await deleteRecord(workspace, "capturesPath", id, "Capture");
}

// Ideas merged into notes: a record still sitting in .work/ideas/ loads as a
// note. Idea-only frontmatter (status, tags, source, revisitAt, history) has no
// note equivalent, so it is appended to the body as plain text lines.
function ideaRecordAsNote(record, pathname) {
  const { metadata, body } = record;
  const match = /^idea_([a-z0-9][a-z0-9_-]{7,80})$/.exec(metadata.id ?? "");
  if (metadata.type !== "idea" || !match) {
    throw new WorkspaceError(`Invalid idea record: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const preserved = [];
  if (typeof metadata.status === "string" && metadata.status) preserved.push(`Status: ${metadata.status}`);
  if (Array.isArray(metadata.tags) && metadata.tags.length > 0) preserved.push(`Tags: ${metadata.tags.join(", ")}`);
  if (typeof metadata.source === "string" && metadata.source) preserved.push(`Source: ${metadata.source}`);
  if (typeof metadata.revisitAt === "string" && metadata.revisitAt) preserved.push(`Revisit at: ${metadata.revisitAt}`);
  for (const event of Array.isArray(metadata.history) ? metadata.history : []) {
    preserved.push(`History: ${event?.from} → ${event?.to}${event?.reason ? ` — ${event.reason}` : ""} (${event?.at})`);
  }
  const now = new Date().toISOString();
  return {
    id: `note_${match[1]}`,
    title: typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : "Untitled note",
    text: [body, preserved.join("\n")].filter(Boolean).join("\n\n"),
    scopePath: metadata.scopePath ?? ".",
    projectPath: metadata.projectPath ?? null,
    createdBy: { kind: "human", name: null },
    createdAt: metadata.createdAt ?? now,
    updatedAt: metadata.updatedAt ?? now,
  };
}

export async function listNotes(workspace, projects = null) {
  const notes = [];
  // Lazy per-record migration, matching the agentIntent tolerant-read pattern
  // below: each legacy idea record is rewritten as a note into the notes store
  // (idea_ id prefix becomes note_) the first time notes are read.
  for (const { pathname, projectPath } of await listStoredMarkdown(workspace, "ideasPath", projects)) {
    const note = ideaRecordAsNote(parseMarkdownRecord(await readFile(pathname, "utf8"), pathname), pathname);
    if (projectPath) { note.projectPath = projectPath; note.scopePath = projectPath; }
    const storage = await targetRecordStore(workspace, projectPath);
    await atomicWrite(join(storage.notesPath, `${note.id}.md`), noteMarkdown(note));
    await unlink(pathname);
    await syncDirectory(dirname(pathname));
    notes.push(note);
  }
  for (const { pathname, projectPath } of await listStoredMarkdown(workspace, "notesPath", projects)) {
    const record = parseMarkdownRecord(await readFile(pathname, "utf8"), pathname);
    const note = noteFromRecord(record, pathname);
    if (projectPath) { note.projectPath = projectPath; note.scopePath = projectPath; }
    // Tolerant read: records written before a schema change (missing createdBy,
    // or carrying the removed agentIntent field) still load; rewriting drops
    // removed fields and fills defaults.
    if ("agentIntent" in record.metadata || record.metadata.createdBy == null) await atomicWrite(pathname, noteMarkdown(note));
    notes.push(note);
  }
  return notes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function noteMarkdown(note) {
  return markdownRecord(
    {
      id: note.id,
      type: "note",
      title: note.title,
      scopePath: note.scopePath,
      projectPath: note.projectPath,
      createdBy: note.createdBy,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    },
    note.text,
  );
}

export async function createNote(workspace, input, projects = null, { createdBy = { kind: "human", name: null } } = {}) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const title = input?.title == null
    ? "Untitled note"
    : assertString(input.title, "title", { max: 300 });
  const text = input?.text == null
    ? ""
    : assertString(input.text, "text", { allowEmpty: true });
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const scopePath = projectPath ?? await validateProjectScopePath(workspace.root, input?.scopePath ?? ".", knownProjects);
  const now = new Date().toISOString();
  const note = {
    id: recordId("note"),
    title,
    text,
    scopePath,
    projectPath,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await writeRecord(workspace, "notesPath", note, noteMarkdown(note));
  return note;
}

function assertAgentOwnsNote(note, agentName) {
  if (note.createdBy.kind !== "agent") {
    throw new WorkspaceError("Agents cannot modify human-created notes.", { code: "agent_note_forbidden", status: 403 });
  }
  if (note.createdBy.name !== agentName) {
    throw new WorkspaceError(`This note belongs to agent ${note.createdBy.name}.`, { code: "agent_note_forbidden", status: 403 });
  }
}

export async function updateNote(workspace, id, input, { agentName = null } = {}) {
  assertRecordId(id, "note");
  const { value: note, pathname } = await readStoredRecord(workspace, "notesPath", `${id}.md`, noteFromRecord, "Note", { override: assignProjectScope });
  if (agentName) assertAgentOwnsNote(note, agentName);
  const updated = {
    ...note,
    title: input?.title == null ? note.title : assertString(input.title, "title", { max: 300 }),
    text: input?.text == null ? note.text : assertString(input.text, "text", { allowEmpty: true }),
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(pathname, noteMarkdown(updated));
  return updated;
}

export async function deleteNote(workspace, id, { agentName = null } = {}) {
  assertRecordId(id, "note");
  await deleteRecord(workspace, "notesPath", id, "Note", agentName
    ? (record, pathname) => assertAgentOwnsNote(noteFromRecord(record, pathname), agentName)
    : null);
}

// CONTRACT §2: delegation is the human's signal. An agent identity can never
// flip it, on tasks or issues, exactly like the agents list it replaced.
function assertHumanDelegation(agentName) {
  if (agentName) {
    throw new WorkspaceError("Only a human can hand an item to an agent.", { code: "agent_delegation_forbidden", status: 403 });
  }
}

function issueActor(kind, name = null) {
  if (kind === "human") return { kind: "human", name: null };
  if (kind !== "agent") {
    throw new WorkspaceError("Issue actor must be human or agent.", { code: "invalid_actor" });
  }
  const normalized = assertString(name, "agentName", { max: 120 });
  if (/[\r\n]/.test(normalized)) {
    throw new WorkspaceError("agentName must be one line.", { code: "invalid_actor" });
  }
  return { kind: "agent", name: normalized };
}

function generatedIssueTitle(body) {
  const firstLine = body.split(/\r?\n/).find((line) => line.trim()) ?? "Untitled issue";
  const plain = firstLine
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .trim();
  return (plain || "Untitled issue").slice(0, 300).trim();
}

function issueTranscript(issue) {
  const replies = issue.messages.map((message) => {
    const label = message.author.kind === "agent"
      ? `Agent: ${message.author.name}`
      : "Human";
    return `### ${label} · ${message.createdAt}\n\n${message.body}`;
  });
  return [
    `# ${issue.title}`,
    "## Issue",
    issue.body,
    ...(replies.length ? ["## Replies", ...replies] : []),
  ].join("\n\n");
}

function validIssueActor(value) {
  if (value?.kind === "human" && value.name === null) return { kind: "human", name: null };
  try {
    return value?.kind === "agent" ? issueActor("agent", value.name) : null;
  } catch {
    return null;
  }
}

function issueFromRecord(record, pathname) {
  const { metadata } = record;
  if (
    metadata.type !== "issue" ||
    !RECORD_ID_PATTERN.test(metadata.id ?? "") ||
    !metadata.id.startsWith("issue_") ||
    !ISSUE_STATES.has(metadata.state)
  ) {
    throw new WorkspaceError(`Invalid issue record: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const body = typeof metadata.body === "string" ? metadata.body : "";
  if (!body.trim() || body.length > MAX_TEXT_LENGTH) {
    throw new WorkspaceError(`Invalid issue body: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const messages = Array.isArray(metadata.messages) ? metadata.messages.map((message) => {
    const author = validIssueActor(message?.author);
    if (
      typeof message?.id !== "string" ||
      !ISSUE_MESSAGE_ID_PATTERN.test(message.id) ||
      typeof message.body !== "string" ||
      !message.body.trim() ||
      message.body.length > MAX_TEXT_LENGTH ||
      !author ||
      typeof message.createdAt !== "string"
    ) {
      throw new WorkspaceError(`Invalid issue message: ${pathname}`, { code: "invalid_record", status: 409 });
    }
    return { id: message.id, body: message.body, author, createdAt: message.createdAt };
  }) : [];
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    throw new WorkspaceError(`Duplicate issue message id: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const stateHistory = Array.isArray(metadata.stateHistory) ? metadata.stateHistory.map((event) => {
    const actor = validIssueActor(event?.actor);
    if (
      !actor ||
      (event.from !== null && !ISSUE_STATES.has(event.from)) ||
      !ISSUE_STATES.has(event.to) ||
      typeof event.at !== "string" ||
      (event.reason != null && (typeof event.reason !== "string" || event.reason.length > 20_000)) ||
      (event.resolutionSummary != null && (typeof event.resolutionSummary !== "string" || event.resolutionSummary.length > MAX_TEXT_LENGTH))
    ) {
      throw new WorkspaceError(`Invalid issue state history: ${pathname}`, { code: "invalid_record", status: 409 });
    }
    return {
      from: event.from,
      to: event.to,
      actor,
      at: event.at,
      reason: typeof event.reason === "string" ? event.reason : null,
      resolutionSummary: typeof event.resolutionSummary === "string" ? event.resolutionSummary : null,
    };
  }) : [];
  if (
    stateHistory.length === 0 ||
    stateHistory[0].from !== null ||
    stateHistory.at(-1).to !== metadata.state ||
    stateHistory.some((event, index) => index > 0 && event.from !== stateHistory[index - 1].to)
  ) {
    throw new WorkspaceError(`Invalid issue state history chain: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const claimedBy = metadata.claimedBy == null ? null : validIssueActor(metadata.claimedBy);
  if (metadata.claimedBy != null && claimedBy?.kind !== "agent") {
    throw new WorkspaceError(`Invalid issue claimant: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const resolutionSummary = metadata.resolutionSummary == null ? null : metadata.resolutionSummary;
  if (
    (resolutionSummary !== null && (typeof resolutionSummary !== "string" || resolutionSummary.length > MAX_TEXT_LENGTH)) ||
    (metadata.state === "resolved" && (typeof resolutionSummary !== "string" || !resolutionSummary.trim()))
  ) {
    throw new WorkspaceError(`Invalid issue resolution: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  if (
    typeof metadata.title !== "string" ||
    !metadata.title.trim() ||
    metadata.title.trim().length > 300 ||
    /[\r\n]/.test(metadata.title)
  ) {
    throw new WorkspaceError(`Invalid issue title: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  return {
    id: metadata.id,
    title: metadata.title.trim(),
    body,
    state: metadata.state,
    scopePath: metadata.scopePath ?? ".",
    projectPath: metadata.projectPath ?? null,
    // A legacy agents list is history, not a delegation signal (see the task
    // parser). Delegation is only ever an explicit human tick.
    delegated: metadata.delegated === true,
    refs: Array.isArray(metadata.refs) ? metadata.refs : [],
    claimedBy,
    resolutionSummary,
    messages,
    stateHistory,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

async function writeIssue(issue, priorMetadata = {}, sourcePath = null, workspace) {
  // The legacy agents list is dropped on rewrite; delegated replaces it.
  const { agents: _legacyAgents, ...prior } = priorMetadata;
  await writeRecord(
    workspace,
    "issuesPath",
    issue,
    markdownRecord(
      {
        ...prior,
        id: issue.id,
        type: "issue",
        title: issue.title,
        body: issue.body,
        state: issue.state,
        scopePath: issue.scopePath,
        projectPath: issue.projectPath,
        delegated: issue.delegated,
        refs: issue.refs,
        claimedBy: issue.claimedBy,
        resolutionSummary: issue.resolutionSummary,
        messages: issue.messages,
        stateHistory: issue.stateHistory,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      },
      issueTranscript(issue),
    ),
    sourcePath,
  );
}

async function readIssueRecord(workspace, id) {
  assertRecordId(id, "issue");
  const { value: issue, record, pathname } = await readStoredRecord(workspace, "issuesPath", `${id}.md`, issueFromRecord, "Issue", { override: assignIssueProject });
  return { issue, record, pathname };
}

export async function listIssues(workspace, projects = null) {
  return listRecords(workspace, "issuesPath", issueFromRecord, projects, { override: assignIssueProject });
}

export async function getIssue(workspace, id) {
  return (await readIssueRecord(workspace, id)).issue;
}

export async function createIssue(workspace, input, projects = null, { agentName = null } = {}) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const body = assertString(input?.body, "body", { trim: false });
  const title = input?.title == null
    ? generatedIssueTitle(body)
    : assertString(input.title, "title", { max: 300, oneLine: true });
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const scopePath = projectPath
    ? await validateProjectScopePath(workspace.root, input?.scopePath ?? projectPath, knownProjects)
    : await validateProjectScopePath(workspace.root, input?.scopePath ?? ".", knownProjects);
  const now = new Date().toISOString();
  const actor = agentName ? issueActor("agent", agentName) : issueActor("human");
  const issue = {
    id: recordId("issue"),
    title,
    body,
    state: "queued",
    scopePath,
    projectPath,
    // CONTRACT §3 verb 4: an agent-filed issue always starts not delegated.
    delegated: agentName ? false : input?.delegated === true,
    refs: [],
    claimedBy: null,
    resolutionSummary: null,
    messages: [],
    stateHistory: [{ from: null, to: "queued", actor, at: now, reason: "Issue filed.", resolutionSummary: null }],
    createdAt: now,
    updatedAt: now,
  };
  await writeIssue(issue, {}, null, workspace);
  return issue;
}

export async function updateIssue(workspace, id, input, { agentName = null } = {}) {
  const { issue, record, pathname } = await readIssueRecord(workspace, id);
  const changed = [];
  if ("delegated" in (input ?? {})) {
    assertHumanDelegation(agentName);
    issue.delegated = input.delegated === true;
    changed.push("delegated");
  }
  if (input?.refs != null) { issue.refs = stringArray(input.refs, "refs"); changed.push("refs"); }
  if (changed.length === 0) return issue;
  issue.updatedAt = new Date().toISOString();
  await writeIssue(issue, record.metadata, pathname, workspace);
  return issue;
}

function assertIssueAgentOwnership(issue, agentName) {
  if (!issue.claimedBy) {
    throw new WorkspaceError("Claim the issue before updating it.", { code: "issue_not_claimed", status: 409 });
  }
  if (issue.claimedBy.name !== agentName) {
    throw new WorkspaceError(`This issue is claimed by ${issue.claimedBy.name}.`, { code: "issue_claimed_by_other", status: 409 });
  }
}

function appendIssueState(issue, state, actor, { reason = null, resolutionSummary = null } = {}) {
  const now = new Date().toISOString();
  issue.stateHistory.push({ from: issue.state, to: state, actor, at: now, reason, resolutionSummary });
  issue.state = state;
  issue.updatedAt = now;
}

export async function claimIssue(workspace, id, agentName) {
  const { issue, record, pathname } = await readIssueRecord(workspace, id);
  const actor = issueActor("agent", agentName);
  if (issue.state !== "queued") {
    throw new WorkspaceError("Only a queued issue can be claimed.", { code: "issue_not_queued", status: 409 });
  }
  if (issue.claimedBy && issue.claimedBy.name !== actor.name) {
    throw new WorkspaceError(`This issue is claimed by ${issue.claimedBy.name}.`, { code: "issue_claimed_by_other", status: 409 });
  }
  issue.claimedBy = actor;
  appendIssueState(issue, "in_progress", actor, { reason: "Issue claimed." });
  await writeIssue(issue, record.metadata, pathname, workspace);
  return issue;
}

export async function replyToIssue(workspace, id, input, { agentName = null } = {}) {
  const { issue, record, pathname } = await readIssueRecord(workspace, id);
  const body = assertString(input?.body, "body", { trim: false });
  const author = agentName ? issueActor("agent", agentName) : issueActor("human");
  if (agentName) {
    if (issue.state === "closed") {
      throw new WorkspaceError("Agents cannot reply to a human-closed issue.", { code: "issue_closed", status: 409 });
    }
    assertIssueAgentOwnership(issue, agentName);
  } else if (issue.state === "needs_human" || issue.state === "resolved" || issue.state === "closed") {
    appendIssueState(issue, "queued", author, { reason: "Human reply reopened the issue." });
    issue.claimedBy = null;
    issue.resolutionSummary = null;
  }
  const now = new Date().toISOString();
  issue.messages.push({ id: recordId("message"), body, author, createdAt: now });
  issue.updatedAt = now;
  await writeIssue(issue, record.metadata, pathname, workspace);
  return issue;
}

export async function updateIssueState(workspace, id, input, { agentName = null } = {}) {
  const { issue, record, pathname } = await readIssueRecord(workspace, id);
  const state = assertString(input?.state, "state", { max: 40 });
  if (!ISSUE_STATES.has(state)) {
    throw new WorkspaceError(`state must be one of: ${[...ISSUE_STATES].join(", ")}.`, { code: "invalid_input" });
  }
  const reason = input?.reason == null
    ? null
    : assertString(input.reason, "reason", { max: 20_000 });
  if (agentName) {
    const actor = issueActor("agent", agentName);
    assertIssueAgentOwnership(issue, agentName);
    if (!new Set(["in_progress", "needs_human", "resolved"]).has(state)) {
      throw new WorkspaceError("Agents may only mark issues in progress, needing human input, or resolved.", { code: "agent_issue_state_forbidden", status: 403 });
    }
    if (issue.state === "resolved" || issue.state === "closed") {
      throw new WorkspaceError("Only a human can reopen a resolved or closed issue.", { code: "issue_reopen_forbidden", status: 409 });
    }
    const resolutionSummary = state === "resolved"
      ? assertString(input?.resolutionSummary, "resolutionSummary", { trim: false })
      : null;
    appendIssueState(issue, state, actor, { reason, resolutionSummary });
    issue.resolutionSummary = resolutionSummary;
  } else {
    const actor = issueActor("human");
    if (state === "closed") {
      if (issue.state === "closed") {
        throw new WorkspaceError("Issue is already closed.", { code: "invalid_issue_transition", status: 409 });
      }
      appendIssueState(issue, "closed", actor, { reason });
    } else if (state === "queued") {
      if (issue.state !== "resolved" && issue.state !== "closed") {
        throw new WorkspaceError("Only a resolved or closed issue can be reopened.", { code: "invalid_issue_transition", status: 409 });
      }
      appendIssueState(issue, "queued", actor, { reason: reason ?? "Issue reopened by a human." });
      issue.claimedBy = null;
      issue.resolutionSummary = null;
    } else {
      throw new WorkspaceError("Humans may close an issue or reopen it to queued.", { code: "human_issue_state_forbidden", status: 403 });
    }
  }
  await writeIssue(issue, record.metadata, pathname, workspace);
  return issue;
}

export async function listDecisions(workspace, projects = null) {
  return listRecords(workspace, "decisionsPath", decisionFromRecord, projects, { sortKey: "createdAt" });
}

export async function createDecision(workspace, input, projects = null) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const title = assertString(input?.title, "title", { max: 500, oneLine: true });
  const detail = input?.detail == null ? "" : assertString(input.detail, "detail", { allowEmpty: true });
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const options = input?.options ?? [];
  if (!Array.isArray(options) || options.length > 50) {
    throw new WorkspaceError("options must be an array with at most 50 entries.", { code: "invalid_input" });
  }
  const cleanOptions = options.map((option, index) => assertString(option, `options[${index}]`, { max: 500, oneLine: true }));
  const recommendedOption = input?.recommendedOption == null || input.recommendedOption === ""
    ? null
    : assertString(input.recommendedOption, "recommendedOption", { max: 500 });
  if (recommendedOption && !cleanOptions.includes(recommendedOption)) {
    throw new WorkspaceError("recommendedOption must exactly match one of the recorded options.", { code: "invalid_input" });
  }
  const now = new Date().toISOString();
  const decision = {
    id: recordId("decision"),
    title,
    detail,
    projectPath,
    refs: stringArray(input?.refs, "refs"),
    options: cleanOptions,
    recommendedOption,
    status: "open",
    resolution: null,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeDecision(workspace, decision);
  return decision;
}

async function writeDecision(workspace, decision, { body = null, metadata = {}, sourcePath = null } = {}) {
  if (!DECISION_STATUSES.has(decision.status)) {
    throw new WorkspaceError("Invalid decision status.", { code: "invalid_record", status: 409 });
  }
  await writeRecord(
    workspace,
    "decisionsPath",
    decision,
    markdownRecord(
      {
        ...metadata,
        id: decision.id,
        type: "decision",
        title: decision.title,
        projectPath: decision.projectPath,
        refs: decision.refs,
        options: decision.options,
        recommendedOption: decision.recommendedOption,
        status: decision.status,
        resolution: decision.resolution,
        history: decision.history,
        createdAt: decision.createdAt,
        updatedAt: decision.updatedAt,
      },
      body ?? decisionBody(decision),
    ),
    sourcePath,
  );
}

export async function applyDecisionAction(workspace, id, input, projects = null) {
  assertRecordId(id, "decision");
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const { value: decision, record: sourceRecord, pathname } = await readStoredRecord(workspace, "decisionsPath", `${id}.md`, decisionFromRecord, "Decision");

  const action = assertString(input?.action, "action", { max: 40 }).toLowerCase();
  if (!DECISION_ACTIONS.has(action)) {
    throw new WorkspaceError("Unknown decision action.", { code: "invalid_action" });
  }
  const note = input?.note == null ? null : assertString(input.note, "note", { allowEmpty: true, max: 10_000 }) || null;
  let choice = input?.choice == null ? null : input.choice;
  if (choice != null && (typeof choice !== "object" || Array.isArray(choice))) {
    throw new WorkspaceError("choice must be a JSON object when provided.", { code: "invalid_action" });
  }
  let status;

  switch (action) {
    case "approve": {
      if (decision.options.length > 0) {
        const option = typeof choice?.option === "string" ? choice.option : "";
        const customResponse = option === "Other";
        if (!decision.options.includes(option) && !customResponse) {
          throw new WorkspaceError("Choose one of the decision's recorded options.", { code: "decision_option_required" });
        }
        if (customResponse && !note) {
          throw new WorkspaceError("Write your answer before choosing Other.", { code: "decision_response_required" });
        }
        choice = { option };
      } else if (!note) {
        throw new WorkspaceError("A written response is required for this decision.", { code: "decision_response_required" });
      }
      status = "approved";
      break;
    }
    case "reject":
      status = "rejected";
      break;
    case "cancel":
      status = "cancelled";
      break;
    case "keep_unassigned":
      status = "kept_unassigned";
      choice = null;
      decision.projectPath = null;
      break;
    case "assign": {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
        throw new WorkspaceError("assign requires choice.projectPath.", { code: "invalid_action" });
      }
      const projectPath = await validateProjectPath(workspace.root, choice.projectPath, knownProjects);
      if (projectPath == null) {
        throw new WorkspaceError("assign requires choice.projectPath.", { code: "invalid_action" });
      }
      choice = { projectPath };
      decision.projectPath = projectPath;
      status = "assigned";
      break;
    }
    case "defer": {
      if (!choice || typeof choice !== "object" || Array.isArray(choice) || typeof choice.until !== "string") {
        throw new WorkspaceError("defer requires choice.until as an ISO date/time.", { code: "invalid_action" });
      }
      const parsed = new Date(choice.until);
      if (Number.isNaN(parsed.valueOf())) {
        throw new WorkspaceError("defer requires a valid choice.until date/time.", { code: "invalid_action" });
      }
      choice = { until: parsed.toISOString() };
      status = "deferred";
      break;
    }
    case "reopen":
      status = "open";
      choice = null;
      break;
    default:
      throw new WorkspaceError("Unknown decision action.", { code: "invalid_action" });
  }

  const at = new Date().toISOString();
  const event = { action, choice, note, at };
  decision.status = status;
  decision.resolution = action === "reopen" ? null : event;
  decision.history = [...decision.history, event];
  decision.updatedAt = at;
  await writeDecision(workspace, decision, { body: sourceRecord.body, metadata: sourceRecord.metadata, sourcePath: pathname });

  // Answering a linked question leaves a trace on each referenced task's
  // progress log. It never touches task status: the human decides whether an
  // answer unblocks the work.
  if (action === "approve" || action === "reject" || action === "cancel") {
    const answer = action === "approve"
      ? (choice?.option && choice.option !== "Other" ? choice.option : note)
      : [action === "reject" ? "Rejected" : "Cancelled", note].filter(Boolean).join(" — ");
    for (const ref of decision.refs) {
      if (!TASK_ID_PATTERN.test(ref)) continue;
      try {
        await appendTaskLog(workspace, ref, { message: `Answered “${decision.title}” — ${answer}` });
      } catch {
        // A ref to a task that no longer exists must not block the answer.
      }
    }
  }
  return decision;
}

const TASK_SECTION_ORDER = [
  ["description", "Description"],
  ["goal", "Goal"],
  ["requirements", "Requirements"],
  ["acceptanceCriteria", "Acceptance Criteria"],
  ["plan", "Plan"],
  ["notes", "Notes"],
  ["progressLog", "Progress Log"],
  ["completionSummary", "Completion Summary"],
];

function normalizeSectionName(heading) {
  const normalized = heading.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (normalized === "description") return "description";
  if (normalized === "goal") return "goal";
  if (normalized === "requirements") return "requirements";
  if (normalized === "acceptance criteria") return "acceptanceCriteria";
  if (normalized === "plan" || normalized === "implementation plan") return "plan";
  if (normalized === "notes" || normalized === "implementation notes") return "notes";
  if (normalized === "progress" || normalized === "progress log") return "progressLog";
  if (normalized === "completion summary" || normalized === "final summary") return "completionSummary";
  return heading.trim();
}

// A section body may itself contain "## " at the start of a line, and the file
// format uses that same marker for section boundaries. Escaping it on the way
// out and restoring it on the way in makes the round trip lossless; Markdown
// renders "\\##" as a literal "##", so the file still reads correctly.
// Without this, a description containing headers was re-parsed as several
// sections, the description came back empty, and later edits wrote that empty
// value over the real content while reporting success. (W-0144, 2026-08-13.)
function escapeSectionBody(text) {
  return String(text ?? "").replace(/^(\\*)(##\s)/gm, (_, slashes, marker) => `\\${slashes}${marker}`);
}

function unescapeSectionBody(text) {
  return String(text ?? "").replace(/^\\(\\*##\s)/gm, "$1");
}

function parseTaskSections(body) {
  const sections = {};
  const extras = [];
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const contentStart = match.index + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? body.length;
    const heading = match[1].trim();
    const key = normalizeSectionName(heading);
    const content = unescapeSectionBody(body.slice(contentStart, contentEnd).trim());
    if (TASK_SECTION_ORDER.some(([known]) => known === key)) sections[key] = content;
    else extras.push({ heading, content });
  }
  for (const [key] of TASK_SECTION_ORDER) sections[key] ??= "";
  return { sections, extras };
}

function checklistItems(content) {
  const items = [];
  for (const match of content.matchAll(/^-\s+\[([ xX])\]\s+(.+)$/gm)) {
    items.push({ checked: match[1].toLowerCase() === "x", text: match[2].trim() });
  }
  return items;
}

function checklistMarkdown(items) {
  return items.map((item) => `- [${item.checked ? "x" : " "}] ${item.text}`).join("\n");
}

function parseProgressLog(content) {
  return content
    .split("\n")
    .map((line) => line.match(/^-\s+(.+?)\s+—\s+([\s\S]+)$/))
    .filter(Boolean)
    .map((match) => ({ at: match[1].trim(), message: match[2].trim() }));
}

function appendProgress(sections, message, at = new Date().toISOString()) {
  const entry = `- ${at} — ${message}`;
  return { ...sections, progressLog: sections.progressLog ? `${sections.progressLog}\n${entry}` : entry };
}

function taskBody(task) {
  const blocks = [];
  for (const [key, heading] of TASK_SECTION_ORDER) {
    blocks.push(`## ${heading}\n${escapeSectionBody(task.sections[key])}`.trimEnd());
  }
  for (const extra of task.extraSections ?? []) {
    blocks.push(`## ${extra.heading}\n${escapeSectionBody(extra.content)}`.trimEnd());
  }
  return blocks.join("\n\n");
}

// ponytail: pre-0.3 task records used snake_case frontmatter (project_path,
// task_type, …). This tolerant read camelizes those keys and the next write
// persists clean camelCase; delete the shim after one release.
const LEGACY_TASK_KEY = /^(project|task|depends|blocked|parent|due|created|updated|started|completed|cancelled)_/;

function tolerantTaskMetadata(raw) {
  const metadata = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = LEGACY_TASK_KEY.test(key)
      ? key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()).replace(/^taskType$/, "type")
      : key;
    metadata[target] ??= value;
  }
  return metadata;
}

function taskFromRecord(record, pathname) {
  const metadata = tolerantTaskMetadata(record.metadata);
  if (!TASK_ID_PATTERN.test(metadata.id ?? "")) {
    throw new WorkspaceError(`Invalid task record: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const { sections, extras } = parseTaskSections(record.body);
  const task = {
    id: metadata.id,
    title: metadata.title ?? metadata.id,
    status: metadata.status ?? "backlog",
    projectPath: metadata.projectPath ?? null,
    // Tolerant read: legacy records carried priority, type, assignee,
    // estimate, and an agents list. A legacy agents list is history — it
    // recorded which agent did the work in an older system — and must NOT
    // read as delegated: doing so silently offered 96 finished records to
    // the runner. Delegation is only ever an explicit human tick.
    delegated: metadata.delegated === true,
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    refs: Array.isArray(metadata.refs) ? metadata.refs : [],
    dependsOn: Array.isArray(metadata.dependsOn) ? metadata.dependsOn : [],
    blockedBy: Array.isArray(metadata.blockedBy) ? metadata.blockedBy : [],
    blockedReason: metadata.blockedReason ?? null,
    parentId: metadata.parentId ?? null,
    dueAt: metadata.dueAt ?? null,
    source: metadata.source ?? null,
    createdAt: metadata.createdAt ?? null,
    updatedAt: metadata.updatedAt ?? null,
    startedAt: metadata.startedAt ?? null,
    completedAt: metadata.completedAt ?? null,
    cancelledAt: metadata.cancelledAt ?? null,
    sections,
    extraSections: extras,
  };
  return {
    ...task,
    requirements: checklistItems(sections.requirements),
    acceptanceCriteria: checklistItems(sections.acceptanceCriteria),
    log: parseProgressLog(sections.progressLog),
  };
}

function assertTaskId(id, field = "id") {
  if (typeof id !== "string" || !TASK_ID_PATTERN.test(id)) {
    throw new WorkspaceError(`${field} must be a Work task id such as W-0001.`, { code: "invalid_id" });
  }
  return id;
}

function stringArray(value, field, { taskIds = false } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new WorkspaceError(`${field} must be an array with at most 200 entries.`, { code: "invalid_input" });
  }
  return value.map((item, index) => {
    const clean = assertString(item, `${field}[${index}]`, { max: 500 });
    if (taskIds) assertTaskId(clean, `${field}[${index}]`);
    return clean;
  });
}

function taskStatuses(workspace) {
  return [...workspace.statuses, ...RESERVED_TASK_STATUSES];
}

function validateTaskStatus(workspace, status) {
  const clean = assertString(status, "status", { max: 80 }).toLowerCase();
  if (!taskStatuses(workspace).includes(clean)) {
    throw new WorkspaceError(`status must be one of: ${taskStatuses(workspace).join(", ")}.`, { code: "invalid_status" });
  }
  return clean;
}

async function readTaskRecord(workspace, id) {
  assertTaskId(id);
  const { value: task, record, pathname } = await readStoredRecord(workspace, "tasksPath", `${id}.md`, taskFromRecord, "Task");
  return { task, record, pathname };
}

async function writeTask(workspace, task, priorMetadata = {}, sourcePath = null) {
  // Camelizing drops legacy snake_case keys; destructuring drops the removed
  // fields (priority, type, assignee, estimate, agents) so a rewrite is clean.
  const {
    priority: _priority,
    type: _type,
    assignee: _assignee,
    estimate: _estimate,
    agents: _agents,
    ...prior
  } = tolerantTaskMetadata(priorMetadata);
  await writeRecord(
    workspace,
    "tasksPath",
    task,
    markdownRecord(
      {
        ...prior,
        id: task.id,
        title: task.title,
        status: task.status,
        projectPath: task.projectPath,
        delegated: task.delegated,
        tags: task.tags,
        refs: task.refs,
        dependsOn: task.dependsOn,
        blockedBy: task.blockedBy,
        blockedReason: task.blockedReason,
        parentId: task.parentId,
        dueAt: task.dueAt,
        source: task.source,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        cancelledAt: task.cancelledAt,
      },
      taskBody(task),
    ),
    sourcePath,
  );
}

export async function listTasks(workspace, projects = null) {
  return listRecords(workspace, "tasksPath", taskFromRecord, projects);
}

export async function getTask(workspace, id) {
  return (await readTaskRecord(workspace, id)).task;
}

function nextTaskId(tasks, idFloor = 0) {
  const highest = tasks.reduce((max, task) => Math.max(max, Number(task.id.slice(2)) || 0), 0);
  return `W-${String(Math.max(idFloor, highest + 1)).padStart(4, "0")}`;
}

function normalizedChecklist(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 500) {
    throw new WorkspaceError(`${field} must be an array with at most 500 entries.`, { code: "invalid_input" });
  }
  return value.map((item, index) => {
    if (typeof item === "string") return { checked: false, text: assertString(item, `${field}[${index}]`, { max: 2_000 }) };
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return { checked: Boolean(item.checked), text: assertString(item.text, `${field}[${index}].text`, { max: 2_000 }) };
    }
    throw new WorkspaceError(`${field}[${index}] must be text or a checklist item.`, { code: "invalid_input" });
  });
}

export async function createTask(workspace, input, projects = null, { agentName = null } = {}) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const title = assertString(input?.title, "title", { max: 500, oneLine: true });
  const status = validateTaskStatus(workspace, input?.status ?? workspace.statuses[0]);
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  if (input?.delegated) assertHumanDelegation(agentName);
  const tasks = await listTasks(workspace);
  const id = nextTaskId(tasks, workspace.idFloor ?? 0);
  const now = new Date().toISOString();
  const requirements = normalizedChecklist(input?.requirements, "requirements");
  const acceptanceCriteria = normalizedChecklist(input?.acceptanceCriteria, "acceptanceCriteria");
  let sections = {
    description: input?.description == null ? "" : assertString(input.description, "description", { allowEmpty: true }),
    goal: input?.goal == null ? "" : assertString(input.goal, "goal", { allowEmpty: true }),
    requirements: checklistMarkdown(requirements),
    acceptanceCriteria: checklistMarkdown(acceptanceCriteria),
    plan: input?.plan == null ? "" : assertString(input.plan, "plan", { allowEmpty: true }),
    notes: input?.notes == null ? "" : assertString(input.notes, "notes", { allowEmpty: true }),
    progressLog: "",
    completionSummary: "",
  };
  sections = appendProgress(sections, `Created in ${status}${projectPath ? ` for ${projectPath}` : " without a project assignment"}.`, now);
  const task = {
    id,
    title,
    status,
    projectPath,
    delegated: input?.delegated === true,
    tags: stringArray(input?.tags, "tags"),
    refs: stringArray(input?.refs, "refs"),
    dependsOn: stringArray(input?.dependsOn, "dependsOn", { taskIds: true }),
    blockedBy: stringArray(input?.blockedBy, "blockedBy", { taskIds: true }),
    blockedReason: input?.blockedReason == null ? null : assertString(input.blockedReason, "blockedReason", { allowEmpty: true, max: 10_000 }) || null,
    parentId: input?.parentId == null ? null : assertTaskId(input.parentId, "parentId"),
    dueAt: input?.dueAt == null ? null : new Date(input.dueAt).toISOString(),
    source: input?.source == null ? null : assertString(String(input.source), "source", { max: 500 }),
    createdAt: now,
    updatedAt: now,
    startedAt: status === "in_progress" ? now : null,
    completedAt: status === "done" ? now : null,
    cancelledAt: status === "cancelled" ? now : null,
    sections,
    extraSections: [],
  };
  await writeTask(workspace, task);
  return (await readTaskRecord(workspace, id)).task;
}

async function ensureDependenciesComplete(workspace, task, status, tasks) {
  if (status !== "done") return;
  const unfinished = task.dependsOn.filter((dependencyId) => {
    const dependency = tasks.find((candidate) => candidate.id === dependencyId);
    return !dependency || dependency.status !== "done";
  });
  if (unfinished.length > 0) {
    throw new WorkspaceError(`Cannot complete ${task.id}; unfinished dependencies: ${unfinished.join(", ")}.`, { code: "blocked_dependency", status: 409 });
  }
}

function ensureReviewChecklistComplete(task, status) {
  if (status !== "review") return;
  const checklist = [
    ...checklistItems(task.sections.requirements).map((item) => ({ ...item, section: "requirement" })),
    ...checklistItems(task.sections.acceptanceCriteria).map((item) => ({ ...item, section: "acceptance criterion" })),
  ];
  const incomplete = checklist.filter((item) => !item.checked);
  if (incomplete.length === 0) return;
  const preview = incomplete.slice(0, 3).map((item) => `${item.section}: ${item.text}`).join("; ");
  const more = incomplete.length > 3 ? `; plus ${incomplete.length - 3} more` : "";
  throw new WorkspaceError(
    `Cannot move ${task.id} to review with ${incomplete.length} unchecked checklist ${incomplete.length === 1 ? "item" : "items"}. Verify and check completed work first (${preview}${more}).`,
    { code: "review_checklist_incomplete", status: 409 },
  );
}

export async function moveTask(workspace, id, input, { agentName = null } = {}) {
  const { task, record, pathname } = await readTaskRecord(workspace, id);
  const status = validateTaskStatus(workspace, input?.status);
  if (agentName && !new Set(["in_progress", "review", "blocked"]).has(status)) {
    throw new WorkspaceError("Agents may only move tasks to in_progress, review, or blocked.", { code: "task_status_forbidden", status: 403 });
  }
  if (status === task.status) return task;
  const tasks = await listTasks(workspace);
  await ensureDependenciesComplete(workspace, task, status, tasks);
  ensureReviewChecklistComplete(task, status);
  const now = new Date().toISOString();
  const previous = task.status;
  task.status = status;
  task.updatedAt = now;
  if (status === "in_progress" && !task.startedAt) task.startedAt = now;
  if (status === "done") task.completedAt = now;
  else if (previous === "done") task.completedAt = null;
  if (status === "cancelled") task.cancelledAt = now;
  else if (previous === "cancelled") task.cancelledAt = null;
  const note = input?.note == null ? "" : assertString(input.note, "note", { allowEmpty: true, max: 10_000 });
  task.sections = appendProgress(task.sections, `Moved from ${previous} to ${status}.${note ? ` ${note}` : ""}`, now);
  await writeTask(workspace, task, record.metadata, pathname);
  return (await readTaskRecord(workspace, id)).task;
}

export async function updateTask(workspace, id, input, projects = null, { agentName = null } = {}) {
  if (agentName) {
    throw new WorkspaceError("Agents cannot edit tasks; use the move, log, and checklist routes.", { code: "agent_task_edit_forbidden", status: 403 });
  }
  if (input?.status != null) {
    await moveTask(workspace, id, { status: input.status, note: input.statusNote }, { agentName });
  }
  const { task, record, pathname } = await readTaskRecord(workspace, id);
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const changed = [];
  if (input?.title != null) {
    const title = assertString(input.title, "title", { max: 500 });
    if (title !== task.title) { task.title = title; changed.push("title"); }
  }
  if ("projectPath" in (input ?? {})) { task.projectPath = await validateProjectPath(workspace.root, input.projectPath, knownProjects); changed.push("project"); }
  if ("delegated" in (input ?? {})) { task.delegated = input.delegated === true; changed.push("delegation"); }
  if (input?.tags != null) { task.tags = stringArray(input.tags, "tags"); changed.push("tags"); }
  if (input?.refs != null) { task.refs = stringArray(input.refs, "refs"); changed.push("refs"); }
  if (input?.dependsOn != null) { task.dependsOn = stringArray(input.dependsOn, "dependsOn", { taskIds: true }); changed.push("dependencies"); }
  if (input?.blockedBy != null) { task.blockedBy = stringArray(input.blockedBy, "blockedBy", { taskIds: true }); changed.push("blockers"); }
  if ("blockedReason" in (input ?? {})) { task.blockedReason = input.blockedReason == null ? null : assertString(input.blockedReason, "blockedReason", { allowEmpty: true, max: 10_000 }) || null; changed.push("blocked reason"); }
  if ("parentId" in (input ?? {})) { task.parentId = input.parentId == null ? null : assertTaskId(input.parentId, "parentId"); changed.push("parent"); }
  if ("dueAt" in (input ?? {})) { task.dueAt = input.dueAt == null ? null : new Date(input.dueAt).toISOString(); changed.push("due date"); }
  for (const section of ["description", "goal", "plan", "notes", "completionSummary"]) {
    if (input?.[section] == null) continue;
    const value = assertString(input[section], section, { allowEmpty: true });
    // Only a real difference counts as a change. Writing the same value used to
    // log "Updated description" anyway, so three PATCHes that silently
    // discarded content each reported success. A no-op now says nothing.
    if (value === task.sections[section]) continue;
    task.sections[section] = value;
    changed.push(section);
  }
  if (input?.extraSections != null) {
    // Sections Work does not know by name. Editable so content that landed
    // there — including anything the "## " parsing bug split out — can be
    // folded back where it belongs.
    if (!Array.isArray(input.extraSections)) {
      throw new WorkspaceError("extraSections must be an array.", { code: "invalid_input" });
    }
    const extras = input.extraSections.map((entry) => ({
      heading: assertString(entry?.heading, "extraSections.heading", { max: 200 }),
      content: assertString(entry?.content ?? "", "extraSections.content", { allowEmpty: true }),
    }));
    if (JSON.stringify(extras) !== JSON.stringify(task.extraSections ?? [])) {
      task.extraSections = extras;
      changed.push("extra sections");
    }
  }
  if (input?.requirements != null) { task.sections.requirements = checklistMarkdown(normalizedChecklist(input.requirements, "requirements")); changed.push("requirements"); }
  if (input?.acceptanceCriteria != null) { task.sections.acceptanceCriteria = checklistMarkdown(normalizedChecklist(input.acceptanceCriteria, "acceptanceCriteria")); changed.push("acceptance criteria"); }
  if (changed.length === 0) return task;
  const now = new Date().toISOString();
  task.updatedAt = now;
  task.sections = appendProgress(task.sections, `Updated ${changed.join(", ")}.`, now);
  await writeTask(workspace, task, record.metadata, pathname);
  return (await readTaskRecord(workspace, id)).task;
}

export async function toggleTaskChecklist(workspace, id, input) {
  const { task, record, pathname } = await readTaskRecord(workspace, id);
  const section = input?.section === "requirements" ? "requirements" : input?.section === "acceptance" ? "acceptanceCriteria" : null;
  if (!section) throw new WorkspaceError("section must be requirements or acceptance.", { code: "invalid_input" });
  const index = Number(input?.index);
  const items = checklistItems(task.sections[section]);
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new WorkspaceError("Checklist item not found.", { code: "not_found", status: 404 });
  }
  items[index].checked = Boolean(input.checked);
  task.sections[section] = checklistMarkdown(items);
  const now = new Date().toISOString();
  task.updatedAt = now;
  task.sections = appendProgress(task.sections, `${items[index].checked ? "Completed" : "Reopened"} ${section === "requirements" ? "requirement" : "acceptance criterion"}: ${items[index].text}.`, now);
  await writeTask(workspace, task, record.metadata, pathname);
  return (await readTaskRecord(workspace, id)).task;
}

export async function appendTaskLog(workspace, id, input) {
  const { task, record, pathname } = await readTaskRecord(workspace, id);
  const message = assertString(input?.message, "message", { max: 20_000 });
  const now = new Date().toISOString();
  task.updatedAt = now;
  task.sections = appendProgress(task.sections, message, now);
  await writeTask(workspace, task, record.metadata, pathname);
  return (await readTaskRecord(workspace, id)).task;
}

async function readSnapshotRecords(workspace, projects) {
  const [captures, decisions, issues, notes, tasks] = await Promise.all([
    listCaptures(workspace, projects),
    listDecisions(workspace, projects),
    listIssues(workspace, projects),
    listNotes(workspace, projects),
    listTasks(workspace, projects),
  ]);
  return { captures, decisions, issues, notes, tasks };
}

/** Project paths a record set references but the project list does not contain. */
export function missingProjectPaths(projects, recordGroups) {
  const known = new Set(projects.map((project) => project.path));
  const missing = new Set();
  for (const records of recordGroups) {
    for (const record of records) {
      const path = record?.projectPath;
      if (path && !known.has(path)) missing.add(path);
    }
  }
  return [...missing];
}

export async function workspaceSnapshot(workspace) {
  // The project list is resolved before the records are read, so a project
  // created in between — the CLI writes markers straight to disk — appears in
  // the records and not in the list. A client cannot tell that stale list from
  // a real misfiling, and one agent read it as the user filing work wrongly.
  // So: assemble, check the snapshot against itself, and rescan once if it
  // referenced a project it did not list.
  let projects = await discoverProjects(workspace.root);
  let records = await readSnapshotRecords(workspace, projects);
  if (missingProjectPaths(projects, Object.values(records)).length > 0) {
    projects = await discoverProjects(workspace.root, { forceRefresh: true });
    records = await readSnapshotRecords(workspace, projects);
  }
  const { captures, decisions, issues, notes, tasks } = records;
  return {
    version: 1,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      root: workspace.root,
      dataDir: workspace.dataDir,
      createdAt: workspace.createdAt,
      startScopePath: workspace.startScopePath ?? ".",
      statuses: workspace.statuses,
      idFloor: workspace.idFloor ?? 0,
    },
    projects,
    captures,
    decisions,
    issues,
    notes,
    tasks,
  };
}
