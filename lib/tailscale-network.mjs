import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { WorkspaceError } from "./local-workspace.mjs";

const execFile = promisify(execFileCallback);

export function isTailscaleIPv4(value) {
  if (typeof value !== "string") return false;
  const octets = value.trim().split(".").map(Number);
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 100
    && octets[1] >= 64
    && octets[1] <= 127;
}

export async function discoverTailscaleIPv4({ run = execFile } = {}) {
  let stdout;
  try {
    const result = await run("tailscale", ["ip", "-4"], { encoding: "utf8" });
    stdout = typeof result === "string" ? result : result?.stdout;
  } catch (error) {
    throw new WorkspaceError(
      `Could not ask Tailscale for this machine's IPv4 address. Make sure Tailscale is installed, running, and connected. ${error.message}`,
      { code: "tailscale_unavailable" },
    );
  }

  const address = String(stdout ?? "")
    .split(/\s+/)
    .map((value) => value.trim())
    .find(isTailscaleIPv4);
  if (!address) {
    throw new WorkspaceError(
      "Tailscale did not report a connected IPv4 address. Connect this machine to a tailnet and try again.",
      { code: "tailscale_address_unavailable" },
    );
  }
  return address;
}
