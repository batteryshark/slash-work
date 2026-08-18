"use client";

import { normalizeTags, tagHueAngle, workspaceTags } from "../lib/tags.mjs";
import { splitTaskTitles } from "../lib/task-lines.mjs";
import { decisionIsActive } from "../lib/decisions.mjs";
import {
  ClipboardEvent,
  CSSProperties,
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
  // Free-text labels that cut across the folder hierarchy. Absent reads as [].
  // Nothing to do with task tags: a project never lends its tags to its tasks.
  tags: string[];
  path: string;
  depth: number;
  markers: string[];
  aliasPaths?: string[];
};

type ProjectProfilePatch = { name?: string; description?: string; view?: "board" | "list"; tags?: string[] };

// The chip carries its hue as a CSS custom property; globals.css owns the
// lightness so one rule covers both themes. The name always shows, so colour
// is never the only signal.
function TagChip({ tag, children }: { tag: string; children?: ReactNode }) {
  return (
    <span className="tag-chip" style={{ "--tag-h": tagHueAngle(tag) } as CSSProperties}>
      {tag}
      {children}
    </span>
  );
}

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

type IssueState = "queued" | "in_progress" | "needs_human" | "closed";

type IssueMessage = {
  id: string;
  body: string;
  author: { kind: "human" | "agent"; name: string | null };
  createdAt: string;
};

type Issue = {
  id: string;
  longId: string;
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
  recommendationReason: string | null;
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

type ChecklistItem = { checked: boolean; text: string; declined?: boolean; reason?: string };
type ChecklistPatch = { checked: boolean } | { declined: true; reason: string };

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

type AppView = "today" | "work" | "issues" | "notes" | "files" | "activity";
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

// Grouping for the project pickers: the folder path is the taxonomy, so a
// project's first path segment is its group. Paths without a folder sit in a
// "Root" group that is listed first.
function groupByFirstSegment<Item>(items: Item[], pathOf: (item: Item) => string) {
  const groups = new Map<string, { key: string; label: string; items: Item[] }>();
  for (const item of items) {
    const parts = pathParts(pathOf(item));
    const key = parts.length > 1 ? parts[0] : "";
    const group = groups.get(key) ?? { key, label: key ? displaySegment(key) : "Root", items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    if (!left.key) return -1;
    if (!right.key) return 1;
    return left.label.localeCompare(right.label);
  });
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
  queued: "Open",
  in_progress: "In progress",
  needs_human: "Needs you",
  closed: "Closed",
};

function scopeLabelFor(projects: Project[], projectPath: string | null, fallback: string) {
  if (!projectPath) return fallback;
  return projects.find((project) => project.path === projectPath)?.name ?? projectPath;
}

function safeLinkTarget(target: string) {
  return /^(https?:\/\/|mailto:)/i.test(target) ? target : null;
}

// A record's pasted images live at .work/attachments/<record-id>/<name> and
// are referenced relatively from the record markdown. Only those references
// render as images — arbitrary remote image URLs stay plain text.
const ATTACHMENT_REF = /^!\[([^\]]*)\]\(\.\.\/attachments\/([A-Za-z0-9_-]+)\/([a-z0-9][a-z0-9-]{0,60}\.(?:png|jpg|gif|webp))\)\s*$/;

function attachmentUrl(record: string, name: string) {
  const workspaceId = typeof window === "undefined" ? null : activeWorkspaceId ?? rememberedValue("work.workspace");
  const suffix = workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : "";
  return `/api/attachments?record=${encodeURIComponent(record)}&name=${encodeURIComponent(name)}${suffix}`;
}

type PastedImage = { name: string; contentType: string; data: string; preview: string };

// Returns null when the clipboard holds no images, so plain text pastes keep
// their default behaviour; otherwise consumes the event and decodes the files.
function readClipboardImages(event: ClipboardEvent<HTMLElement>): Promise<PastedImage[]> | null {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null);
  if (files.length === 0) return null;
  event.preventDefault();
  return Promise.all(files.map((file, index) => new Promise<PastedImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the pasted image."));
    reader.onload = () => {
      const url = String(reader.result);
      resolve({
        name: `paste-${index + 1}`,
        contentType: file.type,
        data: url.slice(url.indexOf(",") + 1),
        preview: url,
      });
    };
    reader.readAsDataURL(file);
  })));
}

function bareAttachments(images: PastedImage[]) {
  return images.map(({ name, contentType, data }) => ({ name, contentType, data }));
}

