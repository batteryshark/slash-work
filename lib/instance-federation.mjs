import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { WorkspaceError } from "./local-workspace.mjs";

const CONFIG_VERSION = 1;
const PROTOCOL_VERSION = "1";
const CREDENTIAL_SERVICE = "slash-work-federation";
const TOKEN_PREFIX = "work_peer";
const DEFAULT_TIMEOUT_MS = 5_000;
const REFRESH_CACHE_MS = 15_000;
const MAX_MANIFEST_BYTES = 256 * 1024;

export function federationConfigPath() {
  return process.env.WORK_FEDERATION_CONFIG_FILE ?? join(homedir(), ".work", "federation.json");
}

export function systemFederationCredentialStore() {
  async function entry(peerId) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(CREDENTIAL_SERVICE, `peer-${peerId}`);
  }
  return {
    async get(peerId) {
      return (await (await entry(peerId)).getPassword()) ?? null;
    },
    async set(peerId, value) {
      await (await entry(peerId)).setPassword(value);
    },
    async delete(peerId) {
      return (await entry(peerId)).deleteCredential();
    },
  };
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    instanceId: randomUUID(),
    name: hostname().split(".")[0] || "Work instance",
    grants: [],
    peers: [],
    updatedAt: new Date().toISOString(),
  };
}

function cleanName(value, label = "Instance name") {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceError(`${label} is required.`, { code: "invalid_federation_settings" });
  }
  const name = value.trim();
  if (name.length > 120 || /[\r\n]/.test(name)) {
    throw new WorkspaceError(`${label} must be one line of at most 120 characters.`, { code: "invalid_federation_settings" });
  }
  return name;
}

function cleanBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceError("A reachable Work URL is required.", { code: "invalid_peer_url" });
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new WorkspaceError("The Work URL is not valid.", { code: "invalid_peer_url" });
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new WorkspaceError("The Work URL must be an HTTP or HTTPS origin without credentials, query parameters, or a fragment.", { code: "invalid_peer_url" });
  }
  return url.toString().replace(/\/$/, "");
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashMatch(left, right) {
  const a = Buffer.from(left ?? "", "hex");
  const b = Buffer.from(right ?? "", "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function readConfig(pathname) {
  try {
    const config = JSON.parse(await readFile(pathname, "utf8"));
    if (config?.version !== CONFIG_VERSION || typeof config.instanceId !== "string" || !Array.isArray(config.grants) || !Array.isArray(config.peers)) {
      throw new Error("Unsupported config");
    }
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new WorkspaceError("Federation settings are not valid JSON.", { code: "invalid_federation_config", status: 500 });
  }
}

async function writeConfig(pathname, config) {
  await mkdir(dirname(pathname), { recursive: true, mode: 0o700 });
  const temporary = `${pathname}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, pathname);
}

function credentialError(error, action) {
  const timedOut = error?.code === "credential_timeout";
  return new WorkspaceError(`The operating system credential store ${timedOut ? `timed out while trying to ${action}` : `could not ${action}`} the remote Work access key.`, {
    code: "federation_credential_store_unavailable",
    status: 503,
    cause: error,
  });
}

async function boundedCredentialOperation(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Credential operation timed out.");
      error.code = "credential_timeout";
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function credentialGet(store, peerId, timeoutMs) {
  try {
    return await boundedCredentialOperation(() => store.get(peerId), timeoutMs);
  } catch (error) {
    throw credentialError(error, "read");
  }
}

async function credentialSet(store, peerId, token, timeoutMs) {
  try {
    await boundedCredentialOperation(() => store.set(peerId, token), timeoutMs);
  } catch (error) {
    throw credentialError(error, "save");
  }
}

async function credentialDelete(store, peerId, timeoutMs) {
  try {
    await boundedCredentialOperation(() => store.delete(peerId), timeoutMs);
  } catch (error) {
    throw credentialError(error, "remove");
  }
}

function timeoutSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

function publicPeer(peer, runtime = null) {
  return {
    id: peer.id,
    name: runtime?.name ?? peer.name,
    baseUrl: peer.baseUrl,
    version: runtime?.version ?? peer.version ?? null,
    available: runtime?.available ?? false,
    lastSeenAt: runtime?.lastSeenAt ?? peer.lastSeenAt ?? null,
    workspaceCount: (runtime?.workspaces ?? peer.workspaces ?? []).length,
    error: runtime?.error ?? null,
  };
}

function publicGrant(grant) {
  return {
    id: grant.id,
    label: grant.label,
    workspaceIds: [...grant.workspaceIds],
    createdAt: grant.createdAt,
    lastUsedAt: grant.lastUsedAt ?? null,
  };
}

function remoteWorkspaceId(peerId, workspaceId) {
  return `remote:${peerId}:${workspaceId}`;
}

export class FederationManager {
  constructor({
    configPath = federationConfigPath(),
    credentialStore = systemFederationCredentialStore(),
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    serviceVersion = null,
    localWorkspaces,
  }) {
    this.configPath = configPath;
    this.credentialStore = credentialStore;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.serviceVersion = serviceVersion;
    this.localWorkspaces = localWorkspaces;
    this.config = null;
    this.runtime = new Map();
    this.lastRefreshAt = 0;
    this.refreshPromise = null;
    this.saveChain = Promise.resolve();
  }

  async initialize() {
    this.config = this.configPath ? await readConfig(this.configPath) ?? defaultConfig() : defaultConfig();
    if (this.configPath) await writeConfig(this.configPath, this.config);
    return this;
  }

  async save() {
    if (!this.configPath) return;
    this.saveChain = this.saveChain.then(() => writeConfig(this.configPath, this.config));
    await this.saveChain;
  }

  settings() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      instance: { id: this.config.instanceId, name: this.config.name, version: this.serviceVersion },
      grants: this.config.grants.map(publicGrant),
      peers: this.config.peers.map((peer) => publicPeer(peer, this.runtime.get(peer.id))),
    };
  }

  async rename(value) {
    this.config.name = cleanName(value);
    await this.save();
    return this.settings();
  }

  async createGrant({ label, workspaceIds }) {
    const allowed = new Set(this.localWorkspaces().map((workspace) => workspace.id));
    const requested = Array.isArray(workspaceIds) ? workspaceIds : [];
    if (requested.length === 0 || requested.some((id) => typeof id !== "string" || !allowed.has(id))) {
      throw new WorkspaceError("Choose at least one local workspace for this access key.", { code: "invalid_federation_grant" });
    }
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const token = `${TOKEN_PREFIX}_${id}_${secret}`;
    const grant = {
      id,
      label: cleanName(label, "Access key label"),
      tokenHash: tokenHash(token),
      workspaceIds: [...new Set(requested)],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.config.grants.push(grant);
    await this.save();
    return { grant: publicGrant(grant), accessKey: token };
  }

  async revokeGrant(id) {
    const grants = this.config.grants.filter((grant) => grant.id !== id);
    if (grants.length === this.config.grants.length) {
      throw new WorkspaceError("That federation access key does not exist.", { code: "federation_grant_not_found", status: 404 });
    }
    this.config.grants = grants;
    await this.save();
  }

  async authorize(authorization, workspaceId = null) {
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const match = token.match(/^work_peer_([0-9a-f-]{36})_[A-Za-z0-9_-]+$/i);
    const grant = match ? this.config.grants.find((item) => item.id === match[1]) : null;
    if (!grant || !safeHashMatch(tokenHash(token), grant.tokenHash)) {
      throw new WorkspaceError("A valid federation access key is required.", { code: "federation_unauthorized", status: 401 });
    }
    if (workspaceId && !grant.workspaceIds.includes(workspaceId)) {
      throw new WorkspaceError("This access key does not grant access to that workspace.", { code: "federation_workspace_forbidden", status: 403 });
    }
    grant.lastUsedAt = new Date().toISOString();
    void this.save().catch(() => undefined);
    return grant;
  }

  manifest(grant) {
    const allowed = new Set(grant.workspaceIds);
    return {
      protocolVersion: PROTOCOL_VERSION,
      instance: { id: this.config.instanceId, name: this.config.name, version: this.serviceVersion },
      workspaces: this.localWorkspaces()
        .filter((workspace) => allowed.has(workspace.id))
        .map((workspace) => ({ id: workspace.id, name: workspace.name })),
    };
  }

  async requestManifest(baseUrl, token) {
    let response;
    try {
      response = await this.fetch(`${cleanBaseUrl(baseUrl)}/api/federation/manifest`, {
        headers: { authorization: `Bearer ${token}`, "x-work-federation-hop": "1" },
        redirect: "manual",
        signal: timeoutSignal(this.timeoutMs),
      });
    } catch (error) {
      throw new WorkspaceError(`The remote Work instance could not be reached: ${error.message}`, { code: "peer_unavailable", status: 502 });
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
      throw new WorkspaceError("The remote Work discovery response is too large.", { code: "peer_response_too_large", status: 502 });
    }
    const content = await response.text();
    if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES) {
      throw new WorkspaceError("The remote Work discovery response is too large.", { code: "peer_response_too_large", status: 502 });
    }
    const body = (() => {
      try { return JSON.parse(content); } catch { return null; }
    })();
    if (!response.ok) {
      const message = body?.error?.message ?? `The remote Work instance returned HTTP ${response.status}.`;
      throw new WorkspaceError(message, { code: body?.error?.code ?? "peer_connection_failed", status: 502 });
    }
    if (body?.protocolVersion !== PROTOCOL_VERSION || typeof body?.instance?.id !== "string" || typeof body?.instance?.name !== "string" || !Array.isArray(body.workspaces)) {
      throw new WorkspaceError("The remote endpoint is not a compatible Work instance.", { code: "incompatible_peer", status: 409 });
    }
    return body;
  }

  async addPeer({ baseUrl, accessKey }) {
    const url = cleanBaseUrl(baseUrl);
    if (typeof accessKey !== "string" || !accessKey.trim()) {
      throw new WorkspaceError("The remote access key is required.", { code: "invalid_peer_key" });
    }
    const token = accessKey.trim();
    const manifest = await this.requestManifest(url, token);
    if (manifest.instance.id === this.config.instanceId) {
      throw new WorkspaceError("An instance cannot connect to itself.", { code: "federation_self_connection", status: 409 });
    }
    await credentialSet(this.credentialStore, manifest.instance.id, token, this.timeoutMs);
    const now = new Date().toISOString();
    const peer = {
      id: manifest.instance.id,
      name: manifest.instance.name,
      baseUrl: url,
      version: manifest.instance.version ?? null,
      addedAt: this.config.peers.find((item) => item.id === manifest.instance.id)?.addedAt ?? now,
      lastSeenAt: now,
      workspaces: manifest.workspaces.map(({ id, name }) => ({ id, name })),
    };
    this.config.peers = [...this.config.peers.filter((item) => item.id !== peer.id), peer];
    this.runtime.set(peer.id, { available: true, name: peer.name, version: peer.version, lastSeenAt: now, workspaces: peer.workspaces, error: null });
    await this.save();
    return publicPeer(peer, this.runtime.get(peer.id));
  }

  async removePeer(id) {
    const peers = this.config.peers.filter((peer) => peer.id !== id);
    if (peers.length === this.config.peers.length) {
      throw new WorkspaceError("That connected Work instance does not exist.", { code: "peer_not_found", status: 404 });
    }
    await credentialDelete(this.credentialStore, id, this.timeoutMs);
    this.config.peers = peers;
    this.runtime.delete(id);
    await this.save();
  }

  async refreshPeer(peer) {
    try {
      const token = (await credentialGet(this.credentialStore, peer.id, this.timeoutMs))?.trim();
      if (!token) throw new WorkspaceError("The access key is missing from the system credential store.", { code: "peer_key_missing", status: 503 });
      const manifest = await this.requestManifest(peer.baseUrl, token);
      if (manifest.instance.id !== peer.id) throw new WorkspaceError("The remote Work identity changed.", { code: "peer_identity_changed", status: 409 });
      const now = new Date().toISOString();
      peer.name = manifest.instance.name;
      peer.version = manifest.instance.version ?? null;
      peer.lastSeenAt = now;
      peer.workspaces = manifest.workspaces.map(({ id, name }) => ({ id, name }));
      this.runtime.set(peer.id, { available: true, name: peer.name, version: peer.version, lastSeenAt: now, workspaces: peer.workspaces, error: null });
      return true;
    } catch (error) {
      this.runtime.set(peer.id, {
        available: false,
        name: peer.name,
        version: peer.version ?? null,
        lastSeenAt: peer.lastSeenAt ?? null,
        workspaces: peer.workspaces ?? [],
        error: error instanceof Error ? error.message : "The remote Work instance is unavailable.",
      });
      return false;
    }
  }

  async refreshPeers({ force = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    if (!force && Date.now() - this.lastRefreshAt < REFRESH_CACHE_MS) return this.settings().peers;
    this.refreshPromise = (async () => {
      const changed = await Promise.all(this.config.peers.map((peer) => this.refreshPeer(peer)));
      if (changed.some(Boolean)) await this.save();
      this.lastRefreshAt = Date.now();
      return this.settings().peers;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  remoteWorkspaces() {
    return this.config.peers.flatMap((peer) => {
      const runtime = this.runtime.get(peer.id);
      const available = runtime?.available ?? false;
      return (runtime?.workspaces ?? peer.workspaces ?? []).map((workspace) => ({
        id: remoteWorkspaceId(peer.id, workspace.id),
        remoteWorkspaceId: workspace.id,
        name: workspace.name,
        root: `remote://${peer.id}/${workspace.id}`,
        location: "remote",
        available,
        peer: { id: peer.id, name: runtime?.name ?? peer.name, baseUrl: peer.baseUrl },
      }));
    });
  }

  resolveRemoteWorkspace(id) {
    return this.remoteWorkspaces().find((workspace) => workspace.id === id) ?? null;
  }

  async peerToken(peerId) {
    const token = (await credentialGet(this.credentialStore, peerId, this.timeoutMs))?.trim();
    if (!token) throw new WorkspaceError("The remote access key is missing from the system credential store.", { code: "peer_key_missing", status: 503 });
    return token;
  }
}
