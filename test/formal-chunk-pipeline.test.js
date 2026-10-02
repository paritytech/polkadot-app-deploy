// test/formal-chunk-pipeline.test.js — replays of formal/tla/ChunkPipeline.tla
// counterexamples against the REAL storeChunkedContent / checkPoolAccountNonceHealth
// (dist/), with every RPC stubbed. Offline: globalThis.WebSocket is replaced by a
// two-backend load-balancer simulator, the papi api/client are stubs.
//
// Each test asserts the CURRENT (buggy) behaviour and is marked `todo`, so the
// suite stays green. When a fix lands, the assertion flips and the test should
// be rewritten to pin the fixed behaviour. See formal/tla/FINDINGS.md.
// (Twin note: the formal/ tree is upstream-only and not mirrored; this file drives the
// real dist/ code and loads nothing from formal/.)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// Module-load constants: must be set before dist/deploy.js is imported.
process.env.BULLETIN_CHUNK_TIMEOUT_MS = "150";
process.env.BULLETIN_CHUNK_LIVENESS_MAX_WAIT_MS = "10";

const { storeChunkedContent, setBulletinEndpoints } = await import("../dist/deploy.js");
const { _resetProbeSession, _bypassMetadataCheckForTest } = await import("../dist/chunk-probe.js");
const { checkPoolAccountNonceHealth, selectHealthyPoolAccount, StuckPoolAccountError } = await import("../dist/pool.js");

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const LB_URL = "wss://fv-two-backends.invalid";

// ---------------------------------------------------------------------------
// Two backends behind one load balancer (the #1637 / #1641 environment).
// Every `new WebSocket` (fetchNonce, verifyNonceAdvanced) lands on the next
// backend from `picks` (default "A"). system_accountNextIndex = on-chain nonce
// plus the contiguous run of txs that backend's pool holds from it. Backend B
// also holds `stuck` (a never-gossiped run) and receives gossip from A; A never
// sees B's local pool. Nothing is ever included: the chain is frozen.
// ---------------------------------------------------------------------------
function makeSim({ onchain, stuck = 0, clientOn = "A", picks = [] }) {
  const sim = {
    onchain, clientOn, picks: [...picks],
    pool: { A: new Set(), B: new Set() },
    stuckSet: new Set(Array.from({ length: stuck }, (_, i) => onchain + i)),
    reads: [], signed: [],
    pick() { return sim.picks.length ? sim.picks.shift() : "A"; },
    nextIndex(b) {
      const s = b === "A" ? sim.pool.A : new Set([...sim.stuckSet, ...sim.pool.B, ...sim.pool.A]);
      let k = sim.onchain;
      while (s.has(k)) k++;
      return k;
    },
  };
  return sim;
}

let sim;
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.backend = sim.pick();
    setImmediate(() => this.onopen?.());
  }
  send(raw) {
    const { id } = JSON.parse(raw);
    const n = sim.nextIndex(this.backend);
    sim.reads.push({ backend: this.backend, n });
    setImmediate(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result: n }) }));
  }
  close() {}
}

// papi stubs: the store tx is accepted into the client's backend pool and never
// reported in a best block (the watcher only ever times out).
function makeApi() {
  return {
    query: { System: { Number: { getValue: async () => 1000 } } },
    apis: {
      BulletinTransactionStorageApi: {
        account_authorization: async () => ({
          expires_at: 9_999_999, bytes_allowance: 100_000_000n, bytes_used: 0n, bytes_permanent_used: 0n,
          transactions_allowance: 1000, transactions_used: 0,
        }),
        can_store: async () => true,
      },
    },
    tx: {
      TransactionStorage: {
        store_with_cid_config: () => ({
          signSubmitAndWatch: (_signer, opts) => {
            sim.signed.push(opts.nonce);
            sim.pool[sim.clientOn].add(opts.nonce);
            return { subscribe() { return { unsubscribe() {} }; } };
          },
        }),
      },
    },
  };
}

// probeChunks client: every CID is absent (present:false), or every probe RPC
// fails (present:null) when probeFails is set. chain_getHeader fails (liveness
// wait fails open).
function makeClient({ probeFails = false } = {}) {
  return {
    destroy() {},
    _request: async (method, params) => {
      if (method === "state_queryStorageAt" && !probeFails) return [{ changes: params[0].map((k) => [k, null]) }];
      throw new Error(`stub: ${method} unavailable`);
    },
  };
}

