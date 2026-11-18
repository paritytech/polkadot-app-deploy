// After a deploy, each new chunk is requested once through the stack's IPFS gateway so its cache
// is warm for the first visitor. A wrong path or another gateway warms nothing and nothing reports it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { preWarmGateway } from "../dist/deploy.js";
import { readShippedStack, BUILT_IN_STACK_IDS } from "../dist/stacks.js";
import { readShippedDescriptor } from "../tools/lib/stack-copies.mjs";

function requestedUrls(gateway) {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response(null, { status: 200 }); };
  try {
    preWarmGateway(["bafkreichunk"], [gateway]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return urls;
}

test("a path-style gateway gets the CID appended once, under a single /ipfs/", () => {
  assert.deepEqual(requestedUrls("https://gateway.example.test/ipfs/"), ["https://gateway.example.test/ipfs/bafkreichunk"],
    ">> FAIL: pre-warm path-style: the URL must be the gateway followed by the CID, not .../ipfs/ipfs/<cid>");
});

// The expected URL comes from the descriptor's own ipfs-gateway service, not from the stack
// object under test, so a stack that carried another gateway fails here.
test("each built-in stack's descriptor ipfs-gateway is requested at gateway + CID", () => {
  for (const id of BUILT_IN_STACK_IDS) {
    const gateway = readShippedDescriptor(id).services.find((service) => service.kind === "ipfs-gateway").urls[0];
    assert.deepEqual(requestedUrls(readShippedStack(id).ipfsGateway), [`${gateway}bafkreichunk`],
      `>> FAIL: pre-warm ${id}: the descriptor's ipfs-gateway ${gateway} must be requested as \${gateway}\${cid}`);
  }
});

test("a bare-host gateway gets /ipfs/ added", () => {
  assert.deepEqual(requestedUrls("https://gateway.example.test"), ["https://gateway.example.test/ipfs/bafkreichunk"],
    ">> FAIL: pre-warm bare host: a gateway without /ipfs/ must still be requested under /ipfs/");
});

// storeDirectoryV2 needs a live chain, so the hand-off is read from the source: deploy() passes the
// stack's gateway as `gateway`, and storeDirectoryV2 pre-warms exactly that gateway.
test("storeDirectoryV2 pre-warms the gateway deploy() passes it", () => {
  const src = fs.readFileSync("src/deploy.ts", "utf8");
  const body = src.slice(src.indexOf("export async function storeDirectoryV2("), src.indexOf("\n}\n", src.indexOf("export async function storeDirectoryV2(")));
  assert.match(body, /\n\s*const gateway = opts\.gateway;\n/,
    ">> FAIL: pre-warm hand-off: storeDirectoryV2 must take its gateway from the gateway option deploy() sets");
  assert.match(body, /\n\s*preWarmGateway\(newlyUploadedCids, \[gateway\]\);\n/,
    ">> FAIL: pre-warm hand-off: storeDirectoryV2 must pre-warm the new chunks through that gateway");
  const call = src.match(/await storeFn\(contentPath, \{\n([\s\S]*?)\n\s*\}\);/)?.[1] ?? "";
  assert.match(call, /^\s*gateway: stack\.ipfsGateway,$/m,
    ">> FAIL: pre-warm hand-off: deploy() must pass the stack's ipfs-gateway to storeDirectoryV2");
});
