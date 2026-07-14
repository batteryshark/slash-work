import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

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

export const PROJECT_MARKERS = Object.freeze([".project"]);

const IGNORED_DIRECTORIES = new Set([
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
const TASK_PRIORITIES = new Set(["critical", "high", "medium", "low", "none"]);
const TASK_TYPES = new Set(["task", "bug", "feature", "research", "admin", "epic", "idea"]);
const NOTE_AGENT_INTENTS = new Set(["reference_only", "review_requested"]);
const IDEA_STATUSES = new Set(["open", "exploring", "deferred", "proposed", "adopted", "declined"]);
const IDEA_AGENT_INTENTS = new Set(["consideration_only", "evaluation_requested"]);
const RECORD_ID_PATTERN = /^(capture|decision|idea|note)_[a-z0-9][a-z0-9_-]{7,80}$/;
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

function assertString(value, field, { allowEmpty = false, max = MAX_TEXT_LENGTH } = {}) {
  if (typeof value !== "string") {
    throw new WorkspaceError(`${field} must be a string.`, { code: "invalid_input" });
  }
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) {
    throw new WorkspaceError(`${field} cannot be empty.`, { code: "invalid_input" });
  }
  if (normalized.length > max) {
    throw new WorkspaceError(`${field} is too long.`, { code: "invalid_input", status: 413 });
  }
  return normalized;
}

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function toPosixPath(value) {
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

async function ensureRecordStorage(root, dataPath) {
  const capturesPath = await ensureSafeDirectory(root, join(dataPath, "captures"));
  const decisionsPath = await ensureSafeDirectory(root, join(dataPath, "decisions"));
  const ideasPath = await ensureSafeDirectory(root, join(dataPath, "ideas"));
  const notesPath = await ensureSafeDirectory(root, join(dataPath, "notes"));
  const tasksPath = await ensureSafeDirectory(root, join(dataPath, "tasks"));
  return { dataPath, capturesPath, decisionsPath, ideasPath, notesPath, tasksPath };
}

async function ensureProjectStorage(workspace, projectPath) {
  const projectRoot = fromWorkspacePath(workspace.root, projectPath);
  const dataPath = await ensureSafeDirectory(workspace.root, join(projectRoot, DATA_DIRECTORY));
  const markerPath = join(dataPath, PROJECT_FILE);
  if (!(await isRegularFile(markerPath))) {
    await atomicWrite(markerPath, `${JSON.stringify({ version: 1, id: randomUUID(), name: basename(projectRoot), createdAt: new Date().toISOString() }, null, 2)}\n`);
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
  return {
    dataPath,
    capturesPath: join(dataPath, "captures"),
    decisionsPath: join(dataPath, "decisions"),
    ideasPath: join(dataPath, "ideas"),
    notesPath: join(dataPath, "notes"),
    tasksPath: join(dataPath, "tasks"),
  };
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

export async function initializeWorkspace(rootPath, { force = false } = {}) {
  const requestedRoot = await canonicalDirectory(rootPath);
  const existingRoot = force ? null : await findWorkspaceRoot(requestedRoot);
  const root = existingRoot ?? requestedRoot;
  const storage = await ensureStorage(root);
  const markerPath = join(storage.dataPath, WORKSPACE_FILE);

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
  } else {
    const now = new Date().toISOString();
    workspace = {
      version: 1,
      id: randomUUID(),
      name: basename(root),
      statuses: [...DEFAULT_TASK_STATUSES],
      createdAt: now,
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

async function projectName(directory) {
  return basename(directory);
}

async function projectMarker(directory) {
  const pathname = join(directory, DATA_DIRECTORY, PROJECT_FILE);
  if (!(await isRegularFile(pathname))) return null;
  try {
    const marker = JSON.parse(await readFile(pathname, "utf8"));
    return marker && typeof marker.id === "string"
      ? { id: marker.id, name: typeof marker.name === "string" ? marker.name : null }
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

export async function discoverProjects(rootPath, { maxDepth = Number.POSITIVE_INFINITY } = {}) {
  const root = await canonicalDirectory(rootPath);
  const projects = [];

  async function walk(directory, depth) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "EACCES" || error?.code === "EPERM") return;
      throw error;
    }

    if (
      directory !== root &&
      entries.some((entry) => entry.name === DATA_DIRECTORY && entry.isDirectory() && !entry.isSymbolicLink()) &&
      await isRegularFile(join(directory, DATA_DIRECTORY, WORKSPACE_FILE))
    ) {
      return;
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
        name: marker?.name || await projectName(directory),
        path: rel,
        depth,
        markers,
        aliasPaths: [],
        gitWorktree,
      });
    }

    if (depth >= maxDepth) return;
    const children = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRECTORIES.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) await walk(join(directory, child.name), depth + 1);
  }

  await walk(root, 0);
  return canonicalizeWorktreeProjects(projects);
}

async function recordStores(workspace) {
  const stores = [{ projectPath: null, ...workspace }];
  for (const project of await discoverProjects(workspace.root)) {
    const storage = await existingRecordStorage(workspace, project);
    if (storage) stores.push({ projectPath: project.path, ...storage });
  }
  return stores;
}

async function targetRecordStore(workspace, projectPath) {
  return projectPath ? ensureProjectStorage(workspace, projectPath) : workspace;
}

async function listStoredMarkdown(workspace, directoryField) {
  const records = [];
  for (const store of await recordStores(workspace)) {
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

export async function migrateProjectLocalStorage(workspace) {
  const projects = await discoverProjects(workspace.root);
  const projectStores = new Map();
  for (const project of projects) {
    const storage = await ensureProjectStorage(workspace, project.path);
    for (const projectPath of [project.path, ...(project.aliasPaths ?? [])]) {
      projectStores.set(projectPath, storage);
    }
  }

  for (const [directoryField, metadataField] of [["capturesPath", "projectPath"], ["decisionsPath", "projectPath"], ["ideasPath", "projectPath"], ["notesPath", "projectPath"], ["tasksPath", "project_path"]]) {
    for (const pathname of await listMarkdown(workspace[directoryField])) {
      const record = parseMarkdownRecord(await readFile(pathname, "utf8"), pathname);
      const projectPath = record.metadata[metadataField];
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
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md"))
    .map((entry) => join(directory, entry.name))
    .sort();
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
  const agentIntent = metadata.agentIntent ?? "reference_only";
  if (!NOTE_AGENT_INTENTS.has(agentIntent)) {
    throw new WorkspaceError(`Invalid note agent intent: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  return {
    id: metadata.id,
    title: typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : "Untitled note",
    text: body,
    scopePath: metadata.scopePath,
    projectPath: metadata.projectPath ?? null,
    agentIntent,
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
    options: Array.isArray(metadata.options) ? metadata.options : [],
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
    ? `\n\n## Options\n\n${decision.options.map((option) => `- ${option}`).join("\n")}`
    : "";
  return `# ${decision.title}${detail}${options}`;
}

export async function listCaptures(workspace) {
  const captures = [];
  for (const { pathname, projectPath } of await listStoredMarkdown(workspace, "capturesPath")) {
    const capture = captureFromRecord(parseMarkdownRecord(await readFile(pathname, "utf8"), pathname), pathname);
    if (projectPath) { capture.projectPath = projectPath; capture.scopePath = projectPath; }
    captures.push(capture);
  }
  return captures.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
  const storage = await targetRecordStore(workspace, capture.projectPath);
  const pathname = join(storage.capturesPath, `${capture.id}.md`);
  await atomicWrite(
    pathname,
    markdownRecord(
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
    ),
  );
  return capture;
}

export async function updateCaptureDestination(workspace, id, input, projects = null) {
  assertRecordId(id, "capture");
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const located = await findStoredRecord(workspace, "capturesPath", `${id}.md`);
  if (!located) throw new WorkspaceError("Capture not found.", { code: "not_found", status: 404 });
  let pathname = located.pathname;
  let capture;
  try {
    capture = captureFromRecord(parseMarkdownRecord(await readFile(pathname, "utf8"), pathname), pathname);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("Capture not found.", { code: "not_found", status: 404 });
    }
    throw error;
  }

  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const scopePath = projectPath ?? await validateProjectScopePath(workspace.root, input?.scopePath ?? ".", knownProjects);
  const updated = { ...capture, scopePath, projectPath, updatedAt: new Date().toISOString() };
  const target = await targetRecordStore(workspace, projectPath);
  pathname = await relocateRecord(pathname, target.capturesPath);
  await atomicWrite(
    pathname,
    markdownRecord(
      {
        id: updated.id,
        type: "capture",
        kind: updated.kind,
        scopePath: updated.scopePath,
        projectPath: updated.projectPath,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
      updated.text,
    ),
  );
  return updated;
}

export async function deleteCapture(workspace, id) {
  assertRecordId(id, "capture");
  const located = await findStoredRecord(workspace, "capturesPath", `${id}.md`);
  if (!located) throw new WorkspaceError("Capture not found.", { code: "not_found", status: 404 });
  const pathname = located.pathname;
  try {
    const details = await lstat(pathname);
    if (!details.isFile() && !details.isSymbolicLink()) throw new Error("Not a file");
    await unlink(pathname);
    await syncDirectory(dirname(pathname));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("Capture not found.", { code: "not_found", status: 404 });
    }
    throw error;
  }
}

export async function listNotes(workspace) {
  const notes = [];
  for (const { pathname, projectPath } of await listStoredMarkdown(workspace, "notesPath")) {
    const record = parseMarkdownRecord(await readFile(pathname, "utf8"), pathname);
    const note = noteFromRecord(record, pathname);
    if (projectPath) { note.projectPath = projectPath; note.scopePath = projectPath; }
    if (record.metadata.agentIntent == null) await atomicWrite(pathname, noteMarkdown(note));
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
      agentIntent: note.agentIntent,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    },
    note.text,
  );
}

export async function createNote(workspace, input, projects = null) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const title = input?.title == null
    ? "Untitled note"
    : assertString(input.title, "title", { max: 300 });
  const text = input?.text == null
    ? ""
    : assertString(input.text, "text", { allowEmpty: true });
  const agentIntent = input?.agentIntent ?? "reference_only";
  if (!NOTE_AGENT_INTENTS.has(agentIntent)) {
    throw new WorkspaceError(`agentIntent must be one of: ${[...NOTE_AGENT_INTENTS].join(", ")}.`, { code: "invalid_input" });
  }
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const scopePath = projectPath ?? await validateProjectScopePath(workspace.root, input?.scopePath ?? ".", knownProjects);
  const now = new Date().toISOString();
  const note = {
    id: recordId("note"),
    title,
    text,
    scopePath,
    projectPath,
    agentIntent,
    createdAt: now,
    updatedAt: now,
  };
  const storage = await targetRecordStore(workspace, projectPath);
  await atomicWrite(join(storage.notesPath, `${note.id}.md`), noteMarkdown(note));
  return note;
}

export async function updateNote(workspace, id, input) {
  assertRecordId(id, "note");
  const located = await findStoredRecord(workspace, "notesPath", `${id}.md`);
  if (!located) throw new WorkspaceError("Note not found.", { code: "not_found", status: 404 });
  let note;
  try {
    note = noteFromRecord(parseMarkdownRecord(await readFile(located.pathname, "utf8"), located.pathname), located.pathname);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("Note not found.", { code: "not_found", status: 404 });
    }
    throw error;
  }
  if (located.projectPath) { note.projectPath = located.projectPath; note.scopePath = located.projectPath; }
  const agentIntent = input?.agentIntent ?? note.agentIntent;
  if (!NOTE_AGENT_INTENTS.has(agentIntent)) {
    throw new WorkspaceError(`agentIntent must be one of: ${[...NOTE_AGENT_INTENTS].join(", ")}.`, { code: "invalid_input" });
  }
  const updated = {
    ...note,
    title: input?.title == null ? note.title : assertString(input.title, "title", { max: 300 }),
    text: input?.text == null ? note.text : assertString(input.text, "text", { allowEmpty: true }),
    agentIntent,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(located.pathname, noteMarkdown(updated));
  return updated;
}

export async function deleteNote(workspace, id) {
  assertRecordId(id, "note");
  const located = await findStoredRecord(workspace, "notesPath", `${id}.md`);
  if (!located) throw new WorkspaceError("Note not found.", { code: "not_found", status: 404 });
  try {
    const details = await lstat(located.pathname);
    if (!details.isFile() && !details.isSymbolicLink()) throw new Error("Not a file");
    await unlink(located.pathname);
    await syncDirectory(dirname(located.pathname));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("Note not found.", { code: "not_found", status: 404 });
    }
    throw error;
  }
}

const IDEA_SECTION_ORDER = [
  ["opportunity", "Opportunity"],
  ["whyItMightMatter", "Why It Might Matter"],
  ["hypothesis", "Hypothesis"],
  ["unknowns", "Unknowns"],
  ["potentialShape", "Potential Shape"],
  ["evidence", "Evidence"],
  ["risksAndConstraints", "Risks and Constraints"],
  ["nextEvaluation", "Next Evaluation"],
  ["outcome", "Outcome"],
];

function normalizeIdeaSectionName(heading) {
  const normalized = heading.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return IDEA_SECTION_ORDER.find(([, label]) => label.toLowerCase() === normalized)?.[0] ?? heading.trim();
}

function parseIdeaSections(body) {
  const sections = {};
  const extras = [];
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const contentStart = match.index + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? body.length;
    const heading = match[1].trim();
    const key = normalizeIdeaSectionName(heading);
    const content = body.slice(contentStart, contentEnd).trim();
    if (IDEA_SECTION_ORDER.some(([known]) => known === key)) sections[key] = content;
    else extras.push({ heading, content });
  }
  for (const [key] of IDEA_SECTION_ORDER) sections[key] ??= "";
  return { sections, extras };
}

function ideaBody(idea) {
  const blocks = IDEA_SECTION_ORDER.map(([key, heading]) => `## ${heading}\n${idea.sections[key] ?? ""}`.trimEnd());
  for (const extra of idea.extraSections ?? []) blocks.push(`## ${extra.heading}\n${extra.content ?? ""}`.trimEnd());
  return blocks.join("\n\n");
}

function ideaFromRecord(record, pathname) {
  const { metadata } = record;
  if (metadata.type !== "idea" || !RECORD_ID_PATTERN.test(metadata.id ?? "") || !metadata.id.startsWith("idea_")) {
    throw new WorkspaceError(`Invalid idea record: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const status = metadata.status ?? "open";
  const agentIntent = metadata.agentIntent ?? "consideration_only";
  if (!IDEA_STATUSES.has(status) || !IDEA_AGENT_INTENTS.has(agentIntent)) {
    throw new WorkspaceError(`Invalid idea state: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const { sections, extras } = parseIdeaSections(record.body);
  return {
    id: metadata.id,
    title: typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : "Untitled idea",
    status,
    scopePath: metadata.scopePath ?? ".",
    projectPath: metadata.projectPath ?? null,
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    source: metadata.source ?? null,
    revisitAt: metadata.revisitAt ?? null,
    agentIntent,
    history: Array.isArray(metadata.history) ? metadata.history : [],
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    sections,
    extraSections: extras,
  };
}

async function writeIdea(workspace, idea, priorMetadata = {}, sourcePath = null) {
  const storage = await targetRecordStore(workspace, idea.projectPath);
  const pathname = sourcePath ? await relocateRecord(sourcePath, storage.ideasPath) : join(storage.ideasPath, `${idea.id}.md`);
  await atomicWrite(
    pathname,
    markdownRecord(
      {
        ...priorMetadata,
        id: idea.id,
        type: "idea",
        title: idea.title,
        status: idea.status,
        scopePath: idea.scopePath,
        projectPath: idea.projectPath,
        tags: idea.tags,
        source: idea.source,
        revisitAt: idea.revisitAt,
        agentIntent: idea.agentIntent,
        history: idea.history,
        createdAt: idea.createdAt,
        updatedAt: idea.updatedAt,
      },
      ideaBody(idea),
    ),
  );
}

export async function listIdeas(workspace) {
  const ideas = [];
  for (const { pathname, projectPath } of await listStoredMarkdown(workspace, "ideasPath")) {
    const idea = ideaFromRecord(parseMarkdownRecord(await readFile(pathname, "utf8"), pathname), pathname);
    if (projectPath) { idea.projectPath = projectPath; idea.scopePath = projectPath; }
    ideas.push(idea);
  }
  return ideas.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

export async function createIdea(workspace, input, projects = null) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const title = assertString(input?.title, "title", { max: 500 });
  if (/[\r\n]/.test(title)) throw new WorkspaceError("title must be one line.", { code: "invalid_input" });
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const scopePath = projectPath ?? await validateProjectScopePath(workspace.root, input?.scopePath ?? ".", knownProjects);
  const now = new Date().toISOString();
  const sections = {};
  for (const [key] of IDEA_SECTION_ORDER) {
    sections[key] = input?.[key] == null ? "" : assertString(input[key], key, { allowEmpty: true });
  }
  const idea = {
    id: recordId("idea"),
    title,
    status: "open",
    scopePath,
    projectPath,
    tags: stringArray(input?.tags, "tags"),
    source: input?.source == null ? null : assertString(String(input.source), "source", { max: 500 }),
    revisitAt: null,
    agentIntent: "consideration_only",
    history: [],
    createdAt: now,
    updatedAt: now,
    sections,
    extraSections: [],
  };
  await writeIdea(workspace, idea);
  return idea;
}

export async function updateIdea(workspace, id, input, projects = null) {
  assertRecordId(id, "idea");
  const located = await findStoredRecord(workspace, "ideasPath", `${id}.md`);
  if (!located) throw new WorkspaceError("Idea not found.", { code: "not_found", status: 404 });
  const record = parseMarkdownRecord(await readFile(located.pathname, "utf8"), located.pathname);
  const idea = ideaFromRecord(record, located.pathname);
  if (located.projectPath) { idea.projectPath = located.projectPath; idea.scopePath = located.projectPath; }
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  if (input?.title != null) {
    idea.title = assertString(input.title, "title", { max: 500 });
    if (/[\r\n]/.test(idea.title)) throw new WorkspaceError("title must be one line.", { code: "invalid_input" });
  }
  if ("projectPath" in (input ?? {})) {
    idea.projectPath = await validateProjectPath(workspace.root, input.projectPath, knownProjects);
    idea.scopePath = idea.projectPath ?? await validateProjectScopePath(workspace.root, input?.scopePath ?? ".", knownProjects);
  }
  if (input?.tags != null) idea.tags = stringArray(input.tags, "tags");
  for (const [key] of IDEA_SECTION_ORDER) {
    if (input?.[key] != null) idea.sections[key] = assertString(input[key], key, { allowEmpty: true });
  }
  if ("revisitAt" in (input ?? {})) {
    if (input.revisitAt == null || input.revisitAt === "") idea.revisitAt = null;
    else {
      const parsed = new Date(input.revisitAt);
      if (Number.isNaN(parsed.valueOf())) throw new WorkspaceError("revisitAt must be a valid date/time.", { code: "invalid_input" });
      idea.revisitAt = parsed.toISOString();
    }
  }
  if (input?.agentIntent != null) {
    if (!IDEA_AGENT_INTENTS.has(input.agentIntent)) {
      throw new WorkspaceError(`agentIntent must be one of: ${[...IDEA_AGENT_INTENTS].join(", ")}.`, { code: "invalid_input" });
    }
    idea.agentIntent = input.agentIntent;
  }
  if (input?.status != null && input.status !== idea.status) {
    const nextStatus = assertString(input.status, "status", { max: 40 }).toLowerCase();
    if (!IDEA_STATUSES.has(nextStatus)) {
      throw new WorkspaceError(`status must be one of: ${[...IDEA_STATUSES].join(", ")}.`, { code: "invalid_input" });
    }
    const reason = input?.reason == null ? "" : assertString(input.reason, "reason", { allowEmpty: true, max: 20_000 });
    if (["deferred", "declined"].includes(nextStatus) && !reason) {
      throw new WorkspaceError(`${nextStatus === "deferred" ? "Not now" : "Closing an idea"} requires a reason.`, { code: "reason_required" });
    }
    const at = new Date().toISOString();
    idea.history = [...idea.history, { from: idea.status, to: nextStatus, reason: reason || null, at }];
    idea.status = nextStatus;
    if (reason) idea.sections.outcome = reason;
    if (["deferred", "adopted", "declined"].includes(nextStatus)) idea.agentIntent = "consideration_only";
  }
  if (idea.agentIntent === "evaluation_requested" && ["deferred", "adopted", "declined"].includes(idea.status)) {
    throw new WorkspaceError("Reopen the idea for exploration before requesting evaluation.", { code: "invalid_idea_intent" });
  }
  idea.updatedAt = new Date().toISOString();
  await writeIdea(workspace, idea, record.metadata, located.pathname);
  return idea;
}

export async function deleteIdea(workspace, id) {
  assertRecordId(id, "idea");
  const located = await findStoredRecord(workspace, "ideasPath", `${id}.md`);
  if (!located) throw new WorkspaceError("Idea not found.", { code: "not_found", status: 404 });
  try {
    const details = await lstat(located.pathname);
    if (!details.isFile() && !details.isSymbolicLink()) throw new Error("Not a file");
    await unlink(located.pathname);
    await syncDirectory(dirname(located.pathname));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("Idea not found.", { code: "not_found", status: 404 });
    }
    throw error;
  }
}

export async function listDecisions(workspace) {
  const decisions = [];
  for (const { pathname, projectPath } of await listStoredMarkdown(workspace, "decisionsPath")) {
    const decision = decisionFromRecord(parseMarkdownRecord(await readFile(pathname, "utf8"), pathname), pathname);
    if (projectPath) decision.projectPath = projectPath;
    decisions.push(decision);
  }
  return decisions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function createDecision(workspace, input, projects = null) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const title = assertString(input?.title, "title", { max: 500 });
  if (/[\r\n]/.test(title)) {
    throw new WorkspaceError("title must be a single line.", { code: "invalid_input" });
  }
  const detail = input?.detail == null ? "" : assertString(input.detail, "detail", { allowEmpty: true });
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const options = input?.options ?? [];
  if (!Array.isArray(options) || options.length > 50) {
    throw new WorkspaceError("options must be an array with at most 50 entries.", { code: "invalid_input" });
  }
  const cleanOptions = options.map((option, index) => {
    const clean = assertString(option, `options[${index}]`, { max: 500 });
    if (/[\r\n]/.test(clean)) {
      throw new WorkspaceError(`options[${index}] must be a single line.`, { code: "invalid_input" });
    }
    return clean;
  });
  const now = new Date().toISOString();
  const decision = {
    id: recordId("decision"),
    title,
    detail,
    projectPath,
    options: cleanOptions,
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
  const storage = await targetRecordStore(workspace, decision.projectPath);
  const pathname = sourcePath ? await relocateRecord(sourcePath, storage.decisionsPath) : join(storage.decisionsPath, `${decision.id}.md`);
  await atomicWrite(
    pathname,
    markdownRecord(
      {
        ...metadata,
        id: decision.id,
        type: "decision",
        title: decision.title,
        projectPath: decision.projectPath,
        options: decision.options,
        status: decision.status,
        resolution: decision.resolution,
        history: decision.history,
        createdAt: decision.createdAt,
        updatedAt: decision.updatedAt,
      },
      body ?? decisionBody(decision),
    ),
  );
}

export async function applyDecisionAction(workspace, id, input, projects = null) {
  assertRecordId(id, "decision");
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const located = await findStoredRecord(workspace, "decisionsPath", `${id}.md`);
  if (!located) throw new WorkspaceError("Decision not found.", { code: "not_found", status: 404 });
  const pathname = located.pathname;
  let decision;
  let sourceRecord;
  try {
    const details = await lstat(pathname);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Unsafe decision record");
    sourceRecord = parseMarkdownRecord(await readFile(pathname, "utf8"), pathname);
    decision = decisionFromRecord(sourceRecord, pathname);
    if (located.projectPath) decision.projectPath = located.projectPath;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("Decision not found.", { code: "not_found", status: 404 });
    }
    throw error;
  }

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
    case "approve":
      status = "approved";
      break;
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
  return decision;
}

const TASK_SECTION_ORDER = [
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
  if (normalized === "goal" || normalized === "description") return "goal";
  if (normalized === "requirements") return "requirements";
  if (normalized === "acceptance criteria") return "acceptanceCriteria";
  if (normalized === "plan" || normalized === "implementation plan") return "plan";
  if (normalized === "notes" || normalized === "implementation notes") return "notes";
  if (normalized === "progress" || normalized === "progress log") return "progressLog";
  if (normalized === "completion summary" || normalized === "final summary") return "completionSummary";
  return heading.trim();
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
    const content = body.slice(contentStart, contentEnd).trim();
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
    blocks.push(`## ${heading}\n${task.sections[key] ?? ""}`.trimEnd());
  }
  for (const extra of task.extraSections ?? []) {
    blocks.push(`## ${extra.heading}\n${extra.content ?? ""}`.trimEnd());
  }
  return blocks.join("\n\n");
}

function taskFromRecord(record, pathname) {
  const metadata = record.metadata;
  if (!TASK_ID_PATTERN.test(metadata.id ?? "")) {
    throw new WorkspaceError(`Invalid task record: ${pathname}`, { code: "invalid_record", status: 409 });
  }
  const { sections, extras } = parseTaskSections(record.body);
  const task = {
    id: metadata.id,
    title: metadata.title ?? metadata.id,
    status: metadata.status ?? "backlog",
    projectPath: metadata.project_path ?? metadata.projectPath ?? null,
    type: metadata.task_type ?? metadata.type ?? "task",
    assignee: metadata.assignee ?? null,
    agents: Array.isArray(metadata.agents) ? metadata.agents : [],
    priority: metadata.priority ?? "none",
    tags: Array.isArray(metadata.tags) ? metadata.tags : Array.isArray(metadata.labels) ? metadata.labels : [],
    dependsOn: Array.isArray(metadata.depends_on) ? metadata.depends_on : Array.isArray(metadata.dependencies) ? metadata.dependencies : [],
    blockedBy: Array.isArray(metadata.blocked_by) ? metadata.blocked_by : [],
    blockedReason: metadata.blocked_reason ?? null,
    parentId: metadata.parent_id ?? null,
    dueAt: metadata.due_at ?? null,
    estimate: metadata.estimate ?? null,
    source: metadata.source ?? null,
    createdAt: metadata.created_at ?? metadata.createdDate ?? null,
    updatedAt: metadata.updated_at ?? metadata.updatedDate ?? null,
    startedAt: metadata.started_at ?? null,
    completedAt: metadata.completed_at ?? null,
    cancelledAt: metadata.cancelled_at ?? null,
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
  const located = await findStoredRecord(workspace, "tasksPath", `${id}.md`);
  if (!located) throw new WorkspaceError("Task not found.", { code: "not_found", status: 404 });
  const pathname = located.pathname;
  try {
    const details = await lstat(pathname);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Unsafe task record");
    const record = parseMarkdownRecord(await readFile(pathname, "utf8"), pathname);
    const task = taskFromRecord(record, pathname);
    if (located.projectPath) task.projectPath = located.projectPath;
    return { task, record, pathname };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("Task not found.", { code: "not_found", status: 404 });
    }
    throw error;
  }
}

async function writeTask(workspace, task, priorMetadata = {}, sourcePath = null) {
  const storage = await targetRecordStore(workspace, task.projectPath);
  const pathname = sourcePath ? await relocateRecord(sourcePath, storage.tasksPath) : join(storage.tasksPath, `${task.id}.md`);
  await atomicWrite(
    pathname,
    markdownRecord(
      {
        ...priorMetadata,
        id: task.id,
        title: task.title,
        status: task.status,
        project_path: task.projectPath,
        task_type: task.type,
        assignee: task.assignee,
        agents: task.agents,
        priority: task.priority,
        tags: task.tags,
        depends_on: task.dependsOn,
        blocked_by: task.blockedBy,
        blocked_reason: task.blockedReason,
        parent_id: task.parentId,
        due_at: task.dueAt,
        estimate: task.estimate,
        source: task.source,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        started_at: task.startedAt,
        completed_at: task.completedAt,
        cancelled_at: task.cancelledAt,
      },
      taskBody(task),
    ),
  );
}

export async function listTasks(workspace) {
  const tasks = [];
  for (const { pathname, projectPath } of await listStoredMarkdown(workspace, "tasksPath")) {
    const task = taskFromRecord(parseMarkdownRecord(await readFile(pathname, "utf8"), pathname), pathname);
    if (projectPath) task.projectPath = projectPath;
    tasks.push(task);
  }
  return tasks.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

export async function getTask(workspace, id) {
  return (await readTaskRecord(workspace, id)).task;
}

function nextTaskId(tasks) {
  const highest = tasks.reduce((max, task) => Math.max(max, Number(task.id.slice(2)) || 0), 0);
  return `W-${String(highest + 1).padStart(4, "0")}`;
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

export async function createTask(workspace, input, projects = null) {
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const title = assertString(input?.title, "title", { max: 500 });
  if (/[\r\n]/.test(title)) throw new WorkspaceError("title must be one line.", { code: "invalid_input" });
  const status = validateTaskStatus(workspace, input?.status ?? workspace.statuses[0]);
  const projectPath = await validateProjectPath(workspace.root, input?.projectPath ?? null, knownProjects);
  const type = assertString(input?.type ?? "task", "type", { max: 40 }).toLowerCase();
  if (!TASK_TYPES.has(type)) throw new WorkspaceError(`type must be one of: ${[...TASK_TYPES].join(", ")}.`, { code: "invalid_input" });
  const priority = assertString(input?.priority ?? "none", "priority", { max: 20 }).toLowerCase();
  if (!TASK_PRIORITIES.has(priority)) throw new WorkspaceError(`priority must be one of: ${[...TASK_PRIORITIES].join(", ")}.`, { code: "invalid_input" });
  const tasks = await listTasks(workspace);
  const id = nextTaskId(tasks);
  const now = new Date().toISOString();
  const requirements = normalizedChecklist(input?.requirements, "requirements");
  const acceptanceCriteria = normalizedChecklist(input?.acceptanceCriteria, "acceptanceCriteria");
  let sections = {
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
    type,
    assignee: input?.assignee == null ? null : assertString(input.assignee, "assignee", { max: 200 }),
    agents: stringArray(input?.agents, "agents"),
    priority,
    tags: stringArray(input?.tags, "tags"),
    dependsOn: stringArray(input?.dependsOn, "dependsOn", { taskIds: true }),
    blockedBy: stringArray(input?.blockedBy, "blockedBy", { taskIds: true }),
    blockedReason: input?.blockedReason == null ? null : assertString(input.blockedReason, "blockedReason", { allowEmpty: true, max: 10_000 }) || null,
    parentId: input?.parentId == null ? null : assertTaskId(input.parentId, "parentId"),
    dueAt: input?.dueAt == null ? null : new Date(input.dueAt).toISOString(),
    estimate: input?.estimate == null ? null : assertString(String(input.estimate), "estimate", { max: 100 }),
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

export async function moveTask(workspace, id, input) {
  const { task, record, pathname } = await readTaskRecord(workspace, id);
  const status = validateTaskStatus(workspace, input?.status);
  if (status === task.status) return task;
  const tasks = await listTasks(workspace);
  await ensureDependenciesComplete(workspace, task, status, tasks);
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

export async function updateTask(workspace, id, input, projects = null) {
  if (input?.status != null) {
    await moveTask(workspace, id, { status: input.status, note: input.statusNote });
  }
  const { task, record, pathname } = await readTaskRecord(workspace, id);
  const knownProjects = projects ?? (await discoverProjects(workspace.root));
  const changed = [];
  if (input?.title != null) { task.title = assertString(input.title, "title", { max: 500 }); changed.push("title"); }
  if ("projectPath" in (input ?? {})) { task.projectPath = await validateProjectPath(workspace.root, input.projectPath, knownProjects); changed.push("project"); }
  if (input?.type != null) {
    const type = assertString(input.type, "type", { max: 40 }).toLowerCase();
    if (!TASK_TYPES.has(type)) throw new WorkspaceError("Unknown task type.", { code: "invalid_input" });
    task.type = type; changed.push("type");
  }
  if ("assignee" in (input ?? {})) { task.assignee = input.assignee == null ? null : assertString(input.assignee, "assignee", { max: 200 }); changed.push("assignee"); }
  if (input?.agents != null) { task.agents = stringArray(input.agents, "agents"); changed.push("agents"); }
  if (input?.priority != null) {
    const priority = assertString(input.priority, "priority", { max: 20 }).toLowerCase();
    if (!TASK_PRIORITIES.has(priority)) throw new WorkspaceError("Unknown priority.", { code: "invalid_input" });
    task.priority = priority; changed.push("priority");
  }
  if (input?.tags != null) { task.tags = stringArray(input.tags, "tags"); changed.push("tags"); }
  if (input?.dependsOn != null) { task.dependsOn = stringArray(input.dependsOn, "dependsOn", { taskIds: true }); changed.push("dependencies"); }
  if (input?.blockedBy != null) { task.blockedBy = stringArray(input.blockedBy, "blockedBy", { taskIds: true }); changed.push("blockers"); }
  if ("blockedReason" in (input ?? {})) { task.blockedReason = input.blockedReason == null ? null : assertString(input.blockedReason, "blockedReason", { allowEmpty: true, max: 10_000 }) || null; changed.push("blocked reason"); }
  if ("parentId" in (input ?? {})) { task.parentId = input.parentId == null ? null : assertTaskId(input.parentId, "parentId"); changed.push("parent"); }
  if ("dueAt" in (input ?? {})) { task.dueAt = input.dueAt == null ? null : new Date(input.dueAt).toISOString(); changed.push("due date"); }
  if ("estimate" in (input ?? {})) { task.estimate = input.estimate == null ? null : assertString(String(input.estimate), "estimate", { max: 100 }); changed.push("estimate"); }
  for (const section of ["goal", "plan", "notes", "completionSummary"]) {
    if (input?.[section] != null) { task.sections[section] = assertString(input[section], section, { allowEmpty: true }); changed.push(section); }
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

export async function workspaceSnapshot(workspace) {
  const projects = await discoverProjects(workspace.root);
  const [captures, decisions, ideas, notes, tasks] = await Promise.all([
    listCaptures(workspace),
    listDecisions(workspace),
    listIdeas(workspace),
    listNotes(workspace),
    listTasks(workspace),
  ]);
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
    },
    projects,
    captures,
    decisions,
    ideas,
    notes,
    tasks,
  };
}

export async function pathExists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}
