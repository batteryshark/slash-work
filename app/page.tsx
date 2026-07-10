"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type ScopeLevel = "all" | "area" | "project";

type Project = {
  id: string;
  name: string;
  code: string;
  area: string;
  state: "Active" | "Quiet" | "Needs you";
  ideas: number;
  active: number;
  focus: string;
  lastUpdate: string;
  nextAction: string;
  context: string;
};

type AttentionItem = {
  id: string;
  project: string;
  label: string;
  title: string;
  detail: string;
  action: string;
};

type CapturedItem = {
  id: string;
  text: string;
  projectId: string | null;
  projectName: string;
  kind: "Idea" | "Question" | "Update";
  createdAt: string;
};

const projects: Project[] = [
  {
    id: "lucent",
    name: "Lucent",
    code: "LC",
    area: "Software",
    state: "Quiet",
    ideas: 0,
    active: 0,
    focus: "No active work",
    lastUpdate: "The project is registered and ready when a direction emerges.",
    nextAction: "Capture the first useful thread when it appears",
    context: "Lucent has intentionally been left quiet. An empty project is allowed to stay empty without becoming an obligation.",
  },
  {
    id: "agent-riskmap",
    name: "Agent Riskmap",
    code: "AR",
    area: "Software",
    state: "Active",
    ideas: 1,
    active: 2,
    focus: "Public release",
    lastUpdate: "The release sequence is license, public repository, deployment, then announcement.",
    nextAction: "Confirm AGPLv3 compatibility before changing repository visibility",
    context: "The release plan is ordered so public communication cannot outrun licensing and deployment readiness.",
  },
  {
    id: "unmask",
    name: "Unmask",
    code: "UM",
    area: "Software",
    state: "Needs you",
    ideas: 2,
    active: 1,
    focus: "Evaluation corpus",
    lastUpdate: "The note asks for at least nine examples but specifies five source-only and five binary-only examples.",
    nextAction: "Resolve whether the target is nine or ten examples",
    context: "The evaluation should cover source-only and binary-only analysis without silently changing the intended sample size.",
  },
  {
    id: "rekb",
    name: "ReKB",
    code: "KB",
    area: "Software",
    state: "Active",
    ideas: 3,
    active: 1,
    focus: "Repository curation",
    lastUpdate: "OKF skills and useful peLab material have been identified as candidate inputs.",
    nextAction: "Shape the curation plan before publishing the repository",
    context: "ReKB should become a curated knowledge asset rather than a direct dump of every prior experiment.",
  },
  {
    id: "rekit",
    name: "ReKit",
    code: "RK",
    area: "Software",
    state: "Active",
    ideas: 7,
    active: 3,
    focus: "Packaging architecture",
    lastUpdate: "Static and dynamic analysis tools need different packaging models.",
    nextAction: "Decide whether tool binaries belong inside packages or install separately",
    context: "The packaging model must cover skills, scripts, assets, references, and platform-specific tools without turning ReKit into an opaque bundle.",
  },
  {
    id: "rekit-factory",
    name: "ReKit Factory",
    code: "RF",
    area: "Software",
    state: "Needs you",
    ideas: 5,
    active: 2,
    focus: "Provider controls",
    lastUpdate: "Global and per-job model settings need to support local compatible endpoints.",
    nextAction: "Define the smallest provider registration and model override flow",
    context: "Factory owns execution concerns that should not leak into the portable ReKit package surface.",
  },
  {
    id: "toolstack",
    name: "Toolstack",
    code: "TS",
    area: "Software",
    state: "Active",
    ideas: 1,
    active: 1,
    focus: "Sandbox validation",
    lastUpdate: "The bwrap and seatbelt changes still need a clean local build test.",
    nextAction: "Run the local validation matrix before proposing the merge",
    context: "The merge proposal should include evidence that Linux bwrap and macOS seatbelt behavior still match the intended isolation contract.",
  },
  {
    id: "parallax",
    name: "Parallax",
    code: "PX",
    area: "Software",
    state: "Quiet",
    ideas: 2,
    active: 0,
    focus: "Release readiness",
    lastUpdate: "README cleanup and a simple sharp identity are the remaining publication threads.",
    nextAction: "Shape the release checklist before starting visual work",
    context: "Parallax is not active yet. Its captured publication work remains visible without competing with current execution.",
  },
];

