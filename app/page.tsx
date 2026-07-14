"use client";

import {
  FormEvent,
  KeyboardEvent,
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
  agentIntent: "reference_only" | "review_requested";
  createdAt: string;
  updatedAt: string;
};

type IdeaStatus = "open" | "exploring" | "deferred" | "proposed" | "adopted" | "declined";

type ProjectIdea = {
  id: string;
  title: string;
  status: IdeaStatus;
  scopePath: string;
  projectPath: string | null;
  tags: string[];
  source: string | null;
  revisitAt: string | null;
  agentIntent: "consideration_only" | "evaluation_requested";
  history: Array<{ from: IdeaStatus; to: IdeaStatus; reason: string | null; at: string }>;
  createdAt: string;
  updatedAt: string;
  sections: {
    opportunity: string;
    whyItMightMatter: string;
    hypothesis: string;
    unknowns: string;
    potentialShape: string;
    evidence: string;
    risksAndConstraints: string;
    nextEvaluation: string;
    outcome: string;
  };
};

type GitFileStatus = "conflict" | "deleted" | "added" | "untracked" | "modified" | "renamed";

type FileEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  language: { id: string; label: string; short: string } | null;
  gitStatus: GitFileStatus | null;
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
  options: string[];
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
  type: "task" | "bug" | "feature" | "research" | "admin" | "epic" | "idea";
  assignee: string | null;
  agents: string[];
  priority: "critical" | "high" | "medium" | "low" | "none";
  tags: string[];
  dependsOn: string[];
  blockedBy: string[];
  blockedReason: string | null;
  parentId: string | null;
  dueAt: string | null;
  estimate: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  sections: {
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
  kind: "task" | "idea" | "decision";
  title: string;
  projectPath: string | null;
  scheduledAt: string;
  allDay: boolean;
  detail: string;
};

type AppView = "home" | "board" | "ideas" | "notes" | "files" | "activity";
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
  ideas: ProjectIdea[];
  notes: ProjectNote[];
  tasks: WorkTask[];
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
  workspaces?: WorkspaceSummary[];
};

type WorkspaceRemovalReceipt = WorkspaceDirectory & {
  removedWorkspaceId: string;
};

type DecisionDraft = {
  action: Exclude<DecisionAction, "reopen"> | "";
  projectPath: string;
  deferFor: "today" | "tomorrow" | "week";
};

type CaptureReceipt = {
  capture: Capture;
  destination: string;
};

type DecisionReceipt = {
  decisionId: string;
  message: string;
};

type ServiceRestartReceipt = {
  restarting: true;
  serviceInstanceId: string;
};

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

type ServiceUpdateReceipt = {
  updating: true;
  installedVersion: string;
  serviceInstanceId: string;
};

