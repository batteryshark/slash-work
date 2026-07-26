import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const STARTUP_TIMEOUT_MS = 12_000;
const STOP_TIMEOUT_MS = 3_000;

function requireUv() {
  const probe = spawnSync("uv", ["--version"], { stdio: "ignore" });
  if (probe.error?.code === "ENOENT" || probe.status !== 0) {
    throw new Error("MCP requires uv. Install it from https://docs.astral.sh/uv/getting-started/installation/ and run work --mcp again.");
  }
}

export async function startMcpSidecar({ apiOrigin, projectRoot }) {
  requireUv();
  const project = resolve(projectRoot, "mcp");
  const secret = randomBytes(32).toString("base64url");
  const child = spawn("uv", ["run", "--project", project, "--locked", "python", "-m", "slash_work_mcp"], {
    env: { ...process.env, WORK_MCP_API_ORIGIN: apiOrigin, WORK_MCP_PROXY_SECRET: secret },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
    process.stderr.write(`[work:mcp] ${chunk}`);
  });
  const ready = await new Promise((resolveReady, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("sidecar readiness timed out")), STARTUP_TIMEOUT_MS);
    const fail = (message) => { clearTimeout(timeout); reject(new Error(message)); };
    child.once("error", (error) => fail(error.message));
    child.once("exit", (code, signal) => fail(`sidecar exited before readiness (${code ?? signal}). ${stderr}`));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "ready" && Number.isInteger(event.port)) {
            clearTimeout(timeout);
            resolveReady(event);
          }
        } catch {}
      }
      output = output.slice(output.lastIndexOf("\n") + 1);
    });
  }).catch((error) => { child.kill("SIGTERM"); throw error; });
  let stopped = false;
  child.once("exit", (code, signal) => {
    if (!stopped) console.error(`[work:mcp] Sidecar exited unexpectedly (${code ?? signal}). MCP requests will return 503.`);
  });
  return {
    port: ready.port,
    secret,
    get ready() { return !stopped && child.exitCode == null; },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode != null) return;
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolveStop) => setTimeout(resolveStop, STOP_TIMEOUT_MS))]);
      if (child.exitCode == null) child.kill("SIGKILL");
    },
  };
}
