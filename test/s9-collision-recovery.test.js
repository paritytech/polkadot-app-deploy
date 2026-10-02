// #1672: S9's two recovery-path defects and its E2E nonce-seed barrier.
//   1. A root-node tx the pool rejects for its nonce (InvalidTxError Stale: a
//      sibling deploy on the same signer took that nonce) was handled as a
//      connection loss: "Connection lost, reconnecting to Bulletin" plus a
//      reconnect. It is a nonce collision: re-read the nonce and resubmit.
//   2. After a mid-upload reconnect, storeChunkedContent destroyed the fresh
//      client and returned it as liveProvider, so storeDirectoryV2's finality
//      probe ran on a dead client ("8 of 8 chunks could not be probed (rpc_error)").
//   3. The barrier (src/e2e-nonce-barrier.ts) that makes S9's collision
//      deterministic: inert without its env var, holds parties until all seeded.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.BULLETIN_CHUNK_LIVENESS_MAX_WAIT_MS = "10";

const { storeChunkedContent, classifyRootSubmitError, isNonceCollisionError, __setNonceCollisionBackoffForTest } = await import("../dist/deploy.js");
const { _resetProbeSession, _bypassMetadataCheckForTest } = await import("../dist/chunk-probe.js");
// No real waits between collision retries in unit tests.
const noBackoff = () => 0;
__setNonceCollisionBackoffForTest(noBackoff);
const { awaitNonceSeedBarrier, e2eNonceSeedBarrier, __resetNonceSeedBarrierForTest, NONCE_SEED_BARRIER_ENV } = await import("../dist/e2e-nonce-barrier.js");

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CHUNK = new Uint8Array([0x42]);
// What papi's InvalidTxError carries when the tx's nonce is already used: the
// JSON of the TransactionValidityError, pretty-printed (polkadot-api submit-fns).
const STALE = JSON.stringify({ type: "Invalid", value: { type: "Stale" } }, null, 2);

const ok = () => ({ subscribe({ next }) { setImmediate(() => next({ type: "txBestBlocksState", found: true, ok: true })); return { unsubscribe() {} }; } });
const fails = (msg) => () => ({ subscribe({ error }) { setImmediate(() => error(new Error(msg))); return { unsubscribe() {} }; } });

// Records every submit's nonce; the n-th submit uses makers[n] (the last one repeats).
function api(makers, nonces = []) {
  let n = 0;
  return {
    nonces,
    query: { System: { Number: { getValue: async () => 1000 } } },
    apis: { BulletinTransactionStorageApi: {
      account_authorization: async () => ({ expires_at: 9_999_999, bytes_allowance: 100_000_000n, bytes_used: 0n, bytes_permanent_used: 0n, transactions_allowance: 1000, transactions_used: 0 }),
      can_store: async () => true,
    } },
    tx: { TransactionStorage: { store_with_cid_config: () => ({
      signSubmitAndWatch: (_s, opts) => { nonces.push(opts.nonce); return makers[Math.min(n++, makers.length - 1)](); },
    }) } },
  };
}
const client = () => ({ destroyed: false, destroy() { this.destroyed = true; } });
const counter = (start) => { let n = start; return async () => n++; };

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try { return { result: await fn(), log: lines.join("\n") }; } finally { console.log = orig; }
}

