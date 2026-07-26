import os
from typing import Any

import httpx


class WorkError(Exception):
    def __init__(self, message: str, code: str = "work_error") -> None:
        super().__init__(message)
        self.code = code


class WorkClient:
    def __init__(self) -> None:
        origin = os.environ.get("WORK_MCP_API_ORIGIN")
        if not origin:
            raise RuntimeError("WORK_MCP_API_ORIGIN is required")
        self.client = httpx.AsyncClient(base_url=origin, timeout=httpx.Timeout(10.0, connect=3.0))

    async def request(self, method: str, path: str, *, workspace_id: str | None = None, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None) -> Any:
        headers = {"X-Work-Workspace": workspace_id} if workspace_id else {}
        try:
            response = await self.client.request(method, path, headers=headers, params=params, json=body)
        except httpx.TimeoutException as error:
            raise WorkError(f"Work timed out while handling {method} {path}.", "api_timeout") from error
        except httpx.HTTPError as error:
            raise WorkError(f"Work is unavailable while handling {method} {path}.", "api_unavailable") from error
        try:
            payload = response.json()
        except ValueError as error:
            raise WorkError("Work returned an invalid response.", "invalid_api_response") from error
        if response.is_error:
            details = payload.get("error", {}) if isinstance(payload, dict) else {}
            raise WorkError(details.get("message", "Work rejected the request."), details.get("code", "work_error"))
        return payload

    async def close(self) -> None:
        await self.client.aclose()