async function runStore(simOpts, { probeFails = false } = {}) {
  sim = makeSim(simOpts);
  _resetProbeSession(); _bypassMetadataCheckForTest();
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };
  let result, error;
  try {
    result = await storeChunkedContent([new Uint8Array([0xf0, 0x0a])], {
      client: makeClient({ probeFails }),
      unsafeApi: makeApi(),
      signer: {},
      ss58: SS58,
      skipRootStore: true,
    });
  } catch (e) {
    error = e;
  } finally {
    console.log = origLog;
  }
  return { result, error, logs, sim };
}

let savedWS;
before(() => {
  savedWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  setBulletinEndpoints([LB_URL]);
});
after(() => { globalThis.WebSocket = savedWS; });

describe("formal ChunkPipeline: #1641 calibration (stuck backend B, client on A)", () => {
  // Trace (Calib.cfg, NonceBounded + NoFalseIncludedReconcile): seed read -> B;
  // watcher fallback -> A (not advanced); retry reconcile read -> B; reprobe
  // re-upload seed -> B; re-upload fallback -> B.
  let run;
  before(async () => {
    run = await runStore({ onchain: 13063, stuck: 51, clientOn: "A", picks: ["B", "A", "B", "B", "B"] });
  });

  test("FV-A-CAL-1: the chunk nonce is seeded from one fetchNonce read that lands on the stuck backend",
    { todo: "#1641 item 1: seed is not validated against the on-chain nonce" }, () => {
      assert.equal(run.sim.signed[0], 13114, ">> FAIL: FV-A-CAL-1: expected the chunk to be signed with B's pool-aware nextIndex");
      assert.ok(run.sim.signed[0] - run.sim.onchain > 8,
        ">> FAIL: FV-A-CAL-1: the signed nonce should sit far above the on-chain nonce (more than the 8-tx in-flight bound)");
    });

  test("FV-A-CAL-2: reconcileTimedOutChunk treats a never-included chunk as included because nextIndex counts pool txs",
    { todo: "#1641 item 2: reconcile reads the pool view, not the chain" }, () => {
      assert.ok(run.logs.some((l) => l.includes("reconcile found it already included (nonce 13114→13115")),
        ">> FAIL: FV-A-CAL-2: expected the #1641 log line 'reconcile found it already included (nonce 13114→13115)'");
      assert.equal(run.sim.onchain, 13063, ">> FAIL: FV-A-CAL-2: nothing was ever included in this replay");
    });

  test("FV-A-F2 (#1637 env): storeChunkedContent returns success with the chunk absent from the chain",
    { todo: "FV-A-F2 #1656: the reprobe re-upload is resolved by the nonce fallback and never re-verified" }, () => {
      assert.equal(run.error, undefined, `>> FAIL: FV-A-F2: expected success, got ${run.error?.message}`);
      assert.ok(run.result?.storageCid, ">> FAIL: FV-A-F2: expected a storage CID to be returned");
      assert.ok(run.logs.some((l) => l.includes("Nonce-collision re-upload: chunk 1")),
        ">> FAIL: FV-A-F2: the reprobe saw the chunk absent and re-uploaded it");
      assert.ok(run.logs.some((l) => /nonce advanced past 13115 .* tx was included/.test(l)),
        ">> FAIL: FV-A-F2: the re-upload was 'confirmed' only by the pool-aware nonce fallback");
    });
});

describe("formal ChunkPipeline: no stuck backend, slow inclusion", () => {
  test("FV-A-F1/F2: with one healthy backend, a chunk still pending at the watch timeout is 'included' via the nonce fallback, and the re-upload is too",
    { todo: "FV-A-F1/F2 #1656: verifyNonceAdvanced counts the deploy's own pending tx; FV-A-F2: the re-upload is never re-verified" }, async () => {
      const run = await runStore({ onchain: 500, stuck: 0, clientOn: "A" });
      assert.equal(run.error, undefined, `>> FAIL: FV-A-F1: expected success, got ${run.error?.message}`);
      assert.ok(run.logs.some((l) => l.includes("nonce advanced past 500")),
        ">> FAIL: FV-A-F1: the first watch should have resolved via the nonce fallback");
      assert.deepEqual(run.sim.signed, [500, 501], ">> FAIL: FV-A-F2: one original + one re-upload, the re-upload stacked on the still-pending original");
      assert.equal(run.sim.onchain, 500, ">> FAIL: FV-A-F2: nothing was included, yet the upload reported success");
    });

  test("FV-A-F3: a present:null reprobe keeps a nonce-fallback claim, with no re-upload",
    { todo: "FV-A-F3 #1657: the post-batch reprobe treats present:null as present" }, async () => {
      const run = await runStore({ onchain: 700, stuck: 0, clientOn: "A" }, { probeFails: true });
      assert.equal(run.error, undefined, `>> FAIL: FV-A-F3: expected success, got ${run.error?.message}`);
      assert.deepEqual(run.sim.signed, [700], ">> FAIL: FV-A-F3: expected exactly one signed tx (no re-upload after an indeterminate probe)");
      assert.ok(!run.logs.some((l) => l.includes("Nonce-collision re-upload")), ">> FAIL: FV-A-F3: no re-upload is attempted");
      assert.equal(run.sim.onchain, 700, ">> FAIL: FV-A-F3: the chunk was never included");
    });
});

