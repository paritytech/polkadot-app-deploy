/**
 * E2E chain-call encoding test suite.
 *
 * Verifies that every extrinsic the codebase submits can be BUILT (getEncodedData)
 * without throwing an "Incompatible runtime entry" error from papi's isCompat check.
 * This catches arg-value-type bugs (wrong JS type for a papi 2.x arg) before they
 * reach the live chain.
 *
 * Gate: E2E=1 (requires live chain access to fetch metadata).
 * Completeness guard: runs without the chain and asserts every tx call in src/
 * is covered here.
 *
 * Arg-type rules confirmed against live paseo-next-v2 metadata:
 *   Vec<u8> / BoundedVec<u8>   → Binary (NOT a hex string)
 *   [u8;N] FixedSizeBinary      → hex string (NOT Binary)
 *   u32                         → JS number
 *   u64 / u128                  → JS bigint
 *   AccountId32 (bare SS58)     → SS58 string
 *   MultiAddress                → Enum("Id", ss58)
 *   Weight                      → { ref_time: bigint, proof_size: bigint }
 *   H160 (20-byte addr)         → hex string "0x" + 20 bytes
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import * as path from "path";
import { createClient, Binary, Enum } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { loadEnvironments } from "../dist/environments.js";
import { ACCOUNT_AUTHORIZATION_FIELDS } from "../dist/pool.js";
import { withTimeout } from "../dist/commands/login.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Environment guard
// ---------------------------------------------------------------------------

const ENABLED = process.env.E2E === "1";

// ---------------------------------------------------------------------------
// Endpoints — resolved from environments.json for the selected/default env.
// PAD_ENV is set by CI's select-env job (which probes + falls back);
// default to paseo-next-v2 locally. Never hardcode wss URLs — they must track
// environments.json so an endpoint change can't silently desync the test.
// ---------------------------------------------------------------------------

const ENV_ID = process.env.PAD_ENV ?? "paseo-next-v2";
const endpoints = {}; // chainId → wss, populated in before()

// ---------------------------------------------------------------------------
// Timeouts (#1595) — every client connect, metadata/runtime fetch, and
// per-extrinsic encode call is bounded so a stalled RPC fails fast instead of
// hanging the job until CI's 10-minute timeout cancels it. An open WebSocket
// from an unbounded connect is exactly what kept the process alive.
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

function wssFor(doc, chainId) {
  const entry = doc.chains.find((c) => c.id === chainId)?.endpoints?.[ENV_ID];
  const wss = Array.isArray(entry?.wss) ? entry.wss[0] : entry?.wss;
  if (!wss) {
    throw new Error(
      `>> FAIL: chain-call-encoding: no '${chainId}' endpoint for env '${ENV_ID}' in environments.json`,
    );
  }
  return wss;
}

// ---------------------------------------------------------------------------
// Dummy values (representative; trigger real papi isCompat checks)
// ---------------------------------------------------------------------------

// A real SS58 address (Alice on Paseo)
const DUMMY_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
// H160 dest for Revive.call (20-byte zero address)
const DUMMY_H160 = "0x" + "00".repeat(20);
// [u8;32] FixedSizeBinary → hex string
const DUMMY_HEX32 = "0x" + "03".repeat(32);
// BoundedVec<u8> / Vec<u8> proof (785 bytes for ring-VRF proofs) → Binary
const DUMMY_PROOF_785 = Binary.fromHex("0x" + "07".repeat(785));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(wss) {
  return createClient(getWsProvider(wss));
}

/**
 * Race a live-chain call against a per-step timeout, naming the chain, the
 * endpoint, and the step in the failure message so a CI hang points straight
 * at the stalled RPC (#1595).
 */
function chainCall(promise, { chain, endpoint, step, timeoutMs }) {
  return withTimeout(
    promise,
    timeoutMs,
    `>> FAIL: chain-call ${chain}: RPC stalled after ${timeoutMs / 1000}s connecting to ${endpoint} (step: ${step})`,
  );
}

/** Marker so callers can tell "our own timeout" apart from any other rejection. */
function isChainCallTimeout(err) {
  return err instanceof Error && err.message.startsWith(">> FAIL: chain-call");
}

