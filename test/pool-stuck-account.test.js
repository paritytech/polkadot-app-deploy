// #1637: a pool account whose pending-tx queue is stuck (system_accountNextIndex far ahead of the
// on-chain nonce) must be skipped by random selection, and fail fast when pinned, instead of
// costing 3 x 180 s chunk timeouts. All RPC is injected; no chain access.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STUCK_NONCE_GAP_THRESHOLD,
  nonceGapVerdict,
  checkPoolAccountNonceHealth,
  selectHealthyPoolAccount,
  selectAccount,
  parsePoolDerivationIndex,
  poolAccountDerivationPath,
} from "../dist/pool.js";
import { NonRetryableError } from "../dist/errors.js";
import { getDeployAttributes } from "../dist/telemetry.js";
import * as fs from "node:fs";

const noSleep = async () => {};

const auths = Array.from({ length: 10 }, (_, i) => ({
  index: i,
  address: `5Addr${i}`,
  signer: {},
  transactions: 100n,
  renewBytes: 0n,
  expiration: 1_000_000,
}));

const healthy = (i) => ({ verdict: "healthy", onchain: 10, nextIndex: 10, gap: 0, samples: [10] });
const stuck = (i) => ({ verdict: "stuck", onchain: 13063, nextIndex: 13116, gap: 53, samples: [13063, 13116] });
const unknown = () => ({ verdict: "unknown", samples: [], reason: "rpc down" });
const silent = { warn() {} };

// ---- verdict ----

test("nonceGapVerdict: gap at the threshold is healthy, one above is stuck", () => {
  assert.equal(STUCK_NONCE_GAP_THRESHOLD, 8);
  assert.equal(nonceGapVerdict(100, 100), "healthy");
  assert.equal(nonceGapVerdict(100, 108), "healthy", ">> FAIL: verdict: a gap equal to the threshold (normal in-flight deploys) must stay healthy");
  assert.equal(nonceGapVerdict(100, 109), "stuck", ">> FAIL: verdict: a gap above the threshold must be stuck");
  assert.equal(nonceGapVerdict(13063, 13116), "stuck", ">> FAIL: verdict: the #1637 gap of 53 must be stuck");
});

test("nonceGapVerdict: a negative gap (lagging backend) is healthy", () => {
  assert.equal(nonceGapVerdict(100, 95), "healthy", ">> FAIL: verdict: a backend lagging behind the chain is not a stuck queue");
});

test("nonceGapVerdict: honours a custom threshold", () => {
  assert.equal(nonceGapVerdict(0, 3, 2), "stuck");
  assert.equal(nonceGapVerdict(0, 2, 2), "healthy");
});

// ---- health check ----

test("checkPoolAccountNonceHealth: takes the MAX over nextIndex samples (one stuck backend behind a load balancer)", async () => {
  const seq = [13063, 13116, 13063, 13063];
  const sampleIdx = [];
  const h = await checkPoolAccountNonceHealth("5Addr8", {
    readOnchainNonce: async () => 13063,
    readNextIndex: async (_addr, i) => { sampleIdx.push(i); return seq[i]; },
    samples: 4,
    sleep: noSleep,
  });
  assert.equal(h.verdict, "stuck", ">> FAIL: health: one sample hitting the stuck backend must mark the account stuck");
  assert.equal(h.onchain, 13063);
  assert.equal(h.nextIndex, 13116);
  assert.equal(h.gap, 53);
  assert.deepEqual(sampleIdx.sort(), [0, 1, 2, 3], ">> FAIL: health: every sample index must be requested once");
});

test("checkPoolAccountNonceHealth: healthy when every sample agrees with the chain", async () => {
  const h = await checkPoolAccountNonceHealth("5Addr1", {
    readOnchainNonce: async () => 42,
    readNextIndex: async () => 44,
    samples: 3,
  });
  assert.equal(h.verdict, "healthy");
  assert.equal(h.gap, 2);
});

