import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A long-lived server keeps its code in memory, so editing or updating Work
// leaves the running process serving the old build — silently, and for as
// long as it stays up. Fingerprinting the files it was started from lets the
// UI notice and offer a restart.

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The files whose change means "the running process is out of date": the
// built UI, the package manifest, and the entry points of each layer.
const WATCHED = [
  "package.json",
  "dist/index.html",
  "bin/work.mjs",
  "server/local-api.mjs",
  "lib/local-workspace.mjs",
  "lib/agent-capabilities.mjs",
];

const THROTTLE_MS = 4000;
let cached = { at: 0, value: null };

export function buildFingerprint() {
  const now = Date.now();
  if (cached.value !== null && now - cached.at < THROTTLE_MS) return cached.value;
  const hash = createHash("sha256");
  for (const relative of WATCHED) {
    try {
      const stats = statSync(join(PACKAGE_ROOT, relative));
      hash.update(`${relative}:${stats.size}:${Math.round(stats.mtimeMs)}\n`);
    } catch {
      // A missing watched file is itself a state worth fingerprinting.
      hash.update(`${relative}:absent\n`);
    }
  }
  cached = { at: now, value: hash.digest("base64url").slice(0, 16) };
  return cached.value;
}