describe("#1672 root-node submit errors", () => {
  test("a root tx rejected as Stale (nonce taken by a sibling deploy) is a nonce collision: no reconnect, resubmitted at a fresh nonce", async () => {
    let reconnects = 0;
    const nonces = [];
    // submit 1: the chunk, ok. submit 2: the root, Stale. submit 3: the root again, ok.
    const a = api([ok, fails(STALE), ok], nonces);
    const { log } = await captureLog(() => storeChunkedContent([CHUNK], {
      client: client(), unsafeApi: a, signer: {}, ss58: SS58,
      reconnect: async () => { reconnects++; return { client: client(), unsafeApi: a, signer: {}, ss58: SS58 }; },
      fetchNonce: counter(100),
    }));
    assert.equal(reconnects, 0, ">> FAIL: #1672: a pool-rejected root tx was handled as a connection loss (reconnect called)");
    assert.doesNotMatch(log, /Connection lost/, ">> FAIL: #1672: a root nonce collision logged 'Connection lost'");
    assert.match(log, /Root node: nonce \d+ collided/, ">> FAIL: #1672: the root nonce collision left no recognisable log line");
    assert.equal(nonces.length, 3, ">> FAIL: #1672: expected chunk + root + root retry submits");
    assert.notEqual(nonces[2], nonces[1], ">> FAIL: #1672: the root retry reused the collided nonce");
  });

  test("a root tx whose subscription dies (ChainHead disjointed) still reconnects", async () => {
    let reconnects = 0;
    const a = api([ok, fails("ChainHead disjointed"), ok]);
    await captureLog(() => storeChunkedContent([CHUNK], {
      client: client(), unsafeApi: a, signer: {}, ss58: SS58,
      reconnect: async () => { reconnects++; return { client: client(), unsafeApi: a, signer: {}, ss58: SS58 }; },
      fetchNonce: counter(100),
    }));
    assert.equal(reconnects, 1, ">> FAIL: #1672: a connection error on the root store must still reconnect");
  });

  test("a root that collides on every attempt fails by name after MAX_ROOT_RETRIES, without a reconnect", async () => {
    let reconnects = 0;
    const nonces = [];
    const a = api([ok, fails(STALE)], nonces);
    await captureLog(() => assert.rejects(() => storeChunkedContent([CHUNK], {
      client: client(), unsafeApi: a, signer: {}, ss58: SS58,
      reconnect: async () => { reconnects++; return { client: client(), unsafeApi: a, signer: {}, ss58: SS58 }; },
      fetchNonce: counter(100),
    }), /Stale/, ">> FAIL: #1672: a root that never stops colliding must fail with the pool's reason"));
    assert.equal(reconnects, 0);
    assert.equal(nonces.length, 4, "chunk + 3 root attempts");
  });

  test("a root store still failing on its last attempt throws instead of returning no root", async () => {
    const a = api([ok, fails("ChainHead disjointed")]);
    const { result } = await captureLog(() => storeChunkedContent([CHUNK], {
      client: client(), unsafeApi: a, signer: {}, ss58: SS58,
      reconnect: async () => ({ client: client(), unsafeApi: a, signer: {}, ss58: SS58 }),
      fetchNonce: counter(100),
    }).then((r) => ({ storageCid: r.storageCid }), (e) => ({ error: e })));
    assert.ok(result.error, `>> FAIL: #1672: the root store gave up silently and returned storageCid=${result.storageCid}`);
    assert.match(result.error.message, /ChainHead disjointed/);
  });

  test("classifyRootSubmitError: pool rejections are collisions, connection errors and anything unknown reconnect", () => {
    const stale = Object.assign(new Error(`root-node subscription error: ${STALE}`), { chainErrorVariant: "Stale" });
    assert.equal(classifyRootSubmitError(stale, false), "nonce-collision");
    assert.equal(classifyRootSubmitError(new Error(`root-node subscription error: ${STALE}`), false), "nonce-collision");
    assert.equal(classifyRootSubmitError(new Error("root-node tx rejected by pool (isValid:false)"), false), "nonce-collision");
    assert.equal(classifyRootSubmitError(new Error("ChainHead disjointed"), false), "reconnect");
    assert.equal(classifyRootSubmitError(stale, true), "reconnect", "a WS halt means the client is dead whatever the error says");
    assert.equal(classifyRootSubmitError(new Error("root-node timed out after 180s waiting for block confirmation"), false), "reconnect");
  });
});

