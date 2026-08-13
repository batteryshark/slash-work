from typing import Any

from fastmcp import FastMCP

from .work_client import WorkClient, WorkError

client = WorkClient()
mcp = FastMCP("Work")


def result(workspace_id: str | None, payload: Any) -> dict[str, Any]:
    selected = workspace_id or payload.get("workspace", {}).get("id") if isinstance(payload, dict) else workspace_id
    return {"workspace_id": selected, "result": payload}


def compact(**fields: Any) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value is not None}


async def call(method: str, path: str, workspace_id: str | None = None, *, agent_name: str | None = None, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        return result(workspace_id, await client.request(method, path, workspace_id=workspace_id, agent_name=agent_name, params=params, body=body))
    except WorkError as error:
        raise ValueError(f"{error.code}: {error}") from error


def require_agent(agent_name: str | None) -> str:
    name = (agent_name or client.agent_name or "").strip()
    if not name:
        raise ValueError("agent_identity_required: pass agent_name or set WORK_AGENT_NAME.")
    return name


@mcp.tool(annotations={"readOnlyHint": True})
async def workspaces_list() -> dict[str, Any]:
    """List available local Work workspaces."""
    return await call("GET", "/api/workspaces")


@mcp.tool(annotations={"readOnlyHint": True})
async def projects_list(workspace_id: str) -> dict[str, Any]:
    """List exact project paths in one workspace."""
    return await call("GET", "/api/projects", workspace_id)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def project_create(workspace_id: str, name: str, parent_path: str | None = None) -> dict[str, Any]:
    """Create a new project: Work makes the folder from a slug of the name and writes the project marker."""
    return await call("POST", "/api/projects", workspace_id, body=compact(name=name, parentPath=parent_path))


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def project_update(workspace_id: str, project_path: str, name: str | None = None,
                         description: str | None = None, view: str | None = None,
                         tags: list[str] | None = None) -> dict[str, Any]:
    """Update one project's profile. Only the fields you pass change; tags REPLACE the
    project's list (pass [] to clear). view is board or list."""
    return await call("PATCH", "/api/projects/profile", workspace_id,
                      body=compact(projectPath=project_path, name=name,
                                   description=description, view=view, tags=tags))


@mcp.tool(annotations={"readOnlyHint": True})
async def tasks_list(workspace_id: str, updated_since: str | None = None) -> dict[str, Any]:
    """List task records in one workspace, optionally only those updated after updated_since (ISO-8601)."""
    return await call("GET", "/api/tasks", workspace_id, params={"updatedSince": updated_since} if updated_since else None)


@mcp.tool(annotations={"readOnlyHint": True})
async def task_get(workspace_id: str, id: str) -> dict[str, Any]:
    """Read one task by stable ID."""
    return await call("GET", f"/api/tasks/{id}", workspace_id)


@mcp.tool(annotations={"readOnlyHint": True})
async def decisions_list(workspace_id: str) -> dict[str, Any]:
    """List decisions awaiting explicit human choices."""
    return await call("GET", "/api/decisions", workspace_id)


@mcp.tool(annotations={"readOnlyHint": True})
async def files_list(workspace_id: str, scope_path: str = ".", path: str = ".") -> dict[str, Any]:
    """List one contained directory through Work's read-only file boundary."""
    return await call("GET", "/api/files/directory", workspace_id, params={"scopePath": scope_path, "path": path})


@mcp.tool(annotations={"readOnlyHint": True})
async def file_read(workspace_id: str, scope_path: str = ".", path: str = "") -> dict[str, Any]:
    """Read one safe text file through Work's read-only file boundary."""
    return await call("GET", "/api/files/content", workspace_id, params={"scopePath": scope_path, "path": path})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def capture_create(workspace_id: str, text: str, kind: str | None = None, scope_path: str | None = None, project_path: str | None = None) -> dict[str, Any]:
    """Preserve a thought without creating executable work."""
    return await call("POST", "/api/captures", workspace_id, body=compact(text=text, kind=kind, scopePath=scope_path, projectPath=project_path))


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def decision_create(workspace_id: str, title: str, project_path: str | None = None, detail: str | None = None, options: list[str] | None = None, recommended_option: str | None = None, refs: list[str] | None = None) -> dict[str, Any]:
    """Create an explicit human decision request. refs links the question to the Work items it is about (for example a task id such as W-0001)."""
    return await call("POST", "/api/decisions", workspace_id, body={"title": title, "projectPath": project_path, "detail": detail or "", "options": options or [], "recommendedOption": recommended_option, "refs": refs or []})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def task_create(workspace_id: str, title: str, project_path: str | None = None, status: str | None = None, delegated: bool | None = None, description: str | None = None, goal: str | None = None, requirements: list[str] | None = None, acceptance_criteria: list[str] | None = None, plan: str | None = None, notes: str | None = None, tags: list[str] | None = None, refs: list[str] | None = None) -> dict[str, Any]:
    """Create authorized executable work with acceptance criteria. description is background context; goal is the discrete outcome. delegated is a human-only signal; Work rejects it from agent identities."""
    return await call("POST", "/api/tasks", workspace_id, body=compact(title=title, projectPath=project_path, status=status, delegated=delegated, description=description, goal=goal, requirements=requirements, acceptanceCriteria=acceptance_criteria, plan=plan, notes=notes, tags=tags, refs=refs))


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def task_move(workspace_id: str, id: str, status: str, note: str | None = None) -> dict[str, Any]:
    """Move a task through an explicit lifecycle transition."""
    return await call("POST", f"/api/tasks/{id}/move", workspace_id, body={"status": status, "note": note})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def task_log(workspace_id: str, id: str, message: str) -> dict[str, Any]:
    """Append durable task progress without changing status."""
    return await call("POST", f"/api/tasks/{id}/log", workspace_id, body={"message": message})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def task_checklist(workspace_id: str, id: str, section: str, index: int, checked: bool) -> dict[str, Any]:
    """Check or reopen one requirement or acceptance checklist item. Section is requirements or acceptance; index is zero-based."""
    return await call("POST", f"/api/tasks/{id}/checklist", workspace_id, body={"section": section, "index": index, "checked": checked})


@mcp.tool(annotations={"readOnlyHint": True})
async def issues_list(workspace_id: str, updated_since: str | None = None, agent_name: str | None = None) -> dict[str, Any]:
    """List issue conversations available for agent investigation, optionally only those updated after updated_since (ISO-8601)."""
    return await call("GET", "/api/agent/issues", workspace_id, agent_name=require_agent(agent_name), params={"updatedSince": updated_since} if updated_since else None)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def issue_create(workspace_id: str, title: str, body: str, agent_name: str | None = None) -> dict[str, Any]:
    """File a new issue attributed to this agent; a human decides whether it becomes work."""
    return await call("POST", "/api/agent/issues", workspace_id, agent_name=require_agent(agent_name), body={"title": title, "body": body})


@mcp.tool(annotations={"readOnlyHint": True})
async def issue_get(workspace_id: str, id: str, agent_name: str | None = None) -> dict[str, Any]:
    """Read one issue with its replies, ownership, and state history."""
    return await call("GET", f"/api/agent/issues/{id}", workspace_id, agent_name=require_agent(agent_name))


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def issue_claim(workspace_id: str, id: str, agent_name: str | None = None) -> dict[str, Any]:
    """Claim one queued issue and mark it in progress."""
    return await call("POST", f"/api/agent/issues/{id}/claim", workspace_id, agent_name=require_agent(agent_name))


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def issue_reply(workspace_id: str, id: str, body: str, agent_name: str | None = None) -> dict[str, Any]:
    """Append an attributed Markdown reply to an issue claimed by this agent."""
    return await call("POST", f"/api/agent/issues/{id}/replies", workspace_id, agent_name=require_agent(agent_name), body={"body": body})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def issue_update_state(workspace_id: str, id: str, state: str, reason: str | None = None, resolution_summary: str | None = None, agent_name: str | None = None) -> dict[str, Any]:
    """Set a claimed issue to in_progress, needs_human, or resolved. Resolving requires resolution_summary."""
    return await call("POST", f"/api/agent/issues/{id}/state", workspace_id, agent_name=require_agent(agent_name), body=compact(state=state, reason=reason, resolutionSummary=resolution_summary))