const attentionItems: AttentionItem[] = [
  {
    id: "ida-ownership",
    project: "ReKit · ReKit Factory",
    label: "Ownership",
    title: "IDA lab ownership",
    detail: "The lab is useful to agents but cannot ship inside the portable pack. Decide which project owns its configuration and lifecycle.",
    action: "Assign to ReKit Factory",
  },
  {
    id: "unmask-count",
    project: "Unmask",
    label: "Clarify",
    title: "Unmask 9-vs-10 examples",
    detail: "The captured thought says at least nine examples, then asks for five source-only and five binary-only reports.",
    action: "Use 10 examples",
  },
  {
    id: "agpl-approval",
    project: "Portfolio",
    label: "Approval",
    title: "AGPLv3 migration",
    detail: "Agent Riskmap, Unmask, and Toolstack all include the same licensing change. Treat it as one decision with project-specific applications.",
    action: "Approve the migration plan",
  },
];

const storageKeys = {
  captures: "work.captures.v1",
  project: "work.project.v1",
  scope: "work.scope.v1",
  resolved: "work.resolved.v1",
};

function inferKind(text: string): CapturedItem["kind"] {
  const lower = text.toLowerCase();
  if (text.includes("?") || /\b(should|could|whether|figure out|understand)\b/.test(lower)) return "Question";
  if (/\b(done|finished|completed|decided|figured out|fixed)\b/.test(lower)) return "Update";
  return "Idea";
}

function cleanCommand(text: string) {
  return text.replace(/^\s*\/work\s*/i, "").trim();
}

function inferProject(text: string) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return projects.find((project) => {
    const name = project.name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    return normalized.includes(name) || normalized.includes(project.id.replace(/-/g, " "));
  });
}

