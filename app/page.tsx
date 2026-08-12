"use client";

import {
  FormEvent,
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Project = {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  view: "board" | "list";
  path: string;
  depth: number;
  markers: string[];
  aliasPaths?: string[];
};

type Capture = {
  id: string;
  text: string;
  kind: "idea" | "question" | "update";
  scopePath: string;
  projectPath: string | null;
  createdAt: string;
  updatedAt: string;
};

type ProjectNote = {
  id: string;
  title: string;
  text: string;
  scopePath: string;
  projectPath: string | null;
  createdBy: { kind: "human"; name: null } | { kind: "agent"; name: string };
  createdAt: string;
  updatedAt: string;
};

type IssueState = "queued" | "in_progress" | "needs_human" | "resolved" | "closed";

type IssueMessage = {
  id: string;
  body: string;
  author: { kind: "human" | "agent"; name: string | null };
  createdAt: string;
};

type Issue = {
  id: string;
  title: string;
  body: string;
  state: IssueState;
  scopePath: string;
  projectPath: string | null;
  delegated: boolean;
  claimedBy: { kind: "agent"; name: string } | null;
  resolutionSummary: string | null;
  messages: IssueMessage[];
  stateHistory: Array<{
    from: IssueState | null;
    to: IssueState;
    actor: { kind: "human" | "agent"; name: string | null };
    reason: string | null;
    resolutionSummary: string | null;
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

type GitFileStatus = "conflict" | "deleted" | "added" | "untracked" | "modified" | "renamed";

type FileEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  language: { id: string; label: string; short: string } | null;
  gitStatus: GitFileStatus | null;
  canInitializeProject: boolean;
  previewable: boolean;
  blockedReason: string | null;
};

type FileDirectory = {
  scopePath: string;
  path: string;
  entries: FileEntry[];
  git: { available: boolean; counts: Partial<Record<GitFileStatus, number>> };
};

type FilePreview = {
  scopePath: string;
  path: string;
  name: string;
  content: string;
  language: { id: string; label: string; short: string };
  gitStatus: GitFileStatus | null;
  size: number;
  modifiedAt: string;
  truncated: boolean;
  readOnly: true;
};

type DecisionAction =
  | "approve"
  | "reject"
  | "defer"
  | "cancel"
  | "assign"
  | "keep_unassigned"
  | "reopen";

type DecisionResolution = {
  action: Exclude<DecisionAction, "reopen">;
  choice: Record<string, unknown> | null;
  note: string | null;
  at: string;
};

type Decision = {
  id: string;
  title: string;
  detail: string;
  projectPath: string | null;
  refs: string[];
  options: string[];
  recommendedOption: string | null;
  status:
    | "open"
    | "approved"
    | "rejected"
    | "deferred"
    | "cancelled"
    | "assigned"
    | "kept_unassigned";
  resolution: DecisionResolution | null;
  history: Array<DecisionResolution | { action: "reopen"; choice: null; note: string | null; at: string }>;
  createdAt: string;
  updatedAt: string;
};

type ChecklistItem = { checked: boolean; text: string };

type WorkTask = {
  id: string;
  title: string;
  status: string;
  projectPath: string | null;
  delegated: boolean;
  tags: string[];
  dependsOn: string[];
  blockedBy: string[];
  blockedReason: string | null;
  parentId: string | null;
  dueAt: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  sections: {
    description: string;
    goal: string;
    requirements: string;
    acceptanceCriteria: string;
    plan: string;
    notes: string;
    progressLog: string;
    completionSummary: string;
  };
  requirements: ChecklistItem[];
  acceptanceCriteria: ChecklistItem[];
  log: Array<{ at: string; message: string }>;
};

type ScheduledItem = {
  key: string;
  id: string;
  kind: "task" | "decision";
  title: string;
  projectPath: string | null;
  scheduledAt: string;
  allDay: boolean;
  detail: string;
};

type AppView = "home" | "board" | "issues" | "notes" | "files" | "activity";
type ThemePreference = "system" | "light" | "dark";

type WorkspacePayload = {
  version: number;
  workspace: {
    id: string;
    name: string;
    root: string;
    dataDir: string;
    startScopePath?: string;
    statuses: string[];
  };
  projects: Project[];
  captures: Capture[];
  decisions: Decision[];
  issues: Issue[];
  notes: ProjectNote[];
  tasks: WorkTask[];
  // True when Work's files on disk changed after this process started, so the
  // running service is serving code it no longer matches.
  staleBuild?: boolean;
};

type WorkspaceSummary = {
  id: string;
  name: string;
  root: string;
};

type WorkspaceDirectory = {
  defaultWorkspaceId: string;
  activeWorkspaceId: string;
  workspaces: WorkspaceSummary[];
};

type WorkspacePickerReceipt = {
  cancelled: boolean;
  workspace?: WorkspaceSummary;
};

type DecisionDraft = {
  action: Exclude<DecisionAction, "reopen"> | "";
  projectPath: string;
  deferFor: "today" | "tomorrow" | "week";
  selectedOption: string;
  response: string;
};

type CaptureReceipt = {
  capture: Capture;
  destination: string;
};

type DecisionReceipt = {
  decisionId: string;
  message: string;
};

// Restart and update accept-receipts only matter for their instance id.
type ServiceReceipt = { serviceInstanceId: string };

type ServiceHealth = {
  ok: boolean;
  service?: { instanceId?: string; restartable?: boolean; version?: string; updatePending?: boolean };
};

type ServiceUpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  installable: boolean;
  checkedAt: string;
};

const emptyDraft: DecisionDraft = {
  action: "",
  projectPath: "",
  deferFor: "week",
  selectedOption: "",
  response: "",
};

function pathParts(path: string) {
  return path === "." ? [] : path.split("/").filter(Boolean);
}

function displaySegment(segment: string) {
  return segment
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pathContains(candidate: string | null, scope: string) {
  if (!candidate) return scope === ".";
  if (scope === ".") return true;
  return candidate === scope || candidate.startsWith(`${scope}/`);
}

function parentPath(path: string) {
  const parts = pathParts(path);
  if (parts.length <= 1) return ".";
  return parts.slice(0, -1).join("/");
}

function relativeFromScope(path: string, scope: string) {
  if (scope === ".") return path;
  return path === scope ? "" : path.slice(scope.length + 1);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function cleanCommand(text: string) {
  return text.replace(/^\s*\/work\s*/i, "").trim();
}

function shortTime(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

const ISSUE_STATE_LABELS: Record<IssueState, string> = {
  queued: "Queued",
  in_progress: "In progress",
  needs_human: "Needs you",
  resolved: "Resolved",
  closed: "Closed",
};

function scopeLabelFor(projects: Project[], projectPath: string | null, fallback: string) {
  if (!projectPath) return fallback;
  return projects.find((project) => project.path === projectPath)?.name ?? projectPath;
}

function safeLinkTarget(target: string) {
  return /^(https?:\/\/|mailto:)/i.test(target) ? target : null;
}

function InlineMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const value = match[0];
    const key = `${match.index}-${value}`;
    if (value.startsWith("`")) {
      parts.push(<code key={key}>{value.slice(1, -1)}</code>);
    } else if (value.startsWith("**")) {
      parts.push(<strong key={key}>{value.slice(2, -2)}</strong>);
    } else if (value.startsWith("*")) {
      parts.push(<em key={key}>{value.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
      const href = link ? safeLinkTarget(link[2]) : null;
      parts.push(href
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{link?.[1]}</a>
        : value);
    }
    cursor = match.index + value.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function Markdown({ children }: { children: string }) {
  const lines = children.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`} data-language={fence[1] || undefined}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const list = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (list) {
      const ordered = /\d+\./.test(list[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(lines[index]);
        if (!item || /\d+\./.test(item[2]) !== ordered) break;
        items.push(item[3]);
        index += 1;
      }
      const children = items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} /></li>);
      blocks.push(ordered
        ? <ol key={`list-${index}`}>{children}</ol>
        : <ul key={`list-${index}`}>{children}</ul>);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length
      && lines[index].trim()
      && !/^```/.test(lines[index])
      && !/^(\s*)([-*]|\d+\.)\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`}><InlineMarkdown text={paragraph.join("\n")} /></p>);
  }

  return <div className="markdown-body">{blocks}</div>;
}

const ISSUE_STATE_NOTES: Partial<Record<IssueState, { className: string; title: (issue: Issue) => string; body: (issue: Issue) => ReactNode }>> = {
  in_progress: {
    className: "",
    title: (issue) => `In progress${issue.claimedBy ? ` · ${issue.claimedBy.name}` : ""}`,
    body: () => <span>The issue stays open while it is investigated.</span>,
  },
  needs_human: {
    className: "needs-human",
    title: () => "Needs you.",
    body: () => <span>Reply below. Only issues in this state appear in the bounded Needs you list.</span>,
  },
  resolved: {
    className: "resolved",
    title: () => "Resolution — awaiting your review.",
    body: (issue) => issue.resolutionSummary
      ? <Markdown>{issue.resolutionSummary}</Markdown>
      : <span>If the result is incomplete, reply or reopen the issue.</span>,
  },
  closed: {
    className: "closed",
    title: () => "Closed by a human.",
    body: () => <span>You can reopen it at any time. Nothing in this conversation is discarded.</span>,
  },
};

function calendarDate(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return new Date(iso);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function scheduleDate(item: Pick<ScheduledItem, "scheduledAt" | "allDay">) {
  return item.allDay ? calendarDate(item.scheduledAt) : new Date(item.scheduledAt);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function scheduleTone(item: Pick<ScheduledItem, "scheduledAt" | "allDay">) {
  const date = scheduleDate(item);
  const now = new Date();
  if (item.allDay) {
    const difference = startOfDay(date).getTime() - startOfDay(now).getTime();
    if (difference < 0) return "overdue";
    if (difference === 0) return "today";
    return "upcoming";
  }
  if (date.getTime() < now.getTime()) return "overdue";
  if (startOfDay(date).getTime() === startOfDay(now).getTime()) return "today";
  return "upcoming";
}

function scheduleLabel(item: Pick<ScheduledItem, "scheduledAt" | "allDay">, prefix = "") {
  const date = scheduleDate(item);
  const difference = Math.round((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / 86_400_000);
  const tone = scheduleTone(item);
  const day = difference === 0
    ? "Today"
    : difference === 1
      ? "Tomorrow"
      : date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  const label = tone === "overdue" ? `Overdue · ${day}` : day;
  if (!prefix || tone === "overdue") return label;
  return `${prefix} ${difference === 0 || difference === 1 ? day.toLowerCase() : day}`;
}

function scheduleDateDetail(item: Pick<ScheduledItem, "scheduledAt" | "allDay">) {
  const date = scheduleDate(item);
  return item.allDay
    ? date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
    : date.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function deferUntil(preset: DecisionDraft["deferFor"]) {
  const date = new Date();
  if (preset === "today") date.setHours(date.getHours() + 4);
  if (preset === "tomorrow") date.setDate(date.getDate() + 1);
  if (preset === "week") date.setDate(date.getDate() + 7);
  return date.toISOString();
}

function decisionIsActive(decision: Decision) {
  if (decision.status === "open") return true;
  if (decision.status !== "deferred") return false;
  const until = decision.resolution?.choice?.until;
  return typeof until === "string" && new Date(until).getTime() <= Date.now();
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const workspaceId = typeof window === "undefined" ? null : localStorage.getItem("work.workspace");
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(workspaceId ? { "x-work-workspace": workspaceId } : {}),
      ...init?.headers,
    },
  });

  const body = (await response.json().catch(() => null)) as
    | T
    | { error?: string | { message?: string }; message?: string }
    | null;

  if (!response.ok) {
    const rawError = body && typeof body === "object" && "error" in body ? body.error : null;
    const message = typeof rawError === "string"
      ? rawError
      : rawError && typeof rawError === "object"
        ? rawError.message
        : body && typeof body === "object" && "message" in body
          ? body.message
          : null;
    throw new Error(message || `Work could not save that (${response.status}).`);
  }

  return body as T;
}

// Shared mutation wrapper: flips the saving flag, clears then reports the
// error state, and rethrows so callers can keep their own control flow.
async function run<T>(
  work: () => Promise<T>,
  handlers: { saving?: (value: boolean) => void; error: (message: string | null) => void; fallback: string },
): Promise<T> {
  handlers.saving?.(true);
  handlers.error(null);
  try {
    return await work();
  } catch (cause) {
    handlers.error(cause instanceof Error ? cause.message : handlers.fallback);
    throw cause;
  } finally {
    handlers.saving?.(false);
  }
}

export default function Home() {
  const [data, setData] = useState<WorkspacePayload | null>(null);
  const [workspaceDirectory, setWorkspaceDirectory] = useState<WorkspaceDirectory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<AppView>("home");
  const [pendingHomeSection, setPendingHomeSection] = useState<"inbox" | "needs-you" | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") return "system";
    const saved = localStorage.getItem("work.theme");
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  });
  const [scopePath, setScopePath] = useState(".");
  const [command, setCommand] = useState("");
  const [savingCapture, setSavingCapture] = useState(false);
  const [movingCaptureId, setMovingCaptureId] = useState<string | null>(null);
  const [captureToMove, setCaptureToMove] = useState<Capture | null>(null);
  const [captureMoveSearch, setCaptureMoveSearch] = useState("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureReceipt, setCaptureReceipt] = useState<CaptureReceipt | null>(null);
  // Session-only, never persisted: captures go to the root Inbox unless the
  // user explicitly flips the dock destination to the current project.
  const [captureToProject, setCaptureToProject] = useState(false);
  const [captureDockCollapsed, setCaptureDockCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("work.captureDockCollapsed") === "true";
  });
  const [systemMenuOpen, setSystemMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [workspacePickerError, setWorkspacePickerError] = useState<string | null>(null);
  const [removingWorkspace, setRemovingWorkspace] = useState<string | null>(null);
  const [restartingService, setRestartingService] = useState(false);
  const [serviceRestartError, setServiceRestartError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<ServiceUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [expandedDecision, setExpandedDecision] = useState<string | null>(null);
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, DecisionDraft>>({});
  const [savingDecision, setSavingDecision] = useState<string | null>(null);
  const [decisionReceipt, setDecisionReceipt] = useState<DecisionReceipt | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [savingIssue, setSavingIssue] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [creatingNote, setCreatingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [savingTask, setSavingTask] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [showTerminalTasks, setShowTerminalTasks] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadRequestRef = useRef(0);

  useEffect(() => {
    if (!captureReceipt) return;
    const captureId = captureReceipt.capture.id;
    const timer = window.setTimeout(() => {
      setCaptureReceipt((current) => current?.capture.id === captureId ? null : current);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [captureReceipt?.capture.id]);

  const loadWorkspace = useCallback(async (quiet = false) => {
    const requestNumber = ++loadRequestRef.current;
    try {
      const directory = await requestJson<WorkspaceDirectory>("/api/workspaces", {
        headers: { accept: "application/json" },
      });
      const rememberedId = localStorage.getItem("work.workspace");
      const selectedId = directory.workspaces.some((workspace) => workspace.id === rememberedId)
        ? rememberedId
        : directory.activeWorkspaceId;
      if (selectedId) localStorage.setItem("work.workspace", selectedId);
      const workspace = await requestJson<WorkspacePayload>("/api/workspace", {
        headers: { accept: "application/json" },
      });
      if (requestNumber !== loadRequestRef.current) return;
      setWorkspaceDirectory(directory);
      setData(workspace);
      setLastSyncedAt(new Date());
      setLoadError(null);
    } catch (error) {
      if (requestNumber !== loadRequestRef.current) return;
      if (!quiet) {
        setLoadError(error instanceof Error ? error.message : "The local workspace is not available.");
      }
    }
  }, []);

  const checkForUpdates = useCallback(async (quiet = false, force = false) => {
    if (!quiet) setCheckingUpdate(true);
    try {
      const status = await requestJson<ServiceUpdateStatus>(`/api/service/update${force ? "?force=1" : ""}`, {
        headers: { accept: "application/json" },
      });
      setUpdateStatus(status);
      setUpdateError(null);
    } catch (error) {
      if (!quiet) setUpdateError(error instanceof Error ? error.message : "Work could not check npm for updates.");
    } finally {
      if (!quiet) setCheckingUpdate(false);
    }
  }, []);

  async function switchWorkspace(workspaceId: string) {
    if (workspaceId === data?.workspace.id) {
      setWorkspaceMenuOpen(false);
      return;
    }
    localStorage.setItem("work.workspace", workspaceId);
    setWorkspaceMenuOpen(false);
    setProjectMenuOpen(false);
    setSelectedNoteId(null);
    setSelectedIssueId(null);
    setSelectedTaskId(null);
    setScopePath(".");
    setView("home");
    setData(null);
    await loadWorkspace();
  }

  async function updateProjectProfile(projectPath: string, patch: { name?: string; description?: string; view?: "board" | "list" }) {
    const project = await requestJson<Project>("/api/projects/profile", {
      method: "PATCH",
      body: JSON.stringify({ projectPath, ...patch }),
    });
    setData((current) => current ? {
      ...current,
      projects: current.projects.map((item) => item.path === project.path ? project : item),
    } : current);
    return project;
  }

  const [confirmingProjectDelete, setConfirmingProjectDelete] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [projectDeleteError, setProjectDeleteError] = useState<string | null>(null);

  async function confirmProjectDelete() {
    if (!selectedProject || deletingProject) return;
    setDeletingProject(true);
    setProjectDeleteError(null);
    try {
      await deleteWorkProject(selectedProject.path);
      setConfirmingProjectDelete(false);
    } catch (error) {
      setProjectDeleteError(error instanceof Error ? error.message : "The project could not be deleted.");
    } finally {
      setDeletingProject(false);
    }
  }

  async function deleteWorkProject(projectPath: string) {
    await requestJson<{ projectPath: string; folderRemoved: boolean }>(
      `/api/projects?projectPath=${encodeURIComponent(projectPath)}`,
      { method: "DELETE" },
    );
    setSelectedTaskId(null);
    setScopePath(".");
    setView("home");
    await loadWorkspace();
  }

  function rememberProject(project: Project) {
    setData((current) => {
      if (!current) return current;
      const projects = current.projects
        .filter((candidate) => candidate.path !== project.path)
        .concat(project)
        .sort((left, right) => left.path.localeCompare(right.path));
      return { ...current, projects };
    });
  }

  async function pickWorkspace() {
    if (pickingWorkspace) return;
    setPickingWorkspace(true);
    setWorkspacePickerError(null);
    try {
      const receipt = await requestJson<WorkspacePickerReceipt>("/api/workspaces/pick", {
        method: "POST",
        headers: { "x-work-folder-picker": "confirm" },
        body: JSON.stringify({ confirm: true }),
      });
      if (receipt.cancelled || !receipt.workspace) return;
      localStorage.setItem("work.workspace", receipt.workspace.id);
      setWorkspaceMenuOpen(false);
      setProjectMenuOpen(false);
      setSelectedNoteId(null);
      setSelectedIssueId(null);
      setSelectedTaskId(null);
      setScopePath(".");
      setView("home");
      setData(null);
      await loadWorkspace();
    } catch (error) {
      setWorkspacePickerError(error instanceof Error ? error.message : "The folder picker could not open.");
    } finally {
      setPickingWorkspace(false);
    }
  }

  async function removeWorkspace(workspaceId: string) {
    if (removingWorkspace) return;
    setRemovingWorkspace(workspaceId);
    setWorkspacePickerError(null);
    try {
      const receipt = await requestJson<WorkspaceDirectory>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
        headers: { "x-work-unregister": "confirm" },
      });
      setWorkspaceDirectory({
        defaultWorkspaceId: receipt.defaultWorkspaceId,
        activeWorkspaceId: receipt.activeWorkspaceId,
        workspaces: receipt.workspaces,
      });
    } catch (error) {
      setWorkspacePickerError(error instanceof Error ? error.message : "The workspace root could not be removed from the list.");
    } finally {
      setRemovingWorkspace(null);
    }
  }

  async function waitForServiceRestart(serviceInstanceId: string) {
    const deadline = Date.now() + 20_000;
    await wait(400);
    while (Date.now() < deadline) {
      try {
        const response = await fetch("/api/health", {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (response.ok) {
          const health = await response.json() as ServiceHealth;
          if (health.service?.instanceId && health.service.instanceId !== serviceInstanceId) return;
        }
      } catch {
        // A brief connection failure is expected while the service is replaced.
      }
      await wait(500);
    }
    throw new Error("Work did not come back within 20 seconds.");
  }

  async function restartLocalService() {
    if (restartingService) return;
    setRestartingService(true);
    setServiceRestartError(null);
    try {
      const accepted = await requestJson<ServiceReceipt>("/api/service/restart", {
        method: "POST",
        headers: { "x-work-restart": "confirm" },
        body: JSON.stringify({ confirm: true }),
      });
      await waitForServiceRestart(accepted.serviceInstanceId);
      await loadWorkspace();
      setSystemMenuOpen(false);
    } catch (error) {
      setServiceRestartError(error instanceof Error ? error.message : "Work could not restart.");
    } finally {
      setRestartingService(false);
    }
  }

  async function installServiceUpdate() {
    if (installingUpdate || !updateStatus?.updateAvailable || !updateStatus.installable) return;
    setInstallingUpdate(true);
    setUpdateError(null);
    try {
      const accepted = await requestJson<ServiceReceipt>("/api/service/update", {
        method: "POST",
        headers: { "x-work-update": "confirm" },
        body: JSON.stringify({ confirm: true }),
      });
      await waitForServiceRestart(accepted.serviceInstanceId);
      window.location.reload();
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : "The Work update could not be installed.");
      setInstallingUpdate(false);
    }
  }

  useEffect(() => {
    void loadWorkspace();
    const interval = window.setInterval(() => void loadWorkspace(true), 12_000);
    const onFocus = () => void loadWorkspace(true);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadWorkspace]);

  useEffect(() => {
    const check = () => {
      if (navigator.onLine) void checkForUpdates(true);
    };
    const initial = window.setTimeout(check, 1_500);
    const interval = window.setInterval(check, 6 * 60 * 60 * 1000);
    window.addEventListener("online", check);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("online", check);
    };
  }, [checkForUpdates]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#14151a" : "#f2efe9");
    };
    localStorage.setItem("work.theme", theme);
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    if (!data) return;
    const key = `work.scope.${data.workspace.root}`;
    const remembered = localStorage.getItem(key);
    const requested = data.workspace.startScopePath && data.workspace.startScopePath !== "."
      ? data.workspace.startScopePath
      : remembered ?? ".";
    const exists = requested === "." || data.projects.some((project) => pathContains(project.path, requested));
    if (exists) setScopePath(requested);
  }, [data?.workspace.root]);

  useEffect(() => {
    if (!data) return;
    localStorage.setItem(`work.scope.${data.workspace.root}`, scopePath);
  }, [data, scopePath]);

  useEffect(() => {
    const onGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        setCaptureDockCollapsed(false);
        localStorage.setItem("work.captureDockCollapsed", "false");
        window.requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, []);

  function setCaptureDockCollapsedPersisted(collapsed: boolean, focus = false) {
    setCaptureDockCollapsed(collapsed);
    localStorage.setItem("work.captureDockCollapsed", String(collapsed));
    if (!collapsed && focus) window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [command]);

  useEffect(() => {
    if (view !== "home" || !pendingHomeSection) return;
    const sectionId = pendingHomeSection;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingHomeSection(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view, pendingHomeSection]);

  const selectedProject = useMemo(
    () => data?.projects.find((project) => project.path === scopePath) ?? null,
    [data, scopePath],
  );

  const scopeKind = scopePath === "." ? "root" : selectedProject ? "project" : "group";
  const scopeLabel = scopePath === "."
    ? data?.workspace.name ?? "This root"
    : selectedProject?.name ?? displaySegment(pathParts(scopePath).at(-1) ?? scopePath);

  const visibleProjects = useMemo(
    () => (data?.projects ?? []).filter((project) => project.path !== "." && pathContains(project.path, scopePath)),
    [data, scopePath],
  );

  const directProjects = useMemo(
    () => visibleProjects.filter((project) => parentPath(project.path) === scopePath),
    [visibleProjects, scopePath],
  );

  const childGroups = useMemo(() => {
    const groups = new Map<string, { path: string; name: string; projects: number }>();
    for (const project of visibleProjects) {
      const remainder = relativeFromScope(project.path, scopePath);
      const [first, ...rest] = pathParts(remainder);
      if (!first || rest.length === 0) continue;
      const path = scopePath === "." ? first : `${scopePath}/${first}`;
      const current = groups.get(path);
      groups.set(path, {
        path,
        name: displaySegment(first),
        projects: (current?.projects ?? 0) + 1,
      });
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [scopePath, visibleProjects]);

  const inboxFolderScopes = useMemo(() => {
    const projects = data?.projects.filter((project) => project.path !== ".") ?? [];
    const projectPaths = new Set(projects.map((project) => project.path));
    const folders = new Set<string>();
    for (const project of projects) {
      const parts = pathParts(project.path);
      for (let index = 1; index < parts.length; index += 1) {
        const path = parts.slice(0, index).join("/");
        if (!projectPaths.has(path)) folders.add(path);
      }
    }
    return [...folders].sort((left, right) => left.localeCompare(right));
  }, [data?.projects]);

  const scopedCaptures = useMemo(() => {
    return (data?.captures ?? [])
      .filter((capture) => pathContains(capture.scopePath, scopePath) || pathContains(capture.projectPath, scopePath))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [data, scopePath]);

  const scopedNotes = useMemo(() => {
    return (data?.notes ?? [])
      .filter((note) => scopePath === "." || pathContains(note.scopePath, scopePath) || pathContains(note.projectPath, scopePath))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [data, scopePath]);

  useEffect(() => {
    if (view !== "notes") return;
    if (selectedNoteId && scopedNotes.some((note) => note.id === selectedNoteId)) return;
    setSelectedNoteId(scopedNotes[0]?.id ?? null);
  }, [view, selectedNoteId, scopedNotes]);

  const scopedIssues = useMemo(() => {
    return (data?.issues ?? [])
      .filter((issue) => scopePath === "." || pathContains(issue.scopePath, scopePath) || pathContains(issue.projectPath, scopePath))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [data, scopePath]);

  useEffect(() => {
    if (view !== "issues") return;
    if (selectedIssueId && scopedIssues.some((issue) => issue.id === selectedIssueId)) return;
    setSelectedIssueId(scopedIssues[0]?.id ?? null);
  }, [view, selectedIssueId, scopedIssues]);

  const scopedTasks = useMemo(() => {
    return (data?.tasks ?? [])
      .filter((task) => scopePath === "." || pathContains(task.projectPath, scopePath))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [data, scopePath]);

  const selectedTask = selectedTaskId
    ? (data?.tasks ?? []).find((task) => task.id === selectedTaskId) ?? null
    : null;
  // Unresolved decisions linked to the open card. Resolved ones drop out.
  const selectedTaskQuestions = selectedTask
    ? (data?.decisions ?? []).filter((decision) => decisionIsActive(decision) && decision.refs.includes(selectedTask.id))
    : [];

  const activeDecisions = useMemo(() => {
    return (data?.decisions ?? [])
      .filter(decisionIsActive)
      .filter((decision) => scopePath === "." || pathContains(decision.projectPath, scopePath))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [data, scopePath]);
  const humanIssues = scopedIssues.filter((issue) => issue.state === "needs_human");
  const blockedTasks = scopedTasks.filter((task) => task.status === "blocked");
  const visibleHumanIssues = humanIssues.slice(0, 3);
  const visibleBlockedTasks = blockedTasks.slice(0, Math.max(0, 3 - visibleHumanIssues.length));
  const visibleDecisions = activeDecisions.slice(0, Math.max(0, 3 - visibleHumanIssues.length - visibleBlockedTasks.length));
  const attentionCount = activeDecisions.length + humanIssues.length + blockedTasks.length;

  const scheduledItems = useMemo(() => {
    const tasks: ScheduledItem[] = scopedTasks
      .filter((task) => task.dueAt && !["done", "cancelled", "archived"].includes(task.status))
      .map((task) => ({
        key: `task:${task.id}`,
        id: task.id,
        kind: "task",
        title: task.title,
        projectPath: task.projectPath,
        scheduledAt: task.dueAt as string,
        allDay: true,
        detail: `${task.id} · ${statusLabel(task.status)}`,
      }));
    const decisions: ScheduledItem[] = (data?.decisions ?? [])
      .filter((decision) => decision.status === "deferred")
      .filter((decision) => scopePath === "." || pathContains(decision.projectPath, scopePath))
      .flatMap((decision) => {
        const until = decision.resolution?.choice?.until;
        if (typeof until !== "string" || Number.isNaN(new Date(until).valueOf()) || new Date(until).getTime() <= Date.now()) return [];
        return [{
          key: `decision:${decision.id}`,
          id: decision.id,
          kind: "decision" as const,
          title: decision.title,
          projectPath: decision.projectPath,
          scheduledAt: until,
          allDay: false,
          detail: "Decision returns",
        }];
      });
    return [...tasks, ...decisions]
      .filter((item) => !Number.isNaN(scheduleDate(item).valueOf()))
      .sort((left, right) => scheduleDate(left).getTime() - scheduleDate(right).getTime());
  }, [data?.decisions, scopedTasks, scopePath]);

  const filteredProjectMenu = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) return data?.projects.filter((project) => project.path !== ".") ?? [];
    return (data?.projects ?? []).filter((project) =>
      project.path !== "." && `${project.name} ${project.path} ${project.description} ${(project.aliasPaths ?? []).join(" ")}`.toLowerCase().includes(query),
    );
  }, [data, projectSearch]);

  const projectInventory = useMemo(() => {
    const logicalProjects = data?.projects.filter((project) => project.path !== ".") ?? [];
    return {
      logicalProjects: logicalProjects.length,
      linkedWorktrees: logicalProjects.reduce((total, project) => total + (project.aliasPaths ?? []).length, 0),
    };
  }, [data?.projects]);

  function navigate(nextScope: string) {
    setScopePath(nextScope || ".");
    setSystemMenuOpen(false);
    setProjectMenuOpen(false);
    setWorkspaceMenuOpen(false);
    setProjectSearch("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openHomeSection(section: "inbox" | "needs-you") {
    setView("home");
    setPendingHomeSection(section);
  }

  function destinationForCurrentScope() {
    if (selectedProject) return `Project inbox: ${selectedProject.name}`;
    if (scopePath === ".") return `Root inbox: ${data?.workspace.name ?? "Root"} · Unassigned`;
    return `Folder inbox: ${scopeLabel} · Unassigned`;
  }

  function destinationForCapture(capture: Capture) {
    const project = data?.projects.find((item) => item.path === capture.projectPath);
    if (project) return `Project inbox: ${project.name}`;
    if (capture.scopePath === ".") return `Root inbox: ${data?.workspace.name ?? "Root"} · Unassigned`;
    return `Folder inbox: ${displaySegment(pathParts(capture.scopePath).at(-1) ?? capture.scopePath)} · Unassigned`;
  }

  function replaceIn<K extends "tasks" | "notes" | "issues">(key: K, record: WorkspacePayload[K][number]) {
    setData((current) => current ? {
      ...current,
      [key]: [record, ...(current[key] ?? []).filter((item) => item.id !== record.id)],
    } : current);
  }

  function createIssue(body: string) {
    return run(async () => {
      const issue = await requestJson<Issue>("/api/issues", {
        method: "POST",
        body: JSON.stringify({ body, scopePath, projectPath: selectedProject?.path ?? null }),
      });
      replaceIn("issues", issue);
      setSelectedIssueId(issue.id);
      setView("issues");
      return issue;
    }, { saving: setSavingIssue, error: setIssueError, fallback: "The issue could not be submitted." });
  }

  function replyToIssue(issueId: string, body: string) {
    return run(async () => {
      const issue = await requestJson<Issue>(`/api/issues/${encodeURIComponent(issueId)}/replies`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      replaceIn("issues", issue);
      return issue;
    }, { saving: setSavingIssue, error: setIssueError, fallback: "The reply could not be submitted." });
  }

  function setIssueState(issueId: string, state: "queued" | "closed") {
    return run(async () => {
      const issue = await requestJson<Issue>(`/api/issues/${encodeURIComponent(issueId)}/state`, {
        method: "POST",
        body: JSON.stringify({ state }),
      });
      replaceIn("issues", issue);
      return issue;
    }, { saving: setSavingIssue, error: setIssueError, fallback: "The issue state could not be changed." });
  }

  function setIssueDelegated(issueId: string, delegated: boolean) {
    return run(async () => {
      const issue = await requestJson<Issue>(`/api/issues/${encodeURIComponent(issueId)}`, {
        method: "PATCH",
        body: JSON.stringify({ delegated }),
      });
      replaceIn("issues", issue);
      return issue;
    }, { saving: setSavingIssue, error: setIssueError, fallback: "The delegation flag could not be changed." });
  }

  function createProjectNote(input: { title?: string; text?: string } = {}) {
    return run(async () => {
      const note = await requestJson<ProjectNote>("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          title: input.title ?? "Untitled note",
          text: input.text ?? "",
          scopePath,
          projectPath: selectedProject?.path ?? null,
        }),
      });
      replaceIn("notes", note);
      setSelectedNoteId(note.id);
      setView("notes");
      return note;
    }, { saving: setCreatingNote, error: setNoteError, fallback: "The note could not be created." });
  }

  function updateProjectNote(noteId: string, patch: { title?: string; text?: string }) {
    return run(async () => {
      const note = await requestJson<ProjectNote>(`/api/notes/${encodeURIComponent(noteId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      replaceIn("notes", note);
      return note;
    }, { error: setNoteError, fallback: "The note could not be saved." });
  }

  function deleteProjectNote(noteId: string) {
    return run(async () => {
      await requestJson<{ ok: boolean }>(`/api/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
      setData((current) => current ? {
        ...current,
        notes: (current.notes ?? []).filter((item) => item.id !== noteId),
      } : current);
      setSelectedNoteId((current) => current === noteId ? null : current);
    }, { error: setNoteError, fallback: "The note could not be deleted." });
  }

  function createWorkTask(input: Record<string, unknown>, open = true) {
    return run(async () => {
      const task = await requestJson<WorkTask>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      });
      replaceIn("tasks", task);
      setCreatingTask(false);
      if (open) {
        setView("board");
        setSelectedTaskId(task.id);
      }
      return task;
    }, { saving: setSavingTask, error: setTaskError, fallback: "The work item could not be created." });
  }

  function moveWorkTask(taskId: string, status: string, note?: string) {
    return run(async () => {
      const task = await requestJson<WorkTask>(`/api/tasks/${encodeURIComponent(taskId)}/move`, {
        method: "POST",
        body: JSON.stringify({ status, note }),
      });
      replaceIn("tasks", task);
      return task;
    }, { saving: setSavingTask, error: setTaskError, fallback: "The card could not be moved." });
  }

  function patchWorkTask(taskId: string, patch: Record<string, unknown>) {
    return run(async () => {
      const task = await requestJson<WorkTask>(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      replaceIn("tasks", task);
      return task;
    }, { saving: setSavingTask, error: setTaskError, fallback: "The work item could not be updated." });
  }

  async function toggleWorkChecklist(taskId: string, section: "requirements" | "acceptance", index: number, checked: boolean) {
    await run(async () => {
      const task = await requestJson<WorkTask>(`/api/tasks/${encodeURIComponent(taskId)}/checklist`, {
        method: "POST",
        body: JSON.stringify({ section, index, checked }),
      });
      replaceIn("tasks", task);
    }, { error: setTaskError, fallback: "The checklist could not be updated." }).catch(() => {});
  }

  function logWorkProgress(taskId: string, message: string) {
    return run(async () => {
      const task = await requestJson<WorkTask>(`/api/tasks/${encodeURIComponent(taskId)}/log`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      replaceIn("tasks", task);
    }, { error: setTaskError, fallback: "The progress entry could not be saved." });
  }

  async function promoteCaptureToTask(capture: Capture) {
    const firstLine = capture.text.split("\n").find((line) => line.trim())?.trim() ?? capture.text;
    const title = firstLine.length > 500 ? `${firstLine.slice(0, 497)}…` : firstLine;
    await createWorkTask({
      title,
      projectPath: capture.projectPath,
      status: "backlog",
      source: capture.id,
      notes: capture.text.includes("\n")
        ? `Promoted from capture ${capture.id}.\n\n${capture.text}`
        : `Promoted from capture ${capture.id}.`,
    });
  }

  async function promoteCaptureToNote(capture: Capture) {
    const firstLine = capture.text.split("\n").find((line) => line.trim())?.trim() ?? capture.text;
    const title = firstLine.length > 300 ? `${firstLine.slice(0, 297)}…` : firstLine;
    await createProjectNote({ title, text: capture.text });
  }

  async function runCommand() {
    const text = cleanCommand(command);
    if (!text) {
      setCaptureError("Write anything you want remembered. No formatting needed.");
      inputRef.current?.focus();
      return;
    }

    const isMultiline = text.includes("\n");
    const taskCommand = isMultiline ? null : text.match(/^(?:task|todo)\s*:?\s+(.+)$/i);
    if (taskCommand) {
      try {
        await createWorkTask({
          title: taskCommand[1].trim(),
          projectPath: selectedProject?.path ?? null,
          status: "backlog",
        });
        setCommand("");
        window.requestAnimationFrame(() => inputRef.current?.focus());
      } catch {
        setCaptureError("Task not created — check the board message and try again.");
      }
      return;
    }
    // Plain typed text is ALWAYS a capture. Navigation lives in the tabs and
    // breadcrumbs; "show board" saved as a thought beats a discarded thought.
    setSavingCapture(true);
    setCaptureError(null);
    try {
      const toProject = captureToProject && selectedProject ? selectedProject.path : null;
      const response = await requestJson<Capture | { capture: Capture }>("/api/captures", {
        method: "POST",
        body: JSON.stringify({
          text,
          scopePath: toProject ? scopePath : ".",
          projectPath: toProject,
        }),
      });
      const capture = "capture" in response ? response.capture : response;
      setData((current) => current ? { ...current, captures: [capture, ...current.captures.filter((item) => item.id !== capture.id)] } : current);
      setCaptureReceipt({ capture, destination: destinationForCapture(capture) });
      setCommand("");
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } catch (error) {
      setCaptureError(error instanceof Error ? `Not saved — ${error.message}` : "Not saved — try again.");
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setSavingCapture(false);
    }
  }

  async function deleteCapture(captureId: string) {
    try {
      await requestJson<{ ok: boolean }>(`/api/captures/${encodeURIComponent(captureId)}`, { method: "DELETE" });
      setData((current) => current ? { ...current, captures: current.captures.filter((item) => item.id !== captureId) } : current);
      if (captureReceipt?.capture.id === captureId) setCaptureReceipt(null);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "That capture could not be undone.");
    }
  }

  async function moveCapture(capture: Capture, destination: string) {
    setMovingCaptureId(capture.id);
    setCaptureError(null);
    try {
      const isProject = destination.startsWith("project:");
      const path = destination.slice(destination.indexOf(":") + 1) || ".";
      const updated = await requestJson<Capture>(`/api/captures/${encodeURIComponent(capture.id)}`, {
        method: "PATCH",
        body: JSON.stringify(isProject ? { projectPath: path } : { projectPath: null, scopePath: path }),
      });
      setData((current) => current ? { ...current, captures: current.captures.map((item) => item.id === updated.id ? updated : item) } : current);
      if (captureReceipt?.capture.id === updated.id) setCaptureReceipt({ capture: updated, destination: destinationForCapture(updated) });
      setCaptureToMove(null);
      setCaptureMoveSearch("");
    } catch (error) {
      setCaptureError(error instanceof Error ? `Thought not moved — ${error.message}` : "Thought not moved — try again.");
    } finally {
      setMovingCaptureId(null);
    }
  }

  function handleCommandSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!savingCapture) void runCommand();
  }

  function handleCommandKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!savingCapture) void runCommand();
      return;
    }
    if (event.key === "Escape") {
      setCommand("");
      setCaptureError(null);
      event.currentTarget.blur();
    }
  }

  function draftFor(decisionId: string) {
    return decisionDrafts[decisionId] ?? emptyDraft;
  }

  function updateDraft(decisionId: string, patch: Partial<DecisionDraft>) {
    setDecisionDrafts((current) => ({
      ...current,
      [decisionId]: { ...(current[decisionId] ?? emptyDraft), ...patch },
    }));
  }

  async function confirmDecision(decision: Decision) {
    const draft = draftFor(decision.id);
    if (!draft.action || (draft.action === "assign" && !draft.projectPath)) return;

    let choice: Record<string, unknown> | null = null;
    if (draft.action === "assign") choice = { projectPath: draft.projectPath };
    if (draft.action === "defer") choice = { until: deferUntil(draft.deferFor) };
    if (draft.action === "approve" && draft.selectedOption) choice = { option: draft.selectedOption };
    const note = draft.response.trim() || null;

    setSavingDecision(decision.id);
    try {
      const response = await requestJson<Decision | { decision: Decision }>(
        `/api/decisions/${encodeURIComponent(decision.id)}/actions`,
        {
          method: "POST",
          body: JSON.stringify({ action: draft.action, choice, note }),
        },
      );
      const updated = "decision" in response ? response.decision : response;
      setData((current) => current ? {
        ...current,
        decisions: current.decisions.map((item) => item.id === updated.id ? updated : item),
      } : current);
      // An answered question appends to each linked task's progress log on the
      // server; a quiet reload picks those entries up.
      if (decision.refs.length > 0) void loadWorkspace(true);
      const labels: Record<Exclude<DecisionAction, "reopen">, string> = {
        approve: draft.selectedOption ? `Selected “${draft.selectedOption}”` : "Decision recorded",
        reject: "Rejected",
        defer: `Deferred until ${new Date(choice?.until as string).toLocaleDateString([], { month: "short", day: "numeric" })}`,
        cancel: "Cancelled and retained in history",
        assign: `Assigned to ${scopeLabelFor(data?.projects ?? [], draft.projectPath, draft.projectPath)}`,
        keep_unassigned: "Kept unassigned",
      };
      setDecisionReceipt({ decisionId: decision.id, message: labels[draft.action] });
      setExpandedDecision(null);
      setDecisionDrafts((current) => ({ ...current, [decision.id]: emptyDraft }));
    } catch (error) {
      setDecisionReceipt({
        decisionId: decision.id,
        message: error instanceof Error ? `Not recorded — ${error.message}` : "Not recorded — try again.",
      });
    } finally {
      setSavingDecision(null);
    }
  }

  async function reopenDecision(decisionId: string) {
    try {
      const response = await requestJson<Decision | { decision: Decision }>(
        `/api/decisions/${encodeURIComponent(decisionId)}/actions`,
        { method: "POST", body: JSON.stringify({ action: "reopen" }) },
      );
      const updated = "decision" in response ? response.decision : response;
      setData((current) => current ? {
        ...current,
        decisions: current.decisions.map((item) => item.id === updated.id ? updated : item),
      } : current);
      setDecisionReceipt(null);
      setExpandedDecision(decisionId);
    } catch (error) {
      setDecisionReceipt({
        decisionId,
        message: error instanceof Error ? `Undo failed — ${error.message}` : "Undo failed — try again.",
      });
    }
  }

  if (loadError && !data) {
    return (
      <main className="connection-page">
        <span className="brand-mark" aria-hidden="true">/</span>
        <p className="eyebrow">Local workspace</p>
        <h1>Work is ready; this root is not running yet.</h1>
        <p>Start Work from the directory you want to manage. It will stay inside that root and discover projects below it.</p>
        <code>npm run work -- /path/to/your/root</code>
        <button type="button" onClick={() => void loadWorkspace()}>Try again</button>
        <small>{loadError}</small>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="loading-page" aria-live="polite">
        <span className="brand-mark" aria-hidden="true">/</span>
        <strong>Opening this root…</strong>
        <span>Reading local project markers and shared work files.</span>
      </main>
    );
  }

  const captureDestinationProject = captureToProject ? selectedProject : null;
  const captureDestination = captureDestinationProject
    ? `Project inbox: ${captureDestinationProject.name}`
    : `Inbox: ${data.workspace.name} · Unassigned`;
  const rootProject = data.projects.find((project) => project.path === ".");
  const workspaceLocationLabel = data.workspace.root;

  return (
    <div className={`app-shell ${captureDockCollapsed ? "capture-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to this scope</a>

      <header className="topbar">
        <div className="brand-group">
          <button
            className="brand-system"
            type="button"
            onClick={() => {
              setSystemMenuOpen((open) => !open);
              setWorkspaceMenuOpen(false);
              setProjectMenuOpen(false);
            }}
            aria-label="Open Work system menu"
            aria-expanded={systemMenuOpen}
            aria-haspopup="menu"
          >
            <span className="brand-mark" aria-hidden="true">/</span>
            {updateStatus?.updateAvailable && <span className="update-available-dot" aria-label={`Work ${updateStatus.latestVersion} is available`} title={`Work ${updateStatus.latestVersion} is available`} />}
          </button>
          <button className="brand-word" type="button" onClick={() => navigate(".")} aria-label={`Go to all in ${data.workspace.name}`}>work</button>
          <button
            className="root-switch"
            type="button"
            onClick={() => {
              setWorkspaceMenuOpen((open) => !open);
              setSystemMenuOpen(false);
              setProjectMenuOpen(false);
            }}
            aria-expanded={workspaceMenuOpen}
            aria-haspopup="menu"
            aria-label={`Select workspace root. Current: ${data.workspace.name}`}
            title={`${data.workspace.name} · Switch workspace root`}
          >
            <span className="workspace-current-name">{data.workspace.name}</span>
            <span aria-hidden="true">⌄</span>
          </button>
        </div>

        <nav className="breadcrumbs" aria-label="Current directory scope">
          <button type="button" onClick={() => navigate(".")} aria-current={scopePath === "." ? "page" : undefined}>
            {data.workspace.name}
          </button>
          {pathParts(scopePath).map((part, index, parts) => {
            const path = parts.slice(0, index + 1).join("/");
            return (
              <span className="breadcrumb-part" key={path}>
                <span aria-hidden="true">›</span>
                <button type="button" onClick={() => navigate(path)} aria-current={path === scopePath ? "page" : undefined}>
                  {data.projects.find((project) => project.path === path)?.name ?? displaySegment(part)}
                </button>
              </span>
            );
          })}
        </nav>

        <nav className="view-tabs" aria-label="Workspace views">
          <button type="button" className={view === "home" ? "selected" : ""} onClick={() => setView("home")}>Home</button>
          <button type="button" className={view === "board" ? "selected" : ""} onClick={() => setView("board")}>Board</button>
          <button type="button" className={view === "issues" ? "selected" : ""} onClick={() => setView("issues")}>Issues</button>
          <button type="button" className={view === "notes" ? "selected" : ""} onClick={() => setView("notes")}>Notes</button>
          <button type="button" className={view === "files" ? "selected" : ""} onClick={() => setView("files")}>Files</button>
          <button type="button" className={view === "activity" ? "selected" : ""} onClick={() => setView("activity")}>Activity</button>
        </nav>

        <label className="theme-picker">
          <span className="sr-only">Color theme</span>
          <span aria-hidden="true">◐</span>
          <select value={theme} onChange={(event) => setTheme(event.target.value as ThemePreference)} aria-label="Color theme">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <div className="header-actions">
          <button className="project-switch" type="button" onClick={() => {
            setProjectMenuOpen((open) => !open);
            setSystemMenuOpen(false);
            setWorkspaceMenuOpen(false);
          }} aria-expanded={projectMenuOpen}>
            <span>
              {projectInventory.logicalProjects} projects
              {projectInventory.linkedWorktrees > 0 && ` · ${projectInventory.linkedWorktrees} worktrees`}
            </span>
            <span aria-hidden="true">⌄</span>
          </button>
        </div>

        {projectMenuOpen && (
          <div className="project-menu" aria-label="Choose a project in this root">
            <div className="project-menu-heading">
              <div><p className="eyebrow">Only this root</p><strong>{data.workspace.name}</strong><small>{workspaceLocationLabel}</small></div>
              <button type="button" onClick={() => setProjectMenuOpen(false)} aria-label="Close project picker">×</button>
            </div>
            <p className="project-menu-note">Logical projects are listed once. Linked Git worktrees are grouped with their repository.</p>
            <input
              className="project-search"
              type="search"
              value={projectSearch}
              onChange={(event) => setProjectSearch(event.target.value)}
              placeholder="Find a project…"
              aria-label="Find a project in this root"
              autoFocus
            />
            <div className="project-menu-grid">
              {filteredProjectMenu.map((project) => {
                const aliasPaths = project.aliasPaths ?? [];
                const worktreeCount = aliasPaths.length;
                const worktreeLabel = `${worktreeCount} linked worktree${worktreeCount === 1 ? "" : "s"} grouped`;
                return (
                <button
                  type="button"
                  key={project.id}
                  onClick={() => navigate(project.path)}
                  className={project.path === scopePath ? "selected" : ""}
                  aria-label={worktreeCount > 0 ? `${project.name}, logical project, ${worktreeLabel}` : project.name}
                  title={worktreeCount > 0 ? `${worktreeLabel}: ${aliasPaths.join(", ")}` : project.path}
                >
                  <span className="project-code" aria-hidden="true">{project.name.slice(0, 2).toUpperCase()}</span>
                  <span>
                    <strong>{project.name}</strong>
                    <small>{project.path}</small>
                    {worktreeCount > 0 && <em className="project-worktree-note">{worktreeLabel}</em>}
                  </span>
                </button>
                );
              })}
            </div>
          </div>
        )}

        {systemMenuOpen && (
          <div className="system-menu" role="menu" aria-label="Work system controls">
            <div className="project-menu-heading">
              <div>
                <p className="eyebrow">Work system</p>
                <strong>Service and updates</strong>
                <small>Maintain this local Work installation.</small>
              </div>
              <button type="button" onClick={() => setSystemMenuOpen(false)} aria-label="Close Work system menu">×</button>
            </div>
            <section className="update-control" aria-label="Work updates">
              <div>
                <strong>Updates {updateStatus?.updateAvailable && <span className="update-badge">Available</span>}</strong>
                <small>{updateStatus
                  ? updateStatus.updateAvailable
                    ? `Version ${updateStatus.currentVersion} · ${updateStatus.latestVersion} is available${updateStatus.installable ? "" : " · Source checkout"}`
                    : `Version ${updateStatus.currentVersion} · Up to date`
                  : "Checks npm quietly every six hours while Work is open."}</small>
              </div>
              <div className="update-actions">
                <button type="button" onClick={() => void checkForUpdates(false, true)} disabled={checkingUpdate || installingUpdate}>{checkingUpdate ? "Checking…" : "Check now"}</button>
                {updateStatus?.updateAvailable && updateStatus.installable && (
                  <ConfirmAction
                    label="Install & restart"
                    triggerClassName="update-install"
                    confirmLabel={`Install ${updateStatus.latestVersion}`}
                    busyLabel="Installing…"
                    busy={installingUpdate}
                    disabled={installingUpdate}
                    confirmClassName="update-confirm"
                    confirmButtonClassName="primary-action"
                    onConfirm={() => void installServiceUpdate()}
                  />
                )}
              </div>
              {updateStatus?.updateAvailable && !updateStatus.installable && <small className="update-source-note">This copy is running from source; update its Git checkout instead.</small>}
              {updateError && <small className="update-error" role="alert">{updateError}</small>}
            </section>
            <section className="service-control" aria-label="Local Work service">
              <div>
                <strong>Local service</strong>
                <small>Reload the Work API and interface without changing project files.</small>
              </div>
              <ConfirmAction
                label="Restart Work"
                message="Restart now?"
                confirmLabel="Confirm restart"
                busyLabel="Restarting…"
                busy={restartingService}
                confirmClassName="service-restart-confirm"
                onArm={() => setServiceRestartError(null)}
                onConfirm={() => void restartLocalService()}
              />
              {serviceRestartError && <small className="service-restart-error" role="alert">{serviceRestartError}</small>}
            </section>
          </div>
        )}

        {workspaceMenuOpen && workspaceDirectory && (
          <div className="workspace-menu" role="menu" aria-label="Choose a workspace root">
            <div className="project-menu-heading">
              <div>
                <p className="eyebrow">Workspace roots</p>
                <strong>Where do you want to work?</strong>
                <small>Choose a recent root or open any folder on this computer.</small>
              </div>
              <button type="button" onClick={() => setWorkspaceMenuOpen(false)} aria-label="Close workspace picker">×</button>
            </div>
            <div className="workspace-menu-list">
              {workspaceDirectory.workspaces.map((workspace) => {
                const current = workspace.id === data.workspace.id;
                return (
                  <div className={`workspace-menu-item${current ? " selected" : ""}`} role="group" key={workspace.id}>
                    <button
                      className="workspace-select"
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      onClick={() => void switchWorkspace(workspace.id)}
                    >
                      <span className="workspace-icon" aria-hidden="true">{workspace.name.slice(0, 1).toUpperCase()}</span>
                      <span><strong>{workspace.name}</strong><small>{workspace.root}</small></span>
                      {current && <span className="current-root">Current</span>}
                    </button>
                    {!current && (
                      <ConfirmAction
                        label="Remove"
                        triggerClassName="workspace-remove"
                        triggerAriaLabel={`Remove ${workspace.name} from the workspace list`}
                        message="Remove from list? Files stay untouched."
                        confirmLabel="Confirm"
                        busyLabel="Removing…"
                        busy={removingWorkspace === workspace.id}
                        confirmClassName="workspace-remove-confirm"
                        alert
                        onArm={() => setWorkspacePickerError(null)}
                        onConfirm={() => void removeWorkspace(workspace.id)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <section className="workspace-folder-action" aria-label="Open another workspace root">
              <div>
                <strong>Open another folder</strong>
                <small>If it is not already a Work root, its `.work` storage will be created automatically.</small>
              </div>
              <button type="button" onClick={() => void pickWorkspace()} disabled={pickingWorkspace}>
                {pickingWorkspace ? "Opening…" : "Choose folder…"}
              </button>
              {workspacePickerError && <small className="workspace-picker-error" role="alert">{workspacePickerError}</small>}
            </section>
          </div>
        )}
      </header>

      {data.staleBuild && (
        <div className="stale-build" role="status">
          <span><strong>Work was updated on disk.</strong> This service is still running the older build.</span>
          <button type="button" className="stale-build-action" disabled={restartingService}
                  onClick={() => void restartLocalService()}>
            {restartingService ? "Restarting…" : "Restart to load it"}
          </button>
        </div>
      )}

      <main id="main-content" className="main-content">
        {view === "board" ? (
          selectedProject?.view === "list" ? (
            <TaskListView
              scopeLabel={scopeLabel}
              tasks={scopedTasks}
              statuses={data.workspace.statuses ?? ["backlog", "ready", "in_progress", "blocked", "review", "done"]}
              showTerminal={showTerminalTasks}
              onToggleTerminal={() => setShowTerminalTasks((shown) => !shown)}
              onMove={(taskId, status) => void moveWorkTask(taskId, status).catch(() => {})}
              onOpenTask={setSelectedTaskId}
              onCreate={() => setCreatingTask(true)}
              error={taskError}
            />
          ) : (
          <KanbanBoard
            scopeLabel={scopeLabel}
            tasks={scopedTasks}
            statuses={data.workspace.statuses ?? ["backlog", "ready", "in_progress", "blocked", "review", "done"]}
            projects={data.projects}
            decisions={data.decisions}
            search={taskSearch}
            onSearch={setTaskSearch}
            showTerminal={showTerminalTasks}
            onToggleTerminal={() => setShowTerminalTasks((shown) => !shown)}
            draggingTaskId={draggingTaskId}
            onDragStart={setDraggingTaskId}
            onDragEnd={() => setDraggingTaskId(null)}
            onMove={(taskId, status) => void moveWorkTask(taskId, status).catch(() => {})}
            onOpenTask={setSelectedTaskId}
            onCreate={() => setCreatingTask(true)}
            error={taskError}
          />
          )
        ) : view === "issues" ? (
          <IssuesView
            scopeLabel={scopeLabel}
            scopePath={scopePath}
            scopeKind={scopeKind}
            issues={scopedIssues}
            projects={data.projects}
            selectedIssueId={selectedIssueId}
            saving={savingIssue}
            error={issueError}
            onSelect={setSelectedIssueId}
            onCreate={createIssue}
            onReply={replyToIssue}
            onSetState={setIssueState}
            onSetDelegated={setIssueDelegated}
          />
        ) : view === "notes" ? (
          <NotesView
            scopeLabel={scopeLabel}
            scopeKind={scopeKind}
            notes={scopedNotes}
            projects={data.projects}
            selectedNoteId={selectedNoteId}
            creating={creatingNote}
            error={noteError}
            onSelect={setSelectedNoteId}
            onCreate={createProjectNote}
            onUpdate={updateProjectNote}
            onDelete={deleteProjectNote}
          />
        ) : view === "files" ? (
          <FilesView
            key={scopePath}
            scopeLabel={scopeLabel}
            scopePath={scopePath}
            project={selectedProject}
            onProjectCreated={rememberProject}
          />
        ) : view === "activity" ? (
          <ActivityView
            scopeLabel={scopeLabel}
            tasks={scopedTasks}
            projects={data.projects}
            onOpenTask={setSelectedTaskId}
          />
        ) : (
          <>
        <section id="continue" className="continue-section" aria-label={`${scopeLabel} current scope`}>
          {scopeKind === "project" && selectedProject ? (
            <ProjectFocus
              project={selectedProject}
              captures={scopedCaptures.filter((capture) => capture.projectPath === selectedProject.path)}
              tasks={scopedTasks.filter((task) => task.projectPath === selectedProject.path)}
              onOpenBoard={() => setView("board")}
              onOpenTask={(taskId) => { setView("board"); setSelectedTaskId(taskId); }}
              onUpdateProfile={updateProjectProfile}
            />
          ) : (
            <div className="portfolio-intro">
              <p className="continue-label"><span aria-hidden="true" /> {scopeKind === "root" ? "One root" : "Folder scope"}</p>
              <h1>{scopeKind === "root" ? `All in ${data.workspace.name}` : scopeLabel}</h1>
              <p>See the shape of this directory without pulling in unrelated work. Everything here stays under one filesystem boundary.</p>
              <p className="scope-path" title={scopeKind === "root" ? workspaceLocationLabel : `${workspaceLocationLabel}/${scopePath}`}>{scopeKind === "root" ? workspaceLocationLabel : scopePath}</p>
              <div className="portfolio-stats" aria-label="Scope summary">
                <span><strong>{visibleProjects.length + (scopePath === "." && rootProject ? 1 : 0)}</strong> projects</span>
                <span><strong>{scopedTasks.length}</strong> work items</span>
                <span><strong>{scopedTasks.filter((task) => ["in_progress", "blocked", "review"].includes(task.status)).length}</strong> in flight</span>
                <span><strong>{scopedTasks.filter((task) => task.status === "done").length}</strong> completed</span>
                <span><strong>{scopedCaptures.length}</strong> captured</span>
                <span><strong>{activeDecisions.length}</strong> need you</span>
              </div>
            </div>
          )}

          {(scopeKind !== "project" || childGroups.length > 0 || directProjects.length > 0) && (
            <div className="scope-grid-section">
              <div className="section-heading compact">
                <div><p className="eyebrow">Zoom in without leaving this root</p><h2 id="scope-heading">Projects and folders</h2></div>
                <span className="count-badge">{visibleProjects.length}</span>
              </div>
              {childGroups.length === 0 && directProjects.length === 0 ? (
                <div className="empty-panel project-create-panel">
                  <strong>No projects here yet.</strong>
                  <span>Name your first project. Work creates the folder and its marker for you.</span>
                  <InlineProjectCreate parentPath={scopePath} onCreated={(project) => { rememberProject(project); navigate(project.path); }} />
                </div>
              ) : (
                <div className="project-grid">
                  {childGroups.map((group) => (
                    <button type="button" className="project-card group-card" key={group.path} onClick={() => navigate(group.path)}>
                      <span className="project-card-code" aria-hidden="true">⌁</span>
                      <span className="project-card-copy"><small>Folder scope</small><strong>{group.name}</strong><span>{group.path}</span></span>
                      <span className="project-card-meta">{group.projects} projects<span aria-hidden="true">→</span></span>
                    </button>
                  ))}
                  {directProjects.map((project) => (
                    <button type="button" className="project-card" key={project.id} onClick={() => navigate(project.path)}>
                      <span className="project-card-code" aria-hidden="true">{project.name.slice(0, 2).toUpperCase()}</span>
                      <span className="project-card-copy"><small>Project · {project.path}</small><strong>{project.name}</strong><span>{project.description || "Add a purpose description"}</span></span>
                      <span className="project-card-meta">Open<span aria-hidden="true">→</span></span>
                    </button>
                  ))}
                  <div className="project-card new-project-card">
                    <span className="project-card-code" aria-hidden="true">＋</span>
                    <span className="project-card-copy">
                      <small>+ New project</small>
                      <InlineProjectCreate parentPath={scopePath} onCreated={rememberProject} />
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <UpcomingSchedule
          items={scheduledItems}
          projects={data.projects}
          onOpenTask={(taskId) => { setView("board"); setSelectedTaskId(taskId); }}
        />

        <div className="home-support-grid">
        <section id="needs-you" className="attention-section" aria-labelledby="needs-you-heading">
          <div className="section-heading">
            <div><p className="eyebrow">Choices, not dismissals</p><h2 id="needs-you-heading">Needs you</h2></div>
            <span className="count-badge" aria-label={`${attentionCount} items need you`}>{attentionCount}</span>
          </div>

          {decisionReceipt && (
            <div className="decision-receipt" role="status">
              <span><strong>Recorded.</strong> {decisionReceipt.message}</span>
              <button type="button" onClick={() => void reopenDecision(decisionReceipt.decisionId)}>Undo</button>
            </div>
          )}

          {attentionCount === 0 ? (
            <div className="empty-panel"><strong>Nothing needs a decision in this scope.</strong><span>Ordinary work stays out of this list.</span></div>
          ) : (
            <div className="attention-list">
              {[
                ...visibleHumanIssues.map((issue) => ({
                  key: `issue-${issue.id}`,
                  icon: "↩",
                  kind: "Issue",
                  title: issue.title,
                  projectPath: issue.projectPath,
                  action: "Reply",
                  open: () => { setSelectedIssueId(issue.id); setView("issues"); },
                })),
                ...visibleBlockedTasks.map((task) => ({
                  key: `task-${task.id}`,
                  icon: "■",
                  kind: "Blocked task",
                  title: task.title,
                  projectPath: task.projectPath,
                  action: "Unblock",
                  open: () => { setSelectedTaskId(task.id); setView("board"); },
                })),
              ].map((item) => (
                <article className="attention-item issue-attention-item" key={item.key}>
                  <button type="button" className="attention-summary" onClick={item.open}>
                    <span className="attention-check" aria-hidden="true">{item.icon}</span>
                    <span className="attention-copy">
                      <small>{item.kind} · {scopeLabelFor(data.projects, item.projectPath, `${data.workspace.name} · Unassigned`)}</small>
                      <strong>{item.title}</strong>
                    </span>
                    <span className="review-label">{item.action}</span>
                  </button>
                </article>
              ))}
              {visibleDecisions.map((decision) => {
                const open = expandedDecision === decision.id;
                return (
                  <article className={`attention-item ${open ? "open" : ""}`} key={decision.id}>
                    <button type="button" className="attention-summary" onClick={() => setExpandedDecision(open ? null : decision.id)} aria-expanded={open}>
                      <span className="attention-check" aria-hidden="true">?</span>
                      <span className="attention-copy">
                        <small>{scopeLabelFor(data.projects, decision.projectPath, `${data.workspace.name} · Unassigned`)}</small>
                        <strong>{decision.title}</strong>
                      </span>
                      <span className="review-label">{open ? "Close" : "Choose"}</span>
                    </button>

                    {open && (
                      <DecisionPanel
                        decision={decision}
                        draft={draftFor(decision.id)}
                        projects={data.projects}
                        saving={savingDecision === decision.id}
                        autoFocusResponse
                        onDraft={updateDraft}
                        onConfirm={() => void confirmDecision(decision)}
                        onClose={() => setExpandedDecision(null)}
                      />
                    )}
                  </article>
                );
              })}
              {attentionCount > visibleHumanIssues.length + visibleBlockedTasks.length + visibleDecisions.length && (
                <p className="more-decisions">{attentionCount - visibleHumanIssues.length - visibleBlockedTasks.length - visibleDecisions.length} more waiting safely in this scope. Reply, finish, or defer one to bring the next forward.</p>
              )}
            </div>
          )}
        </section>

        <section id="inbox" className="captured-section" aria-labelledby="inbox-heading">
          <div className="section-heading">
            <div><p className="eyebrow">Visible immediately</p><h2 id="inbox-heading">Inbox</h2><small className="inbox-destination">{destinationForCurrentScope()}</small></div>
            <span className="count-badge" aria-label={`${scopedCaptures.length} captures in this scope`}>{scopedCaptures.length}</span>
          </div>
          {scopedCaptures.length === 0 ? (
            <div className="empty-panel"><strong>Nothing captured in this scope yet.</strong><span>Use the bar below. It saves the exact thought before asking you to organize it.</span></div>
          ) : (
            <ul className="capture-list">
              {scopedCaptures.map((capture) => {
                const destinationLabel = destinationForCapture(capture);
                return (
                  <li key={capture.id} className={captureReceipt?.capture.id === capture.id ? "new-capture" : ""}>
                    <span className={`capture-kind kind-${capture.kind}`}>{capture.kind}</span>
                    <div><strong>{capture.text}</strong><small>{destinationLabel} · {shortTime(capture.createdAt)}</small></div>
                    <div className="capture-row-actions">
                      <button type="button" className="capture-icon-action" title="Move to another inbox" onClick={() => { setCaptureToMove(capture); setCaptureMoveSearch(""); }} aria-label={`Move thought to another inbox: ${capture.text}`}><span aria-hidden="true">↗</span></button>
                      <button type="button" className="capture-icon-action promote-note" title="Keep this as a note" onClick={() => void promoteCaptureToNote(capture).catch(() => {})} aria-label={`Make note from thought: ${capture.text}`}><span aria-hidden="true">◇</span></button>
                      <button type="button" className="capture-icon-action promote-capture" title="Make this a task" onClick={() => void promoteCaptureToTask(capture).catch(() => {})} aria-label={`Make task from thought: ${capture.text}`}><span aria-hidden="true">＋</span></button>
                      <button type="button" className="capture-icon-action remove-capture" title="Remove this thought" onClick={() => void deleteCapture(capture.id)} aria-label={`Remove capture: ${capture.text}`}><span aria-hidden="true">×</span></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        </div>

        {scopeKind === "project" && selectedProject && (
          <section className="danger-zone" aria-label="Danger zone">
            <button type="button" className="danger-zone-button" onClick={() => { setProjectDeleteError(null); setConfirmingProjectDelete(true); }}>
              {TRASH_GLYPH} Delete project
            </button>
          </section>
        )}
          </>
        )}
      </main>

      {confirmingProjectDelete && selectedProject && (
        <div className="capture-move-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !deletingProject) setConfirmingProjectDelete(false); }}>
          <section className="project-delete-panel" role="dialog" aria-modal="true" aria-labelledby="project-delete-heading">
            <div className="capture-move-heading">
              <div><p className="eyebrow">Danger zone</p><h2 id="project-delete-heading">Delete {selectedProject.name}?</h2></div>
              <button type="button" onClick={() => setConfirmingProjectDelete(false)} aria-label="Close delete confirmation" disabled={deletingProject}>×</button>
            </div>
            <p className="project-delete-copy">Removes the project and its Work records. Your files stay unless the folder is empty.</p>
            {projectDeleteError && <p className="field-error" role="alert">{projectDeleteError}</p>}
            <div className="project-delete-actions">
              <button type="button" onClick={() => setConfirmingProjectDelete(false)} disabled={deletingProject}>Cancel</button>
              <button type="button" className="danger-zone-button" disabled={deletingProject} onClick={() => void confirmProjectDelete()}>
                {TRASH_GLYPH} {deletingProject ? "Deleting…" : "Delete project"}
              </button>
            </div>
          </section>
        </div>
      )}

      {captureToMove && (
        <div className="capture-move-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCaptureToMove(null); }}>
          <section className="capture-move-panel" role="dialog" aria-modal="true" aria-labelledby="capture-move-heading">
            <div className="capture-move-heading"><div><p className="eyebrow">Reassign thought</p><h2 id="capture-move-heading">Move to an inbox</h2></div><button type="button" onClick={() => setCaptureToMove(null)} aria-label="Close destination picker">×</button></div>
            <p className="capture-move-preview">“{captureToMove.text}”</p>
            <label className="field-wide"><span className="sr-only">Find a destination</span><input type="search" value={captureMoveSearch} onChange={(event) => setCaptureMoveSearch(event.target.value)} placeholder="Find a project or folder…" autoFocus /></label>
            <div className="capture-destination-list">
              {[
                { value: "scope:.", title: "Root inbox", detail: `${data.workspace.name} · Unassigned` },
                ...inboxFolderScopes.map((path) => ({ value: `scope:${path}`, title: displaySegment(pathParts(path).at(-1) ?? path), detail: `Folder inbox · ${path}` })),
                ...data.projects.filter((project) => project.path !== ".").map((project) => ({ value: `project:${project.path}`, title: project.name, detail: `Project inbox · ${project.path}` })),
              ].filter((item) => `${item.title} ${item.detail}`.toLowerCase().includes(captureMoveSearch.trim().toLowerCase())).map((item) => (
                <button type="button" key={item.value} disabled={movingCaptureId === captureToMove.id} onClick={() => void moveCapture(captureToMove, item.value)}><span><strong>{item.title}</strong><small>{item.detail}</small></span><span aria-hidden="true">→</span></button>
              ))}
            </div>
          </section>
        </div>
      )}

      {creatingTask && (
        <CreateTaskPanel
          projects={data.projects}
          statuses={data.workspace.statuses}
          defaultProjectPath={selectedProject?.path ?? null}
          saving={savingTask}
          error={taskError}
          onClose={() => { setCreatingTask(false); setTaskError(null); }}
          onCreate={(input) => void createWorkTask(input).catch(() => {})}
        />
      )}

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          tasks={data.tasks ?? []}
          projects={data.projects}
          statuses={data.workspace.statuses}
          saving={savingTask}
          error={taskError}
          openQuestions={selectedTaskQuestions.length > 0 ? (
            <section className="task-subsection task-open-questions" aria-label="Open questions">
              <h3>Open questions</h3>
              <p>Answering records the choice on this card’s log. The status stays yours to change.</p>
              {selectedTaskQuestions.map((decision) => (
                <article className="task-open-question" key={decision.id}>
                  <h4>{decision.title}</h4>
                  <DecisionPanel
                    decision={decision}
                    draft={draftFor(decision.id)}
                    projects={data.projects}
                    saving={savingDecision === decision.id}
                    onDraft={updateDraft}
                    onConfirm={() => void confirmDecision(decision)}
                  />
                </article>
              ))}
            </section>
          ) : null}
          onClose={() => { setSelectedTaskId(null); setTaskError(null); }}
          onMove={(status, note) => void moveWorkTask(selectedTask.id, status, note).catch(() => {})}
          onPatch={(patch) => void patchWorkTask(selectedTask.id, patch).catch(() => {})}
          onToggle={(section, index, checked) => void toggleWorkChecklist(selectedTask.id, section, index, checked)}
          onLog={(message) => logWorkProgress(selectedTask.id, message)}
        />
      )}

      {captureDockCollapsed ? (
        <button
          type="button"
          className="capture-dock-restore"
          aria-label="Show capture box"
          onClick={() => setCaptureDockCollapsedPersisted(false, true)}
        >
          <span aria-hidden="true">⌃</span><strong>Capture</strong>
        </button>
      ) : <div className="capture-dock" id="capture-dock">
        <button
          type="button"
          className="capture-dock-collapse"
          aria-label="Hide capture box"
          aria-controls="capture-dock"
          aria-expanded="true"
          onClick={() => setCaptureDockCollapsedPersisted(true)}
        ><span aria-hidden="true">⌄</span></button>
        {captureReceipt && (
          <div className="capture-receipt" role="status" aria-live="polite">
            <span className="receipt-check" aria-hidden="true">✓</span>
            <div><strong>Saved: “{captureReceipt.capture.text}”</strong><small>{captureReceipt.destination} · Waiting in your inbox</small></div>
            <div className="receipt-actions">
              <button type="button" onClick={() => void promoteCaptureToNote(captureReceipt.capture).catch(() => {})}>Make note</button>
              <button type="button" onClick={() => void promoteCaptureToTask(captureReceipt.capture).catch(() => {})}>Make task</button>
              <button type="button" onClick={() => void deleteCapture(captureReceipt.capture.id)}>Undo</button>
              <button type="button" onClick={() => openHomeSection("inbox")}>Open inbox</button>
              <button type="button" onClick={() => setCaptureReceipt(null)} aria-label="Dismiss saved receipt">×</button>
            </div>
          </div>
        )}
        <form onSubmit={handleCommandSubmit} aria-label="Universal work command">
          <div className="capture-context">
            <span className="capture-symbol" aria-hidden="true">/</span>
            <div>
              <strong>Capture anything</strong>
              <button
                type="button"
                className={`capture-destination-toggle ${captureDestinationProject ? "to-project" : ""}`}
                onClick={() => setCaptureToProject((current) => !current)}
                disabled={!selectedProject}
                aria-pressed={Boolean(captureDestinationProject)}
                title={selectedProject
                  ? `Capture into ${captureDestinationProject ? "the root Inbox instead" : selectedProject.name} `
                  : "Open a project to capture into it instead of the Inbox"}
              >
                Going to {captureDestinationProject ? captureDestinationProject.name : "Inbox"}{selectedProject ? " · switch" : ""}
              </button>
            </div>
          </div>
          <label className="sr-only" htmlFor="work-command">Tell Work anything you want remembered</label>
          <textarea
            ref={inputRef}
            id="work-command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={handleCommandKeyDown}
            placeholder="Tell /work anything…"
            autoComplete="off"
            rows={1}
          />
          <button className="remember-button" type="submit" disabled={savingCapture}>
            {savingCapture ? "Saving…" : "Save thought"}<span aria-hidden="true">↵</span>
          </button>
        </form>
        <div className="capture-meta">
          <span className={captureError ? "capture-error" : ""} aria-live="polite">
            {captureError ?? `Exact destination: ${captureDestination}. Project names in the thought never reroute it.`}
          </span>
          <div>
            <button type="button" onClick={() => openHomeSection("inbox")}>{scopedCaptures.length} in {selectedProject ? `${selectedProject.name} inbox` : scopePath === "." ? "root inbox" : `${scopeLabel} inbox`}</button>
            <span className="shortcut-hint"><kbd>/</kbd> focus</span>
            <span className="multiline-hint"><kbd>Shift</kbd> + <kbd>Enter</kbd> new line</span>
            <span>{lastSyncedAt ? `Synced ${shortTime(lastSyncedAt.toISOString())}` : "Connecting…"}</span>
          </div>
        </div>
      </div>}
    </div>
  );
}

function InlineProjectCreate({
  parentPath,
  onCreated,
}: {
  parentPath: string;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const project = await requestJson<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, ...(parentPath === "." ? {} : { parentPath }) }),
      });
      setName("");
      onCreated(project);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The project could not be created.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="project-create-form" onSubmit={create}>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Project name…"
        aria-label="New project name"
        maxLength={120}
      />
      <button type="submit" disabled={saving || !name.trim()}>{saving ? "Creating…" : "Create project"}</button>
      {error && <span className="capture-error" role="alert">{error}</span>}
    </form>
  );
}

const TRASH_GLYPH = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M2.5 4.5h11m-8-2h5m-6.6 2 .7 8.3a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.7-8.3M6.6 7v4.5M9.4 7v4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function ConfirmAction({
  label,
  message,
  confirmLabel,
  busyLabel,
  busy = false,
  disabled = false,
  triggerClassName,
  triggerAriaLabel,
  confirmClassName,
  confirmButtonClassName = "danger-action",
  alert = false,
  onArm,
  onConfirm,
}: {
  label: ReactNode;
  message?: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  confirmClassName?: string;
  confirmButtonClassName?: string;
  alert?: boolean;
  onArm?: () => void;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button
        type="button"
        className={triggerClassName}
        aria-label={triggerAriaLabel}
        disabled={disabled}
        onClick={() => {
          setArmed(true);
          onArm?.();
        }}
      >
        {label}
      </button>
    );
  }
  return (
    <div className={confirmClassName} role={alert ? "alert" : undefined}>
      {message && <span>{message}</span>}
      <button type="button" onClick={() => setArmed(false)} disabled={busy}>Cancel</button>
      <button type="button" className={confirmButtonClassName} disabled={busy} onClick={onConfirm}>
        {busy && busyLabel ? busyLabel : confirmLabel}
      </button>
    </div>
  );
}

// The one decision resolution surface. Needs you on Home and the Open
// questions block on a task card both render this; there is no second copy.
function DecisionPanel({ decision, draft, projects, saving, autoFocusResponse, onDraft, onConfirm, onClose }: {
  decision: Decision;
  draft: DecisionDraft;
  projects: Project[];
  saving: boolean;
  autoFocusResponse?: boolean;
  onDraft: (decisionId: string, patch: Partial<DecisionDraft>) => void;
  onConfirm: () => void;
  onClose?: () => void;
}) {
  const hasExplicitOptions = decision.options.length > 0;
  const choosingOther = draft.selectedOption === "Other";
  const hasDecisionResponse = hasExplicitOptions
    ? Boolean(draft.selectedOption) && (!choosingOther || Boolean(draft.response.trim()))
    : Boolean(draft.response.trim());
  const displayedOptions = hasExplicitOptions && !decision.options.includes("Other")
    ? [...decision.options, "Other"]
    : decision.options;
  const canConfirm = Boolean(
    draft.action
    && (draft.action !== "assign" || draft.projectPath)
    && (draft.action !== "approve" || hasDecisionResponse),
  );
  return (
    <div className="decision-panel">
      {decision.detail && <p className="decision-detail">{decision.detail}</p>}
      <fieldset>
        <legend>{hasExplicitOptions ? "Choose one option" : "What is your decision?"}</legend>
        {hasExplicitOptions ? displayedOptions.map((option) => (
          <label className={`decision-choice ${draft.selectedOption === option ? "selected" : ""}`} key={option}>
            <input
              type="radio"
              name={`decision-option-${decision.id}`}
              value={option}
              checked={draft.selectedOption === option}
              onChange={() => onDraft(decision.id, { action: "approve", selectedOption: option })}
            />
            <span>
              <strong>{option}</strong>
              {option === decision.recommendedOption && <small className="decision-recommended">Recommendation</small>}
              {option === "Other" && <small>Write a different answer below.</small>}
            </span>
          </label>
        )) : (
          <label className="decision-response">
            <span>Your answer</span>
            <textarea
              value={draft.response}
              onChange={(event) => onDraft(decision.id, { action: "approve", response: event.target.value })}
              placeholder="Write the decision or direction that should be recorded…"
              autoFocus={autoFocusResponse}
            />
          </label>
        )}
        {hasExplicitOptions && (
          <label className={`decision-response ${choosingOther ? "" : "optional"}`}>
            <span>{choosingOther ? "Your answer" : <>Reason or context <small>(optional)</small></>}</span>
            <textarea value={draft.response} onChange={(event) => onDraft(decision.id, { response: event.target.value })} placeholder={choosingOther ? "Write the decision or direction that should be recorded…" : "Why this option?"} />
          </label>
        )}
      </fieldset>
      <details className="decision-management">
        <summary>Manage instead of deciding</summary>
        <fieldset>
          <legend>Administrative actions</legend>
        {!decision.projectPath && <DecisionChoice decisionId={decision.id} action="assign" label="Assign to a project" detail="Choose one project from this root." draft={draft} onChange={onDraft} />}
        {draft.action === "assign" && (
          <label className="inline-field">
            <span>Project</span>
            <select value={draft.projectPath} onChange={(event) => onDraft(decision.id, { projectPath: event.target.value })}>
              <option value="">Choose a project…</option>
              {projects.filter((project) => project.path !== ".").map((project) => (
                <option value={project.path} key={project.id}>{project.name} — {project.path}</option>
              ))}
            </select>
          </label>
        )}
        {!decision.projectPath && <DecisionChoice decisionId={decision.id} action="keep_unassigned" label="Keep unassigned" detail="Make no ownership claim yet." draft={draft} onChange={onDraft} />}
        <DecisionChoice decisionId={decision.id} action="defer" label="Decide later" detail="Return it to Needs you at a real time." draft={draft} onChange={onDraft} />
        {draft.action === "defer" && (
          <label className="inline-field">
            <span>Bring it back</span>
            <select value={draft.deferFor} onChange={(event) => onDraft(decision.id, { deferFor: event.target.value as DecisionDraft["deferFor"] })}>
              <option value="today">Later today</option>
              <option value="tomorrow">Tomorrow</option>
              <option value="week">Next week</option>
            </select>
          </label>
        )}
        <DecisionChoice decisionId={decision.id} action="cancel" label="Cancel this item" detail="Retain a cancelled record; do not erase history." draft={draft} onChange={onDraft} />
        </fieldset>
      </details>
      <div className="decision-actions">
        {onClose && <button type="button" className="secondary-action" onClick={onClose}>Close without changes</button>}
        <button type="button" className="primary-action" disabled={!canConfirm || saving} onClick={onConfirm}>
          {saving ? "Recording…" : "Confirm decision"}
        </button>
      </div>
    </div>
  );
}

function DecisionChoice({
  decisionId,
  action,
  label,
  detail,
  draft,
  onChange,
}: {
  decisionId: string;
  action: Exclude<DecisionAction, "reopen">;
  label: string;
  detail: string;
  draft: DecisionDraft;
  onChange: (decisionId: string, patch: Partial<DecisionDraft>) => void;
}) {
  return (
    <label className={`decision-choice ${draft.action === action ? "selected" : ""}`}>
      <input type="radio" name={`decision-${decisionId}`} value={action} checked={draft.action === action} onChange={() => onChange(decisionId, { action })} />
      <span><strong>{label}</strong><small>{detail}</small></span>
    </label>
  );
}

function ProjectFocus({ project, captures, tasks, onOpenBoard, onOpenTask, onUpdateProfile }: {
  project: Project;
  captures: Capture[];
  tasks: WorkTask[];
  onOpenBoard: () => void;
  onOpenTask: (taskId: string) => void;
  onUpdateProfile: (projectPath: string, patch: { name?: string; description?: string; view?: "board" | "list" }) => Promise<Project>;
}) {
  const [savingView, setSavingView] = useState(false);
  async function switchView(view: "board" | "list") {
    if (view === project.view || savingView) return;
    setSavingView(true);
    try {
      await onUpdateProfile(project.path, { view });
    } catch {
      // The profile card keeps its current mode; the next toggle retries.
    } finally {
      setSavingView(false);
    }
  }
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(project.name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [editingPurpose, setEditingPurpose] = useState(false);
  const [purpose, setPurpose] = useState(project.description ?? "");
  const [savingPurpose, setSavingPurpose] = useState(false);
  const [purposeError, setPurposeError] = useState<string | null>(null);
  const updates = captures.filter((capture) => capture.kind === "update");
  const inFlight = tasks.filter((task) => ["in_progress", "blocked", "review"].includes(task.status));
  const queued = tasks.filter((task) => ["ready", "backlog"].includes(task.status));
  const completed = tasks.filter((task) => task.status === "done");
  const currentTasks = (inFlight.length > 0 ? inFlight : queued).slice(0, 3);
  const lastUpdate = tasks.flatMap((task) => task.log.map((entry) => ({ ...entry, task }))).sort((a, b) => b.at.localeCompare(a.at))[0];
  const latestCapture = updates[0] ?? captures[0];
  const progressText = lastUpdate?.message ?? latestCapture?.text ?? "No meaningful progress has been recorded for this project yet.";
  const progressSource = lastUpdate
    ? `${lastUpdate.task.id} · ${shortTime(lastUpdate.at)}`
    : latestCapture
      ? `${latestCapture.kind} · ${shortTime(latestCapture.updatedAt)}`
      : "Waiting for the first update";

  useEffect(() => {
    setName(project.name);
    setEditingName(false);
    setNameError(null);
    setPurpose(project.description ?? "");
    setEditingPurpose(false);
    setPurposeError(null);
  }, [project.path, project.name, project.description]);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setSavingName(true);
    setNameError(null);
    try {
      await onUpdateProfile(project.path, { name: name.trim() });
      setEditingName(false);
    } catch (error) {
      setNameError(error instanceof Error ? error.message : "The project name could not be saved.");
    } finally {
      setSavingName(false);
    }
  }

  async function savePurpose() {
    setSavingPurpose(true);
    setPurposeError(null);
    try {
      await onUpdateProfile(project.path, { description: purpose.trim() });
      setEditingPurpose(false);
    } catch (error) {
      setPurposeError(error instanceof Error ? error.message : "The project purpose could not be saved.");
    } finally {
      setSavingPurpose(false);
    }
  }

  return (
    <article className="project-pulse">
      <header className="pulse-header">
        <div>
          <p className="continue-label"><span aria-hidden="true" /> Project pulse</p>
          {editingName ? (
            <form className="project-name-editor" onSubmit={(event) => void saveName(event)}>
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={120} aria-label="Project name" />
              <button type="button" className="project-name-folder" onClick={() => setName(project.path.split("/").at(-1) ?? project.name)}>Use folder name</button>
              <button type="button" onClick={() => { setName(project.name); setEditingName(false); setNameError(null); }}>Cancel</button>
              <button type="submit" className="primary-action" disabled={savingName || !name.trim()}>{savingName ? "Saving…" : "Save"}</button>
            </form>
          ) : (
            <div className="project-name-heading">
              <h1>{project.name}</h1>
              <button type="button" className="project-name-edit" aria-label="Edit project name" title="Edit project name" onClick={() => setEditingName(true)}><span aria-hidden="true">✎</span></button>
            </div>
          )}
          <span className="pulse-path">{project.path}</span>
          {nameError && <p className="field-error" role="alert">{nameError}</p>}
        </div>
        <div className="pulse-header-actions">
          <div className="project-view-toggle" role="group" aria-label="Task view for this project">
            <button type="button" className={project.view === "board" ? "selected" : ""} aria-pressed={project.view === "board"} disabled={savingView} onClick={() => void switchView("board")}>Board</button>
            <button type="button" className={project.view === "list" ? "selected" : ""} aria-pressed={project.view === "list"} disabled={savingView} onClick={() => void switchView("list")}>List</button>
          </div>
          <button type="button" className="primary-action" onClick={onOpenBoard}>{project.view === "list" ? "Open list" : "Open board"}<span aria-hidden="true">→</span></button>
        </div>
      </header>

      <section className="project-purpose" aria-label="Project purpose">
        <div className="project-purpose-heading">
          <div><p className="eyebrow">Why this project exists</p><h2>Project purpose</h2></div>
          {!editingPurpose && <button type="button" onClick={() => setEditingPurpose(true)}>{project.description ? "Edit" : "Add purpose"}</button>}
        </div>
        {editingPurpose ? (
          <div className="project-purpose-editor">
            <textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={20_000} rows={4} aria-label="Project purpose description" placeholder="What is this project, who does it serve, and why does it exist?" />
            <div><button type="button" onClick={() => { setPurpose(project.description ?? ""); setEditingPurpose(false); setPurposeError(null); }}>Cancel</button><button type="button" className="primary-action" disabled={savingPurpose} onClick={() => void savePurpose()}>{savingPurpose ? "Saving…" : "Save purpose"}</button></div>
          </div>
        ) : (
          <p className={project.description ? "" : "project-purpose-empty"}>{project.description || "Add a short description of what this project is trying to make possible."}</p>
        )}
        {purposeError && <p className="field-error" role="alert">{purposeError}</p>}
      </section>

      <div className="pulse-stats" aria-label="Project summary">
        <span><strong>{tasks.length}</strong> work items</span>
        <span><strong>{inFlight.length}</strong> active</span>
        <span><strong>{completed.length}</strong> completed</span>
        <span><strong>{captures.length}</strong> inbox</span>
      </div>

      <div className="pulse-grid">
        <section className="pulse-work" aria-labelledby="current-work-heading">
          <div className="pulse-section-heading">
            <div><p className="eyebrow">What deserves attention</p><h2 id="current-work-heading">{inFlight.length > 0 ? "Current work" : "Up next"}</h2></div>
            <button type="button" onClick={onOpenBoard}>View all</button>
          </div>
          {currentTasks.length === 0 ? (
            <p className="pulse-empty">Nothing is queued. Capture the next useful thread when it appears.</p>
          ) : (
            <div className="pulse-task-list">
              {currentTasks.map((task) => {
                const progress = checklistProgress(task);
                return (
                  <button type="button" key={task.id} onClick={() => onOpenTask(task.id)}>
                    <span className={`pulse-state pulse-state-${task.status}`}>{statusLabel(task.status)}</span>
                    <span className="pulse-task-copy"><small>{task.id}{task.delegated ? " · handed to an agent" : ""}</small><strong>{task.title}</strong></span>
                    <span className="pulse-task-meta">{progress.total > 0 ? `${progress.complete}/${progress.total}` : shortTime(task.updatedAt)}<span aria-hidden="true">→</span></span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <aside className="pulse-progress">
          <p className="eyebrow">Latest progress</p>
          <p title={progressText}>{progressText}</p>
          <small>{progressSource}</small>
        </aside>
      </div>

    </article>
  );
}

const FILE_STATUS_COPY: Record<GitFileStatus, { short: string; label: string }> = {
  conflict: { short: "!", label: "Conflict" },
  deleted: { short: "D", label: "Deleted" },
  added: { short: "A", label: "Added" },
  untracked: { short: "?", label: "Untracked" },
  modified: { short: "M", label: "Modified" },
  renamed: { short: "R", label: "Renamed" },
};

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FilesView({ scopeLabel, scopePath, project, onProjectCreated }: {
  scopeLabel: string;
  scopePath: string;
  project: Project | null;
  onProjectCreated: (project: Project) => void;
}) {
  const fileScopes = project
    ? [
        { path: project.path, label: `${project.path} — primary checkout` },
        ...(project.aliasPaths ?? []).map((path) => ({ path, label: `${path} — linked worktree` })),
      ]
    : [{ path: scopePath, label: scopePath === "." ? "Workspace root" : scopePath }];
  const [fileScopePath, setFileScopePath] = useState(fileScopes[0].path);
  const [directories, setDirectories] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectReceipt, setProjectReceipt] = useState<Project | null>(null);
  const [initializingProjectPath, setInitializingProjectPath] = useState<string | null>(null);
  const [initializedProjectPaths, setInitializedProjectPaths] = useState<Set<string>>(new Set());
  const [changedOnly, setChangedOnly] = useState(false);
  const [git, setGit] = useState<FileDirectory["git"]>({ available: false, counts: {} });

  const loadDirectory = useCallback(async (path: string) => {
    setLoadingDirectories((current) => new Set(current).add(path));
    setError(null);
    try {
      const query = new URLSearchParams({ scopePath: fileScopePath, path });
      const directory = await requestJson<FileDirectory>(`/api/files/directory?${query.toString()}`);
      setDirectories((current) => ({ ...current, [directory.path]: directory.entries }));
      setGit(directory.git);
      return directory;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The file tree could not be loaded.");
      return null;
    } finally {
      setLoadingDirectories((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  }, [fileScopePath]);

  const refreshFiles = useCallback(async () => {
    setDirectories({});
    setExpanded(new Set());
    setSelectedPath(null);
    setPreview(null);
    setPreviewError(null);
    setChangedOnly(false);
    await loadDirectory(".");
  }, [loadDirectory]);

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

  async function toggleDirectory(entry: FileEntry) {
    const isOpen = expanded.has(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!isOpen && !directories[entry.path]) await loadDirectory(entry.path);
  }

  async function selectFile(entry: FileEntry) {
    setSelectedPath(entry.path);
    setPreview(null);
    setPreviewError(null);
    if (!entry.previewable) {
      setPreviewError(entry.blockedReason ?? "This item is not available in the text preview.");
      return;
    }
    setLoadingPreview(true);
    try {
      const query = new URLSearchParams({ scopePath: fileScopePath, path: entry.path });
      setPreview(await requestJson<FilePreview>(`/api/files/content?${query.toString()}`));
    } catch (previewLoadError) {
      setPreviewError(previewLoadError instanceof Error ? previewLoadError.message : "The file could not be previewed.");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function initializeFolderProject(entry: FileEntry) {
    if (!entry.canInitializeProject || initializingProjectPath) return;
    const projectPath = fileScopePath === "." ? entry.path : `${fileScopePath}/${entry.path}`;
    setInitializingProjectPath(entry.path);
    setProjectError(null);
    setProjectReceipt(null);
    try {
      const created = await requestJson<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ projectPath }),
      });
      setDirectories((current) => Object.fromEntries(
        Object.entries(current).map(([path, entries]) => [
          path,
          entries.map((candidate) => candidate.path === entry.path
            ? { ...candidate, canInitializeProject: false }
            : candidate),
        ]),
      ));
      setInitializedProjectPaths((current) => new Set(current).add(entry.path));
      setProjectReceipt(created);
      onProjectCreated(created);
    } catch (projectInitError) {
      setProjectError(projectInitError instanceof Error ? projectInitError.message : "The project could not be started.");
    } finally {
      setInitializingProjectPath(null);
    }
  }

  const selectedEntry = Object.values(directories).flat().find((entry) => entry.path === selectedPath) ?? null;
  const totalChanges = Object.values(git.counts).reduce((total, count) => total + (count ?? 0), 0);

  function renderDirectory(path: string, depth = 0): React.ReactNode {
    const entries = directories[path] ?? [];
    const visibleEntries = changedOnly ? entries.filter((entry) => entry.gitStatus) : entries;
    if (visibleEntries.length === 0 && path === ".") {
      return <div className="file-tree-empty">{changedOnly ? "No changed files in this scope." : "This scope has no visible files."}</div>;
    }
    return visibleEntries.map((entry) => {
      const isDirectory = entry.kind === "directory";
      const isOpen = isDirectory && expanded.has(entry.path);
      const status = entry.gitStatus ? FILE_STATUS_COPY[entry.gitStatus] : null;
      return (
        <div className="file-tree-branch" key={entry.path} role="none">
          <div className="file-tree-row">
            <button
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={isDirectory ? isOpen : undefined}
              aria-selected={!isDirectory && selectedPath === entry.path}
              className={`file-tree-entry ${selectedPath === entry.path ? "selected" : ""} kind-${entry.kind}`}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
              onClick={() => isDirectory ? void toggleDirectory(entry) : void selectFile(entry)}
              title={entry.blockedReason ?? entry.path}
            >
              <span className="file-tree-toggle" aria-hidden="true">{isDirectory ? (isOpen ? "▾" : "▸") : ""}</span>
              {isDirectory ? (
                <span className="file-kind folder" aria-hidden="true">DIR</span>
              ) : (
                <span className="file-kind" data-language={entry.language?.id ?? "text"} aria-hidden="true">{entry.language?.short ?? "—"}</span>
              )}
              <span className="file-tree-name">{entry.name}</span>
              {status && <span className={`file-git-status status-${entry.gitStatus}`} title={status.label}>{status.short}</span>}
            </button>
            {entry.canInitializeProject && (
              <button
                type="button"
                className="file-project-start"
                disabled={initializingProjectPath !== null}
                aria-label={`Start a Work project in ${entry.name}`}
                title={`Create ${entry.path}/.work and start a project here`}
                onClick={() => void initializeFolderProject(entry)}
              >
                {initializingProjectPath === entry.path ? "Starting…" : "+ Project"}
              </button>
            )}
            {initializedProjectPaths.has(entry.path) && (
              <span className="file-project-ready" title="This folder is now a Work project">Project</span>
            )}
          </div>
          {isDirectory && isOpen && (
            <div role="group">
              {loadingDirectories.has(entry.path)
                ? <div className="file-tree-loading" style={{ paddingLeft: `${44 + depth * 16}px` }}>Loading…</div>
                : renderDirectory(entry.path, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <section className="files-view" aria-labelledby="files-heading">
      <header className="files-toolbar">
        <div>
          <p className="eyebrow">Read-only source reference</p>
          <h1 id="files-heading">{scopeLabel} files</h1>
          <p>{git.available
            ? `${totalChanges} changed file${totalChanges === 1 ? "" : "s"} in this Git scope. Browse without editing source files, or start a Work project in an unmarked folder.`
            : "Browse without editing source files, or start a Work project in an unmarked folder. Git markers appear when the selected scope is inside a repository."}</p>
        </div>
        <div className="files-toolbar-actions">
          {fileScopes.length > 1 && (
            <label className="file-scope-picker">
              <span>Checkout</span>
              <select value={fileScopePath} onChange={(event) => setFileScopePath(event.target.value)} aria-label="Checkout or linked worktree">
                {fileScopes.map((scope) => <option value={scope.path} key={scope.path}>{scope.label}</option>)}
              </select>
            </label>
          )}
          <button type="button" className={changedOnly ? "selected" : ""} disabled={!git.available} onClick={() => setChangedOnly((shown) => !shown)}>
            {changedOnly ? "Show all files" : "Changed only"}
          </button>
          <button type="button" onClick={() => void refreshFiles()}>Refresh</button>
        </div>
      </header>

      {(error || projectError) && <p className="file-error" role="alert">{error ?? projectError}</p>}

      <div className="files-workspace">
        <aside className="file-tree-panel" aria-label={`Files in ${scopeLabel}`}>
          <div className="file-tree-heading">
            <div><strong>Explorer</strong><small>{fileScopePath === "." ? "Workspace root" : fileScopePath}</small></div>
            {git.available && <span title={`${totalChanges} changed files`}>{totalChanges}</span>}
          </div>
          <div className="file-tree" role="tree" aria-label="Read-only file tree">
            {loadingDirectories.has(".") && !directories["."]
              ? <div className="file-tree-empty">Loading files…</div>
              : renderDirectory(".")}
          </div>
          {projectReceipt && (
            <div className="file-project-receipt" role="status">
              <strong>{projectReceipt.name}</strong>
              <span>Project started in {projectReceipt.path}</span>
            </div>
          )}
          <div className="file-tree-legend" aria-label="Git change legend">
            <span><i className="status-added">A</i> Added</span>
            <span><i className="status-modified">M</i> Modified</span>
            <span><i className="status-untracked">?</i> Untracked</span>
            <span><i className="status-deleted">D</i> Deleted</span>
          </div>
        </aside>

        <article className="file-preview" aria-label={selectedPath ? `Preview ${selectedPath}` : "File preview"}>
          {loadingPreview ? (
            <div className="file-preview-empty"><span aria-hidden="true">…</span><strong>Loading preview</strong></div>
          ) : preview ? (
            <>
              <header className="file-preview-heading">
                <div>
                  <span className="file-kind" data-language={preview.language.id} aria-hidden="true">{preview.language.short}</span>
                  <span><strong>{preview.name}</strong><small>{preview.path}</small></span>
                </div>
                <div className="file-preview-meta">
                  {preview.gitStatus && <span className={`file-git-pill status-${preview.gitStatus}`}>{FILE_STATUS_COPY[preview.gitStatus].label}</span>}
                  <span>{preview.language.label}</span>
                  <span>{formatFileSize(preview.size)}</span>
                  <strong>Read only</strong>
                </div>
              </header>
              {preview.truncated && <p className="file-preview-notice">Preview limited to the first 256 KB.</p>}
              <div className="file-code" role="region" aria-label={`${preview.name} source`} tabIndex={0}>
                {preview.content.split("\n").map((line, index) => (
                  <span className="file-code-line" key={`${index}-${line.length}`}>
                    <i aria-hidden="true">{index + 1}</i><code>{line || " "}</code>
                  </span>
                ))}
              </div>
            </>
          ) : previewError ? (
            <div className="file-preview-empty unavailable"><span aria-hidden="true">×</span><strong>Preview unavailable</strong><p>{previewError}</p><small>{selectedEntry?.path}</small></div>
          ) : (
            <div className="file-preview-empty"><span aria-hidden="true">⌘</span><strong>Select a file</strong><p>Choose a text file to inspect it here. Work will not edit or save source files.</p></div>
          )}
        </article>
      </div>
    </section>
  );
}

function IssuesView({
  scopeLabel,
  scopePath,
  scopeKind,
  issues,
  projects,
  selectedIssueId,
  saving,
  error,
  onSelect,
  onCreate,
  onReply,
  onSetState,
  onSetDelegated,
}: {
  scopeLabel: string;
  scopePath: string;
  scopeKind: "root" | "group" | "project";
  issues: Issue[];
  projects: Project[];
  selectedIssueId: string | null;
  saving: boolean;
  error: string | null;
  onSelect: (issueId: string) => void;
  onCreate: (body: string) => Promise<Issue>;
  onReply: (issueId: string, body: string) => Promise<Issue>;
  onSetState: (issueId: string, state: "queued" | "closed") => Promise<Issue>;
  onSetDelegated: (issueId: string, delegated: boolean) => Promise<Issue>;
}) {
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId) ?? null;
  const stateNote = selectedIssue ? ISSUE_STATE_NOTES[selectedIssue.state] : undefined;
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setReply("");
  }, [selectedIssue?.id]);

  const filteredIssues = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return issues;
    return issues.filter((issue) => [
      issue.title,
      issue.body,
      issue.claimedBy?.name ?? "",
      ...issue.messages.map((message) => message.body),
    ].join(" ").toLowerCase().includes(query));
  }, [issues, search]);

  function issueLocation(issue: Issue) {
    return scopeLabelFor(projects, issue.projectPath, issue.scopePath === "." ? "Workspace" : `Folder · ${issue.scopePath}`);
  }

  async function submitIssue(event?: FormEvent) {
    event?.preventDefault();
    const body = draft;
    if (!body.trim() || saving) return;
    await onCreate(body);
    setDraft("");
  }

  async function submitReply(event?: FormEvent) {
    event?.preventDefault();
    if (!selectedIssue || !reply.trim() || saving) return;
    await onReply(selectedIssue.id, reply);
    setReply("");
  }

  function submitOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>, action: () => Promise<void>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void action().catch(() => {});
    }
  }

  const exactScope = scopeKind === "root"
    ? `${scopeLabel} workspace · ${scopePath}`
    : `${scopeKind === "project" ? "Project" : "Folder"}: ${scopeLabel} · ${scopePath}`;

  return (
    <section className="issues-view" aria-labelledby="issues-heading">
      <header className="issues-toolbar">
        <div>
          <p className="eyebrow">A durable conversation beside the work</p>
          <h1 id="issues-heading">{scopeLabel} issues</h1>
          <p>Write what is wrong, unclear, or worth investigating. No title or categorization required.</p>
        </div>
      </header>

      <form className="issue-composer" onSubmit={(event) => void submitIssue(event).catch(() => {})}>
        <label htmlFor="new-issue-body">
          <strong>File an issue</strong>
          <span>Markdown supported · Enter adds a new line</span>
        </label>
        <textarea
          id="new-issue-body"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => submitOnShortcut(event, () => submitIssue())}
          placeholder="Describe it however it comes to you…"
          aria-describedby="issue-scope issue-submit-hint"
        />
        <footer>
          <span id="issue-scope"><strong>Exact scope:</strong> {exactScope}</span>
          <div>
            <span id="issue-submit-hint"><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>
            <button type="submit" className="primary-action" disabled={saving || !draft.trim()}>
              {saving ? "Submitting…" : "Submit issue"}
            </button>
          </div>
        </footer>
      </form>

      {error && <p className="note-error" role="alert">{error}</p>}

      <div className="issues-workspace">
        <aside className="issue-list-panel" aria-label="Issues in this scope">
          <div className="notes-list-heading">
            <div><strong>Issues</strong><small>{issues.length} in this scope</small></div>
            <span className="count-badge" aria-hidden="true">{issues.length}</span>
          </div>
          <label className="notes-search">
            <span className="sr-only">Find an issue</span>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an issue…" />
          </label>
          {filteredIssues.length === 0 ? (
            <div className="notes-list-empty">
              <strong>{issues.length === 0 ? "No issues yet." : "No issues match."}</strong>
              <span>{issues.length === 0 ? "Use the free-form box above whenever something needs investigation." : "Try a different search."}</span>
            </div>
          ) : (
            <div className="issue-list" role="listbox" aria-label="Select an issue">
              {filteredIssues.map((issue) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={issue.id === selectedIssue?.id}
                  className={issue.id === selectedIssue?.id ? "selected" : ""}
                  key={issue.id}
                  onClick={() => onSelect(issue.id)}
                >
                  <span className="issue-list-title"><strong>{issue.title}</strong></span>
                  <span className={`issue-state state-${issue.state}`}>{ISSUE_STATE_LABELS[issue.state]}</span>
                  {issue.delegated && <span className="card-delegated">agent</span>}
                  <small>{issueLocation(issue)} · {shortTime(issue.updatedAt)}</small>
                </button>
              ))}
            </div>
          )}
        </aside>

        <article className="issue-thread" aria-label={selectedIssue ? `Issue conversation: ${selectedIssue.title}` : "Issue conversation"}>
          {selectedIssue ? (
            <>
              <header className="issue-thread-heading">
                <div>
                  <span className={`issue-state state-${selectedIssue.state}`}>{ISSUE_STATE_LABELS[selectedIssue.state]}</span>
                  <h2>{selectedIssue.title}</h2>
                  <small>{issueLocation(selectedIssue)} · Opened {new Date(selectedIssue.createdAt).toLocaleString()}</small>
                </div>
                <div className="issue-state-actions">
                  {(selectedIssue.state === "resolved" || selectedIssue.state === "closed") && (
                    <button type="button" className="secondary-action" disabled={saving} onClick={() => void onSetState(selectedIssue.id, "queued").catch(() => {})}>Reopen</button>
                  )}
                  {selectedIssue.state !== "closed" && (
                    <ConfirmAction
                      key={selectedIssue.id}
                      label="Close issue"
                      triggerClassName="issue-close-action"
                      message="Close this issue?"
                      confirmLabel="Close"
                      busy={saving}
                      disabled={saving}
                      confirmClassName="issue-close-confirm"
                      onConfirm={() => void onSetState(selectedIssue.id, "closed").catch(() => {})}
                    />
                  )}
                </div>
              </header>

              <label className="field-delegate issue-delegate">
                <input
                  type="checkbox"
                  checked={selectedIssue.delegated}
                  disabled={saving}
                  onChange={(event) => void onSetDelegated(selectedIssue.id, event.target.checked).catch(() => {})}
                />
                <span><strong>Hand to an agent</strong><small>An agent runner picks up delegated items on its next pass.</small></span>
              </label>

              {stateNote && (
                <div className={`issue-state-note ${stateNote.className}`}>
                  <strong>{stateNote.title(selectedIssue)}</strong>
                  {stateNote.body(selectedIssue)}
                </div>
              )}

              <ol className="issue-messages" aria-label="Issue conversation">
                <li className="issue-message human">
                  <header><strong>You</strong><time dateTime={selectedIssue.createdAt}>{new Date(selectedIssue.createdAt).toLocaleString()}</time></header>
                  <Markdown>{selectedIssue.body}</Markdown>
                </li>
                {selectedIssue.messages.map((message) => (
                  <li className={`issue-message ${message.author.kind}`} key={message.id}>
                    <header>
                      <strong>{message.author.kind === "human" ? "You" : message.author.name || "Agent"}</strong>
                      <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
                    </header>
                    <Markdown>{message.body}</Markdown>
                  </li>
                ))}
              </ol>

              <details className="issue-history">
                <summary>
                  <strong>State history</strong>
                  <span>{selectedIssue.stateHistory.length} changes</span>
                </summary>
                <ol>
                  {selectedIssue.stateHistory.map((change, index) => (
                    <li key={`${change.at}-${index}`}>
                      <header>
                        <strong>
                          {change.from
                            ? `${ISSUE_STATE_LABELS[change.from]} → ${ISSUE_STATE_LABELS[change.to]}`
                            : ISSUE_STATE_LABELS[change.to]}
                        </strong>
                        <time dateTime={change.at}>{new Date(change.at).toLocaleString()}</time>
                      </header>
                      <small>{change.actor.kind === "human" ? "You" : change.actor.name || "Agent"}</small>
                      {change.reason && <Markdown>{change.reason}</Markdown>}
                      {change.resolutionSummary && (
                        <div className="issue-history-resolution">
                          <strong>Resolution</strong>
                          <Markdown>{change.resolutionSummary}</Markdown>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </details>

              <form className="issue-reply" onSubmit={(event) => void submitReply(event).catch(() => {})}>
                <label htmlFor={`issue-reply-${selectedIssue.id}`}>
                  <strong>Reply</strong>
                  {selectedIssue.state === "needs_human" && <span>Replying returns this issue to Queued so work can continue.</span>}
                  {(selectedIssue.state === "resolved" || selectedIssue.state === "closed") && <span>Replying automatically reopens this issue and returns it to Queued.</span>}
                </label>
                <textarea
                  id={`issue-reply-${selectedIssue.id}`}
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => submitOnShortcut(event, () => submitReply())}
                  placeholder="Add context, answer questions, or say what still is not right…"
                />
                <footer>
                  <span>Markdown supported · <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>
                  <button type="submit" className="primary-action" disabled={saving || !reply.trim()}>
                    {saving
                      ? "Submitting…"
                      : selectedIssue.state === "needs_human"
                        ? "Reply and return to queue"
                        : selectedIssue.state === "resolved" || selectedIssue.state === "closed"
                          ? "Reply and reopen"
                          : "Reply"}
                  </button>
                </footer>
              </form>
              <p className="issue-authority-note">Only you can close this issue. An agent may resolve it, but cannot delete, lock, or prevent a reply.</p>
            </>
          ) : (
            <div className="note-editor-empty">
              <span aria-hidden="true">⌁</span>
              <strong>{issues.length === 0 ? "File the first issue" : "Select an issue"}</strong>
              <p>{issues.length === 0 ? "A plain description is enough. Work derives the title and keeps the conversation together." : "Choose one to read or continue its conversation."}</p>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function NotesView({
  scopeLabel,
  scopeKind,
  notes,
  projects,
  selectedNoteId,
  creating,
  error,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
}: {
  scopeLabel: string;
  scopeKind: "root" | "group" | "project";
  notes: ProjectNote[];
  projects: Project[];
  selectedNoteId: string | null;
  creating: boolean;
  error: string | null;
  onSelect: (noteId: string) => void;
  onCreate: () => Promise<ProjectNote>;
  onUpdate: (noteId: string, patch: { title?: string; text?: string }) => Promise<ProjectNote>;
  onDelete: (noteId: string) => Promise<void>;
}) {
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null;
  const [search, setSearch] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "editing" | "saving" | "saved" | "error">("idle");
  const [deleting, setDeleting] = useState(false);
  const revisionRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);

  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return notes;
    return notes.filter((note) => `${note.title} ${note.text}`.toLowerCase().includes(query));
  }, [notes, search]);

  useEffect(() => {
    revisionRef.current += 1;
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    setDraftTitle(selectedNote?.title ?? "");
    setDraftText(selectedNote?.text ?? "");
    setDirty(false);
    setSaveState(selectedNote ? "saved" : "idle");
  }, [selectedNote?.id]);

  async function persistDraft() {
    if (!selectedNote || !dirty) return true;
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const revision = revisionRef.current;
    setSaveState("saving");
    try {
      await onUpdate(selectedNote.id, {
        title: draftTitle.trim() || "Untitled note",
        text: draftText,
      });
      if (revisionRef.current === revision) {
        // The response confirms persistence and refreshes note metadata in the
        // parent. Replacing the controlled inputs here can clobber a keystroke
        // that lands between the browser's key and input events.
        setDirty(false);
        setSaveState("saved");
      }
      return true;
    } catch {
      if (revisionRef.current === revision) setSaveState("error");
      return false;
    }
  }

  useEffect(() => {
    if (!selectedNote || !dirty) return;
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistDraft();
    }, 700);
    return () => {
      if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
  }, [draftTitle, draftText, dirty, selectedNote?.id]);

  function changeTitle(value: string) {
    revisionRef.current += 1;
    setDraftTitle(value);
    setDirty(true);
    setSaveState("editing");
  }

  function changeText(value: string) {
    revisionRef.current += 1;
    setDraftText(value);
    setDirty(true);
    setSaveState("editing");
  }

  async function selectNote(noteId: string) {
    if (noteId === selectedNote?.id) return;
    if (!(await persistDraft())) return;
    onSelect(noteId);
  }

  async function createNote() {
    if (!(await persistDraft())) return;
    try {
      await onCreate();
    } catch {
      setSaveState("error");
    }
  }

  async function removeNote() {
    if (!selectedNote || deleting) return;
    revisionRef.current += 1;
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    setDirty(false);
    setDeleting(true);
    try {
      await onDelete(selectedNote.id);
    } catch {
      setSaveState("error");
    } finally {
      setDeleting(false);
    }
  }

  function noteLocation(note: ProjectNote) {
    return scopeLabelFor(
      projects,
      note.projectPath,
      note.scopePath === "." ? "Workspace note" : `${displaySegment(pathParts(note.scopePath).at(-1) ?? note.scopePath)} note`,
    );
  }

  const saveLabel = saveState === "saving"
    ? "Saving…"
    : saveState === "editing"
      ? "Unsaved changes"
      : saveState === "error"
        ? "Not saved"
        : selectedNote
          ? `Saved ${shortTime(selectedNote.updatedAt)}`
          : "";

  return (
    <section className="notes-view" aria-labelledby="notes-heading">
      <header className="notes-toolbar">
        <div>
          <p className="eyebrow">{scopeKind === "project" ? "Project notebook" : scopeKind === "root" ? "Workspace notebook" : "Folder notebook"}</p>
          <h1 id="notes-heading">{scopeLabel} notes</h1>
          <p>Plain-text working notes kept beside the project. Human notes stay protected; agent-created notes show who contributed them.</p>
        </div>
        <button type="button" className="primary-action" disabled={creating} onClick={() => void createNote()}>
          {creating ? "Creating…" : "New note"}<span aria-hidden="true">＋</span>
        </button>
      </header>

      {error && <p className="note-error" role="alert">{error}</p>}

      <div className="notes-workspace">
        <aside className="notes-list-panel" aria-label="Notes in this scope">
          <div className="notes-list-heading">
            <div><strong>Notes</strong><small>{notes.length} in this scope</small></div>
            <span className="count-badge" aria-hidden="true">{notes.length}</span>
          </div>
          <label className="notes-search">
            <span className="sr-only">Find a note</span>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a note…" />
          </label>
          {filteredNotes.length === 0 ? (
            <div className="notes-list-empty">
              <strong>{notes.length === 0 ? "No notes yet." : "No notes match."}</strong>
              <span>{notes.length === 0 ? "Create one whenever a thought needs more room than the inbox." : "Try a different search."}</span>
            </div>
          ) : (
            <div className="notes-list" role="listbox" aria-label="Select a note">
              {filteredNotes.map((note) => {
                const preview = note.text.split("\n").find((line) => line.trim())?.trim() || "Empty note";
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={note.id === selectedNote?.id}
                    className={note.id === selectedNote?.id ? "selected" : ""}
                    key={note.id}
                    onClick={() => void selectNote(note.id)}
                  >
                    <span className="note-list-title">
                      <strong>{note.title}</strong>
                      {note.createdBy.kind === "agent" && <em>Added by {note.createdBy.name}</em>}
                    </span>
                    <span className="note-list-preview">{preview}</span>
                    <small>{noteLocation(note)} · {shortTime(note.updatedAt)}</small>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        <article className="note-editor" aria-label={selectedNote ? `Edit note: ${selectedNote.title}` : "Note editor"}>
          {selectedNote ? (
            <>
              <div className="note-editor-heading">
                <label>
                  <span className="sr-only">Note title</span>
                  <input
                    type="text"
                    value={draftTitle}
                    maxLength={300}
                    onChange={(event) => changeTitle(event.target.value)}
                    onBlur={() => void persistDraft()}
                    placeholder="Untitled note"
                    aria-label="Note title"
                  />
                </label>
                <span>{noteLocation(selectedNote)}{selectedNote.createdBy.kind === "agent" ? ` · Agent: ${selectedNote.createdBy.name}` : " · Human note"}</span>
              </div>
              <label className="note-body-field">
                <span className="sr-only">Note text</span>
                <textarea
                  value={draftText}
                  onChange={(event) => changeText(event.target.value)}
                  onBlur={() => void persistDraft()}
                  placeholder="Write whatever you need to remember…"
                  aria-label="Note text"
                  spellCheck="true"
                />
              </label>
              <footer className="note-editor-footer">
                <span className={`note-save-state state-${saveState}`} role="status" aria-live="polite">{saveLabel}</span>
                <div className="note-editor-actions">
                  <ConfirmAction
                    key={selectedNote.id}
                    label="Delete note"
                    triggerClassName="note-delete"
                    message="Delete this note?"
                    confirmLabel="Delete"
                    busyLabel="Deleting…"
                    busy={deleting}
                    confirmClassName="note-delete-confirm"
                    onConfirm={() => void removeNote()}
                  />
                  <button type="button" className="secondary-action note-save-button" disabled={!dirty || saveState === "saving"} onClick={() => void persistDraft()}>Save now</button>
                </div>
              </footer>
            </>
          ) : (
            <div className="note-editor-empty">
              <span aria-hidden="true">≡</span>
              <strong>{notes.length === 0 ? "Start a note" : "Select a note"}</strong>
              <p>{notes.length === 0 ? "Notes are for thoughts that need room to grow. They stay as plain text and live with this scope." : "Choose one from the list to read or continue writing."}</p>
              {notes.length === 0 && <button type="button" className="primary-action" disabled={creating} onClick={() => void createNote()}>New note</button>}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    backlog: "Backlog",
    ready: "Ready",
    in_progress: "In flight",
    blocked: "Blocked",
    review: "Review",
    done: "Completed",
    cancelled: "Cancelled",
    archived: "Archived",
  };
  return labels[status] ?? displaySegment(status);
}

function checklistProgress(task: WorkTask) {
  const items = [...task.requirements, ...task.acceptanceCriteria];
  const complete = items.filter((item) => item.checked).length;
  return { complete, total: items.length };
}

function UpcomingSchedule({ items, projects, onOpenTask }: {
  items: ScheduledItem[];
  projects: Project[];
  onOpenTask: (id: string) => void;
}) {
  return (
    <section id="upcoming" className="upcoming-section" aria-labelledby="upcoming-heading">
      <div className="section-heading compact">
        <div><p className="eyebrow">Dates across this scope</p><h2 id="upcoming-heading">Upcoming</h2></div>
        <span className="count-badge" aria-label={`${items.length} scheduled items`}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="upcoming-empty"><strong>Nothing scheduled here.</strong><span>Due dates and revisit dates will appear automatically.</span></div>
      ) : (
        <ol className="upcoming-list" aria-label="Upcoming scheduled dates">
          {items.map((item) => {
            const tone = scheduleTone(item);
            const content = (
              <>
                <time className={`upcoming-date ${tone}`} dateTime={item.scheduledAt}>
                  <strong>{scheduleLabel(item)}</strong>
                  <span>{scheduleDateDetail(item)}</span>
                </time>
                <span className="upcoming-copy">
                  <small><i>{item.kind}</i>{scopeLabelFor(projects, item.projectPath, "Unassigned")}</small>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </span>
                {item.kind !== "decision" && <span className="upcoming-open" aria-hidden="true">→</span>}
              </>
            );
            if (item.kind === "decision") return <li key={item.key}><article className="upcoming-item">{content}</article></li>;
            return (
              <li key={item.key}>
                <button
                  type="button"
                  className="upcoming-item"
                  onClick={() => onOpenTask(item.id)}
                  aria-label={`Open ${item.kind}: ${item.title}`}
                >
                  {content}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function TaskListView({ scopeLabel, tasks, statuses, showTerminal, onToggleTerminal, onMove, onOpenTask, onCreate, error }: {
  scopeLabel: string;
  tasks: WorkTask[];
  statuses: string[];
  showTerminal: boolean;
  onToggleTerminal: () => void;
  onMove: (id: string, status: string) => void;
  onOpenTask: (id: string) => void;
  onCreate: () => void;
  error: string | null;
}) {
  const order = [...statuses, "cancelled", "archived"];
  const visible = tasks
    .filter((task) => showTerminal || !["cancelled", "archived"].includes(task.status))
    .sort((left, right) => order.indexOf(left.status) - order.indexOf(right.status) || (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999") || (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return (
    <section className="board-view task-list-view" aria-labelledby="board-heading">
      <div className="board-toolbar">
        <div>
          <p className="eyebrow">A plain list · full lifecycle</p>
          <h1 id="board-heading">{scopeLabel} tasks</h1>
          <p>{visible.length} work items. Select one for full details.</p>
        </div>
        <div className="board-actions">
          <button type="button" className="secondary-action" onClick={onToggleTerminal}>{showTerminal ? "Hide cancelled & archived" : "Show cancelled & archived"}</button>
          <button type="button" className="primary-action" onClick={onCreate}>New work item</button>
        </div>
      </div>
      {error && <div className="task-error" role="alert">{error}</div>}
      {visible.length === 0 ? (
        <div className="board-empty">
          <strong>No work items in this scope yet.</strong>
          <span>Create one here, promote an Inbox thought, or type `/work task: …`.</span>
          <button type="button" className="primary-action" onClick={onCreate}>Create the first item</button>
        </div>
      ) : (
        <ol className="task-list" aria-label="Tasks in this project">
          {visible.map((task) => (
            <li key={task.id}>
              <button type="button" className="task-list-title" onClick={() => onOpenTask(task.id)} aria-label={`Open ${task.id}: ${task.title}`}>
                <strong>{task.title}</strong>
                <small>{task.id}{task.delegated ? " · handed to an agent" : ""}</small>
              </button>
              <label className="task-list-status">
                <span className="sr-only">Status for {task.id}</span>
                <select value={task.status} onChange={(event) => onMove(task.id, event.target.value)}>
                  {order.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                </select>
              </label>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function KanbanBoard({
  scopeLabel,
  tasks,
  statuses,
  projects,
  decisions,
  search,
  onSearch,
  showTerminal,
  onToggleTerminal,
  draggingTaskId,
  onDragStart,
  onDragEnd,
  onMove,
  onOpenTask,
  onCreate,
  error,
}: {
  scopeLabel: string;
  tasks: WorkTask[];
  statuses: string[];
  projects: Project[];
  decisions: Decision[];
  search: string;
  onSearch: (value: string) => void;
  showTerminal: boolean;
  onToggleTerminal: () => void;
  draggingTaskId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onMove: (id: string, status: string) => void;
  onOpenTask: (id: string) => void;
  onCreate: () => void;
  error: string | null;
}) {
  const boardStatuses = showTerminal ? [...statuses, "cancelled", "archived"] : statuses;
  const query = search.trim().toLowerCase();
  const filtered = tasks.filter((task) => !query || [task.id, task.title, task.projectPath ?? "", ...task.tags].join(" ").toLowerCase().includes(query));
  const activeCount = filtered.filter((task) => ["in_progress", "blocked", "review"].includes(task.status)).length;
  const doneCount = filtered.filter((task) => task.status === "done").length;

  return (
    <section className="board-view" aria-labelledby="board-heading">
      <div className="board-toolbar">
        <div>
          <p className="eyebrow">Present state · full lifecycle</p>
          <h1 id="board-heading">{scopeLabel} board</h1>
          <p>{filtered.length}{query ? ` of ${tasks.length}` : ""} work items · {activeCount} in flight · {doneCount} completed <span className="board-detail-hint">Select a card for full details.</span></p>
        </div>
        <div className="board-actions">
          <button type="button" className="secondary-action" onClick={onToggleTerminal}>{showTerminal ? "Hide cancelled & archived" : "Show cancelled & archived"}</button>
          <button type="button" className="primary-action" onClick={onCreate}>New work item</button>
        </div>
      </div>
      <div className="board-filters" aria-label="Board filters">
        <label className="board-search">
          <span className="sr-only">Search work items</span>
          <input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search title, ID, project, or tag…" />
        </label>
      </div>
      {error && <div className="task-error" role="alert">{error}</div>}
      {tasks.length === 0 ? (
        <div className="board-empty">
          <strong>No work items in this scope yet.</strong>
          <span>Create a full card here, promote an Inbox thought, or type `/work task: …`.</span>
          <button type="button" className="primary-action" onClick={onCreate}>Create the first card</button>
        </div>
      ) : (
        <div className="kanban-scroll" aria-label="Kanban board">
          <div className="kanban-grid" style={{ gridTemplateColumns: `repeat(${boardStatuses.length}, minmax(${showTerminal ? 168 : 150}px, 1fr))` }}>
            {boardStatuses.map((status) => {
              const columnTasks = filtered.filter((task) => task.status === status);
              return (
                <section
                  className={`kanban-column status-${status} ${draggingTaskId ? "drag-active" : ""}`}
                  key={status}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggingTaskId) onMove(draggingTaskId, status);
                    onDragEnd();
                  }}
                  aria-labelledby={`column-${status}`}
                >
                  <header><h2 id={`column-${status}`}>{statusLabel(status)}</h2><span>{columnTasks.length}</span></header>
                  <div className="kanban-card-list">
                    {columnTasks.map((task) => {
                      const progress = checklistProgress(task);
                      const projectName = scopeLabelFor(projects, task.projectPath, "Unassigned");
                      const descriptionLine = task.sections.description.split("\n").find((line) => line.trim()) ?? "";
                      const questionCount = decisions.filter((decision) => decisionIsActive(decision) && decision.refs.includes(task.id)).length;
                      const hoverSummary = [
                        `${task.id} · ${statusLabel(task.status)}`,
                        task.title,
                        descriptionLine || null,
                        `Project: ${projectName}`,
                        task.delegated ? "Handed to an agent" : null,
                        task.dependsOn.length > 0 || task.blockedBy.length > 0
                          ? `${task.dependsOn.length} dependencies · ${task.blockedBy.length} blockers`
                          : null,
                        task.blockedReason ? `Blocked: ${task.blockedReason}` : null,
                        task.dueAt ? scheduleLabel({ scheduledAt: task.dueAt, allDay: true }, "Due") : null,
                        "Select for full details.",
                      ].filter(Boolean).join("\n");
                      return (
                        <button
                          type="button"
                          className="kanban-card"
                          key={task.id}
                          title={hoverSummary}
                          aria-label={`Open ${task.id}: ${task.title}`}
                          draggable
                          onDragStart={() => onDragStart(task.id)}
                          onDragEnd={onDragEnd}
                          onClick={() => onOpenTask(task.id)}
                        >
                          <span className="card-topline"><strong>{task.id}</strong>{task.delegated && <span className="card-delegated">agent</span>}</span>
                          <span className="card-title">{task.title}</span>
                          {descriptionLine && <span className="card-description">{descriptionLine}</span>}
                          {questionCount > 0 && <span className="card-questions">{questionCount} open {questionCount === 1 ? "question" : "questions"}</span>}
                          <span className="card-project">{projectName}</span>
                          {task.dueAt && (
                            <time className={`card-due ${scheduleTone({ scheduledAt: task.dueAt, allDay: true })}`} dateTime={task.dueAt}>
                              <span aria-hidden="true">◷</span>{scheduleLabel({ scheduledAt: task.dueAt, allDay: true }, "Due")}
                            </time>
                          )}
                          {task.tags.length > 0 && <span className="card-tags">{task.tags.slice(0, 4).map((tag) => <i key={tag}>{tag}</i>)}</span>}
                          {(task.dependsOn.length > 0 || task.blockedBy.length > 0) && <span className="card-links">{task.dependsOn.length} dependencies · {task.blockedBy.length} blockers</span>}
                          {progress.total > 0 && <span className="card-progress"><span><i style={{ width: `${(progress.complete / progress.total) * 100}%` }} /></span>{progress.complete}/{progress.total}</span>}
                          {task.blockedReason && <span className="card-blocked">Blocked: {task.blockedReason}</span>}
                          <span className="card-updated">Updated {shortTime(task.updatedAt)}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function ActivityView({ scopeLabel, tasks, projects, onOpenTask }: { scopeLabel: string; tasks: WorkTask[]; projects: Project[]; onOpenTask: (id: string) => void }) {
  const events = tasks
    .flatMap((task) => task.log.map((entry) => ({ ...entry, task })))
    .sort((a, b) => b.at.localeCompare(a.at));
  return (
    <section className="activity-view" aria-labelledby="activity-heading">
      <div className="board-toolbar">
        <div><p className="eyebrow">What was added, changed, and completed</p><h1 id="activity-heading">{scopeLabel} activity</h1><p>{events.length} durable progress entries from Markdown work items.</p></div>
      </div>
      {events.length === 0 ? (
        <div className="empty-panel"><strong>No task activity yet.</strong><span>Creating, moving, editing, and checking work items appends here automatically.</span></div>
      ) : (
        <ol className="activity-list">
          {events.map((event, index) => (
            <li key={`${event.task.id}-${event.at}-${index}`}>
              <time dateTime={event.at}>{new Date(event.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
              <button type="button" onClick={() => onOpenTask(event.task.id)}><strong>{event.task.id} · {event.task.title}</strong><span>{event.message}</span><small>{scopeLabelFor(projects, event.task.projectPath, "Unassigned")} · {statusLabel(event.task.status)}</small></button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type TaskFieldValues = {
  projectPath: string;
  delegated: boolean;
  tags: string;
  parentId: string;
  dueAt: string;
};

function commaList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

// The eye-level fields shared by the create and detail panels. `children`
// renders the one panel-specific field (Status when creating).
function TaskFields({ projects, values, onChange, children }: {
  projects: Project[];
  values: TaskFieldValues;
  onChange: (patch: Partial<TaskFieldValues>) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="field-grid">
        <label><span>Project</span><select value={values.projectPath} onChange={(event) => onChange({ projectPath: event.target.value })}><option value="">Unassigned</option>{projects.filter((project) => project.path !== ".").map((project) => <option key={project.id} value={project.path}>{project.name} — {project.path}</option>)}</select></label>
        {children}
      </div>
      <label className="field-delegate"><input type="checkbox" checked={values.delegated} onChange={(event) => onChange({ delegated: event.target.checked })} /><span><strong>Hand to an agent</strong><small>An agent runner picks up delegated items on its next pass.</small></span></label>
    </>
  );
}

// Rarely-touched fields sit behind the one "More details" disclosure, shared
// by both panels. `children` renders extra panel-specific fields inside it.
function TaskMoreFields({ values, onChange, children }: {
  values: TaskFieldValues;
  onChange: (patch: Partial<TaskFieldValues>) => void;
  children?: ReactNode;
}) {
  return (
    <details className="task-more-fields">
      <summary>More details</summary>
      <div className="field-grid">
        <label><span>Due date</span><input type="date" value={values.dueAt} onChange={(event) => onChange({ dueAt: event.target.value })} /></label>
        <label><span>Parent task ID</span><input value={values.parentId} onChange={(event) => onChange({ parentId: event.target.value })} placeholder="W-0001" /></label>
      </div>
      <label className="field-wide"><span>Tags</span><input value={values.tags} onChange={(event) => onChange({ tags: event.target.value })} placeholder="Comma-separated" /></label>
      {children}
    </details>
  );
}

function CreateTaskPanel({ projects, statuses, defaultProjectPath, saving, error, onClose, onCreate }: {
  projects: Project[];
  statuses: string[];
  defaultProjectPath: string | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (input: Record<string, unknown>) => void;
}) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState(statuses[0] ?? "backlog");
  const [fields, setFields] = useState<TaskFieldValues>({
    projectPath: defaultProjectPath ?? "",
    delegated: false,
    tags: "",
    parentId: "",
    dueAt: "",
  });
  const [description, setDescription] = useState("");
  const [goal, setGoal] = useState("");
  const [requirements, setRequirements] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [plan, setPlan] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      projectPath: fields.projectPath || null,
      status,
      delegated: fields.delegated,
      tags: commaList(fields.tags),
      parentId: fields.parentId.trim() || null,
      dueAt: fields.dueAt || null,
      description,
      goal,
      requirements: requirements.split("\n").map((item) => item.trim()).filter(Boolean),
      acceptanceCriteria: acceptance.split("\n").map((item) => item.trim()).filter(Boolean),
      plan,
    });
  }

  return (
    <aside className="task-panel create-task-panel" aria-labelledby="create-task-heading">
      {/* The heading asks the question the title answers, so the panel spends
          its space on the prompt instead of on a label, a placeholder, and a
          title that all say the same thing. */}
      <div className="task-panel-header"><div><p className="eyebrow">New work item</p><h2 id="create-task-heading">What outcome or task needs tracking?</h2></div><button type="button" onClick={onClose} aria-label="Close new work item">×</button></div>
      <form onSubmit={submit} className="task-form">
        <label className="field-wide"><span className="sr-only">Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Name it in a few words" autoFocus /></label>
        <TaskFields projects={projects} values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}>
          <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}>{statuses.map((item) => <option key={item} value={item}>{statusLabel(item)}</option>)}</select></label>
        </TaskFields>
        <label className="field-wide"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Background and context — what is this, and what is the situation?" /></label>
        <label className="field-wide"><span>Goal</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="The discrete outcome — what does done accomplish?" /></label>
        <label className="field-wide"><span>Requirements · one per line</span><textarea value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder={"Must preserve Markdown\nMust remain root-scoped"} /></label>
        <label className="field-wide"><span>Acceptance criteria · one per line</span><textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder={"Board reflects status\nRestart restores the card"} /></label>
        <label className="field-wide"><span>Plan</span><textarea value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="How to get there — known steps or research shape" /></label>
        <TaskMoreFields values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))} />
        {error && <div className="task-error" role="alert">{error}</div>}
        <div className="task-panel-actions"><button type="button" className="secondary-action" onClick={onClose}>Cancel</button><button type="submit" className="primary-action" disabled={!title.trim() || saving}>{saving ? "Creating…" : "Create work item"}</button></div>
      </form>
    </aside>
  );
}

function TaskDetailPanel({ task, tasks, projects, statuses, saving, error, openQuestions, onClose, onMove, onPatch, onToggle, onLog }: {
  task: WorkTask;
  tasks: WorkTask[];
  projects: Project[];
  statuses: string[];
  saving: boolean;
  error: string | null;
  openQuestions?: ReactNode;
  onClose: () => void;
  onMove: (status: string, note?: string) => void;
  onPatch: (patch: Record<string, unknown>) => void;
  onToggle: (section: "requirements" | "acceptance", index: number, checked: boolean) => void;
  onLog: (message: string) => Promise<void>;
}) {
  const taskFieldValues = (): TaskFieldValues => ({
    projectPath: task.projectPath ?? "",
    delegated: task.delegated,
    tags: task.tags.join(", "),
    parentId: task.parentId ?? "",
    dueAt: task.dueAt?.slice(0, 10) ?? "",
  });
  const [title, setTitle] = useState(task.title);
  const [fields, setFields] = useState<TaskFieldValues>(taskFieldValues);
  const [dependsOn, setDependsOn] = useState(task.dependsOn.join(", "));
  const [blockedBy, setBlockedBy] = useState(task.blockedBy.join(", "));
  const [blockedReason, setBlockedReason] = useState(task.blockedReason ?? "");
  const [description, setDescription] = useState(task.sections.description);
  const [goal, setGoal] = useState(task.sections.goal);
  const [plan, setPlan] = useState(task.sections.plan);
  const [notes, setNotes] = useState(task.sections.notes);
  const [completionSummary, setCompletionSummary] = useState(task.sections.completionSummary);
  const [newRequirement, setNewRequirement] = useState("");
  const [newAcceptance, setNewAcceptance] = useState("");
  const [logMessage, setLogMessage] = useState("");

  useEffect(() => {
    setTitle(task.title);
    setFields(taskFieldValues());
    setDependsOn(task.dependsOn.join(", ")); setBlockedBy(task.blockedBy.join(", ")); setBlockedReason(task.blockedReason ?? "");
    setDescription(task.sections.description); setGoal(task.sections.goal); setPlan(task.sections.plan); setNotes(task.sections.notes);
    setCompletionSummary(task.sections.completionSummary);
  }, [task.id, task.updatedAt]);

  function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onPatch({ title, projectPath: fields.projectPath || null, delegated: fields.delegated, tags: commaList(fields.tags), dependsOn: commaList(dependsOn), blockedBy: commaList(blockedBy), blockedReason: blockedReason.trim() || null, parentId: fields.parentId.trim() || null, dueAt: fields.dueAt || null, description, goal, plan, notes, completionSummary });
  }

  const childTasks = tasks.filter((item) => item.parentId === task.id);
  const progress = checklistProgress(task);

  return (
    <aside className="task-panel" aria-labelledby="task-detail-heading">
      <div className="task-panel-header"><div><p className="eyebrow">{task.id}{task.delegated ? " · handed to an agent" : ""}</p><h2 id="task-detail-heading">{task.title}</h2></div><div className="task-panel-header-actions"><button type="button" onClick={onClose} aria-label="Close work item">×</button></div></div>
      <div className="task-state-strip"><label><span>Status</span><select value={task.status} onChange={(event) => onMove(event.target.value)} disabled={saving}>{[...statuses, "cancelled", "archived"].map((status) => <option key={status} value={status} disabled={status === "review" && progress.complete < progress.total}>{status === "review" && progress.complete < progress.total ? "Review — complete checklist first" : statusLabel(status)}</option>)}</select></label><span>{progress.complete}/{progress.total} checks complete</span><span>Updated {shortTime(task.updatedAt)}</span></div>
      {task.status === "review" && progress.complete < progress.total && <div className="task-error" role="status">This legacy review card has unchecked requirements or acceptance criteria. Verify its checklist before treating it as review-ready.</div>}
      {error && <div className="task-error" role="alert">{error}</div>}
      {openQuestions}
      <form className="task-form" onSubmit={saveDetails}>
        <label className="field-wide"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <TaskFields projects={projects} values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))} />
        <label className="field-wide"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Background and context — what is this, and what is the situation?" /></label>
        <label className="field-wide"><span>Goal</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="The discrete outcome — what does done accomplish?" /></label>
        <label className="field-wide"><span>Plan</span><textarea value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="How to get there — known steps or research shape" /></label>
        <TaskMoreFields values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}>
          <label className="field-wide"><span>Depends on task IDs</span><input value={dependsOn} onChange={(event) => setDependsOn(event.target.value)} placeholder="W-0001, W-0002" /></label>
          <label className="field-wide"><span>Blocked by task IDs</span><input value={blockedBy} onChange={(event) => setBlockedBy(event.target.value)} placeholder="W-0001" /></label>
          <label className="field-wide"><span>Blocker explanation</span><textarea value={blockedReason} onChange={(event) => setBlockedReason(event.target.value)} /></label>
          <label className="field-wide"><span>Notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          <label className="field-wide"><span>Completion summary</span><textarea value={completionSummary} onChange={(event) => setCompletionSummary(event.target.value)} placeholder="What shipped, changed, or was learned?" /></label>
        </TaskMoreFields>
        <button type="submit" className="primary-action" disabled={saving}>{saving ? "Saving…" : "Save card details"}</button>
      </form>

      <TaskChecklist title="Requirements" items={task.requirements} onToggle={(index, checked) => onToggle("requirements", index, checked)} />
      <form className="add-check" onSubmit={(event) => { event.preventDefault(); if (!newRequirement.trim()) return; onPatch({ requirements: [...task.requirements, { checked: false, text: newRequirement.trim() }] }); setNewRequirement(""); }}><input value={newRequirement} onChange={(event) => setNewRequirement(event.target.value)} placeholder="Add requirement…" /><button type="submit">Add</button></form>
      <TaskChecklist title="Acceptance criteria" items={task.acceptanceCriteria} onToggle={(index, checked) => onToggle("acceptance", index, checked)} />
      <form className="add-check" onSubmit={(event) => { event.preventDefault(); if (!newAcceptance.trim()) return; onPatch({ acceptanceCriteria: [...task.acceptanceCriteria, { checked: false, text: newAcceptance.trim() }] }); setNewAcceptance(""); }}><input value={newAcceptance} onChange={(event) => setNewAcceptance(event.target.value)} placeholder="Add acceptance criterion…" /><button type="submit">Add</button></form>

      {childTasks.length > 0 && <section className="task-subsection"><h3>Child work</h3><ul>{childTasks.map((child) => <li key={child.id}><strong>{child.id}</strong> {child.title} <span>{statusLabel(child.status)}</span></li>)}</ul></section>}
      <section className="task-subsection"><h3>Lifecycle</h3><ul><li>Created: {new Date(task.createdAt).toLocaleString()}</li>{task.startedAt && <li>Started: {new Date(task.startedAt).toLocaleString()}</li>}{task.completedAt && <li>Completed: {new Date(task.completedAt).toLocaleString()}</li>}{task.cancelledAt && <li>Cancelled: {new Date(task.cancelledAt).toLocaleString()}</li>}{task.dueAt && <li>Due: {new Date(task.dueAt).toLocaleDateString()}</li>}{task.source && <li>Source: {task.source}</li>}</ul></section>
      <section className="task-subsection"><h3>Progress log</h3>{task.log.length === 0 ? <p>No entries yet.</p> : <ol className="task-log">{[...task.log].reverse().map((entry, index) => <li key={`${entry.at}-${index}`}><time dateTime={entry.at}>{new Date(entry.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time><span>{entry.message}</span></li>)}</ol>}</section>
      <form className="add-log" onSubmit={(event) => { event.preventDefault(); if (!logMessage.trim()) return; void onLog(logMessage.trim()).then(() => setLogMessage("")); }}><label><span>Add progress</span><textarea value={logMessage} onChange={(event) => setLogMessage(event.target.value)} placeholder="What was done, learned, changed, or blocked?" /></label><button type="submit" className="primary-action" disabled={!logMessage.trim()}>Append to log</button></form>
    </aside>
  );
}

function TaskChecklist({ title, items, onToggle }: { title: string; items: ChecklistItem[]; onToggle: (index: number, checked: boolean) => void }) {
  return (
    <section className="task-subsection"><h3>{title}</h3>{items.length === 0 ? <p>None recorded.</p> : <ul className="task-checklist">{items.map((item, index) => <li key={`${item.text}-${index}`}><label><input type="checkbox" checked={item.checked} onChange={(event) => onToggle(index, event.target.checked)} /><span>{item.text}</span></label></li>)}</ul>}</section>
  );
}
