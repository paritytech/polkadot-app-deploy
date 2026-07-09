import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fromHex, toHex } from "@polkadot-api/utils";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { sr25519, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { createClient as createPolkadotClient, Enum } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { getWsProvider } from "polkadot-api/ws";
import type { PolkadotSigner } from "polkadot-api";
import { BULLETIN_ENDPOINTS, WS_HEARTBEAT_TIMEOUT_MS, makeBulletinStatusHandler } from "./deploy.js";
import { setDeployAttribute, truncateAddress } from "./telemetry.js";

// Mirrors product-sdk-terminal's sanitizeAppId in host-cache.ts.
function sanitize(appId: string): string {
  return appId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function cacheFilePath(appId: string, storageDir?: string): string {
  return join(storageDir ?? homedir(), ".polkadot-apps", `${sanitize(appId)}_AllowanceKeys.json`);
}

// Mobile wallets return schnorrkel SecretKey::to_bytes() material for 64-byte keys.
// @scure/sr25519 expects the to_ed25519_bytes() scalar (×8 cofactor), so normalize
// the scalar half (bytes 0–31) before use. Mirrors playground-cli's
// normalizeAllocatedSlotAccountKey / encodeSchnorrkelScalarForScure.
function normalizeSchnorrkelKey(key: Uint8Array): Uint8Array {
  if (key.length !== 64) return key;
  const out = new Uint8Array(key);
  let carry = 0;
  for (let i = 0; i < 32; i++) {
    const v = key[i] * 8 + carry;
    out[i] = v & 0xff;
    carry = v >> 8;
  }
  return out;
}

function signerFromSecret(secret: Uint8Array): PolkadotSigner {
  if (secret.length === 32) {
    const kp = sr25519CreateDerive(secret)("");
    return getPolkadotSigner(kp.publicKey, "Sr25519", async (d) => kp.sign(d));
  }
  if (secret.length === 64) {
    const normalized = normalizeSchnorrkelKey(secret);
    const pub = sr25519.getPublicKey(normalized);
    return getPolkadotSigner(pub, "Sr25519", async (d) => sr25519.sign(d, normalized));
  }
  throw new Error(
    `BulletInAllowance slot key: unexpected length ${secret.length} (expected 32 or 64)`,
  );
}

// Cache format + tag spelling are owned by product-sdk-terminal (dist/host.js
// mergeOutcomes/saveCache) — we are a compatible second writer. Verified
// unchanged for terminal 0.3.1 / host-papp 0.8.5; full evidence in PR for the
// v0.8 migration (spec: docs-internal/superpowers/specs/2026-06-04-v08-signin-migration-design.md).

/**
 * Read the BulletInAllowance slot account from the product-sdk-terminal allowance cache.
 * Returns null when not cached. storageDir defaults to os.homedir().
 *
 * Cache format: @parity/product-sdk-terminal host-cache.ts v1.
 *
 * NOTE: reads the pre-0.8.6 plaintext cache format (_AllowanceKeys.json). On host-papp 0.8.6+
 * the cache is AES-encrypted and keyed by sessionId (_AllowanceKeys_<sessionId>.json), so
 * this function returns null on 0.8.6+ installations. Use adapter.allowance.getBulletinSigner()
 * for runtime checks instead.
 */
export async function readBulletinSlotSigner(
  appId: string,
  storageDir?: string,
): Promise<{ signer: PolkadotSigner; ss58: string } | null> {
  let raw: string;
  try {
    raw = await readFile(cacheFilePath(appId, storageDir), "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  let cache: any;
  try {
    cache = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = cache?.entries?.BulletInAllowance;
  if (!entry?.slotAccountKey) return null;
  let secret: Uint8Array;
  try {
    secret = fromHex(entry.slotAccountKey);
  } catch {
    return null;
  }
  const signer = signerFromSecret(secret);
  return { signer, ss58: ss58Address(signer.publicKey) };
}

/**
 * Write a BulletInAllowance slot key to the product-sdk-terminal cache (v1 format).
 * Read-modify-write so other entries are preserved.
 */
export async function writeBulletinSlotKey(
  appId: string,
  hexKey: `0x${string}`,
  storageDir?: string,
): Promise<void> {
  const path = cacheFilePath(appId, storageDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing: any = { version: 1, entries: {} };
  try {
    existing = JSON.parse(await readFile(path, "utf-8"));
  } catch {
    /* start fresh */
  }
  existing.entries ??= {};
  existing.entries.BulletInAllowance = { tag: "BulletInAllowance", slotAccountKey: hexKey };
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Extract the BulletInAllowance slot key hex from a requestResourceAllocation outcome array.
 * The vendored allocations.ts does not parse or persist the key material — callers must
 * call this and then writeBulletinSlotKey.
 */
export function extractBulletinSlotKey(
  outcomes: { tag: string; value: unknown }[],
): `0x${string}` | null {
  for (const outcome of outcomes) {
    if (outcome.tag !== "Allocated") continue;
    const allocated = outcome.value as
      | { tag?: string; value?: { slotAccountKey?: Uint8Array } }
      | undefined;
    if (allocated?.tag !== "BulletInAllowance") continue;
    const key = allocated.value?.slotAccountKey;
    if (!(key instanceof Uint8Array)) continue;
    // Store as-is; normalization (schnorrkel SecretKey::to_bytes() → to_ed25519_bytes())
    // is applied in signerFromSecret at use time to avoid double-normalizing on read.
    return toHex(key) as `0x${string}`;
  }
  return null;
}

/**
 * Typed error thrown by getSlotSignerProvider when the slot account is not
 * usably authorized on-chain.  The `reason` field lets callers produce
 * targeted messages without string-matching.
 *
 *  "missing"  — no Authorizations entry found for the slot account.
 *  "expired"  — entry exists but expiration ≤ current finalized block.
 */
export class BulletinSlotAuthError extends Error {
  readonly reason: "missing" | "expired";
  /** The on-chain expiration block (only set when reason === "expired"). */
  readonly expiration?: number;

  constructor(reason: "missing" | "expired", ss58: string, expiration?: number) {
    const detail =
      reason === "expired" && expiration != null
        ? `expired at block ${expiration}`
        : "no on-chain authorization found";
    super(`Slot account ${ss58} not authorized on Bulletin (${detail})`);
    this.reason = reason;
    this.expiration = expiration;
    this.name = "BulletinSlotAuthError";
  }
}

/**
 * Pure active-test for a Bulletin Authorizations entry.
 * Shared by getSlotSignerProvider (single probe) and the poll loop in
 * waitForBulletinAuthorization (repeated probes).
 *
 * @param auth  Raw value from TransactionStorage.Authorizations.getValue — null when absent.
 * @param blockNumber  Current finalized block number.
 */
export function isBulletinAuthActive(
  auth: { expiration?: bigint | number } | null | undefined,
  blockNumber: number,
): { active: true; expiration: number } | { active: false; reason: "missing" | "expired"; expiration?: number } {
  if (auth == null) return { active: false, reason: "missing" };
  const exp = Number(auth.expiration ?? 0);
  if (exp <= blockNumber) return { active: false, reason: "expired", expiration: exp };
  return { active: true, expiration: exp };
}

/**
 * Internal poll loop for waitForBulletinAuthorization.
 * Injecting the query function keeps the loop unit-testable without a real WS connection.
 *
 * @param queryFn  Async function that returns {auth, blockNumber} — mock in tests.
 * @param opts     pollMs (default 2000), timeoutMs (default 90000).
 *
 * Transient query errors (thrown by queryFn) are retried until the deadline — a
 * flaky WS read is NOT treated as "unauthorized". Only a clean active-check
 * returning false advances toward timeout.
 */
export async function pollUntilBulletinAuthorized(
  queryFn: () => Promise<{ auth: { expiration?: bigint | number } | null | undefined; blockNumber: number }>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ authorized: true; expiration: number } | { authorized: false; reason: "timeout" }> {
  const { pollMs = 2000, timeoutMs = 90_000 } = opts;
  const debug = Boolean(process.env.DOT_DEBUG);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { auth, blockNumber } = await queryFn();
      const result = isBulletinAuthActive(auth, blockNumber);
      if (result.active) {
        if (debug) console.error(`[auth-poll] active expiration=${result.expiration}`);
        return { authorized: true, expiration: result.expiration };
      }
      if (debug) {
        console.error(
          `[auth-poll] not-active reason=${result.reason}` +
          (result.expiration != null ? ` expiration=${result.expiration}` : ""),
        );
      }
    } catch (e) {
      // A transient chain/WS read error is NOT "unauthorized" — retry until the
      // deadline. Counting a flaky read as a miss is what made login time out
      // while the slot was already authorized on-chain.
      if (debug) console.error(`[auth-poll] query-errored: ${e instanceof Error ? e.message : String(e)}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(pollMs, remaining)));
  }
  return { authorized: false, reason: "timeout" };
}

/**
 * Open a Bulletin WS connection, poll Authorizations until the slot account's
 * authorization lands on-chain, then destroy the connection and return.
 *
 * Intended for the fresh-login path in src/commands/login.ts to gate the
 * success summary until the authorization is finalized (avoids the first-run
 * race where deploy checks immediately after phone approval but before the
 * on-chain tx is included).
 *
 * Does NOT print any progress — the caller (login.ts) owns the output via a
 * spinner. Pass `quiet: true` to suppress connection status chatter so the
 * caller's spinner owns the line.
 *
 * @returns `{ authorized: true, expiration }` on success;
 *          `{ authorized: false, reason: "timeout" }` after the configured timeout.
 */
export async function waitForBulletinAuthorization(
  ss58: string,
  opts: { timeoutMs?: number; pollMs?: number; quiet?: boolean; endpoints?: string[] } = {},
): Promise<{ authorized: true; expiration: number } | { authorized: false; reason: "timeout" }> {
  const { quiet, endpoints, ...pollOpts } = opts;
  // Callers in the login path MUST pass the selected env's bulletin endpoint(s).
  // BULLETIN_ENDPOINTS defaults to the deploy-only DEFAULT_BULLETIN_RPC (the
  // paseo-next chain) and is the wrong chain for any other env — we only fall
  // back to it when no endpoints are supplied (preserves the deploy-path default).
  const eps = endpoints && endpoints.length > 0 ? endpoints : BULLETIN_ENDPOINTS;
  const primary = eps[0];
  const onStatusChanged = quiet ? () => {} : makeBulletinStatusHandler(primary);
  const client = createPolkadotClient(getWsProvider(
    eps,
    { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS, onStatusChanged },
  ));
  const unsafeApi: any = client.getUnsafeApi();
  try {
    return await pollUntilBulletinAuthorized(
      async () => {
        const [auth, block] = await Promise.all([
          unsafeApi.query.TransactionStorage.Authorizations.getValue(Enum("Account", ss58)),
          client.getFinalizedBlock(),
        ]);
        return { auth, blockNumber: block.number };
      },
      pollOpts,
    );
  } finally {
    client.destroy();
  }
}

/**
 * Generic retry wrapper for a single flaky step. Retries any thrown error
 * EXCEPT `BulletinSlotAuthError` up to `retries` times (default 2, i.e. 3
 * total attempts) with `delayMs` between attempts (default 1000ms).
 *
 * `BulletinSlotAuthError` ("missing" | "expired") is a definitive on-chain
 * fact, not a network blip — retrying it would just re-read the same state
 * and waste time, so it always propagates on the first attempt.
 *
 * Extracted for #1058: getSlotSignerProvider's connect + Authorizations
 * probe is a single WS round-trip performed once per deploy; a transient
 * WS/RPC hiccup on that one attempt used to permanently commit the whole
 * upload to the pool-account fallback (selectStorageReconnect in
 * src/deploy.ts never retries the slot path once it has failed once).
 * Mirrors the existing "a flaky read is NOT unauthorized" tolerance already
 * used by pollUntilBulletinAuthorized (login path), bounded to a much
 * shorter budget appropriate for a synchronous deploy-time connect.
 */
export async function withTransientRetry<T>(
  attempt: () => Promise<T>,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  const { retries = 2, delayMs = 1000 } = opts;
  const debug = Boolean(process.env.DOT_DEBUG);
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof BulletinSlotAuthError) throw e;
      lastErr = e;
      if (i < retries) {
        if (debug) {
          console.error(
            `[slot-signer] transient error (attempt ${i + 1}/${retries + 1}): ` +
            `${e instanceof Error ? e.message : String(e)}`,
          );
        }
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Create a Bulletin WS connection for the slot-account signer.
 * Checks on-chain authorization. A transient connect/query error (WS blip,
 * RPC timeout) is retried up to twice via withTransientRetry before giving
 * up; a clean read that is definitively missing/expired throws
 * BulletinSlotAuthError immediately (no retry — see withTransientRetry) so
 * callers can distinguish and produce targeted messages.
 */
export async function getSlotSignerProvider(
  signer: PolkadotSigner,
  ss58: string,
): Promise<{ client: any; unsafeApi: any; signer: PolkadotSigner; ss58: string }> {
  return withTransientRetry(async () => {
    const primary = BULLETIN_ENDPOINTS[0];
    console.log(`   Connecting to Bulletin (slot signer): ${primary}`);
    const client = createPolkadotClient(getWsProvider(
      BULLETIN_ENDPOINTS,
      { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS, onStatusChanged: makeBulletinStatusHandler(primary) },
    ));
    const unsafeApi: any = client.getUnsafeApi();

    let auth: any;
    let currentBlock: any;
    try {
      [auth, currentBlock] = await Promise.all([
        unsafeApi.query.TransactionStorage.Authorizations.getValue(Enum("Account", ss58)),
        client.getFinalizedBlock(),
      ]);
    } catch (e) {
      client.destroy();
      throw e; // transient connect/query failure — retried by withTransientRetry
    }
    const result = isBulletinAuthActive(auth, currentBlock.number);
    if (!result.active) {
      client.destroy();
      throw new BulletinSlotAuthError(result.reason, ss58, result.expiration);
    }
    console.log(`   Using slot signer: ${ss58} (authorized until block ${result.expiration})`);
    setDeployAttribute("deploy.signer.mode", "slot");
    setDeployAttribute("deploy.signer.address", truncateAddress(ss58) as string);
    return { client, unsafeApi, signer, ss58 };
  });
}
