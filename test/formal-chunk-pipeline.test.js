// test/formal-chunk-pipeline.test.js — replays of formal/tla/ChunkPipeline.tla
// counterexamples against the REAL storeChunkedContent / checkPoolAccountNonceHealth
// (dist/), with every RPC stubbed. Offline: globalThis.WebSocket is replaced by a
// two-backend load-balancer simulator, the papi api/client are stubs.
//
// The FV-A-CAL / F1 / F2 / F3 replays were `todo` tests that pinned the buggy
// behaviour; since the F1 fix (#1656, #1657, #1641) they assert the FIXED
// behaviour, which the CP_Fixed* configs model. See formal/tla/FINDINGS.md.
// (Twin note: the formal/ tree is upstream-only and not mirrored; this file drives the
// real dist/ code and loads nothing from formal/.)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Twox128, Blake2128Concat } from "@polkadot-api/substrate-bindings";

// Module-load constants: must be set before dist/deploy.js is imported.
process.env.BULLETIN_CHUNK_TIMEOUT_MS = "150";
process.env.BULLETIN_CHUNK_LIVENESS_MAX_WAIT_MS = "10";

const { storeChunkedContent, setBulletinEndpoints } = await import("../dist/deploy.js");
const { _resetProbeSession, _bypassMetadataCheckForTest } = await import("../dist/chunk-probe.js");
const { checkPoolAccountNonceHealth, selectHealthyPoolAccount, StuckPoolAccountError, STUCK_NONCE_GAP_THRESHOLD } = await import("../dist/pool.js");

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const LB_URL = "wss://fv-two-backends.invalid";
const CHUNK = new Uint8Array([0xf0, 0x0a]);

// TransactionStorage.TransactionByContentHash key of a sha-256 chunk CID (chunk-probe.ts buildStorageKey).
const enc = new TextEncoder();
function contentKey(bytes) {
  const digest = createHash("sha256").update(bytes).digest();
  const parts = [Twox128(enc.encode("TransactionStorage")), Twox128(enc.encode("TransactionByContentHash")), Blake2128Concat(digest)];
  return "0x" + Buffer.concat(parts.map((p) => Buffer.from(p))).toString("hex");
}
function storageValue(block, index) {
  const b = Buffer.alloc(8); b.writeUInt32LE(block, 0); b.writeUInt32LE(index, 4);
  return "0x" + b.toString("hex");
}

