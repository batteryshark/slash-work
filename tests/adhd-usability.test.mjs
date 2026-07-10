import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html", host: "localhost" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders one calm resume surface with capture in the first response", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Work · One next thing<\/title>/i);
  assert.match(html, /packaging architecture/i);
  assert.match(html, /Last meaningful update/i);
  assert.match(html, /Next action/i);
  assert.match(html, /Needs you/i);
  assert.match(html, /Tell \/work anything/i);
  assert.match(html, /Universal work command/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("keeps the interaction contract low-friction and non-interruptive", async () => {
  const [page, css, standard] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("docs/ADHD-USABILITY-STANDARD.md", root), "utf8"),
  ]);

  assert.match(page, /event\.key === "\/"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /Nothing was started/);
  assert.match(page, /Undo/);
  assert.match(page, /localStorage/);
  assert.match(page, /if \(!hydrated\) return/);
  assert.doesNotMatch(page, /<dialog|window\.alert|window\.confirm|\brequired=/i);

  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /focus-visible/);

  assert.match(standard, /Capture Gate/i);
  assert.match(standard, /Resume Gate/i);
  assert.match(standard, /Attention Gate/i);
  assert.match(standard, /No shame language/i);
});

test("ships a complete absolute social preview contract", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /property="og:image" content="http:\/\/localhost\/og\.png"/i);
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
  assert.match(html, /property="og:image:width" content="1200"/i);
  assert.match(html, /property="og:image:height" content="630"/i);
});
