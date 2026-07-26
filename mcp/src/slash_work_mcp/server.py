from typing import Any

from fastmcp import FastMCP

from .work_client import WorkClient, WorkError

client = WorkClient()
mcp = FastMCP("Work")


def result(workspace_id: str | None, payload: Any) -> dict[str, Any]:
    selected = workspace_id or payload.get("workspace", {}).get("id") if isinstance(payload, dict) else workspace_id
    return {"workspace_id": selected, "result": payload}


async def call(method: str, path: str, workspace_id: str | None = None, *, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        return result(workspace_id, await client.request(method, path, workspace_id=workspace_id, params=params, body=body))
    except WorkError as error:
        raise ValueError(f"{error.code}: {error}") from error


@mcp.tool(annotations={"readOnlyHint": True})
async def workspaces_list() -> dict[str, Any]:
    """List available local and federated Work workspaces."""
    return await call("GET", "/api/workspaces")


@mcp.tool(annotations={"readOnlyHint": True})
async def projects_list(workspace_id: str) -> dict[str, Any]:
    """List exact project paths in one workspace."""
    return await call("GET", "/api/projects", workspace_id)


@mcp.tool(annotations={"readOnlyHint": True})
async def tasks_list(workspace_id: str) -> dict[str, Any]:
    """List task records in one workspace."""
    return await call("GET", "/api/tasks", workspace_id)


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
    body = {"text": text, "kind": kind, "scopePath": scope_path, "projectPath": project_path}
    return await call("POST", "/api/captures", workspace_id, body={key: value for key, value in body.items() if value is not None})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def idea_create(workspace_id: str, title: str, project_path: str | None = None, scope_path: str | None = None, opportunity: str | None = None, why_it_might_matter: str | None = None, hypothesis: str | None = None, unknowns: str | None = None, tags: list[str] | None = None) -> dict[str, Any]:
    """Record a possibility for later evaluation."""
    body = {"title": title, "projectPath": project_path, "scopePath": scope_path, "opportunity": opportunity, "whyItMightMatter": why_it_might_matter, "hypothesis": hypothesis, "unknowns": unknowns, "tags": tags}
    return await call("POST", "/api/ideas", workspace_id, body={key: value for key, value in body.items() if value is not None})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def decision_create(workspace_id: str, title: str, project_path: str | None = None, detail: str | None = None, options: list[str] | None = None, recommended_option: str | None = None) -> dict[str, Any]:
    """Create an explicit human decision request."""
    return await call("POST", "/api/decisions", workspace_id, body={"title": title, "projectPath": project_path, "detail": detail or "", "options": options or [], "recommendedOption": recommended_option})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def task_create(workspace_id: str, title: str, project_path: str | None = None, type: str | None = None, priority: str | None = None, status: str | None = None, goal: str | None = None, requirements: list[str] | None = None, acceptance_criteria: list[str] | None = None, plan: str | None = None, notes: str | None = None, tags: list[str] | None = None, agents: list[str] | None = None) -> dict[str, Any]:
    """Create authorized executable work with acceptance criteria."""
    body = {"title": title, "projectPath": project_path, "type": type, "priority": priority, "status": status, "goal": goal, "requirements": requirements, "acceptanceCriteria": acceptance_criteria, "plan": plan, "notes": notes, "tags": tags, "agents": agents}
    return await call("POST", "/api/tasks", workspace_id, body={key: value for key, value in body.items() if value is not None})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def task_move(workspace_id: str, id: str, status: str, note: str | None = None) -> dict[str, Any]:
    """Move a task through an explicit lifecycle transition."""
    return await call("POST", f"/api/tasks/{id}/move", workspace_id, body={"status": status, "note": note})


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
async def task_log(workspace_id: str, id: str, message: str) -> dict[str, Any]:
    """Append durable task progress without changing status."""
    return await call("POST", f"/api/tasks/{id}/log", workspace_id, body={"message": message})
