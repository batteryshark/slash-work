import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  WorkspaceError,
  validateScopePath,
} from "./local-workspace.mjs";

const execFile = promisify(execFileCallback);
const MAX_PREVIEW_FILE_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".work",
  ".next",
  ".cache",
  ".cargo",
  ".gradle",
  ".hg",
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

const IGNORED_FILES = new Set([".DS_Store"]);

const LANGUAGE_BY_EXTENSION = new Map(Object.entries({
  ".c": ["c", "C", "C"],
  ".cc": ["cpp", "C++", "C++"],
  ".cpp": ["cpp", "C++", "C++"],
  ".cs": ["csharp", "C#", "C#"],
  ".css": ["css", "CSS", "CSS"],
  ".go": ["go", "Go", "GO"],
  ".h": ["c", "C header", "H"],
  ".hpp": ["cpp", "C++ header", "H++"],
  ".html": ["html", "HTML", "HTML"],
  ".gif": ["image", "Image", "IMG"],
  ".ico": ["image", "Image", "IMG"],
  ".java": ["java", "Java", "JAVA"],
  ".js": ["javascript", "JavaScript", "JS"],
  ".json": ["json", "JSON", "JSON"],
  ".jpeg": ["image", "Image", "IMG"],
  ".jpg": ["image", "Image", "IMG"],
  ".jsx": ["javascript", "JavaScript JSX", "JSX"],
  ".kt": ["kotlin", "Kotlin", "KT"],
  ".lua": ["lua", "Lua", "LUA"],
  ".md": ["markdown", "Markdown", "MD"],
  ".mjs": ["javascript", "JavaScript module", "MJS"],
  ".php": ["php", "PHP", "PHP"],
  ".png": ["image", "Image", "IMG"],
  ".proto": ["protobuf", "Protocol Buffers", "PROTO"],
  ".py": ["python", "Python", "PY"],
  ".rb": ["ruby", "Ruby", "RB"],
  ".rs": ["rust", "Rust", "RS"],
  ".scss": ["scss", "SCSS", "SCSS"],
  ".sh": ["shell", "Shell", "SH"],
  ".sql": ["sql", "SQL", "SQL"],
  ".swift": ["swift", "Swift", "SWIFT"],
  ".toml": ["toml", "TOML", "TOML"],
  ".ts": ["typescript", "TypeScript", "TS"],
  ".tsx": ["typescript", "TypeScript JSX", "TSX"],
  ".vue": ["vue", "Vue", "VUE"],
  ".webp": ["image", "Image", "IMG"],
  ".xml": ["xml", "XML", "XML"],
  ".yaml": ["yaml", "YAML", "YAML"],
  ".yml": ["yaml", "YAML", "YAML"],
  ".zig": ["zig", "Zig", "ZIG"],
}));

const LANGUAGE_BY_NAME = new Map([
  ["dockerfile", ["dockerfile", "Dockerfile", "DOCKER"]],
  ["makefile", ["makefile", "Makefile", "MAKE"]],
  ["gemfile", ["ruby", "Ruby", "RB"]],
  ["rakefile", ["ruby", "Ruby", "RB"]],
]);

const STATUS_PRIORITY = {
  conflict: 6,
  deleted: 5,
  added: 4,
  untracked: 3,
  modified: 2,
  renamed: 1,
};

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function toPosixPath(value) {
  return value.split(sep).join("/");
}

function normalizeRelativePath(value = ".") {
  if (typeof value !== "string" || value.length > 4096) {
    throw new WorkspaceError("File path must be a relative path.", { code: "invalid_file_path" });
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized === "" || normalized === ".") return ".";
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) {
    throw new WorkspaceError("Absolute file paths are not allowed.", { code: "path_escape", status: 403 });
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WorkspaceError("File path escapes the selected scope.", { code: "path_escape", status: 403 });
  }
  return segments.join("/");
}

function languageFor(name) {
  const exact = LANGUAGE_BY_NAME.get(name.toLowerCase());
  const language = exact ?? LANGUAGE_BY_EXTENSION.get(extname(name).toLowerCase()) ?? ["text", "Plain text", "TXT"];
  return { id: language[0], label: language[1], short: language[2] };
}