describe("#1672 re-upload nonce collisions (CI run 37027455287, attempt 1)", () => {
  // Both S9 deploys re-upload their provisional chunks at once and keep reading the
  // same nextIndex, so a re-upload can lose to the sibling 3 times in a row (Stale
  // each time). That used to fail the deploy ("Nonce-collision re-upload of chunk 3
  // failed after 3 attempts: ... Stale") with re-upload rounds left. A collision now
  // backs off (jittered, to break the lockstep) and, once the round's attempts are
  // spent, leaves the chunk pending for the next verify round.
  test("a re-upload that collides on every attempt of a round is retried next round after a backoff, and the deploy succeeds", async () => {
    _resetProbeSession(); _bypassMetadataCheckForTest();
    const backoffs = [];
    __setNonceCollisionBackoffForTest(() => { backoffs.push(1); return 0; });
    try {
      // submit 1: initial chunk, Stale -> reconcile sees the nonce consumed -> provisional.
      // submits 2-4: round-1 re-uploads, all Stale. submit 5: round-2 re-upload, ok.
      const a = api([fails(STALE), fails(STALE), fails(STALE), fails(STALE), ok]);
      // Every content-hash probe answers "absent" (a null value for the key).
      const probeClient = { destroy() {}, _request: async (m, params) => {
        if (m !== "state_queryStorageAt") throw new Error(`stub: ${m}`);
        return [{ changes: params[0].map((k) => [k, null]) }];
      } };
      const { log } = await captureLog(() => storeChunkedContent([CHUNK], {
        client: probeClient, unsafeApi: a, signer: {}, ss58: SS58,
        fetchNonce: counter(100), skipRootStore: true,
      }));
      assert.match(log, /left for the next verify round/, ">> FAIL: #1672: a round of colliding re-uploads did not hand the chunk to the next round");
      assert.ok(backoffs.length >= 3, `>> FAIL: #1672: collision retries did not back off (backoffs=${backoffs.length})`);
    } finally {
      __setNonceCollisionBackoffForTest(noBackoff);
    }
  });

  test("isNonceCollisionError: Stale and isValid:false only", () => {
    assert.equal(isNonceCollisionError(new Error(STALE)), true);
    assert.equal(isNonceCollisionError(Object.assign(new Error("x"), { chainErrorVariant: "Stale" })), true);
    assert.equal(isNonceCollisionError(new Error("chunk(nonce:1) tx rejected by pool (isValid:false)")), true);
    assert.equal(isNonceCollisionError(new Error(JSON.stringify({ type: "Invalid", value: { type: "Payment" } }))), false);
    assert.equal(isNonceCollisionError(new Error("ChainHead disjointed")), false);
  });
});

describe("#1672 live client after a mid-upload reconnect", () => {
  function run(extra) {
    const fresh = client();
    const a = api([fails("ChainHead disjointed"), ok]);
    return storeChunkedContent([CHUNK], {
      client: client(), unsafeApi: a, signer: {}, ss58: SS58,
      reconnect: async () => ({ client: fresh, unsafeApi: a, signer: {}, ss58: SS58 }),
      // A constant nonce: the failed chunk was not consumed, so it is simply resubmitted.
      fetchNonce: async () => 100, skipRootStore: true, ...extra,
    }).then((r) => ({ r, fresh }));
  }

  test("handOffLiveClient: the reconnect-created client comes back alive as liveProvider", async () => {
    const { result: { r, fresh } } = await captureLog(() => run({ handOffLiveClient: true }));
    assert.equal(r.liveProvider.client, fresh, ">> FAIL: #1672: liveProvider must carry the reconnect-created client");
    assert.equal(fresh.destroyed, false, ">> FAIL: #1672: storeChunkedContent destroyed the client it handed back; the finality probe then runs on a dead client");
  });

  // Client accounting for the paths #1672 changed: every client a reconnect opens is
  // either handed back alive (and the caller closes it) or closed here; none is left
  // open and unreachable.
  test("handOffLiveClient + reconnect + a later failure: the reconnect-created client is closed on the error path", async () => {
    const opened = [];
    const a = api([fails("ChainHead disjointed"), fails("dispatch error")]);
    const err = await captureLog(() => storeChunkedContent([CHUNK], {
      client: client(), unsafeApi: a, signer: {}, ss58: SS58,
      reconnect: async () => { const c = client(); opened.push(c); return { client: c, unsafeApi: a, signer: {}, ss58: SS58 }; },
      fetchNonce: async () => 100, skipRootStore: true, handOffLiveClient: true,
    }).then(() => null, (e) => e));
    assert.ok(err.result, "the deploy must fail: every chunk submit after the reconnect errors");
    assert.ok(opened.length >= 1, "fixture: a reconnect happened");
    assert.deepEqual(opened.map((c) => c.destroyed), opened.map(() => true),
      ">> FAIL: #1672: a reconnect-created client stayed open after storeChunkedContent failed");
  });

  test("without handOffLiveClient the reconnect-created client is still closed (callers that drop liveProvider must not leak it)", async () => {
    const { result: { fresh } } = await captureLog(() => run({}));
    assert.equal(fresh.destroyed, true, ">> FAIL: #1672: a caller that ignores liveProvider leaked the reconnect-created client");
  });
});

