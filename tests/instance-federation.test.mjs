import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeLocalApi, startLocalApi } from "../server/local-api.mjs";

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function memoryCredentialStore() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    values,
  };
}

async function apiRequest(origin, pathname, { workspaceId, headers = {}, body, ...init } = {}) {
  const response = await fetch(new URL(pathname, origin), {
    ...init,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(workspaceId ? { "x-work-workspace": workspaceId } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

test("pairs instances as non-transitive workspace proxies without persisting plaintext keys", async () => {
  const macRoot = await temporaryDirectory("work-federation-mac-");
  const homeRoot = await temporaryDirectory("work-federation-home-");
  const privateHomeRoot = await temporaryDirectory("work-federation-private-");
  const macConfig = join(await temporaryDirectory("work-federation-config-mac-"), "federation.json");
  const homeConfig = join(await temporaryDirectory("work-federation-config-home-"), "federation.json");
  const macCredentials = memoryCredentialStore();
  const homeCredentials = memoryCredentialStore();
  const home = await startLocalApi({
    root: homeRoot,
    roots: [homeRoot, privateHomeRoot],
    port: 0,
    version: "1.2.3-home",
    federationConfigFile: homeConfig,
    federationCredentialStore: homeCredentials,
  });
  const mac = await startLocalApi({
    root: macRoot,
    port: 0,
    version: "1.2.3-mac",
    federationConfigFile: macConfig,
    federationCredentialStore: macCredentials,
  });

  try {
    const macSettings = await apiRequest(mac.origin, "/api/federation");
    assert.deepEqual(macSettings.payload.network, { mode: "loopback", reachableUrl: null });

    const homeDirectory = await apiRequest(home.origin, "/api/workspaces");
    const sharedWorkspace = homeDirectory.payload.workspaces.find((workspace) => workspace.id === homeDirectory.payload.defaultWorkspaceId);
    const privateWorkspace = homeDirectory.payload.workspaces.find((workspace) => workspace.id !== sharedWorkspace.id);
    const grantResult = await apiRequest(home.origin, "/api/federation/grants", {
      method: "POST",
      headers: { "x-work-federation-settings": "confirm" },
      body: { label: "MacBook", workspaceIds: [sharedWorkspace.id] },
    });
    assert.equal(grantResult.response.status, 201);
    assert.match(grantResult.payload.accessKey, /^work_peer_/);

    const connected = await apiRequest(mac.origin, "/api/federation/peers", {
      method: "POST",
      headers: { "x-work-federation-settings": "confirm" },
      body: { baseUrl: home.origin, accessKey: grantResult.payload.accessKey },
    });
    assert.equal(connected.response.status, 201);
    assert.equal(connected.payload.name.length > 0, true);
    assert.equal(connected.payload.workspaceCount, 1);

    const macDirectory = await apiRequest(mac.origin, "/api/workspaces?refresh=1");
    const remoteWorkspace = macDirectory.payload.workspaces.find((workspace) => workspace.location === "remote");
    assert.equal(remoteWorkspace.available, true);
    assert.equal(remoteWorkspace.peer.id, connected.payload.id);
    assert.equal(macDirectory.payload.workspaces.some((workspace) => workspace.name === privateWorkspace.name && workspace.location === "remote"), false);

    const created = await apiRequest(mac.origin, "/api/captures", {
      method: "POST",
      workspaceId: remoteWorkspace.id,
      body: { text: "Created through the MacBook gateway", scopePath: "." },
    });
    assert.equal(created.response.status, 201);
    const ownerRecords = await apiRequest(home.origin, "/api/captures", { workspaceId: sharedWorkspace.id });
    assert.equal(ownerRecords.payload.captures.some((capture) => capture.text === "Created through the MacBook gateway"), true);
    const localRecords = await apiRequest(mac.origin, "/api/captures", { workspaceId: mac.workspace.id });
    assert.equal(localRecords.payload.captures.length, 0);

    const remoteSnapshot = await apiRequest(mac.origin, "/api/workspace", { workspaceId: remoteWorkspace.id });
    assert.equal(remoteSnapshot.payload.workspace.id, remoteWorkspace.id);
    assert.equal(remoteSnapshot.payload.workspace.location, "remote");
    assert.equal(remoteSnapshot.response.headers.get("x-work-workspace"), remoteWorkspace.id);

    const forbidden = await apiRequest(home.origin, "/api/captures", {
      workspaceId: privateWorkspace.id,
      headers: {
        authorization: `Bearer ${grantResult.payload.accessKey}`,
        "x-work-federation-hop": "1",
      },
    });
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.payload.error.code, "federation_workspace_forbidden");

    const transitive = await apiRequest(home.origin, "/api/workspaces", {
      headers: {
        authorization: `Bearer ${grantResult.payload.accessKey}`,
        "x-work-federation-hop": "1",
      },
    });
    assert.equal(transitive.response.status, 403);
    assert.equal(transitive.payload.error.code, "federation_route_forbidden");

    const macConfigText = await readFile(macConfig, "utf8");
    const homeConfigText = await readFile(homeConfig, "utf8");
    assert.equal(macConfigText.includes(grantResult.payload.accessKey), false);
    assert.equal(homeConfigText.includes(grantResult.payload.accessKey), false);
    assert.equal(homeConfigText.includes("tokenHash"), true);
    assert.equal(macCredentials.values.get(connected.payload.id), grantResult.payload.accessKey);

    await apiRequest(home.origin, `/api/federation/grants/${grantResult.payload.grant.id}`, {
      method: "DELETE",
      headers: { "x-work-federation-settings": "confirm" },
    });
    const revoked = await apiRequest(mac.origin, "/api/captures", { workspaceId: remoteWorkspace.id });
    assert.equal(revoked.response.status, 401);
    assert.equal(revoked.payload.error.code, "federation_unauthorized");
  } finally {
    await closeLocalApi(mac.server);
    await closeLocalApi(home.server);
  }
});

test("keeps cached remote workspaces visible but unavailable when their owner is offline", async () => {
  const firstRoot = await temporaryDirectory("work-federation-first-");
  const secondRoot = await temporaryDirectory("work-federation-second-");
  const firstConfig = join(await temporaryDirectory("work-federation-first-config-"), "federation.json");
  const secondConfig = join(await temporaryDirectory("work-federation-second-config-"), "federation.json");
  const first = await startLocalApi({ root: firstRoot, port: 0, federationConfigFile: firstConfig, federationCredentialStore: memoryCredentialStore() });
  const second = await startLocalApi({ root: secondRoot, port: 0, federationConfigFile: secondConfig, federationCredentialStore: memoryCredentialStore() });

  try {
    const secondDirectory = await apiRequest(second.origin, "/api/workspaces");
    const grant = await apiRequest(second.origin, "/api/federation/grants", {
      method: "POST",
      headers: { "x-work-federation-settings": "confirm" },
      body: { label: "First", workspaceIds: [secondDirectory.payload.defaultWorkspaceId] },
    });
    await apiRequest(first.origin, "/api/federation/peers", {
      method: "POST",
      headers: { "x-work-federation-settings": "confirm" },
      body: { baseUrl: second.origin, accessKey: grant.payload.accessKey },
    });
    await closeLocalApi(second.server);

    const directory = await apiRequest(first.origin, "/api/workspaces?refresh=1");
    const remote = directory.payload.workspaces.find((workspace) => workspace.location === "remote");
    assert.equal(remote.available, false);
    assert.equal(remote.name, secondDirectory.payload.workspaces[0].name);
  } finally {
    await closeLocalApi(first.server);
    await closeLocalApi(second.server);
  }
});

test("keeps local startup responsive when a configured peer credential store hangs", async () => {
  const gatewayRoot = await temporaryDirectory("work-federation-resilient-gateway-");
  const ownerRoot = await temporaryDirectory("work-federation-resilient-owner-");
  const gatewayConfig = join(await temporaryDirectory("work-federation-resilient-config-"), "federation.json");
  const ownerConfig = join(await temporaryDirectory("work-federation-resilient-owner-config-"), "federation.json");
  const gatewayCredentials = memoryCredentialStore();
  const owner = await startLocalApi({ root: ownerRoot, port: 0, federationConfigFile: ownerConfig, federationCredentialStore: memoryCredentialStore() });
  const gateway = await startLocalApi({ root: gatewayRoot, port: 0, federationConfigFile: gatewayConfig, federationCredentialStore: gatewayCredentials });

  try {
    const ownerDirectory = await apiRequest(owner.origin, "/api/workspaces");
    const grant = await apiRequest(owner.origin, "/api/federation/grants", {
      method: "POST",
      headers: { "x-work-federation-settings": "confirm" },
      body: { label: "Minimal gateway", workspaceIds: [ownerDirectory.payload.defaultWorkspaceId] },
    });
    await apiRequest(gateway.origin, "/api/federation/peers", {
      method: "POST",
      headers: { "x-work-federation-settings": "confirm" },
      body: { baseUrl: owner.origin, accessKey: grant.payload.accessKey },
    });
  } finally {
    await closeLocalApi(gateway.server);
    await closeLocalApi(owner.server);
  }

  const hangingCredentials = {
    async get() { return new Promise(() => {}); },
    async set() { return new Promise(() => {}); },
    async delete() { return new Promise(() => {}); },
  };
  const restarted = await startLocalApi({
    root: gatewayRoot,
    port: 0,
    federationConfigFile: gatewayConfig,
    federationCredentialStore: hangingCredentials,
    federationRequestTimeoutMs: 1_000,
  });

  try {
    const directory = await Promise.race([
      apiRequest(restarted.origin, "/api/workspaces"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Local workspace discovery waited for the credential store.")), 250)),
    ]);
    assert.equal(directory.response.status, 200);
    assert.equal(directory.payload.workspaces.some((workspace) => workspace.location === "local"), true);
    assert.equal(directory.payload.workspaces.some((workspace) => workspace.location === "remote" && workspace.available === false), true);

    const refreshed = await apiRequest(restarted.origin, "/api/federation?refresh=1");
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.payload.peers[0].available, false);
    assert.match(refreshed.payload.peers[0].error, /credential store timed out/i);
  } finally {
    await closeLocalApi(restarted.server);
  }
});

test("does not consult a native credential store when no peers are configured", async () => {
  const root = await temporaryDirectory("work-federation-minimal-os-");
  const config = join(await temporaryDirectory("work-federation-minimal-os-config-"), "federation.json");
  let credentialCalls = 0;
  const unavailableCredentials = {
    async get() { credentialCalls += 1; throw new Error("No Secret Service"); },
    async set() { credentialCalls += 1; throw new Error("No Secret Service"); },
    async delete() { credentialCalls += 1; throw new Error("No Secret Service"); },
  };
  const api = await startLocalApi({ root, port: 0, federationConfigFile: config, federationCredentialStore: unavailableCredentials });
  try {
    assert.equal((await apiRequest(api.origin, "/api/workspaces")).response.status, 200);
    assert.equal(credentialCalls, 0);
  } finally {
    await closeLocalApi(api.server);
  }
});

test("presents remote ownership and pairing as an explicit, understandable UI workflow", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const routing = await readFile(new URL("../skills/slash-work/references/service-routing.md", import.meta.url), "utf8");

  assert.match(page, /Connected Work instances/);
  assert.match(page, /Let another instance browse this one/);
  assert.match(page, /Browse another instance here/);
  assert.match(page, /Connections are deliberately one-way/);
  assert.match(page, /Only a hash stays here/);
  assert.match(page, /work --tailscale/);
  assert.match(page, /Tailnet API URL copied/);
  assert.match(page, /workspace\.available !== false/);
  assert.match(page, /remote \? "↗"/);
  assert.match(css, /\.workspace-menu-item\.offline/);
  assert.match(css, /\.federation-key-receipt/);
  assert.match(css, /\.federation-network\.ready/);
  assert.match(routing, /keep using `\$WORK_ORIGIN`/i);
  assert.match(routing, /do not attempt\s+transitive routing/i);
});
