import asyncio
import json
import os
import socket
import sys

import uvicorn

from .server import client, mcp


class PrivateProxy:
    def __init__(self, app, secret: str) -> None:
        self.app = app
        self.secret = secret

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            if headers.get(b"x-work-mcp-proxy") != self.secret.encode():
                await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": b'{"error":"private MCP proxy authentication required"}'})
                return
        await self.app(scope, receive, send)


async def main() -> None:
    secret = os.environ.get("WORK_MCP_PROXY_SECRET")
    if not secret:
        raise RuntimeError("WORK_MCP_PROXY_SECRET is required")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    sock.setblocking(False)
    port = sock.getsockname()[1]
    app = PrivateProxy(mcp.http_app(path="/mcp", transport="streamable-http", stateless_http=True, json_response=True), secret)
    config = uvicorn.Config(app, log_level="warning")
    server = uvicorn.Server(config)
    print(json.dumps({"type": "ready", "port": port}), flush=True)
    await server.serve(sockets=[sock])
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