describe("#1672 E2E nonce-seed barrier", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "s9-barrier-"));

  test("two parties: neither returns before both seeded, and both see both seeds", async () => {
    const dir = tmp();
    const order = [];
    const a = awaitNonceSeedBarrier({ dir, seed: 7, id: "a", pollMs: 5, timeoutMs: 5000 }).then((r) => { order.push("a-done"); return r; });
    await new Promise((r) => setTimeout(r, 50));
    order.push("b-start");
    const b = awaitNonceSeedBarrier({ dir, seed: 7, id: "b", pollMs: 5, timeoutMs: 5000 });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(order[0], "b-start", ">> FAIL: #1672: party A passed the barrier before party B seeded");
    assert.deepEqual(ra, { met: true, seeds: [7, 7] });
    assert.deepEqual(rb, { met: true, seeds: [7, 7] });
  });

  test("a lone party times out and reports met:false instead of hanging", async () => {
    const r = await awaitNonceSeedBarrier({ dir: tmp(), seed: 3, id: "solo", pollMs: 5, timeoutMs: 30 });
    assert.deepEqual(r, { met: false, seeds: [3] });
  });

  test("inert without its env var, and waits at most once per process", async () => {
    __resetNonceSeedBarrierForTest();
    const t0 = Date.now();
    await e2eNonceSeedBarrier(1, {});
    assert.ok(Date.now() - t0 < 50, ">> FAIL: #1672: the barrier waited although its env var is unset");
    const dir = tmp();
    const env = { [NONCE_SEED_BARRIER_ENV]: dir, [`${NONCE_SEED_BARRIER_ENV}_PARTIES`]: "1" };
    await captureLog(() => e2eNonceSeedBarrier(5, env));
    assert.equal(fs.readdirSync(dir).length, 1, "first call writes its seed");
    const env2 = { [NONCE_SEED_BARRIER_ENV]: dir, [`${NONCE_SEED_BARRIER_ENV}_PARTIES`]: "9", [`${NONCE_SEED_BARRIER_ENV}_TIMEOUT_MS`]: "60000" };
    const t1 = Date.now();
    await e2eNonceSeedBarrier(6, env2);
    assert.ok(Date.now() - t1 < 50, ">> FAIL: #1672: a second storeChunkedContent call in the same process was held at the barrier");
    __resetNonceSeedBarrierForTest();
  });

  test("the barrier is not reachable from a CLI flag", () => {
    const bin = fs.readFileSync(new URL("../bin/polkadot-app-deploy", import.meta.url), "utf8");
    assert.doesNotMatch(bin, /NONCE_SEED_BARRIER|nonce-seed-barrier/i, ">> FAIL: #1672: the E2E-only barrier leaked into the CLI");
  });
});