function sensitiveReason(name) {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return "Environment files are hidden from preview.";
  if ([".npmrc", ".pypirc", ".netrc", "credentials.json", "service-account.json", "id_rsa", "id_ed25519"].includes(lower)) {
    return "Credential files are hidden from preview.";
  }
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(lower)) return "Key material is hidden from preview.";
  return null;
}

function binaryReason(name) {
  if (/\.(?:7z|a|bin|class|dylib|exe|gif|gz|ico|jpeg|jpg|o|pdf|png|pyc|so|tar|wasm|webp|zip)$/i.test(name)) {
    return "Binary files are not available in the text preview.";
  }
  return null;
}

function ignoredGitPath(path) {
  return path.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment) || IGNORED_FILES.has(segment) || segment.endsWith(".egg-info"));
}

function changeKind(code) {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "conflict";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("R") || code.includes("C")) return "renamed";
  return "modified";
}

function strongestStatus(statuses) {
  return statuses.reduce((strongest, status) => {
    if (!strongest || STATUS_PRIORITY[status] > STATUS_PRIORITY[strongest]) return status;
    return strongest;
  }, null);
}

async function resolveScope(workspace, requestedScope) {
  const scopePath = await validateScopePath(workspace.root, requestedScope ?? ".");
  const base = await realpath(resolve(workspace.root, scopePath === "." ? "" : scopePath));
  if (!isContained(workspace.root, base)) {
    throw new WorkspaceError("File scope escapes the workspace root.", { code: "path_escape", status: 403 });
  }
  return { base, scopePath };
}

async function resolveEntry(base, requestedPath, expectedKind = null) {
  const path = normalizeRelativePath(requestedPath);
  const pathname = resolve(base, path === "." ? "" : path);
  if (!isContained(base, pathname)) {
    throw new WorkspaceError("File path escapes the selected scope.", { code: "path_escape", status: 403 });
  }
  let details;
  try {
    details = await lstat(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") throw new WorkspaceError("File path was not found.", { code: "file_not_found", status: 404 });
    throw error;
  }
  if (details.isSymbolicLink()) {
    throw new WorkspaceError("Symbolic links are not followed by the file viewer.", { code: "unsafe_file_path", status: 403 });
  }
  const canonical = await realpath(pathname);
  if (!isContained(base, canonical)) {
    throw new WorkspaceError("File path resolves outside the selected scope.", { code: "path_escape", status: 403 });
  }
  if (expectedKind === "directory" && !details.isDirectory()) {
    throw new WorkspaceError("File path must name a directory.", { code: "invalid_file_path" });
  }
  if (expectedKind === "file" && !details.isFile()) {
    throw new WorkspaceError("File path must name a regular file.", { code: "invalid_file_path" });
  }
  return { path, pathname: canonical, details };
}

async function gitStatusForScope(workspace, base) {
  let gitRoot;
  try {
    const result = await execFile("git", ["-C", base, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 3000,
    });
    gitRoot = await realpath(result.stdout.trim());
  } catch {
    return { available: false, statuses: new Map(), counts: {} };
  }
  if (!isContained(workspace.root, gitRoot) || !isContained(gitRoot, base)) {
    return { available: false, statuses: new Map(), counts: {} };
  }

  let output;
  try {
    const result = await execFile("git", ["-C", gitRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: 5000,
    });
    output = result.stdout;
  } catch {
    return { available: false, statuses: new Map(), counts: {} };
  }

  const statuses = new Map();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const gitPath = record.slice(3);
    if (code.includes("R") || code.includes("C")) index += 1;
    const absolute = resolve(gitRoot, ...gitPath.split("/"));
    if (!isContained(base, absolute)) continue;
    const scopedPath = toPosixPath(relative(base, absolute));
    if (!scopedPath || scopedPath === "." || ignoredGitPath(scopedPath)) continue;
    statuses.set(scopedPath, changeKind(code));
  }
  const counts = {};
  for (const status of statuses.values()) counts[status] = (counts[status] ?? 0) + 1;
  return { available: true, statuses, counts };
}