function PastedImageChips({ images, onRemove }: { images: PastedImage[]; onRemove: (index: number) => void }) {
  if (images.length === 0) return null;
  return (
    <div className="pasted-images" aria-label="Pasted images awaiting submit">
      {images.map((image, index) => (
        <span key={`${image.name}-${index}`} className="pasted-image-chip">
          <img src={image.preview} alt="" aria-hidden="true" />
          {image.name}
          <button type="button" aria-label={`Remove ${image.name}`} onClick={() => onRemove(index)}>×</button>
        </span>
      ))}
    </div>
  );
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

    const attachment = ATTACHMENT_REF.exec(line);
    if (attachment) {
      blocks.push(
        <p key={`attachment-${index}`} className="markdown-attachment">
          <img src={attachmentUrl(attachment[2], attachment[3])} alt={attachment[1] || attachment[3]} loading="lazy" />
        </p>,
      );
      index += 1;
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
  closed: {
    className: "closed",
    title: (issue) => issue.resolutionSummary ? "Closed with a resolution." : "Closed.",
    body: (issue) => issue.resolutionSummary
      ? <Markdown>{issue.resolutionSummary}</Markdown>
      : <span>You can reopen it at any time. Nothing in this conversation is discarded.</span>,
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



// Where you are looking is per-window; what you looked at last is shared.
// localStorage is one value for every tab on this origin, so two windows on
// two projects used to overwrite each other. sessionStorage gives each window
// its own place, seeded from the shared value so a fresh window still opens
// where you left off, and writes back so the next new window follows.
function rememberedValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  const own = sessionStorage.getItem(key);
  if (own !== null) return own;
  const shared = localStorage.getItem(key);
  if (shared !== null) sessionStorage.setItem(key, shared);
  return shared;
}

function rememberValue(key: string, value: string) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(key, value);
  localStorage.setItem(key, value);
}

// The workspace every request in THIS window belongs to. Storage is shared by
// every tab on the origin, so reading it per request let another window's write
// redirect this one's mutations mid-flight.
let activeWorkspaceId: string | null = null;
function setActiveWorkspaceId(id: string) { activeWorkspaceId = id; }

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const workspaceId = typeof window === "undefined"
    ? null
    : activeWorkspaceId ?? rememberedValue("work.workspace");
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
  const [view, setView] = useState<AppView>("today");
  const [pendingHomeSection, setPendingHomeSection] = useState<"inbox" | "needs-you" | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") return "system";
    const saved = localStorage.getItem("work.theme");
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  });
  const [scopePath, setScopePath] = useState(".");
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const [recentProjectPaths, setRecentProjectPaths] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [savingCapture, setSavingCapture] = useState(false);
  const [movingCaptureId, setMovingCaptureId] = useState<string | null>(null);
  const [captureToMove, setCaptureToMove] = useState<Capture | null>(null);
  const [captureMoveSearch, setCaptureMoveSearch] = useState("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
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
  const [projectTagFilter, setProjectTagFilter] = useState<string | null>(null);
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
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [savingTask, setSavingTask] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [showTerminalTasks, setShowTerminalTasks] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadRequestRef = useRef(0);
  // The workspace this window is on, decided once and then reused. The poll
  // used to re-derive it every 12 seconds and fall back to the server's boot
  // root whenever storage missed, silently dragging the window to another root.
  const workspaceIdRef = useRef<string | null>(null);

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
      const knownId = workspaceIdRef.current ?? rememberedValue("work.workspace");
      const selectedId = directory.workspaces.some((workspace) => workspace.id === knownId)
        ? knownId
        : directory.activeWorkspaceId;
      if (selectedId) {
        workspaceIdRef.current = selectedId;
        setActiveWorkspaceId(selectedId);
        rememberValue("work.workspace", selectedId);
      }
      const workspace = await requestJson<WorkspacePayload>("/api/workspace", {
        // Named explicitly rather than read from storage again: another window
        // writing the shared value mid-poll must not redirect this one.
        headers: { accept: "application/json", ...(selectedId ? { "x-work-workspace": selectedId } : {}) },
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
    workspaceIdRef.current = workspaceId;
    setActiveWorkspaceId(workspaceId);
    rememberValue("work.workspace", workspaceId);
    setWorkspaceMenuOpen(false);
    setProjectMenuOpen(false);
    setSelectedNoteId(null);
    setSelectedIssueId(null);
    setSelectedTaskId(null);
    setScopePath(".");
    setView("today");
    setData(null);
    await loadWorkspace();
  }

  async function updateProjectProfile(projectPath: string, patch: ProjectProfilePatch) {
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
    setView("today");
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
      rememberValue("work.workspace", receipt.workspace.id);
      setWorkspaceMenuOpen(false);
      setProjectMenuOpen(false);
      setSelectedNoteId(null);
      setSelectedIssueId(null);
      setSelectedTaskId(null);
      setScopePath(".");
      setView("today");
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
    // A restart re-execs the process and rebinds the port, which can outlast a
    // short deadline on a busy machine. Giving up early reverted the button as
    // though nothing had happened while the restart was still in flight.
    const deadline = Date.now() + 45_000;
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
    throw new Error("Work is taking longer than usual to come back. It may still be restarting — this page will catch up on its own.");
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
      // Reload rather than refetch: this tab is still running the JS bundle it
      // downloaded from the old build, so refreshing only the data leaves the
      // stale UI the banner was complaining about.
      window.location.reload();
      return;
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
    const remembered = rememberedValue(key);
    const requested = data.workspace.startScopePath && data.workspace.startScopePath !== "."
      ? data.workspace.startScopePath
      : remembered ?? ".";
    const exists = requested === "." || data.projects.some((project) => pathContains(project.path, requested));
    if (exists) setScopePath(requested);
  }, [data?.workspace.root]);

  useEffect(() => {
    if (!data) return;
    rememberValue(`work.scope.${data.workspace.root}`, scopePath);
  }, [data, scopePath]);

  // Picker memory, same per-root shape as work.scope.*: which project groups the
  // owner left open, and the projects they opened most recently.
  useEffect(() => {
    if (!data) return;
    const read = (key: string) => {
      try {
        const parsed = JSON.parse(localStorage.getItem(`${key}.${data.workspace.root}`) ?? "[]");
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
      } catch {
        return [];
      }
    };
    setExpandedGroups(read("work.projectGroups"));
    setRecentProjectPaths(read("work.recentProjects"));
  }, [data?.workspace.root]);

  function rememberRecentProject(path: string) {
    if (!data || path === "." || !data.projects.some((project) => project.path === path)) return;
    setRecentProjectPaths((current) => {
      const next = [path, ...current.filter((entry) => entry !== path)].slice(0, 5);
      localStorage.setItem(`work.recentProjects.${data.workspace.root}`, JSON.stringify(next));
      return next;
    });
  }

  function toggleProjectGroup(key: string) {
    setExpandedGroups((current) => {
      const next = current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key];
      if (data) localStorage.setItem(`work.projectGroups.${data.workspace.root}`, JSON.stringify(next));
      return next;
    });
  }

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
    if (view !== "today" || !pendingHomeSection) return;
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
  // ---- workbench shell state ----
  const [serviceVersion, setServiceVersion] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/health", { headers: { accept: "application/json" } })
      .then((response) => response.json())
      .then((health) => setServiceVersion(health?.service?.version ?? null))
      .catch(() => {});
  }, [data?.workspace.id]);
  const [railOpen, setRailOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("work.rail") !== "closed";
  });
  const [workMode, setWorkMode] = useState<"list" | "board" | "overview">("list");
  const [decidedOpen, setDecidedOpen] = useState(false);
  const openCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of data?.tasks ?? []) {
      if (["done", "cancelled", "archived"].includes(task.status)) continue;
      const path = task.projectPath ?? ".";
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return counts;
  }, [data]);
  const decidedDecisions = useMemo(() => {
    return (data?.decisions ?? [])
      .filter((decision) => !decisionIsActive(decision))
      .filter((decision) => scopePath === "." || pathContains(decision.projectPath, scopePath))
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
  }, [data, scopePath]);
  function toggleRail() {
    setRailOpen((open) => {
      localStorage.setItem("work.rail", open ? "closed" : "open");
      return !open;
    });
  }
  function openScope(path: string) {
    setScopePath(path);
    if (path !== ".") rememberRecentProject(path);
    if (path === "." && (view === "issues" || view === "files")) setView("work");
    if (path !== "." && workMode === "overview") setWorkMode("list");
    setProjectMenuOpen(false);
  }
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

  // Suggestions and the filter row are derived from the projects themselves;
  // there is no tag registry to keep in step.
  const projectTagVocabulary = useMemo(() => workspaceTags(data?.projects ?? []) as string[], [data?.projects]);

  // The tag filter narrows the set first; search then runs inside it, so the
  // two compose instead of competing. Folder grouping is untouched: the same
  // groups render with fewer entries.
  const filteredProjectMenu = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    const tag = projectTagFilter?.toLowerCase() ?? null;
    return (data?.projects ?? []).filter((project) => {
      if (project.path === ".") return false;
      if (tag && !project.tags.some((value) => value.toLowerCase() === tag)) return false;
      if (!query) return true;
      return `${project.name} ${project.path} ${project.description} ${project.tags.join(" ")} ${(project.aliasPaths ?? []).join(" ")}`.toLowerCase().includes(query);
    });
  }, [data, projectSearch, projectTagFilter]);

  const projectMenuGroups = useMemo(
    () => groupByFirstSegment(filteredProjectMenu, (project) => project.path),
    [filteredProjectMenu],
  );

  const recentProjects = useMemo(
    () => recentProjectPaths.flatMap((path) => data?.projects.filter((project) => project.path === path) ?? []),
    [data?.projects, recentProjectPaths],
  );

  const projectInventory = useMemo(() => {
    const logicalProjects = data?.projects.filter((project) => project.path !== ".") ?? [];
    return {
      logicalProjects: logicalProjects.length,
      linkedWorktrees: logicalProjects.reduce((total, project) => total + (project.aliasPaths ?? []).length, 0),
    };
  }, [data?.projects]);

  function navigate(nextScope: string) {
    setScopePath(nextScope || ".");
    rememberRecentProject(nextScope || ".");
    setSystemMenuOpen(false);
    setProjectMenuOpen(false);
    setWorkspaceMenuOpen(false);
    setProjectSearch("");
    setProjectTagFilter(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function projectMenuButton(project: Project) {
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
  }

  function openHomeSection(section: "inbox" | "needs-you") {
    setView("today");
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

  function createIssue(title: string, body: string, attachments?: { name: string; contentType: string; data: string }[]) {
    return run(async () => {
      const issue = await requestJson<Issue>("/api/issues", {
        method: "POST",
        // The title is its own field. Deriving it from the first body line
        // produced titles like: In issues, """Hand to an agent
        body: JSON.stringify({ title, body, scopePath, projectPath: selectedProject?.path ?? null, attachments }),
      });
      replaceIn("issues", issue);
      setSelectedIssueId(issue.id);
      setView("issues");
      return issue;
    }, { saving: setSavingIssue, error: setIssueError, fallback: "The issue could not be submitted." });
  }

  function replyToIssue(issueId: string, body: string, attachments?: { name: string; contentType: string; data: string }[]) {
    return run(async () => {
      const issue = await requestJson<Issue>(`/api/issues/${encodeURIComponent(issueId)}/replies`, {
        method: "POST",
        body: JSON.stringify({ body, attachments }),
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

  function deleteWorkIssue(issueId: string) {
    return run(async () => {
      await requestJson<null>(`/api/issues/${encodeURIComponent(issueId)}`, { method: "DELETE" });
      setData((current) => current ? {
        ...current,
        issues: (current.issues ?? []).filter((issue) => issue.id !== issueId),
      } : current);
      setSelectedIssueId(null);
    }, { saving: setSavingIssue, error: setIssueError, fallback: "The issue could not be deleted." });
  }

  function createProjectNote(input: { title?: string; text?: string; projectPath?: string | null; scopePath?: string } = {}) {
    return run(async () => {
      const note = await requestJson<ProjectNote>("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          title: input.title ?? "Untitled note",
          text: input.text ?? "",
          scopePath: input.scopePath ?? (input.projectPath !== undefined ? input.projectPath ?? "." : scopePath),
          projectPath: input.projectPath !== undefined ? input.projectPath : selectedProject?.path ?? null,
        }),
      });
      replaceIn("notes", note);
      setSelectedNoteId(note.id);
      setView("notes");
      return note;
    }, { saving: setCreatingNote, error: setNoteError, fallback: "The note could not be created." });
  }

  function updateProjectNote(noteId: string, patch: { title?: string; text?: string; attachments?: { name: string; contentType: string; data: string }[] }) {
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
        setView("work");
        setSelectedTaskId(task.id);
      }
      return task;
    }, { saving: setSavingTask, error: setTaskError, fallback: "The work item could not be created." });
  }

  // Quick add stays out of the shared saving/error state on purpose: the row
  // reports its own outcome inline and never opens the created task.
  async function quickAddTask(title: string, status: string, parentId: string | null) {
    const task = await requestJson<WorkTask>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title, projectPath: selectedProject?.path ?? null, status, parentId }),
    });
    replaceIn("tasks", task);
    return task;
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

  async function toggleWorkChecklist(taskId: string, section: "requirements" | "acceptance", index: number, state: ChecklistPatch) {
    await run(async () => {
      const task = await requestJson<WorkTask>(`/api/tasks/${encodeURIComponent(taskId)}/checklist`, {
        method: "POST",
        body: JSON.stringify({ section, index, ...state }),
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
    await deleteCapture(capture.id);
  }

  async function promoteCaptureToNote(capture: Capture) {
    const firstLine = capture.text.split("\n").find((line) => line.trim())?.trim() ?? capture.text;
    const title = firstLine.length > 300 ? `${firstLine.slice(0, 297)}…` : firstLine;
    await createProjectNote({ title, text: capture.text, projectPath: capture.projectPath ?? null });
    await deleteCapture(capture.id);
  }

  async function runCommand() {
    const text = cleanCommand(command);
    if (!text) {
      setCaptureError("Write anything you want remembered. No formatting needed.");
      inputRef.current?.focus();
      return;
    }

    // `task:` on the first line switches the dock to task entry. Every further
    // line becomes its own task, so a pasted list arrives as a list.
    const lines = splitTaskTitles(text);
    const taskCommand = lines[0]?.match(/^(?:task|todo)\s*:?\s+(.+)$/i);
    if (taskCommand) {
      const titles = [taskCommand[1].trim(), ...lines.slice(1).map((line) => line.replace(/^(?:task|todo)\s*:?\s+/i, ""))].filter(Boolean);
      setSavingCapture(true);
      setCaptureError(null);
      setCaptureNotice(null);
      let created = 0;
      try {
        for (const title of titles) {
          await createWorkTask({ title, projectPath: selectedProject?.path ?? null, status: "backlog" }, false);
          created += 1;
        }
        setCommand("");
        setCaptureNotice(created > 1 ? `Added ${created} tasks to ${selectedProject?.name ?? "the workspace"}.` : null);
      } catch {
        setCaptureError(`${created > 0 ? `Added ${created} of ${titles.length}. ` : ""}Task not created — check the board message and try again.`);
        setCommand(titles.slice(created).map((title) => `task: ${title}`).join("\n"));
      } finally {
        setSavingCapture(false);
        window.requestAnimationFrame(() => inputRef.current?.focus());
      }
      return;
    }
    // Plain typed text is ALWAYS a capture. Navigation lives in the tabs and
    // breadcrumbs; "show board" saved as a thought beats a discarded thought.
    setSavingCapture(true);
    setCaptureError(null);
    setCaptureNotice(null);
    try {
      // The dock files into the scope you are standing in; root otherwise.
      const toProject = selectedProject ? selectedProject.path : null;
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
      setCaptureDockCollapsedPersisted(true);
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

  const expandedDecisionObj = expandedDecision
    ? (data.decisions ?? []).find((decision) => decision.id === expandedDecision) ?? null
    : null;
  const selectedCapture = selectedCaptureId
    ? (data.captures ?? []).find((capture) => capture.id === selectedCaptureId) ?? null
    : null;
  const panelOpen = creatingTask || !!selectedTask || !!expandedDecisionObj || !!selectedCapture;
  const projectScoped = scopeKind === "project";
  const openTaskTotal = scopedTasks.filter((task) => !["done", "cancelled", "archived"].includes(task.status)).length;
  const queuedIssueCount = scopedIssues.filter((issue) => issue.state === "queued").length;
  const railProjects = data.projects.filter((project) => project.path !== ".");
  const railGroups = groupByFirstSegment(railProjects, (project) => project.path);

  return (
    <div className="wb-frame">
      <a className="skip-link" href="#main-content">Skip to content</a>

      <nav className={`wb-rail${railOpen ? "" : " wb-rail-closed"}`} aria-label="Roots and projects">
        <div className="wb-rail-scroll">
          <button
            type="button"
            className="wb-rootbtn"
            onClick={() => { setWorkspaceMenuOpen((open) => !open); setSystemMenuOpen(false); }}
            aria-expanded={workspaceMenuOpen}
            aria-haspopup="menu"
          >
            <span className="wb-root-text">
              <strong>{data.workspace.name}</strong>
              <small>{workspaceLocationLabel}</small>
            </span>
            <span className="wb-chev" aria-hidden="true">{workspaceMenuOpen ? "▴" : "▾"}</span>
          </button>
          {workspaceMenuOpen && (
            <div className="wb-menu" role="menu" aria-label="Workspace roots">
              {(workspaceDirectory?.workspaces ?? []).map((workspace) => (
                <div className="wb-menu-row" key={workspace.id}>
                  <button
                    type="button"
                    className={workspace.id === data.workspace.id ? "on" : ""}
                    onClick={() => void switchWorkspace(workspace.id)}
                  >
                    <span>{workspace.name}</span>
                    <small>{workspace.root}</small>
                  </button>
                  {workspace.id !== data.workspace.id && (
                    <button
                      type="button"
                      className="wb-menu-x"
                      aria-label={`Forget the root ${workspace.name}`}
                      disabled={removingWorkspace === workspace.id}
                      onClick={() => void removeWorkspace(workspace.id)}
                    >×</button>
                  )}
                </div>
              ))}
              <button type="button" className="wb-menu-add" disabled={pickingWorkspace} onClick={() => void pickWorkspace()}>
                {pickingWorkspace ? "Opening the folder picker…" : "+ Open another root…"}
              </button>
              {workspacePickerError && <small className="wb-menu-error" role="alert">{workspacePickerError}</small>}
            </div>
          )}

          <p className="wb-rail-label" id="wb-projects-label">Projects</p>
          <div className="wb-tree" role="list" aria-labelledby="wb-projects-label">
            <button type="button" className={`wb-proj${scopePath === "." ? " on" : ""}`} onClick={() => openScope(".")}>
              <span>All projects</span>
              <span className="wb-count">{(data.tasks ?? []).filter((task) => !["done", "cancelled", "archived"].includes(task.status)).length || ""}</span>
            </button>
            {railGroups.map((group) => group.key === "" ? (
              group.items.map((project) => (
                <button type="button" key={project.path} className={`wb-proj${scopePath === project.path ? " on" : ""}`} onClick={() => openScope(project.path)}>
                  <span>{project.name}</span>
                  <span className="wb-count">{openCountByProject.get(project.path) || ""}</span>
                </button>
              ))
            ) : (
              <div key={group.key} className="wb-group">
                <button
                  type="button"
                  className={`wb-grouphead${expandedGroups.includes(group.key) ? " open" : ""}`}
                  aria-expanded={expandedGroups.includes(group.key)}
                  onClick={() => toggleProjectGroup(group.key)}
                >
                  <span className="wb-tw" aria-hidden="true">▸</span>
                  <span>{group.label}</span>
                  <span className="wb-count">{group.items.reduce((total, project) => total + (openCountByProject.get(project.path) ?? 0), 0) || ""}</span>
                </button>
                {expandedGroups.includes(group.key) && (
                  <div className="wb-kids">
                    {group.items.map((project) => (
                      <button type="button" key={project.path} className={`wb-proj${scopePath === project.path ? " on" : ""}`} onClick={() => openScope(project.path)}>
                        <span>{project.name}</span>
                        <span className="wb-count">{openCountByProject.get(project.path) || ""}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <InlineProjectCreate parentPath={projectScoped ? parentPath(scopePath) || "." : scopePath} onCreated={(project) => { rememberProject(project); openScope(project.path); }} />
          </div>
        </div>

        <div className="wb-railfoot">
          {systemMenuOpen && (
            <div className="wb-menu wb-setmenu" role="menu" aria-label="Work settings">
              <button type="button" disabled={restartingService} onClick={() => void restartLocalService()}>
                ↻ {restartingService ? "Restarting…" : "Restart service"}
              </button>
              <button type="button" disabled={checkingUpdate} onClick={() => void checkForUpdates(false, true)}>
                ⬆ {checkingUpdate ? "Checking…" : "Check for updates"}
                <span className="wb-menu-sub">{updateStatus?.updateAvailable ? `${updateStatus.latestVersion} available` : `v${updateStatus?.currentVersion ?? data.version ?? ""}`}</span>
              </button>
              {updateStatus?.updateAvailable && updateStatus.installable && (
                <button type="button" disabled={installingUpdate} onClick={() => void installServiceUpdate()}>
                  {installingUpdate ? "Installing…" : `Install ${updateStatus.latestVersion} and restart`}
                </button>
              )}
              <div className="wb-menu-theme" role="group" aria-label="Theme">
                {(["system", "light", "dark"] as const).map((option) => (
                  <button type="button" key={option} className={theme === option ? "on" : ""} onClick={() => setTheme(option)}>{option}</button>
                ))}
              </div>
              {(serviceRestartError || updateError) && <small className="wb-menu-error" role="alert">{serviceRestartError ?? updateError}</small>}
            </div>
          )}
          <button type="button" className="wb-settings" aria-expanded={systemMenuOpen} aria-haspopup="menu"
                  onClick={() => { setSystemMenuOpen((open) => !open); setWorkspaceMenuOpen(false); }}>
            ⚙ <span>Settings</span>
            {updateStatus?.updateAvailable && <span className="update-available-dot" aria-hidden="true" />}
            {serviceVersion && <span className="wb-ver">v{serviceVersion}</span>}
          </button>
        </div>
      </nav>

      <div className="wb-center">
        <div className="wb-subbar">
          <span className="wb-mark" aria-hidden="true">/</span>
          <button type="button" className="wb-railtoggle" aria-label={railOpen ? "Hide the sidebar" : "Show the sidebar"} onClick={toggleRail}>☰</button>
          <button type="button" className={`wb-tab${view === "today" ? " on" : ""}`} onClick={() => setView("today")}>
            Today{attentionCount > 0 && <span className="wb-badge">{attentionCount}</span>}
          </button>
          <button type="button" className={`wb-tab${view === "work" ? " on" : ""}`} onClick={() => setView("work")}>
            Work<span className="wb-badge">{openTaskTotal}</span>
          </button>
          <button
            type="button"
            className={`wb-tab${view === "issues" ? " on" : ""}${projectScoped ? "" : " stub"}`}
            title={projectScoped ? undefined : "Pick a project — issues live on a project, not the whole root"}
            onClick={() => { if (projectScoped) setView("issues"); }}
          >
            Issues{projectScoped && queuedIssueCount > 0 && <span className="wb-badge">{queuedIssueCount}</span>}
          </button>
          <button type="button" className={`wb-tab${view === "notes" ? " on" : ""}`} onClick={() => setView("notes")}>
            Notes{scopedNotes.length > 0 && <span className="wb-badge">{scopedNotes.length}</span>}
          </button>
          <button
            type="button"
            className={`wb-tab${view === "files" ? " on" : ""}${projectScoped ? "" : " stub"}`}
            title={projectScoped ? undefined : "Pick a project to browse its files"}
            onClick={() => { if (projectScoped) setView("files"); }}
          >Files</button>
          <button type="button" className={`wb-tab${view === "activity" ? " on" : ""}`} onClick={() => setView("activity")}>Activity</button>
          <span className="wb-spacer" />
          {view === "work" && (
            <>
              <div className="wb-modetoggle" role="group" aria-label="Work layout">
                <button type="button" className={workMode === "list" ? "on" : ""} onClick={() => setWorkMode("list")}>List</button>
                <button type="button" className={workMode === "board" ? "on" : ""} onClick={() => setWorkMode("board")}>Board</button>
                {scopePath === "." && (
                  <button type="button" className={workMode === "overview" ? "on" : ""} onClick={() => setWorkMode("overview")}>Projects</button>
                )}
              </div>
              <button type="button" className="wb-newbtn" onClick={() => setCreatingTask(true)}>New item</button>
            </>
          )}
          {data.staleBuild && (
            <button type="button" className="wb-stale" disabled={restartingService} onClick={() => void restartLocalService()}>
              {restartingService ? "Restarting…" : "New build on disk — restart"}
            </button>
          )}
          <span className={`wb-sync${loadError ? " off" : ""}`} title={lastSyncedAt ? `Synced ${shortTime(lastSyncedAt.toISOString())}` : "Connecting…"} />
        </div>

        {projectScoped && selectedProject && (
          <div className="wb-projheader">
            <strong>{selectedProject.name}</strong>
            <ProjectTagEditor project={selectedProject} suggestions={projectTagVocabulary} onUpdateProfile={updateProjectProfile} />
          </div>
        )}

        <main id="main-content" className="wb-view">
          {view === "today" ? (
            <>
            <WbToday
              scopeLabel={scopeLabel}
              projects={data.projects}
              decisions={activeDecisions}
              decided={decidedDecisions}
              decidedOpen={decidedOpen}
              humanIssues={humanIssues}
              blockedTasks={blockedTasks}
              tasks={scopedTasks}
              captures={scopedCaptures}
              savingDecision={savingDecision}
              onToggleDecided={() => setDecidedOpen((open) => !open)}
              onOpenDecision={(decisionId) => setExpandedDecision(decisionId)}
              onReopenDecision={(decisionId) => void reopenDecision(decisionId)}
              onOpenIssue={(issue) => { if (issue.projectPath) openScope(issue.projectPath); setSelectedIssueId(issue.id); setView("issues"); }}
              onOpenTask={setSelectedTaskId}
              onOpenCapture={setSelectedCaptureId}
              onPromoteTask={(capture) => { setSelectedCaptureId(null); void promoteCaptureToTask(capture); }}
              onPromoteNote={(capture) => { setSelectedCaptureId(null); void promoteCaptureToNote(capture); }}
              onDropCapture={(captureId) => { setSelectedCaptureId(null); void deleteCapture(captureId); }}
            />
            {projectScoped && selectedProject && (
              <div className="wb-today wb-dangerzone project-delete-panel">
                <h2 className="wb-h2">Danger zone</h2>
                <div className="wb-stack wb-danger-stack">
                  <div className="wb-trow wb-trow-static">
                    {confirmingProjectDelete ? (
                      <>
                        <span className="wb-trow-title">Delete {selectedProject.name}? Its Work records are removed; nothing else on disk is touched.</span>
                        <button type="button" className="danger-zone-button" disabled={deletingProject} onClick={() => void confirmProjectDelete()}>
                          {deletingProject ? "Deleting…" : "Really delete"}
                        </button>
                        <button type="button" className="wb-linkbtn" onClick={() => setConfirmingProjectDelete(false)}>Keep it</button>
                        {projectDeleteError && <small role="alert">{projectDeleteError}</small>}
                      </>
                    ) : (
                      <>
                        <span className="wb-trow-title">This will remove the project after confirmation.</span>
                        <button type="button" className="danger-zone-button" onClick={() => setConfirmingProjectDelete(true)}>Delete project…</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
          ) : view === "work" ? (
            workMode === "overview" && scopePath === "." ? (
              <WbProjectsOverview
                projects={railProjects}
                tasks={data.tasks ?? []}
                openCounts={openCountByProject}
                tagFilter={projectTagFilter}
                onTagFilter={setProjectTagFilter}
                onOpen={openScope}
              />
            ) : workMode === "board" ? (
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
                onQuickAdd={quickAddTask}
                error={taskError}
              />
            ) : (
              <TaskListView
                scopeLabel={scopeLabel}
                tasks={scopedTasks}
                statuses={data.workspace.statuses ?? ["backlog", "ready", "in_progress", "blocked", "review", "done"]}
                projects={data.projects}
                atRoot={scopePath === "."}
                showTerminal={showTerminalTasks}
                onToggleTerminal={() => setShowTerminalTasks((shown) => !shown)}
                onMove={(taskId, status) => void moveWorkTask(taskId, status).catch(() => {})}
                onOpenTask={setSelectedTaskId}
                onCreate={() => setCreatingTask(true)}
                onQuickAdd={quickAddTask}
                onReparent={(taskId, parentId) => void patchWorkTask(taskId, { parentId }).catch(() => {})}
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
              onDelete={(issueId) => void deleteWorkIssue(issueId).catch(() => {})}
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
          ) : (
            <ActivityView
              scopeLabel={scopeLabel}
              tasks={scopedTasks}
              projects={data.projects}
              onOpenTask={setSelectedTaskId}
            />
          )}
        </main>
      </div>

      <aside className={`wb-panel${panelOpen ? " open" : ""}`} aria-label="Detail panel">
        {creatingTask ? (
          <CreateTaskPanel
            projects={data.projects}
            statuses={data.workspace.statuses}
            tasks={scopedTasks}
            defaultProjectPath={selectedProject?.path ?? null}
            saving={savingTask}
            error={taskError}
            onClose={() => { setCreatingTask(false); setTaskError(null); }}
            onCreate={(input) => void createWorkTask(input).catch(() => {})}
          />
        ) : selectedTask ? (
          <TaskDetailPanel
            task={selectedTask}
            tasks={data.tasks ?? []}
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
            onClose={() => setSelectedTaskId(null)}
            onMove={(status, note) => void moveWorkTask(selectedTask.id, status, note).catch(() => {})}
            onPatch={(patch) => patchWorkTask(selectedTask.id, patch)}
            onToggle={(section, index, state) => void toggleWorkChecklist(selectedTask.id, section, index, state)}
            onLog={(message) => logWorkProgress(selectedTask.id, message)}
          />
        ) : selectedCapture ? (
          <div className="wb-capture-panel">
            <div className="wb-tp-head">
              <div>
                <p className="eyebrow">Inbox · {shortTime(selectedCapture.createdAt)}</p>
              </div>
              <div className="wb-tp-close"><button type="button" onClick={() => setSelectedCaptureId(null)} aria-label="Close capture">×</button></div>
            </div>
            <div className="wb-capture-text"><Markdown>{selectedCapture.text}</Markdown></div>
            <label className="wb-capture-move">
              <span>File in</span>
              <select
                value={selectedCapture.projectPath ?? "."}
                disabled={movingCaptureId === selectedCapture.id}
                onChange={(event) => void moveCapture(selectedCapture, event.target.value === "." ? "scope:." : `project:${event.target.value}`)}
              >
                <option value=".">Root inbox — no project yet</option>
                {data.projects.filter((project) => project.path !== ".").map((project) => (
                  <option key={project.path} value={project.path}>{project.name}</option>
                ))}
              </select>
            </label>
            <p className="wb-capture-dest">{movingCaptureId === selectedCapture.id ? "Moving…" : destinationForCapture(selectedCapture)}</p>
            <div className="p-actions wb-capture-actions">
              <button type="button" className="wb-newbtn" onClick={() => { setSelectedCaptureId(null); void promoteCaptureToTask(selectedCapture); }}>→ Task</button>
              <button type="button" className="wb-linkbtn" onClick={() => { setSelectedCaptureId(null); void promoteCaptureToNote(selectedCapture); }}>→ Note</button>
              <button type="button" className="wb-linkbtn wb-drop" onClick={() => { setSelectedCaptureId(null); void deleteCapture(selectedCapture.id); }}>Let it go</button>
            </div>
          </div>
        ) : expandedDecisionObj ? (
          <div className="wb-decision-panel">
            <DecisionPanel
              decision={expandedDecisionObj}
              draft={draftFor(expandedDecisionObj.id)}
              projects={data.projects}
              saving={savingDecision === expandedDecisionObj.id}
              autoFocusResponse
              onDraft={updateDraft}
              onConfirm={() => void confirmDecision(expandedDecisionObj)}
              onClose={() => setExpandedDecision(null)}
            />
          </div>
        ) : null}
      </aside>

      {captureDockCollapsed ? (
        <button type="button" className="wb-cap-pill" onClick={() => setCaptureDockCollapsedPersisted(false, true)}>
          / <span>Capture</span> <kbd>/</kbd>
        </button>
      ) : (
        <form className="wb-capbar capture-dock" onSubmit={handleCommandSubmit}>
          <textarea
            ref={inputRef}
            rows={1}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={handleCommandKeyDown}
            placeholder={selectedProject ? `Capture to ${selectedProject.name}…` : `Capture to the ${data.workspace.name} inbox…`}
            aria-label="Capture anything"
          />
          <div className="wb-cap-hintrow">
            <span className={captureError ? "wb-cap-error" : ""} role={captureError ? "alert" : undefined}>
              {captureError ?? captureNotice ?? captureReceipt?.destination ?? <span className="task-prefix-hint">Start with <kbd>task:</kbd> to file a task instead of a note</span>}
            </span>
            <span className="wb-cap-keys">
              {savingCapture ? "Saving…" : <><kbd>Enter</kbd> save · <kbd>Esc</kbd> close</>}
              <button type="submit" className="sr-only">Save thought</button>
              <button type="button" className="wb-cap-collapse" aria-label="Collapse the capture dock" onClick={() => setCaptureDockCollapsedPersisted(true)}>▾</button>
            </span>
          </div>
        </form>
      )}
    </div>
  );

}

function WbToday({
  scopeLabel,
  projects,
  decisions,
  decided,
  decidedOpen,
  humanIssues,
  blockedTasks,
  tasks,
  captures,
  savingDecision,
  onToggleDecided,
  onOpenDecision,
  onReopenDecision,
  onOpenIssue,
  onOpenTask,
  onOpenCapture,
  onPromoteTask,
  onPromoteNote,
  onDropCapture,
}: {
  scopeLabel: string;
  projects: Project[];
  decisions: Decision[];
  decided: Decision[];
  decidedOpen: boolean;
  humanIssues: Issue[];
  blockedTasks: WorkTask[];
  tasks: WorkTask[];
  captures: Capture[];
  savingDecision: string | null;
  onToggleDecided: () => void;
  onOpenDecision: (decisionId: string) => void;
  onReopenDecision: (decisionId: string) => void;
  onOpenIssue: (issue: Issue) => void;
  onOpenTask: (taskId: string) => void;
  onOpenCapture: (captureId: string) => void;
  onPromoteTask: (capture: Capture) => void;
  onPromoteNote: (capture: Capture) => void;
  onDropCapture: (captureId: string) => void;
}) {
  const projectName = (path: string | null) => projects.find((project) => project.path === path)?.name ?? (path ? displaySegment(pathParts(path).at(-1) ?? path) : "root");
  const today = new Date();
  const dueState = (task: WorkTask) => {
    if (!task.dueAt || ["done", "cancelled", "archived"].includes(task.status)) return null;
    const due = calendarDate(task.dueAt);
    const difference = startOfDay(due).getTime() - startOfDay(today).getTime();
    if (difference < 0) return "overdue";
    if (difference === 0) return "due";
    return null;
  };
  const due = tasks.filter((task) => dueState(task));
  const active = tasks.filter((task) => ["in_progress", "review"].includes(task.status) && !due.includes(task));
  const needsCount = decisions.length + humanIssues.length + blockedTasks.length;

  const taskRow = (task: WorkTask) => {
    const tone = dueState(task);
    const progress = checklistProgress(task);
    return (
      <button type="button" className="wb-trow" key={task.id} onClick={() => onOpenTask(task.id)}>
        <span className={`wb-dot status-${task.status}`} aria-hidden="true" />
        <span className="wb-trow-title">{task.title}</span>
        {task.delegated && <span className="wb-chip agent">agent</span>}
        {task.status === "blocked" && <span className="wb-chip overdue">blocked</span>}
        {tone && <span className={`wb-chip ${tone}`}>{tone === "overdue" ? "overdue" : "due today"}</span>}
        {progress.total > 0 && <span className="wb-meta">{progress.complete}/{progress.total}</span>}
        <span className="wb-meta">{projectName(task.projectPath)}</span>
      </button>
    );
  };

  return (
    <div className="wb-today">
      <h2 className="wb-h2">Needs you <span className="wb-n">{needsCount}</span></h2>
      <div className="wb-stack" id="needs-you" role="list" aria-label={`Needs you in ${scopeLabel}`}>
        {decisions.map((decision) => (
          <button type="button" className="wb-trow" key={decision.id} onClick={() => onOpenDecision(decision.id)}>
            <span className="wb-what">decision</span>
            <span className="wb-trow-title">{decision.title}</span>
            <span className="wb-meta">{savingDecision === decision.id ? "Saving…" : projectName(decision.projectPath)}</span>
          </button>
        ))}
        {humanIssues.map((issue) => (
          <button type="button" className="wb-trow" key={issue.id} onClick={() => onOpenIssue(issue)}>
            <span className="wb-what">issue</span>
            <span className="wb-trow-title">{issue.title}</span>
            <span className="wb-meta">{projectName(issue.projectPath)}</span>
          </button>
        ))}
        {blockedTasks.map((task) => (
          <button type="button" className="wb-trow" key={task.id} onClick={() => onOpenTask(task.id)}>
            <span className="wb-what">blocked</span>
            <span className="wb-trow-title">{task.title}</span>
            <span className="wb-meta">{projectName(task.projectPath)}</span>
          </button>
        ))}
        {needsCount === 0 && <p className="wb-empty">Nothing needs you.</p>}
      </div>

      {decided.length > 0 && (
        <>
          <button type="button" className="wb-h2 wb-h2-fold" onClick={onToggleDecided} aria-expanded={decidedOpen}>
            Decided <span className="wb-n">{decided.length} — {decidedOpen ? "hide" : "show"}</span>
          </button>
          {decidedOpen && (
            <div className="wb-stack" role="list" aria-label="Recently decided">
              {decided.slice(0, 12).map((decision) => (
                <div className="wb-trow wb-trow-static" key={decision.id}>
                  <span className={`wb-what state-${decision.status}`}>{decision.status}</span>
                  <span className="wb-trow-title">{decision.title}</span>
                  <span className="wb-meta">{typeof decision.resolution?.choice?.option === "string" ? decision.resolution.choice.option : ""}</span>
                  <button type="button" className="wb-linkbtn" onClick={() => onReopenDecision(decision.id)}>↩ Reopen</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <h2 className="wb-h2">On deck <span className="wb-n">{due.length + active.length}</span></h2>
      <div className="wb-stack" role="list" aria-label={`On deck in ${scopeLabel}`}>
        {due.map(taskRow)}
        {active.map(taskRow)}
        {due.length + active.length === 0 && <p className="wb-empty">Nothing due, nothing in flight.</p>}
      </div>

      <h2 className="wb-h2" id="inbox">Inbox <span className="wb-n">{captures.length}</span></h2>
      <div className="wb-stack" role="list" aria-label={`Inbox in ${scopeLabel}`}>
        {captures.slice(0, 10).map((capture) => (
          <div className="wb-trow wb-trow-static" key={capture.id}>
            <span className="wb-what">note</span>
            <button type="button" className="wb-trow-open" onClick={() => onOpenCapture(capture.id)} aria-label="Open this thought">
              <span className="wb-trow-title">{capture.text}</span>
            </button>
            {capture.projectPath && <span className="wb-chip">{projectName(capture.projectPath)}</span>}
            <span className="wb-triage">
              <button type="button" onClick={() => onPromoteTask(capture)}>→ Task</button>
              <button type="button" onClick={() => onPromoteNote(capture)}>→ Note</button>
              <button type="button" className="wb-drop" onClick={() => onDropCapture(capture.id)}>Let it go</button>
            </span>
          </div>
        ))}
        {captures.length > 10 && <p className="wb-empty">{captures.length - 10} more in this inbox.</p>}
        {captures.length === 0 && <p className="wb-empty">Nothing in the inbox.</p>}
      </div>
    </div>
  );
}

function WbProjectsOverview({
  projects,
  tasks,
  openCounts,
  tagFilter,
  onTagFilter,
  onOpen,
}: {
  projects: Project[];
  tasks: WorkTask[];
  openCounts: Map<string, number>;
  tagFilter: string | null;
  onTagFilter: (tag: string | null) => void;
  onOpen: (path: string) => void;
}) {
  const allTags = [...new Set(projects.flatMap((project) => project.tags ?? []))].sort();
  const list = projects
    .filter((project) => !tagFilter || (project.tags ?? []).includes(tagFilter))
    .sort((a, b) => a.name.localeCompare(b.name));
  const flags = (path: string) => {
    let due = 0; let blocked = 0; let delegated = 0;
    for (const task of tasks) {
      if (!pathContains(task.projectPath, path) || ["done", "cancelled", "archived"].includes(task.status)) continue;
      if (task.status === "blocked") blocked += 1;
      if (task.delegated) delegated += 1;
      if (task.dueAt && startOfDay(calendarDate(task.dueAt)).getTime() <= startOfDay(new Date()).getTime()) due += 1;
    }
    return { due, blocked, delegated };
  };
  return (
    <div className="wb-today wb-overview">
      <h2 className="wb-h2">
        All projects <span className="wb-n">{list.length}</span>
        {allTags.length > 0 && (
          <select className="wb-tagfilter" value={tagFilter ?? ""} onChange={(event) => onTagFilter(event.target.value || null)} aria-label="Filter projects by tag">
            <option value="">every tag</option>
            {allTags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}
          </select>
        )}
      </h2>
      <div className="wb-stack" role="list" aria-label="All projects by tag">
        {list.map((project) => {
          const projectFlags = flags(project.path);
          return (
            <button type="button" className="wb-trow" key={project.path} onClick={() => onOpen(project.path)}>
              <span className="wb-trow-title wb-trow-name">{project.name}</span>
              {(project.tags ?? []).map((tag) => (
                <TagChip key={tag} tag={tag} />
              ))}
              <span className="wb-spacer" />
              {projectFlags.due > 0 && <span className="wb-chip due">{projectFlags.due} due</span>}
              {projectFlags.blocked > 0 && <span className="wb-chip overdue">{projectFlags.blocked} blocked</span>}
              {projectFlags.delegated > 0 && <span className="wb-chip agent">{projectFlags.delegated} with agents</span>}
              <span className="wb-meta">{openCounts.get(project.path) ?? 0} open</span>
            </button>
          );
        })}
      </div>
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
  const [open, setOpen] = useState(false);
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
      setOpen(false);
      onCreated(project);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The project could not be created.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="wb-newproj" onClick={() => setOpen(true)}>+ New project</button>
    );
  }
  return (
    <form className="wb-newproj-form" onSubmit={create}>
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); setName(""); setError(null); } }}
        placeholder="Project name…"
        aria-label="New project name"
      />
      <div className="wb-newproj-actions">
        <button type="submit" disabled={saving || !name.trim()}>{saving ? "Creating…" : "Create"}</button>
        <button type="button" onClick={() => { setOpen(false); setName(""); setError(null); }}>Cancel</button>
      </div>
      {error && <small role="alert">{error}</small>}
    </form>
  );
}
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
      {!decision.recommendedOption && decision.recommendationReason && (
        <p className="decision-noreason">No recommendation: {decision.recommendationReason}</p>
      )}
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
              {option === decision.recommendedOption && decision.recommendationReason && <small className="decision-reason">{decision.recommendationReason}</small>}
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

// A real chip input, not a comma-separated string: existing tags are removable
// chips, and one field both filters the workspace's existing tags and accepts
// a brand-new one. Every change saves immediately through the profile PATCH,
// so there is no half-typed state to lose.
function ProjectTagEditor({ project, suggestions, onUpdateProfile }: {
  project: Project;
  suggestions: string[];
  onUpdateProfile: (projectPath: string, patch: ProjectProfilePatch) => Promise<Project>;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = draft.trim().toLowerCase();
  const matches = suggestions.filter((tag) =>
    !project.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())
    && (!query || tag.toLowerCase().includes(query)),
  ).slice(0, 8);
  // normalizeTags keeps the first-seen casing, so an existing "House" wins
  // over a freshly typed "house" and the two can never both exist.
  const isNew = query.length > 0 && !suggestions.some((tag) => tag.toLowerCase() === query);

  async function save(tags: string[]) {
    setSaving(true);
    setError(null);
    try {
      await onUpdateProfile(project.path, { tags });
      setDraft("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The project tags could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function add(tag: string) {
    const tags = normalizeTags([...project.tags, tag]) as string[];
    if (tags.length === project.tags.length) { setDraft(""); return; }
    void save(tags);
  }

  return (
    <section className="project-tags wb-tags-inline" aria-label="Project tags">
      <div className="project-tag-chips">
        {project.tags.map((tag) => (
          <TagChip key={tag} tag={tag}>
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove tag ${tag}`}
              disabled={saving}
              onClick={() => void save(project.tags.filter((value) => value !== tag))}
            >×</button>
          </TagChip>
        ))}
      </div>
      <div className="project-tag-input">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (draft.trim()) add(draft);
          }}
          maxLength={500}
          disabled={saving}
          aria-label="Add a tag"
          placeholder="+ tag"
        />
        {query.length > 0 && (matches.length > 0 || isNew) && (
          <div className="project-tag-suggestions" role="group" aria-label="Tag suggestions">
            {matches.map((tag) => (
              <button
                key={tag}
                type="button"
                className="tag-chip tag-chip-button"
                style={{ "--tag-h": tagHueAngle(tag) } as CSSProperties}
                disabled={saving}
                onClick={() => add(tag)}
              >{tag}</button>
            ))}
            {isNew && <button type="button" className="tag-chip-new" disabled={saving} onClick={() => add(draft)}>+ Create “{draft.trim()}”</button>}
          </div>
        )}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  );
}

function ProjectFocus({ project, captures, tasks, tagSuggestions, onOpenBoard, onOpenTask, onUpdateProfile }: {
  project: Project;
  captures: Capture[];
  tasks: WorkTask[];
  tagSuggestions: string[];
  onOpenBoard: () => void;
  onOpenTask: (taskId: string) => void;
  onUpdateProfile: (projectPath: string, patch: ProjectProfilePatch) => Promise<Project>;
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

      <ProjectTagEditor project={project} suggestions={tagSuggestions} onUpdateProfile={onUpdateProfile} />

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
      <header className="files-toolbar wb-viewbar">
        <div>
          <strong id="files-heading">{scopeLabel} files</strong>
          <span className="wb-n"> read-only{git.available ? ` · ${totalChanges} changed in Git` : ""}</span>
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
  onDelete,
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
  onCreate: (title: string, body: string, attachments?: { name: string; contentType: string; data: string }[]) => Promise<Issue>;
  onReply: (issueId: string, body: string, attachments?: { name: string; contentType: string; data: string }[]) => Promise<Issue>;
  onSetState: (issueId: string, state: "queued" | "closed") => Promise<Issue>;
  onSetDelegated: (issueId: string, delegated: boolean) => Promise<Issue>;
  onDelete: (issueId: string) => void;
}) {
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId) ?? null;
  const stateNote = selectedIssue ? ISSUE_STATE_NOTES[selectedIssue.state] : undefined;
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState("");
  const [search, setSearch] = useState("");
  const [pastedDraft, setPastedDraft] = useState<PastedImage[]>([]);
  const [pastedReply, setPastedReply] = useState<PastedImage[]>([]);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    setReply("");
    setPastedReply([]);
  }, [selectedIssue?.id]);

  function pasteInto(setter: (update: (current: PastedImage[]) => PastedImage[]) => void) {
    return (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const decoded = readClipboardImages(event);
      if (decoded) void decoded.then((images) => setter((current) => [...current, ...images])).catch(() => {});
    };
  }

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
    if (!title.trim() || (!body.trim() && pastedDraft.length === 0) || saving) return;
    await onCreate(title.trim(), body, pastedDraft.length ? bareAttachments(pastedDraft) : undefined);
    setTitle("");
    setDraft("");
    setPastedDraft([]);
    setComposing(false);
  }

  async function submitReply(event?: FormEvent) {
    event?.preventDefault();
    if (!selectedIssue || (!reply.trim() && pastedReply.length === 0) || saving) return;
    await onReply(selectedIssue.id, reply, pastedReply.length ? bareAttachments(pastedReply) : undefined);
    setReply("");
    setPastedReply([]);
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
      <div className="wb-viewbar">
        <strong id="issues-heading">{scopeLabel} issues</strong>
        <span className="wb-n">{issues.length}</span>
        <span className="wb-spacer" />
        <button type="button" className="wb-newbtn" onClick={() => setComposing((open) => !open)}>
          {composing ? "Cancel" : "New issue"}
        </button>
      </div>

      {composing && <form className="issue-composer" onSubmit={(event) => void submitIssue(event).catch(() => {})}>
        <label htmlFor="new-issue-title">
          <strong>File an issue</strong>
          <span>A short name, then the detail below</span>
        </label>
        <input
          id="new-issue-title"
          className="issue-title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What is this about?"
          maxLength={300}
        />
        <label htmlFor="new-issue-body" className="sr-only">Issue detail</label>
        <textarea
          id="new-issue-body"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => submitOnShortcut(event, () => submitIssue())}
          onPaste={pasteInto(setPastedDraft)}
          placeholder="Describe it however it comes to you… (paste screenshots straight in)"
          aria-describedby="issue-scope issue-submit-hint"
        />
        <PastedImageChips images={pastedDraft} onRemove={(index) => setPastedDraft((current) => current.filter((_, i) => i !== index))} />
        <footer>
          <span id="issue-scope"><strong>Exact scope:</strong> {exactScope}</span>
          <div>
            <span id="issue-submit-hint"><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>
            <button type="submit" className="primary-action" disabled={saving || !title.trim() || (!draft.trim() && pastedDraft.length === 0)}>
              {saving ? "Submitting…" : "Submit issue"}
            </button>
          </div>
        </footer>
      </form>}

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
                  <small>{issue.id} · {issueLocation(issue)} · {shortTime(issue.updatedAt)}</small>
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
                  <strong className="issue-short-id">{selectedIssue.id}</strong>
                  <small>{issueLocation(selectedIssue)} · Opened {new Date(selectedIssue.createdAt).toLocaleString()}</small>
                  <small className="issue-long-id">Long ID · <code>{selectedIssue.longId}</code></small>
                </div>
                <div className="issue-state-actions">
                  {selectedIssue.state === "closed" && (
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
                  <ConfirmAction
                    key={`delete-${selectedIssue.id}`}
                    label="Delete…"
                    triggerClassName="issue-delete-action"
                    message="Delete this issue and its attachments? The conversation is not recoverable."
                    confirmLabel="Really delete"
                    busy={saving}
                    disabled={saving}
                    confirmClassName="issue-delete-confirm"
                    onConfirm={() => onDelete(selectedIssue.id)}
                  />
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
                  {selectedIssue.state === "closed" && <span>Replying automatically reopens this issue and returns it to Queued.</span>}
                </label>
                <textarea
                  id={`issue-reply-${selectedIssue.id}`}
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => submitOnShortcut(event, () => submitReply())}
                  onPaste={pasteInto(setPastedReply)}
                  placeholder="Add context, answer questions, or paste a screenshot…"
                />
                <PastedImageChips images={pastedReply} onRemove={(index) => setPastedReply((current) => current.filter((_, i) => i !== index))} />
                <footer>
                  <span>Markdown supported · <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>
                  <button type="submit" className="primary-action" disabled={saving || (!reply.trim() && pastedReply.length === 0)}>
                    {saving
                      ? "Submitting…"
                      : selectedIssue.state === "needs_human"
                        ? "Reply and return to queue"
                        : selectedIssue.state === "closed"
                          ? "Reply and reopen"
                          : "Reply"}
                  </button>
                </footer>
              </form>
              <p className="issue-authority-note">Closing is always reversible. An agent may close with a resolution summary, but cannot delete, lock, or prevent a reply.</p>
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
  onUpdate: (noteId: string, patch: { title?: string; text?: string; attachments?: { name: string; contentType: string; data: string }[] }) => Promise<ProjectNote>;
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

  async function attachPastedImages(decoded: Promise<PastedImage[]>) {
    if (!selectedNote) return;
    const noteId = selectedNote.id;
    const revision = revisionRef.current;
    try {
      const images = await decoded;
      // Flush the text first so the server appends the references to what is
      // on screen, then adopt the returned text so the draft carries them.
      if (!(await persistDraft())) return;
      setSaveState("saving");
      const note = await onUpdate(noteId, { attachments: bareAttachments(images) });
      if (revisionRef.current === revision) {
        setDraftText(note.text);
        setDirty(false);
        setSaveState("saved");
      }
    } catch {
      if (revisionRef.current === revision) setSaveState("error");
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
      <div className="wb-viewbar">
        <strong id="notes-heading">{scopeLabel} notes</strong>
        <span className="wb-n">{notes.length}</span>
        <span className="wb-spacer" />
        <button type="button" className="wb-newbtn" disabled={creating} onClick={() => void createNote()}>
          {creating ? "Creating…" : "New note"}
        </button>
      </div>

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
                  onPaste={(event) => {
                    const decoded = readClipboardImages(event);
                    if (decoded) void attachPastedImages(decoded);
                  }}
                  placeholder="Write whatever you need to remember… (paste screenshots straight in)"
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

type QuickAddCreate = (title: string, status: string, parentId: string | null) => Promise<WorkTask>;

/**
 * Rapid task entry: type, Enter, type, Enter, never leaving the keyboard.
 * Pasting several lines creates one task per line. Tab files the next task
 * under the row above from this typing session; because `parentId` is a single
 * link, indenting under a task that is itself a subtask reuses that subtask's
 * parent instead of nesting a second level.
 */
function QuickAddRow({ status, statusName, onQuickAdd }: { status: string; statusName: string; onQuickAdd: QuickAddCreate }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [indent, setIndent] = useState(false);
  const [anchor, setAnchor] = useState<{ id: string; parentId: string | null } | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const parentId = indent && anchor ? anchor.parentId ?? anchor.id : null;

  async function submit() {
    const titles = splitTaskTitles(value);
    if (titles.length === 0 || busy) return;
    // Clear first so the next line can be typed while this one saves; a
    // failure puts the unsaved lines back only if nothing was typed since.
    setValue("");
    setBusy(true);
    setError(null);
    setNotice(null);
    let previous = anchor;
    let created = 0;
    try {
      for (const title of titles) {
        const parent = indent && previous ? previous.parentId ?? previous.id : null;
        const task = await onQuickAdd(title, status, parent);
        previous = { id: task.id, parentId: task.parentId ?? null };
        created += 1;
      }
      setNotice(created > 1 ? `Added ${created} tasks.` : null);
    } catch (cause) {
      const remaining = titles.slice(created);
      setValue((current) => current || remaining.join("\n"));
      setError(`${created > 0 ? `Added ${created} of ${titles.length}. ` : ""}Not saved — ${cause instanceof Error ? cause.message : "try again."}`);
    } finally {
      if (previous) setAnchor(previous);
      setBusy(false);
      fieldRef.current?.focus();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && value.trim() && anchor) {
      event.preventDefault();
      setIndent(true);
      return;
    }
    if (event.key === "Tab" && event.shiftKey && indent) {
      event.preventDefault();
      setIndent(false);
    }
  }

  return (
    <form
      className={`quick-add ${parentId ? "indented" : ""}`}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <div className="quick-add-indent-controls">
        <button type="button" aria-label="Outdent: file the next task on its own" disabled={!indent} onClick={() => setIndent(false)}><span aria-hidden="true">⇤</span></button>
        <button type="button" aria-label="Indent: file the next task under the one above" disabled={!anchor} onClick={() => setIndent(true)}><span aria-hidden="true">⇥</span></button>
      </div>
      {/* A textarea, not a text input: a text input silently strips the
          newlines out of a pasted list, and the whole point is one task per
          pasted line. Enter still saves; the field grows to what was pasted. */}
      <textarea
        ref={fieldRef}
        className="quick-add-input"
        value={value}
        rows={Math.min(6, value.split("\n").length)}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={`Add to ${statusName} — Enter saves, Tab indents`}
        aria-label={`Add a task to ${statusName}. Enter saves it. Tab files it under the task above. Paste several lines to create several tasks.`}
        autoComplete="off"
      />
      <span className="quick-add-state" role="status" aria-live="polite">
        {error ?? notice ?? (busy ? "Saving…" : parentId ? `Subtask of ${parentId}` : "")}
      </span>
    </form>
  );
}

function TaskListView({ scopeLabel, tasks, statuses, projects, atRoot, showTerminal, onToggleTerminal, onMove, onOpenTask, onCreate, onQuickAdd, onReparent, error }: {
  scopeLabel: string;
  tasks: WorkTask[];
  statuses: string[];
  projects: Project[];
  atRoot: boolean;
  showTerminal: boolean;
  onToggleTerminal: () => void;
  onMove: (id: string, status: string) => void;
  onOpenTask: (id: string) => void;
  onCreate: () => void;
  onQuickAdd: QuickAddCreate;
  onReparent: (taskId: string, parentId: string | null) => void;
  error: string | null;
}) {
  // Done starts folded; every group can fold. The fold is session state, not
  // preference — a fresh window starts from the same calm default.
  const [folded, setFolded] = useState<Record<string, boolean>>({ done: true });
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const known = ["in_progress", "blocked", "review", "ready", "backlog", "done"];
  const extras = statuses.filter((status) => !known.includes(status));
  const groupOrder = [
    ...known.filter((status) => statuses.includes(status)),
    ...extras,
    ...(showTerminal ? ["cancelled", "archived"] : []),
  ];

  const visible = tasks.filter((task) => showTerminal || !["cancelled", "archived"].includes(task.status));
  const ids = new Set(visible.map((task) => task.id));
  const byId = new Map(visible.map((task) => [task.id, task]));
  const childrenOf = (id: string) => visible.filter((task) => task.parentId === id);
  const topLevel = visible
    .filter((task) => !task.parentId || !ids.has(task.parentId))
    .sort((left, right) => (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999") || (left.createdAt ?? "").localeCompare(right.createdAt ?? ""));

  function isDescendantOf(taskId: string, ancestorId: string) {
    let current = byId.get(taskId);
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.parentId)) {
      if (current.parentId === ancestorId) return true;
      seen.add(current.parentId);
      current = byId.get(current.parentId);
    }
    return false;
  }

  function completeFromRow(task: WorkTask, checked: boolean) {
    if (!checked) {
      onMove(task.id, "backlog");
      return;
    }
    const progress = checklistProgress(task);
    if (progress.total > 0 && progress.complete < progress.total) {
      // The checklist gate: open the card at its unfinished boxes instead of
      // silently refusing — same rule the CLI enforces on review.
      onOpenTask(task.id);
      return;
    }
    onMove(task.id, "done");
  }

  function dropOnRow(task: WorkTask) {
    return (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      if (!dragId || dragId === task.id) { setDragId(null); return; }
      if (isDescendantOf(task.id, dragId)) { setDragId(null); return; }
      onReparent(dragId, task.id);
      setDragId(null);
    };
  }

  const row = (task: WorkTask, depth: number): ReactNode => {
    const progress = checklistProgress(task);
    const terminal = ["done", "cancelled", "archived"].includes(task.status);
    const tone = task.dueAt && !terminal ? scheduleTone({ scheduledAt: task.dueAt, allDay: true }) : null;
    return (
      <li key={task.id}>
        <div
          className={`wb-lrow${terminal ? " done" : ""}${dropTarget === task.id ? " dropover" : ""}`}
          draggable
          onDragStart={(event) => { setDragId(task.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragOver={(event) => { event.preventDefault(); setDropTarget(task.id); }}
          onDragLeave={() => setDropTarget((current) => current === task.id ? null : current)}
          onDrop={dropOnRow(task)}
        >
          <input
            type="checkbox"
            className="wb-donebox"
            checked={task.status === "done"}
            onChange={(event) => completeFromRow(task, event.target.checked)}
            aria-label={`Mark ${task.id} ${task.status === "done" ? "not done" : "done"}`}
          />
          <span className={`wb-dot status-${task.status}`} aria-hidden="true" />
          <button type="button" className="wb-lrow-main" onClick={() => onOpenTask(task.id)} aria-label={`Open ${task.id}: ${task.title}`}>
            <code>{task.id}</code>
            <span className="wb-lrow-title">{task.title}</span>
          </button>
          {task.delegated && <span className="wb-chip agent">agent</span>}
          {task.blockedReason && <span className="wb-chip overdue">blocked</span>}
          {tone === "overdue" && <span className="wb-chip overdue">overdue</span>}
          {tone === "today" && <span className="wb-chip due">today</span>}
          {tone === "upcoming" && task.dueAt && <span className="wb-chip">{scheduleLabel({ scheduledAt: task.dueAt, allDay: true }, "due")}</span>}
          {atRoot && <span className="wb-meta">{scopeLabelFor(projects, task.projectPath, "root")}</span>}
          <span className="wb-prog">{progress.total > 0 ? `${progress.complete}/${progress.total}` : ""}</span>
        </div>
        {childrenOf(task.id).length > 0 && (
          <ol className="task-list task-list-children" aria-label={`Subtasks of ${task.id}`}>
            {childrenOf(task.id).map((child) => row(child, depth + 1))}
          </ol>
        )}
      </li>
    );
  };

  return (
    <section
      className="wb-list task-list-view"
      aria-label={`${scopeLabel} tasks`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => { if (dragId) { onReparent(dragId, null); setDragId(null); setDropTarget(null); } }}
    >
      {error && <div className="task-error" role="alert">{error}</div>}
      {visible.length === 0 && (
        <div className="wb-empty-state">
          <strong>No work items in this scope yet.</strong>
          <span>Type the first one below, promote an Inbox thought, or use New item.</span>
          <button type="button" className="wb-newbtn" onClick={onCreate}>Create the first item</button>
        </div>
      )}
      {groupOrder.map((status) => {
        const group = topLevel.filter((task) => task.status === status);
        if (group.length === 0) return null;
        const isFolded = folded[status] ?? false;
        return (
          <div key={status} className="wb-lgroup">
            <button
              type="button"
              className={`wb-gh${isFolded ? "" : " open"}`}
              aria-expanded={!isFolded}
              onClick={() => setFolded((current) => ({ ...current, [status]: !isFolded }))}
            >
              <span className="wb-tw" aria-hidden="true">▸</span>
              <span className={`wb-dot status-${status}`} aria-hidden="true" />
              {statusLabel(status)} <span className="wb-n">{group.length}{isFolded ? " — show" : ""}</span>
            </button>
            {!isFolded && (
              <ol className="task-list" aria-label={`${statusLabel(status)} tasks`}>
                {group.map((task) => row(task, 0))}
              </ol>
            )}
          </div>
        );
      })}
      <QuickAddRow status="backlog" statusName={statusLabel("backlog")} onQuickAdd={onQuickAdd} />
      <button type="button" className="wb-terminal-toggle" onClick={onToggleTerminal}>
        {showTerminal ? "Hide cancelled & archived" : "Show cancelled & archived"}
      </button>
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
  onQuickAdd,
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
  onQuickAdd: QuickAddCreate;
  error: string | null;
}) {
  const boardStatuses = showTerminal ? [...statuses, "cancelled", "archived"] : statuses;
  const query = search.trim().toLowerCase();
  const filtered = tasks.filter((task) => !query || [task.id, task.title, task.projectPath ?? "", ...task.tags].join(" ").toLowerCase().includes(query));
  // Done earns a full column only when asked; empty columns collapse to
  // slivers except while a drag is looking for a destination.
  const [doneOpen, setDoneOpen] = useState(false);

  return (
    <section className="board-view" aria-label={`${scopeLabel} board`}>
      <div className="wb-board-toolbar">
        <label className="board-search">
          <span className="sr-only">Search work items</span>
          <input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search title, ID, project, or tag…" />
        </label>
        <button type="button" className="wb-terminal-toggle" onClick={onToggleTerminal}>{showTerminal ? "Hide cancelled & archived" : "Show cancelled & archived"}</button>
      </div>
      {error && <div className="task-error" role="alert">{error}</div>}
      {tasks.length === 0 ? (
        <div className="board-empty">
          <strong>No work items in this scope yet.</strong>
          <span>Create one here, promote an Inbox thought, or type a list in a project's list view.</span>
          <button type="button" className="primary-action" onClick={onCreate}>Create the first card</button>
        </div>
      ) : (
        <div className="kanban-scroll" aria-label="Kanban board">
          <div className="kanban-grid wb-kanban-flex">
            {boardStatuses.map((status) => {
              const columnTasks = filtered.filter((task) => task.status === status);
              const slim = !draggingTaskId && ((status === "done" && !doneOpen) || (columnTasks.length === 0 && status !== "done"));
              if (slim) {
                return (
                  <button
                    type="button"
                    key={status}
                    className={`wb-col-slim status-${status}`}
                    onClick={() => { if (status === "done") setDoneOpen(true); }}
                    title={status === "done" ? "Show completed cards" : `${statusLabel(status)} is empty`}
                  >
                    <span className={`wb-dot status-${status}`} aria-hidden="true" />
                    <span>{statusLabel(status)} · {columnTasks.length}</span>
                  </button>
                );
              }
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
                  <header>
                    <h2 id={`column-${status}`}>{statusLabel(status)}</h2>
                    <span>{columnTasks.length}</span>
                    {status === "done" && doneOpen && (
                      <button type="button" className="wb-col-fold" onClick={() => setDoneOpen(false)}>fold</button>
                    )}
                  </header>
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
      <div className="wb-viewbar">
        <strong id="activity-heading">{scopeLabel} activity</strong>
        <span className="wb-n">{events.length} entries</span>
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
// renders fields specific to one panel (Project and Status when creating).
function TaskFields({ values, onChange, children }: {
  values: TaskFieldValues;
  onChange: (patch: Partial<TaskFieldValues>) => void;
  children?: ReactNode;
}) {
  return (
    <>
      {children && <div className="field-grid">{children}</div>}
      <label className="field-delegate"><input type="checkbox" checked={values.delegated} onChange={(event) => onChange({ delegated: event.target.checked })} /><span><strong>Hand to an agent</strong><small>An agent runner picks up delegated items on its next pass.</small></span></label>
    </>
  );
}

// Rarely-touched fields sit behind the one "More details" disclosure, shared
// by both panels. `children` renders extra panel-specific fields inside it.
function TaskMoreFields({ values, onChange, tasks, excludeId, children }: {
  values: TaskFieldValues;
  onChange: (patch: Partial<TaskFieldValues>) => void;
  tasks: WorkTask[];
  excludeId?: string;
  children?: ReactNode;
}) {
  // Nobody types record ids by hand: parent is a pick from open tasks.
  const candidates = tasks.filter((task) => task.id !== excludeId && !["done", "cancelled", "archived"].includes(task.status));
  return (
    <details className="task-more-fields">
      <summary>More details</summary>
      <div className="field-grid">
        <label><span>Due date</span><input type="date" value={values.dueAt} onChange={(event) => onChange({ dueAt: event.target.value })} /></label>
        <label><span>Parent task ID</span>
          <select value={values.parentId} onChange={(event) => onChange({ parentId: event.target.value })}>
            <option value="">none</option>
            {values.parentId && !candidates.some((task) => task.id === values.parentId) && <option value={values.parentId}>{values.parentId}</option>}
            {candidates.map((task) => <option key={task.id} value={task.id}>{task.id} — {task.title.slice(0, 42)}{task.title.length > 42 ? "…" : ""}</option>)}
          </select>
        </label>
      </div>
      <label className="field-wide"><span>Tags</span><input value={values.tags} onChange={(event) => onChange({ tags: event.target.value })} placeholder="Comma-separated" /></label>
      {children}
    </details>
  );
}

function CreateTaskPanel({ projects, statuses, defaultProjectPath, tasks, saving, error, onClose, onCreate }: {
  projects: Project[];
  tasks: WorkTask[];
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
      <div className="wb-tp-head"><div><p className="eyebrow">New work item</p><h2 id="create-task-heading">What outcome or task needs tracking?</h2></div><button type="button" onClick={onClose} aria-label="Close new work item">×</button></div>
      <form onSubmit={submit} className="task-form">
        <label className="field-wide"><span className="sr-only">Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Name it in a few words" autoFocus /></label>
        <TaskFields values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}>
          <label><span>Project</span><select value={fields.projectPath} onChange={(event) => setFields((current) => ({ ...current, projectPath: event.target.value }))}><option value="">Unassigned</option>{projects.filter((project) => project.path !== ".").map((project) => <option key={project.id} value={project.path}>{project.name} — {project.path}</option>)}</select></label>
          <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}>{statuses.map((item) => <option key={item} value={item}>{statusLabel(item)}</option>)}</select></label>
        </TaskFields>
        <label className="field-wide"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Background and context — what is this, and what is the situation?" /></label>
        <label className="field-wide"><span>Goal</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="The discrete outcome — what does done accomplish?" /></label>
        <label className="field-wide"><span>Requirements · one per line</span><textarea value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder={"Must preserve Markdown\nMust remain root-scoped"} /></label>
        <label className="field-wide"><span>Acceptance criteria · one per line</span><textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder={"Board reflects status\nRestart restores the card"} /></label>
        <label className="field-wide"><span>Plan</span><textarea value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="How to get there — known steps or research shape" /></label>
        <TaskMoreFields values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))} tasks={tasks} />
        {error && <div className="task-error" role="alert">{error}</div>}
        <div className="task-panel-actions"><button type="button" className="secondary-action" onClick={onClose}>Cancel</button><button type="submit" className="primary-action" disabled={!title.trim() || saving}>{saving ? "Creating…" : "Create work item"}</button></div>
      </form>
    </aside>
  );
}

function WbSection({ label, value, placeholder, onSave, autoEdit, onAbandon }: {
  label: string;
  value: string;
  placeholder: string;
  onSave: (next: string) => void;
  autoEdit?: boolean;
  onAbandon?: () => void;
}) {
  // Read-first: prose renders as prose. The pencil (or the ghost row when the
  // section is empty) swaps in a textarea that saves itself on blur.
  const [editing, setEditing] = useState(autoEdit ?? false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  return (
    <div className="wb-sec">
      <div className="wb-sec-h">
        <span>{label}</span>
        <button type="button" className="wb-pencil" aria-label={`Edit ${label.toLowerCase()}`} onClick={() => setEditing(true)}>✎</button>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            // Nothing typed into a freshly added section: it was never real.
            if (!draft.trim() && !value.trim()) { onAbandon?.(); return; }
            if (draft !== value) onSave(draft);
          }}
          placeholder={placeholder}
        />
      ) : value.trim() ? (
        <div className="wb-sec-prose"><Markdown>{value}</Markdown></div>
      ) : (
        <button type="button" className="wb-sec-add" onClick={() => setEditing(true)}>{placeholder}</button>
      )}
    </div>
  );
}

function TaskDetailPanel({ task, tasks, statuses, saving, error, openQuestions, onClose, onMove, onPatch, onToggle, onLog }: {
  task: WorkTask;
  tasks: WorkTask[];
  statuses: string[];
  saving: boolean;
  error: string | null;
  openQuestions?: ReactNode;
  onClose: () => void;
  onMove: (status: string, note?: string) => void;
  onPatch: (patch: Record<string, unknown>) => void;
  onToggle: (section: "requirements" | "acceptance", index: number, state: ChecklistPatch) => void;
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [fields, setFields] = useState<TaskFieldValues>(taskFieldValues);
  const [dependsOn, setDependsOn] = useState(task.dependsOn.join(", "));
  const [blockedBy, setBlockedBy] = useState(task.blockedBy.join(", "));
  const [blockedReason, setBlockedReason] = useState(task.blockedReason ?? "");
  const [description, setDescription] = useState(task.sections.description);
  const [goal, setGoal] = useState(task.sections.goal);
  const [plan, setPlan] = useState(task.sections.plan);
  const [notes, setNotes] = useState(task.sections.notes);
  const [completionSummary, setCompletionSummary] = useState(task.sections.completionSummary);
  const [addedSections, setAddedSections] = useState<string[]>([]);
  const [newRequirement, setNewRequirement] = useState("");
  const [newAcceptance, setNewAcceptance] = useState("");
  const [logMessage, setLogMessage] = useState("");

  useEffect(() => {
    setTitle(task.title);
    setFields(taskFieldValues());
    setDependsOn(task.dependsOn.join(", ")); setBlockedBy(task.blockedBy.join(", ")); setBlockedReason(task.blockedReason ?? "");
    setDescription(task.sections.description); setGoal(task.sections.goal); setPlan(task.sections.plan); setNotes(task.sections.notes);
    setCompletionSummary(task.sections.completionSummary);
    setAddedSections([]);
  }, [task.id, task.updatedAt]);

  function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onPatch({ tags: commaList(fields.tags), dependsOn: commaList(dependsOn), blockedBy: commaList(blockedBy), blockedReason: blockedReason.trim() || null, parentId: fields.parentId.trim() || null, dueAt: fields.dueAt || null, notes });
  }

  const childTasks = tasks.filter((item) => item.parentId === task.id);
  const progress = checklistProgress(task);

  return (
    <aside className="task-panel" aria-labelledby="task-detail-heading">
      <div className="wb-tp-head">
        <div>
          <p className="eyebrow">{task.id}{task.delegated ? " · handed to an agent" : ""}</p>
          {editingTitle ? (
            <input
              className="wb-title-input"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => { setEditingTitle(false); if (title.trim() && title !== task.title) onPatch({ title: title.trim() }); else setTitle(task.title); }}
              onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); if (event.key === "Escape") { setTitle(task.title); setEditingTitle(false); } }}
              aria-label="Task title"
            />
          ) : (
            <h2 id="task-detail-heading" className="wb-title-read" title="Select to edit the title" onClick={() => setEditingTitle(true)}>{task.title}</h2>
          )}
        </div>
        <div className="wb-tp-close"><button type="button" onClick={onClose} aria-label="Close work item">×</button></div>
      </div>
      <div className="wb-tp-meta">
        <label>
          <span className="sr-only">Status</span>
          <select value={task.status} onChange={(event) => onMove(event.target.value)} disabled={saving} title={progress.complete < progress.total ? "Review unlocks when the checklist is complete." : undefined}>{[...statuses, "cancelled", "archived"].map((status) => <option key={status} value={status} disabled={status === "review" && progress.complete < progress.total} title={status === "review" && progress.complete < progress.total ? "Complete the checklist first." : undefined}>{statusLabel(status)}</option>)}</select>
        </label>
        {task.projectPath && <span className="wb-chip">{displaySegment(pathParts(task.projectPath).at(-1) ?? task.projectPath)}</span>}
        {task.dueAt && <span className={`wb-chip ${scheduleTone({ scheduledAt: task.dueAt, allDay: true }) === "overdue" ? "overdue" : scheduleTone({ scheduledAt: task.dueAt, allDay: true }) === "today" ? "due" : ""}`}>{scheduleLabel({ scheduledAt: task.dueAt, allDay: true }, "due")}</span>}
        {progress.total > 0 && <span className="wb-chip">{progress.complete}/{progress.total} checks</span>}
        {task.tags.map((tag) => <TagChip key={tag} tag={tag} />)}
        <input
          className="wb-strip-addtag"
          placeholder="+ tag"
          aria-label="Add a tag to this task"
          onKeyDown={(event) => {
            const value = (event.target as HTMLInputElement).value.trim().toLowerCase();
            if (event.key === "Enter" && value) {
              onPatch({ tags: normalizeTags([...task.tags, value]) });
              (event.target as HTMLInputElement).value = "";
            }
          }}
        />
      </div>
      {task.status === "review" && progress.complete < progress.total && <div className="task-error" role="status">This legacy review card has unchecked requirements or acceptance criteria. Verify its checklist before treating it as review-ready.</div>}
      {error && <div className="task-error" role="alert">{error}</div>}
      {openQuestions}
      <TaskFields
        values={fields}
        onChange={(patch) => {
          setFields((current) => ({ ...current, ...patch }));
          // Delegation is one tick with immediate meaning; it never waits for
          // a save button.
          if ("delegated" in patch) onPatch({ delegated: patch.delegated });
        }}
      />
      {([
        ["Description", "description", description, (next: string) => { setDescription(next); onPatch({ description: next }); }, "Background and context — what is this, and what is the situation?"],
        ["Goal", "goal", goal, (next: string) => { setGoal(next); onPatch({ goal: next }); }, "The discrete outcome — what does done accomplish?"],
        ["Plan", "plan", plan, (next: string) => { setPlan(next); onPatch({ plan: next }); }, "How to get there — known steps or research shape"],
        ["Outcome", "outcome", completionSummary, (next: string) => { setCompletionSummary(next); onPatch({ completionSummary: next }); }, "What shipped, changed, or was learned?"],
      ] as [string, string, string, (next: string) => void, string][])
        .filter(([, key, value]) => value.trim() || addedSections.includes(key))
        .map(([label, key, value, save, placeholder]) => (
          <WbSection key={key} label={label} value={value} placeholder={placeholder} onSave={save} autoEdit={addedSections.includes(key) && !value.trim()} onAbandon={() => setAddedSections((current) => current.filter((entry) => entry !== key))} />
        ))}
      {([["description", description], ["goal", goal], ["plan", plan], ["outcome", completionSummary]] as [string, string][])
        .filter(([key, value]) => !value.trim() && !addedSections.includes(key)).length > 0 && (
        <div className="wb-sec wb-addsection">
          <div className="wb-sec-h">Add section</div>
          <div className="wb-addsection-row">
            {([["description", description], ["goal", goal], ["plan", plan], ["outcome", completionSummary]] as [string, string][])
              .filter(([key, value]) => !value.trim() && !addedSections.includes(key))
              .map(([key]) => (
                <button type="button" key={key} className="wb-sec-add" onClick={() => setAddedSections((current) => [...current, key])}>+ {key}</button>
              ))}
          </div>
        </div>
      )}
      <form className="task-form" onSubmit={saveDetails}>
        <TaskMoreFields values={fields} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))} tasks={tasks} excludeId={task.id}>
          <div className="field-wide wb-deps"><span>Depends on task IDs</span>
            <div className="wb-deps-chips">
              {commaList(dependsOn).map((id) => (
                <span key={id} className="wb-chip">{id}
                  <button type="button" aria-label={`Remove dependency ${id}`} onClick={() => setDependsOn(commaList(dependsOn).filter((entry) => entry !== id).join(", "))}>×</button>
                </span>
              ))}
              <select
                value=""
                aria-label="Add a dependency"
                onChange={(event) => {
                  const id = event.target.value;
                  if (id && !commaList(dependsOn).includes(id)) setDependsOn([...commaList(dependsOn), id].join(", "));
                }}
              >
                <option value="">+ add a dependency…</option>
                {tasks.filter((candidate) => candidate.id !== task.id && !["done", "cancelled", "archived"].includes(candidate.status)).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.id} — {candidate.title.slice(0, 42)}{candidate.title.length > 42 ? "…" : ""}</option>
                ))}
              </select>
            </div>
          </div>
          <label className="field-wide"><span>Blocked by task IDs</span><input value={blockedBy} onChange={(event) => setBlockedBy(event.target.value)} placeholder="W-0001" /></label>
          <label className="field-wide"><span>Blocker explanation</span><textarea value={blockedReason} onChange={(event) => setBlockedReason(event.target.value)} /></label>
          <label className="field-wide"><span>Notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          <button type="submit" className="primary-action" disabled={saving}>{saving ? "Saving…" : "Save details"}</button>
        </TaskMoreFields>
      </form>

      <TaskChecklist title="Requirements" items={task.requirements} onToggle={(index, state) => onToggle("requirements", index, state)} onRemove={(index) => onPatch({ requirements: task.requirements.filter((_, i) => i !== index) })} />
      <form className="add-check" onSubmit={(event) => { event.preventDefault(); if (!newRequirement.trim()) return; onPatch({ requirements: [...task.requirements, { checked: false, text: newRequirement.trim() }] }); setNewRequirement(""); }}><input value={newRequirement} onChange={(event) => setNewRequirement(event.target.value)} placeholder="Add requirement…" /><button type="submit">Add</button></form>
      <TaskChecklist title="Acceptance" items={task.acceptanceCriteria} onToggle={(index, state) => onToggle("acceptance", index, state)} onRemove={(index) => onPatch({ acceptanceCriteria: task.acceptanceCriteria.filter((_, i) => i !== index) })} />
      <form className="add-check" onSubmit={(event) => { event.preventDefault(); if (!newAcceptance.trim()) return; onPatch({ acceptanceCriteria: [...task.acceptanceCriteria, { checked: false, text: newAcceptance.trim() }] }); setNewAcceptance(""); }}><input value={newAcceptance} onChange={(event) => setNewAcceptance(event.target.value)} placeholder="Add criterion…" /><button type="submit">Add</button></form>

      {childTasks.length > 0 && <section className="task-subsection"><h3>Child work</h3><ul>{childTasks.map((child) => <li key={child.id}><strong>{child.id}</strong> {child.title} <span>{statusLabel(child.status)}</span></li>)}</ul></section>}
      <section className="task-subsection"><h3>Log</h3>{task.log.length === 0 ? <p>No entries yet.</p> : <ol className="task-log">{[...task.log].reverse().map((entry, index) => <li key={`${entry.at}-${index}`}><time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{new Date(entry.at).toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" })} {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time><span>{entry.message}</span></li>)}</ol>}</section>
      <form className="add-log" onSubmit={(event) => { event.preventDefault(); if (!logMessage.trim()) return; void onLog(logMessage.trim()).then(() => setLogMessage("")); }}><label><span>Add progress</span><textarea value={logMessage} onChange={(event) => setLogMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (logMessage.trim()) void onLog(logMessage.trim()).then(() => setLogMessage("")); } }} placeholder="Add progress… (Enter)" /></label><button type="submit" className="primary-action" disabled={!logMessage.trim()}>Append to log</button></form>
    </aside>
  );
}

function TaskChecklist({ title, items, onToggle, onRemove }: { title: string; items: ChecklistItem[]; onToggle: (index: number, state: ChecklistPatch) => void; onRemove: (index: number) => void }) {
  // Humans tick boxes or delete rows; "declined" is an agent's report verb
  // and renders read-only when an agent recorded one.
  return (
    <section className="task-subsection"><h3>{title}</h3>{items.length === 0 ? null : <ul className="task-checklist">{items.map((item, index) => (
      <li key={`${item.text}-${index}`} className={item.declined ? "declined" : undefined}>
        <label><input type="checkbox" checked={item.checked} onChange={(event) => onToggle(index, { checked: event.target.checked })} /><span>{item.text}</span></label>
        <button type="button" className="check-remove" aria-label={`Remove: ${item.text}`} onClick={() => onRemove(index)}>×</button>
        {item.declined && <p className="check-reason">Declined by an agent: {item.reason || "no reason recorded"}</p>}
      </li>
    ))}</ul>}</section>
  );
}