test("checkPoolAccountNonceHealth: partial sample failure uses the samples that succeeded", async () => {
  const h = await checkPoolAccountNonceHealth("5Addr8", {
    readOnchainNonce: async () => 100,
    readNextIndex: async (_a, i) => { if (i === 0) throw new Error("ws closed"); return 200; },
    samples: 2,
    sleep: noSleep,
  });
  assert.equal(h.verdict, "stuck");
  assert.deepEqual(h.samples, [200]);
});

test("checkPoolAccountNonceHealth: every sample failing yields 'unknown', never throws", async () => {
  const h = await checkPoolAccountNonceHealth("5Addr8", {
    readOnchainNonce: async () => 100,
    readNextIndex: async () => { throw new Error("All promises were rejected"); },
    samples: 3,
  });
  assert.equal(h.verdict, "unknown", ">> FAIL: health: an RPC failure must not block the deploy");
  assert.match(h.reason, /nextIndex/);
});

test("checkPoolAccountNonceHealth: on-chain read failure yields 'unknown'", async () => {
  const h = await checkPoolAccountNonceHealth("5Addr8", {
    readOnchainNonce: async () => { throw new Error("storage query failed"); },
    readNextIndex: async () => 200,
    samples: 2,
  });
  assert.equal(h.verdict, "unknown");
  assert.match(h.reason, /storage query failed/);
});

test("checkPoolAccountNonceHealth: a hanging RPC is bounded by timeoutMs", async () => {
  const started = Date.now();
  const h = await checkPoolAccountNonceHealth("5Addr8", {
    readOnchainNonce: () => new Promise(() => {}),
    readNextIndex: () => new Promise(() => {}),
    samples: 2,
    timeoutMs: 100,
  });
  assert.equal(h.verdict, "unknown");
  assert.ok(Date.now() - started < 2_000, ">> FAIL: health: a stalled RPC must not hang selection past its timeout");
});