describe("formal ChunkPipeline: health check vs a busy shared signer (FV-A-F4, #1658 fixed)", () => {
  const busy = [{ index: 3, address: "5Busy", transactions: 10n, renewBytes: 0n, expiration: 0 }];

  test("FV-A-F4: a healthy account whose in-flight queue exceeds the threshold is NOT called stuck when no block lands in the re-read window", async () => {
    let reads = 0;
    const h = await checkPoolAccountNonceHealth("5Busy", {
      readOnchainNonce: async () => { reads++; return 100; }, // the chain never includes the head during the check
      readNextIndex: async () => 109,                         // 9 ready txs from concurrent deploys: valid, gossiped, on every backend
      samples: 2,
      sleep: async () => {},
    });
    assert.notEqual(h.verdict, "stuck", ">> FAIL: FV-A-F4: a busy, gossiped queue (every backend sees it) must not be classified stuck");
    assert.equal(h.verdict, "unknown", ">> FAIL: FV-A-F4: a uniform large gap with a flat nonce is ambiguous, so the verdict is unknown");
    assert.equal(h.backendLocal, false);
    assert.equal(reads, 1, ">> FAIL: FV-A-F4: a gossiped queue can never be stuck, so no re-read wait is spent on it");
    const sel = await selectHealthyPoolAccount(busy, { pinnedIndex: 3, checkHealth: async () => h, log: { warn() {} } });
    assert.equal(sel.account.index, 3, ">> FAIL: FV-A-F4: pinned, the busy account must be used, not failed fast with StuckPoolAccountError");
  });

  test("FV-A-F4: a busy queue whose head lands after the old 12 s window but inside the extended one is healthy", async () => {
    const onchain = [100, 100, 100, 101];
    const h = await checkPoolAccountNonceHealth("5Busy", {
      readOnchainNonce: async () => (onchain.length > 1 ? onchain.shift() : onchain[0]),
      readNextIndex: async (_a, i) => (i % 2 === 0 ? 109 : 101), // a lagging backend: the spread alone does not decide
      samples: 2,
      sleep: async () => {},
    });
    assert.equal(h.verdict, "healthy", ">> FAIL: FV-A-F4: the nonce advanced inside the extended window, so the account is busy, not stuck");
  });

  test("FV-A-F4 control: the //deploy/8 shape (queue on one backend only, nonce flat) is still stuck and a pin still fails fast", async () => {
    const h = await checkPoolAccountNonceHealth("5HZK3oa3", {
      readOnchainNonce: async () => 13063,
      // #1640 live sweep: samples a mix of 13063 (healthy backend) and 13114 (the backend holding the never-gossiped run)
      readNextIndex: async (_a, i) => (i % 3 === 0 ? 13114 : 13063),
      samples: 6,
      sleep: async () => {},
    });
    assert.equal(h.verdict, "stuck", ">> FAIL: FV-A-F4 control: a backend-local run with a flat nonce must stay stuck (#1640)");
    assert.equal(h.backendLocal, true);
    await assert.rejects(
      selectHealthyPoolAccount([{ index: 8, address: "5HZK3oa3", transactions: 10n, renewBytes: 0n, expiration: 0 }],
        { pinnedIndex: 8, checkHealth: async () => h, log: { warn() {} } }),
      (e) => e instanceof StuckPoolAccountError,
      ">> FAIL: FV-A-F4 control: pinned, the genuinely stuck account must still fail fast");
  });
});
