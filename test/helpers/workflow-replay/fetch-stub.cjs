"use strict";
// Preload (node -r) for replaying .github/scripts/classify-runner-loss.cjs
// offline. Replaces globalThis.fetch with a router over STUB_ROUTES (a JSON
// file: [{ "match": "<substring of the URL>", "status": 200, "json": ... }
// or "text": "..."]). First match wins; no match is a 404. Every requested
// URL is appended to STUB_LOG, one per line, so a test can assert WHICH
// endpoint the real script asked for.
const fs = require("fs");
const routes = JSON.parse(fs.readFileSync(process.env.STUB_ROUTES, "utf8"));
globalThis.fetch = async (url) => {
  if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, `${url}\n`);
  const r = routes.find((x) => String(url).includes(x.match));
  if (!r) return new Response("not found", { status: 404 });
  const body = r.json !== undefined ? JSON.stringify(r.json) : r.text ?? "";
  return new Response(body, { status: r.status ?? 200 });
};