function statusForPath(path, kind, statuses) {
  if (kind !== "directory") return statuses.get(path) ?? null;
  const prefix = `${path}/`;
  return strongestStatus([...statuses.entries()].filter(([changedPath]) => changedPath.startsWith(prefix)).map(([, status]) => status));
}

export async function listFiles(workspace, { scopePath = ".", path = "." } = {}) {
  const scope = await resolveScope(workspace, scopePath);
  const directory = await resolveEntry(scope.base, path, "directory");
  const git = await gitStatusForScope(workspace, scope.base);
  const children = await readdir(directory.pathname, { withFileTypes: true });
  const entries = [];

  for (const child of children) {
    if (IGNORED_FILES.has(child.name) || IGNORED_DIRECTORIES.has(child.name)) continue;
    if (child.isDirectory() && child.name.endsWith(".egg-info")) continue;
    const childPath = directory.path === "." ? child.name : `${directory.path}/${child.name}`;
    let kind = "other";
    if (child.isDirectory()) kind = "directory";
    else if (child.isFile()) kind = "file";
    else if (child.isSymbolicLink()) kind = "symlink";
    const blockedReason = kind === "file" ? sensitiveReason(child.name) ?? binaryReason(child.name) : kind === "symlink" ? "Symbolic links are not followed." : null;
    entries.push({
      name: child.name,
      path: childPath,
      kind,
      language: kind === "file" ? languageFor(child.name) : null,
      gitStatus: statusForPath(childPath, kind, git.statuses),
      previewable: kind === "file" && blockedReason == null,
      blockedReason,
    });
  }

  if (directory.path === ".") {
    for (const [deletedPath, status] of git.statuses) {
      if (status !== "deleted" || entries.some((entry) => entry.path === deletedPath)) continue;
      const name = basename(deletedPath);
      entries.push({
        name: deletedPath,
        path: deletedPath,
        kind: "other",
        language: languageFor(name),
        gitStatus: "deleted",
        previewable: false,
        blockedReason: "This file was deleted from the working tree.",
      });
    }
  }

  entries.sort((left, right) => {
    const leftRank = left.kind === "directory" ? 0 : left.kind === "file" ? 1 : 2;
    const rightRank = right.kind === "directory" ? 0 : right.kind === "file" ? 1 : 2;
    return leftRank - rightRank || left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });

  return {
    scopePath: scope.scopePath,
    path: directory.path,
    entries,
    git: { available: git.available, counts: git.counts },
  };
}

export async function readFilePreview(workspace, { scopePath = ".", path } = {}) {
  const scope = await resolveScope(workspace, scopePath);
  const file = await resolveEntry(scope.base, path, "file");
  const reason = sensitiveReason(basename(file.pathname));
  if (reason) throw new WorkspaceError(reason, { code: "sensitive_file", status: 403 });
  const knownBinaryReason = binaryReason(basename(file.pathname));
  if (knownBinaryReason) throw new WorkspaceError(knownBinaryReason, { code: "binary_file", status: 415 });
  const details = await stat(file.pathname);
  if (details.size > MAX_PREVIEW_FILE_BYTES) {
    throw new WorkspaceError("This file is too large for the read-only preview.", { code: "file_too_large", status: 413 });
  }
  const source = await readFile(file.pathname);
  if (source.subarray(0, Math.min(source.length, 8192)).includes(0)) {
    throw new WorkspaceError("Binary files are not available in the text preview.", { code: "binary_file", status: 415 });
  }
  const git = await gitStatusForScope(workspace, scope.base);
  const content = source.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
  return {
    scopePath: scope.scopePath,
    path: file.path,
    name: basename(file.pathname),
    content,
    language: languageFor(basename(file.pathname)),
    gitStatus: git.statuses.get(file.path) ?? null,
    size: details.size,
    modifiedAt: details.mtime.toISOString(),
    truncated: source.length > MAX_PREVIEW_BYTES,
    readOnly: true,
  };
}