function timeLabel(iso: string) {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function Home() {
  const [scope, setScope] = useState<ScopeLevel>("project");
  const [selectedProjectId, setSelectedProjectId] = useState("rekit");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [expandedAttention, setExpandedAttention] = useState<string | null>(null);
  const [resolvedAttention, setResolvedAttention] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [captures, setCaptures] = useState<CapturedItem[]>([]);
  const [capturesOpen, setCapturesOpen] = useState(false);
  const [status, setStatus] = useState("Ready when you are.");
  const [lastCaptureId, setLastCaptureId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[4];
  const activeAttention = attentionItems.filter((item) => !resolvedAttention.includes(item.id));

  useEffect(() => {
    try {
      const storedCaptures = localStorage.getItem(storageKeys.captures);
      const storedProject = localStorage.getItem(storageKeys.project);
      const storedScope = localStorage.getItem(storageKeys.scope) as ScopeLevel | null;
      const storedResolved = localStorage.getItem(storageKeys.resolved);

      if (storedCaptures) setCaptures(JSON.parse(storedCaptures));
      if (storedProject && projects.some((project) => project.id === storedProject)) setSelectedProjectId(storedProject);
      if (storedScope && ["all", "area", "project"].includes(storedScope)) setScope(storedScope);
      if (storedResolved) setResolvedAttention(JSON.parse(storedResolved));
    } catch {
      setStatus("Your workspace is ready. Previous local preferences could not be restored.");
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(storageKeys.captures, JSON.stringify(captures));
  }, [captures, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(storageKeys.project, selectedProjectId);
    localStorage.setItem(storageKeys.scope, scope);
  }, [hydrated, scope, selectedProjectId]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(storageKeys.resolved, JSON.stringify(resolvedAttention));
  }, [hydrated, resolvedAttention]);

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

  const scopeName = useMemo(() => {
    if (scope === "all") return "General inbox";
    if (scope === "area") return "Software inbox";
    return selectedProject.name;
  }, [scope, selectedProject.name]);

  function navigateToProject(projectId: string) {
    setSelectedProjectId(projectId);
    setScope("project");
    setContextOpen(false);
    setProjectMenuOpen(false);
    const project = projects.find((item) => item.id === projectId);
    setStatus(`${project?.name ?? "Project"} is in focus.`);
  }

  function runCommand() {
    const text = cleanCommand(command);
    if (!text) {
      setStatus("Write anything you want remembered. No formatting needed.");
      inputRef.current?.focus();
      return;
    }

    const lower = text.toLowerCase();
    const mentionedProject = inferProject(text);

    if (/\b(show|focus|open|take me to)\b/.test(lower)) {
      if (/\b(everything|all work|portfolio)\b/.test(lower)) {
        setScope("all");
        setStatus("Showing all work. New thoughts will go to the general inbox.");
        setCommand("");
        return;
      }
      if (/\bsoftware\b/.test(lower) && !mentionedProject) {
        setScope("area");
        setStatus("Showing Software. New thoughts will go to the Software inbox.");
        setCommand("");
        return;
      }
      if (mentionedProject) {
        navigateToProject(mentionedProject.id);
        setCommand("");
        return;
      }
    }

    if (/\b(what was i doing|continue|resume|pick up where)\b/.test(lower)) {
      setScope("project");
      setContextOpen(true);
      setStatus(`${selectedProject.focus} is ready. Your next action is highlighted.`);
      setCommand("");
      return;
    }

    const targetProject = mentionedProject ?? (scope === "project" ? selectedProject : null);
    const captured: CapturedItem = {
      id: `capture-${Date.now()}`,
      text,
      projectId: targetProject?.id ?? null,
      projectName: targetProject?.name ?? scopeName,
      kind: inferKind(text),
      createdAt: new Date().toISOString(),
    };

    setCaptures((items) => [captured, ...items]);
    setLastCaptureId(captured.id);
    setCommand("");
    setStatus(`Saved in ${captured.projectName}. Nothing was started.`);
  }

  function handleCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runCommand();
  }

  function undoLastCapture() {
    if (!lastCaptureId) return;
    setCaptures((items) => items.filter((item) => item.id !== lastCaptureId));
    setLastCaptureId(null);
    setStatus("Capture undone. Nothing else changed.");
  }

  function resolveAttention(item: AttentionItem) {
    setResolvedAttention((items) => [...items, item.id]);
    setExpandedAttention(null);
    setStatus(`${item.title} recorded: ${item.action}.`);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      runCommand();
      return;
    }
    if (event.key === "Escape") {
      setCommand("");
      event.currentTarget.blur();
      setStatus("Capture cleared. Nothing was saved.");
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to your next action</a>

      <header className="topbar">
        <button className="brand" type="button" onClick={() => setScope("all")} aria-label="Go to all work">
          <span className="brand-mark" aria-hidden="true">/</span>
          <span>work</span>
        </button>

        <nav className="breadcrumbs" aria-label="Current scope">
          <button type="button" onClick={() => setScope("all")} aria-current={scope === "all" ? "page" : undefined}>All work</button>
          <span aria-hidden="true">›</span>
          <button type="button" onClick={() => setScope("area")} aria-current={scope === "area" ? "page" : undefined}>Software</button>
          {scope === "project" && (
            <>
              <span aria-hidden="true">›</span>
              <button type="button" aria-current="page" onClick={() => setProjectMenuOpen((open) => !open)}>{selectedProject.name}</button>
            </>
          )}
        </nav>

        <div className="header-actions">
          <button className="project-switch" type="button" onClick={() => setProjectMenuOpen((open) => !open)} aria-expanded={projectMenuOpen}>
            <span>{projects.length} projects</span>
            <span aria-hidden="true">⌄</span>
          </button>
        </div>

        {projectMenuOpen && (
          <div className="project-menu" aria-label="Choose a project">
            <p className="eyebrow">Jump to a project</p>
            <div className="project-menu-grid">
              {projects.map((project) => (
                <button type="button" key={project.id} onClick={() => navigateToProject(project.id)} className={project.id === selectedProject.id ? "selected" : ""}>
                  <span className="project-code" aria-hidden="true">{project.code}</span>
                  <span><strong>{project.name}</strong><small>{project.focus}</small></span>
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      <aside className="flow-rail" aria-label="Your working flow">
        <div className="rail-line" aria-hidden="true" />
        <div className="rail-step current">
          <span>1</span>
          <div><strong>One next thing</strong><small>{scope === "project" ? selectedProject.focus : "Choose a project"}</small></div>
        </div>
        <div className="rail-step">
          <span>2</span>
          <div><strong>Needs you</strong><small>{activeAttention.length} {activeAttention.length === 1 ? "decision" : "decisions"}</small></div>
        </div>
        <div className="rail-step">
          <span>3</span>
          <div><strong>Capture anytime</strong><small>Use /work below</small></div>
        </div>
      </aside>

      <main id="main-content" className="main-content">
        {scope === "project" ? (
          <ProjectFocus project={selectedProject} contextOpen={contextOpen} onToggleContext={() => setContextOpen((open) => !open)} />
        ) : (
          <PortfolioView scope={scope} projects={projects} onOpenProject={navigateToProject} />
        )}

        <section className="attention-section" aria-labelledby="needs-you-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Only real interruptions</p>
              <h2 id="needs-you-heading">Needs you</h2>
            </div>
            <span className="count-badge" aria-label={`${activeAttention.length} unresolved items`}>{activeAttention.length}</span>
          </div>

          {activeAttention.length === 0 ? (
            <div className="empty-attention"><strong>Nothing needs a decision.</strong><span>Ordinary work stays out of this list.</span></div>
          ) : (
            <div className="attention-list">
              {activeAttention.map((item) => {
                const open = expandedAttention === item.id;
                return (
                  <article className={`attention-item ${open ? "open" : ""}`} key={item.id}>
                    <button type="button" className="attention-summary" onClick={() => setExpandedAttention(open ? null : item.id)} aria-expanded={open}>
                      <span className="attention-check" aria-hidden="true" />
                      <span className="attention-copy">
                        <small>{item.project} · {item.label}</small>
                        <strong>{item.title}</strong>
                      </span>
                      <span className="review-label">{open ? "Close" : "Review"}</span>
                    </button>
                    {open && (
                      <div className="attention-detail">
                        <p>{item.detail}</p>
                        <button type="button" onClick={() => resolveAttention(item)}>{item.action}<span aria-hidden="true">→</span></button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {capturesOpen && (
          <section className="captured-section" aria-labelledby="captured-heading">
            <div className="section-heading compact">
              <div><p className="eyebrow">Remembered for you</p><h2 id="captured-heading">Recent captures</h2></div>
              <button type="button" onClick={() => setCapturesOpen(false)}>Hide</button>
            </div>
            {captures.length === 0 ? (
              <p className="capture-empty">Your captured thoughts will appear here. Nothing needs organizing first.</p>
            ) : (
              <ul className="capture-list">
                {captures.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <span className="capture-kind">{item.kind}</span>
                    <div><strong>{item.text}</strong><small>{item.projectName} · {timeLabel(item.createdAt)}</small></div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>

      <div className="capture-dock">
        <form onSubmit={handleCommand} aria-label="Universal work command">
          <div className="capture-context">
            <span className="capture-symbol" aria-hidden="true">/</span>
            <div><strong>Capture anything</strong><small>Going to {scopeName}</small></div>
          </div>
          <label className="sr-only" htmlFor="work-command">Tell Work anything you want remembered</label>
          <input
            ref={inputRef}
            id="work-command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Tell /work anything…"
            autoComplete="off"
          />
          <button className="remember-button" type="submit">Remember it <span aria-hidden="true">↵</span></button>
        </form>
        <div className="capture-meta">
          <span aria-live="polite">{status}</span>
          <div>
            {lastCaptureId && <button type="button" onClick={undoLastCapture}>Undo</button>}
            <button type="button" onClick={() => setCapturesOpen((open) => !open)}>{captures.length} captured</button>
            <span className="shortcut-hint"><kbd>/</kbd> focus</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectFocus({ project, contextOpen, onToggleContext }: { project: Project; contextOpen: boolean; onToggleContext: () => void }) {
  return (
    <section className="focus-section" aria-labelledby="focus-heading">
      <article className="focus-card">
        <div className="focus-topline">
          <p className="continue-label"><span aria-hidden="true" /> Continue</p>
          <span className={`state-pill state-${project.state.toLowerCase().replace(/\s+/g, "-")}`}>{project.name} · {project.focus}</span>
        </div>
        <h1 id="focus-heading">{project.name} {project.focus.toLowerCase()}</h1>

        <div className="focus-facts">
          <div className="fact-card">
            <span>Last meaningful update</span>
            <p>{project.lastUpdate}</p>
          </div>
          <div className="fact-card next">
            <span>Next action</span>
            <p>{project.nextAction}</p>
          </div>
        </div>

        {contextOpen && (
          <div className="context-panel">
            <div><span>Why this matters</span><p>{project.context}</p></div>
            <div><span>Current shape</span><p>{project.active} active thread{project.active === 1 ? "" : "s"} · {project.ideas} captured idea{project.ideas === 1 ? "" : "s"}</p></div>
          </div>
        )}

        <div className="focus-footer">
          <p>{contextOpen ? "Context is open. Your next action stays visible." : "No setup needed — context is ready."}</p>
          <button className="primary-action" type="button" onClick={onToggleContext}>{contextOpen ? "Hide context" : "Continue work"}<span aria-hidden="true">→</span></button>
        </div>
      </article>
    </section>
  );
}

function PortfolioView({ scope, projects, onOpenProject }: { scope: Exclude<ScopeLevel, "project">; projects: Project[]; onOpenProject: (id: string) => void }) {
  const activeCount = projects.filter((project) => project.active > 0).length;
  const ideaCount = projects.reduce((sum, project) => sum + project.ideas, 0);
  return (
    <section className="portfolio-section" aria-labelledby="portfolio-heading">
      <div className="portfolio-intro">
        <p className="continue-label"><span aria-hidden="true" /> Zoomed out</p>
        <h1 id="portfolio-heading">{scope === "all" ? "All work" : "Software"}</h1>
        <p>See the shape of everything without turning every thread into an equal emergency.</p>
        <div className="portfolio-stats" aria-label="Portfolio summary">
          <span><strong>{projects.length}</strong> projects</span>
          <span><strong>{activeCount}</strong> active</span>
          <span><strong>{ideaCount}</strong> captured ideas</span>
        </div>
      </div>
      <div className="project-grid">
        {projects.map((project) => (
          <button type="button" className="project-card" key={project.id} onClick={() => onOpenProject(project.id)}>
            <span className="project-card-code" aria-hidden="true">{project.code}</span>
            <span className="project-card-copy"><small>{project.state}</small><strong>{project.name}</strong><span>{project.focus}</span></span>
            <span className="project-card-meta">{project.active > 0 ? `${project.active} active` : "Quiet"}<span aria-hidden="true">→</span></span>
          </button>
        ))}
      </div>
    </section>
  );
}
