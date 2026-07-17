import assert from "node:assert/strict";
import test from "node:test";

import { discoverTailscaleIPv4, isTailscaleIPv4 } from "../lib/tailscale-network.mjs";
import { startLocalApi } from "../server/local-api.mjs";

test("recognizes only Tailscale's IPv4 address range", () => {
  assert.equal(isTailscaleIPv4("100.64.0.1"), true);
  assert.equal(isTailscaleIPv4("100.127.255.254"), true);
  assert.equal(isTailscaleIPv4("100.63.255.255"), false);
  assert.equal(isTailscaleIPv4("100.128.0.1"), false);
  assert.equal(isTailscaleIPv4("192.168.1.10"), false);
  assert.equal(isTailscaleIPv4("not-an-address"), false);
});

test("discovers the connected Tailscale IPv4 address", async () => {
  const calls = [];
  const address = await discoverTailscaleIPv4({
    run: async (...args) => {
      calls.push(args);
      return { stdout: "100.101.102.103\n" };
    },
  });
  assert.equal(address, "100.101.102.103");
  assert.deepEqual(calls[0].slice(0, 2), ["tailscale", ["ip", "-4"]]);
});

test("explains when Tailscale is unavailable or disconnected", async () => {
  await assert.rejects(
    discoverTailscaleIPv4({ run: async () => { throw new Error("command not found"); } }),
    (error) => error.code === "tailscale_unavailable" && /installed, running, and connected/i.test(error.message),
  );
  await assert.rejects(
    discoverTailscaleIPv4({ run: async () => ({ stdout: "" }) }),
    (error) => error.code === "tailscale_address_unavailable" && /Connect this machine/i.test(error.message),
  );
});

test("the API refuses wildcard and ordinary LAN bind addresses", async () => {
  await assert.rejects(
    startLocalApi({ host: "0.0.0.0" }),
    (error) => error.code === "invalid_listen_host",
  );
  await assert.rejects(
    startLocalApi({ host: "192.168.1.10" }),
    (error) => error.code === "invalid_listen_host",
  );
});
