import { test } from "node:test";
import assert from "node:assert/strict";
import { probeChunks, getBestBlockNumber, _resetProbeSession, _bypassMetadataCheckForTest } from "../dist/chunk-probe.js";

// probeChunks reads metadata first, so a stub that stalls every method only
// ever exercises state_getMetadata. Each test stalls one method, bypasses the
// metadata check when a later call is the point, and asserts it was reached.
const CID = "bafkreidrchwf76kulasoplap3fnd4azwli3djcjp6umuimfgw6h4ojxyme";
const TIMEOUT = 200;

// Stalls only `stallOn`; every other method answers plausibly.
function client(stallOn) {
  const calls = [];
  return {
    calls,
    _request: (method) => {
      calls.push(method);
      if (method === stallOn) return new Promise(() => {});
      if (method === "chain_getFinalizedHead") return Promise.resolve("0xfinalised");
      if (method === "chain_getHeader") return Promise.resolve({ number: "0x10" });
      return Promise.resolve([{ changes: [] }]);
    },
  };
}

test("a stalled storage query returns by the deadline, reported as a timeout", async () => {
  _bypassMetadataCheckForTest();
  const c = client("state_queryStorageAt");
  const started = Date.now();
  const [r] = await probeChunks([CID], { client: c, requestTimeoutMs: TIMEOUT });
  const elapsed = Date.now() - started;

  assert.ok(c.calls.includes("state_queryStorageAt"),
    ">> FAIL: the test never reached the storage query, so it proves nothing about the hang");
  assert.equal(r.present, null);
  assert.equal(r.failureReason, "timeout",
    ">> FAIL: a stalled socket must not be reported as rpc_error, which means the chain answered");
  assert.ok(elapsed < 5000, `>> FAIL: probeChunks did not return by its deadline (${elapsed}ms)`);
  _resetProbeSession();
});

test("a stalled finalised-head read does NOT fall back to probing best chain", async () => {
  // Answering "is it finalised?" with "it is in some block" would let a caller
  // publish a root GRANDPA has not sealed.
  _bypassMetadataCheckForTest();
  const c = client("chain_getFinalizedHead");
  const [r] = await probeChunks([CID], { client: c, atFinalized: true, requestTimeoutMs: TIMEOUT });

  assert.equal(r.present, null, ">> FAIL: a finalised-head timeout produced a presence verdict from best chain");
  assert.equal(r.failureReason, "timeout");
  assert.ok(!c.calls.includes("state_queryStorageAt"),
    ">> FAIL: probeChunks queried storage after the finalised-head read timed out, so the answer is a best-chain answer wearing a finalised label");
  _resetProbeSession();
});

test("a stalled metadata read is a timeout, not a metadata_error", async () => {
  // metadata_error elsewhere means the runtime's shape is wrong, which is a
  // permanent condition; a stalled socket is not.
  _resetProbeSession();
  const c = client("state_getMetadata");
  const [r] = await probeChunks([CID], { client: c, requestTimeoutMs: TIMEOUT });

  assert.equal(r.present, null);
  assert.equal(r.failureReason, "timeout");
  _resetProbeSession();
});

test("getBestBlockNumber returns by its deadline instead of hanging", async () => {
  const c = client("chain_getHeader");
  const started = Date.now();
  const n = await getBestBlockNumber(c, TIMEOUT);
  assert.equal(n, null);
  assert.ok(Date.now() - started < 5000, ">> FAIL: getBestBlockNumber hung on a stalled socket");
});

test("no chain calls at all for an empty cid list", async () => {
  const c = client("state_getMetadata");
  assert.deepEqual(await probeChunks([], { client: c }), []);
  assert.deepEqual(c.calls, []);
});