const emptyDraft: DecisionDraft = {
  action: "",
  projectPath: "",
  deferFor: "week",
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
  const [systemMenuOpen, setSystemMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [workspacePickerError, setWorkspacePickerError] = useState<string | null>(null);
  const [workspaceRemovalTarget, setWorkspaceRemovalTarget] = useState<string | null>(null);
  const [removingWorkspace, setRemovingWorkspace] = useState<string | null>(null);
  const [restartArmed, setRestartArmed] = useState(false);
  const [restartingService, setRestartingService] = useState(false);
  const [serviceRestartError, setServiceRestartError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<ServiceUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateArmed, setUpdateArmed] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [expandedDecision, setExpandedDecision] = useState<string | null>(null);
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, DecisionDraft>>({});
  const [savingDecision, setSavingDecision] = useState<string | null>(null);
  const [decisionReceipt, setDecisionReceipt] = useState<DecisionReceipt | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [creatingNote, setCreatingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [selectedIdeaId, setSelectedIdeaId] = useState<string | null>(null);
  const [creatingIdea, setCreatingIdea] = useState(false);
  const [savingIdea, setSavingIdea] = useState(false);
  const [ideaError, setIdeaError] = useState<string | null>(null);
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
      if (!status.updateAvailable) setUpdateArmed(false);
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
    setSelectedIdeaId(null);
    setSelectedTaskId(null);
    setScopePath(".");
    setView("home");
    setData(null);
    await loadWorkspace();
  }

  async function updateProjectPurpose(projectPath: string, description: string) {
    const project = await requestJson<Project>("/api/projects/profile", {
      method: "PATCH",
      body: JSON.stringify({ projectPath, description }),
    });
    setData((current) => current ? {
      ...current,
      projects: current.projects.map((item) => item.path === project.path ? project : item),
    } : current);
    return project;
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
      setSelectedIdeaId(null);
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
      const receipt = await requestJson<WorkspaceRemovalReceipt>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
        headers: { "x-work-unregister": "confirm" },
      });
      setWorkspaceDirectory({
        defaultWorkspaceId: receipt.defaultWorkspaceId,
        activeWorkspaceId: receipt.activeWorkspaceId,
        workspaces: receipt.workspaces,
      });
      setWorkspaceRemovalTarget(null);
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
      const accepted = await requestJson<ServiceRestartReceipt>("/api/service/restart", {
        method: "POST",
        headers: { "x-work-restart": "confirm" },
        body: JSON.stringify({ confirm: true }),
      });
      await waitForServiceRestart(accepted.serviceInstanceId);
      await loadWorkspace();
      setRestartArmed(false);
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
      const accepted = await requestJson<ServiceUpdateReceipt>("/api/service/update", {
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
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, []);

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

  const scopedIdeas = useMemo(() => {
    return (data?.ideas ?? [])
      .filter((idea) => scopePath === "." || pathContains(idea.scopePath, scopePath) || pathContains(idea.projectPath, scopePath))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [data, scopePath]);

  useEffect(() => {
    if (view !== "ideas") return;
    if (selectedIdeaId && scopedIdeas.some((idea) => idea.id === selectedIdeaId)) return;
    setSelectedIdeaId(scopedIdeas[0]?.id ?? null);
  }, [view, selectedIdeaId, scopedIdeas]);

  const scopedTasks = useMemo(() => {
    return (data?.tasks ?? [])
      .filter((task) => scopePath === "." || pathContains(task.projectPath, scopePath))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [data, scopePath]);

  const selectedTask = selectedTaskId
    ? (data?.tasks ?? []).find((task) => task.id === selectedTaskId) ?? null
    : null;

  const activeDecisions = useMemo(() => {
    return (data?.decisions ?? [])
      .filter(decisionIsActive)
      .filter((decision) => scopePath === "." || pathContains(decision.projectPath, scopePath))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [data, scopePath]);
  const visibleDecisions = activeDecisions.slice(0, 3);

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
    const ideas: ScheduledItem[] = scopedIdeas
      .filter((idea) => idea.revisitAt && !["adopted", "declined"].includes(idea.status))
      .map((idea) => ({
        key: `idea:${idea.id}`,
        id: idea.id,
        kind: "idea",
        title: idea.title,
        projectPath: idea.projectPath,
        scheduledAt: idea.revisitAt as string,
        allDay: true,
        detail: idea.status === "deferred" ? "Idea · Not now" : `Idea · ${displaySegment(idea.status)}`,
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
    return [...tasks, ...ideas, ...decisions]
      .filter((item) => !Number.isNaN(scheduleDate(item).valueOf()))
      .sort((left, right) => scheduleDate(left).getTime() - scheduleDate(right).getTime());
  }, [data?.decisions, scopedIdeas, scopedTasks, scopePath]);

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

  function findNavigationTarget(text: string) {
    const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return data?.projects.find((project) => {
      const name = project.name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      const path = project.path.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      return normalized.includes(name) || normalized.includes(path);
    });
  }

  function replaceTask(task: WorkTask) {
    setData((current) => current ? {
      ...current,
      tasks: [task, ...(current.tasks ?? []).filter((item) => item.id !== task.id)],
    } : current);
  }

  function replaceNote(note: ProjectNote) {
    setData((current) => current ? {
      ...current,
      notes: [note, ...(current.notes ?? []).filter((item) => item.id !== note.id)],
    } : current);
  }

  function replaceIdea(idea: ProjectIdea) {
    setData((current) => current ? {
      ...current,
      ideas: [idea, ...(current.ideas ?? []).filter((item) => item.id !== idea.id)],
    } : current);
  }

  async function createProjectIdea(input: { title?: string; opportunity?: string; tags?: string[]; source?: string | null } = {}) {
    setCreatingIdea(true);
    setIdeaError(null);
    try {
      const idea = await requestJson<ProjectIdea>("/api/ideas", {
        method: "POST",
        body: JSON.stringify({
          title: input.title ?? "Untitled idea",
          opportunity: input.opportunity ?? "",
          scopePath,
          projectPath: selectedProject?.path ?? null,
          tags: input.tags ?? [],
          source: input.source ?? null,
        }),
      });
      replaceIdea(idea);
      setSelectedIdeaId(idea.id);
      setView("ideas");
      return idea;
    } catch (error) {
      setIdeaError(error instanceof Error ? error.message : "The idea could not be created.");
      throw error;
    } finally {
      setCreatingIdea(false);
    }
  }

  async function updateProjectIdea(ideaId: string, patch: Record<string, unknown>) {
    setSavingIdea(true);
    setIdeaError(null);
    try {
      const idea = await requestJson<ProjectIdea>(`/api/ideas/${encodeURIComponent(ideaId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      replaceIdea(idea);
      return idea;
    } catch (error) {
      setIdeaError(error instanceof Error ? error.message : "The idea could not be saved.");
      throw error;
    } finally {
      setSavingIdea(false);
    }
  }

  async function deleteProjectIdea(ideaId: string) {
    setIdeaError(null);
    try {
      await requestJson<{ ok: boolean }>(`/api/ideas/${encodeURIComponent(ideaId)}`, { method: "DELETE" });
      setData((current) => current ? {
        ...current,
        ideas: (current.ideas ?? []).filter((item) => item.id !== ideaId),
      } : current);
      setSelectedIdeaId((current) => current === ideaId ? null : current);
    } catch (error) {
      setIdeaError(error instanceof Error ? error.message : "The idea could not be deleted.");
      throw error;
    }
  }

  async function scopeIdeaAsWork(idea: ProjectIdea) {
    return createWorkTask({
      title: idea.title,
      projectPath: idea.projectPath,
      status: "backlog",
      type: "epic",
      source: idea.id,
      goal: [idea.sections.opportunity, idea.sections.whyItMightMatter].filter(Boolean).join("\n\n"),
      notes: [
        idea.sections.hypothesis && `Hypothesis\n${idea.sections.hypothesis}`,
        idea.sections.potentialShape && `Potential shape\n${idea.sections.potentialShape}`,
        idea.sections.risksAndConstraints && `Risks and constraints\n${idea.sections.risksAndConstraints}`,
      ].filter(Boolean).join("\n\n"),
    });
  }

  async function createProjectNote() {
    setCreatingNote(true);
    setNoteError(null);
    try {
      const note = await requestJson<ProjectNote>("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          title: "Untitled note",
          text: "",
          scopePath,
          projectPath: selectedProject?.path ?? null,
          agentIntent: "reference_only",
        }),
      });
      replaceNote(note);
      setSelectedNoteId(note.id);
      setView("notes");
      return note;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The note could not be created.";
      setNoteError(message);
      throw error;
    } finally {
      setCreatingNote(false);
    }
  }

  async function updateProjectNote(noteId: string, patch: { title?: string; text?: string; agentIntent?: ProjectNote["agentIntent"] }) {
    setNoteError(null);
    try {
      const note = await requestJson<ProjectNote>(`/api/notes/${encodeURIComponent(noteId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      replaceNote(note);
      return note;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The note could not be saved.";
      setNoteError(message);
      throw error;
    }
  }

  async function deleteProjectNote(noteId: string) {
    setNoteError(null);
    try {
      await requestJson<{ ok: boolean }>(`/api/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
      setData((current) => current ? {
        ...current,
        notes: (current.notes ?? []).filter((item) => item.id !== noteId),
      } : current);
      setSelectedNoteId((current) => current === noteId ? null : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The note could not be deleted.";
      setNoteError(message);
      throw error;
    }
  }

  async function createWorkTask(input: Record<string, unknown>, open = true) {
    setSavingTask(true);
    setTaskError(null);
    try {
      const task = await requestJson<WorkTask>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      });
      replaceTask(task);
      setCreatingTask(false);
      if (open) {
        setView("board");
        setSelectedTaskId(task.id);
      }
      return task;
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "The work item could not be created.");
      throw error;
    } finally {
      setSavingTask(false);
    }
  }

  async function moveWorkTask(taskId: string, status: string, note?: string) {
    setSavingTask(true);
    setTaskError(null);
    try {
      const task = await requestJson<WorkTask>(`/api/tasks/${encodeURIComponent(taskId)}/move`, {
        method: "POST",
        body: JSON.stringify({ status, note }),
      });
      replaceTask(task);
      return task;
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "The card could not be moved.");
      throw error;
    } finally {
      setSavingTask(false);
    }
  }

  async function patchWorkTask(taskId: string, patch: Record<string, unknown>) {
    setSavingTask(true);
    setTaskError(null);
    try {
      const task = await requestJson<WorkTask>(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      replaceTask(task);
      return task;
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "The work item could not be updated.");
      throw error;
    } finally {
      setSavingTask(false);
    }
  }

  async function toggleWorkChecklist(taskId: string, section: "requirements" | "acceptance", index: number, checked: boolean) {
    setTaskError(null);
    try {
      const task = await requestJson<WorkTask>(`/api/tasks/${encodeURIComponent(taskId)}/checklist`, {
        method: "POST",
        body: JSON.stringify({ section, index, checked }),
      });
      replaceTask(task);
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "The checklist could not be updated.");
    }
  }

  async function logWorkProgress(taskId: string, message: string) {
    setTaskError(null);
    try {
      const task = await requestJson<WorkTask>(`/api/tasks/${encodeURIComponent(taskId)}/log`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      replaceTask(task);
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "The progress entry could not be saved.");
      throw error;
    }
  }

  async function promoteCaptureToTask(capture: Capture) {
    const firstLine = capture.text.split("\n").find((line) => line.trim())?.trim() ?? capture.text;
    const title = firstLine.length > 500 ? `${firstLine.slice(0, 497)}…` : firstLine;
    await createWorkTask({
      title,
      projectPath: capture.projectPath,
      status: "backlog",
      type: capture.kind === "question" ? "research" : "idea",
      source: capture.id,
      notes: capture.text.includes("\n")
        ? `Promoted from capture ${capture.id}.\n\n${capture.text}`
        : `Promoted from capture ${capture.id}.`,
    });
  }

  async function promoteCaptureToIdea(capture: Capture) {
    const firstLine = capture.text.split("\n").find((line) => line.trim())?.trim() ?? capture.text;
    const title = firstLine.length > 500 ? `${firstLine.slice(0, 497)}…` : firstLine;
    await createProjectIdea({
      title,
      opportunity: capture.text,
      tags: capture.kind === "idea" ? [] : [capture.kind],
      source: capture.id,
    });
  }

  async function runCommand() {
    const text = cleanCommand(command);
    if (!text) {
      setCaptureError("Write anything you want remembered. No formatting needed.");
      inputRef.current?.focus();
      return;
    }

    const lower = text.toLowerCase();
    const isMultiline = text.includes("\n");
    const taskCommand = isMultiline ? null : text.match(/^(?:task|todo)\s*:?\s+(.+)$/i);
    if (taskCommand) {
      try {
        await createWorkTask({
          title: taskCommand[1].trim(),
          projectPath: selectedProject?.path ?? null,
          status: "backlog",
          type: "task",
        });
        setCommand("");
        window.requestAnimationFrame(() => inputRef.current?.focus());
      } catch {
        setCaptureError("Task not created — check the board message and try again.");
      }
      return;
    }
    const navigationTarget = findNavigationTarget(text);
    if (!isMultiline && /\b(show|focus|open|take me to)\b/.test(lower)) {
      if (/\b(board|kanban)\b/.test(lower)) {
        setView("board");
        setCommand("");
        return;
      }
      if (/\b(notes?|notebook)\b/.test(lower)) {
        setView("notes");
        setCommand("");
        return;
      }
      if (/\b(ideas?|possibilities)\b/.test(lower)) {
        setView("ideas");
        setCommand("");
        return;
      }
      if (/\b(activity|history|log)\b/.test(lower)) {
        setView("activity");
        setCommand("");
        return;
      }
      if (/\b(everything|all work|this root|root)\b/.test(lower)) {
        navigate(".");
        setCommand("");
        return;
      }
      if (navigationTarget) {
        navigate(navigationTarget.path);
        setCommand("");
        return;
      }
      if (/\binbox\b/.test(lower)) {
        openHomeSection("inbox");
        setCommand("");
        return;
      }
      if (/\b(needs you|decisions?)\b/.test(lower)) {
        openHomeSection("needs-you");
        setCommand("");
        return;
      }
    }

    setSavingCapture(true);
    setCaptureError(null);
    try {
      const response = await requestJson<Capture | { capture: Capture }>("/api/captures", {
        method: "POST",
        body: JSON.stringify({
          text,
          scopePath,
          projectPath: selectedProject?.path ?? null,
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

    setSavingDecision(decision.id);
    try {
      const response = await requestJson<Decision | { decision: Decision }>(
        `/api/decisions/${encodeURIComponent(decision.id)}/actions`,
        {
          method: "POST",
          body: JSON.stringify({ action: draft.action, choice }),
        },
      );
      const updated = "decision" in response ? response.decision : response;
      setData((current) => current ? {
        ...current,
        decisions: current.decisions.map((item) => item.id === updated.id ? updated : item),
      } : current);
      const assignedProject = draft.action === "assign"
        ? data?.projects.find((project) => project.path === draft.projectPath)?.name
        : null;
      const labels: Record<Exclude<DecisionAction, "reopen">, string> = {
        approve: "Approved as proposed",
        reject: "Rejected",
        defer: `Deferred until ${new Date(choice?.until as string).toLocaleDateString([], { month: "short", day: "numeric" })}`,
        cancel: "Cancelled and retained in history",
        assign: `Assigned to ${assignedProject ?? draft.projectPath}`,
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

  const destination = destinationForCurrentScope();
  const rootProject = data.projects.find((project) => project.path === ".");

  return (
    <div className="app-shell">
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
          <button type="button" className={view === "ideas" ? "selected" : ""} onClick={() => setView("ideas")}>Ideas</button>
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
              <div><p className="eyebrow">Only this root</p><strong>{data.workspace.name}</strong><small>{data.workspace.root}</small></div>
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
                {updateStatus?.updateAvailable && updateStatus.installable && !updateArmed && (
                  <button type="button" className="update-install" onClick={() => setUpdateArmed(true)} disabled={installingUpdate}>Install & restart</button>
                )}
                {updateStatus?.updateAvailable && updateStatus.installable && updateArmed && (
                  <div className="update-confirm">
                    <button type="button" onClick={() => setUpdateArmed(false)} disabled={installingUpdate}>Cancel</button>
                    <button type="button" className="primary-action" onClick={() => void installServiceUpdate()} disabled={installingUpdate}>{installingUpdate ? "Installing…" : `Install ${updateStatus.latestVersion}`}</button>
                  </div>
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
              {!restartArmed ? (
                <button type="button" onClick={() => { setRestartArmed(true); setServiceRestartError(null); }}>Restart Work</button>
              ) : (
                <div className="service-restart-confirm">
                  <span>Restart now?</span>
                  <button type="button" onClick={() => setRestartArmed(false)} disabled={restartingService}>Cancel</button>
                  <button type="button" className="danger-action" onClick={() => void restartLocalService()} disabled={restartingService}>
                    {restartingService ? "Restarting…" : "Confirm restart"}
                  </button>
                </div>
              )}
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
                const confirmingRemoval = workspaceRemovalTarget === workspace.id;
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
                    {!current && !confirmingRemoval && (
                      <button
                        type="button"
                        className="workspace-remove"
                        aria-label={`Remove ${workspace.name} from the workspace list`}
                        onClick={() => { setWorkspaceRemovalTarget(workspace.id); setWorkspacePickerError(null); }}
                      >
                        Remove
                      </button>
                    )}
                    {!current && confirmingRemoval && (
                      <div className="workspace-remove-confirm" role="alert">
                        <span>Remove from list? Files stay untouched.</span>
                        <button type="button" onClick={() => setWorkspaceRemovalTarget(null)} disabled={removingWorkspace === workspace.id}>Cancel</button>
                        <button type="button" className="danger-action" onClick={() => void removeWorkspace(workspace.id)} disabled={removingWorkspace === workspace.id}>
                          {removingWorkspace === workspace.id ? "Removing…" : "Confirm"}
                        </button>
                      </div>
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

      <main id="main-content" className="main-content">
        {view === "board" ? (
          <KanbanBoard
            scopeLabel={scopeLabel}
            tasks={scopedTasks}
            statuses={data.workspace.statuses ?? ["backlog", "ready", "in_progress", "blocked", "review", "done"]}
            projects={data.projects}
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
        ) : view === "ideas" ? (
          <IdeasView
            scopeLabel={scopeLabel}
            scopeKind={scopeKind}
            ideas={scopedIdeas}
            projects={data.projects}
            selectedIdeaId={selectedIdeaId}
            creating={creatingIdea}
            saving={savingIdea}
            error={ideaError}
            onSelect={setSelectedIdeaId}
            onCreate={createProjectIdea}
            onUpdate={updateProjectIdea}
            onDelete={deleteProjectIdea}
            onScopeWork={scopeIdeaAsWork}
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
          <FilesView key={scopePath} scopeLabel={scopeLabel} scopePath={scopePath} project={selectedProject} />
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
              onUpdatePurpose={updateProjectPurpose}
            />
          ) : (
            <ScopeOverview
              rootName={data.workspace.name}
              scopeLabel={scopeLabel}
              scopeKind={scopeKind}
              scopePath={scopePath}
              projectCount={visibleProjects.length + (scopePath === "." && rootProject ? 1 : 0)}
              captureCount={scopedCaptures.length}
              ideaCount={scopedIdeas.length}
              decisionCount={activeDecisions.length}
              taskCount={scopedTasks.length}
              inFlightCount={scopedTasks.filter((task) => ["in_progress", "blocked", "review"].includes(task.status)).length}
              doneCount={scopedTasks.filter((task) => task.status === "done").length}
              rootPath={data.workspace.root}
            />
          )}

          {(scopeKind !== "project" || childGroups.length > 0 || directProjects.length > 0) && (
            <div className="scope-grid-section">
              <div className="section-heading compact">
                <div><p className="eyebrow">Zoom in without leaving this root</p><h2 id="scope-heading">Projects and folders</h2></div>
                <span className="count-badge">{visibleProjects.length}</span>
              </div>
              {childGroups.length === 0 && directProjects.length === 0 ? (
                <div className="empty-panel"><strong>No marked projects found here.</strong><span>Add an empty `.project` file or `.project/` folder inside each project directory, then refresh.</span></div>
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
                </div>
              )}
            </div>
          )}
        </section>

        <UpcomingSchedule
          items={scheduledItems}
          projects={data.projects}
          onOpenTask={(taskId) => { setView("board"); setSelectedTaskId(taskId); }}
          onOpenIdea={(ideaId) => { setView("ideas"); setSelectedIdeaId(ideaId); }}
        />

        <div className="home-support-grid">
        <section id="needs-you" className="attention-section" aria-labelledby="needs-you-heading">
          <div className="section-heading">
            <div><p className="eyebrow">Choices, not dismissals</p><h2 id="needs-you-heading">Needs you</h2></div>
            <span className="count-badge" aria-label={`${activeDecisions.length} active decisions`}>{activeDecisions.length}</span>
          </div>

          {decisionReceipt && (
            <div className="decision-receipt" role="status">
              <span><strong>Recorded.</strong> {decisionReceipt.message}</span>
              <button type="button" onClick={() => void reopenDecision(decisionReceipt.decisionId)}>Undo</button>
            </div>
          )}

          {activeDecisions.length === 0 ? (
            <div className="empty-panel"><strong>Nothing needs a decision in this scope.</strong><span>Ordinary work stays out of this list.</span></div>
          ) : (
            <div className="attention-list">
              {visibleDecisions.map((decision) => {
                const open = expandedDecision === decision.id;
                const draft = draftFor(decision.id);
                const hasProposal = decision.options.some((option) => /approve|yes|accept/i.test(option));
                const canConfirm = Boolean(draft.action && (draft.action !== "assign" || draft.projectPath));
                return (
                  <article className={`attention-item ${open ? "open" : ""}`} key={decision.id}>
                    <button type="button" className="attention-summary" onClick={() => setExpandedDecision(open ? null : decision.id)} aria-expanded={open}>
                      <span className="attention-check" aria-hidden="true">?</span>
                      <span className="attention-copy">
                        <small>{decision.projectPath ? data.projects.find((project) => project.path === decision.projectPath)?.name ?? decision.projectPath : `${data.workspace.name} · Unassigned`}</small>
                        <strong>{decision.title}</strong>
                      </span>
                      <span className="review-label">{open ? "Close" : "Choose"}</span>
                    </button>

                    {open && (
                      <div className="decision-panel">
                        {decision.detail && <p className="decision-detail">{decision.detail}</p>}
                        <fieldset>
                          <legend>What should happen?</legend>
                          {hasProposal && (
                            <DecisionChoice decisionId={decision.id} action="approve" label="Approve the proposal" detail="Record a clear approval." draft={draft} onChange={updateDraft} />
                          )}
                          {hasProposal && (
                            <DecisionChoice decisionId={decision.id} action="reject" label="Reject the proposal" detail="Keep the reason in history instead of deleting it." draft={draft} onChange={updateDraft} />
                          )}
                          <DecisionChoice decisionId={decision.id} action="assign" label="Assign to a project" detail="Choose one project from this root." draft={draft} onChange={updateDraft} />
                          {draft.action === "assign" && (
                            <label className="inline-field">
                              <span>Project</span>
                              <select value={draft.projectPath} onChange={(event) => updateDraft(decision.id, { projectPath: event.target.value })}>
                                <option value="">Choose a project…</option>
                                {data.projects.filter((project) => project.path !== ".").map((project) => (
                                  <option value={project.path} key={project.id}>{project.name} — {project.path}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          <DecisionChoice decisionId={decision.id} action="keep_unassigned" label="Keep unassigned" detail="Make no ownership claim yet." draft={draft} onChange={updateDraft} />
                          <DecisionChoice decisionId={decision.id} action="defer" label="Decide later" detail="Return it to Needs you at a real time." draft={draft} onChange={updateDraft} />
                          {draft.action === "defer" && (
                            <label className="inline-field">
                              <span>Bring it back</span>
                              <select value={draft.deferFor} onChange={(event) => updateDraft(decision.id, { deferFor: event.target.value as DecisionDraft["deferFor"] })}>
                                <option value="today">Later today</option>
                                <option value="tomorrow">Tomorrow</option>
                                <option value="week">Next week</option>
                              </select>
                            </label>
                          )}
                          <DecisionChoice decisionId={decision.id} action="cancel" label="Cancel this item" detail="Retain a cancelled record; do not erase history." draft={draft} onChange={updateDraft} />
                        </fieldset>
                        <div className="decision-actions">
                          <button type="button" className="secondary-action" onClick={() => setExpandedDecision(null)}>Close without changes</button>
                          <button type="button" className="primary-action" disabled={!canConfirm || savingDecision === decision.id} onClick={() => void confirmDecision(decision)}>
                            {savingDecision === decision.id ? "Recording…" : "Confirm decision"}
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
              {activeDecisions.length > visibleDecisions.length && (
                <p className="more-decisions">{activeDecisions.length - visibleDecisions.length} more waiting safely in this scope. Finish or defer one to bring the next forward.</p>
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
                      <button type="button" className="capture-icon-action promote-idea" title="Develop this as an idea" onClick={() => void promoteCaptureToIdea(capture).catch(() => {})} aria-label={`Make idea from thought: ${capture.text}`}><span aria-hidden="true">◇</span></button>
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
          </>
        )}
      </main>

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
          onClose={() => { setSelectedTaskId(null); setTaskError(null); }}
          onMove={(status, note) => void moveWorkTask(selectedTask.id, status, note).catch(() => {})}
          onPatch={(patch) => void patchWorkTask(selectedTask.id, patch).catch(() => {})}
          onToggle={(section, index, checked) => void toggleWorkChecklist(selectedTask.id, section, index, checked)}
          onLog={(message) => logWorkProgress(selectedTask.id, message)}
        />
      )}

      <div className="capture-dock">
        {captureReceipt && (
          <div className="capture-receipt" role="status" aria-live="polite">
            <span className="receipt-check" aria-hidden="true">✓</span>
            <div><strong>Saved: “{captureReceipt.capture.text}”</strong><small>{captureReceipt.destination} · Available to agents in this root</small></div>
            <div className="receipt-actions">
              <button type="button" onClick={() => void promoteCaptureToIdea(captureReceipt.capture).catch(() => {})}>Make idea</button>
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
            <div><strong>Capture anything</strong><small>Going to {destination}</small></div>
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
            {captureError ?? `Exact destination: ${destination}. Project names in the thought never reroute it.`}
          </span>
          <div>
            <button type="button" onClick={() => openHomeSection("inbox")}>{scopedCaptures.length} in {selectedProject ? `${selectedProject.name} inbox` : scopePath === "." ? "root inbox" : `${scopeLabel} inbox`}</button>
            <span className="shortcut-hint"><kbd>/</kbd> focus</span>
            <span className="multiline-hint"><kbd>Shift</kbd> + <kbd>Enter</kbd> new line</span>
            <span>{lastSyncedAt ? `Synced ${shortTime(lastSyncedAt.toISOString())}` : "Connecting…"}</span>
          </div>
        </div>
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

function ScopeOverview({
  rootName,
  scopeLabel,
  scopeKind,
  scopePath,
  projectCount,
  captureCount,
  ideaCount,
  decisionCount,
  taskCount,
  inFlightCount,
  doneCount,
  rootPath,
}: {
  rootName: string;
  scopeLabel: string;
  scopeKind: "root" | "group" | "project";
  scopePath: string;
  projectCount: number;
  captureCount: number;
  ideaCount: number;
  decisionCount: number;
  taskCount: number;
  inFlightCount: number;
  doneCount: number;
  rootPath: string;
}) {
  return (
    <div className="portfolio-intro">
      <p className="continue-label"><span aria-hidden="true" /> {scopeKind === "root" ? "One root" : "Folder scope"}</p>
      <h1>{scopeKind === "root" ? `All in ${rootName}` : scopeLabel}</h1>
      <p>See the shape of this directory without pulling in unrelated work. Everything here stays under one filesystem boundary.</p>
      <p className="scope-path" title={scopeKind === "root" ? rootPath : `${rootPath}/${scopePath}`}>{scopeKind === "root" ? rootPath : scopePath}</p>
      <div className="portfolio-stats" aria-label="Scope summary">
        <span><strong>{projectCount}</strong> projects</span>
        <span><strong>{taskCount}</strong> work items</span>
        <span><strong>{inFlightCount}</strong> in flight</span>
        <span><strong>{doneCount}</strong> completed</span>
        <span><strong>{captureCount}</strong> captured</span>
        <span><strong>{ideaCount}</strong> ideas</span>
        <span><strong>{decisionCount}</strong> need you</span>
      </div>
    </div>
  );
}

function ProjectFocus({ project, captures, tasks, onOpenBoard, onOpenTask, onUpdatePurpose }: {
  project: Project;
  captures: Capture[];
  tasks: WorkTask[];
  onOpenBoard: () => void;
  onOpenTask: (taskId: string) => void;
  onUpdatePurpose: (projectPath: string, description: string) => Promise<Project>;
}) {
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
    setPurpose(project.description ?? "");
    setEditingPurpose(false);
    setPurposeError(null);
  }, [project.path, project.description]);

  async function savePurpose() {
    setSavingPurpose(true);
    setPurposeError(null);
    try {
      await onUpdatePurpose(project.path, purpose.trim());
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
          <h1>{project.name}</h1>
          <span className="pulse-path">{project.path}</span>
        </div>
        <button type="button" className="primary-action" onClick={onOpenBoard}>Open board<span aria-hidden="true">→</span></button>
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
          <p className={project.description ? "" : "project-purpose-empty"}>{project.description || "Add a short description so people and agents understand what this project is trying to make possible."}</p>
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
                    <span className="pulse-task-copy"><small>{task.id} · {task.priority}</small><strong>{task.title}</strong></span>
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

function FilesView({ scopeLabel, scopePath, project }: { scopeLabel: string; scopePath: string; project: Project | null }) {
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
          <button
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={isDirectory ? isOpen : undefined}
            aria-selected={!isDirectory && selectedPath === entry.path}
            className={`${selectedPath === entry.path ? "selected" : ""} kind-${entry.kind}`}
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
          <p className="eyebrow">Read-only project reference</p>
          <h1 id="files-heading">{scopeLabel} files</h1>
          <p>{git.available
            ? `${totalChanges} changed file${totalChanges === 1 ? "" : "s"} in this Git scope. Browse and inspect without changing the working tree.`
            : "Browse and inspect this scope without changing its files. Git markers appear when the selected scope is inside a repository."}</p>
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

      {error && <p className="file-error" role="alert">{error}</p>}

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

const IDEA_STATUS_OPTIONS: Array<{ value: IdeaStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "exploring", label: "Exploring" },
  { value: "deferred", label: "Not now" },
  { value: "proposed", label: "Proposed" },
  { value: "adopted", label: "Adopted" },
  { value: "declined", label: "Closed" },
];

function ideaStatusLabel(status: IdeaStatus) {
  return IDEA_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? displaySegment(status);
}

function IdeasView({
  scopeLabel,
  scopeKind,
  ideas,
  projects,
  selectedIdeaId,
  creating,
  saving,
  error,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  onScopeWork,
}: {
  scopeLabel: string;
  scopeKind: "root" | "group" | "project";
  ideas: ProjectIdea[];
  projects: Project[];
  selectedIdeaId: string | null;
  creating: boolean;
  saving: boolean;
  error: string | null;
  onSelect: (ideaId: string) => void;
  onCreate: (input?: { title?: string; opportunity?: string; tags?: string[]; source?: string | null }) => Promise<ProjectIdea>;
  onUpdate: (ideaId: string, patch: Record<string, unknown>) => Promise<ProjectIdea>;
  onDelete: (ideaId: string) => Promise<void>;
  onScopeWork: (idea: ProjectIdea) => Promise<WorkTask>;
}) {
  const selectedIdea = ideas.find((idea) => idea.id === selectedIdeaId) ?? null;
  const [search, setSearch] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    status: "open" as IdeaStatus,
    tags: "",
    revisitAt: "",
    reason: "",
    opportunity: "",
    whyItMightMatter: "",
    hypothesis: "",
    unknowns: "",
    potentialShape: "",
    evidence: "",
    risksAndConstraints: "",
    nextEvaluation: "",
    outcome: "",
  });

  useEffect(() => {
    setDraft({
      title: selectedIdea?.title ?? "",
      status: selectedIdea?.status ?? "open",
      tags: selectedIdea?.tags.join(", ") ?? "",
      revisitAt: selectedIdea?.revisitAt?.slice(0, 10) ?? "",
      reason: "",
      opportunity: selectedIdea?.sections.opportunity ?? "",
      whyItMightMatter: selectedIdea?.sections.whyItMightMatter ?? "",
      hypothesis: selectedIdea?.sections.hypothesis ?? "",
      unknowns: selectedIdea?.sections.unknowns ?? "",
      potentialShape: selectedIdea?.sections.potentialShape ?? "",
      evidence: selectedIdea?.sections.evidence ?? "",
      risksAndConstraints: selectedIdea?.sections.risksAndConstraints ?? "",
      nextEvaluation: selectedIdea?.sections.nextEvaluation ?? "",
      outcome: selectedIdea?.sections.outcome ?? "",
    });
    setDeleteArmed(false);
  }, [selectedIdea?.id, selectedIdea?.updatedAt]);

  const filteredIdeas = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return ideas;
    return ideas.filter((idea) => `${idea.title} ${idea.status} ${idea.tags.join(" ")} ${Object.values(idea.sections).join(" ")}`.toLowerCase().includes(query));
  }, [ideas, search]);

  function setField(field: keyof typeof draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function ideaLocation(idea: ProjectIdea) {
    if (!idea.projectPath) return idea.scopePath === "." ? "Workspace idea" : `${displaySegment(pathParts(idea.scopePath).at(-1) ?? idea.scopePath)} idea`;
    return projects.find((project) => project.path === idea.projectPath)?.name ?? idea.projectPath;
  }

  function draftPatch(status = draft.status, reason = draft.reason) {
    return {
      title: draft.title.trim() || "Untitled idea",
      status,
      reason,
      tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      revisitAt: draft.revisitAt || null,
      opportunity: draft.opportunity,
      whyItMightMatter: draft.whyItMightMatter,
      hypothesis: draft.hypothesis,
      unknowns: draft.unknowns,
      potentialShape: draft.potentialShape,
      evidence: draft.evidence,
      risksAndConstraints: draft.risksAndConstraints,
      nextEvaluation: draft.nextEvaluation,
      outcome: draft.outcome,
    };
  }

  async function saveIdea(event: FormEvent) {
    event.preventDefault();
    if (!selectedIdea) return;
    await onUpdate(selectedIdea.id, draftPatch());
  }

  async function toggleEvaluationRequest() {
    if (!selectedIdea) return;
    const requested = selectedIdea.agentIntent === "evaluation_requested";
    const shouldExplore = ["open", "deferred", "adopted", "declined"].includes(draft.status);
    const nextStatus = !requested && shouldExplore ? "exploring" : draft.status;
    const transitionReason = nextStatus !== draft.status
      ? (draft.status === "open" ? "Evaluation requested." : "Evaluation reopened.")
      : draft.reason;
    await onUpdate(selectedIdea.id, {
      ...draftPatch(nextStatus, transitionReason),
      ...(requested
        ? { agentIntent: "consideration_only" }
        : {
          agentIntent: "evaluation_requested",
        }),
    });
  }

  async function removeIdea() {
    if (!selectedIdea || deleting) return;
    setDeleting(true);
    try {
      await onDelete(selectedIdea.id);
      setDeleteArmed(false);
    } finally {
      setDeleting(false);
    }
  }

  const reasonNeeded = selectedIdea && draft.status !== selectedIdea.status && ["deferred", "declined"].includes(draft.status);
  const sectionFields: Array<{ key: keyof typeof draft; label: string; placeholder: string }> = [
    { key: "opportunity", label: "Opportunity", placeholder: "What might become possible?" },
    { key: "whyItMightMatter", label: "Why it might matter", placeholder: "Who benefits, and what improves?" },
    { key: "hypothesis", label: "Hypothesis", placeholder: "What do we believe could be true?" },
    { key: "unknowns", label: "Unknowns", placeholder: "Questions that need investigation." },
    { key: "potentialShape", label: "Potential shape", placeholder: "A possible approach, without committing to it." },
    { key: "evidence", label: "Evidence", placeholder: "Research, examples, experiments, or observations." },
    { key: "risksAndConstraints", label: "Risks and constraints", placeholder: "Security, cost, complexity, or boundary concerns." },
    { key: "nextEvaluation", label: "Next evaluation", placeholder: "What should we learn or discuss next?" },
    { key: "outcome", label: "Outcome", placeholder: "What did we conclude, and why?" },
  ];

  return (
    <section className="notes-view ideas-view" aria-labelledby="ideas-heading">
      <header className="notes-toolbar">
        <div>
          <p className="eyebrow">{scopeKind === "project" ? "Project possibilities" : "Possibilities worth keeping"}</p>
          <h1 id="ideas-heading">{scopeLabel} ideas</h1>
          <p>Explore value and feasibility without authorizing implementation. Promote an idea only when you are ready to decide or scope work.</p>
        </div>
        <button type="button" className="primary-action" disabled={creating} onClick={() => void onCreate()}>
          {creating ? "Creating…" : "New idea"}<span aria-hidden="true">＋</span>
        </button>
      </header>

      {error && <p className="note-error" role="alert">{error}</p>}

      <div className="notes-workspace ideas-workspace">
        <aside className="notes-list-panel" aria-label="Ideas in this scope">
          <div className="notes-list-heading"><div><strong>Ideas</strong><small>{ideas.length} in this scope</small></div><span className="count-badge">{ideas.length}</span></div>
          <label className="notes-search"><span className="sr-only">Find an idea</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an idea…" /></label>
          {filteredIdeas.length === 0 ? (
            <div className="notes-list-empty"><strong>{ideas.length === 0 ? "No ideas yet." : "No ideas match."}</strong><span>{ideas.length === 0 ? "Promote an inbox thought or record something worth considering." : "Try a different search."}</span></div>
          ) : (
            <div className="notes-list idea-list" role="listbox" aria-label="Select an idea">
              {filteredIdeas.map((idea) => (
                <button type="button" role="option" aria-selected={idea.id === selectedIdea?.id} className={idea.id === selectedIdea?.id ? "selected" : ""} key={idea.id} onClick={() => onSelect(idea.id)}>
                  <span className="note-list-title"><strong>{idea.title}</strong>{idea.agentIntent === "evaluation_requested" && <em>Evaluate</em>}</span>
                  <span className={`idea-status status-${idea.status}`}>{ideaStatusLabel(idea.status)}</span>
                  <small>{ideaLocation(idea)} · {shortTime(idea.updatedAt)}</small>
                </button>
              ))}
            </div>
          )}
        </aside>

        <article className="idea-editor" aria-label={selectedIdea ? `Develop idea: ${selectedIdea.title}` : "Idea editor"}>
          {selectedIdea ? (
            <form onSubmit={(event) => void saveIdea(event).catch(() => {})}>
              <div className={`idea-intent ${selectedIdea.agentIntent === "evaluation_requested" ? "evaluation-requested" : "consideration-only"}`}>
                <div><strong>{selectedIdea.agentIntent === "evaluation_requested" ? "Evaluation requested" : "Consideration only"}</strong><span>{selectedIdea.agentIntent === "evaluation_requested" ? "An agent may assess feasibility, value, unknowns, and options. Implementation is not authorized." : "This preserves a possibility. It is not a task, decision, or approval to implement."}</span></div>
                {(selectedIdea.status !== "adopted" || selectedIdea.agentIntent === "evaluation_requested") && <button type="button" disabled={saving} onClick={() => void toggleEvaluationRequest().catch(() => {})}>{selectedIdea.agentIntent === "evaluation_requested" ? "Clear request" : "Ask agent to evaluate"}</button>}
              </div>
              <label className="idea-title"><span>Idea</span><input value={draft.title} maxLength={500} onChange={(event) => setField("title", event.target.value)} /></label>
              <div className="idea-state-fields">
                <label><span>State</span><select value={draft.status} onChange={(event) => setField("status", event.target.value)}>{IDEA_STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
                <label><span>Revisit date</span><input type="date" value={draft.revisitAt} onChange={(event) => setField("revisitAt", event.target.value)} /></label>
                <label><span>Tags</span><input value={draft.tags} onChange={(event) => setField("tags", event.target.value)} placeholder="remote, architecture" /></label>
              </div>
              {draft.status !== selectedIdea.status && (
                <label className="idea-transition-reason"><span>{reasonNeeded ? "Why? Required for this state" : "Reason for this state change"}</span><textarea value={draft.reason} onChange={(event) => setField("reason", event.target.value)} placeholder={draft.status === "deferred" ? "Why not now, and what could change?" : draft.status === "declined" ? "Why is this not worth pursuing?" : "What changed?"} /></label>
              )}
              <div className="idea-sections">
                {sectionFields.map((field) => <label key={field.key}><span>{field.label}</span><textarea value={draft[field.key]} onChange={(event) => setField(field.key, event.target.value)} placeholder={field.placeholder} /></label>)}
              </div>
              {selectedIdea.history.length > 0 && <section className="idea-history"><h3>State history</h3><ol>{[...selectedIdea.history].reverse().map((entry, index) => <li key={`${entry.at}-${index}`}><strong>{ideaStatusLabel(entry.from)} → {ideaStatusLabel(entry.to)}</strong><span>{entry.reason ?? "No reason recorded."}</span><small>{new Date(entry.at).toLocaleString()}</small></li>)}</ol></section>}
              <footer className="idea-editor-footer">
                <span>{ideaLocation(selectedIdea)} · Updated {shortTime(selectedIdea.updatedAt)}</span>
                <div>
                  {deleteArmed ? (
                    <div className="idea-delete-confirm">
                      <span>Delete this idea?</span>
                      <button type="button" onClick={() => setDeleteArmed(false)} disabled={deleting}>Cancel</button>
                      <button type="button" className="danger-action" onClick={() => void removeIdea().catch(() => {})} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
                    </div>
                  ) : (
                    <button type="button" className="idea-delete" disabled={saving} onClick={() => setDeleteArmed(true)}>Delete idea</button>
                  )}
                  {selectedIdea.status === "adopted" && <button type="button" className="secondary-action" disabled={saving} onClick={() => void onScopeWork(selectedIdea).catch(() => {})}>Scope as work</button>}
                  <button type="submit" className="primary-action" disabled={saving || !draft.title.trim()}>{saving ? "Saving…" : "Save idea"}</button>
                </div>
              </footer>
            </form>
          ) : (
            <div className="note-editor-empty"><span aria-hidden="true">◇</span><strong>{ideas.length === 0 ? "Capture a possibility" : "Select an idea"}</strong><p>{ideas.length === 0 ? "Ideas give you room to evaluate something before deciding or creating work." : "Choose one to continue the conversation."}</p>{ideas.length === 0 && <button type="button" className="primary-action" disabled={creating} onClick={() => void onCreate()}>New idea</button>}</div>
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
  onUpdate: (noteId: string, patch: { title?: string; text?: string; agentIntent?: ProjectNote["agentIntent"] }) => Promise<ProjectNote>;
  onDelete: (noteId: string) => Promise<void>;
}) {
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null;
  const [search, setSearch] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "editing" | "saving" | "saved" | "error">("idle");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updatingAgentIntent, setUpdatingAgentIntent] = useState(false);
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
    setDeleteArmed(false);
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
      setDeleteArmed(false);
    } catch {
      setSaveState("error");
    } finally {
      setDeleting(false);
    }
  }

  async function toggleAgentReview() {
    if (!selectedNote || updatingAgentIntent) return;
    if (!(await persistDraft())) return;
    setUpdatingAgentIntent(true);
    try {
      await onUpdate(selectedNote.id, {
        agentIntent: selectedNote.agentIntent === "review_requested" ? "reference_only" : "review_requested",
      });
    } catch {
      setSaveState("error");
    } finally {
      setUpdatingAgentIntent(false);
    }
  }

  function noteLocation(note: ProjectNote) {
    if (!note.projectPath) return note.scopePath === "." ? "Workspace note" : `${displaySegment(pathParts(note.scopePath).at(-1) ?? note.scopePath)} note`;
    return projects.find((project) => project.path === note.projectPath)?.name ?? note.projectPath;
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
          <p>Plain-text working notes kept beside the project. They are personal reference unless you explicitly request an agent review.</p>
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
                      {note.agentIntent === "review_requested" && <em>Agent review</em>}
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
                <span>{noteLocation(selectedNote)}</span>
              </div>
              <div className={`note-agent-intent ${selectedNote.agentIntent === "review_requested" ? "review-requested" : "reference-only"}`}>
                <div>
                  <strong>{selectedNote.agentIntent === "review_requested" ? "Agent review requested" : "Reference note"}</strong>
                  <span>{selectedNote.agentIntent === "review_requested"
                    ? "An agent should review this promptly. This is still not authorization to execute work."
                    : "Agents may use this as context, but should not treat it as a request or task."}</span>
                </div>
                <button type="button" disabled={updatingAgentIntent} onClick={() => void toggleAgentReview()}>
                  {updatingAgentIntent
                    ? "Updating…"
                    : selectedNote.agentIntent === "review_requested"
                      ? "Clear review request"
                      : "Ask agent to review"}
                </button>
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
                  {deleteArmed ? (
                    <div className="note-delete-confirm">
                      <span>Delete this note?</span>
                      <button type="button" onClick={() => setDeleteArmed(false)} disabled={deleting}>Cancel</button>
                      <button type="button" className="danger-action" onClick={() => void removeNote()} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
                    </div>
                  ) : (
                    <button type="button" className="note-delete" onClick={() => setDeleteArmed(true)}>Delete note</button>
                  )}
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

function UpcomingSchedule({ items, projects, onOpenTask, onOpenIdea }: {
  items: ScheduledItem[];
  projects: Project[];
  onOpenTask: (id: string) => void;
  onOpenIdea: (id: string) => void;
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
            const project = projects.find((candidate) => candidate.path === item.projectPath);
            const content = (
              <>
                <time className={`upcoming-date ${tone}`} dateTime={item.scheduledAt}>
                  <strong>{scheduleLabel(item)}</strong>
                  <span>{scheduleDateDetail(item)}</span>
                </time>
                <span className="upcoming-copy">
                  <small><i>{item.kind}</i>{project?.name ?? item.projectPath ?? "Unassigned"}</small>
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
                  onClick={() => item.kind === "task" ? onOpenTask(item.id) : onOpenIdea(item.id)}
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

function KanbanBoard({
  scopeLabel,
  tasks,
  statuses,
  projects,
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
  const filtered = tasks.filter((task) => !query || [task.id, task.title, task.projectPath ?? "", task.assignee ?? "", task.type, task.priority, ...task.tags, ...task.agents].join(" ").toLowerCase().includes(query));
  const activeCount = tasks.filter((task) => ["in_progress", "blocked", "review"].includes(task.status)).length;
  const doneCount = tasks.filter((task) => task.status === "done").length;

  return (
    <section className="board-view" aria-labelledby="board-heading">
      <div className="board-toolbar">
        <div>
          <p className="eyebrow">Present state · full lifecycle</p>
          <h1 id="board-heading">{scopeLabel} board</h1>
          <p>{tasks.length} work items · {activeCount} in flight · {doneCount} completed <span className="board-detail-hint">Select a card for full details.</span></p>
        </div>
        <div className="board-actions">
          <button type="button" className="secondary-action" onClick={onToggleTerminal}>{showTerminal ? "Hide cancelled & archived" : "Show cancelled & archived"}</button>
          <button type="button" className="primary-action" onClick={onCreate}>New work item</button>
        </div>
      </div>
      <label className="board-search">
        <span className="sr-only">Search work items</span>
        <input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search title, ID, project, owner, agent, or tag…" />
      </label>
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
                      const project = projects.find((item) => item.path === task.projectPath);
                      const projectName = project?.name ?? task.projectPath ?? "Unassigned";
                      const owners = [task.assignee, ...task.agents].filter(Boolean).join(" · ");
                      const hoverSummary = [
                        `${task.id} · ${statusLabel(task.status)} · ${task.priority}`,
                        task.title,
                        `Project: ${projectName}`,
                        owners ? `Owner/agents: ${owners}` : null,
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
                          className={`kanban-card priority-${task.priority}`}
                          key={task.id}
                          title={hoverSummary}
                          aria-label={`Open ${task.id}: ${task.title}`}
                          draggable
                          onDragStart={() => onDragStart(task.id)}
                          onDragEnd={onDragEnd}
                          onClick={() => onOpenTask(task.id)}
                        >
                          <span className="card-topline"><strong>{task.id}</strong><span>{task.type}</span><span>{task.priority}</span></span>
                          <span className="card-title">{task.title}</span>
                          <span className="card-project">{projectName}</span>
                          {task.dueAt && (
                            <time className={`card-due ${scheduleTone({ scheduledAt: task.dueAt, allDay: true })}`} dateTime={task.dueAt}>
                              <span aria-hidden="true">◷</span>{scheduleLabel({ scheduledAt: task.dueAt, allDay: true }, "Due")}
                            </time>
                          )}
                          {owners && <span className="card-owners">{owners}</span>}
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
          {events.map((event, index) => {
            const project = projects.find((item) => item.path === event.task.projectPath);
            return (
              <li key={`${event.task.id}-${event.at}-${index}`}>
                <time dateTime={event.at}>{new Date(event.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
                <button type="button" onClick={() => onOpenTask(event.task.id)}><strong>{event.task.id} · {event.task.title}</strong><span>{event.message}</span><small>{project?.name ?? "Unassigned"} · {statusLabel(event.task.status)}</small></button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
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
  const [projectPath, setProjectPath] = useState(defaultProjectPath ?? "");
  const [status, setStatus] = useState(statuses[0] ?? "backlog");
  const [type, setType] = useState("task");
  const [priority, setPriority] = useState("none");
  const [assignee, setAssignee] = useState("");
  const [agents, setAgents] = useState("");
  const [tags, setTags] = useState("");
  const [parentId, setParentId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [goal, setGoal] = useState("");
  const [requirements, setRequirements] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [plan, setPlan] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      projectPath: projectPath || null,
      status,
      type,
      priority,
      assignee: assignee.trim() || null,
      agents: agents.split(",").map((item) => item.trim()).filter(Boolean),
      tags: tags.split(",").map((item) => item.trim()).filter(Boolean),
      parentId: parentId.trim() || null,
      dueAt: dueAt || null,
      goal,
      requirements: requirements.split("\n").map((item) => item.trim()).filter(Boolean),
      acceptanceCriteria: acceptance.split("\n").map((item) => item.trim()).filter(Boolean),
      plan,
    });
  }

  return (
    <aside className="task-panel create-task-panel" aria-labelledby="create-task-heading">
      <div className="task-panel-header"><div><p className="eyebrow">New work item</p><h2 id="create-task-heading">Create a complete card</h2></div><button type="button" onClick={onClose} aria-label="Close new work item">×</button></div>
      <form onSubmit={submit} className="task-form">
        <label className="field-wide"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What outcome or task needs tracking?" autoFocus /></label>
        <div className="field-grid">
          <label><span>Project</span><select value={projectPath} onChange={(event) => setProjectPath(event.target.value)}><option value="">Unassigned</option>{projects.filter((project) => project.path !== ".").map((project) => <option key={project.id} value={project.path}>{project.name} — {project.path}</option>)}</select></label>
          <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}>{statuses.map((item) => <option key={item} value={item}>{statusLabel(item)}</option>)}</select></label>
          <label><span>Type</span><select value={type} onChange={(event) => setType(event.target.value)}>{["task", "bug", "feature", "research", "admin", "epic", "idea"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value)}>{["none", "low", "medium", "high", "critical"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>Human owner</span><input value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder="Optional" /></label>
          <label><span>Agents or teams</span><input value={agents} onChange={(event) => setAgents(event.target.value)} placeholder="codex, rev-team" /></label>
          <label><span>Parent task ID</span><input value={parentId} onChange={(event) => setParentId(event.target.value)} placeholder="W-0001" /></label>
          <label><span>Due date</span><input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
        </div>
        <label className="field-wide"><span>Tags</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="release, reverse-engineering" /></label>
        <label className="field-wide"><span>Goal</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="What does done accomplish?" /></label>
        <label className="field-wide"><span>Requirements · one per line</span><textarea value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder={"Must preserve Markdown\nMust remain root-scoped"} /></label>
        <label className="field-wide"><span>Acceptance criteria · one per line</span><textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder={"Board reflects status\nRestart restores the card"} /></label>
        <label className="field-wide"><span>Plan</span><textarea value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="Known implementation shape or research steps" /></label>
        {error && <div className="task-error" role="alert">{error}</div>}
        <div className="task-panel-actions"><button type="button" className="secondary-action" onClick={onClose}>Cancel</button><button type="submit" className="primary-action" disabled={!title.trim() || saving}>{saving ? "Creating…" : "Create work item"}</button></div>
      </form>
    </aside>
  );
}

function TaskDetailPanel({ task, tasks, projects, statuses, saving, error, onClose, onMove, onPatch, onToggle, onLog }: {
  task: WorkTask;
  tasks: WorkTask[];
  projects: Project[];
  statuses: string[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onMove: (status: string, note?: string) => void;
  onPatch: (patch: Record<string, unknown>) => void;
  onToggle: (section: "requirements" | "acceptance", index: number, checked: boolean) => void;
  onLog: (message: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title);
  const [projectPath, setProjectPath] = useState(task.projectPath ?? "");
  const [type, setType] = useState(task.type);
  const [priority, setPriority] = useState(task.priority);
  const [assignee, setAssignee] = useState(task.assignee ?? "");
  const [agents, setAgents] = useState(task.agents.join(", "));
  const [tags, setTags] = useState(task.tags.join(", "));
  const [dependsOn, setDependsOn] = useState(task.dependsOn.join(", "));
  const [blockedBy, setBlockedBy] = useState(task.blockedBy.join(", "));
  const [blockedReason, setBlockedReason] = useState(task.blockedReason ?? "");
  const [estimate, setEstimate] = useState(task.estimate ?? "");
  const [parentId, setParentId] = useState(task.parentId ?? "");
  const [dueAt, setDueAt] = useState(task.dueAt?.slice(0, 10) ?? "");
  const [goal, setGoal] = useState(task.sections.goal);
  const [plan, setPlan] = useState(task.sections.plan);
  const [notes, setNotes] = useState(task.sections.notes);
  const [completionSummary, setCompletionSummary] = useState(task.sections.completionSummary);
  const [newRequirement, setNewRequirement] = useState("");
  const [newAcceptance, setNewAcceptance] = useState("");
  const [logMessage, setLogMessage] = useState("");

  useEffect(() => {
    setTitle(task.title); setProjectPath(task.projectPath ?? ""); setType(task.type); setPriority(task.priority);
    setAssignee(task.assignee ?? ""); setAgents(task.agents.join(", ")); setTags(task.tags.join(", "));
    setDependsOn(task.dependsOn.join(", ")); setBlockedBy(task.blockedBy.join(", ")); setBlockedReason(task.blockedReason ?? "");
    setEstimate(task.estimate ?? ""); setParentId(task.parentId ?? ""); setDueAt(task.dueAt?.slice(0, 10) ?? ""); setGoal(task.sections.goal); setPlan(task.sections.plan); setNotes(task.sections.notes);
    setCompletionSummary(task.sections.completionSummary);
  }, [task.id, task.updatedAt]);

  function commaIds(value: string) { return value.split(",").map((item) => item.trim()).filter(Boolean); }
  function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onPatch({ title, projectPath: projectPath || null, type, priority, assignee: assignee.trim() || null, agents: commaIds(agents), tags: commaIds(tags), dependsOn: commaIds(dependsOn), blockedBy: commaIds(blockedBy), blockedReason: blockedReason.trim() || null, estimate: estimate.trim() || null, parentId: parentId.trim() || null, dueAt: dueAt || null, goal, plan, notes, completionSummary });
  }

  const childTasks = tasks.filter((item) => item.parentId === task.id);
  const progress = checklistProgress(task);

  return (
    <aside className="task-panel" aria-labelledby="task-detail-heading">
      <div className="task-panel-header"><div><p className="eyebrow">{task.id} · {task.type} · {task.priority}</p><h2 id="task-detail-heading">{task.title}</h2></div><button type="button" onClick={onClose} aria-label="Close work item">×</button></div>
      <div className="task-state-strip"><label><span>Status</span><select value={task.status} onChange={(event) => onMove(event.target.value)} disabled={saving}>{[...statuses, "cancelled", "archived"].map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label><span>{progress.complete}/{progress.total} checks complete</span><span>Updated {shortTime(task.updatedAt)}</span></div>
      {error && <div className="task-error" role="alert">{error}</div>}
      <form className="task-form" onSubmit={saveDetails}>
        <label className="field-wide"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <div className="field-grid">
          <label><span>Project</span><select value={projectPath} onChange={(event) => setProjectPath(event.target.value)}><option value="">Unassigned</option>{projects.filter((project) => project.path !== ".").map((project) => <option key={project.id} value={project.path}>{project.name} — {project.path}</option>)}</select></label>
          <label><span>Type</span><select value={type} onChange={(event) => setType(event.target.value as WorkTask["type"])}>{["task", "bug", "feature", "research", "admin", "epic", "idea"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value as WorkTask["priority"])}>{["none", "low", "medium", "high", "critical"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>Estimate</span><input value={estimate} onChange={(event) => setEstimate(event.target.value)} placeholder="2h, 3 points, unknown" /></label>
          <label><span>Human owner</span><input value={assignee} onChange={(event) => setAssignee(event.target.value)} /></label>
          <label><span>Agents or teams</span><input value={agents} onChange={(event) => setAgents(event.target.value)} placeholder="Comma-separated" /></label>
          <label><span>Parent task ID</span><input value={parentId} onChange={(event) => setParentId(event.target.value)} placeholder="W-0001" /></label>
          <label><span>Due date</span><input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
        </div>
        <label className="field-wide"><span>Tags</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Comma-separated" /></label>
        <label className="field-wide"><span>Depends on task IDs</span><input value={dependsOn} onChange={(event) => setDependsOn(event.target.value)} placeholder="W-0001, W-0002" /></label>
        <label className="field-wide"><span>Blocked by task IDs</span><input value={blockedBy} onChange={(event) => setBlockedBy(event.target.value)} placeholder="W-0001" /></label>
        <label className="field-wide"><span>Blocker explanation</span><textarea value={blockedReason} onChange={(event) => setBlockedReason(event.target.value)} /></label>
        <label className="field-wide"><span>Goal</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
        <label className="field-wide"><span>Plan</span><textarea value={plan} onChange={(event) => setPlan(event.target.value)} /></label>
        <label className="field-wide"><span>Notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <label className="field-wide"><span>Completion summary</span><textarea value={completionSummary} onChange={(event) => setCompletionSummary(event.target.value)} placeholder="What shipped, changed, or was learned?" /></label>
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