test("checkPoolAccountNonceHealth: a large gap whose on-chain nonce advances is a BUSY account, not stuck", async () => {
  const onchain = [100, 103];
  const slept = [];
  const h = await checkPoolAccountNonceHealth("5Addr1", {
    readOnchainNonce: async () => onchain.shift(),
    readNextIndex: async () => 112,
    samples: 2,
    confirmDelayMs: 12_000,
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.deepEqual(slept, [12_000], ">> FAIL: health: a large gap must wait confirmDelayMs before the re-read");
  assert.equal(h.verdict, "healthy", ">> FAIL: health: concurrent deploys draining their queue (nonce advanced) must not be flagged stuck");
  assert.equal(h.onchain, 103);
  assert.equal(h.gap, 9);
});

test("checkPoolAccountNonceHealth: a large gap whose on-chain nonce stays flat is stuck", async () => {
  let reads = 0;
  const h = await checkPoolAccountNonceHealth("5Addr8", {
    readOnchainNonce: async () => { reads++; return 13063; },
    readNextIndex: async () => 13116,
    samples: 2,
    sleep: noSleep,
  });
  assert.equal(h.verdict, "stuck");
  assert.equal(reads, 2, ">> FAIL: health: the stuck verdict must be confirmed by a second on-chain read");
});

test("checkPoolAccountNonceHealth: a small gap never pays the confirmation wait", async () => {
  let slept = false;
  const h = await checkPoolAccountNonceHealth("5Addr1", {
    readOnchainNonce: async () => 10,
    readNextIndex: async () => 12,
    samples: 2,
    sleep: async () => { slept = true; },
  });
  assert.equal(h.verdict, "healthy");
  assert.equal(slept, false, ">> FAIL: health: the happy path must not sleep");
});

test("checkPoolAccountNonceHealth: a failed confirmation re-read yields 'unknown'", async () => {
  let n = 0;
  const h = await checkPoolAccountNonceHealth("5Addr8", {
    readOnchainNonce: async () => { if (n++ > 0) throw new Error("ws gone"); return 13063; },
    readNextIndex: async () => 13116,
    samples: 2,
    sleep: noSleep,
  });
  assert.equal(h.verdict, "unknown");
  assert.match(h.reason, /re-read/);
});

test("getDirectProvider checks the signer's queue and fails fast (NonRetryableError) when stuck", () => {
  const src = fs.readFileSync(new URL("../src/deploy.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function getDirectProvider(");
  const end = src.indexOf("async function getSignerProvider(", start);
  assert.ok(start !== -1 && end !== -1, ">> FAIL: direct provider: getDirectProvider/getSignerProvider markers not found in src/deploy.ts");
  const body = src.slice(start, end);
  assert.match(body, /checkSignerQueue\(unsafeApi, "direct signer", ss58\)/, ">> FAIL: direct provider: the E2E pinned pool legs store through getDirectProvider (--derivation-path //deploy/N), so it must run the queue check");
  assert.match(body, /verdict === "stuck"[\s\S]{0,400}throw new NonRetryableError\(stuckQueueMessage\(/, ">> FAIL: direct provider: a stuck direct signer must fail fast with stuckQueueMessage");
  assert.match(body, /recordStuckSkipped\(/, ">> FAIL: direct provider: the fail-fast must record deploy.pool.stuck_skipped");
});

// ---- selection ----

test("selectHealthyPoolAccount: a healthy first draw is exactly selectAccount's draw (distribution unchanged)", async () => {
  for (const r of [0, 0.15, 0.55, 0.99]) {
    const expected = selectAccount(auths, () => r).account.index;
    const res = await selectHealthyPoolAccount(auths, { random: () => r, checkHealth: async (a) => healthy(a.index), log: silent });
    assert.equal(res.account.index, expected, `>> FAIL: selection: random=${r} must pick the same index as selectAccount`);
    assert.deepEqual(res.skippedStuck, []);
    assert.equal(res.eligibleCount, 10);
  }
});

test("selectHealthyPoolAccount: skips a stuck draw, warns, and draws again from the rest", async () => {
  const warnings = [];
  const draws = [0.85, 0.0]; // 0.85*10 -> index 8 (stuck); then 0.0 over the 9 remaining -> index 0
  const res = await selectHealthyPoolAccount(auths, {
    random: () => draws.shift(),
    checkHealth: async (a) => (a.index === 8 ? stuck(8) : healthy(a.index)),
    log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(res.account.index, 0, ">> FAIL: selection: a stuck account must be replaced by the next healthy draw");
  assert.deepEqual(res.skippedStuck.map((s) => s.index), [8]);
  assert.equal(res.eligibleCount, 10);
  assert.ok(warnings.some((w) => /pool account 8/.test(w) && /13063/.test(w) && /13116/.test(w)), `>> FAIL: selection: the skip warning must name the account and both nonces; got ${JSON.stringify(warnings)}`);
});

test("selectHealthyPoolAccount: every account stuck falls back to the first draw with a warning", async () => {
  const warnings = [];
  const res = await selectHealthyPoolAccount(auths.slice(0, 3), {
    random: () => 0.5,
    checkHealth: async (a) => stuck(a.index),
    log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(res.account.index, 1, ">> FAIL: selection: with no healthy account, keep today's first draw");
  assert.equal(res.skippedStuck.length, 3);
  assert.ok(warnings.some((w) => /every pool account/i.test(w)));
});

test("selectHealthyPoolAccount: an 'unknown' health check falls through to today's behaviour", async () => {
  const warnings = [];
  const res = await selectHealthyPoolAccount(auths, {
    random: () => 0.85,
    checkHealth: async () => unknown(),
    log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(res.account.index, 8, ">> FAIL: selection: an unchecked account must still be used (RPC trouble never blocks a deploy)");
  assert.deepEqual(res.skippedStuck, []);
  assert.deepEqual(warnings, []);
});

test("parsePoolDerivationIndex inverts poolAccountDerivationPath", () => {
  assert.equal(parsePoolDerivationIndex(poolAccountDerivationPath(8)), 8);
  assert.equal(parsePoolDerivationIndex("//deploy/12"), 12);
  assert.equal(parsePoolDerivationIndex(""), undefined);
  assert.equal(parsePoolDerivationIndex("//e2e-direct"), undefined);
  assert.equal(parsePoolDerivationIndex("//deploy/8//x"), undefined);
});

test("selectHealthyPoolAccount: a checkHealth that throws is treated as 'unknown'", async () => {
  const res = await selectHealthyPoolAccount(auths, {
    random: () => 0.3,
    checkHealth: async () => { throw new Error("boom"); },
    log: silent,
  });
  assert.equal(res.account.index, 3);
});

test("selectHealthyPoolAccount: pinned + stuck fails fast with an actionable NonRetryableError", async () => {
  await assert.rejects(
    selectHealthyPoolAccount(auths, { pinnedIndex: 8, checkHealth: async () => stuck(8), log: silent }),
    (e) => {
      assert.ok(e instanceof NonRetryableError, ">> FAIL: pinned: a stuck pinned account must be non-retryable");
      assert.match(e.message, /BULLETIN_POOL_ACCOUNT_INDEX=8/);
      assert.match(e.message, /5Addr8/);
      assert.match(e.message, /13063/);
      assert.match(e.message, /13116/);
      assert.match(e.message, /53/);
      assert.match(e.message, /unset BULLETIN_POOL_ACCOUNT_INDEX|another index/i, ">> FAIL: pinned: the error must name the remedy");
      assert.deepEqual(e.skippedStuck?.map((s) => s.index), [8], ">> FAIL: pinned: the error must carry the skipped account for telemetry");
      return true;
    },
  );
});

test("selectHealthyPoolAccount: pinned + healthy / unknown proceeds on the pinned account", async () => {
  for (const h of [healthy(8), unknown()]) {
    const res = await selectHealthyPoolAccount(auths, { pinnedIndex: 8, checkHealth: async () => h, log: silent });
    assert.equal(res.account.index, 8);
  }
});

test("selectHealthyPoolAccount: a pinned index missing from the pool still throws (unchanged #863 contract)", async () => {
  await assert.rejects(
    selectHealthyPoolAccount(auths.slice(0, 3), { pinnedIndex: 8, checkHealth: async () => healthy(8), log: silent }),
    /pool account index 8 not available/,
  );
});

// ---- telemetry ----

test("deploy.pool.stuck_skipped is seeded 'none' (string) on every span", () => {
  const attrs = getDeployAttributes("example.dot");
  assert.equal(attrs["deploy.pool.stuck_skipped"], "none", ">> FAIL: telemetry: the stuck-skip attribute must default to the string 'none' so count_if has a denominator");
});

test("the queue check runs on a deploy's first provider only, not on every mid-upload reconnect", () => {
  const src = fs.readFileSync(new URL("../src/deploy.ts", import.meta.url), "utf8");
  const start = src.indexOf("export function selectStorageReconnect(");
  const end = src.indexOf("\nfunction watchTransaction", start);
  assert.ok(start !== -1 && end !== -1, ">> FAIL: reconnect: selectStorageReconnect markers not found in src/deploy.ts");
  const body = src.slice(start, end);
  assert.match(body, /const pool = firstCallChecksQueue\(\(checkQueue\) => getProvider\(\{ checkQueue \}\)\)/, ">> FAIL: reconnect: pool reconnects must go through firstCallChecksQueue (S8 halt storms would pay 8 s per sample on every reconnect)");
  assert.match(body, /firstCallChecksQueue\(\(checkQueue\) => getDirectProvider\(options\.mnemonic!, options\.derivationPath, \{ checkQueue \}\)\)/, ">> FAIL: reconnect: direct reconnects must go through firstCallChecksQueue");
  assert.doesNotMatch(body, /return getProvider\(\)/, ">> FAIL: reconnect: a bare getProvider() here would re-run the queue check on every reconnect");
});