// ---------------------------------------------------------------------------
// Two backends behind one load balancer (the #1637 / #1641 environment).
// Every `new WebSocket` (fetchNonce) lands on the next backend from `picks`
// (default "A"). system_accountNextIndex = on-chain nonce plus the contiguous
// run of txs that backend's pool holds from it. Backend B also holds `stuck`
// (a never-gossiped run) and receives gossip from A; A never sees B's local
// pool. By default nothing is ever included: the chain is frozen.
//   includeAfterMs: a tx accepted at the on-chain nonce on A is included that
//                   long after submission, silently (the watch never sees it).
//   sibling:        the first submit finds the slot taken by another deploy's
//                   tx on the same signer (S9), which lands at once; ours is
//                   rejected by the pool (isValid:false).
//   reportInclusion: a tx included by the sim is also reported to its watch.
// ---------------------------------------------------------------------------
function makeSim({ onchain, stuck = 0, clientOn = "A", picks = [], includeAfterMs = null, sibling = false, reportInclusion = false }) {
  const sim = {
    onchain, clientOn, picks: [...picks], includeAfterMs, sibling, reportInclusion,
    pool: { A: new Map(), B: new Map() },   // nonce -> content key
    chain: new Map(),                       // content key -> block
    stuckSet: new Set(Array.from({ length: stuck }, (_, i) => onchain + i)),
    reads: [], signed: [], onchainReads: 0,
    pick() { return sim.picks.length ? sim.picks.shift() : "A"; },
    nextIndex(b) {
      const s = b === "A" ? new Set(sim.pool.A.keys()) : new Set([...sim.stuckSet, ...sim.pool.B.keys(), ...sim.pool.A.keys()]);
      let k = sim.onchain;
      while (s.has(k)) k++;
      return k;
    },
    include(nonce) {
      const key = sim.pool.A.get(nonce);
      if (key === undefined || nonce !== sim.onchain) return false;
      sim.pool.A.delete(nonce);
      sim.chain.set(key, 2000 + sim.onchain);
      sim.onchain++;
      return true;
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

// papi stubs. System.Account at best is the sim's on-chain nonce. The store tx
// is accepted into the client's backend pool when its nonce is free there.
function makeApi() {
  return {
    query: {
      System: {
        Number: { getValue: async () => 1000 },
        Account: { getValue: async () => { sim.onchainReads++; return { nonce: sim.onchain }; } },
      },
    },
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
        store_with_cid_config: ({ data }) => ({
          signSubmitAndWatch: (_signer, opts) => ({
            subscribe({ next }) {
              const k = opts.nonce;
              const key = contentKey(data);
              sim.signed.push(k);
              let timer;
              if (sim.sibling) {
                sim.sibling = false;
                sim.pool.A.set(k, "sibling");
                sim.include(k);
                setImmediate(() => next({ type: "txBestBlocksState", found: false, isValid: false }));
                return { unsubscribe() {} };
              }
              const pool = sim.pool[sim.clientOn];
              const view = sim.clientOn === "A" ? sim.pool.A : new Map([...sim.pool.B, ...sim.pool.A]);
              if (k < sim.onchain || view.has(k)) {
                setImmediate(() => next({ type: "txBestBlocksState", found: false, isValid: false }));
                return { unsubscribe() {} };
              }
              pool.set(k, key);
              if (sim.includeAfterMs != null && sim.clientOn === "A") {
                timer = setTimeout(() => {
                  if (sim.include(k) && sim.reportInclusion) next({ type: "txBestBlocksState", found: true, ok: true });
                }, sim.includeAfterMs);
              }
              return { unsubscribe() { /* the tx stays in the pool; inclusion is the chain's business */ } };
            },
          }),
        }),
      },
    },
  };
}

// probeChunks client: TransactionByContentHash answers from sim.chain at best
// (any other key, e.g. the cross-validation Transactions[block] read, is
// absent). probeFails: every probe RPC fails (present:null). clientNonce: the
// client's own connection answers system_accountNextIndex from its backend's
// view (otherwise that read fails and the code falls back to a fresh
// connection). chain_getHeader fails, so the liveness wait fails open.
function makeClient({ probeFails = false, clientNonce = false } = {}) {
  return {
    destroy() {},
    _request: async (method, params) => {
      if (method === "system_accountNextIndex" && clientNonce) {
        const n = sim.nextIndex(sim.clientOn);
        sim.reads.push({ backend: `client:${sim.clientOn}`, n });
        return n;
      }
      if (method === "state_queryStorageAt" && !probeFails) {
        return [{ changes: params[0].map((k) => [k, sim.chain.has(k) ? storageValue(sim.chain.get(k), 0) : null]) }];
      }
      throw new Error(`stub: ${method} unavailable`);
    },
  };
}

async function runStore(simOpts, { probeFails = false, clientNonce = false } = {}) {
  sim = makeSim(simOpts);
  _resetProbeSession(); _bypassMetadataCheckForTest();
  const logs = [];
  const origLog = console.log, origWarn = console.warn;
  console.log = (...a) => { logs.push(a.join(" ")); };
  console.warn = (...a) => { logs.push(a.join(" ")); };
  let result, error;
  try {
    result = await storeChunkedContent([CHUNK], {
      client: makeClient({ probeFails, clientNonce }),
      unsafeApi: makeApi(),
      signer: {},
      ss58: SS58,
      skipRootStore: true,
    });
  } catch (e) {
    error = e;
  } finally {
    console.log = origLog; console.warn = origWarn;
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

describe("formal ChunkPipeline: #1641 calibration (stuck backend B, client on A), fixed", () => {
  // Same environment as the CAL traces (CP_Calib.cfg): the first seed read lands
  // on B, whose nextIndex runs 51 ahead. Fixed behaviour (CP_FixedCalib.cfg): the
  // read is out of bound against the on-chain nonce at best, so it is re-read;
  // nothing is ever included, so the deploy fails by name instead of succeeding.
  let run;
  before(async () => {
    run = await runStore({ onchain: 13063, stuck: 51, clientOn: "A", picks: ["B", "A", "B", "B", "B"] });
  });

  test("FV-A-CAL-1: a seed read from the stuck backend is rejected by the on-chain bound and re-read", () => {
    assert.equal(run.sim.reads[0]?.n, 13114, ">> FAIL: FV-A-CAL-1: replay setup: the first seed read should land on B (13114)");
    assert.equal(run.sim.signed[0], 13063, `>> FAIL: FV-A-CAL-1: the chunk must be signed with the in-bound nonce 13063, got ${run.sim.signed[0]}`);
    for (const k of run.sim.signed) {
      assert.ok(k - 13063 <= STUCK_NONCE_GAP_THRESHOLD,
        `>> FAIL: FV-A-CAL-1: signed nonce ${k} is more than the ${STUCK_NONCE_GAP_THRESHOLD}-tx in-flight bound above the on-chain nonce`);
    }
    assert.ok(run.logs.some((l) => /stuck backend/i.test(l) && l.includes("13114")),
      ">> FAIL: FV-A-CAL-1: expected a log naming the out-of-bound (stuck backend) nonce read 13114");
  });

  test("FV-A-CAL-1b: the seed is read over the deploy's own connection first, so the stuck backend's view is never used", async () => {
    const r = await runStore({ onchain: 13063, stuck: 51, clientOn: "A", picks: Array(40).fill("B") }, { clientNonce: true });
    assert.equal(r.sim.reads[0]?.backend, "client:A", ">> FAIL: FV-A-CAL-1b: the first nonce read must go over the deploy's own connection");
    assert.equal(r.sim.signed[0], 13063, `>> FAIL: FV-A-CAL-1b: expected the chunk signed at 13063, got ${r.sim.signed[0]}`);
    for (const k of r.sim.signed) {
      assert.ok(k - 13063 <= STUCK_NONCE_GAP_THRESHOLD, `>> FAIL: FV-A-CAL-1b: signed nonce ${k} is out of bound`);
    }
  });

  test("FV-A-CAL-2: reconcile never reports a chunk as already included on the pool view", () => {
    assert.ok(!run.logs.some((l) => l.includes("reconcile found it already included")),
      ">> FAIL: FV-A-CAL-2: reconcile reported 'already included' for a chunk that never reached the chain");
    assert.equal(run.sim.chain.size, 0, ">> FAIL: FV-A-CAL-2: replay setup: nothing is ever included");
  });

  test("FV-A-F2 (#1637 env): storeChunkedContent fails, by name, when the chunk never reaches the chain", () => {
    assert.ok(run.error, ">> FAIL: FV-A-F2: storeChunkedContent returned success with the chunk absent from the chain");
    assert.equal(run.result, undefined, ">> FAIL: FV-A-F2: no storage CID may be returned");
    assert.match(run.error.message, /chunk 1/i, `>> FAIL: FV-A-F2: the error must name the chunk, got: ${run.error.message}`);
    assert.ok(!run.logs.some((l) => /nonce advanced past/.test(l)),
      ">> FAIL: FV-A-F2: the pool-aware nonce fallback must no longer confirm anything");
  });
});

describe("formal ChunkPipeline: no stuck backend, fixed", () => {
  test("FV-A-F1/F2: a chunk still pending at the watch timeout is never 'included' by the nonce, and the re-upload is not either", async () => {
    const run = await runStore({ onchain: 500, stuck: 0, clientOn: "A" });
    assert.ok(run.error, ">> FAIL: FV-A-F1/F2: storeChunkedContent returned success with nothing on-chain");
    assert.ok(!run.logs.some((l) => /nonce advanced past/.test(l) || l.includes("already included")),
      ">> FAIL: FV-A-F1: the watcher fallback or reconcile claimed inclusion from the pool view");
    assert.ok(run.logs.some((l) => l.includes("Nonce-collision re-upload: chunk 1")),
      ">> FAIL: FV-A-F2: the verify loop must re-upload the absent chunk");
    for (const k of run.sim.signed) assert.ok(k - 500 <= STUCK_NONCE_GAP_THRESHOLD, `>> FAIL: FV-A-F2: signed nonce ${k} out of bound`);
    assert.equal(run.sim.chain.size, 0, ">> FAIL: FV-A-F2: replay setup: nothing was included");
  });

  test("FV-A-F3: a present:null verify probe is retried a bounded number of times, then fails with ChunkInclusionUnverifiedError", async () => {
    const run = await runStore({ onchain: 700, stuck: 0, clientOn: "A" }, { probeFails: true });
    assert.ok(run.error, ">> FAIL: FV-A-F3: an unverifiable chunk was kept as stored");
    assert.equal(run.error.name, "ChunkInclusionUnverifiedError", `>> FAIL: FV-A-F3: expected ChunkInclusionUnverifiedError, got ${run.error.name}: ${run.error.message}`);
    assert.match(run.error.message, /chunk 1/i, ">> FAIL: FV-A-F3: the error must name the chunk");
    assert.equal(run.sim.chain.size, 0, ">> FAIL: FV-A-F3: replay setup: the chunk was never included");
  });

  test("FV-A-POS: a chunk that lands after the watch timeout is found by the best-block probe and the deploy succeeds", async () => {
    const run = await runStore({ onchain: 900, stuck: 0, clientOn: "A", includeAfterMs: 60 });
    assert.equal(run.error, undefined, `>> FAIL: FV-A-POS: expected success, got ${run.error?.message}`);
    assert.ok(run.result?.storageCid, ">> FAIL: FV-A-POS: expected a storage CID");
    assert.deepEqual(run.sim.signed, [900], ">> FAIL: FV-A-POS: the chunk was on-chain; no resubmit or re-upload may be signed");
    assert.equal(run.sim.chain.size, 1, ">> FAIL: FV-A-POS: the chunk is on-chain");
  });

  test("FV-A-S9: a sibling deploy takes the nonce slot; the chunk is re-uploaded at a fresh nonce and verified", async () => {
    const run = await runStore({ onchain: 300, stuck: 0, clientOn: "A", sibling: true, includeAfterMs: 5, reportInclusion: true });
    assert.equal(run.error, undefined, `>> FAIL: FV-A-S9: expected success, got ${run.error?.message}`);
    assert.equal(run.sim.signed[0], 300, ">> FAIL: FV-A-S9: replay setup: first submit at the seed nonce");
    assert.ok(run.sim.signed.slice(1).every((k) => k === 301), `>> FAIL: FV-A-S9: resubmits must move to the fresh nonce 301, signed ${run.sim.signed}`);
    assert.ok(run.sim.chain.has(contentKey(CHUNK)), ">> FAIL: FV-A-S9: our chunk must be on-chain when the deploy reports success");
    assert.ok(run.logs.some((l) => /nonce 300 consumed|Nonce-collision re-upload/.test(l)),
      ">> FAIL: FV-A-S9: expected a nonce-collision recovery log (S9's e2e regex depends on it)");
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