/**
 * Create a client for `chainId` and bound the ready-check (first metadata
 * fetch) with CONNECT_TIMEOUT_MS. On timeout — or any setup failure — destroy
 * the client so a stalled/half-open socket never keeps the process alive.
 */
async function setupClient(chainId) {
  const wss = endpoints[chainId];
  const client = makeClient(wss);
  try {
    const api = client.getUnsafeApi();
    await chainCall(api.constants.System.Version(), {
      chain: chainId,
      endpoint: wss,
      step: "connect",
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    return { client, api };
  } catch (err) {
    try {
      client.destroy();
    } catch {
      // best-effort — the client may already be in a bad/half-open state
    }
    throw err;
  }
}

/** Shared per-chain (chain, endpoint) pair for chainCall()'s failure message, keyed off `endpoints` populated by the top-level before(). */
function chainCtx(chain) {
  return { chain, endpoint: endpoints[chain] };
}

/** Destroy a client best-effort — a stalled/half-open client's destroy() can itself throw, and teardown must never fail the suite over that. */
function destroyQuietly(client) {
  try {
    client?.destroy();
  } catch {
    // best-effort teardown — a stalled/half-open client may throw here
  }
}

async function tryEncode(api, pallet, call, args, { chain, endpoint, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  try {
    const tx = api.tx[pallet][call](args);
    await chainCall(tx.getEncodedData(), { chain, endpoint, step: `${pallet}.${call}`, timeoutMs });
  } catch (err) {
    if (isChainCallTimeout(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `>> FAIL: ${pallet}.${call}: arg-type mismatch — papi isCompat rejected the call args. Error: ${msg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main encode test suite (requires live chain)
// ---------------------------------------------------------------------------

describe("chain-call encoding — all 10 extrinsics + 1 runtime API", { skip: !ENABLED }, () => {
  before(async () => {
    const { doc } = await loadEnvironments();
    for (const chainId of ["asset-hub", "people", "bulletin"]) {
      endpoints[chainId] = wssFor(doc, chainId);
    }
  });

  // ------------------------------------------------------------------
  // Asset Hub calls
  // ------------------------------------------------------------------

  describe("Asset Hub", () => {
    let ahClient;
    let ahApi;

    // A before() hook, not a test(): when setupClient() throws (e.g. the
    // connect timeout above), node:test cancels every sibling test in this
    // describe with that same original error, cleanly — no undefined-api
    // TypeError, no misleading wrapper. Mirrors the after()-based teardown
    // below (#1595).
    before(async () => {
      ({ client: ahClient, api: ahApi } = await setupClient("asset-hub"));
    });

    // 1. AliasAccounts.reprove_alias_account
    // proof: BoundedVec<u8> → Binary
    // ring_index: u32 → number
    // ring_revision: u32 → number
    // proof_valid_at: u64 → bigint
    test("AliasAccounts.reprove_alias_account encodes with Binary proof", async () => {
      await tryEncode(
        ahApi,
        "AliasAccounts",
        "reprove_alias_account",
        {
          proof: DUMMY_PROOF_785,
          ring_index: 0,
          ring_revision: 1,
          proof_valid_at: 0n,
        },
        chainCtx("asset-hub"),
      );
    });

    // 2. AliasAccounts.set_alias_account
    // proof: BoundedVec<u8> → Binary
    // collection: [u8;32] → hex string (FixedSizeBinary)
    // ring_index: u32 → number
    // ring_revision: u32 → number
    // context: [u8;32] → hex string (FixedSizeBinary)
    // proof_valid_at: u64 → bigint
    test("AliasAccounts.set_alias_account encodes with Binary proof and hex collection/context", async () => {
      await tryEncode(
        ahApi,
        "AliasAccounts",
        "set_alias_account",
        {
          proof: DUMMY_PROOF_785,
          collection: DUMMY_HEX32,
          ring_index: 0,
          ring_revision: 1,
          context: DUMMY_HEX32,
          proof_valid_at: 0n,
        },
        chainCtx("asset-hub"),
      );
    });

    // 3a. Balances.transfer_allow_death (Asset Hub — dotns.ts submitTransfer)
    // dest: MultiAddress → Enum("Id", ss58)
    // value: u128 → bigint
    test("Balances.transfer_allow_death (asset-hub) encodes with Enum('Id', ss58)", async () => {
      await tryEncode(
        ahApi,
        "Balances",
        "transfer_allow_death",
        {
          dest: Enum("Id", DUMMY_SS58),
          value: 1_000_000_000_000n,
        },
        chainCtx("asset-hub"),
      );
    });

    // 5. Pgas.claim_pgas
    // slot_index: u32 → number
    // target: AccountId32 → bare SS58 string
    test("Pgas.claim_pgas encodes with bare SS58 target", async () => {
      await tryEncode(
        ahApi,
        "Pgas",
        "claim_pgas",
        {
          slot_index: 0,
          target: DUMMY_SS58,
        },
        chainCtx("asset-hub"),
      );
    });

    // 6. Revive.call
    // dest: H160 → hex string "0x" + 20 bytes
    // value: Compact<u128> → bigint
    // weight_limit: Weight → { ref_time: bigint, proof_size: bigint }
    // storage_deposit_limit: Compact<u128> → bigint
    // data: Vec<u8> → Binary (prod uses Binary.fromHex(encodedData))
    test("Revive.call encodes with Binary data and bigint weight fields", async () => {
      await tryEncode(
        ahApi,
        "Revive",
        "call",
        {
          dest: DUMMY_H160,
          value: 0n,
          weight_limit: { ref_time: 10_000_000_000n, proof_size: 131072n },
          storage_deposit_limit: 0n,
          data: Binary.fromHex("0xdeadbeef"),
        },
        chainCtx("asset-hub"),
      );
    });

    // 7. Revive.map_account
    // No args — prod calls api.tx.Revive.map_account() with no argument
    test("Revive.map_account encodes (no args)", async () => {
      await tryEncode(ahApi, "Revive", "map_account", undefined, chainCtx("asset-hub"));
    });

    // 10. Utility.batch_all
    // calls: Vec<RuntimeCall> → array of .decodedCall objects from inner Revive.call txs
    test("Utility.batch_all encodes with decodedCall inner array", async () => {
      const inner = ahApi.tx.Revive.call({
        dest: DUMMY_H160,
        value: 0n,
        weight_limit: { ref_time: 10_000_000_000n, proof_size: 131072n },
        storage_deposit_limit: 0n,
        data: Binary.fromHex("0xdeadbeef"),
      }).decodedCall;
      await tryEncode(ahApi, "Utility", "batch_all", { calls: [inner] }, chainCtx("asset-hub"));
    });

    after(() => destroyQuietly(ahClient));
  });

  // ------------------------------------------------------------------
  // People chain calls
  // ------------------------------------------------------------------

  describe("People", () => {
    let peopleClient;
    let peopleApi;

    before(async () => {
      ({ client: peopleClient, api: peopleApi } = await setupClient("people"));
    });

    // 4. People.set_personal_id_account
    // account: AccountId32 → bare SS58 string
    // call_valid_at: u32 → number
    test("People.set_personal_id_account encodes with bare SS58 account", async () => {
      await tryEncode(
        peopleApi,
        "People",
        "set_personal_id_account",
        {
          account: DUMMY_SS58,
          call_valid_at: 0,
        },
        chainCtx("people"),
      );
    });

    after(() => destroyQuietly(peopleClient));
  });

  // ------------------------------------------------------------------
  // Bulletin chain calls
  // ------------------------------------------------------------------

  describe("Bulletin", () => {
    let bulletinClient;
    let bulletinApi;

    before(async () => {
      ({ client: bulletinClient, api: bulletinApi } = await setupClient("bulletin"));
    });

    // 8. TransactionStorage.authorize_account
    // who: AccountId32 → bare SS58 string (prod passes account.address directly)
    // transactions: u32 → number (prod uses clampU32 → JS number)
    // bytes: u64 → bigint (prod passes TOPUP_BYTES = 100_000_000n)
    test("TransactionStorage.authorize_account encodes with bare SS58, number transactions, bigint bytes", async () => {
      await tryEncode(
        bulletinApi,
        "TransactionStorage",
        "authorize_account",
        {
          who: DUMMY_SS58,
          transactions: 1000,
          bytes: 100_000_000n,
        },
        chainCtx("bulletin"),
      );
    });

    // 9. TransactionStorage.store_with_cid_config
    // cid.codec: u64 → bigint (prod: BigInt(CID_CONFIG.codec))
    // cid.hashing: Enum variant → { type: "Sha2_256", value: undefined } from toHashingEnum(0x12)
    // data: Vec<u8> → Uint8Array (prod passes raw chunk bytes / contentBytes)
    test("TransactionStorage.store_with_cid_config encodes with bigint codec, Uint8Array data", async () => {
      await tryEncode(
        bulletinApi,
        "TransactionStorage",
        "store_with_cid_config",
        {
          cid: {
            codec: BigInt(0x55), // raw-codec (CID_CONFIG.codec from deploy.ts)
            hashing: { type: "Sha2_256", value: undefined }, // toHashingEnum(0x12) in prod
          },
          data: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
        },
        chainCtx("bulletin"),
      );
    });

    // A runtime API, not an extrinsic — but the same class of assumption this file
    // guards: it is the only way the client reads storage authorization. An env whose
    // runtime lacks it fails every deploy at the authorization preflight.
    test("BulletinTransactionStorageApi.account_authorization resolves against live metadata", async () => {
      let auth;
      try {
        auth = await chainCall(bulletinApi.apis.BulletinTransactionStorageApi.account_authorization(DUMMY_SS58), {
          ...chainCtx("bulletin"),
          step: "BulletinTransactionStorageApi.account_authorization",
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch (e) {
        if (isChainCallTimeout(e)) throw e;
        assert.fail(
          `>> FAIL: chain-call-encoding: BulletinTransactionStorageApi::account_authorization did not resolve on ${ENV_ID}'s Bulletin runtime — polkadot-app-deploy reads every account's storage quota through it, so no deploy can pass its authorization preflight here. Cause: ${e?.message ?? e}`,
        );
      }
      // Option::None → undefined: Alice may hold no authorization here, itself a
      // valid decode. Only a Some must be shaped — and it is checked against the
      // client's own field list, so this can never guard fields it no longer reads.
      if (auth === undefined) return;
      const missing = ACCOUNT_AUTHORIZATION_FIELDS.filter((f) => !(f in auth));
      assert.equal(
        missing.length,
        0,
        `>> FAIL: chain-call-encoding: account_authorization returned an AccountAuthorization missing ${missing.join(", ")} — readAccountAuthorization in src/pool.ts maps exactly these fields and throws when one is absent, so a rename on-chain breaks every deploy.`,
      );
    });

    after(() => destroyQuietly(bulletinClient));
  });
});

// ---------------------------------------------------------------------------
// Timeout-path unit test (#1595) — runs WITHOUT chain access.
// Proves chainCall() fails fast with the named message when the underlying
// RPC call never resolves, instead of hanging — the exact failure mode that
// held the CI job open until its 10-minute timeout.
// ---------------------------------------------------------------------------

describe("chain-call timeout guard — unit (no chain)", () => {
  test("chainCall rejects with the named failure message within the bound when the RPC never resolves", async () => {
    const timeoutMs = 200;
    const start = Date.now();
    await assert.rejects(
      () =>
        chainCall(new Promise(() => {}), {
          chain: "stub-chain",
          endpoint: "wss://stub.example",
          step: "state_getMetadata",
          timeoutMs,
        }),
      (err) => {
        assert.equal(
          err.message,
          `>> FAIL: chain-call stub-chain: RPC stalled after ${timeoutMs / 1000}s connecting to wss://stub.example (step: state_getMetadata)`,
        );
        assert.ok(isChainCallTimeout(err), ">> FAIL: chain-call-timeout-unit: isChainCallTimeout must recognize its own message");
        return true;
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 2000,
      `>> FAIL: chain-call-timeout-unit: took ${elapsed}ms to reject a ${timeoutMs}ms-bound timeout — the bound is not being enforced`,
    );
  });

  test("tryEncode surfaces the named RPC-stalled message (not the arg-type-mismatch wrapper) when getEncodedData never resolves", async () => {
    const stubApi = {
      tx: {
        Stub: {
          neverResolves: () => ({ getEncodedData: () => new Promise(() => {}) }),
        },
      },
    };
    await assert.rejects(
      () =>
        tryEncode(stubApi, "Stub", "neverResolves", undefined, {
          chain: "stub-chain",
          endpoint: "wss://stub.example",
          timeoutMs: 200,
        }),
      (err) => {
        assert.match(err.message, /^>> FAIL: chain-call stub-chain: RPC stalled after 0\.2s/);
        return true;
      },
    );
  });

  // Reproduces, without any live chain, exactly what a real CI run showed
  // (#1595): when one chain's setup fails/times out mid-suite, every later
  // test in that describe block would see an undefined api. The fix is
  // structural, not a per-call guard: per-chain setup runs in a before()
  // hook (mirroring the after()-based teardown), so node:test itself cancels
  // every sibling test in that describe with the ORIGINAL "RPC stalled"
  // error — cleanly, with no undefined-api TypeError and no misleading
  // "arg-type mismatch" wrapper sending whoever reads CI hunting a
  // nonexistent encoding regression. This guard asserts that structure holds:
  // scan this file's own source and fail if a per-chain setup is ever
  // rewritten back as a test() (built via concatenation so this assertion
  // can never match its own source line).
  test("chain setup runs in before(), not test() — a stalled connect must cancel sibling tests, not leave them an undefined api", () => {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const suspectPattern = ["test", '("setup '].join("");
    assert.ok(
      !src.includes(suspectPattern),
      ">> FAIL: chain-call-encoding: a per-chain client setup was written as a test() again instead of a before() hook — a stalled connect would then leave every later test in that describe block seeing an undefined api instead of being cleanly cancelled by node:test (#1595).",
    );
  });
});

// ---------------------------------------------------------------------------
// Completeness guard — runs WITHOUT chain access
// Asserts that the set of (Pallet.call) covered above is a superset of
// every tx call found by scanning src/**/*.ts.
// ---------------------------------------------------------------------------

describe("chain-call coverage — completeness guard", () => {
  test("every tx call in src/ is covered by this test file", () => {
    const srcRoot = path.resolve(__dirname, "../src");

    // Synchronous recursive .ts file walk
    function walkTs(dir) {
      const files = [];
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          files.push(...walkTs(full));
        } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
          files.push(full);
        }
      }
      return files;
    }

    const tsFiles = walkTs(srcRoot);

    // Extract all .tx.<Pallet>.<call> patterns.
    // Pallet name must start with an uppercase letter to exclude false positives
    // like "chain.tx.submit" where "submit" is not a Pallet name.
    const TX_PATTERN = /\.tx\.([A-Z][A-Za-z]*)\.([a-z][a-z_A-Z0-9]*)/g;
    const found = new Set();
    for (const file of tsFiles) {
      const content = readFileSync(file, "utf8");
      let m;
      TX_PATTERN.lastIndex = 0;
      while ((m = TX_PATTERN.exec(content)) !== null) {
        found.add(`${m[1]}.${m[2]}`);
      }
    }

    // The set of (Pallet.call) pairs covered by this test file
    const covered = new Set([
      "AliasAccounts.reprove_alias_account",
      "AliasAccounts.set_alias_account",
      "Balances.transfer_allow_death",
      "People.set_personal_id_account",
      "Pgas.claim_pgas",
      "Revive.call",
      "Revive.map_account",
      "TransactionStorage.authorize_account",
      "TransactionStorage.store_with_cid_config",
      "Utility.batch_all",
    ]);

    const uncovered = [...found].filter((c) => !covered.has(c));
    assert.equal(
      uncovered.length,
      0,
      `>> FAIL: chain-call-coverage: uncovered tx calls in src/: ${uncovered.join(", ")}. Add them to test/e2e-chain-calls.test.js.`,
    );
  });
});
