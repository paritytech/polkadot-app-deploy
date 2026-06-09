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
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import * as path from "path";
import { createClient, Binary, Enum } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { loadEnvironments } from "../dist/environments.js";

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

async function tryEncode(api, pallet, call, args) {
  try {
    const tx = api.tx[pallet][call](args);
    await tx.getEncodedData();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `>> FAIL: ${pallet}.${call}: arg-type mismatch — papi isCompat rejected the call args. Error: ${msg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main encode test suite (requires live chain)
// ---------------------------------------------------------------------------

describe("chain-call encoding — all 10 extrinsics", { skip: !ENABLED }, () => {
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

    test("setup asset-hub client", async () => {
      ahClient = makeClient(endpoints["asset-hub"]);
      ahApi = ahClient.getUnsafeApi();
      // Warm up: wait for the client to be ready by fetching a small bit of metadata
      await ahApi.constants.System.Version();
    });

    // 1. AliasAccounts.reprove_alias_account
    // proof: BoundedVec<u8> → Binary
    // ring_index: u32 → number
    // ring_revision: u32 → number
    // proof_valid_at: u64 → bigint
    test("AliasAccounts.reprove_alias_account encodes with Binary proof", async () => {
      await tryEncode(ahApi, "AliasAccounts", "reprove_alias_account", {
        proof: DUMMY_PROOF_785,
        ring_index: 0,
        ring_revision: 1,
        proof_valid_at: 0n,
      });
    });

    // 2. AliasAccounts.set_alias_account
    // proof: BoundedVec<u8> → Binary
    // collection: [u8;32] → hex string (FixedSizeBinary)
    // ring_index: u32 → number
    // ring_revision: u32 → number
    // context: [u8;32] → hex string (FixedSizeBinary)
    // proof_valid_at: u64 → bigint
    test("AliasAccounts.set_alias_account encodes with Binary proof and hex collection/context", async () => {
      await tryEncode(ahApi, "AliasAccounts", "set_alias_account", {
        proof: DUMMY_PROOF_785,
        collection: DUMMY_HEX32,
        ring_index: 0,
        ring_revision: 1,
        context: DUMMY_HEX32,
        proof_valid_at: 0n,
      });
    });

    // 3a. Balances.transfer_allow_death (Asset Hub — dotns.ts submitTransfer)
    // dest: MultiAddress → Enum("Id", ss58)
    // value: u128 → bigint
    test("Balances.transfer_allow_death (asset-hub) encodes with Enum('Id', ss58)", async () => {
      await tryEncode(ahApi, "Balances", "transfer_allow_death", {
        dest: Enum("Id", DUMMY_SS58),
        value: 1_000_000_000_000n,
      });
    });

    // 5. Pgas.claim_pgas
    // slot_index: u32 → number
    // target: AccountId32 → bare SS58 string
    test("Pgas.claim_pgas encodes with bare SS58 target", async () => {
      await tryEncode(ahApi, "Pgas", "claim_pgas", {
        slot_index: 0,
        target: DUMMY_SS58,
      });
    });

    // 6. Revive.call
    // dest: H160 → hex string "0x" + 20 bytes
    // value: Compact<u128> → bigint
    // weight_limit: Weight → { ref_time: bigint, proof_size: bigint }
    // storage_deposit_limit: Compact<u128> → bigint
    // data: Vec<u8> → Binary (prod uses Binary.fromHex(encodedData))
    test("Revive.call encodes with Binary data and bigint weight fields", async () => {
      await tryEncode(ahApi, "Revive", "call", {
        dest: DUMMY_H160,
        value: 0n,
        weight_limit: { ref_time: 10_000_000_000n, proof_size: 131072n },
        storage_deposit_limit: 0n,
        data: Binary.fromHex("0xdeadbeef"),
      });
    });

    // 7. Revive.map_account
    // No args — prod calls api.tx.Revive.map_account() with no argument
    test("Revive.map_account encodes (no args)", async () => {
      await tryEncode(ahApi, "Revive", "map_account", undefined);
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
      await tryEncode(ahApi, "Utility", "batch_all", { calls: [inner] });
    });

    test("teardown asset-hub client", async () => {
      ahClient?.destroy();
    });
  });

  // ------------------------------------------------------------------
  // People chain calls
  // ------------------------------------------------------------------

  describe("People", () => {
    let peopleClient;
    let peopleApi;

    test("setup people client", async () => {
      peopleClient = makeClient(endpoints["people"]);
      peopleApi = peopleClient.getUnsafeApi();
      await peopleApi.constants.System.Version();
    });

    // 4. People.set_personal_id_account
    // account: AccountId32 → bare SS58 string
    // call_valid_at: u32 → number
    test("People.set_personal_id_account encodes with bare SS58 account", async () => {
      await tryEncode(peopleApi, "People", "set_personal_id_account", {
        account: DUMMY_SS58,
        call_valid_at: 0,
      });
    });

    test("teardown people client", async () => {
      peopleClient?.destroy();
    });
  });

  // ------------------------------------------------------------------
  // Bulletin chain calls
  // ------------------------------------------------------------------

  describe("Bulletin", () => {
    let bulletinClient;
    let bulletinApi;

    test("setup bulletin client", async () => {
      bulletinClient = makeClient(endpoints["bulletin"]);
      bulletinApi = bulletinClient.getUnsafeApi();
      await bulletinApi.constants.System.Version();
    });

    // 8. TransactionStorage.authorize_account
    // who: AccountId32 → bare SS58 string (prod passes account.address directly)
    // transactions: u32 → number (prod uses clampU32 → JS number)
    // bytes: u64 → bigint (prod passes TOPUP_BYTES = 100_000_000n)
    test("TransactionStorage.authorize_account encodes with bare SS58, number transactions, bigint bytes", async () => {
      await tryEncode(bulletinApi, "TransactionStorage", "authorize_account", {
        who: DUMMY_SS58,
        transactions: 1000,
        bytes: 100_000_000n,
      });
    });

    // 9. TransactionStorage.store_with_cid_config
    // cid.codec: u64 → bigint (prod: BigInt(CID_CONFIG.codec))
    // cid.hashing: Enum variant → { type: "Sha2_256", value: undefined } from toHashingEnum(0x12)
    // data: Vec<u8> → Uint8Array (prod passes raw chunk bytes / contentBytes)
    test("TransactionStorage.store_with_cid_config encodes with bigint codec, Uint8Array data", async () => {
      await tryEncode(bulletinApi, "TransactionStorage", "store_with_cid_config", {
        cid: {
          codec: BigInt(0x55), // raw-codec (CID_CONFIG.codec from deploy.ts)
          hashing: { type: "Sha2_256", value: undefined }, // toHashingEnum(0x12) in prod
        },
        data: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      });
    });

    test("teardown bulletin client", async () => {
      bulletinClient?.destroy();
    });
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
