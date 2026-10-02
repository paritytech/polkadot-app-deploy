import { Buffer } from "buffer";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { CLI_NAME } from "./cli-name.js";
import { resolveEffectiveMnemonic } from "./mnemonic.js";
import { hasPersistedSession, STALE_SESSION_DEPLOY_MESSAGE, getPeopleChainEndpoints } from "./auth-config.js";
import { statementSigningAccount } from "./sss-allowance.js";
import { preflightSssAllowance } from "./sss-allowance-cache.js";
import { sha256 } from "@noble/hashes/sha256";
import { blake2b } from "@noble/hashes/blake2b";
import { createClient as createPolkadotClient } from "polkadot-api";
import { getWsProvider, WsEvent } from "polkadot-api/ws";
import { CID } from "multiformats/cid";
import { create as createMultihash } from "multiformats/hashes/digest";
import { base32 } from "multiformats/bases/base32";
import { base58btc } from "multiformats/bases/base58";
import * as dagPB from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { merkleizeJS, merkleizeWithStableOrder, rebuildOrderedCarFromBytes } from "./merkle.js";
import { extractManifestFromCar, fetchPreviousManifest, writePersistentLocalManifest } from "./manifest-fetch.js";
import { writeEmbeddedManifestPlaceholder, finaliseEmbeddedManifest } from "./manifest-embed.js";
import { MANIFEST_VERSION, MANIFEST_DIR, MANIFEST_PATH, classifyFile, parseManifest, CONTENT_HASH_RE, type ManifestFileEntry, type ManifestChunkEntry } from "./manifest.js";
import { probeChunks, probeFinalityGap, getBestBlockNumber, type ChunkProbeResult } from "./chunk-probe.js";
import { computeStats, telemetryAttributes, renderSummary } from "./incremental-stats.js";
import { DotNS, fetchNonce, TX_TIMEOUT_MS, validateDomainLabel, popStatusName, parseDomainName, classifyRegistrability, formatUnregistrableReason, DEFAULT_TLD, computeDomainNode, topUpTargetFor, AUTO_MAP_RENT_HEADROOM } from "./dotns.js";
import type { ParsedDomainName, DotnsPreflightResult, PhoneSignatureStep, DotNSConnectOptions, DotnsSuccessAction } from "./dotns.js";
import type { DotnsAbiProfile } from "./dotns-protocol.js";
import { subnameNestingLevels } from "./subname-depth.js";
export type { PhoneSignatureStep };
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { derivePoolAccounts, fetchPoolAuthorizations, selectHealthyPoolAccount, checkPoolAccountNonceHealth, StuckPoolAccountError, STUCK_NONCE_GAP_THRESHOLD, withTimeout, stuckQueueMessage, parsePoolDerivationIndex, NONCE_HEALTH_SAMPLES, type NonceHealth, ensureAuthorized, isAuthorizationSufficient, readAccountAuthorization, detectTestnet, resolvePoolMnemonic } from "./pool.js";
import type { BulletinAuthorization, PoolAuthorization } from "./pool.js";
import { initTelemetry, withSpan, withDeploySpan, setDeployAttribute, setDeploySentryTag, sampleMemory, setDeployReportContext, captureWarning, flush, VERSION, resolveRunner, resolveRunnerType, truncateAddress } from "./telemetry.js";
import { loadEnvironments, describeContractSources, resolveEndpoints, getPopSelfServeConfig, DEFAULT_ENV_ID } from "./environments.js";
import type { PopSelfServeConfig } from "./environments.js";
import { setDeployContext as setBugReportContext } from "./bug-report.js";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { mnemonicToEntropy, entropyToMiniSecret, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { deriveProductSigner } from "./product-account.js";
import type { PolkadotSigner } from "polkadot-api";
import { CarReader } from "@ipld/car/reader";
import {
  getSlotSignerProvider,
  BulletinSlotAuthError,
} from "./storage-signer.js";
import { resolveStorageSigner } from "./deploy-actors.js";
import { requestResourceAllocation, createSlotAccountSigner, BULLETIN_RESOURCE, SESSION_EXPIRED_MESSAGE } from "./auth/index.js";

export interface DeployResult {
  domainName: string;
  fullDomain: string;
  cid: string;
  ipfsCid?: string;
  /**
   * The env-aware browser URL for the deployed site — same value browserUrlFor()
   * produces for the "Check it out here" console line (issue #1157). Exposed here
   * so callers embedding deploy() as a library (and the CLI's GITHUB_OUTPUT write,
   * and the reusable workflow's PR-comment step) can reuse the ONE resolution
   * instead of recomputing a gateway URL from a hardcoded default.
   */
  browserUrl: string;
  /**
   * The Bulletin allowance-slot signer this deploy stored its content with, when it resolved
   * one from a login session (`resolveStorageSigner`). Exposed so the CLI can hand the SAME
   * identity to `publishManifest` immediately afterwards: the manifest's icon and executables
   * are billed to the storage account's quota, and a session deploy whose manifest fell back
   * to the shared pool would fail on any chain whose pool holds no quota. Undefined when
   * storage ran on a mnemonic, an external signer, or the pool — those the manifest step
   * resolves for itself from the options it is already given.
   */
  storageSigner?: PolkadotSigner;
  /** SS58 address of that slot account. Set whenever `storageSigner` is. */
  storageSignerAddress?: string;
}

export type DeployContent = string | Uint8Array | Uint8Array[];

export { NonRetryableError, EXIT_CODE_NO_RETRY } from "./errors.js";
import { NonRetryableError } from "./errors.js";
import { e2eNonceSeedBarrier } from "./e2e-nonce-barrier.js";

// Bulletin's signed extension returns InvalidTransaction::Payment when a storage tx
// exceeds the signer's quota — Bulletin has no fees, so "Payment" means quota.
// NOTE: the rewritten string intentionally avoids the word "authorization"
// because Sentry's default PII scrubber has an Authorization-header rule that
// length-masked the full error to asterisks in live events, making the
// dashboard unreadable.
export function friendlyChainError(msg: string): string {
  if (/"type":\s*"Invalid"[\s\S]*?"type":\s*"Payment"/i.test(msg)) {
    return "Bulletin quota exhausted (signed extension rejected the tx — signer is out of allowed txs or bytes; grant quota on-chain)";
  }
  return msg;
}

interface ProviderResult { client: any; unsafeApi: any; signer: PolkadotSigner; ss58: string; }
interface ExistingProvider { client?: any; unsafeApi?: any; signer?: PolkadotSigner; ss58?: string; reconnect?: () => Promise<ProviderResult>; fetchNonce?: (rpc: string | string[], ss58: string) => Promise<number>; skipCids?: Set<string>; probeFailedCids?: Set<string>; gateway?: string;
  /**
   * CIDs the caller vouches are already on-chain. Chunks matching these CIDs
   * are skipped without any re-probe (unlike `skipCids` which re-probes before
   * skipping). Invariant: only pass CIDs verified or uploaded within the same
   * chain connection during the current deploy — they are trusted to still be
   * present (eviction within a single deploy session is negligible).
   */
  trustedCids?: Set<string>;
  /**
   * When true, skip the DAG-PB root build + setRoot tx at the end of
   * storeChunkedContent. Phase A in the V2 path passes this because the
   * caller (storeDirectoryV2) never uses the Phase A root CID — Phase B
   * computes and stores the real root, which becomes the contenthash.
   */
  skipRootStore?: boolean;
  /**
   * When true, a client storeChunkedContent created by reconnecting is handed back
   * via `liveProvider` alive, and closing it becomes the caller's job (#1672).
   * storeDirectoryV2 sets it: it probes finality with that client afterwards.
   * Callers that drop liveProvider leave it unset, and the client is closed here.
   */
  handOffLiveClient?: boolean;
}
interface ChainReceipt { txHash: string; blockHash: string; blockNumber: number; }
// viaFallback: not confirmed by a watch event (a best-block CID probe, or provisional pending the
// post-batch verify loop, which every such chunk must pass before storeChunkedContent returns).
interface StoredChunk { cid: CID; len: number; viaFallback?: boolean; receipt?: ChainReceipt; }
// confirmIncluded: positive on-chain evidence for the tx's effect at the BEST block (a CID probe),
// asked when the watch gives up. Only `true` resolves the watch; anything else is a rejection.
interface WatchTransactionOptions { label?: string; timeoutMs?: number; confirmIncluded?: () => Promise<boolean>; }
interface WatchResult<T> { value: T; viaFallback: boolean; receipt?: ChainReceipt; }

export const DEFAULT_BULLETIN_RPC = "wss://paseo-bulletin-rpc.polkadot.io";
export const DEFAULT_POOL_SIZE = 10;
// Full endpoint list for multi-endpoint transport. Index 0 is always the
// effective primary. Only one public Bulletin endpoint is known today — add
// backups here once the Bulletin team publishes them (no code change needed).
export let BULLETIN_ENDPOINTS: string[] = [DEFAULT_BULLETIN_RPC];
let POOL_SIZE = DEFAULT_POOL_SIZE;
// bulletin #1362/#1095: the resolved env's environments.json `network` field.
// Threaded into ensureAuthorized by the provider helpers below so their
// detectTestnet call decides from the declared env, not a chain spec_name
// guess, whenever one is available. Module-level (like BULLETIN_ENDPOINTS/
// POOL_SIZE above) because getProvider/getDirectProvider/getSignerProvider
// run outside deploy()'s own scope. Also read by isPoolFallbackAllowed below
// to gate whether a failed Bulletin allowance slot may fall back to the
// shared pool — the pool is derived from the well-known dev phrase and holds
// no grant on mainnet.
let bulletinNetwork: string | undefined;

/**
 * Bulletin RPC override precedence, shared by every caller that resolves an
 * env's Bulletin endpoint(s): an explicit `rpcOverride` (CLI `--rpc`) wins,
 * falling back to the `BULLETIN_RPC` env var, else the env-resolved
 * candidate list is used unchanged. The override is placed first (primary)
 * with the rest of the env's candidates kept as fail-over backups, minus any
 * duplicate of the override itself.
 *
 * Extracted from `deploy()`'s own resolution so `manifest/publish.ts` can
 * compute the exact same endpoint `deploy()` would for a given env/--rpc,
 * instead of inventing a second resolution mechanism.
 */
export function resolveBulletinEndpoints(envBulletin: string[], rpcOverride?: string): string[] {
  const userRpc = rpcOverride ?? process.env.BULLETIN_RPC;
  return userRpc ? [userRpc, ...envBulletin.filter(e => e !== userRpc)] : envBulletin;
}

/**
 * Set the module-level Bulletin endpoint list that `getProvider()` (and
 * therefore `storeFile`/`storeDirectory` when called without an explicit
 * client) connects to. `deploy()` sets this from the resolved env/--rpc at
 * the top of every run. Exported so callers outside this module — namely
 * `manifest/publish.ts`'s `publishManifest`, which can run without a
 * preceding in-process `deploy()` call — can point their own storage
 * uploads at the same env instead of silently defaulting to
 * `DEFAULT_BULLETIN_RPC`. ESM named imports are read-only bindings, so a
 * setter is the only way for another module to update this `let`.
 */
export function setBulletinEndpoints(endpoints: string[]): void {
  BULLETIN_ENDPOINTS = endpoints;
}

/**
 * Set the module-level `bulletinNetwork` context declared above. `manifest/publish.ts`
 * opens its own storage provider and can run without a preceding in-process `deploy()`,
 * in which case `bulletinNetwork` would still be undefined — the historical
 * (testnet-shaped) fallback behavior, not a hard failure on mainnet, and detectTestnet's
 * own spec_name guess would also be skipped. Same reasoning as `setBulletinEndpoints`:
 * ESM named imports are read-only bindings, so a setter is the only way for another
 * module to update this `let`.
 */
export function setBulletinNetworkContext(network: string | undefined): void {
  bulletinNetwork = network;
}

/** The value above, for tests that assert the wiring without a chain connection. */
export function __getBulletinNetworkContextForTest(): string | undefined {
  return bulletinNetwork;
}
// Module-level flag: flipped by getWsProvider's onStatusChanged if papi
// connects to a non-primary endpoint. Flushed into the deploy span at the end
// of deploy() so the attribute always lands even if the callback fires late
// (e.g. after the span has already been annotated).
let _deployRpcFailedOver = false;

// Module-level WS-halt callback registered by storeChunkedContent. Fires
// synchronously when getWsProvider's onStatusChanged sees CLOSE or ERROR.
// The callback's job is to destroy the current PAPI client BEFORE PAPI's
// auto-reconnect path can run its leaky `activeBroadcasts.forEach` loop
// (issue #287 — that forEach mutates the Map it's iterating, generating
// thousands of 4 MB transaction-broadcast strings until OOM).
let _onWsHalt: (() => void) | null = null;

export function setWsHaltCallback(cb: (() => void) | null): void {
  _onWsHalt = cb;
}

// Shared onStatusChanged callback for Bulletin providers. Flips the module-level
// failover flag, writes telemetry, and on CLOSE/ERROR fires the registered
// halt callback so storeChunkedContent can destroy the client synchronously.
export function makeBulletinStatusHandler(primary: string) {
  return (s: { type: WsEvent; uri?: string }) => {
    if (s.type === WsEvent.CONNECTED && s.uri !== primary) {
      _deployRpcFailedOver = true;
      setDeployAttribute("deploy.rpc.failed_over", "true");
      captureWarning("Bulletin RPC failover", { from: primary, to: s.uri });
    }
    if (s.type === WsEvent.CLOSE || s.type === WsEvent.ERROR) {
      try { _onWsHalt?.(); } catch { /* halt-callback failures are non-fatal */ }
    }
  };
}

const CHUNK_SIZE: number = 2 * 1024 * 1024;
const MAX_FILE_SIZE: number = 8 * 1024 * 1024;
const MAX_RECONNECTIONS: number = parseInt(process.env.BULLETIN_MAX_RECONNECTIONS ?? "3", 10);
const CHUNK_TIMEOUT_MS: number = parseInt(process.env.BULLETIN_CHUNK_TIMEOUT_MS ?? "180000", 10);
// Chunk tx mortality window. The comment here used to say "24s/block,
// period:16 ≈ 6.4 min" — that block time was wrong. The Bulletin chain's
// actual block time is 6s (empirically measured via
// tools/bulletin-retention-probe.mjs, see
// docs-internal/superpowers/plans/2026-05-07-incremental-upload-v2.md), so
// period:16 was really only ~96s — under the 90-240s inclusion stalls
// #1048's Sentry cluster shows for this path. Raised to 64 (6s × 64 = 384s
// ≈ 6.4min, the duration originally intended) so a slow-but-eventual
// inclusion survives the stall instead of expiring into AncientBirth/BadProof.
// Widening this used to risk a live duplicate-tx at the same nonce (the old
// design relied on the ORIGINAL tx expiring before a resubmit could collide
// with it) — that risk is now covered by reconcileTimedOutChunk() (#1051),
// which checks nonce-advance + CID-at-best-block before every resubmit, so
// mortality no longer needs to be kept artificially short to avoid collisions.
// (storeFile and root-node stay at period:256 — no retry loop, no duplicate risk.)
// Overridable via BULLETIN_CHUNK_MORTALITY_PERIOD (integer, default 64).
// Tests set a short period (e.g. 2) to exercise the expiry-retry path.
export const CHUNK_MORTALITY_PERIOD: number = (() => {
  const v = parseInt(process.env.BULLETIN_CHUNK_MORTALITY_PERIOD ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 64;
})();

// Chain-liveness gate for the chunk-upload retry loop (#1051). On a
// chunk-tx timeout, before spending a retry attempt on a resubmit, wait up
// to this long for the best-block height to advance past what it was when
// the timeout fired. A frozen chain means resubmitting would just pile up a
// same-nonce collision once it resumes — waiting is strictly better.
// Bounded so a single dead/lagging RPC peer can't hang a retry forever;
// `waitForChainLiveness` fails open (proceeds as if live) when it can't
// determine height at all. Overridable via BULLETIN_CHUNK_LIVENESS_MAX_WAIT_MS.
const CHUNK_LIVENESS_MAX_WAIT_MS: number = parseInt(process.env.BULLETIN_CHUNK_LIVENESS_MAX_WAIT_MS ?? "60000", 10);
const CHUNK_LIVENESS_POLL_MS: number = 5_000;
const RETRY_BASE_DELAY_MS: number = 2_000;
const RETRY_MAX_DELAY_MS: number = 15_000;
export const WS_HEARTBEAT_TIMEOUT_MS: number = 300_000;

// GRANDPA finality poll constants.
// Phase B's just-uploaded chunks (especially the root, the last extrinsic
// submitted) are in best chain but not yet at finalised head — give them
// time to finalise naturally before assuming something went wrong.
// Default raised from 90s to 210s (#1049): paseo-next-v2 has been observed
// lagging finality by 90-240s in production; 90s was routinely too short,
// which pushed chunks that were merely finality-lagging into the re-upload
// path below (that path is now best-block-gated, but a longer natural wait
// keeps it from firing at all on a healthy-but-slow chain).
const GRANDPA_NATURAL_WAIT_MS: number = parseInt(process.env.BULLETIN_GRANDPA_NATURAL_WAIT_MS ?? "210000", 10);
const GRANDPA_REUPLOAD_POLL_MS: number = 5_000;
// 120s: paseo-next-v2 has 12s block times; a re-uploaded chunk needs inclusion
// (~12s) + 2 finality rounds (~24s) = ~36s minimum. 120s gives 3× headroom.
// Overridable via BULLETIN_GRANDPA_REUPLOAD_TIMEOUT_MS (#1049) for chains
// with slower finality than paseo-next-v2's baseline.
const GRANDPA_REUPLOAD_TIMEOUT_MS: number = parseInt(process.env.BULLETIN_GRANDPA_REUPLOAD_TIMEOUT_MS ?? "120000", 10);
// Up to 3 re-upload rounds: a re-uploaded tx can land in a block that gets
// forked off; retrying submits a fresh tx on the canonical chain.
const GRANDPA_REUPLOAD_MAX_ROUNDS: number = 3;
// Bounded extra wait for chunks confirmed present at best-block but still
// not finalised after GRANDPA_NATURAL_WAIT_MS (#1049). These are NEVER
// re-uploaded — this wait is purely to let GRANDPA catch up before we
// report success. If it expires, the deploy still succeeds: best-block
// presence is sufficient (finality is a best-effort/async confirmation).
const GRANDPA_LAGGING_WAIT_MS: number = parseInt(process.env.BULLETIN_GRANDPA_LAGGING_WAIT_MS ?? "90000", 10);

// Polls `cids` at finalised head every GRANDPA_REUPLOAD_POLL_MS, mutating
// the Set in place by deleting cids as they finalise, until either the Set
// is empty or `timeoutMs` elapses. Shared by all three GRANDPA wait loops
// (natural wait, post-re-upload wait, and the #1049 finality-lagging wait)
// so a future change to polling behaviour (backoff, batching, etc.) only
// needs to happen once.
async function pollUntilFinalized(cids: Set<string>, timeoutMs: number, client: any): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && cids.size > 0) {
    await new Promise((r) => setTimeout(r, GRANDPA_REUPLOAD_POLL_MS));
    const poll = await probeChunks([...cids], { client, atFinalized: true });
    for (const r of poll) {
      if (r.present === true) cids.delete(r.cid);
    }
  }
}

// Per-deploy retry budget (#216). Bounds peak in-flight allocation during
// WS-halt storms: each chunk-retry and reconnect adds ~2 MB encoded
// extrinsic + RxJS observable tree + WS frame state. If we churn through
// more than RETRY_BUDGET_MAX_EVENTS recovery attempts within a sliding
// RETRY_BUDGET_WINDOW_MS, bail rather than letting GC fall behind.
// Defaults sized so a healthy WS hiccup (1-2 retries) passes through but
// a sustained outage trips fast — at ~3 retries/10s the budget blows in
// under a minute, well before the 2 GB+ peak we observed in #216.
const RETRY_BUDGET_MAX_EVENTS: number = parseInt(process.env.BULLETIN_RETRY_BUDGET_MAX ?? "5", 10);
const RETRY_BUDGET_WINDOW_MS: number = parseInt(process.env.BULLETIN_RETRY_BUDGET_WINDOW_MS ?? "30000", 10);

export function retryBudgetExhausted(
  history: number[],
  maxEvents: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  let inWindow = 0;
  for (const t of history) {
    if (now - t <= windowMs) inWindow++;
  }
  return inWindow > maxEvents;
}

// twin: upstream defines this next to its ChainError type, as part of an earlier
// change (InvalidTransaction variant carried structurally) this repo has not
// taken. Only the pure extractor is brought in, because isNonceCollisionError
// needs it; nothing here sets chainErrorVariant, so the message is the carrier.
/**
 * Pulls the InvalidTransaction variant name (e.g. "AncientBirthBlock",
 * "BadProof", "Payment") out of the raw `{ "type": "Invalid", "value": {
 * "type": "<Variant>" } }` shape substrate's signed extension returns.
 */
export function extractInvalidTransactionVariant(msg: string): string | undefined {
  return /"type"\s*:\s*"Invalid"[\s\S]*?"value"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(msg)?.[1];
}

/**
 * How the root-node store loop answers a failed submit (#1672). A tx the pool
 * rejects for its nonce is a nonce collision, not a lost connection: a sibling
 * deploy on the same signer took that nonce (S9), so the fix is a fresh nonce,
 * and a reconnect only burns budget. papi reports it as InvalidTxError Stale once
 * the block holding the other tx finalises, or as isValid:false on a reorg. A WS
 * halt or a connection error means the client is dead. Anything else keeps the
 * historical reconnect.
 */
export function classifyRootSubmitError(error: any, wsHalted: boolean): "reconnect" | "nonce-collision" {
  if (wsHalted || isConnectionError(error)) return "reconnect";
  return isNonceCollisionError(error) ? "nonce-collision" : "reconnect";
}

/** The pool rejected the tx for its nonce: InvalidTxError Stale, or isValid:false (#1672). */
export function isNonceCollisionError(error: any): boolean {
  const msg = String(error?.message ?? error);
  return (error?.chainErrorVariant ?? extractInvalidTransactionVariant(msg)) === "Stale" || msg.includes("isValid:false");
}

// Wait before re-reading the nonce after a collision (#1672). Two deploys on one
// signer see their Stale at the same finalised block and re-read the same
// nextIndex, so without a random offset they collide again on every retry.
const defaultNonceCollisionBackoff = (): number => RETRY_BASE_DELAY_MS + Math.round(Math.random() * 10_000);
let nonceCollisionBackoffMs: () => number = defaultNonceCollisionBackoff;
/** Test-only: replace the collision backoff (null restores the default). */
export function __setNonceCollisionBackoffForTest(fn: (() => number) | null): void {
  nonceCollisionBackoffMs = fn ?? defaultNonceCollisionBackoff;
}

export function isConnectionError(error: any): boolean {
  const msg = error?.message || String(error);
  // `ChainHead disjointed` is PAPI's error when chainHead subscription state
  // is inconsistent — fires after our destroy-on-WS-halt workaround tears
  // down a client mid-subscription. Treating it as a connection error so
  // the retry path triggers doReconnect (build a fresh client) rather than
  // looping on the destroyed one.
  // `Not connected` / `not connected` is the polkadot-api raw-client error
  // emitted during teardown when a WS subscription is torn down after the
  // client is already closed — matches the login.ts teardown pattern.
  return /heartbeat timeout|WS halt|Unable to connect|ChainHead disjointed|not connected/i.test(msg);
}

/**
 * True for benign teardown noise that must NOT fail a deploy/command. Covers:
 *  - connection errors (recoverable via the storage reconnect path) — this already
 *    includes papi's raw "Not connected" via isConnectionError above;
 *  - "DestroyedError: Client destroyed" — orphaned pending-response promises the
 *    SSO/papi client rejects while a session adapter is torn down AFTER the work
 *    is done (e.g. the owner-signs update path destroying its re-acquired session);
 *  - the `@novasamatech/sdk-statement` `getStatements` TDZ crash: `const unsubscribe`
 *    is initialised from `api.subscribeStatement(...)`, and both the next/error
 *    callbacks close over it. If that observable settles SYNCHRONOUSLY (a poll
 *    firing after the WS client was already destroyed — hit on Ctrl+C/teardown
 *    during an active pairing poll), the callback runs before the binding is
 *    initialised, throwing `ReferenceError: Cannot access 'unsubscribe' before
 *    initialization`, which rxjs rethrows as an uncaughtException.
 *    `patches/@novasamatech+sdk-statement+0.6.0.patch` is the PRIMARY fix (it also
 *    closes a subscription leak this guard cannot undo) — this only prevents an
 *    unpatched consumer (e.g. npm blocking install scripts) from crashing outright.
 *    Deliberately narrow: matches only this exact binding name, so an unrelated
 *    ReferenceError still crashes the process.
 * The CLI's crash handlers use this so a successful deploy isn't marked killed
 * (exit 2) by late teardown noise. Checks name+message so DestroyedError matches
 * even when its message differs.
 */
export function isBenignTeardownError(error: any): boolean {
  if (isConnectionError(error)) return true;
  const isErr = error instanceof Error;
  const s = isErr ? `${error.name ?? ""} ${error.message ?? ""}` : String(error);
  // Case-insensitive on purpose: login.ts's own regex was /client destroyed|destroyederror/i, so
  // matching case-sensitively here would silently shrink its swallow set on delegation.
  if (/DestroyedError|Client destroyed|Not connected/i.test(s)) return true;
  // `instanceof Error` + exact name, so a plain object claiming to be a ReferenceError doesn't
  // qualify; the binding name is pinned so an unrelated TDZ error still crashes.
  return isErr && error.name === "ReferenceError"
    && /cannot access 'unsubscribe' before initialization/i.test(error.message ?? "");
}

// Multihash codes accepted by createCID + toHashingEnum. Exported so callers
// can pass a per-call override to storeFile without re-stating the magic
// number at every call site.
//
// SHA256 is bulletin-deploy's default (matches the CIDs every existing
// consumer has pinned). BLAKE2B_256 is the multihash code the Polkadot Host
// preimage SDK reconstructs internally (polkadot-desktop's
// `ipfsService.hashToCid` hardcodes it), so blobs the host must resolve via
// `preimageManager.lookup` — product icons in particular — MUST be uploaded
// under blake2b-256 or the host SDK can't find them on the IPFS gateway.
export const SHA256_MULTIHASH_CODE = 0x12;
export const BLAKE2B_256_MULTIHASH_CODE = 0xb220;

const CID_CONFIG = { version: 1, codec: 0x55, hashCode: SHA256_MULTIHASH_CODE, hashLength: 32 } as const;

// `path` defaults to "" (root key). Pass a path like "//deploy/3" to derive a
// sub-account — used by pool mode, or by direct-signer tests that want to
// exercise a specific pool-derived account without colliding with the root.
export function deriveRootSigner(mnemonic: string, path: string = ""): { signer: PolkadotSigner; ss58: string } {
  const entropy = mnemonicToEntropy(mnemonic);
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const keyPair = derive(path);
  const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
  return { signer, ss58: ss58Address(keyPair.publicKey) };
}

export function createCID(data: Uint8Array, codec: number = CID_CONFIG.codec, hashCode: number = CID_CONFIG.hashCode): CID {
  let hash: Uint8Array;
  if (hashCode === 0xb220) hash = blake2b(data, { dkLen: CID_CONFIG.hashLength });
  else if (hashCode === 0x12) hash = sha256(data);
  else throw new Error(`Unsupported hash code: 0x${hashCode.toString(16)}`);
  return CID.createV1(codec, createMultihash(hashCode, hash));
}

export function encodeContenthash(cidString: string): string {
  const decoder = cidString.startsWith("Qm") ? base58btc : base32;
  const cid = CID.parse(cidString, decoder);
  const contenthash = new Uint8Array(cid.bytes.length + 2);
  contenthash[0] = 0xe3;
  contenthash[1] = 0x01;
  contenthash.set(cid.bytes, 2);
  return Buffer.from(contenthash).toString("hex");
}

// ── Encryption (password-protected SPAs) ──────────────────────
// Format: [DOTLI_ENC\x01 (10B)] [salt (16B)] [nonce (12B)] [ChaCha20-Poly1305 ciphertext] [tag (16B)]

export const ENCRYPT_MAGIC = new Uint8Array([0x44, 0x4f, 0x54, 0x4c, 0x49, 0x5f, 0x45, 0x4e, 0x43, 0x01]);
export const ENCRYPT_SALT_LEN = 16;
export const ENCRYPT_NONCE_LEN = 12;
export const ENCRYPT_TAG_LEN = 16;
export const ENCRYPT_KEY_LEN = 32;
export const ENCRYPT_PBKDF2_ITERATIONS = 100_000;

export async function encryptContent(data: Uint8Array, password: string): Promise<Uint8Array> {
  const { webcrypto, createCipheriv } = await import("crypto");
  const subtle = webcrypto.subtle;
  const salt = webcrypto.getRandomValues(new Uint8Array(ENCRYPT_SALT_LEN));
  const nonce = webcrypto.getRandomValues(new Uint8Array(ENCRYPT_NONCE_LEN));

  const keyMaterial = await subtle.importKey("raw", Buffer.from(password, "utf-8"), "PBKDF2", false, ["deriveBits"]);
  const keyBits = await subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ENCRYPT_PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    ENCRYPT_KEY_LEN * 8,
  );

  const cipher = createCipheriv("chacha20-poly1305", Buffer.from(keyBits), nonce, { authTagLength: ENCRYPT_TAG_LEN });
  cipher.setAAD(ENCRYPT_MAGIC, { plaintextLength: data.length });
  return Buffer.concat([ENCRYPT_MAGIC, salt, nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}

function toHashingEnum(mhCode: number): { type: string; value: undefined } {
  switch (mhCode) {
    case 0xb220: return { type: "Blake2b256", value: undefined };
    case 0x12: return { type: "Sha2_256", value: undefined };
    case 0x1b: return { type: "Keccak256", value: undefined };
    default: throw new Error(`Unhandled multihash code: ${mhCode}`);
  }
}

// bulletin #1637: reads for checkPoolAccountNonceHealth. The on-chain nonce comes from the deploy's own
// client at the BEST block. Each nextIndex sample goes through fetchNonce, which opens a fresh
// WebSocket per call (a new load-balancer backend pick), the same path chunk nonces are read
// through. Samples are spread round-robin over the endpoints.
async function checkSignerQueue(unsafeApi: any, who: string, address: string): Promise<NonceHealth> {
  const h = await checkPoolAccountNonceHealth(address, {
    readOnchainNonce: async (a: string) => Number((await unsafeApi.query.System.Account.getValue(a, { at: "best" })).nonce),
    readNextIndex: (a: string, sample: number) => fetchNonce(BULLETIN_ENDPOINTS[sample % BULLETIN_ENDPOINTS.length], a),
    samples: NONCE_HEALTH_SAMPLES * BULLETIN_ENDPOINTS.length,
  });
  console.log(h.verdict === "unknown"
    ? `   Could not check ${who}'s pending-tx queue (${h.reason}); continuing`
    : `   Pending-tx queue (${who}): on-chain nonce ${h.onchain}, nextIndex samples [${h.samples.join(", ")}] -> ${h.verdict}`);
  return h;
}

// bulletin #1637: which accounts a deploy refused because their queue was stuck. Seeded "none".
function recordStuckSkipped(ids: Array<number | string>): void {
  if (ids.length > 0) setDeployAttribute("deploy.pool.stuck_skipped", ids.join(","));
}

async function getProvider({ checkQueue = true }: { checkQueue?: boolean } = {}): Promise<ProviderResult> {
  const primary = BULLETIN_ENDPOINTS[0];
  console.log(`   Connecting to Bulletin: ${primary}`);
  const client = createPolkadotClient(getWsProvider(
    BULLETIN_ENDPOINTS,
    { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS, onStatusChanged: makeBulletinStatusHandler(primary) },
  ));
  const unsafeApi: any = client.getUnsafeApi();

  try {
    await cryptoWaitReady();
    // One resolver, shared with bin/polkadot-app-bootstrap, so the accounts an operator authorizes
    // are the accounts a deploy uploads from (see resolvePoolMnemonic's doc comment).
    const poolAccounts = derivePoolAccounts(POOL_SIZE, resolvePoolMnemonic());
    const authorizations = await fetchPoolAuthorizations(unsafeApi, poolAccounts);
    const poolIndexEnv = process.env.BULLETIN_POOL_ACCOUNT_INDEX;
    let pinnedPoolIndex: number | undefined;
    if (poolIndexEnv != null && poolIndexEnv !== "") {
      const n = Number(poolIndexEnv);
      if (!Number.isInteger(n) || n < 0) {
        throw new NonRetryableError(`BULLETIN_POOL_ACCOUNT_INDEX must be a non-negative integer, got "${poolIndexEnv}"`);
      }
      pinnedPoolIndex = n;
    }
    // bulletin #1637: skip (or, when pinned, fail fast on) an account whose pending-tx queue is stuck.
    let selectionResult;
    try {
      selectionResult = await selectHealthyPoolAccount(authorizations, {
        pinnedIndex: pinnedPoolIndex,
        checkHealth: checkQueue
          ? (a) => checkSignerQueue(unsafeApi, `pool account ${a.index}`, a.address)
          : async () => ({ verdict: "unknown", samples: [], reason: "skipped on reconnect" }),
      });
    } catch (e) {
      if (e instanceof StuckPoolAccountError) recordStuckSkipped(e.skippedStuck.map((s) => s.index));
      throw e;
    }
    const selectedAccount = selectionResult.account;
    const eligibleCount = selectionResult.eligibleCount;
    recordStuckSkipped(selectionResult.skippedStuck.map((s) => s.index));
    await ensureAuthorized(unsafeApi, selectedAccount.address, `pool account ${selectedAccount.index}`, { network: bulletinNetwork });

    console.log(`   Using pool account ${selectedAccount.index}: ${selectedAccount.address}`);
    setDeployAttribute("deploy.signer.mode", "pool");
    setDeployAttribute("deploy.pool.account", truncateAddress(selectedAccount.address) as string);
    setDeployAttribute("deploy.pool.index", String(selectedAccount.index));
    setDeployAttribute("deploy.pool.eligible_count", eligibleCount);
    return { client, unsafeApi, signer: selectedAccount.signer, ss58: selectedAccount.address };
  } catch (e) {
    client.destroy();
    throw e;
  }
}

async function getDirectProvider(mnemonic: string, derivationPath: string = "", { checkQueue = true }: { checkQueue?: boolean } = {}): Promise<ProviderResult> {
  const primary = BULLETIN_ENDPOINTS[0];
  console.log(`   Connecting to Bulletin: ${primary}`);
  const client = createPolkadotClient(getWsProvider(
    BULLETIN_ENDPOINTS,
    { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS, onStatusChanged: makeBulletinStatusHandler(primary) },
  ));
  const unsafeApi: any = client.getUnsafeApi();
  const { signer, ss58 } = deriveRootSigner(mnemonic, derivationPath);

  console.log(`   Using direct signer: ${ss58}${derivationPath ? ` (path: ${derivationPath})` : ""}`);

  // bulletin #1637: a direct signer has no other account to fall back to, so a stuck queue fails fast
  // instead of 3 x 180 s chunk timeouts. "unknown" (RPC trouble) proceeds as before. The check
  // never rejects and runs alongside the authorization read; it is awaited before ensureAuthorized.
  const queueCheck: Promise<NonceHealth> = checkQueue
    ? checkSignerQueue(unsafeApi, "direct signer", ss58)
    : Promise.resolve({ verdict: "unknown", samples: [] });
  let [auth, currentBlock] = await Promise.all([
    readAccountAuthorization(unsafeApi, ss58),
    client.getFinalizedBlock(),
  ]);
  const queue = await queueCheck;
  if (queue.verdict === "stuck") {
    client.destroy();
    recordStuckSkipped([parsePoolDerivationIndex(derivationPath) ?? "direct"]);
    throw new NonRetryableError(stuckQueueMessage(
      `Direct signer${derivationPath ? ` ${derivationPath}` : ""}`, ss58, queue,
      "Deploy with another signer or derivation path, or wait for the queue to clear.",
    ));
  }
  let now = currentBlock.number;
  if (!isAuthorizationSufficient(auth, now)) {
    try {
      await ensureAuthorized(unsafeApi, ss58 as string, "direct signer", { network: bulletinNetwork });
      [auth, currentBlock] = await Promise.all([
        readAccountAuthorization(unsafeApi, ss58),
        client.getFinalizedBlock(),
      ]);
      now = currentBlock.number;
    } catch (e: any) {
      client.destroy();
      throw new NonRetryableError(`Account ${ss58} is not authorized for Bulletin storage and auto-authorization failed: ${e.message}`);
    }
  }
  console.log(`   Authorization: expires at block ${auth?.expiration ?? 0} (current: ${now})`);

  setDeployAttribute("deploy.signer.mode", "direct");
  setDeployAttribute("deploy.signer.address", truncateAddress(ss58) as string);
  return { client, unsafeApi, signer, ss58 };
}

async function getSignerProvider(signer: PolkadotSigner, ss58: string): Promise<ProviderResult> {
  const primary = BULLETIN_ENDPOINTS[0];
  console.log(`   Connecting to Bulletin: ${primary}`);
  const client = createPolkadotClient(getWsProvider(
    BULLETIN_ENDPOINTS,
    { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS, onStatusChanged: makeBulletinStatusHandler(primary) },
  ));
  const unsafeApi: any = client.getUnsafeApi();

  console.log(`   Using external signer: ${ss58}`);

  let [auth, currentBlock] = await Promise.all([
    readAccountAuthorization(unsafeApi, ss58),
    client.getFinalizedBlock(),
  ]);
  let now = currentBlock.number;
  if (!isAuthorizationSufficient(auth, now)) {
    try {
      await ensureAuthorized(unsafeApi, ss58, "external signer", { network: bulletinNetwork });
      [auth, currentBlock] = await Promise.all([
        readAccountAuthorization(unsafeApi, ss58),
        client.getFinalizedBlock(),
      ]);
      now = currentBlock.number;
    } catch (e: any) {
      client.destroy();
      throw new NonRetryableError(`Account ${ss58} is not authorized for Bulletin storage and auto-authorization failed: ${e.message}`);
    }
  }
  console.log(`   Authorization: expires at block ${auth?.expiration ?? 0} (current: ${now})`);

  setDeployAttribute("deploy.signer.mode", "external");
  setDeployAttribute("deploy.signer.address", truncateAddress(ss58) as string);
  return { client, unsafeApi, signer, ss58 };
}

// #1107 introduced this resolver so the bin's flag/env resolution is
// unit-testable and so the two env vars are forwarded consistently
// (previously the bin only forwarded `flags.mnemonic` into
// `options.mnemonic`, so an env-only mnemonic never reached
// `chooseSignerInput` and a persisted session silently won instead — even
// though `chooseSignerInput` already prefers mnemonic first).
//
// bulletin #1553/#1461: moved to src/mnemonic.ts and re-exported here
// (rather than defined locally) so `DotNS.connect` (src/dotns.ts) can share
// the exact same precedence logic without a deploy.ts <-> dotns.ts import
// cycle — deploy.ts already imports from dotns.ts. Keeping one definition
// removes the possibility of the two files' precedence drifting apart again.
export { resolveEffectiveMnemonic, mnemonicConflictNotice } from "./mnemonic.js";

/**
 * Resolve the environment id the CLI should target, in precedence order:
 * `--env` flag > `PAD_ENV` env var. Returns `undefined` when neither is
 * set — callers (deploy(), the bin's other flag sites) already fall back to
 * `DEFAULT_ENV_ID` themselves, so this helper doesn't bake that default in;
 * it only resolves the flag/env-var precedence (mirrors
 * `resolveEffectiveMnemonic`'s pattern so the bin's session default is
 * unit-testable).
 */
export function resolveEnvId(opts: {
  flagEnv: string | undefined;
  envVar: string | undefined;
}): string | undefined {
  return opts.flagEnv ?? opts.envVar;
}

/**
 * Decide whether the deploy should publish product-config manifest records
 * (subname registration + resolver + contenthash + text records), independent
 * of whether `tryLoadProductConfig` found a config on disk. Exists so the
 * bin's `--no-manifest` / `--content-only` short-circuit is unit-testable:
 * with the flag set, manifest publishing is skipped even when a
 * `polkadot-app-deploy.config.*` is discoverable, producing the same
 * content-only deploy as when no config exists at all.
 */
export function shouldPublishManifest(opts: {
  configFound: boolean;
  noManifest: boolean;
}): boolean {
  return opts.configFound && !opts.noManifest;
}

/**
 * Choose the post-deploy banner text (#1164). Pure and unit-testable without
 * a live deploy. `manifestPending` is opt-in on `DeployOptions` — every
 * existing library caller (e.g. playground-cli) leaves it unset and keeps
 * today's "DEPLOYMENT COMPLETE!" banner.
 */
export function pickPostDeployBannerText(manifestPending: boolean | undefined): string {
  return manifestPending ? "CONTENT DEPLOYED — publishing product manifest…" : "DEPLOYMENT COMPLETE!";
}

/**
 * Print the real completion banner + browser URL. Called by `deploy()` itself
 * when `manifestPending` is unset/false, and by `bin/polkadot-app-deploy` once
 * its own subsequent `publishManifest()` call succeeds when it is set.
 */
export function printDeploymentCompleteBanner(fullDomain: string, browserUrl: string): void {
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE!");
  console.log("=".repeat(60));
  console.log("\nCheck it out here:");
  console.log(`   ${browserUrl}`);
  console.log(`   ${fullDomain}  (in a Polkadot app: mobile or desktop)`);
  console.log("\n" + "=".repeat(60) + "\n");
}

/**
 * storageSigner > signer (unless session-backed with no slot, bulletin #1452) > mnemonic > pool
 * precedence for storage routing. `selectStorageReconnect` delegates to this so the two
 * never drift apart. Exported for unit testing.
 */
export function __selectStorageProviderModeForTest(
  options: Pick<DeployOptions, "storageSigner" | "storageSignerAddress" | "signer" | "signerAddress" | "mnemonic" | "sessionSigner">,
): "storageSigner" | "signer" | "direct" | "pool" {
  if (options.storageSigner && options.storageSignerAddress) return "storageSigner";
  // bulletin #1452: a phone-backed session signer with no allowance slot must fall through to
  // pool/mnemonic, not sign chunks itself. A caller-injected external signer (sessionSigner
  // unset — e.g. playground-cli) is unaffected and still routes to "signer" here.
  if (options.signer && options.signerAddress && !options.sessionSigner) return "signer";
  if (options.mnemonic) return "direct";
  return "pool";
}

/**
 * Build the signer-related DeployOptions fields from a resolved `resolveDeployActors`
 * result. Pulled out of the resolve branch (bulletin #1452) so the session-vs-local
 * distinction that gates Bulletin storage routing is directly unit-testable without
 * exercising `resolveDeployActors`' SSO stack. Exported for unit testing.
 */
export function deployActorsToSignerOptions(
  actors: { worker: { signer: PolkadotSigner; address: string; source: string }; recipientH160?: string },
): Pick<DeployOptions, "signer" | "signerAddress" | "transferTo" | "sessionSigner"> {
  return {
    signer: actors.worker.signer,
    signerAddress: actors.worker.address,
    ...(actors.recipientH160 ? { transferTo: actors.recipientH160 } : {}),
    sessionSigner: actors.worker.source === "session",
  };
}

/**
 * Decide how to source the signer for a deploy invocation. Exported for unit testing.
 *
 *  - "mnemonic"  — caller passed --mnemonic; use mnemonic-derived signer (existing path).
 *  - "injected"  — caller pre-built a PolkadotSigner (library or test seam).
 *  - "resolve"   — use resolveSigner: either --suri was passed (dev account /
 *                  mnemonic), OR a persisted login session exists (hasSession) so a
 *                  plain `deploy` uses the logged-in identity (the #411 UX). This is
 *                  the only path that loads the SSO stack.
 *  - "pool"      — none of the above: no --mnemonic, no pre-built signer, no --suri,
 *                  and no persisted session → pool path, unchanged from pre-#411.
 *
 * Layer-3 isolation is preserved because `hasSession` is computed at the call site
 * from a cheap session-file existence check — headless/CI deploys (no session file,
 * no --suri) never load the SSO stack or hit the People chain.
 */
export function chooseSignerInput(opts: {
  mnemonic: string | undefined;
  suri: string | undefined;
  hasInjectedSigner: boolean;
  hasSession?: boolean;
}): "mnemonic" | "injected" | "resolve" | "pool" {
  if (opts.mnemonic) return "mnemonic";
  if (opts.hasInjectedSigner) return "injected";
  if (opts.suri) return "resolve";
  if (opts.hasSession) return "resolve";
  return "pool";
}

// True when the active signer is phone-backed — a resolved login session, or an
// injected QR/mobile signer — and therefore needs phone taps. In transfer mode
// (options.transferTo set) the injected signer is a LOCAL worker that signs every
// tx itself and hands the name over at the end, so no phone is ever involved.
// Gates both the up-front "phone ready" banner and the per-step "check your phone"
// reminder — they must agree, so they read the same predicate.
export function isPhoneSignerActive(
  options: Pick<DeployOptions, "signer" | "signerAddress" | "transferTo" | "localSigner">,
): boolean {
  return !!(options.signer && options.signerAddress && !options.transferTo && !options.localSigner);
}

/**
 * Build the error bin/polkadot-app-deploy's `confirmPhoneReady` hook throws when
 * the phone-confirmation gate fires in a non-interactive environment (issue #1363).
 *
 * Pre-fix, the CLI unconditionally created a `readline` interface and awaited a
 * keypress; in a non-interactive shell (no TTY, or CI) readline's `"close"` event
 * fires immediately because there is no input to deliver, and the gate rejected
 * with `new Error("aborted by user")` — indistinguishable from a deliberate
 * Ctrl-C, blaming an operator who was never there. There is no safe default to
 * fall back to here: unlike a yes/no prompt, silently proceeding would submit a
 * transaction nobody approved on their phone. So a non-interactive caller must
 * hard-fail with a message naming the actual fix — swap to a signer that never
 * needs phone confirmation.
 *
 * `NonRetryableError` (not a plain `Error`): retrying in the same CI environment
 * fails the identical way every time, so bin/polkadot-app-deploy should exit
 * with EXIT_CODE_NO_RETRY rather than a retryable-looking generic failure.
 *
 * Pure and readline-free (unlike the CLI's readline wiring) so it's directly
 * unit-testable; bin/polkadot-app-deploy calls this only after checking
 * version-check.ts's `isInteractive()` itself, reusing that existing TTY/CI
 * detection rather than adding a second one.
 */
export function nonInteractivePhoneConfirmationError(label: string): NonRetryableError {
  return new NonRetryableError(
    `Phone confirmation required for "${label}" but this run is non-interactive ` +
      `(no TTY, or a CI environment was detected) — there is nobody to press Y. ` +
      `Use a signer that never needs phone confirmation: pass --mnemonic, or set ` +
      `the MNEMONIC or DOTNS_MNEMONIC environment variable.`,
  );
}

/**
 * Decide whether to hand the name over to the signed-in user after a deploy.
 * The handover only fires when the worker FRESHLY REGISTERED the name in this
 * run (#928): updating the content of a name that already exists must never
 * change its ownership. Without this, re-deploying any pre-existing name in
 * transfer mode silently transferred it to whatever session was on disk —
 * which captured shared E2E fixture labels for a local developer's account.
 * Exported for unit testing.
 */
export function shouldHandoverName(
  opts: { transferTo?: string; registeredFresh: boolean },
): boolean {
  return !!opts.transferTo && opts.registeredFresh;
}

/**
 * Produce the one-line storage-signer status printed at resolution time. Exported for unit testing.
 *   User-owned slot: "   Storage signer: your allowance slot <ss58>"  (owned=true)
 *   Explicit slot:   "   Storage signer: allowance slot <ss58>"        (owned=false or omitted)
 *   Fallback:        "   Storage signer: pool fallback (<reason>)"
 */
export function formatStorageSignerLine(slotAddress: string | null, failReason?: string, owned?: boolean): string {
  if (slotAddress) {
    const prefix = owned ? "your allowance slot" : "allowance slot";
    return `   Storage signer: ${prefix} ${slotAddress}`;
  }
  return `   Storage signer: pool fallback (${failReason ?? "no session"})`;
}

/**
 * Storage-signer status line for transfer mode. In transfer mode the local
 * worker (Alice / --suri) signs the whole deploy, INCLUDING Bulletin storage —
 * so it is NOT a pool fallback. The old line said "pool fallback (transfer mode
 * — worker signs storage)", which contradicted the very next "Using external
 * signer: <worker>" line. State plainly that the worker signs storage. Exported
 * for unit testing.
 */
export function formatTransferModeStorageSignerLine(workerAddress: string): string {
  return `   Storage signer: worker ${workerAddress} (transfer mode)`;
}

/**
 * #60: the transfer-mode DotNS announcement, printed at preflight once ownership
 * is known. The up-front worker header states only the worker's storage role (it
 * can't know ownership yet); this line states the transfer-vs-owned-update reality:
 *   New name:      "   DotNS: will register <name> and transfer it to your account <recipient>"
 *   Already owned: "   DotNS: you already own <name> — content update needs your phone signature (no transfer)"
 * Exported for unit testing.
 */
export function formatTransferModeDotnsLine(alreadyOwned: boolean, dotName: string, recipient: string): string {
  return alreadyOwned
    ? `   DotNS: you already own ${dotName} — content update needs your phone signature (no transfer)`
    : `   DotNS: will register ${dotName} and transfer it to your account ${recipient}`;
}

/**
 * Produce an actionable reason string for the pool-fallback warning + telemetry
 * attribute. BulletinSlotAuthError carries a typed reason; other errors
 * (WS/connection, still possible after withTransientRetry's bounded retries
 * are exhausted — see storage-signer.ts) use their message. Extracted from
 * selectStorageReconnect so it's unit-testable without a real WS connection
 * (#1058: pool fallbacks must always carry an explicit, visible reason).
 */
export function describeSlotFallbackReason(e: unknown): string {
  if (e instanceof BulletinSlotAuthError) {
    return e.reason === "expired" && e.expiration != null
      ? `expired at block ${e.expiration}`
      : "no on-chain authorization found";
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * May a failed allowance slot fall back to the shared `//deploy/N` pool?
 *
 * Only off mainnet. The pool is derived from the well-known dev phrase, so on a mainnet chain it
 * holds no authorization and the fallback cannot succeed — it just trades a precise slot error
 * for an out-of-quota failure later in the upload, behind a warning that says the situation is
 * fine. Keyed on the resolved env's declared `network`, the same field used elsewhere to
 * distinguish testnet-vs-mainnet wording; an env that declares nothing (custom presets, library
 * callers that never set it) keeps the historical fallback rather than newly hard-failing.
 */
export function isPoolFallbackAllowed(network?: string): boolean {
  return network !== "mainnet";
}

/**
 * The refusal itself, extracted so the mainnet branch is unit-testable without a WS connection
 * (same reasoning as describeSlotFallbackReason). Returns normally when the fallback is allowed;
 * throws on mainnet, carrying the slot's own failure reason so the message says what actually
 * went wrong rather than only that storage is unavailable.
 */
export function assertPoolFallbackAllowed(network: string | undefined, reason: string): void {
  if (isPoolFallbackAllowed(network)) return;
  throw new NonRetryableError(
    `Bulletin allowance slot not usable: ${reason}. ` +
    `On mainnet storage must run on your own allowance — the shared pool account holds no ` +
    `quota there, so there is nothing to fall back to. Run: ${CLI_NAME} logout && ${CLI_NAME} login`,
  );
}

// bulletin #1637: the pending-tx queue check costs 8 fresh connections per endpoint (plus a 12 s confirm
// wait on a large gap), and behind a halted endpoint each sample waits out fetchNonce's 8 s timer.
// Run it on the first provider a deploy creates, not on every mid-upload reconnect (S8's budget).
function firstCallChecksQueue(make: (checkQueue: boolean) => Promise<ProviderResult>): () => Promise<ProviderResult> {
  let first = true;
  return () => {
    const checkQueue = first;
    first = false;
    return make(checkQueue);
  };
}

export function selectStorageReconnect(options: DeployOptions): () => Promise<ProviderResult> {
  // Delegate the mode decision to the pure, unit-tested selector (bulletin #1452) so this
  // function and __selectStorageProviderModeForTest can never disagree about which branch runs.
  const mode = __selectStorageProviderModeForTest(options);
  const pool = firstCallChecksQueue((checkQueue) => getProvider({ checkQueue }));
  if (mode === "storageSigner") {
    // Committed-signer: once the slot provider fails on the first attempt,
    // every subsequent reconnect uses pool. Prevents signer drift mid-upload
    // (nonce/attribution would break if storage switched signers between chunks).
    // Note: getSlotSignerProvider itself now retries transient connect/query
    // errors internally (withTransientRetry in storage-signer.ts) before
    // giving up, so reaching this catch means the slot is genuinely
    // unavailable (or retries were exhausted) — not a single WS blip.
    let useSlot = true;
    return async () => {
      if (!useSlot) return pool();
      try {
        return await getSlotSignerProvider(options.storageSigner!, options.storageSignerAddress!);
      } catch (e) {
        const reason = describeSlotFallbackReason(e);
        // The pool cannot store on mainnet (dev-phrase accounts, no grant), so falling back
        // would only defer the failure past the upload. Fail here, where the cause is known.
        // Attribute first: the refusal throws, and the reason must reach telemetry either way.
        setDeployAttribute("deploy.signer.fallback_reason", reason);
        assertPoolFallbackAllowed(bulletinNetwork, reason);
        useSlot = false;
        setDeployAttribute("deploy.signer.mode", "pool-fallback");
        console.warn(
          `⚠  Bulletin allowance slot not usable: ${reason}\n` +
          `   Falling back to the shared pool account for storage (fine on testnet).\n` +
          `   To use your own allowance, run: ${CLI_NAME} logout && ${CLI_NAME} login`,
        );
        return pool();
      }
    };
  }
  // External signer (options.signer + options.signerAddress, NOT session-backed): use
  // getSignerProvider for Bulletin storage when no dedicated slot signer is available.
  // This supports programmatic callers (playground-cli, library consumers) that pass
  // their own PolkadotSigner without a pre-allocated BulletInAllowance slot key. A
  // phone-backed session signer with no slot (mode "pool" — bulletin #1452) falls
  // through below.
  if (mode === "signer")
    return () => getSignerProvider(options.signer!, options.signerAddress!);
  if (mode === "direct")
    return firstCallChecksQueue((checkQueue) => getDirectProvider(options.mnemonic!, options.derivationPath, { checkQueue }));
  return pool;
}

function watchTransaction<T>(tx: any, signer: PolkadotSigner, txOpts: any, onSuccess: (event?: any) => T, { label = "transaction", timeoutMs, confirmIncluded }: WatchTransactionOptions = {}): Promise<WatchResult<T>> {
  const timeout = timeoutMs ?? TX_TIMEOUT_MS;
  return new Promise<WatchResult<T>>((resolve, reject) => {
    let settled = false;
    let sub: any;
    const settle = (fn: Function) => (...args: any[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sub?.unsubscribe(); } catch {}
      fn(...args);
    };
    // Chain-evidence fallback (#1656): when the subscription cannot confirm the
    // tx, ask the chain whether its effect (the stored CID) is at the best
    // block. The old fallback compared system_accountNextIndex with the tx's
    // nonce; nextIndex counts the pool, including this very tx while it is
    // still pending, so a pending chunk read as "included".
    const tryChainFallback = async (): Promise<boolean> => {
      if (!confirmIncluded) return false;
      try {
        const present = await confirmIncluded();
        if (settled) return true;
        if (present) {
          console.log(`      ${label}: found at the best block by a content-hash probe, tx was included`);
          settle(resolve)({ value: onSuccess(), viaFallback: true });
          return true;
        }
        console.log(`      ${label}: not found at the best block`);
      } catch (e: any) {
        if (settled) return true;
        console.log(`      ${label}: best-block probe failed: ${e.message?.slice(0, 80)}`);
      }
      return false;
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      if (await tryChainFallback()) return;
      settle(reject)(new Error(`${label} timed out after ${timeout / 1000}s waiting for block confirmation`));
    }, timeout);
    sub = tx.signSubmitAndWatch(signer, txOpts).subscribe({
      next: async (event: any) => {
        if (event.type !== "txBestBlocksState") return;
        if (event.found) {
          if (event.ok) {
            const receipt: ChainReceipt | undefined = event.block
              ? { txHash: String(event.txHash), blockHash: String(event.block.hash), blockNumber: Number(event.block.number) }
              : undefined;
            settle(resolve)({ value: onSuccess(event), viaFallback: false, receipt });
          } else settle(reject)(new Error(`${label} dispatch error`));
          return;
        }
        // event.found === false: per polkadot-api's TxInBestBlocksNotFound, the
        // tx is not currently in the best chain. The `isValid` flag distinguishes
        // the two reasons:
        //   isValid:true  → tx is still in the pool, not yet included (or
        //                   reorged out and waiting to re-include). Normal pre-
        //                   inclusion state — keep waiting.
        //   isValid:false → tx has been rejected by the pool and will never
        //                   include. Probe the best block (in case the chain
        //                   actually included it but a peer disagrees) then
        //                   reject so the retry loop can reissue with a fresh
        //                   nonce. The previous code counted every isValid:true
        //                   event as a "drop" and failed after 5, producing
        //                   spurious `tx dropped from best chain 5 times`
        //                   failures on slow blocks.
        if (event.isValid === false) {
          console.log(`      ${label}: tx rejected by pool (isValid:false), probing the best block...`);
          if (await tryChainFallback()) return;
          settle(reject)(new Error(`${label} tx rejected by pool (isValid:false)`));
        }
      },
      error: (e: any) => {
        const msg = e?.message || String(e).slice(0, 500);
        settle(reject)(new Error(`${label} subscription error: ${friendlyChainError(msg)}`));
      },
    });
  });
}

/**
 * Reconcile-before-resubmit (#1051), decided by chain evidence only (#1641,
 * #1656). Pure, no chain I/O. Three outcomes for a timed-out chunk tx:
 *   - "included": its CID is present at the best block. The only signal that
 *     counts as stored.
 *   - "verify": the account's nonce moved past the chunk's nonce, but its CID
 *     is not at best. The nonce was read from system_accountNextIndex, which
 *     counts pool txs: the chunk's own pending tx, or a sibling deploy's tx on
 *     the same signer (S9), moves it too. So this is a ROUTING signal, never
 *     inclusion: the chunk is marked provisional and the post-batch verify
 *     loop probes it, re-uploading at a fresh nonce if it is absent. Only
 *     meaningful when `nonceHeuristicValid`, false after a pool account
 *     rotation, where the old nonce belongs to another account (#951).
 *   - "resubmit": neither.
 */
export type ReconcileDecision = "included" | "verify" | "resubmit";
export function reconcileTimedOutChunk(opts: {
  originalNonce: number | undefined;
  currentNonce: number;
  nonceHeuristicValid: boolean;
  cidPresentAtBest: boolean | null;
}): ReconcileDecision {
  const { originalNonce, currentNonce, nonceHeuristicValid, cidPresentAtBest } = opts;
  if (cidPresentAtBest === true) return "included";
  if (nonceHeuristicValid && originalNonce !== undefined && originalNonce < currentNonce) return "verify";
  return "resubmit";
}

/**
 * Bounded nonce read for every Bulletin nonce a chunk/root tx is signed with
 * (#1641). system_accountNextIndex is pool-aware, which a shared signer needs
 * (S9: a second deploy must stack above the first one's pending txs), but a
 * load-balanced backend holding a stuck, never-gossiped run reports a future
 * nonce. The first read goes over the deploy's own connection (the backend its
 * txs are submitted to, so its pool view is the one that matters); re-reads
 * use fresh connections (a new backend pick). The floor is the on-chain nonce
 * at the BEST block:
 *   - nextIndex at most `bound` (STUCK_NONCE_GAP_THRESHOLD, the #1640 in-flight
 *     bound) above it is accepted;
 *   - below it (a lagging backend) the on-chain nonce is used;
 *   - further ahead is a stuck backend: re-read on a fresh connection (a new
 *     backend pick), up to `reads` times, then sign from the on-chain nonce.
 * If the on-chain read itself fails, the nextIndex read is used unbounded, as
 * before #1641: correctness never rests on the nonce, every chunk is accepted
 * only on chain evidence, so the worst case is timeouts, not a false success.
 */
export async function readBoundedChunkNonce(deps: {
  readOnchainNonce: () => Promise<number>;
  /** `attempt` is 1-based. */
  readNextIndex: (attempt: number) => Promise<number>;
  bound?: number;
  reads?: number;
  log?: (msg: string) => void;
}): Promise<number> {
  const bound = deps.bound ?? STUCK_NONCE_GAP_THRESHOLD;
  const reads = deps.reads ?? 3;
  const log = deps.log ?? ((m: string) => console.log(m));
  // The on-chain read and the first nextIndex read are independent: run them together.
  const [onchainRes, firstRes] = await Promise.allSettled([
    Promise.resolve().then(deps.readOnchainNonce).then((v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
      return n;
    }),
    Promise.resolve().then(() => deps.readNextIndex(1)),
  ]);
  if (onchainRes.status === "rejected") {
    const e = onchainRes.reason;
    log(`   Could not read the on-chain nonce at best (${String(e?.message ?? e).slice(0, 80)}); using system_accountNextIndex unbounded`);
    if (firstRes.status === "rejected") throw firstRes.reason;
    return Number(firstRes.value);
  }
  const onchain = onchainRes.value;
  const read = (i: number): Promise<number> => i > 1 ? deps.readNextIndex(i)
    : firstRes.status === "fulfilled" ? Promise.resolve(firstRes.value) : Promise.reject(firstRes.reason);
  for (let i = 1; i <= reads; i++) {
    let n: number;
    try {
      n = Number(await read(i));
    } catch (e: any) {
      log(`   system_accountNextIndex read failed (${String(e?.message ?? e).slice(0, 80)}) (${i}/${reads})`);
      continue;
    }
    if (n <= onchain) return onchain;
    if (n - onchain <= bound) return n;
    log(`   system_accountNextIndex ${n} is ${n - onchain} above the on-chain nonce ${onchain} at best (bound ${bound}): stuck backend, re-reading (${i}/${reads})`);
  }
  log(`   No in-bound system_accountNextIndex read; signing from the on-chain nonce ${onchain} at best`);
  return onchain;
}

/**
 * readBoundedChunkNonce bound to a live Bulletin connection. Getters, because
 * the client, api and account change on reconnect and pool rotation. The
 * first nextIndex read goes over the deploy's own connection (the backend its
 * txs are submitted to); re-reads open fresh connections via `fetchNonceFn`.
 * Both reads carry their own ceiling: a stalled-but-open socket would
 * otherwise wait out the 300 s heartbeat.
 */
function boundedNonceReader(p: {
  client: () => any; unsafeApi: () => any; ss58: () => string;
  fetchNonceFn: (rpc: string | string[], ss58: string) => Promise<number>;
}): () => Promise<number> {
  return () => readBoundedChunkNonce({
    readOnchainNonce: async () => Number((await withTimeout<any>(() => p.unsafeApi().query.System.Account.getValue(p.ss58(), { at: "best" }), 10_000, "on-chain nonce read")).nonce),
    readNextIndex: async (attempt: number) => {
      if (attempt === 1) {
        try {
          const n = await withTimeout(() => p.client()._request("system_accountNextIndex", [p.ss58()]), 8_000, "system_accountNextIndex");
          if (typeof n === "number") return n;
        } catch { /* fall back to a fresh connection */ }
      }
      return p.fetchNonceFn(BULLETIN_ENDPOINTS, p.ss58());
    },
  });
}

/** Re-probes the present:null results once and merges the answers by CID. */
async function reprobeUnanswered(results: ChunkProbeResult[], client: any): Promise<ChunkProbeResult[]> {
  const unknown = results.filter(r => r.present === null).map(r => r.cid);
  if (unknown.length === 0) return results;
  const again = new Map((await probeChunks(unknown, { client })).map(r => [r.cid, r]));
  return results.map(r => (r.present === null ? (again.get(r.cid) ?? r) : r));
}

/** #1656/#1657: a chunk's on-chain presence could not be established at the best block. */
export class ChunkInclusionUnverifiedError extends Error {
  constructor(message: string) { super(message); this.name = "ChunkInclusionUnverifiedError"; }
}

/** Best-block presence of one CID, as a watch fallback: true only on a positive probe. */
async function cidPresentAtBest(client: any, cid: string): Promise<boolean> {
  const [probe] = await probeChunks([cid], { client });
  return probe?.present === true;
}

/**
 * Chain-liveness gate (#1051). Polls `getBestBlockNumber` every
 * CHUNK_LIVENESS_POLL_MS until height advances past `lastHeight`, or until
 * `timeoutMs` elapses. Returns the last-observed height either way — never
 * throws. `lastHeight === null` (couldn't determine a baseline) returns
 * immediately without waiting: there's nothing to compare against, so
 * waiting would just delay a resubmit decision for no benefit. A `null`
 * result from `getBestBlockNumber` mid-wait (RPC failure) also returns
 * immediately — fail open toward resubmitting rather than hanging on a dead
 * peer.
 */
async function waitForChainLiveness(client: any, lastHeight: number | null, timeoutMs: number, pollMs: number = CHUNK_LIVENESS_POLL_MS): Promise<number | null> {
  if (lastHeight == null) return getBestBlockNumber(client);
  const deadline = Date.now() + timeoutMs;
  let height: number | null = lastHeight;
  while (Date.now() < deadline) {
    const h = await getBestBlockNumber(client);
    if (h == null) return height;
    height = h;
    if (height > lastHeight) return height;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return height;
}

/** Test-only alias — exported for unit tests that inject a short timeout/poll. */
export const __waitForChainLivenessForTest = waitForChainLiveness;

// `opts.client` is a getter: the caller's client is reassigned on reconnect and destroyed on a WS halt.
async function storeChunk(unsafeApi: any, signer: PolkadotSigner, chunkBytes: Uint8Array, nonce: number, opts: { client?: () => any } = {}): Promise<StoredChunk> {
  const cid = createCID(chunkBytes, CID_CONFIG.codec, CID_CONFIG.hashCode);
  const tx = unsafeApi.tx.TransactionStorage.store_with_cid_config({ cid: { codec: BigInt(CID_CONFIG.codec), hashing: toHashingEnum(CID_CONFIG.hashCode) }, data: chunkBytes });
  const txOpts = { mortality: { mortal: true, period: CHUNK_MORTALITY_PERIOD }, nonce };
  const { value, viaFallback, receipt } = await watchTransaction(tx, signer, txOpts, () => {
    console.log(`      CID: ${cid.toString()}`);
    return { cid, len: chunkBytes.length };
  }, { label: `chunk(nonce:${nonce})`, timeoutMs: CHUNK_TIMEOUT_MS, confirmIncluded: opts.client ? () => cidPresentAtBest(opts.client!(), cid.toString()) : undefined });
  return { ...value, viaFallback, receipt };
}

// Per-call hash-algorithm override. Defaults to `CID_CONFIG.hashCode` (sha-256,
// 0x12) to preserve the existing CIDs of every consumer that already pinned a
// deploy.
export async function storeFile(
  contentBytes: Uint8Array,
  {
    client: existingClient,
    unsafeApi: existingApi,
    signer: existingSigner,
    hashCode = CID_CONFIG.hashCode,
  }: ExistingProvider & { hashCode?: number } = {},
): Promise<string> {
  console.log(`\n   Size: ${(contentBytes.length / 1024).toFixed(2)} KB`);
  if (contentBytes.length > MAX_FILE_SIZE) throw new Error(`File exceeds 8MB limit. Use chunked deployment.`);
  const cid = createCID(contentBytes, CID_CONFIG.codec, hashCode);
  console.log(`   CID: ${cid.toString()}`);
  let client: any, unsafeApi: any, signer: PolkadotSigner | undefined;
  if (existingClient) {
    client = existingClient; unsafeApi = existingApi; signer = existingSigner;
  } else {
    const provider = await getProvider();
    client = provider.client; unsafeApi = provider.unsafeApi; signer = provider.signer;
  }
  try {
    // Probe chain first — if these exact bytes are already stored, skip the
    // upload entirely. We tried `TransactionStorage.renew` here to also
    // extend the lease, but paseo-next-v2's runtime rejects double-renew of
    // an entry already renewed in the current retention window with
    // `Invalid(Custom 11)` regardless of whether the entry is addressed by
    // Position or ContentHash. Skipping matches the existing root-store
    // behaviour in storeChunkedContent (which has always opportunistically
    // skipped when the root probe came back present). Probe failures
    // (`present === null`) fall through to the store path.
    const [probe] = await probeChunks([cid.toString()], { client });
    if (probe.present === true) {
      console.log(`   Already on chain (block ${probe.block}, index ${probe.index}) — skipping upload.\n`);
      if (!existingClient) client.destroy();
      return cid.toString();
    }
    const tx = unsafeApi.tx.TransactionStorage.store_with_cid_config({ cid: { codec: BigInt(CID_CONFIG.codec), hashing: toHashingEnum(hashCode) }, data: contentBytes });
    const txOpts = { mortality: { mortal: true, period: 256 } };
    console.log(`   Submitting...`);
    const { value } = await watchTransaction(tx, signer!, txOpts, (event: any) => {
      console.log(`   Block: ${event?.block?.hash ?? "confirmed"}\n`);
      return cid.toString();
    }, { label: "storeFile" });
    if (!existingClient) client.destroy();
    return value;
  } catch (e) { if (!existingClient) client.destroy(); throw e; }
}

/**
 * Pre-compute dense nonces for chunks that need submission.
 * Chunks where stored[i] !== null are already on chain (skipped via skipCids or
 * prior reconnect logic) and consume zero nonce slots.
 * Exported under a test-only alias so unit tests can verify the dense property
 * without touching the real chain.
 */
function assignDenseNonces(stored: (StoredChunk | null)[], startNonce: number): Map<number, number> {
  const nonces = new Map<number, number>();
  let counter = 0;
  for (let i = 0; i < stored.length; i++) {
    if (stored[i] === null) {
      nonces.set(i, startNonce + counter);
      counter++;
    }
  }
  return nonces;
}

export const __assignDenseNoncesForTest = assignDenseNonces;

export async function storeChunkedContent(chunks: Uint8Array[], { client: existingClient, unsafeApi: existingApi, signer: existingSigner, ss58: existingSS58, reconnect, fetchNonce: fetchNonceOverride, skipCids, probeFailedCids, gateway: providerGateway, trustedCids, skipRootStore, handOffLiveClient }: ExistingProvider = {}): Promise<{ storageCid: string; tier2Verified: number; tier2Inconclusive: number; tier2Fallback: number; liveProvider: ExistingProvider; skipProbeResults: Map<string, true | false | null>; rootSkipped: boolean }> {
  const _fetchNonce = fetchNonceOverride ?? fetchNonce;
  console.log(`\n   Data chunks: ${chunks.length}`);
  const totalBytes = chunks.reduce((s: number, c: Uint8Array) => s + c.length, 0);
  console.log(`   Total: ${(totalBytes / 1024).toFixed(2)} KB`);

  let client: any, unsafeApi: any, signer: PolkadotSigner | undefined, ss58: string | undefined;
  let ownsClient = false;
  if (existingClient) {
    client = existingClient; unsafeApi = existingApi; signer = existingSigner;
    ss58 = existingSS58;
  } else {
    const provider = await getProvider();
    client = provider.client; unsafeApi = provider.unsafeApi; signer = provider.signer;
    ss58 = provider.ss58;
    ownsClient = true;
  }

  const refreshExistingClient = async (reason: string) => {
    if (!reconnect) return false;
    console.log(`\n   Connection lost (${reason}), reconnecting...`);
    const fresh = await reconnect();
    client = fresh.client; unsafeApi = fresh.unsafeApi; signer = fresh.signer; ss58 = fresh.ss58;
    ownsClient = true;
    return true;
  };

  // If an existing client is provided it may have been destroyed by a prior
  // storeChunkedContent call's wsHaltCallback (e.g. when storeDirectoryV2
  // passes the same provider to phase B after phase A reconnected). Probe
  // it with a lightweight query and silently refresh via reconnect() if dead.
  if (existingClient && reconnect) {
    try {
      await unsafeApi.query.System.Number.getValue();
    } catch (e: any) {
      if (isConnectionError(e)) {
        await refreshExistingClient("stale client detected by pre-upload probe");
      } else { throw e; }
    }
  }

  // Verify authorization is active before starting the upload. Sufficiency is
  // existence + non-expiry ONLY — we do NOT gate on the txs/bytes allowance
  // counters. The Bulletin `store` extrinsic uses soft limits, so an authorized,
  // unexpired account stores fine even with exhausted/zeroed quota counters
  // (the allowance fields are no longer the gate; an exhausted-but-unexpired
  // account is warned about below — bulletin #1547 — not blocked). Deploy no
  // longer self-authorizes (#745); fail fast if there is no active authorization —
  // it must be granted out-of-band (testnet faucet / personhood / pool bootstrap).
  //
  // Arm order matters: the raw papi read can throw *synchronously* on a destroyed
  // client, so it goes first — readAccountAuthorization only rejects. Reversed, that
  // sync throw would orphan the in-flight auth read as an unhandled rejection.
  const readUploadAuthorization = () => Promise.all([
    unsafeApi.query.System.Number.getValue(),
    readAccountAuthorization(unsafeApi, ss58 as string),
  ]);
  let uploadAuth: BulletinAuthorization | null = null;
  let currentBlockNum = 0;
  try {
    [currentBlockNum, uploadAuth] = await readUploadAuthorization();
  } catch (e: any) {
    if (existingClient && reconnect && isConnectionError(e)) {
      await refreshExistingClient("authorization preflight hit a stale chainHead");
      [currentBlockNum, uploadAuth] = await readUploadAuthorization();
    } else {
      throw e;
    }
  }
  const sufficient = isAuthorizationSufficient(uploadAuth, currentBlockNum);
  if (!sufficient) {
    throw new NonRetryableError(`Account ${ss58} has no active Bulletin authorization (missing or expired). Request authorization on-chain (testnet faucet / personhood / pool bootstrap), then retry.`);
  }

  // bulletin #1547 (check/warn half only): existence+expiry alone doesn't mean full
  // priority — an unexpired account can still be out of transaction/byte quota, which
  // drops it behind accounts that have headroom (never a store failure, only a priority
  // loss; see quotaHeadroomDimensions' comment in pool.ts). Now that chunks are known,
  // size the real need (one tx per chunk; total bytes as an upper bound) and warn.
  // polkadot-app-deploy never self-authorizes Bulletin storage, so unlike bulletin-deploy
  // this never re-grants — reuses uploadAuth/currentBlockNum read just above instead of a
  // second RPC round trip.
  const authResult = await ensureAuthorized(unsafeApi, ss58 as string, "storage account", {
    needs: { transactions: chunks.length, bytes: BigInt(totalBytes) },
    precheckedAuth: { auth: uploadAuth, currentBlock: currentBlockNum },
    network: bulletinNetwork,
  });
  if (authResult.quotaExhausted) {
    console.warn(
      `   Warning: Bulletin storage account ${ss58}'s allowance is exhausted (${authResult.dimensions.join("/")}). ` +
      `polkadot-app-deploy does not auto-reauthorize, so uploads are BEST EFFORT — queued behind accounts that still have quota.`,
    );
  }

  let reconnectionsUsed = 0;
  // Sliding window of recovery-attempt timestamps (#216). Each chunk retry
  // and each reconnect appends; if more than RETRY_BUDGET_MAX_EVENTS land
  // within RETRY_BUDGET_WINDOW_MS, we bail to bound peak in-flight bytes
  // before GC falls behind. See retryBudgetExhausted() above.
  const recoveryHistory: number[] = [];
  const recordRecoveryAndCheckBudget = (kind: string): void => {
    const now = Date.now();
    recoveryHistory.push(now);
    if (retryBudgetExhausted(recoveryHistory, RETRY_BUDGET_MAX_EVENTS, RETRY_BUDGET_WINDOW_MS, now)) {
      captureWarning("Retry budget exhausted", {
        kind,
        events: recoveryHistory.length,
        maxEvents: RETRY_BUDGET_MAX_EVENTS,
        windowMs: RETRY_BUDGET_WINDOW_MS,
      });
      throw new Error(
        `Retry budget exhausted: more than ${RETRY_BUDGET_MAX_EVENTS} recovery attempts ` +
        `within ${Math.round(RETRY_BUDGET_WINDOW_MS / 1000)}s. Chain RPC is unstable; bailing to bound peak memory.`,
      );
    }
  };

  async function doReconnect(): Promise<void> {
    if (!reconnect || reconnectionsUsed >= MAX_RECONNECTIONS) {
      throw new Error(`Connection lost and max reconnections (${MAX_RECONNECTIONS}) exhausted`);
    }
    recordRecoveryAndCheckBudget("reconnect");
    reconnectionsUsed++;
    setDeployAttribute("deploy.reconnects", reconnectionsUsed);
    const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, reconnectionsUsed - 1), RETRY_MAX_DELAY_MS);
    console.log(`\n   Connection lost, reconnecting to Bulletin in ${(delay / 1000).toFixed(0)}s (${reconnectionsUsed}/${MAX_RECONNECTIONS})...`);
    captureWarning("WebSocket connection lost, reconnecting", { reconnection: reconnectionsUsed, maxReconnections: MAX_RECONNECTIONS });
    // Peak-during-reconnect answers whether destroyed clients release or pile.
    sampleMemory(`reconnect_${reconnectionsUsed}_before`);
    try { client.destroy(); } catch {}
    await new Promise(r => setTimeout(r, delay));
    const fresh = await reconnect();
    client = fresh.client; unsafeApi = fresh.unsafeApi; signer = fresh.signer; ss58 = fresh.ss58;
    wsHaltDetected = false;
    ownsClient = true;
    sampleMemory(`reconnect_${reconnectionsUsed}_after`);
  }

  // Register a synchronous WS-halt callback. When the underlying WsProvider
  // sees a CLOSE or ERROR event, the callback destroys the current client
  // immediately, BEFORE PAPI's auto-reconnect path runs its leaky
  // `activeBroadcasts.forEach` loop (issue #287 — that forEach mutates the
  // Map it iterates, generating thousands of 4 MB transaction-broadcast
  // strings until OOM). client.destroy() sets PAPI's state.type to 2 (Done)
  // which short-circuits the forEach's `if (state.type === 0)` guard, so
  // even if a microtask queued a forEach iteration, no more allocations
  // happen. Also flips a flag so the chunk-upload loop runs doReconnect
  // proactively even if the halt landed in the gap between batches (where
  // no chunk submission would error to trigger it via the retry path).
  let wsHaltDetected = false;
  setWsHaltCallback(() => {
    wsHaltDetected = true;
    try { client.destroy(); } catch { /* already destroyed; safe */ }
  });

  // Every nonce a chunk/root tx is signed with is bounded by the on-chain
  // nonce at best (#1641). Reads the CURRENT client/account: both change on
  // reconnect and pool rotation.
  const readChunkNonce = boundedNonceReader({ client: () => client, unsafeApi: () => unsafeApi, ss58: () => ss58 as string, fetchNonceFn: _fetchNonce });
  // storeChunk's best-block probe must follow `client` across reconnects.
  const chunkOpts = { client: () => client };

  try {

    let startNonce = await readChunkNonce();
    console.log(`   Starting nonce: ${startNonce}`);
    // Two-mode batching (#216 d): start with 2 in flight to amortise round-
    // trip latency, but drop to 1 once we've burned a reconnect — halves
    // peak in-flight bytes during the recovery path, where buffer pressure
    // is the actual failure mode.
    const BATCH_SIZE_INITIAL = 2;
    const BATCH_SIZE_RECOVERY = 1;
    const MAX_CHUNK_RETRIES = 3;
    const MAX_REPROBE_RETRIES = 3;
    console.log(`\n   Submitting ${chunks.length} data chunks in batches of up to ${BATCH_SIZE_INITIAL}...`);
    const stored: (StoredChunk | null)[] = new Array(chunks.length).fill(null);

    // Incremental upload (v2): pre-mark already-present chunks as stored so the
    // batching loop below skips them. The chain doesn't dedup store_with_cid_config,
    // so submitting an already-stored chunk would waste a tx slot + bytes — the
    // gateway probe gives us the answer for free. (block, tx_index) for skipped
    // chunks is unknown without a chain query (Task 8 follow-up); for v1 we mark
    // viaFallback:true and the manifest's `chunks` map is sentinel-only.
    let tier2Verified = 0;
    let tier2Inconclusive = 0;
    let tier2Fallback = 0;
    // Per-CID probe outcomes from the internal skipCids probe. Returned to
    // callers (e.g. storeDirectoryV2) that need per-chunk results for manifest
    // construction without running a separate external probe round.
    const skipProbeResults = new Map<string, true | false | null>();
    // Every chunk stored on anything but a watch event: probe-confirmed
    // (viaFallback) or provisional. The post-batch verify loop is the only
    // way out of this set, and the only way storeChunkedContent can return.
    const nonceAdvanceIndices = new Set<number>();
    const markProvisional = (idx: number): void => {
      stored[idx] = { cid: createCID(chunks[idx], CID_CONFIG.codec, 0x12), len: chunks[idx].length, viaFallback: true };
      nonceAdvanceIndices.add(idx);
    };
    // Best-block probe that never lets present:null pass (#1657). A null after
    // a WS halt is a dead socket, not an unknown chunk: reconnect (whose own
    // exhaustion message is what S8's storm accepts) and ask again. Returns
    // the absent results; throws ChunkInclusionUnverifiedError when a chunk
    // stays unanswered after MAX_REPROBE_RETRIES re-probes.
    const probeAtBestUntilAnswered = async (cids: string[]): Promise<{ cid: string }[]> => {
      let results = await probeChunks(cids, { client });
      for (let attempt = 1; results.some(r => r.present === null); attempt++) {
        const unknown = results.filter(r => r.present === null);
        const reason = (unknown[0] as { failureReason?: string }).failureReason ?? "unknown";
        if (attempt > MAX_REPROBE_RETRIES) {
          const unknownCids = new Set(unknown.map(r => r.cid));
          const idxs = chunkCidsComputed.flatMap((c, i) => (unknownCids.has(c.toString()) ? [i + 1] : []));
          throw new ChunkInclusionUnverifiedError(
            `Could not verify that chunk ${idxs.join(", ")} is stored on-chain: the TransactionByContentHash probe at the best ` +
            `block gave no answer ${MAX_REPROBE_RETRIES + 1} times (${reason}). Not treating it as stored. Check the Bulletin RPC ` +
            `(${BULLETIN_ENDPOINTS[0]}) and re-run the deploy; chunks already on-chain are skipped.`,
          );
        }
        if (wsHaltDetected && reconnect) {
          // Throws the existing "max reconnections exhausted" error once the budget is spent.
          wsHaltDetected = false;
          await doReconnect();
        } else {
          await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS));
        }
        console.log(`   ${unknown.length} chunk probe(s) unanswered (${reason}), re-probing (${attempt}/${MAX_REPROBE_RETRIES})`);
        results = await reprobeUnanswered(results, client);
      }
      return results.filter(r => r.present === false);
    };

    // Single pass to compute CIDs and handle both trustedCids (no-reprobe skip)
    // and skipCids (reprobe before skip) in one chunk iteration.
    const chunkCidsComputed: ReturnType<typeof createCID>[] = new Array(chunks.length);
    let trustedCount = 0;
    const trustedIndices: number[] = [];
    const skipCidsCandidates: { index: number; cid: ReturnType<typeof createCID> }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const cid = createCID(chunks[i], CID_CONFIG.codec, 0x12);
      chunkCidsComputed[i] = cid;
      const cidStr = cid.toString();
      // trustedCids: skip without re-probing. Caller vouches these CIDs were
      // verified or uploaded in this same deploy session, so eviction within
      // the session window is negligible.
      if (trustedCids?.has(cidStr)) {
        stored[i] = { cid, len: chunks[i].length, viaFallback: true };
        trustedCount++;
        trustedIndices.push(i + 1);
      } else if (skipCids?.has(cidStr)) {
        skipCidsCandidates.push({ index: i, cid });
      }
    }
    if (trustedCount > 0) {
      const indicesStr = trustedIndices.length > 10
        ? `${trustedIndices.slice(0, 5).join(", ")}, …, ${trustedIndices.slice(-3).join(", ")}`
        : trustedIndices.join(", ");
      console.log(`   Trusted: ${trustedCount} chunks skipped without re-probe (chunks ${indicesStr})`);
    }

    if (skipCidsCandidates.length > 0) {
      const cidStrings = skipCidsCandidates.map(c => c.cid.toString());
      // One re-probe for unanswered CIDs (as probeFinalityGap does) before
      // falling back to uploading them.
      const probeResults = await reprobeUnanswered(await probeChunks(cidStrings, { client }), client);
      const probeResultMap = new Map(probeResults.map(r => [r.cid, r.present]));
      for (const r of probeResults) skipProbeResults.set(r.cid, r.present);

      let confirmedCount = 0;
      for (const { index: i, cid } of skipCidsCandidates) {
        const cidStr = cid.toString();
        const present = probeResultMap.get(cidStr) ?? null;
        if (present === true) {
          // Only a positive answer skips the upload (#1657). An unanswered
          // probe is not evidence, so that chunk is uploaded like an absent
          // one: a duplicate store is harmless, a missing chunk is not.
          stored[i] = { cid, len: chunks[i].length, viaFallback: true };
          confirmedCount++;
          tier2Verified++;
        } else if (present === null) {
          tier2Inconclusive++;
        } else {
          tier2Fallback++;
        }
      }
      console.log(`   Cache check: ${confirmedCount} confirmed, ${tier2Fallback} missing${tier2Inconclusive > 0 ? `, ${tier2Inconclusive} unanswered` : ""}${tier2Fallback + tier2Inconclusive > 0 ? " (will upload)" : ""}`);
    }

    // Pre-compute dense nonces: skipped chunks consume zero nonce slots, so the
    // actually-submitted chunks receive consecutive nonces startNonce..N.
    // Re-running assignDenseNonces after reconnect (see doReconnectAndRebase below)
    // is necessary when the pool rotates to a different account (ss58 changes):
    // old-account nonces are invalid on the new account. `let` because the rebase
    // reassigns this map on rotation.
    let assignedNonces = assignDenseNonces(stored, startNonce);

    // Reconnect and rebase dense nonces if the pool rotated to a different account.
    // Returns { changed: bool, currentNonce: number }.
    //   changed=true  → ss58 changed; assignedNonces has been rebased to the new
    //                   account's nonce base. Callers must skip the "nonce consumed →
    //                   included" heuristic — old-account nonce values are meaningless
    //                   on the new account (the #951 false-positive).
    //   changed=false → same-account reconnect; behaviour unchanged (heuristic valid).
    // #946 sites (nonce-collision re-upload, root-node reconnect) keep calling
    // doReconnect() directly — they do not read assignedNonces so no rebase needed.
    const doReconnectAndRebase = async (): Promise<{ changed: boolean; currentNonce: number }> => {
      const prevSS58 = ss58;
      await doReconnect();
      const currentNonce = await readChunkNonce();
      const changed = ss58 !== prevSS58;
      if (changed) {
        assignedNonces = assignDenseNonces(stored, currentNonce);
        startNonce = currentNonce;
      }
      return { changed, currentNonce };
    };

    // Upload-pass numerator: how many chunks we will actually submit. The
    // reconnect path only re-tries existing stored[]===null entries; it never
    // introduces new ones, so this value is stable across reconnects.
    const uploadTotal = stored.filter((s) => s === null).length;
    // uploadEmittedIndices tracks which chunk indices have already been counted
    // in the [N/M] progress line. On connection-error retries the same chunk
    // index re-enters the batch loop — without this guard uploadEmitted would
    // exceed uploadTotal (e.g. [3/2], [4/2] …) (#932).
    const uploadEmittedIndices = new Set<number>();
    let uploadEmitted = 0;

    // E2E-only (#1672): hold here, seed read and nothing submitted yet, until the
    // sibling deploy has seeded too. A no-op unless its env var is set.
    if (uploadTotal > 0) await e2eNonceSeedBarrier(startNonce);

    let b = 0;
    while (b < chunks.length) {
      // If the WS halt callback fired since the last batch, the current
      // client was destroyed but no chunk error triggered doReconnect (the
      // halt landed in the gap between batches). Build a fresh client now
      // before submitting any chunks against the destroyed one.
      if (wsHaltDetected && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
        wsHaltDetected = false;
        // doReconnectAndRebase (not bare doReconnect): this guard runs *before*
        // the assignedNonces submission loop below, so a pool-account rotation
        // here must rebase assignedNonces to the new account's nonce base —
        // else chunks submit with stale old-account nonces (isValid:false), which
        // is not a connection error so the per-failure retry never reconnects and
        // the consumed-heuristic false-"includes" never-stored chunks (#32).
        // Return value unused: no in-flight chunks at the loop top, only the rebase matters.
        await doReconnectAndRebase();
      }
      const batchSize = reconnectionsUsed > 0 ? BATCH_SIZE_RECOVERY : BATCH_SIZE_INITIAL;
      // Only submit chunks that haven't been stored yet (relevant after reconnection)
      const batchIndices: number[] = [];
      const batchChunks: Uint8Array[] = [];
      for (let j = 0; j < batchSize && b + j < chunks.length; j++) {
        const i = b + j;
        if (stored[i] === null) { batchIndices.push(i); batchChunks.push(chunks[i]); }
      }
      if (batchIndices.length === 0) { b += batchSize; continue; }

      const batchPromises = batchChunks.map((chunkData: Uint8Array, j: number) => {
        const i = batchIndices[j];
        const nonce = assignedNonces.get(i)!;
        const isRetry = uploadEmittedIndices.has(i);
        if (!isRetry) { uploadEmittedIndices.add(i); uploadEmitted++; }
        console.log(`   [${uploadEmitted}/${uploadTotal}] chunk ${i + 1} — ${(chunkData.length / 1024 / 1024).toFixed(2)} MB (nonce: ${nonce})${isRetry ? " (retry)" : ""}`);
        return storeChunk(unsafeApi, signer as PolkadotSigner, chunkData, nonce, chunkOpts);
      });

      const results = await Promise.allSettled(batchPromises);

      results.forEach((r: PromiseSettledResult<StoredChunk>, j: number) => {
        if (r.status === "fulfilled") {
          stored[batchIndices[j]] = r.value;
          assignedNonces.delete(batchIndices[j]);
          if (r.value.viaFallback) nonceAdvanceIndices.add(batchIndices[j]);
          // progress resets the recovery budget — a landed chunk means recovery is
          // healthy, not thrashing (the budget guards no-progress thrashing only). #864
          recoveryHistory.length = 0;
        }
      });

      const failures = results
        .map((r: PromiseSettledResult<StoredChunk>, j: number) => r.status === "rejected" ? { index: batchIndices[j], chunkData: batchChunks[j], error: (r as PromiseRejectedResult).reason } : null)
        .filter(Boolean) as { index: number; chunkData: Uint8Array; error: any }[];

      // Reconnect only when the WebSocket subscription itself failed (the
      // observable's `error` channel fires for connection-level problems).
      // Tx-level rejections (isValid:false from the pool, dispatch errors,
      // timeouts that fell back to nonce-advance) do NOT need a reconnect —
      // the WS is healthy, the retry path will reissue with a fresh nonce.
      const needsReconnect = failures.some(f => isConnectionError(f.error));
      if (needsReconnect && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
        const { changed, currentNonce } = await doReconnectAndRebase();
        // "nonce consumed" routing: only valid when the account did NOT change.
        // On rotation the old assignedNonce baseline belongs to a different
        // account (#951). A consumed nonce is NOT inclusion (the pool view
        // counts pending txs, #1656): the chunk goes provisional and the
        // post-batch verify loop probes it, re-uploading it if absent.
        if (!changed) {
          for (const idx of batchIndices) {
            const chunkNonce = assignedNonces.get(idx);
            if (chunkNonce !== undefined && chunkNonce < currentNonce && stored[idx] === null) {
              console.log(`   Chunk ${idx + 1}: nonce ${chunkNonce} consumed (current=${currentNonce}), pending on-chain verification`);
              markProvisional(idx);
              assignedNonces.delete(idx);
            }
          }
          startNonce = Math.max(startNonce, currentNonce);
        }
        if (failures.some(f => stored[f.index] === null)) {
          // Some chunks still missing post-reconnect — retry the same batch
          // (with a possibly smaller batchSize on the next iteration since
          // reconnectionsUsed has just incremented).
          continue;
        }
      }

      for (const fail of failures) {
        if (stored[fail.index] !== null) {
          continue;
        }
        // isValid:false backstop: if the initial failure was a pool rejection AND
        // the chunk's CID was probe-failed (present:null), the chunk is probably
        // already on chain. Stop burning retries on a tx the chain will keep
        // rejecting, but "probably" is not evidence: it goes provisional and the
        // post-batch verify loop must find it at best (or re-upload it).
        const failCid = createCID(fail.chunkData, CID_CONFIG.codec, 0x12);
        if (
          probeFailedCids &&
          probeFailedCids.has(failCid.toString()) &&
          fail.error?.message?.includes("isValid:false")
        ) {
          console.log(`   Chunk ${fail.index + 1}: isValid:false but CID was probe-failed — pending on-chain verification`);
          captureWarning("isValid:false deferred to verification (probe-failed backstop)", { chunkIndex: fail.index + 1, cid: failCid.toString() });
          markProvisional(fail.index);
          continue;
        }
        captureWarning("Chunk upload failed, retrying", { chunkIndex: fail.index + 1, maxRetries: MAX_CHUNK_RETRIES, error: fail.error?.message?.slice(0, 200) });
        const isExpiryFailure = fail.error?.message?.includes("isValid:false");
        if (isExpiryFailure) {
          console.log(`   Chunk ${fail.index + 1}: tx rejected (isValid:false), likely mortal era expiry — reissuing with fresh nonce`);
        }
        let retried = false;
        for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
          recordRecoveryAndCheckBudget("chunk_retry");
          const retryDelay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
          console.log(`   Retrying chunk ${fail.index + 1} (attempt ${attempt}/${MAX_CHUNK_RETRIES}) in ${(retryDelay / 1000).toFixed(0)}s...`);
          await new Promise(r => setTimeout(r, retryDelay));
          // If this was a connection error, reconnect before retrying.
          // Use doReconnectAndRebase so that a pool account rotation (new ss58)
          // rebases assignedNonces to the new account's nonce base — preventing
          // stale old-account nonces from being submitted on the new account (#951).
          let perRetryChanged = false;
          if (isConnectionError(fail.error) && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
            try {
              ({ changed: perRetryChanged } = await doReconnectAndRebase());
            } catch (reconnectErr: any) {
              console.log(`   Reconnect failed: ${reconnectErr.message?.slice(0, 80)}`);
              break;
            }
          }
          try {
            const currentNonce = await readChunkNonce();
            const originalNonce = assignedNonces.get(fail.index);
            // Reconcile before resubmit (#1051): probe the chunk's own CID at
            // best-block in addition to the nonce heuristic below. Probe
            // failures/absence (present !== true) are non-fatal — fall
            // through to the nonce check, then to a real resubmit.
            let cidPresentAtBest: boolean | null = null;
            try {
              const [probe] = await probeChunks([failCid.toString()], { client });
              cidPresentAtBest = probe.present === true ? true : null;
            } catch { /* probe errors are non-fatal — treat as indeterminate */ }
            // "nonce consumed → included" heuristic: only valid on same account.
            // On rotation, originalNonce is the new account's rebased value and
            // the comparison is not meaningful until the new account actually
            // advances its nonce (#951).
            const decision = reconcileTimedOutChunk({ originalNonce, currentNonce, nonceHeuristicValid: !perRetryChanged, cidPresentAtBest });
            if (decision !== "resubmit") {
              if (decision === "included") {
                console.log(`   Chunk ${fail.index + 1}: reconcile found its CID at the best block — skipping resubmit`);
                stored[fail.index] = { cid: failCid, len: fail.chunkData.length, viaFallback: true };
                nonceAdvanceIndices.add(fail.index);
              } else {
                console.log(`   Chunk ${fail.index + 1}: nonce ${originalNonce} consumed (current=${currentNonce}) but its CID is not at the best block — pending on-chain verification`);
                markProvisional(fail.index);
              }
              assignedNonces.delete(fail.index);
              // progress resets the recovery budget — a landed chunk means recovery is
              // healthy, not thrashing (the budget guards no-progress thrashing only). #864
              recoveryHistory.length = 0;
              retried = true;
              break;
            }
            // Gate resubmit on chain liveness (#1051): a resubmit into a
            // frozen chain just piles up a same-nonce collision once it
            // resumes. Wait (bounded) for a new best-block before spending
            // this attempt on a resubmit; fails open (proceeds immediately)
            // if height can't be determined at all.
            const heightBefore = await getBestBlockNumber(client);
            const heightAfter = await waitForChainLiveness(client, heightBefore, CHUNK_LIVENESS_MAX_WAIT_MS);
            if (heightBefore != null && heightAfter != null && heightAfter <= heightBefore) {
              console.log(`   Chunk ${fail.index + 1}: chain still frozen at block ${heightBefore} after ${(CHUNK_LIVENESS_MAX_WAIT_MS / 1000).toFixed(0)}s wait — resubmitting anyway`);
            }
            const retryNonce = originalNonce ?? currentNonce;
            const result = await storeChunk(unsafeApi, signer as PolkadotSigner, fail.chunkData, retryNonce, chunkOpts);
            stored[fail.index] = result;
            if (result.viaFallback) nonceAdvanceIndices.add(fail.index);
            assignedNonces.delete(fail.index);
            // progress resets the recovery budget — a landed chunk means recovery is
            // healthy, not thrashing (the budget guards no-progress thrashing only). #864
            recoveryHistory.length = 0;
            retried = true;
            break;
          } catch (e: any) {
            // isValid:false backstop for retries: same logic as initial-failure path.
            if (
              probeFailedCids &&
              probeFailedCids.has(failCid.toString()) &&
              e?.message?.includes("isValid:false")
            ) {
              console.log(`   Chunk ${fail.index + 1}: retry isValid:false but CID was probe-failed — pending on-chain verification`);
              captureWarning("isValid:false retry deferred to verification (probe-failed backstop)", { chunkIndex: fail.index + 1, cid: failCid.toString(), attempt });
              markProvisional(fail.index);
              assignedNonces.delete(fail.index);
              retried = true;
              break;
            }
            captureWarning("Chunk retry failed", { chunkIndex: fail.index + 1, attempt, maxRetries: MAX_CHUNK_RETRIES, error: e.message?.slice(0, 200) });
            console.log(`   Retry ${attempt} failed: ${e.message?.slice(0, 80)}`);
            // If retry also failed with connection error, try reconnecting on next attempt
            if (isConnectionError(e) && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
              try { await doReconnect(); } catch {}
            }
          }
        }
        if (!retried) {
          // When all reconnect slots are exhausted and the chunk failure is a
          // connection error, surface the root cause rather than wrapping it as
          // a chunk error (the reconnection budget, not the chunk, is the limit).
          if (isConnectionError(fail.error) && reconnectionsUsed >= MAX_RECONNECTIONS) {
            throw new Error(`Connection lost and max reconnections (${MAX_RECONNECTIONS}) exhausted`);
          }
          throw new Error(`Chunk ${fail.index + 1} failed after ${MAX_CHUNK_RETRIES} retries: ${fail.error?.message?.slice(0, 100)}`);
        }
      }
      b += batchSize;
    }

    // Post-batch verify loop (#1656, #1657): the one gate between a chunk
    // that was not confirmed by a watch event and a successful return. Probes
    // at the BEST block (never finalized: a lagging GRANDPA head is not
    // absence, #1049). present:true is the only accept; present:false is
    // re-uploaded at a fresh bounded nonce and probed again next round;
    // present:null is retried, then fails by name. Bounded: at most
    // MAX_REPROBE_RETRIES re-upload rounds, then one last probe round.
    if (nonceAdvanceIndices.size > 0) {
      setDeployAttribute("deploy.pool.nonce_collision_count", nonceAdvanceIndices.size);
      const pending = new Set(nonceAdvanceIndices);
      let reuploadCount = 0;
      for (let round = 1; pending.size > 0; round++) {
        const cidToIndex = new Map([...pending].map(i => [(stored[i] as StoredChunk).cid.toString(), i]));
        const missingResults = await probeAtBestUntilAnswered([...cidToIndex.keys()]);
        const missingCids = new Set(missingResults.map(m => m.cid));
        for (const [cid, idx] of cidToIndex) if (!missingCids.has(cid)) pending.delete(idx);
        // First round only: how many chunks the batch left absent at best.
        if (round === 1) setDeployAttribute("deploy.pool.nonce_collision_missing", missingResults.length);
        if (missingResults.length === 0) break;
        if (round > MAX_REPROBE_RETRIES) {
          throw new ChunkInclusionUnverifiedError(
            `Chunk ${missingResults.map(m => cidToIndex.get(m.cid)! + 1).join(", ")} still absent at the best block after ` +
            `${MAX_REPROBE_RETRIES} re-upload rounds; not treating it as stored. The Bulletin chain is accepting the account's ` +
            `txs but not including this chunk: check the account's pending queue and re-run the deploy.`,
          );
        }
        captureWarning("nonce-advance collision: re-uploading missing chunks", {
          collision_count: missingResults.length,
        });

        // A WS halt between the batch loop and here leaves the client destroyed
        // with no chunk error to trigger doReconnect; rebuild before re-uploading
        // (mirrors the proactive guard at the top of the batch loop, ~L932). #946
        if (wsHaltDetected && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
          wsHaltDetected = false;
          await doReconnect();
        }

        for (const m of missingResults) {
          const idx = cidToIndex.get(m.cid)!;
          for (let attempt = 1; attempt <= MAX_REPROBE_RETRIES; attempt++) {
            console.log(`   Nonce-collision re-upload: chunk ${idx + 1} (attempt ${attempt}/${MAX_REPROBE_RETRIES})`);
            let freshNonce: number | undefined;
            try {
              freshNonce = await readChunkNonce();
              const result = await storeChunk(unsafeApi, signer as PolkadotSigner, chunks[idx], freshNonce, chunkOpts);
              // A watch event in a best block is evidence; a probe-confirmed
              // result is re-verified next round.
              stored[idx] = result;
              if (!result.viaFallback) pending.delete(idx);
              reuploadCount++;
              break;
            } catch (e: any) {
              // ChainHead disjointed / WS drop: rebuild the client (rebinds
              // unsafeApi/signer/ss58) and retry the remaining attempts against
              // it, instead of re-running every attempt on the dead client —
              // matches the batch-retry and root-store loops. #946
              if (isConnectionError(e) && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
                try { await doReconnect(); } catch { /* fall through to retry / final-attempt throw */ }
              } else if (isNonceCollisionError(e)) {
                // The sibling deploy took the nonce again (#1672). Back off by a random
                // offset; once this round's attempts are spent the chunk stays pending
                // and the next verify round probes and re-uploads it (bounded by rounds).
                const last = attempt === MAX_REPROBE_RETRIES;
                console.log(`   Chunk ${idx + 1}: re-upload nonce ${freshNonce} collided${last ? `; left for the next verify round` : ", retrying"}`);
                await new Promise(r => setTimeout(r, nonceCollisionBackoffMs()));
                continue;
              }
              if (attempt === MAX_REPROBE_RETRIES) {
                // twin: upstream throws chunkFailureError here (structural InvalidTransaction variant), which this repo has not taken.
                throw new Error(`Nonce-collision re-upload of chunk ${idx + 1} failed after ${MAX_REPROBE_RETRIES} attempts: ${e.message?.slice(0, 100)}`);
              }
            }
          }
        }
      }
      setDeployAttribute("deploy.pool.nonce_collision_reupload_count", reuploadCount);
    }

    setDeployAttribute("deploy.pool.account", truncateAddress(ss58) as string);

    console.log("\n   " + formatUploadInclusionLine(chunks.length, uploadTotal));

    // Verify chunk integrity before building DAG
    console.log(`   Verifying chunk integrity...`);
    const missing = stored.map((c, i) => c === null ? i + 1 : null).filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Chunk verification failed: missing chunks at positions ${missing.join(", ")}`);
    }
    const verifiedStored = stored as StoredChunk[];
    for (let i = 0; i < chunks.length; i++) {
      const expectedCid = createCID(chunks[i], CID_CONFIG.codec, 0x12);
      if (verifiedStored[i].cid.toString() !== expectedCid.toString()) {
        throw new Error(`Chunk verification failed: chunk ${i + 1} CID mismatch (expected ${expectedCid}, got ${verifiedStored[i].cid})`);
      }
    }
    console.log(`   All ${chunks.length} chunks verified ✓`);

    console.log(`   Building DAG-PB...`);
    const fileData = new UnixFS({ type: "file", blockSizes: verifiedStored.map((c: StoredChunk) => BigInt(c.len)) });
    const dagNode = dagPB.prepare({ Data: fileData.marshal(), Links: verifiedStored.map((c: StoredChunk) => ({ Name: "", Tsize: c.len, Hash: c.cid })) });
    const dagBytes = dagPB.encode(dagNode);
    const hashCode = 0x12;
    const rootCid = createCID(dagBytes, 0x70, hashCode);

    // OOM note (observed in s-inc-pool-kubo E2E, ~531s into a large deploy):
    // By this point the heap holds phase A + phase B block maps, both carBytes
    // buffers, papi decoder state, and Sentry SDK buffers. On kubo deploys of
    // large sites (≥ 9 MB) this can reach 4 GB on the default V8 heap limit.
    // The run-state.ts OOM hint already surfaces "retry with --max-old-space-size=8192"
    // on the next relaunch. If you need to debug further, compare rss samples
    // at merkleize_end vs chunk_upload_b_end in the Sentry memory report.
    const rssBeforeRootMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssBeforeRootMb > 2048) {
      captureWarning("high RSS before root node store — OOM risk", {
        rss_mb: rssBeforeRootMb,
        chunks: chunks.length,
      });
    }

    let rootSkipped = false;
    // Phase A passes skipRootStore: its intermediate root is never the
    // contenthash (Phase B re-merkleizes with the real manifest and stores
    // its own root). Skipping here saves a probe + a setRoot tx on first
    // deploys of new content. The previously-existing opportunistic skip
    // (when the root happened to be on chain already) handled the common
    // case where the same content had been deployed before; this covers
    // the first-deploy case where nothing's been deployed yet.
    if (skipRootStore) {
      rootSkipped = true;
    } else {
      const rootProbeResult = await probeChunks([rootCid.toString()], { client });
      if (rootProbeResult[0]?.present === true) {
        console.log(`   Root node already on-chain (${rootCid.toString().slice(0, 20)}…), skipping store.`);
        rootSkipped = true;
      }
    }
    let result: string | undefined;
    let uploadReceipt: ChainReceipt | undefined;
    if (rootSkipped) {
      result = rootCid.toString();
      // No root tx — use last chunk's receipt as upload marker.
      uploadReceipt = (stored as StoredChunk[]).findLast((c: StoredChunk) => c?.receipt)?.receipt;
    } else {
      const MAX_ROOT_RETRIES = 3;
      for (let rootAttempt = 1; rootAttempt <= MAX_ROOT_RETRIES; rootAttempt++) {
        const rootNonce = await readChunkNonce();
        console.log(`   Storing root node (nonce: ${rootNonce})...`);
        const rootTx = unsafeApi.tx.TransactionStorage.store_with_cid_config({ cid: { codec: BigInt(0x70), hashing: toHashingEnum(hashCode) }, data: dagBytes });
        const rootTxOpts = { mortality: { mortal: true, period: 256 }, nonce: rootNonce };
        try {
          const watchResult = await watchTransaction(rootTx, signer!, rootTxOpts, () => {
            console.log(`   Root CID: ${rootCid.toString()}\n`);
            return rootCid.toString();
          }, { label: "root-node", timeoutMs: CHUNK_TIMEOUT_MS, confirmIncluded: () => cidPresentAtBest(client, rootCid.toString()) });
          result = watchResult.value;
          // Root tx is the canonical upload receipt — it finalises the DAG.
          uploadReceipt = watchResult.receipt;
          break;
        } catch (e: any) {
          // The last attempt rethrows: a retry it would schedule never runs, and the
          // loop used to exit with no root stored and no error (#1672).
          if (rootAttempt === MAX_ROOT_RETRIES) throw e;
          if (classifyRootSubmitError(e, wsHaltDetected) === "nonce-collision") {
            // Not a connection loss (#1672): re-read the nonce and resubmit on the same client.
            console.log(`   Root node: nonce ${rootNonce} collided (${e.message?.replace(/\s+/g, " ").slice(0, 80)}), resubmitting at a fresh nonce (attempt ${rootAttempt}/${MAX_ROOT_RETRIES})`);
            captureWarning("root-node nonce collision: resubmitting", { nonce: rootNonce, attempt: rootAttempt });
            await new Promise(r => setTimeout(r, nonceCollisionBackoffMs()));
            continue;
          }
          if (reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
            await doReconnect();
            continue;
          }
          console.log(`   Root node attempt ${rootAttempt} failed: ${e.message?.slice(0, 80)}`);
          await new Promise(r => setTimeout(r, 6000));
        }
      }
    }
    if (uploadReceipt) {
      setDeployAttribute("bulletin.upload.tx_hash", uploadReceipt.txHash);
      setDeployAttribute("bulletin.upload.block_hash", uploadReceipt.blockHash);
      setDeployAttribute("bulletin.upload.block_number", String(uploadReceipt.blockNumber));
      console.log(`   Storage upload finalised @ block ${uploadReceipt.blockNumber} (tx ${uploadReceipt.txHash})`);
    }

    // If a WS halt fired during root-node storage and the root-node watch
    // resolved via nonce-advance (3-min timeout) before the subscription error
    // could trigger doReconnect, the current client is the original destroyed
    // one. The stale-client probe at phase-B entry may not reliably detect this
    // (System.Number can resolve on a destroyed client while the
    // account_authorization runtime call fails with "ChainHead disjointed").
    // Reconnect here so liveProvider carries a healthy client.
    // ownsClient is reset to false: the fresh client is handed off via
    // liveProvider, not destroyed below.
    if (wsHaltDetected && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
      wsHaltDetected = false;
      await doReconnect();
      ownsClient = false;
    }

    if (ownsClient && !handOffLiveClient) client.destroy();
    return { storageCid: result as string, tier2Verified, tier2Inconclusive, tier2Fallback, liveProvider: { client, unsafeApi, signer, ss58 }, skipProbeResults, rootSkipped };
  } catch (e) {
    if (ownsClient) client.destroy();
    throw e;
  } finally {
    // Always clear the halt callback so it doesn't fire after this deploy
    // has finished (e.g. during teardown) and reach into a stale `client`
    // closure.
    setWsHaltCallback(null);
  }
}

// Returns read-only views into the source ArrayBuffer. Mutating a chunk
// would mutate the source; no caller downstream does. PAPI's Vec<u8>
// encoder copies into a fresh wire buffer at sign-time, so the aliasing
// is safe across the sign+submit boundary.
export function chunk(data: Uint8Array, size: number = CHUNK_SIZE): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < data.length) { const end = Math.min(offset + size, data.length); chunks.push(data.subarray(offset, end)); offset = end; }
  return chunks;
}

let _hasIPFS: boolean | undefined;
export function hasIPFS(): boolean { if (_hasIPFS === undefined) { try { execSync("ipfs version", { stdio: "ignore" }); _hasIPFS = true; } catch { _hasIPFS = false; } } return _hasIPFS; }

export async function merkleize(directoryPath: string, outputCarPath: string): Promise<{ carPath: string; cid: string }> {
  if (!hasIPFS()) throw new Error("IPFS CLI not installed. Install from: https://docs.ipfs.tech/install/");
  if (!fs.existsSync(directoryPath)) throw new Error(`Directory not found: ${directoryPath}`);
  console.log(`   Merkleizing: ${directoryPath}`);
  const cid = execSync(`ipfs add -Q -r --cid-version=1 --raw-leaves --pin=false "${directoryPath}"`, { encoding: "utf-8" }).trim();
  if (!cid) throw new Error("Failed to get CID from IPFS");
  execSync(`ipfs dag export ${cid} > "${outputCarPath}"`);
  if (!fs.existsSync(outputCarPath)) throw new Error("Failed to create CAR file");
  const size = fs.statSync(outputCarPath).size;
  console.log(`   CAR: ${(size / 1024 / 1024).toFixed(2)} MB`);
  return { carPath: outputCarPath, cid };
}

// Pure, synchronous. Mirrors the root-CID compute inside storeChunkedContent
// so callers can predict the deploy's final storage CID from the CAR bytes
// alone — no chain round-trip required. This lets onCarReady-driven side
// effects fire in parallel with the (slow) Bulletin upload instead of
// waiting for it to finish.
export function computeStorageCid(chunks: Uint8Array[]): string {
  const hashCode = 0x12;
  const chunkInfo = chunks.map(c => ({
    cid: createCID(c, CID_CONFIG.codec, hashCode),
    len: c.length,
  }));
  const fileData = new UnixFS({ type: "file", blockSizes: chunkInfo.map(c => BigInt(c.len)) });
  const dagNode = dagPB.prepare({ Data: fileData.marshal(), Links: chunkInfo.map(c => ({ Name: "", Tsize: c.len, Hash: c.cid })) });
  const dagBytes = dagPB.encode(dagNode);
  return createCID(dagBytes, 0x70, hashCode).toString();
}

/**
 * Should a storeDirectoryV2 call use the incremental (chunk-dedup) upload
 * path and embed a .bulletin-deploy/manifest.json cache manifest?
 *
 * False for encrypted deploys (existing behavior: encryption breaks
 * chunk-level dedup) and for mainnet deploys: retention makes a cache stale
 * on arrival at mainnet's low deploy cadence, and a production name should
 * not carry build-cache artifacts. Exact `=== "mainnet"` check on purpose —
 * an env-less deploy (`network: undefined`, bare --rpc) or one whose
 * resolved env declares no network keeps the historical incremental
 * behavior; only an env that explicitly declares itself mainnet loses the
 * cache.
 *
 * Not yet wired into storeDirectoryV2 or deploy() — the twin has no mainnet
 * env configured today, so there is nothing to gate on yet. Ported as a
 * standalone pure predicate so the shape stays in sync with upstream for
 * when a mainnet env lands; the wiring (StoreDirectoryOptions.network, the
 * storeDirectoryV2 early-return gate, and the deploy() call-site restructure)
 * is deferred.
 */
export function usesIncrementalCache(opts: { network?: string; password?: string }): boolean {
  return opts.network !== "mainnet" && !opts.password;
}

export interface StoreDirectoryOptions {
  provider?: ExistingProvider;
  password?: string;
  jsMerkle?: boolean;
  /**
   * Fires exactly once, right after the CAR has been merkleized + encrypted
   * and the final storage CID is known, but BEFORE the chunk upload to
   * Bulletin starts. Use to kick off parallel side-effects that can run
   * concurrently with the slow upload. The returned promise is awaited at
   * the end of the deploy; errors are passed through to the caller so they
   * can decide fatal / non-fatal policy.
   */
  onCarReady?: (carBytes: Uint8Array, storageCid: string) => Promise<void> | void;
  /**
   * v2 incremental upload: contenthash from the previous deploy of this
   * domain (the IPFS CID, not the e3-prefixed bytes). The new flow fetches
   * this CID's embedded manifest via the gateway, classifies files,
   * probes chunks for presence, and skips re-uploading any chunk already
   * stored on chain. Pass null (or omit) for first-deploy behaviour.
   * Encrypted deploys (password set) bypass the incremental path because
   * encryption breaks chunk-level dedup.
   */
  previousContenthash?: string | null;
  /** Override gateway URL for manifest fetch + chunk probes. */
  gateway?: string;
  /** Skip the 500 MiB abort guard and allow oversized deploys. */
  allowLargeDeploy?: boolean;
  /**
   * Pin the `deployedAt` timestamp for byte-identical rebuilds.
   * Values: "commit" (git committer date), "epoch:<N>" (Unix epoch seconds),
   * or any ISO 8601 string. Omit for a live wall-clock timestamp.
   */
  reproducibleSource?: string;
  /**
   * DotNS domain label being deployed (without the `.dot` suffix, e.g. `"myapp"`).
   */
  domain?: string;
  /**
   * Opt-in: write the pre-upload CAR file to disk after merkleization.
   * - `true` → write to `<buildDir>.bulletin.car` (default path).
   * - `string` → write to that explicit path.
   * - omitted / `false` → no file written (default).
   * Also honoured when `PAD_DUMP_CAR` env var is set (back-compat).
   */
  dumpCar?: string | boolean;
}

export async function storeDirectory(directoryPath: string, providerOrOptions: ExistingProvider | StoreDirectoryOptions = {}, password?: string, jsMerkle?: boolean): Promise<{ storageCid: string; ipfsCid: string; carBytes: Uint8Array }> {
  // Back-compat: positional (provider, password, jsMerkle) or a single options
  // object. New callers should prefer the object form to get onCarReady.
  const opts: StoreDirectoryOptions = (providerOrOptions && ("provider" in providerOrOptions || "onCarReady" in providerOrOptions || "password" in providerOrOptions || "jsMerkle" in providerOrOptions))
    ? (providerOrOptions as StoreDirectoryOptions)
    : { provider: providerOrOptions as ExistingProvider, password, jsMerkle };
  const provider = opts.provider ?? {};
  password = opts.password;
  jsMerkle = opts.jsMerkle;

  let carContent: Uint8Array;
  let ipfsCid: string;

  // Only send the basename as the telemetry attribute — the full path leaks local
  // usernames (/Users/<name>/...) and home-directory layouts. The basename still
  // carries useful signal (e.g. "dist", ".output/public") without identifying the user.
  const dirBasename = path.basename(directoryPath);
  sampleMemory("storage_start");
  if (jsMerkle) {
    const result = await withSpan("deploy.merkleize", "1a. merkleize (js)", { "deploy.directory": dirBasename }, async () => {
      const r = await merkleizeJS(directoryPath);
      sampleMemory("merkleize_end");
      return r;
    });
    carContent = result.carBytes;
    ipfsCid = result.cid;
  } else {
    const carPath = path.join(path.dirname(directoryPath), `${path.basename(directoryPath)}.car`);
    const { cid } = await withSpan("deploy.merkleize", "1a. merkleize", { "deploy.directory": dirBasename }, async () => {
      const r = await merkleize(directoryPath, carPath);
      sampleMemory("merkleize_end");
      return r;
    });
    ipfsCid = cid;
    carContent = fs.readFileSync(carPath);
  }

  if (password) {
    console.log(`   Encrypting CAR file...`);
    carContent = await encryptContent(carContent, password);
    console.log(`   Encrypted: ${(carContent.length / 1024 / 1024).toFixed(2)} MB`);
  }
  // Opt-in: write the pre-upload CAR to disk. Only when the caller explicitly
  // requests it (PAD_DUMP_CAR env var for back-compat, or dumpCar
  // option). No write by default — avoids polluting consumers' repos/CI areas.
  const carDumpEnv = process.env.PAD_DUMP_CAR;
  const carDumpOpt = opts.dumpCar;
  if (carDumpEnv !== undefined || carDumpOpt) {
    const dumpPath = (typeof carDumpEnv === "string" && carDumpEnv)
      ? carDumpEnv
      : (typeof carDumpOpt === "string" && carDumpOpt)
        ? carDumpOpt
        : path.join(path.dirname(directoryPath), `${path.basename(directoryPath)}.bulletin.car`);
    fs.writeFileSync(dumpPath, carContent);
    console.log(`   Pre-upload CAR saved to ${dumpPath} (${(carContent.length / 1024 / 1024).toFixed(2)} MB)`);
  }
  const carChunks = chunk(carContent, CHUNK_SIZE);
  // Predicted storage CID, available without any chain round-trip. Lets the
  // onCarReady callback act on the final CID before the chain upload lands.
  // Verified against Bulletin's own rootCid computation below.
  const predictedStorageCid = computeStorageCid(carChunks);
  if (opts.onCarReady) await opts.onCarReady(carContent, predictedStorageCid);
  // Enrich the threshold-triggered memory report with deploy shape. No-op
  // outside a deploy span; safe to call unconditionally.
  setDeployReportContext({
    jsMerkle: Boolean(jsMerkle),
    chunkCount: carChunks.length,
    carBytes: carContent.length,
    outputDir: path.dirname(directoryPath),
  });
  // Mirror into the bug-report context so auto-filed issues carry the same
  // shape info the memory report already gets.
  setBugReportContext({
    chunkCount: carChunks.length,
    totalSize: `${(carContent.length / 1024 / 1024).toFixed(2)} MB`,
  });
  // deploy.car.mb is kept (as a string) for the existing CAR-size dashboard
  // widget which displays human-readable MB values. deploy.car.bytes and
  // deploy.chunks.total are now sent as numbers so Sentry max()/p95()
  // aggregates work.
  const carMbFloat = Math.round((carContent.length / 1024 / 1024) * 100) / 100;
  const carMb = String(carMbFloat);
  // Size bucket for distribution widget — numeric filters on string-typed EAP
  // attributes don't work, so we bucket at emission time.
  const carSizeBucket =
    carMbFloat < 1 ? "tiny" :
    carMbFloat < 5 ? "small" :
    carMbFloat < 15 ? "medium" :
    carMbFloat < 50 ? "large" : "xlarge";
  const storageCid = await withSpan("deploy.chunk-upload", "1b. chunk-upload", { "deploy.chunks.total": carChunks.length, "deploy.car.bytes": carContent.length, "deploy.car.mb": carMb, "deploy.car.size_bucket": carSizeBucket }, async () => {
    sampleMemory("chunk_upload_start");
    const r = await storeChunkedContent(carChunks, provider);
    sampleMemory("chunk_upload_end");
    return r.storageCid;
  });
  if (storageCid !== predictedStorageCid) {
    // Pure compute drift — would only happen if UnixFS / DAG-PB encoding on
    // our side diverges from what storeChunkedContent actually writes. We
    // don't fail the deploy (on-chain state is authoritative), but log loud
    // so any drift surfaces in Sentry and in the test matrix before a real
    // user hits it.
    captureWarning("computeStorageCid drift vs storeChunkedContent", {
      predicted: predictedStorageCid,
      uploaded: storageCid,
    });
  }
  return { storageCid, ipfsCid, carBytes: carContent };
}

// Read the on-chain contenthash for a domain and decode it to an IPFS CID
// string for the incremental-upload-v2 manifest fetcher. Best-effort: returns
// null on first deploy ("0x"), unreadable bytes, or any error. Mirrors the
// decode logic in dotns.ts:setContenthash without throwing.
//
// `bareLabel` MUST NOT include the TLD: DotNS.getContenthash() derives the
// on-chain node as namehash(`${domainName}.${this._tld}`) itself, so passing
// an already-suffixed name (e.g. ParsedDomainName.fullName, which is always
// `${label}.${tld}`) makes it read namehash("sub.parent.paseo.paseo") — a
// node that doesn't exist. That's a *different* instance of the exact bug
// class documented above computeDomainTokenId in dotns.ts (registering
// namehash("ssoqedtuwf.paseo") but then querying namehash("ssoqedtuwf.dot")
// after an 11 PAS mint had already succeeded). Here it's caught by the
// try/catch below, so it only silently defeats the incremental-deploy
// optimisation rather than reverting a paid call — but the parameter name
// is deliberately "bareLabel", not "domainName" or "fullName", so a future
// caller can't reach for the wrong field again. Exported for unit tests.
export async function readPreviousContenthashSafe(dotns: DotNS, bareLabel: string): Promise<string | null> {
  try {
    const hex = await dotns.getContenthash(bareLabel);
    if (!hex || hex === "0x") return null;
    const bytes = Buffer.from(hex.slice(2), "hex");
    if (bytes[0] !== 0xe3 || bytes.length < 4) return null;
    return CID.decode(bytes.slice(2)).toString();
  } catch {
    return null;
  }
}

// Build the per-file map for the embedded manifest. Records path, CID,
// classification, and file size. When fileCids is provided (v2 flow),
// each file gets its actual CID and size; without it (legacy / unit-test path)
// CID defaults to "" and the walk behaviour is unchanged.
//
// Exported for unit tests.
export function buildFilesMap(buildDir: string, fileCids: Map<string, string> = new Map(), framework: string | null = null): Record<string, ManifestFileEntry> {
  const map: Record<string, ManifestFileEntry> = {};
  function walk(dir: string, prefix = ""): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        if (rel === MANIFEST_PATH) continue;
        const fileCid = fileCids.get(rel) ?? "";
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* manifest path-only */ }
        const type = classifyFile(rel, { fileCid: fileCid || undefined, framework });
        map[rel] = { cid: fileCid, type, size };
      }
    }
  }
  walk(buildDir);
  return map;
}

// Read RetentionPeriod from chain. Storage value (not constant) — see
// tools/bulletin-retention-probe.mjs and the plan's Phase 0 outcomes.
// Best-effort: 0 on failure (telemetry-only field, doesn't gate behaviour).
async function readRetentionPeriodBlocks(unsafeApi: any): Promise<number> {
  try {
    const rp = await unsafeApi.query.TransactionStorage.RetentionPeriod.getValue();
    return Number(rp);
  } catch {
    return 0;
  }
}

// Detect the frontend framework used to generate the build dir, by build
// markers evaluated against the deployed directory only (C1 — never any
// history/manifest). Order is presentation only: two markers are ambiguous
// no matter which matched first, so reordering these checks changes nothing
// unless the collision rule below changes too. Returns null on ambiguity
// (more than one marker) or on no marker at all, rather than guessing (C3): a
// misdetection would apply a real per-framework rule set to the wrong tree,
// which is worse than falling back to the unchanged global heuristic.
//
// Intentionally the same regex object as the classification fallback, not an
// independent vite pattern: "does this look like a bundler hash" is one
// question asked in two places. Tightening CONTENT_HASH_RE therefore also
// retunes vite DETECTION here — check both when you touch it.
const VITE_ASSET_HASH_RE = CONTENT_HASH_RE;

export function detectFramework(directoryPath: string): string | null {
  const markers: string[] = [];

  // Most specific: a parsed manifest field, not a directory name.
  try {
    const manifestPath = path.join(directoryPath, "manifest.json");
    const polkavmBinPath = path.join(directoryPath, "app.polkavm");
    if (fs.existsSync(manifestPath) && fs.existsSync(polkavmBinPath)) {
      const obj = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (obj && typeof obj === "object" && obj.runtime && obj.runtime.kind === "polkavm") {
        markers.push("polkavm-app");
      }
    }
  } catch { /* missing/malformed manifest.json: not a marker */ }

  if (fs.existsSync(path.join(directoryPath, "_next", "static"))) markers.push("next");
  if (fs.existsSync(path.join(directoryPath, "_nuxt"))) markers.push("nuxt");

  // Vite requires evidence, not just a folder name: an assets/ dir whose
  // vite-plugin-singlefile output inlines everything comes and goes between
  // deploys, so a bare directory-presence check flips between UNKNOWN and
  // "vite" for the same repo. Requiring a hash-shaped entry makes an inlined
  // single-file build report UNKNOWN consistently — correct, since it has
  // nothing left to classify.
  const assetsDir = path.join(directoryPath, "assets");
  if (fs.existsSync(assetsDir)) {
    try {
      const entries = fs.readdirSync(assetsDir);
      if (entries.some((name) => VITE_ASSET_HASH_RE.test(name))) markers.push("vite");
    } catch { /* unreadable assets dir: not a marker */ }
  }

  if (markers.length !== 1) return null;
  return markers[0];
}

// ── Deploy size guardrails ─────────────────────────────────────────────────
const SIZE_WARN_BYTES = 50 * 1024 * 1024;
const SIZE_ABORT_BYTES = 500 * 1024 * 1024;

export type SizeDecision =
  | { kind: "ok" }
  | { kind: "warn"; message: string }
  | { kind: "abort"; message: string };

export function checkDeploySize(carBytes: number, opts: { allowLargeDeploy?: boolean }): SizeDecision {
  if (carBytes >= SIZE_ABORT_BYTES && !opts.allowLargeDeploy) {
    return { kind: "abort", message: `deploy exceeds 500 MiB (${(carBytes / 1024 / 1024).toFixed(1)} MiB). Re-run with --allow-large-deploy if intentional.` };
  }
  if (carBytes >= SIZE_WARN_BYTES) {
    return { kind: "warn", message: `deploy exceeds 50 MiB (${(carBytes / 1024 / 1024).toFixed(1)} MiB). Continuing.` };
  }
  return { kind: "ok" };
}

// ── Reproducible timestamp resolution ─────────────────────────────────────
export function resolveReproducibleTimestamp(source: string): string {
  if (source === "commit") {
    try {
      const out = execSync("git log -1 --format=%cI", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const d = new Date(out);
      if (Number.isNaN(d.getTime())) throw new Error("invalid git committer date");
      return d.toISOString();
    } catch (e: any) {
      throw new Error(`--reproducible=commit failed: ${e?.message ?? e}. Provide --reproducible=<ISO8601> instead.`);
    }
  }
  if (source.startsWith("epoch:")) {
    const n = Number(source.slice("epoch:".length));
    if (!Number.isFinite(n)) throw new Error(`--reproducible=epoch:N requires a number; got ${source}`);
    return new Date(n * 1000).toISOString();
  }
  // Try as ISO 8601.
  const d = new Date(source);
  if (Number.isNaN(d.getTime())) throw new Error(`--reproducible=<source>: '${source}' is not a recognised timestamp`);
  return d.toISOString();
}

// ── Gateway pre-warm ───────────────────────────────────────────────────────
// Fire-and-forget HEAD requests for newly uploaded chunks so gateway caches
// are warm before the first user hits the site. Errors are intentionally
// swallowed — this is a best-effort optimisation only.
function preWarmGateway(chunkCids: string[], gateways: string[]): void {
  for (const cid of chunkCids) {
    for (const gw of gateways) {
      const url = `${gw.replace(/\/$/, "")}/ipfs/${cid}`;
      fetch(url, { method: "HEAD" }).catch(() => {});
    }
  }
}

// Set Sentry span attributes for the manifest fetch outcome. Extracted for unit
// tests so the attribute-emission logic can be verified without a full deploy.
// All numeric values are emitted as strings — @sentry/node EAP stores user-defined
// attributes as string-typed columns regardless of JS value type, so sum()/avg()
// won't work on raw numbers. Use count_if(deploy.manifest.fetch_source, "heuristic_fallback")
// / count() as an equation widget for the fallback rate.
//
// Exported for unit tests.
export function applyManifestFetchAttributes(fetched: { source: string; attempts?: number; bytesDownloaded?: number }): void {
  setDeployAttribute("deploy.manifest.fetch_source", fetched.source);
  setDeployAttribute("deploy.manifest.fetch_attempts", String(fetched.attempts ?? 0));
  setDeployAttribute("deploy.manifest.bytes_downloaded", String(fetched.bytesDownloaded ?? 0));
}

// #1011: given the section-1 CIDs Phase A is considering and the set of CIDs the
// previous manifest vouches for, report how many are new (toCheck), how many are
// trusted (deduped — a trusted CID repeated in section 1 counts once), and how
// many are plain duplicates (repeat occurrences of ANY CID, trusted or not),
// reported separately rather than folded into "trusted".
//
// Deduping before counting trusted/toCheck is deliberate: the naive formula
// `toCheck = uniqueCount - phaseAUploadCids.filter(c => trustedCids.has(c)).length`
// (counting trusted occurrences over the RAW, non-deduped list) goes negative
// whenever a trusted CID repeats, and — the bug this replaces — the previous
// `phaseAUploadCids.length - new Set(phaseAUploadCids).size` formula counted
// PLAIN DUPLICATES (of any CID, trusted or not) as "trusted from prev manifest",
// which is how a first deploy (no previous manifest at all) could print a
// nonzero trusted count purely from a repeated CID in section 1.
//
// Exported for unit tests.
export function computePhaseACounts(
  uploadCids: string[],
  trustedCids: Set<string>,
): { toCheck: number; trusted: number; duplicates: number } {
  const uniqueCids = [...new Set(uploadCids)];
  const trusted = uniqueCids.filter((c) => trustedCids.has(c)).length;
  const toCheck = uniqueCids.length - trusted;
  const duplicates = uploadCids.length - uniqueCids.length;
  return { toCheck, trusted, duplicates };
}

// #1011: `submittedCount` (stored entries where !viaFallback) undercounts real
// submissions — viaFallback is ALSO set for chunks that genuinely were submitted
// this run via the nonce-advance heuristic, the timed-out-reconcile path, and the
// isValid:false probe-failed backstop (none of those are "already on chain from
// before this call"). `uploadTotal` is captured once, before the submission loop
// starts, as the count of chunks NOT already resolved by the incremental-cache
// pre-pass (trustedCids/skipCids) — i.e. the chunks this call actually drove
// through submission-or-confirmation, whichever path they took. That is the
// correct "submitted and included" count; `totalChunks - uploadTotal` is the
// correct "already on chain [before this call]" count.
//
// Exported for unit tests.
export function formatUploadInclusionLine(totalChunks: number, uploadTotal: number): string {
  if (uploadTotal === 0) {
    return `All ${totalChunks} chunks already on chain — nothing submitted`;
  }
  return `${uploadTotal} submitted and included, ${totalChunks - uploadTotal} already on chain`;
}

// Incremental upload v2 flow. Wraps the existing storeDirectory pipeline with:
//  - previous-manifest fetch via the Bulletin gateway
//  - placeholder/finalise embedded-manifest dance around the merkleize
//  - gateway HEAD probe to identify already-stored chunks
//  - skipCids threading into storeChunkedContent
//  - stats + telemetry emission
//
// Encrypted deploys fall through to the legacy storeDirectory path (encryption
// breaks chunk-level dedup; CIDs differ even for identical content).
//
// Spec: docs-internal/superpowers/specs/2026-05-07-incremental-upload-v2-design.md
// Plan: docs-internal/superpowers/plans/2026-05-07-incremental-upload-v2.md (Task 12)

/**
 * `present === null` is "could not measure", not "absent". Re-upload is the
 * remedy for a chunk that is gone, not one we could not read (bulletin #1445).
 */
export function partitionFinalityProbe(
  results: { cid: string; present: boolean | null; failureReason?: string }[],
): { absent: string[]; indeterminate: string[]; reason?: string } {
  const indeterminate = results.filter(r => r.present === null);
  return {
    absent: results.filter(r => r.present === false).map(r => r.cid),
    indeterminate: indeterminate.map(r => r.cid),
    reason: indeterminate[0]?.failureReason,
  };
}

export async function storeDirectoryV2(
  directoryPath: string,
  opts: StoreDirectoryOptions = {}
): Promise<{ storageCid: string; ipfsCid: string; carBytes: Uint8Array }> {
  // Encryption + incremental are incompatible. Route to legacy path.
  if (opts.password) return storeDirectory(directoryPath, opts);

  const provider = opts.provider ?? {};
  const prevContenthash = opts.previousContenthash ?? null;
  // Gateway URL flows from environments.ts via the deploy() wrapper that
  // passes `gateway: envIpfs` into this function. No hardcoded fallback —
  // missing gateway means fetchPreviousManifest will skip the network tier
  // and rely on persistent cache + heuristic.
  const gateway = opts.gateway;
  const dirBasename = path.basename(directoryPath);
  sampleMemory("storage_start");

  // 1. Fetch previous embedded manifest (skipped if first deploy).
  // Priority: local cache → chain (bitswap_v1_get) → IPFS gateway → heuristic fallback.
  const fetched = await fetchPreviousManifest(prevContenthash, {
    gateway,
    domain: opts.domain,
    chainClient: opts.provider?.client,
  });
  const prevManifest = fetched.source === "embedded" ? fetched.manifest : null;
  console.log(`   Manifest fetch: ${fetched.source}${fetched.source !== "none" ? ` (${(fetched as any).attempts} attempt${(fetched as any).attempts === 1 ? "" : "s"})` : ""}`);
  applyManifestFetchAttributes(fetched);

  // 2. Phase A — placeholder before first merkleize.
  //
  // Framework detection happens exactly once here, before
  // writeEmbeddedManifestPlaceholder — the first thing that mutates the
  // deployed tree (it creates .bulletin-deploy/manifest.json inside
  // directoryPath). detectFramework reads only the directory being deployed
  // (C1), so it must never observe a file this deploy created; computing it
  // any later would risk that even though isVolatilePath already excludes
  // .bulletin-deploy/ from every marker's own path space. The single value
  // computed here is reused at every other call site below instead of
  // re-invoking detectFramework.
  const framework = detectFramework(directoryPath);
  // Hoisted once: buildOrderedCar's classifyFn runs per file, per merkleize
  // pass (Phase A and Phase B) — reusing one context object instead of a
  // fresh `{ framework }` literal per call avoids an allocation on every file
  // of every deploy for a value that never changes within a deploy.
  const classifyCtx = { framework };
  const deployedAt = opts.reproducibleSource
    ? resolveReproducibleTimestamp(opts.reproducibleSource)
    : new Date().toISOString();
  writeEmbeddedManifestPlaceholder(directoryPath, {
    version: MANIFEST_VERSION,
    previousContenthash: prevContenthash,
    deployedAt,
    framework: null,
  });

  // 3. Merkleize with stable order (anchors unchanged stable blocks at their
  // old positions). Backend chosen by jsMerkle option, matching the legacy
  // storeDirectory's behaviour:
  //   - jsMerkle: true       → JS importer (works everywhere, no daemon)
  //   - jsMerkle: false      → Kubo (throws if ipfs not on PATH; a failed ipfs call falls back to JS)
  //   - jsMerkle: undefined  → smart default: Kubo if available, JS otherwise
  // The same buildOrderedCar runs over both backends' output, so the resulting
  // CAR is byte-identical regardless of merkleizer choice for identical content.
  let useKubo: boolean;
  if (opts.jsMerkle === true) {
    useKubo = false;
  } else if (opts.jsMerkle === false) {
    if (!hasIPFS()) {
      throw new Error("jsMerkle:false requires the ipfs binary on PATH; install from https://docs.ipfs.tech/install/ or omit --js-merkle to fall back to JS.");
    }
    useKubo = true;
  } else {
    useKubo = hasIPFS();
  }
  const phaseA = await withSpan("deploy.merkleize", `1a. merkleize (${useKubo ? "kubo" : "js"}, stable)`, { "deploy.directory": dirBasename, "deploy.merkle": useKubo ? "kubo" : "js" }, async () => {
    const r = await merkleizeWithStableOrder(directoryPath, prevManifest?.stableBlockOrder, { useKubo, phase: "Phase A", classifyFn: (p) => classifyFile(p, classifyCtx) });
    sampleMemory("merkleize_end");
    return r;
  });

  // 4. Phase A — chunk probe is merged into storeChunkedContent (single probe round).
  // Section-1 only — sections 0 (manifest placeholder) and 2 (root dir placeholder)
  // differ between phases A and B. Uploading them in Phase A would orphan chunks
  // when Phase B re-merkleizes with the final manifest. Phase B uploads them.
  const carChunksA = phaseA.chunks;
  const carChunkCidsA = phaseA.chunkCids;
  const s1Start = phaseA.sectionChunkCounts.section0;
  const s1End = s1Start + phaseA.sectionChunkCounts.section1;
  const phaseAUploadChunks = carChunksA.slice(s1Start, s1End);
  const phaseAUploadCids = carChunkCidsA.slice(s1Start, s1End);

  // Build trust set from previous manifest's chunks map. Chunks listed there were
  // on chain at prev-deploy finalisation; trust them without re-probing.
  // Safety: end-of-Phase-B GRANDPA probe re-verifies all chunks at finalised head,
  // so a "trusted but evicted" chunk gets caught and re-uploaded there.
  //
  // #1011 invariant (cross-referenced with src/incremental-stats.ts's Manifest
  // line): trustedCidsA stays empty whenever prevManifest is absent, which is
  // exactly when computeStats/renderSummary reports manifestSource === "none"
  // ("first deploy (no previous manifest)" or another none-reason). That keeps
  // computePhaseACounts(phaseAUploadCids, trustedCidsA).trusted === 0 on every
  // such deploy — the "first deploy" line and a nonzero Phase A trusted count
  // can never both print. If you change how trustedCidsA is populated, or add
  // a new manifestSource variant, re-check that this stays true.
  const trustedCidsA = new Set<string>();
  if (prevManifest?.chunks) {
    for (const cid of Object.keys(prevManifest.chunks)) {
      trustedCidsA.add(cid);
    }
  }

  // skipCidsA covers all section-1 CIDs; storeChunkedContent will skip the
  // trusted ones via trustedCidsA (no re-probe) and probe+skip the rest.
  const skipCidsA = new Set<string>(phaseAUploadCids);
  const probeFailedCidsA = new Set<string>();
  const hasNewChunks = phaseAUploadCids.some(c => !trustedCidsA.has(c));
  // #1011: computePhaseACounts scopes trusted/toCheck/duplicates to
  // phaseAUploadCids specifically (deduped before counting), fixing the bug
  // where a first deploy (no previous manifest) could print a nonzero
  // "trusted from prev manifest" count purely from a duplicate CID in
  // section 1 — see the console.log lines below and computePhaseACounts'
  // own doc comment.
  const phaseACounts = computePhaseACounts(phaseAUploadCids, trustedCidsA);
  setDeployAttribute("deploy.phase_a.chunks_trusted", trustedCidsA.size);

  // 5. Phase A upload — submits absent chunks; skips present ones via internal probe.
  setDeployReportContext({
    jsMerkle: true,
    chunkCount: carChunksA.length,
    carBytes: phaseA.carBytes.length,
    outputDir: path.dirname(directoryPath),
  });
  setBugReportContext({
    chunkCount: carChunksA.length,
    totalSize: `${(phaseA.carBytes.length / 1024 / 1024).toFixed(2)} MB`,
  });
  const carMbA = String(Math.round((phaseA.carBytes.length / 1024 / 1024) * 100) / 100);
  let phaseALiveProvider: ExistingProvider = provider;
  let phaseASkipProbeResults = new Map<string, true | false | null>();
  console.log("\n   Phase A (stable section):");
  // Printed once regardless of branch below — duplicate CIDs in section 1 are
  // a property of phaseAUploadCids itself, not of whether any chunk needs
  // uploading (#1011 /simplify: was copy-pasted into both branches).
  if (phaseACounts.duplicates > 0) {
    console.log(`   Phase A: ${phaseACounts.duplicates} duplicate chunk CID(s) in section 1 (deduped, not double-counted)`);
  }
  if (!hasNewChunks) {
    // All section-1 chunks trusted from prev manifest — skip storeChunkedContent entirely.
    console.log(`   Phase A: nothing to upload (all ${phaseACounts.trusted} section-1 chunks trusted from prev manifest)`);
    phaseASkipProbeResults = new Map(phaseAUploadCids.map(c => [c, true as true]));
    // phaseALiveProvider stays as provider (no extrinsics submitted yet; Phase B will populate its own)
  } else {
    if (phaseACounts.trusted > 0) {
      console.log(`   Phase A: ${phaseACounts.toCheck} chunks to check/upload, ${phaseACounts.trusted} trusted from prev manifest`);
    }
    await withSpan("deploy.chunk-upload", "1b. chunk-upload (phase A)", {
      "deploy.chunks.total": phaseAUploadChunks.length,
      "deploy.car.bytes": phaseA.carBytes.length,
      "deploy.car.mb": carMbA,
    }, async () => {
      sampleMemory("chunk_upload_start");
      const phaseAUpload = await storeChunkedContent(phaseAUploadChunks, { ...provider, gateway, skipCids: skipCidsA, trustedCids: trustedCidsA, skipRootStore: true, handOffLiveClient: true }); // phase A: single internal probe, no root store (Phase B's root supersedes), Tier 2 counts discarded (intermediate CAR)
      phaseALiveProvider = { ...provider, ...phaseAUpload.liveProvider };
      phaseASkipProbeResults = phaseAUpload.skipProbeResults;
      setDeployAttribute("deploy.storage.phase_a.root_already_onchain", String(phaseAUpload.rootSkipped));
      if (phaseAUpload.tier2Inconclusive > 0) {
        captureWarning("Phase A chunk probe inconclusive — chain RPC returned null for some CIDs", {
          tier2Inconclusive: phaseAUpload.tier2Inconclusive,
          total: phaseAUploadChunks.length,
        });
      }
      sampleMemory("chunk_upload_end");
    });
  }

  // Derive probe telemetry from the internal probe results + the trust set.
  // Trusted chunks were skipped by storeChunkedContent without probing, but
  // from a "what's on chain?" standpoint the prev manifest vouches for them.
  // Count them as present here so the deploy summary's chunk-skip rate reflects
  // reality (manifest-aware Phase A is supposed to BOOST that rate, not zero it).
  // Phase A only uploaded section 1 (sections 0/2 deferred to Phase B). Probe
  // stats are scoped accordingly — sections 0 and 2 weren't probed/uploaded
  // by Phase A and are tracked when Phase B processes them.
  let probePresent = 0;
  let probeAbsent = 0;
  let bytesProbePresent = 0;
  let bytesProbeAbsent = 0;
  for (let i = 0; i < phaseAUploadCids.length; i++) {
    const cid = phaseAUploadCids[i];
    if (trustedCidsA.has(cid)) {
      probePresent++;
      bytesProbePresent += phaseAUploadChunks[i].length;
      continue;
    }
    const present = phaseASkipProbeResults.get(cid);
    if (present === true) {
      probePresent++;
      bytesProbePresent += phaseAUploadChunks[i].length;
    } else if (present === false) {
      probeAbsent++;
      bytesProbeAbsent += phaseAUploadChunks[i].length;
    } else if (present === null) {
      probeFailedCidsA.add(cid);
    }
  }
  const probeFailedCount = probeFailedCidsA.size;
  setDeployAttribute("deploy.probe.present", probePresent);
  setDeployAttribute("deploy.probe.absent", probeAbsent);
  setDeployAttribute("deploy.probe.failed", probeFailedCount);
  // Number of section-1 chunks Phase A actually uploaded (vs. found present already).
  setDeployAttribute("deploy.phase_a.chunks_uploaded", probeAbsent);

  // Section-1 CIDs Phase A uploaded (or confirmed already present) — Phase B
  // trusts them without re-probe via trustedCidsB.
  const phaseAKnownPresent = new Set<string>(phaseAUploadCids);

  // 6. Phase B — finalise manifest with v3 fields.
  const filesMap = buildFilesMap(directoryPath, phaseA.fileCids, framework);
  const blocksList = [...phaseA.blocks.keys()];
  const chunksMap: Record<string, ManifestChunkEntry> = {};
  for (let i = 0; i < phaseA.section1ChunkCids.length; i++) {
    const cid = phaseA.section1ChunkCids[i];
    // deployed_at policy:
    //   - If chunk was probe-present AND in prev manifest → inherit prev's deployed_at.
    //   - If chunk was probe-present but NOT in prev manifest (recycled) → conservative ceiling: deployedAt.
    //   - If chunk was probe-absent or probe-failed (uploaded this run) → deployedAt.
    const probePresence = phaseASkipProbeResults.get(cid);
    const inheritFrom = prevManifest?.chunks?.[cid];
    let deployedAtForChunk: string;
    if ((probePresence === true || probePresence === null) && inheritFrom) {
      deployedAtForChunk = inheritFrom.deployed_at;
    } else {
      deployedAtForChunk = deployedAt;
    }
    // chunk size from phaseA.chunks.
    const probedIdx = phaseA.chunkCids.indexOf(cid);
    const sizeBytes = phaseA.chunks[probedIdx]?.length ?? 0;
    // block/index are not available from the merged probe path (storeChunkedContent
    // does not return per-chunk block metadata). Omit to keep manifest lean.
    chunksMap[cid] = { size: sizeBytes, deployed_at: deployedAtForChunk };
  }
  finaliseEmbeddedManifest(directoryPath, {
    version: MANIFEST_VERSION,
    previousContenthash: prevContenthash,
    deployedAt,
    framework,
    files: filesMap,
    stableBlockOrder: phaseA.stableOrder,
    blocks: blocksList,
    chunks: chunksMap,
  });

  // Release Phase A bulk allocations early; phaseA.stableOrder is still
  // needed for the Phase B merkleize call below.
  phaseA.blocks.clear();
  carChunksA.length = 0;
  phaseA.carBytes = new Uint8Array(0);

  // 7. Re-merkleize with the same blockOrder. Only the manifest-bearing
  // block(s) change; everything else is byte-identical.
  const phaseB = await withSpan("deploy.merkleize", "1c. merkleize (js, finalise)", { "deploy.directory": dirBasename }, async () => {
    const r = await merkleizeWithStableOrder(directoryPath, phaseA.stableOrder, { useKubo, phase: "Phase B", classifyFn: (p) => classifyFile(p, classifyCtx) });
    sampleMemory("merkleize_finalise_end");
    return r;
  });

  // Size guardrail — warn at 50 MiB, abort at 500 MiB (unless --allow-large-deploy).
  const sizeDecision = checkDeploySize(phaseB.carBytes.length, { allowLargeDeploy: opts.allowLargeDeploy });
  if (sizeDecision.kind === "abort") throw new Error(sizeDecision.message);
  if (sizeDecision.kind === "warn") console.warn(`   ⚠ ${sizeDecision.message}`);

  // Opt-in: write the pre-upload CAR to disk. Only when explicitly requested.
  const carDumpEnv = process.env.PAD_DUMP_CAR;
  const carDumpOpt = opts.dumpCar;
  if (carDumpEnv !== undefined || carDumpOpt) {
    const dumpPath = (typeof carDumpEnv === "string" && carDumpEnv)
      ? carDumpEnv
      : (typeof carDumpOpt === "string" && carDumpOpt)
        ? carDumpOpt
        : path.join(path.dirname(directoryPath), `${path.basename(directoryPath)}.bulletin.car`);
    fs.writeFileSync(dumpPath, phaseB.carBytes);
    console.log(`   Pre-upload CAR saved to ${dumpPath} (${(phaseB.carBytes.length / 1024 / 1024).toFixed(2)} MB)`);
  }

  // 8. Re-chunk Phase B; identify which chunks are NEW vs already-handled in Phase A.
  const carChunksB = phaseB.chunks;
  const carChunkCidsB = phaseB.chunkCids;
  // Phase B uses trustedCids (not skipCids) — no re-probe. All Phase A CIDs
  // were verified/uploaded during Phase A's single probe round and can be
  // trusted present for the lifetime of this deploy session.
  const trustedCidsB = new Set<string>(phaseAKnownPresent);
  // Probe Phase B CIDs not already trusted from Phase A to avoid re-uploading
  // chunks that are already on-chain from a previous Phase B run.
  let phaseBProbeHits = 0;
  {
    const phaseBUnknown = carChunkCidsB.filter(c => !trustedCidsB.has(c));
    if (phaseBUnknown.length > 0) {
      const probeResults = await probeChunks(phaseBUnknown, { client: phaseALiveProvider.client! });
      for (const r of probeResults) {
        if (r.present === true) {
          trustedCidsB.add(r.cid);
          phaseBProbeHits++;
        }
      }
    }
  }
  // computeStorageCid is the predicted root CID; published via onCarReady so
  // callers can react before the Phase B upload completes.
  const predictedStorageCid = computeStorageCid(carChunksB);
  if (opts.onCarReady) await opts.onCarReady(phaseB.carBytes, predictedStorageCid);

  // 9. Phase B upload — submits only the chunks that actually changed
  // (typically just the chunk(s) covering the manifest file).
  console.log("\n   Phase B (full CAR):");
  const carMbB = String(Math.round((phaseB.carBytes.length / 1024 / 1024) * 100) / 100);
  const newPhaseBChunks = carChunkCidsB.filter((c) => !trustedCidsB.has(c)).length;
  const phaseBResult = await withSpan("deploy.chunk-upload", "1d. chunk-upload (phase B)", {
    "deploy.chunks.total": carChunksB.length,
    "deploy.chunks.phase_b_new": newPhaseBChunks,
    "deploy.car.bytes": phaseB.carBytes.length,
    "deploy.car.mb": carMbB,
  }, async () => {
    sampleMemory("chunk_upload_b_start");
    const r = await storeChunkedContent(carChunksB, { ...phaseALiveProvider, gateway, trustedCids: trustedCidsB, probeFailedCids: probeFailedCidsA, handOffLiveClient: true });
    sampleMemory("chunk_upload_b_end");
    return r;
  });
  phaseALiveProvider = { ...phaseALiveProvider, ...phaseBResult.liveProvider };
  const storageCid = phaseBResult.storageCid;
  setDeployAttribute("deploy.storage.phase_b.probe_hit_count", phaseBProbeHits);

  // GRANDPA finality check — runs AFTER Phase B's upload covers all chunks
  // referenced by the published manifest, plus the DAG-PB root that
  // setContenthash will reference.
  //
  // Flow:
  //   1. Initial probe at finalised head. Anything present → done.
  //   2. For anything missing: this is normal — Phase B's just-uploaded
  //      chunks (especially the root) are in best chain but haven't
  //      finalised yet. Poll for natural finalisation up to FINALITY_WAIT_MS.
  //   3. Anything STILL missing after the wait: re-upload (chunks) or throw
  //      (root has no re-upload path). Then poll the re-uploaded CIDs.
  if (!phaseALiveProvider.client) {
    throw new Error(`Connection lost and max reconnections (${MAX_RECONNECTIONS}) exhausted after phase B — finality probe unavailable. Retry the deploy.`);
  }
  {
    const grandpaCids = [...phaseB.chunkCids, storageCid];
    console.log(`   Finality check: probing ${grandpaCids.length} chunks at chain-finalised state (aka GRANDPA)...`);
    const finalityResults = await probeChunks(grandpaCids, { client: phaseALiveProvider.client!, atFinalized: true });
    const { absent, indeterminate, reason } = partitionFinalityProbe(finalityResults);
    let missingCids = new Set(absent);
    setDeployAttribute("deploy.probe.finality_miss_count", missingCids.size);
    setDeployAttribute("deploy.probe.finality_indeterminate_count", indeterminate.length);
    if (indeterminate.length > 0) {
      console.log(`   ${indeterminate.length} of ${grandpaCids.length} chunks could not be probed (${reason}); finality unverified for those`);
    }

    let reuploadCount = 0;
    let laggingFinalityCount = 0;
    if (missingCids.size === 0) {
      console.log(indeterminate.length === 0
        ? `   ✓ All ${grandpaCids.length} chunks finalised`
        : `   ${grandpaCids.length - indeterminate.length} of ${grandpaCids.length} chunks finalised, ${indeterminate.length} unverified`);
    } else {
      // Step 2: wait for natural finalisation. Phase B's just-landed chunks
      // (and especially the root, which was the LAST extrinsic submitted)
      // are in best chain but not yet at finalised head — give them time.
      console.log(`   ${missingCids.size} chunks not yet finalised — waiting up to ${GRANDPA_NATURAL_WAIT_MS / 1000}s for natural finalisation`);
      for (const cid of missingCids) console.log(`      ${cid.slice(0, 20)}…`);
      const waitStart = Date.now();
      await pollUntilFinalized(missingCids, GRANDPA_NATURAL_WAIT_MS, phaseALiveProvider.client!);

      if (missingCids.size === 0) {
        const elapsed = Math.round((Date.now() - waitStart) / 1000);
        console.log(`   ✓ All ${grandpaCids.length} chunks finalised (waited ${elapsed}s)`);
      } else {
        // Step 3 (#1049): before treating anything as "missing" and
        // re-uploading it, probe at BEST-BLOCK. A chunk present in
        // best-block was never lost — GRANDPA just hasn't caught up yet —
        // so re-uploading it is both unnecessary and actively harmful (the
        // re-upload tx can itself time out, failing an otherwise-successful
        // deploy). Only chunks absent from best-block too are genuinely
        // missing and eligible for re-upload below.
        const stillMissing = [...missingCids];
        const { reallyMissing, lagging } = await probeFinalityGap(stillMissing, { client: phaseALiveProvider.client! });
        const laggingCids = new Set(lagging);
        laggingFinalityCount = laggingCids.size;
        missingCids = new Set(reallyMissing);
        setDeployAttribute("deploy.probe.finality_lagging_count", laggingFinalityCount);
        if (laggingCids.size > 0) {
          console.log(`   ${laggingCids.size} chunk(s) present in best-block but finality-lagging — will NOT re-upload, waiting for GRANDPA (bounded)`);
        }

        // Re-upload anything genuinely missing (absent from best-block too),
        // including root if needed. Root uses DAG-PB codec (0x70); chunks
        // use raw codec (0x55).

        // Pre-compute DAG-PB root bytes — same encoding as computeStorageCid.
        const rootHashCode = 0x12;
        const rootChunkLinks = phaseB.chunks.map(c => ({
          cid: createCID(c, CID_CONFIG.codec, rootHashCode),
          len: c.length,
        }));
        const rootFileData = new UnixFS({ type: "file", blockSizes: rootChunkLinks.map(c => BigInt(c.len)) });
        const rootDagNode = dagPB.prepare({ Data: rootFileData.marshal(), Links: rootChunkLinks.map(c => ({ Name: "", Tsize: c.len, Hash: c.cid })) });
        const rootDagBytes = dagPB.encode(rootDagNode);

        const phaseBChunkByCid = new Map<string, Uint8Array>();
        for (let i = 0; i < phaseB.chunkCids.length; i++) {
          phaseBChunkByCid.set(phaseB.chunkCids[i], phaseB.chunks[i]);
        }
        // Bounded like every chunk nonce (#1641); getters follow the provider across reconnects.
        const readReuploadNonce = boundedNonceReader({
          client: () => phaseALiveProvider.client, unsafeApi: () => phaseALiveProvider.unsafeApi,
          ss58: () => phaseALiveProvider.ss58 as string, fetchNonceFn: phaseALiveProvider.fetchNonce ?? fetchNonce,
        });

        for (let round = 1; round <= GRANDPA_REUPLOAD_MAX_ROUNDS && missingCids.size > 0; round++) {
          const roundSuffix = round > 1 ? ` (round ${round}/${GRANDPA_REUPLOAD_MAX_ROUNDS}, retry after fork)` : '';
          console.log(`   ${missingCids.size} chunks still missing after wait — re-uploading${roundSuffix}`);

          // Submit all re-uploads first (each takes a fresh nonce, so they must
          // be sequential), then poll all of them together in one shared loop.
          // Saves up to ~(N-1) × poll-interval vs. polling each chunk in turn.
          const reuploadList = [...missingCids];
          try {
            for (let i = 0; i < reuploadList.length; i++) {
              const cid = reuploadList[i];
              const freshNonce = await readReuploadNonce();
              if (cid === storageCid) {
                // Root re-upload: store_with_cid_config with DAG-PB codec.
                const rootTx = phaseALiveProvider.unsafeApi.tx.TransactionStorage.store_with_cid_config({
                  cid: { codec: BigInt(0x70), hashing: toHashingEnum(rootHashCode) },
                  data: rootDagBytes,
                });
                await watchTransaction(rootTx, phaseALiveProvider.signer as PolkadotSigner, { mortality: { mortal: true, period: 256 }, nonce: freshNonce }, () => storageCid, {
                  label: "root-reupload",
                  timeoutMs: CHUNK_TIMEOUT_MS,
                  confirmIncluded: () => cidPresentAtBest(phaseALiveProvider.client, storageCid),
                });
              } else {
                const chunkBytes = phaseBChunkByCid.get(cid);
                if (!chunkBytes) {
                  throw new Error(
                    `Deploy verification failed: chunk ${cid.slice(0, 20)}… missing at finalised head and ` +
                    `its bytes are not in phaseB.chunks (cannot re-upload). This indicates an internal state issue.`
                  );
                }
                await storeChunk(phaseALiveProvider.unsafeApi, phaseALiveProvider.signer as PolkadotSigner, chunkBytes, freshNonce, { client: () => phaseALiveProvider.client });
              }
              reuploadCount++;
              console.log(`      [${i + 1}/${reuploadList.length}] re-uploaded ${cid.slice(0, 20)}… (nonce ${freshNonce})`);
            }
          } catch (e: any) {
            // ChainHead disjointed mid-re-upload: rebuild the client and retry
            // this round on the fresh provider (the round counter bounds total
            // attempts; missingCids still drives what gets re-submitted). #946
            if (isConnectionError(e) && phaseALiveProvider.reconnect) {
              try { phaseALiveProvider.client!.destroy(); } catch { /* already dead */ }
              const fresh = await phaseALiveProvider.reconnect();
              phaseALiveProvider = { ...phaseALiveProvider, ...fresh };
              continue;
            }
            throw e;
          }

          await pollUntilFinalized(missingCids, GRANDPA_REUPLOAD_TIMEOUT_MS, phaseALiveProvider.client!);
        }

        if (missingCids.size > 0) {
          const stuck = [...missingCids][0];
          throw new Error(
            `Deploy verification failed: ${missingCids.size} chunk(s) not finalised after ${GRANDPA_REUPLOAD_MAX_ROUNDS} re-upload round(s) ` +
            `(first: ${stuck.slice(0, 20)}…). The chain may have dropped chunks due to a persistent fork. Re-run deploy.`
          );
        }
        if (reuploadCount > 0) {
          console.log(`   ✓ All ${grandpaCids.length - laggingFinalityCount} chunks finalised after re-upload`);
        } else {
          console.log(`   ✓ No chunks genuinely missing from best-block — skipped re-upload entirely`);
        }

        // Bounded extra wait for finality-lagging chunks (#1049). They are
        // NEVER re-uploaded — best-block already confirms them — this wait
        // is purely to let GRANDPA catch up before reporting. If it
        // expires, the deploy still succeeds: best-block presence of the
        // full chunk set + root is sufficient; finality remains a
        // best-effort/async confirmation.
        if (laggingCids.size > 0) {
          await pollUntilFinalized(laggingCids, GRANDPA_LAGGING_WAIT_MS, phaseALiveProvider.client!);
          if (laggingCids.size === 0) {
            console.log(`   ✓ finality-lagging chunk(s) caught up`);
          } else {
            console.warn(
              `   ⚠ ${laggingCids.size} chunk(s) still not finalised after extended wait, but confirmed present ` +
              `in best-block — deploy succeeds; finality pending asynchronously`
            );
          }
        }
      }
    }
    setDeployAttribute("deploy.probe.finality_miss_reupload_count", reuploadCount);
  }

  // Write persistent local cache so the next deploy can use the manifest without a chain fetch.
  // Stored outside buildDir so rebuilds (which wipe <buildDir>) don't invalidate it.
  // Best-effort: a failed write must not abort a successful deploy.
  if (opts.domain) {
    try {
      const manifestText = fs.readFileSync(path.join(directoryPath, MANIFEST_PATH), "utf8");
      writePersistentLocalManifest(opts.domain, storageCid, manifestText);
    } catch { /* best-effort */ }
  }

  if (storageCid !== predictedStorageCid) {
    captureWarning("computeStorageCid drift vs storeChunkedContent (v2)", {
      predicted: predictedStorageCid,
      uploaded: storageCid,
    });
  }

  // Pre-warm gateway caches for newly uploaded chunks (fire-and-forget).
  const newlyUploadedCids = carChunkCidsB.filter((c) => !trustedCidsB.has(c));
  if (newlyUploadedCids.length > 0 && gateway) {
    preWarmGateway(newlyUploadedCids, [gateway]);
  }

  // 10. Stats + telemetry.
  const retentionPeriodBlocks = await readRetentionPeriodBlocks(provider.unsafeApi);
  const filesStableCount = [...phaseA.fileCids.entries()].filter(([p, cid]) => {
    if (p === MANIFEST_PATH) return false;
    return classifyFile(p, { prevManifest, fileCid: cid, framework }) === "stable";
  }).length;
  const filesTotalCount = phaseA.fileCids.size - (phaseA.fileCids.has(MANIFEST_PATH) ? 1 : 0);
  // Build ChunkProbeResult array for computeStats from chunks that Phase A
  // actually probed. Trusted chunks (skipped by storeChunkedContent because
  // the prev manifest vouches for them) count as present without a probe.
  // Chunks NOT in phaseASkipProbeResults AND NOT in trustedCidsA were never
  // probed at all — typically sections 0 (manifest) and 2 (volatile), which
  // Phase A defers to Phase B. We omit them from probeResultsForStats rather
  // than fabricating "rpc_error" entries for them, which previously inflated
  // probedTotal and surfaced a misleading "N probe-failed (rpc_error)" row
  // on every deploy.
  type _CPR = import("./chunk-probe.js").ChunkProbeResult;
  const probeResultsForStats: _CPR[] = carChunkCidsA.flatMap((cid): _CPR[] => {
    if (trustedCidsA.has(cid)) return [{ cid, present: true, block: 0, index: 0 }];
    if (!phaseASkipProbeResults.has(cid)) return [];
    const present = phaseASkipProbeResults.get(cid);
    if (present === true) return [{ cid, present: true, block: 0, index: 0 }];
    if (present === false) return [{ cid, present: false }];
    return [{ cid, present: null, failureReason: "rpc_error" }];
  });
  // Chunk + byte totals combine BOTH phases. Phase A uploads section-1 chunks
  // it found absent; Phase B uploads everything that's NOT in trustedCidsB
  // (typically the manifest section + any volatile chunks whose CID differs
  // between A and B). Reporting Phase A's numbers alone hid Phase B's uploads;
  // reporting Phase B's alone hid Phase A's (Phase A uploads land in
  // trustedCidsB and look like skips from Phase B's perspective).
  let phaseBChunksUploaded = 0;
  let phaseBBytesUploaded = 0;
  for (let i = 0; i < phaseB.chunks.length; i++) {
    if (!trustedCidsB.has(phaseB.chunkCids[i])) {
      phaseBChunksUploaded++;
      phaseBBytesUploaded += phaseB.chunks[i].length;
    }
  }
  const chunksUploadedTotal = probeAbsent + phaseBChunksUploaded;
  const bytesUploadedTotal = bytesProbeAbsent + phaseBBytesUploaded;
  const chunksSkippedTotal = phaseB.chunks.length - chunksUploadedTotal;
  const bytesSkippedTotal = phaseB.carBytes.length - bytesUploadedTotal;
  const stats = computeStats({
    manifestSource: fetched.source,
    manifestFetchAttempts: fetched.source === "none" ? 0 : (fetched as any).attempts ?? 0,
    manifestFetchReason: fetched.source === "heuristic_fallback" ? (fetched as any).reason : undefined,
    manifestBytes: fetched.source === "embedded" ? ((fetched as any).bytesDownloaded ?? 0) : 0,
    framework,
    filesTotal: filesTotalCount,
    filesStable: filesStableCount,
    filesVolatile: filesTotalCount - filesStableCount,
    probeResults: probeResultsForStats,
    prevChunks: prevManifest?.chunks ?? {},
    retentionPeriodBlocks,
    bytesProbePresent,
    bytesProbeAbsent,
    bytesSkipped: bytesSkippedTotal,
    bytesUploaded: bytesUploadedTotal,
    chunksTotal: phaseB.chunks.length,
    chunksUploaded: chunksUploadedTotal,
    chunksSkipped: chunksSkippedTotal,
    carBytes: phaseB.carBytes.length,
    sectionSizes: phaseB.sectionSizes,
    tier2VerifiedCount: phaseBResult.tier2Verified,
    tier2InconclusiveCount: phaseBResult.tier2Inconclusive,
    tier2FallbackCount: phaseBResult.tier2Fallback,
  });
  for (const [k, v] of Object.entries(telemetryAttributes(stats))) {
    setDeployAttribute(k, v);
  }
  console.log("\n" + renderSummary(stats));

  // Last barrier before the caller invokes setContenthash: re-probe the
  // DAG-PB root at finalised head. Catches the narrow case where the root
  // was finalised at the GRANDPA probe above but became absent before the
  // caller writes the contenthash. Implausible on a healthy chain.
  //
  // Tolerance: a DEFINITIVE absent (present:false) does NOT fail immediately
  // — #1049 applies here too: the root may simply still be finality-lagging
  // (e.g. it was in the GRANDPA block's `lagging` set and the bounded wait
  // there expired without catching up). Route through the same
  // probeFinalityGap policy as the GRANDPA phase — only a root absent from
  // BEST-BLOCK too is genuinely evicted. Probe-failure (present:null, e.g.
  // transient RPC error) is treated as "unverifiable but the GRANDPA probe
  // seconds ago said present, so trust that".
  console.log(`   Final root check: ${storageCid}`);
  const rootProbe = await probeChunks([storageCid], { client: phaseALiveProvider.client!, atFinalized: true });
  if (rootProbe[0]?.present === false) {
    const { reallyMissing } = await probeFinalityGap([storageCid], { client: phaseALiveProvider.client! });
    if (reallyMissing.length > 0) {
      throw new Error(
        `Deploy verification failed: DAG-PB root ${storageCid.slice(0, 20)}… not finalised and not present in best-block. ` +
        `The chain may have evicted the root extrinsic. Re-run deploy.`
      );
    }
    console.log(`   Root confirmed present in best-block (finality-lagging, #1049) — treating as success.`);
  } else if (rootProbe[0]?.present === true) {
    console.log(`   ✓ Root finalised on chain`);
  } else {
    console.log(`   Root finality unverified (probe returned no answer); content is in best-block, continuing.`);
  }

  return { storageCid, ipfsCid: phaseB.cid, carBytes: phaseB.carBytes };
}

export interface DeployOptions {
  mnemonic?: string;
  /** Optional derivation path applied to the mnemonic (e.g. "//deploy/3"). Defaults to "" (root key). */
  derivationPath?: string;
  /**
   * Deploy as this product's derived account (RFC-0022 host derivation,
   * index 0) instead of the mnemonic's root account, so the deployed name is
   * owned by the account a host hands the product at runtime. Needs a
   * mnemonic; mutually exclusive with suri, derivationPath, and signer.
   * CLI: --product-name <name>
   */
  productName?: string;
  /**
   * Internal: the injected signer signs locally in-process, so no phone
   * ceremony gates its signatures. Set by the productName resolution;
   * genuine QR/mobile injected signers leave it unset.
   */
  localSigner?: boolean;
  /** Pre-built signer — skips mnemonic derivation. Use for QR/mobile signing. */
  signer?: PolkadotSigner;
  /** SS58 address for the signer (required when signer is provided). */
  signerAddress?: string;
  /**
   * Internal: `signer`/`signerAddress` were resolved from a phone-backed login
   * session (`resolveDeployActors`'s `actors.worker.source === "session"`), as
   * opposed to a local `--suri`/mnemonic-derived worker or a caller-injected
   * `PolkadotSigner` (programmatic callers, e.g. playground-cli). Set by
   * `deployActorsToSignerOptions`. Storage routing must not silently sign
   * Bulletin chunks with this signer when no allowance slot is available —
   * a session signer with no slot must route to pool instead. See bulletin #1452.
   */
  sessionSigner?: boolean;
  /** Slot-account signer for Bulletin chunk uploads. When set, used instead of pool/mnemonic
   *  for storage. DotNS still uses signer/signerAddress. */
  storageSigner?: PolkadotSigner;
  /** SS58 address of the slot account. Required when storageSigner is set. */
  storageSignerAddress?: string;
  /** Secret URI for dev signers (e.g. "//Alice" or a BIP-39 mnemonic). Passed to resolveSigner. */
  suri?: string;
  /** When signed in, deploy with a local worker signer and transfer the finished
   *  name to the signed-in account (zero mobile signatures). Default true.
   *  CLI: --no-transfer-to-signedin-user sets this false. */
  transferToSignedInUser?: boolean;
  /** Internal: recipient H160 for the post-deploy handover. Set by the resolve
   *  branch; callers normally let it be derived. */
  transferTo?: string;
  rpc?: string;
  poolSize?: number;
  password?: string;
  /** Use pure-JS merkleization instead of Kubo CLI. Required for WebContainer environments. */
  jsMerkle?: boolean;
  /**
   * Free-form label attached to the deploy span as `deploy.tag`. Used to separate
   * test/benchmark/canary runs from real-user traffic in Sentry dashboards
   * (e.g. "e2e-ci-pr", "load-test-a"). Falls back to DEPLOY_TAG env var.
   */
  tag?: string;
  /** Custom telemetry attributes, merged into the deploy span. Overrides auto-detected values. */
  attributes?: Record<string, string>;
  /** Skip the 500 MiB abort guard and allow oversized deploys. */
  allowLargeDeploy?: boolean;
  /**
   * Filesystem path to a pre-built `.car` file. When set, skips directory
   * scanning and merkleization; the CAR bytes are read from disk, the root
   * CID is parsed from the CAR header, and the file is uploaded directly.
   * The positional `<build-dir>` argument is not required when this is set.
   */
  inputCar?: string;
  /**
   * Pin the `deployedAt` timestamp for byte-identical rebuilds.
   * Values: "commit" (git committer date), "epoch:<N>" (Unix epoch seconds),
   * or any ISO 8601 string. Omit for a live wall-clock timestamp.
   */
  reproducibleSource?: string;
  /**
   * Environment id from environments.json (e.g. "paseo-next-v2", "paseo-review").
   * Drives both the bulletin RPC and the asset-hub RPC. Defaults to
   * DEFAULT_ENV_ID. `--rpc` / BULLETIN_RPC still override the bulletin endpoint
   * within the chosen env.
   */
  env?: string;
  /**
   * Pre-resolved bulletin endpoints (escape hatch for tests / library callers
   * that want to skip environments.json loading). When provided, the loader
   * is not called and `env` is ignored.
   */
  bulletinEndpoints?: string[];
  /** Pre-resolved asset-hub endpoints. Same escape-hatch semantics. */
  assetHubEndpoints?: string[];
  /**
   * Opt-in: write the pre-upload CAR file to disk after merkleization.
   * - `true` → write to `<buildDir>.bulletin.car` (default path).
   * - `string` → write to that explicit path.
   * - omitted / `false` → no file written (default).
   * Also honoured when `PAD_DUMP_CAR` env var is set (back-compat).
   * CLI: --dump-car[=<path>]
   */
  dumpCar?: string | boolean;
  /**
   * Override/supply DotNS contract addresses, shallow-merged OVER the chosen
   * env's `contracts` map (these win). The `custom` env ships no addresses, so
   * this is how they are provided. Keys are the DOTNS_* names used in
   * environments.json (e.g. DOTNS_REGISTRY, DOTNS_CONTENT_RESOLVER).
   * CLI: --contract <KEY>=<0xADDRESS> (repeatable).
   */
  contracts?: Record<string, string>;
  /**
   * Plan of phone signatures this deploy will need. Fired once, at preflight,
   * BEFORE storage. Notification only; used by the CLI bin to print the
   * "Have your phone ready" banner up front.
   */
  onPhoneSignaturePlan?: (steps: PhoneSignatureStep[]) => void;
  /**
   * Human-ready gate. Awaited immediately BEFORE each phone signature request
   * is sent. Resolve when the human is at their phone and ready; reject/throw
   * to abort. The per-signature operation timeout starts only AFTER this
   * resolves. `attempt` >= 2 means a re-sign.
   * Absent + non-TTY → fail fast (NonRetryableError).
   * Absent + TTY → CLI bin must supply the hook; core does not readline.
   *
   * `approvalBudgetMs` and `reason` (#194): widened to match dotns.ts's
   * ConnectOptions.confirmPhoneReady, which this field is passed straight
   * through to unchanged (see resolveDotnsConnectOptions call sites below).
   * `approvalBudgetMs` discloses the phone-approval silence deadline so the
   * CLI prompt never hardcodes a number that can drift from the constant that
   * actually governs it. `reason: "silence"` marks a watcher-silence re-arm
   * (re-prompt after no response) as distinct from the pre-existing re-sign
   * case (undefined/"resign").
   */
  confirmPhoneReady?: (ctx: { label: string; attempt: number; total: number; approvalBudgetMs: number; reason?: "resign" | "silence" }) => Promise<void>;
  /**
   * #1164: when set, the post-deploy console banner prints "CONTENT DEPLOYED
   * — publishing product manifest…" instead of "DEPLOYMENT COMPLETE!", and
   * the "Check it out here" browser-URL block is suppressed. The caller
   * (bin/polkadot-app-deploy) is then responsible for printing the real
   * completion banner itself, via `printDeploymentCompleteBanner`, once its
   * own subsequent `publishManifest()` call succeeds. Opt-in: every existing
   * library caller (e.g. playground-cli) leaves this unset and keeps today's
   * single-banner output.
   */
  manifestPending?: boolean;
}

// Shared by deploy() and publishManifest() so both derive the same key.
export function resolveProductSigner(
  options: Pick<DeployOptions, "productName" | "mnemonic" | "signer" | "signerAddress" | "suri" | "derivationPath">,
): Pick<DeployOptions, "signer" | "signerAddress" | "mnemonic" | "localSigner"> | null {
  if (!options.productName) return null;
  if (options.signer || options.signerAddress || options.suri || options.derivationPath) {
    throw new NonRetryableError("--product-name derives the signer itself; it cannot be combined with --suri, --derivation-path, or an external signer.");
  }
  const productMnemonic = resolveEffectiveMnemonic({
    flagMnemonic: options.mnemonic,
    envMnemonic: process.env.MNEMONIC,
    envDotnsMnemonic: process.env.DOTNS_MNEMONIC,
  });
  if (!productMnemonic) {
    throw new NonRetryableError("--product-name needs a mnemonic (--mnemonic or the MNEMONIC env var) to derive the product account from.");
  }
  const product = deriveProductSigner(productMnemonic, options.productName);
  console.log(`   Product deployer: ${product.ss58} (product ${product.productName}, index 0)`);
  return { signer: product.signer, signerAddress: product.ss58, mnemonic: undefined, localSigner: true };
}

// Resolve the DeployOptions that affect DotNS authentication into the shape
// DotNS.connect expects. Three branches:
//   1. external signer (QR/mobile): pass signer + signerAddress straight through.
//   2. mnemonic provided: pass mnemonic + derivationPath; DotNS combines them.
//   3. no mnemonic: still pass derivationPath if set, so DotNS.connect can
//      apply it to the MNEMONIC env-var fallback. This is the #209 fix —
//      pre-fix the derivationPath was silently dropped in pool mode.
// Pure function exported for unit tests; deploy()'s two DotNS.connect calls
// share this resolver to avoid drift.
export function resolveDotnsConnectOptions(
  options: Pick<DeployOptions, "mnemonic" | "derivationPath" | "signer" | "signerAddress">,
  assetHubEndpoints?: string[],
  autoAccountMapping?: boolean,
  contracts?: Record<string, string>,
  nativeToEthRatio?: bigint,
  environmentId?: string,
  popSelfServe?: PopSelfServeConfig | null,
  registerStorageDeposit?: bigint,
  tld?: string,
  contractSources?: Record<string, string>,
  // bulletin #1362/#1095: appended AFTER contractSources (rather than
  // inserted earlier in the positional list, as bulletin-deploy does) so
  // this port doesn't have to renumber the manifest/publish.ts call site
  // (a separate, non-deploy() publish flow, left untouched here — same
  // scoping bulletin's own #1221 applied to that file).
  network?: string,
): Pick<
  DotNSConnectOptions,
  | "signer"
  | "signerAddress"
  | "mnemonic"
  | "derivationPath"
  | "assetHubEndpoints"
  | "autoAccountMapping"
  | "contracts"
  | "nativeToEthRatio"
  | "environmentId"
  | "popSelfServe"
  | "registerStorageDeposit"
  | "tld"
  | "contractSources"
  | "network"
> {
  const tail = assetHubEndpoints && assetHubEndpoints.length > 0 ? { assetHubEndpoints } : {};
  const mappingTail = autoAccountMapping ? { autoAccountMapping } : {};
  const contractsTail = contracts && Object.keys(contracts).length > 0 ? { contracts } : {};
  const sourcesTail = contractSources && Object.keys(contractSources).length > 0 ? { contractSources } : {};
  const ratioTail = nativeToEthRatio ? { nativeToEthRatio } : {};
  const envTail = environmentId ? { environmentId } : {};
  const popTail = popSelfServe !== undefined ? { popSelfServe } : {};
  const storageTail = registerStorageDeposit !== undefined ? { registerStorageDeposit } : {};
  const tldTail = tld !== undefined ? { tld } : {};
  // bulletin #1362/#1095: only set when defined — omitting it (rather than
  // sending an explicit undefined) preserves DotNS's own instance-field
  // default and matches every other optional tail above.
  const networkTail = network !== undefined ? { network } : {};
  if (options.signer && options.signerAddress) {
    return { signer: options.signer, signerAddress: options.signerAddress, ...tail, ...mappingTail, ...contractsTail, ...sourcesTail, ...ratioTail, ...envTail, ...popTail, ...storageTail, ...tldTail, ...networkTail };
  }
  return { mnemonic: options.mnemonic, derivationPath: options.derivationPath, ...tail, ...mappingTail, ...contractsTail, ...sourcesTail, ...ratioTail, ...envTail, ...popTail, ...storageTail, ...tldTail, ...networkTail };
}

// bulletin #1221: the planned action to size a post-preflight auto-map
// top-up (topUpTargetFor's first arg). Once preflight has run, use its REAL
// plannedAction rather than assuming "register", so an owned action's
// (smaller) floor is requested instead. "abort" can't actually reach here
// (deploy() throws on !dotnsPreflight.canProceed before either post-preflight
// connect site), but the type is wider than DotnsSuccessAction, so fall back
// to "register" defensively rather than assert past it.
export function autoMapPlannedActionFor(dotnsPreflight: DotnsPreflightResult | null): DotnsSuccessAction {
  return dotnsPreflight && dotnsPreflight.plannedAction !== "abort" ? dotnsPreflight.plannedAction : "register";
}

// Upper-bound estimate of how many bytes this deploy will push to Bulletin.
// Used to size the defensive pre-authorization. Returns null if the input
// can't be measured cheaply (caller should skip the defensive top-up).
export async function estimateUploadBytes(content: DeployContent): Promise<number | null> {
  try {
    if (Array.isArray(content)) {
      return content.reduce((s, c) => s + c.length, 0);
    }
    if (content instanceof Uint8Array) {
      return content.length;
    }
    const resolved = path.resolve(content);
    if (!fs.existsSync(resolved)) return null;
    const st = fs.statSync(resolved);
    if (st.isFile()) return st.size;
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile()) total += fs.statSync(child).size;
      }
    };
    walk(resolved);
    return total;
  } catch {
    return null;
  }
}

/**
 * Throws NonRetryableError if a subdomain is owned by a different address
 * than the current signer. Called in the preflight branch before chunk upload.
 * Issue #562: preflight was only checking `owned`, not comparing `owner`.
 */
export function assertSubdomainOwnerMatchesSigner(
  result: { owned: boolean; owner: string | null | undefined },
  signerEvmAddress: string | null | undefined,
  sublabel: string,
  parentLabel: string,
  tld: string = DEFAULT_TLD,
): void {
  if (result.owned && result.owner?.toLowerCase() !== signerEvmAddress?.toLowerCase()) {
    throw new NonRetryableError(
      `Subdomain ${sublabel}.${parentLabel}.${tld} is already owned by ${result.owner} (signer is ${signerEvmAddress}). ` +
      `Use a fresh subdomain label, or release the existing registration.`
    );
  }
}

/**
 * An unregistered, non-registrable parent (a governance-reserved name) used
 * to yield "parent game.dot is owned by no one, not by this signer" —
 * awkward, and silent about the only route forward. When the parent is
 * non-registrable per classifyRegistrability AND unowned, this additionally
 * teaches the dotns-cli whitelisted-registration route, via the SAME
 * formatUnregistrableReason preflight/register() use, so the texts cannot
 * drift.
 *
 * bulletin-deploy #1380 (issue #1062): the two remaining branches used to
 * name the problem but not the remedy — recurring on a consumer's
 * per-branch preview deploys, each one only discovered after
 * connect/build/upload had already run. Both branches now name a concrete
 * next step:
 *   - unregistered, registrable parent: deploying the parent directly IS the
 *     registration path (this CLI has no separate register-only command),
 *     so the remedy is that same command aimed at the parent.
 *   - owned by another account: this signer cannot self-serve. The only
 *     route is the current owner handing the name over. Verified against
 *     src/commands/transfer.ts: `runTransfer` always signs as
 *     `opts.mnemonic ?? DEFAULT_MNEMONIC` (Alice's dev key) — never from a
 *     session — so the hint MUST include --mnemonic for the owner's own
 *     key, or run verbatim it connects as Alice and fails with "it is owned
 *     by ..., not the worker <alice-address>" (DotNS.transferName). Only
 *     --to may default (to the signed-in session). selfAddress can be ""
 *     (the call site passes `preflight.evmAddress ?? ""`), so the transfer
 *     hint is only emitted when it's non-empty — a dangling `--to ` is worse
 *     than no hint.
 * Neither addition weakens the refusal: both still throw, they only add an
 * actionable line after the unchanged "is owned by ..." sentence that
 * telemetry's naming.subdomain_orphan classifier keys on (src/telemetry.ts).
 *
 * bulletin-deploy #1443 added two more fixes on top:
 *   - `parentOwner` is now read via checkNodeAuthorization's isAuthorised-
 *     backed owner(node), which can return the zero address for a node that
 *     was never created — normalised to the unowned branch here, since the
 *     burn sentinel is not an account anyone can be asked to transfer from.
 *   - once nested subnames are allowed, `parentLabel` may itself be a
 *     multi-label path ("app.supafaust"). Such a parent cannot be registered
 *     directly, so an unowned nested parent names the immediate requirement
 *     (whoever owns the grandparent must create and hand it over) instead of
 *     emitting a register command that would fail for the same reason.
 */
export function formatSubdomainParentError(
  fullName: string,
  parentLabel: string,
  parentOwner: string | null,
  selfAddress: string,
  // #1419: tld and profile were both stale implicit defaults (DEFAULT_TLD /
  // the old poprules-startingPrice profile) — exactly the class of bug the
  // comment below used to warn about, just one layer further out. Both are
  // now required so a caller can't silently inherit a generation that
  // describes no environment this repo talks to.
  tld: string,
  // Without this, a v0.6.0 environment would silently fall back to
  // poprules-startingPrice's (stricter, digit-stripping) label semantics
  // here — the exact class of bug the profile-aware classifier exists to
  // close, just at a call site outside src/dotns.ts.
  profile: DotnsAbiProfile,
): string {
  // bulletin-deploy #1443: a zero-address owner is the registry's "no owner"
  // sentinel, not an account. Callers now read it straight off
  // isAuthorised-backed owner(node) (checkNodeAuthorization), which returns
  // 0x000...0 for a node that was never created — so without this the
  // owned-by-someone-else branch below would fire and tell the caller to ask
  // the burn address for its private key. Normalise it to the unowned
  // branch, which already says the right thing.
  const owner = parentOwner !== null && /^0x0{40}$/i.test(parentOwner) ? null : parentOwner;
  // bulletin-deploy #1443: a nested parent ("app.supafaust") cannot be
  // registered as a base name, so the "register the parent" remedy below
  // would emit a command that fails for the same reason. Name the immediate
  // requirement instead.
  const parentIsNested = parentLabel.includes(".");
  if (owner === null && parentIsNested) {
    return `Cannot deploy ${fullName}: parent ${parentLabel}.${tld} does not exist.\n\n` +
      `It is itself a subname, so it cannot be registered directly — whoever owns ` +
      `${parentLabel.slice(parentLabel.indexOf(".") + 1)}.${tld} has to create it first, then hand it to ` +
      `this signer (${selfAddress || "this account"}).`;
  }
  if (owner !== null) {
    const transferBullet = selfAddress
      ? `  - ask the ${owner} account to hand the parent to this signer, run BY that account: ${CLI_NAME} transfer ${parentLabel}.${tld} --to ${selfAddress} --mnemonic <the ${owner} account's key>\n`
      : "";
    const ownedParentBullet = `  - deploy the subdomain under a parent this signer already owns instead.`;
    return `Cannot deploy ${fullName}: parent ${parentLabel}.${tld} is owned by ${owner}, not by this signer.\n\n` +
      (transferBullet ? `Either:\n${transferBullet}${ownedParentBullet}` : ownedParentBullet);
  }
  const registrability = classifyRegistrability(parentLabel, profile);
  if (registrability.registrable) {
    return `Cannot deploy ${fullName}: parent ${parentLabel}.${tld} is owned by no one, not by this signer.\n\n` +
      `Register the parent with this signer first, then redeploy the subdomain unchanged:\n` +
      `  ${CLI_NAME} <build-dir> ${parentLabel}.${tld}`;
  }
  return `Cannot deploy ${fullName}: parent ${formatUnregistrableReason({ label: parentLabel, registrability, existingOwner: null, selfAddress, tld, profile })}`;
}

/**
 * Returns the browser URL for the given domain name, optionally suffixed
 * with a network query parameter so the SPA opens the right chain.
 * Currently only the "preview" env needs a suffix — the SPA defaults to
 * paseo-next-v2 which would show "no content" for preview deployments.
 *
 * The gateway host defaults to "dot.li" (issue #142: devnet-family names are
 * NOT resolvable via dot.li — they're served by a different gateway, e.g.
 * "dev-dot.li" — so callers must pass the resolved env's `webGateway` when
 * one is set; otherwise the link loads but resolves the name against the
 * wrong network).
 * @param name - the DotNS label (e.g. "myapp")
 * @param envId - the environment id from options.env ?? DEFAULT_ENV_ID
 * @param webGateway - the resolved env's `webGateway`, if any (defaults to "dot.li")
 */
export function browserUrlFor(name: string, envId: string | undefined, webGateway?: string): string {
  const host = webGateway ?? "dot.li";
  const base = `https://${name}.${host}`;
  return envId === "preview" ? `${base}?network=previewnet` : base;
}

// ── P2P retrieval liveness probe (issue #456) ─────────────────────────────
// PROPAGATION/LIVENESS PROXY only — bitswap_v1_get runs from the RPC node's
// privileged vantage (direct validator links, possibly its own block store).
// A green result does NOT guarantee an external consumer (browser Helia /
// smoldot light client) can retrieve the content — they use a different
// transport path (WebRTC/WSS to the broader validator swarm). A true
// consumer-vantage guarantee requires headless dot.li/Helia, out of scope here.

export type BitswapErrorVariant = "none" | "not_found" | "timeout" | "error";

export interface BitswapProbeResult {
  retrievable: boolean;
  errorVariant: BitswapErrorVariant;
  durationMs: number;
}

/**
 * Pure classifier — maps a raw response or thrown error to {retrievable, errorVariant}.
 * Exported for unit tests; does NOT touch telemetry or console.
 */
export function interpretBitswapResult(
  outcome: { ok: true; response: unknown } | { ok: false; error: unknown }
): { retrievable: boolean; errorVariant: BitswapErrorVariant } {
  if (outcome.ok) {
    return { retrievable: true, errorVariant: "none" };
  }
  const err = outcome.error;
  // NotFound: code -32810 — content is valid-looking CID but not in RPC node's store
  if (err != null && typeof err === "object" && "code" in err && (err as any).code === -32810) {
    return { retrievable: false, errorVariant: "not_found" };
  }
  // Timeout sentinel thrown by the Promise.race below
  if (err instanceof Error && err.message === "p2p_probe_timeout") {
    return { retrievable: false, errorVariant: "timeout" };
  }
  // All other errors (network reset, malformed response, etc.)
  return { retrievable: false, errorVariant: "error" };
}

/**
 * Calls bitswap_v1_get on the bulletin RPC client for the given base32 CIDv1 string.
 * Never throws — wraps every outcome in BitswapProbeResult.
 * @param client - polkadot-api client (ProviderResult.client)
 * @param cid    - base32 CIDv1 string (e.g. "bafyrei...")
 * @param timeoutMs - safety ceiling; the RPC typically responds in ~600ms
 */
export async function probeP2pRetrieval(
  client: any,
  cid: string,
  timeoutMs = 3_000
): Promise<BitswapProbeResult> {
  const t0 = Date.now();
  let outcome: { ok: true; response: unknown } | { ok: false; error: unknown };
  try {
    const timeoutError = new Error("p2p_probe_timeout");
    const response = await Promise.race([
      client._request("bitswap_v1_get", [cid]),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(timeoutError), timeoutMs);
        // Prevent the timer from keeping the Node.js event loop alive after a
        // fast RPC response. Without this the CLI would stall ~timeoutMs on success.
        if (typeof t === "object" && t !== null && typeof (t as any).unref === "function") {
          (t as any).unref();
        }
      }),
    ]);
    outcome = { ok: true, response };
  } catch (err) {
    outcome = { ok: false, error: err };
  }
  const durationMs = Date.now() - t0;
  const { retrievable, errorVariant } = interpretBitswapResult(outcome);
  return { retrievable, errorVariant, durationMs };
}

export async function deploy(content: DeployContent, domainName: string | null = null, options: DeployOptions = {}): Promise<DeployResult> {
  // A mnemonic and an external signer are two ways to name the same thing — the
  // single account that signs both Bulletin storage and DotNS. Passing both is
  // contradictory (and would silently route storage to the signer while the
  // caller may expect the mnemonic). Reject up front rather than pick one.
  if (options.signer && options.signerAddress && options.mnemonic) {
    throw new NonRetryableError("Pass either a mnemonic or an external signer, not both — they identify the signing account and only one can win.");
  }
  bulletinNetwork = undefined; // bulletin #1362/#1095: reset per-deploy; set from the resolved env below
  // Product-name deploys resolve to an injected signer up front: the product
  // account derived from the mnemonic per RFC-0022 signs storage and DotNS
  // alike, so the deployed name is owned by the very account a host hands the
  // product at runtime. Resolved here, before signer-choice, so the rest of
  // the pipeline sees a plain injected signer and needs no product awareness.
  options = { ...options, ...resolveProductSigner(options) };
  // Resolve the target environment. options.bulletinEndpoints / assetHubEndpoints
  // bypass the loader for tests and library callers.
  const envId = options.env ?? DEFAULT_ENV_ID;
  let envBulletin: string[] = [DEFAULT_BULLETIN_RPC];
  let envAssetHub: string[] | undefined;
  let envSource: string | undefined;
  let envUserFilePath: string | undefined;
  let envUserFileKeys: string[] | undefined;
  let envNetwork: string | undefined;
  let envName: string | undefined;
  let envIpfs: string | undefined;
  let envWebGateway: string | undefined;
  let envAutoAccountMapping = false;
  let envContracts: Record<string, string> = {};
  let envNativeToEthRatio: bigint | undefined;
  let envRegisterStorageDeposit: bigint | undefined;
  let envPopSelfServe: PopSelfServeConfig | null = null;
  let envTld: string = DEFAULT_TLD;
  // Undefined-preserving twin of envTld: unlike envTld (defaulted to "dot"
  // for display/pre-connect parsing), this is what actually reaches
  // DotNS.connect()'s `tld` option below. If it were defaulted here too,
  // connect()'s `if (options.tld === undefined)` on-chain-read branch would
  // NEVER fire for an env that genuinely configures no tld (e.g. devnet) —
  // the whole point of the dotns PR #218 resolution order (env config >
  // on-chain read > DEFAULT_TLD) would be dead code. Keep this
  // `string | undefined` all the way to every resolveDotnsConnectOptions()
  // call site; never apply `?? DEFAULT_TLD` to it.
  let envConfiguredTld: string | undefined;
  if (options.bulletinEndpoints && options.bulletinEndpoints.length > 0) {
    envBulletin = options.bulletinEndpoints;
    envAssetHub = options.assetHubEndpoints;
  } else {
    try {
      const { doc, source, userFilePath, userFileContractKeys } = await loadEnvironments();
      const resolved = resolveEndpoints(doc, envId);
      envBulletin = resolved.bulletin;
      envAssetHub = options.assetHubEndpoints ?? resolved.assetHub;
      envSource = source;
      envUserFilePath = userFilePath;
      envUserFileKeys = userFileContractKeys?.[envId];
      // bulletin #1362/#1095: once an env WAS resolved (this try block
      // succeeded), a missing `network` field is a config gap, not "no env
      // context" — normalize to the "unknown" sentinel so
      // detectTestnet()/isTestnet() fail CLOSED (not-testnet) instead of
      // falling through to a live spec_name guess. envNetwork stays
      // genuinely `undefined` only when this whole block is skipped
      // (options.bulletinEndpoints) or throws — the one case where the
      // spec_name fallback is still the intended behavior.
      envNetwork = resolved.network ?? "unknown";
      envName = resolved.envName;
      envIpfs = resolved.ipfs;
      envWebGateway = resolved.webGateway;
      envAutoAccountMapping = resolved.autoAccountMapping;
      envContracts = resolved.contracts;
      envNativeToEthRatio = resolved.nativeToEthRatio;
      envRegisterStorageDeposit = resolved.registerStorageDeposit;
      envTld = resolved.tld ?? DEFAULT_TLD;
      envConfiguredTld = resolved.tld;
      envPopSelfServe = getPopSelfServeConfig(doc, envId);
      bulletinNetwork = envNetwork; // already normalized (resolved.network ?? "unknown") above
    } catch (e) {
      if (e instanceof NonRetryableError) throw e;
      if (options.env !== undefined) throw e;
      captureWarning(`environments load failed: ${(e as Error)?.message ?? e}`);
    }
  }
  // CLI/library-supplied contract addresses win over the env's map. The `custom`
  // env intentionally ships no addresses, so they must be provided this way.
  const contractSources = describeContractSources(envContracts, options.contracts, envSource, envUserFilePath, envId, envUserFileKeys);
  if (options.contracts && Object.keys(options.contracts).length > 0) {
    envContracts = { ...envContracts, ...options.contracts };
  }
  BULLETIN_ENDPOINTS = resolveBulletinEndpoints(envBulletin, options.rpc);
  _deployRpcFailedOver = false;
  POOL_SIZE = options.poolSize ?? parseInt(process.env.BULLETIN_POOL_SIZE ?? String(DEFAULT_POOL_SIZE), 10);

  // Signer resolution — "resolve" fires ONLY when --suri is explicitly passed.
  // Pool mode (no mnemonic, no signer, no suri) falls through unchanged — no SSO load.
  // Injected signer (options.signer) and mnemonic paths are also unchanged.

  // Validate the label up-front (parseDomainName runs the pure, chain-free
  // validateDomainLabel) so a syntactically-invalid one — bad charset, wrong
  // length, or an edge hyphen — fails before we print a signer plan that can
  // never matter. A Reserved/PopRules-shaped label (e.g. a <=5-char base name)
  // is NOT rejected here: parseDomainName always succeeds for those now,
  // since the signer might legitimately own the name (registerReserved
  // bypasses PopRules on-chain). That decision moved to ownership-aware
  // preflight — see classifyRegistrability/decideRegistrabilityOutcome in
  // src/dotns.ts.
  // `let`, not `const`: refreshed once the preflight connect resolves the
  // AUTHORITATIVE on-chain TLD (see the `parsed = { ...parsed, fullName: ... }`
  // reassignment below) — `fullName` embeds whichever `envTld` was current at
  // THIS parse, which on an env with no configured tld is still the
  // pre-connect DEFAULT_TLD guess, not necessarily the real one.
  let parsed: ParsedDomainName | null = domainName ? parseDomainName(domainName, envTld) : null;
  // bulletin-deploy #1443/#1449: subname depth is observed, not gated —
  // parseDomainName never refuses on depth grounds. Print a factual,
  // no-advice notice when nesting goes past the ordinary case (a parent path
  // containing a dot, i.e. more than 2 labels before the TLD), so a typo or a
  // doubled suffix is obvious on sight. Nothing is being blocked here, so
  // there's no remedy to offer.
  if (parsed?.isSubdomain && parsed.parentLabel!.includes(".")) {
    const levels = subnameNestingLevels(1 + parsed.parentLabel!.split(".").length);
    console.log(`   NOTE: "${domainName}" parses as sublabel "${parsed.sublabel}" under parent path "${parsed.parentLabel}.${envTld}" (${levels} levels of subname nesting).`);
  }

  let sessionCleanup: (() => void) | undefined;
  // Cheap session-file probe — does NOT load the SSO stack. A logged-in user has
  // the SSO session file on disk; headless/CI deploys don't, so they never enter
  // the "resolve" branch and never load SSO / hit the People chain.
  const hasSession = hasPersistedSession();
  const signerChoice = chooseSignerInput({
    mnemonic: options.mnemonic,
    suri: options.suri,
    hasInjectedSigner: !!(options.signer && options.signerAddress),
    hasSession,
  });
  // An explicit mnemonic (from --mnemonic OR the MNEMONIC/DOTNS_MNEMONIC env
  // vars) always wins over a persisted login session — chooseSignerInput
  // already encodes that precedence. Surface it so the override is visible
  // instead of silent: without this, a signed-in user setting MNEMONIC for a
  // one-off deploy would see no indication their session was bypassed.
  if (signerChoice === "mnemonic" && hasSession) {
    console.error("Using the provided mnemonic; the persisted login session will be ignored for this deploy.");
  }
  // userSession is set when the resolve path finds a session — used below for
  // slot-key allocation which is available to any caller, not just the resolve path.
  // Typed as any to avoid importing UserSession from @parity/product-sdk-terminal here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolvedUserSession: any = undefined;

  if (signerChoice === "resolve") {
    // --suri (dev account / mnemonic) OR a persisted login session → resolve a signer.
    const { resolveDeployActors } = await import("./deploy-actors.js");
    const { getAuthClient } = await import("./auth-config.js");
    const authClient = await getAuthClient(envId);
    // env.network drives the testnet gate without a chain call.
    const isTestnetEnv = envNetwork === "testnet";
    const transferEnabled = options.transferToSignedInUser !== false; // default true
    try {
      const actors = await resolveDeployActors(authClient, {
        suri: options.suri,
        transferEnabled,
        isTestnet: isTestnetEnv,
        sessionPresent: hasSession,
      });
      options = { ...options, ...deployActorsToSignerOptions(actors) };
      sessionCleanup = actors.worker.destroy.bind(actors.worker);
      if (actors.worker.source === "session") resolvedUserSession = actors.worker;
      if (actors.recipientH160) {
        // #60: state only the worker's certain role here — it signs Bulletin
        // storage. Whether a transfer happens depends on ownership, which isn't
        // known until the DotNS preflight below; the transfer-vs-owned-update
        // reality is announced there (formatTransferModeDotnsLine).
        console.log(`   Worker: ${actors.worker.source} signer ${actors.worker.address} (signs Bulletin storage)`);
      } else {
        console.log(`   Using ${actors.worker.source} signer: ${actors.worker.address}`);
      }
    } catch (e) {
      if ((e as { name?: string } | null)?.name === "SignerNotAvailableError") {
        // #234 (see src/deploy-actors.ts's resolveDeployActors for the full
        // rationale): fail fast, before any chain write, instead of falling
        // through to the default dev signer. hasSession is always true here —
        // chooseSignerInput only returns "resolve" without an explicit --suri
        // when hasSession is true, and resolveDeployActors only throws this
        // class when sessionPresent is true.
        throw new NonRetryableError(STALE_SESSION_DEPLOY_MESSAGE);
      }
      throw e; // includes MainnetDefaultWorkerError — surface it
    }
  }

  // SSS preflight: check Statement Store allowance via pure state_getStorage — no
  // transaction, no phone dialog. Only for session signers; mnemonic/--suri signers
  // never have an SSS allowance and must not enter this check.
  //
  // We check the session's LOCAL (statement-signing) account, not the product
  // account. The product account signs on-chain extrinsics and never writes to
  // the statement store, so its `:statement_allowance:` key is always null —
  // checking it blocks every valid session (the bug fixed here). The local
  // account is the one that publishes Request statements to relay signing to the
  // phone, so the chain grants its allowance at login. See sss-allowance.ts.
  const statementAccount = resolvedUserSession && options.signer
    ? statementSigningAccount(resolvedUserSession.userSession)
    : null;
  if (statementAccount) {
    try {
      if (process.env.DOT_DEBUG) {
        const { ss58Encode } = await import("@parity/product-sdk-address");
        console.log(`   [sss] checking statement-store allowance for ${ss58Encode(statementAccount)}`);
      }
      // Cached preflight: skips the chain read on a same-period hit, falls
      // through to the authoritative read on a miss. See sss-allowance-cache.ts.
      const allowed = await preflightSssAllowance(statementAccount, () => getPeopleChainEndpoints(envId));
      if (allowed === false) {
        throw new NonRetryableError(SESSION_EXPIRED_MESSAGE);
      }
      // allowed === null → People chain unreachable; don't block the deploy.
    } catch (e) {
      if (e instanceof NonRetryableError) throw e;
      // Any other error (network, bad endpoint) — skip the check, don't block.
    }
  }

  // Resolve user-owned slot-account signer for Bulletin storage (#19).
  // Precedence: storageSigner (explicit, pre-built) > signer (external PolkadotSigner) >
  //   mnemonic (direct) > session-derived slot (new, this block) > pool.
  //
  // resolveStorageSigner handles steps 3–4:
  //   3. Cache-hit: adapter.allowance.getBulletinSigner → user's own Bulletin slot.
  //   4. Cache-miss (NotAvailable/Rejected): prompt then requestResourceAllocation
  //      ([BulletInAllowance]) → newly-allocated slot. Ctrl-C → pool.
  //
  // Layer-3 isolation: when resolvedUserSession is null (no session file, no --suri),
  // resolveStorageSigner returns null immediately — the SSO stack is never loaded.
  // Pool is always the final fallback; nothing here aborts the deploy.
  if (!options.storageSigner) {
    const { ss58Encode } = await import("@parity/product-sdk-address");
    const slotResult = await resolveStorageSigner(
      resolvedUserSession ?? null,
      {
        getBulletinSigner: (sessionId, productId, adapter) =>
          adapter.allowance.getBulletinSigner(sessionId, productId),
        requestResourceAllocation,
        createSlotAccountSigner,
        ss58Encode: (pk) => ss58Encode(pk),
        promptBeforeAllocation: () => {
          console.log(
            `\n⚠  Your account has no Bulletin allowance. ` +
            `Approve one on your phone to deploy with your own account, ` +
            `or press Ctrl-C to use the shared pool.`,
          );
        },
      },
    );
    if (slotResult) {
      options = { ...options, storageSigner: slotResult.signer, storageSignerAddress: slotResult.slotAddress };
      console.log(formatStorageSignerLine(slotResult.slotAddress, undefined, slotResult.owned));
    } else if (options.transferTo && options.signerAddress) {
      // Transfer mode: the local worker signs the whole deploy, including Bulletin
      // storage — it is NOT a pool fallback. Label it as the worker so the line
      // agrees with the "Using external signer: <worker>" line that follows, and
      // doesn't mislead a signed-in user (supersedes the #892 "pool fallback
      // (transfer mode …)" wording, which read as a contradiction).
      console.log(formatTransferModeStorageSignerLine(options.signerAddress));
    } else {
      // Non-transfer fallback: a logged-in user whose slot allocation failed sees
      // "no allowance"; an anonymous pool deploy sees "(no session)" (#892).
      const storageFailReason = resolvedUserSession ? "no allowance" : undefined;
      console.log(formatStorageSignerLine(null, storageFailReason));
    }
  }

  initTelemetry();
  const randomSuffix = Math.floor(Math.random() * 100).toString().padStart(2, "0");
  const name = parsed ? parsed.label : `test-domain-${Date.now().toString(36)}${randomSuffix}`;

  const phoneSignerActive = isPhoneSignerActive(options);

  try {
  return await withDeploySpan(name, async () => {
    const deployTag = options.tag ?? process.env.DEPLOY_TAG;
    if (deployTag) {
      setDeployAttribute("deploy.tag", deployTag);
      // Also expose as a Sentry scope tag so captureWarning / captureException
      // events carry it — lets the E2E Health dashboard's Errors-dataset
      // filter on deploy.tag work for the warning widgets.
      setDeploySentryTag("deploy.tag", deployTag);
    }
    setDeployAttribute("deploy.env", envId);
    setDeployAttribute("deploy.label", parsed?.label ?? name);
    setDeployAttribute("deploy.subdomain", String(parsed?.isSubdomain ?? false));
    // bulletin-deploy #1443/#1449: recorded on every subname deploy (not only
    // the unusually deep ones) so it has a baseline to compare against — a
    // metric that only appears in the unusual case can't show whether nested
    // names are rare or routine. 1 = the ordinary case (a single-label
    // parent); numeric, not a String()-wrapped value, so it aggregates in
    // Sentry.
    if (parsed?.isSubdomain) {
      setDeployAttribute("deploy.dotns.subname_levels", subnameNestingLevels(1 + parsed.parentLabel!.split(".").length));
    }
    if (envNetwork) setDeployAttribute("deploy.network", envNetwork);
    if (envSource) setDeployAttribute("deploy.environments_source", envSource);
    setDeployAttribute("deploy.transfer.enabled", options.transferTo ? "true" : "false");

    let cid: string | undefined;
    let ipfsCid: string | undefined;
    console.log("\n" + "=".repeat(60));
    console.log(`DEPLOYING TO TESTNET                    v${VERSION}`);
    console.log("=".repeat(60));
    if (envName) console.log(`   Environment: ${envName}`);
    // NOT printed here: on an env with no configured `tld`, envTld at this
    // point is still the pre-connect DEFAULT_TLD guess, not the real
    // on-chain value — printing it now could show "name.dot" for a
    // paseo-next-v2-shaped env whose actual TLD is ".paseo". The "Domain:"
    // line prints below, right after the preflight connect resolves the
    // AUTHORITATIVE tld (see `envTld = preflight.tld` in the Preflight
    // section) — no user-visible line ever renders the domain with a
    // not-yet-confirmed TLD.
    if (deployTag) console.log(`   Tag: ${deployTag}`);
    if (options.inputCar) console.log(`   Input CAR: ${path.resolve(options.inputCar)}`);
    else if (typeof content === "string") console.log(`   Build dir: ${path.resolve(content)}`);
    if (process.env.CI) console.log(`   Runner: ${resolveRunner()} (${resolveRunnerType()})`);
    if (options.password) console.log(`   Encrypted: yes`);

    let provider: ProviderResult | undefined;
    // Every Bulletin client this deploy opens, so the finally below can close the
    // ones a mid-upload reconnect handed to storeDirectoryV2 (#1672).
    const openedClients: any[] = [];
    const openStorageProvider = selectStorageReconnect(options);
    const reconnect = async (): Promise<ProviderResult> => {
      const p = await openStorageProvider();
      openedClients.push(p.client);
      return p;
    };
    // Hoisted so the DotNS phase below can reuse the pre-upload eligibility
    // result when deciding whether registration can continue.
    let dotnsPreflight: DotnsPreflightResult | null = null;
    // Hoisted so the storage phase below can pass it to storeDirectoryV2
    // for incremental upload. Resolved during preflight (or null if no
    // existing contenthash / read failed). Decoded from on-chain e3-prefixed
    // bytes to the IPFS CID string.
    let previousContenthashCid: string | null = null;
    try {
      // Check domain ownership before uploading anything
      console.log("\n" + "=".repeat(60));
      console.log("Preflight");
      console.log("=".repeat(60));


      const preflight = new DotNS();
      await preflight.connect({
        ...resolveDotnsConnectOptions(options, envAssetHub, envAutoAccountMapping, envContracts, envNativeToEthRatio, envId, envPopSelfServe, envRegisterStorageDeposit, envConfiguredTld, contractSources, envNetwork),
        // bulletin #1221: plannedAction isn't known until preflight() runs below, so
        // assume "register" (see AUTO_MAP_RENT_HEADROOM's doc comment in dotns.ts for the cost).
        autoMapTopUpTarget: topUpTargetFor("register", envRegisterStorageDeposit, AUTO_MAP_RENT_HEADROOM),
      });
      // connect() now guarantees the account is mapped before returning — no
      // post-connect mapping wait needed here. See DotNS.connect() in dotns.ts.
      // Adopt the authoritative, chain-resolved TLD for everything downstream
      // (display strings, the two later resolveDotnsConnectOptions() calls'
      // pre-connect siblings, etc.) — envTld before this point may still be
      // DEFAULT_TLD even on an env whose real on-chain TLD differs, because
      // it was set before connect() had a chance to read the chain.
      envTld = preflight.tld;
      // `fullName` was computed by the pre-connect parseDomainName() call
      // using whatever envTld was current THEN — refresh it now that envTld
      // is authoritative, so no downstream message (subdomain ownership
      // errors, previous-contenthash lookups, etc.) can embed a stale TLD.
      // `fullName` is always `${label}.${tld}` for both the top-level and
      // subdomain shapes (see parseDomainName), so this is a safe, complete
      // recomputation without re-invoking the parser (which could spuriously
      // re-trigger its wrong-TLD guard on an input that already parsed
      // successfully once).
      if (parsed) parsed = { ...parsed, fullName: `${parsed.label}.${envTld}` };
      // First point in this deploy where the domain's REAL TLD is known — see
      // the comment at the earlier (now TLD-less) banner print above for why
      // this line doesn't fire any sooner.
      console.log(`   Domain: ${name}.${envTld}`);

      // Subdomain deploys use a different on-chain path (setSubnodeOwner on
      // the Registry, no commit-reveal or PoP). Skip the TLD preflight and
      // just verify the signer is authorised over the parent; if the subname
      // is already ours or unowned, the DotNS phase below will do the right
      // thing.
      //
      // bulletin-deploy #1443: authorisation is checked via the registry's own
      // isAuthorised(parentNode, account) (DotNS.checkNodeAuthorization), NOT
      // checkOwnership(parentLabel) — that reads the REGISTRAR's ERC-721
      // ownerOf, which only resolves for a top-level, tokenised parent. Once
      // nested subnames are allowed (parentLabel can itself be a multi-label
      // path like "app.supafaust", a subnode with no ERC-721 tokenId at all),
      // checkOwnership either reverts or reads back "owned by no one" for a
      // parent the signer genuinely owns/is-approved-for, routing into
      // formatSubdomainParentError's UNOWNED branch with a confidently wrong
      // "register the parent" suggestion. checkNodeAuthorization is also
      // correct at depth 1 (falls back to owner()-equality when isAuthorised
      // is absent), so this replaces the old call outright rather than
      // supplementing it.
      if (parsed?.isSubdomain) {
        try {
          const subResult = await preflight.checkSubdomainOwnership(parsed.sublabel!, parsed.parentLabel!);
          assertSubdomainOwnerMatchesSigner(subResult, preflight.evmAddress, parsed.sublabel!, parsed.parentLabel!, envTld);
          if (!subResult.owned) {
            const parentNode = computeDomainNode(parsed.parentLabel!, envTld);
            const { authorised: parentAuthorised, owner: parentOwner } = await preflight.checkNodeAuthorization(parentNode, preflight.evmAddress!);
            if (!parentAuthorised) {
              throw new NonRetryableError(
                formatSubdomainParentError(parsed.fullName, parsed.parentLabel!, parentOwner ?? null, preflight.evmAddress ?? "", envTld, preflight.protocolVersion)
              );
            }
          }
          // Best-effort: read the existing contenthash so the storage phase
          // can drive incremental upload. Non-fatal — first deploy returns "0x".
          // NOTE: readPreviousContenthashSafe wants the bare `sub.parent` label
          // (no TLD) — it appends `.${tld}` itself. `parsed.label` is that bare
          // form for a subdomain (see parseDomainName); `parsed.fullName` already
          // carries the TLD and would double-suffix it (see the function's doc
          // comment for the historical incident this class of bug caused).
          previousContenthashCid = await readPreviousContenthashSafe(preflight, parsed.label);
          setDeployAttribute("deploy.incremental", previousContenthashCid ? "true" : "false");
        } finally {
          preflight.disconnect();
        }
        console.log(`   Mode: subdomain (parent ${parsed.parentLabel}.${envTld} owned by signer)`);
      } else {
        // Full DotNS readiness check — runs every view-only rule we know
        // (classification, ownership, reservation, PoP gate) BEFORE touching
        // Bulletin. Advisory; registerDomain keeps its own internal checks.
        // Issue #100.
        try {
          dotnsPreflight = await preflight.preflight(name, { transferRecipientH160: options.transferTo });
          previousContenthashCid = await readPreviousContenthashSafe(preflight, name);
          setDeployAttribute("deploy.incremental", previousContenthashCid ? "true" : "false");
        } finally {
          preflight.disconnect();
        }
        if (dotnsPreflight) {
          setDeployAttribute("deploy.dotns.preflight.action", dotnsPreflight.plannedAction);
          setDeployAttribute("deploy.dotns.preflight.classification", popStatusName(dotnsPreflight.classification.status));
        }
        // Both owned actions mean the name is already registered to the user
        // (directly, or to the signed-in account in transfer mode, #893), so the
        // PoP requirement isn't re-enforced and the domain shows as owned, not available.
        const alreadyOwned = dotnsPreflight.plannedAction === "already-owned-by-us"
          || dotnsPreflight.plannedAction === "already-owned-by-recipient";
        const reqSuffix = alreadyOwned ? " (already owned, requirement not enforced)" : "";
        console.log(`   DotNS: ${name}.${envTld} requires ${popStatusName(dotnsPreflight.classification.status)}${reqSuffix}`);
        if (dotnsPreflight.canProceed) {
          const fromName = popStatusName(dotnsPreflight.userStatus);
          console.log(`   Your PoP: ${fromName}`);
          console.log(`   Domain: ${alreadyOwned ? "owned by you" : "available"}`);
          // #60: announce the transfer-vs-owned-update reality now that preflight
          // knows ownership. The worker header above states only the storage role
          // (it can't know ownership yet). In transfer mode a NEW name is registered
          // + transferred to the recipient; an already-owned name is just
          // content-updated, signed by the owner's phone (no transfer, an extra
          // phone tap). Only meaningful in transfer mode (recipient set).
          if (options.transferTo) {
            console.log(formatTransferModeDotnsLine(alreadyOwned, `${name}.${envTld}`, options.transferTo));
          }
        }

        if (!dotnsPreflight.canProceed) {
          throw new NonRetryableError(
            dotnsPreflight.reason ?? "DotNS preflight rejected the deploy; please check the label and signer."
          );
        }
      }

      // Phone signature plan — fire the opt-in hook at preflight, BEFORE storage.
      // The CLI bin uses this to print the "Have your phone ready" banner up front;
      // library consumers (playground-cli) ignore it or use their own UI.
      if (phoneSignerActive) {
        const steps = computePhoneSigningSteps(dotnsPreflight);
        options.onPhoneSignaturePlan?.(steps as PhoneSignatureStep[]);
      }

      // Storage provider selection: signer > mnemonic > pool (mirrors resolveDotnsConnectOptions precedence).
      // When options.signer + options.signerAddress are set, Bulletin uploads use the external signer
      // and go through getSignerProvider — ensureAuthorized throws when the account is not authorized.
      provider = await reconnect();
      const providerWithReconnect: ExistingProvider = { ...provider, reconnect };

      const isTestnet = await detectTestnet(provider.unsafeApi, envNetwork);
      setDeployAttribute("deploy.is_testnet", isTestnet ? "true" : "false");

      console.log("\n" + "=".repeat(60));
      console.log("Storage");
      console.log("=".repeat(60));

      setDeployAttribute("deploy.content_type", "unknown");
      setDeployAttribute("deploy.encrypted", "false");
      await withSpan("deploy.storage", "1. storage", {}, async () => {
        if (options.inputCar) {
          setDeployAttribute("deploy.content_type", "inputCar");
          const carPath = path.resolve(options.inputCar);
          if (!fs.existsSync(carPath)) throw new Error(`CAR file not found: ${carPath}`);
          console.log(`\n   Mode: Pre-built CAR`);
          console.log(`   Path: ${carPath}`);
          let carContent: Uint8Array = fs.readFileSync(carPath);
          console.log(`   Size: ${(carContent.length / 1024 / 1024).toFixed(2)} MB`);
          // Parse root CID from the CAR header
          const reader = await CarReader.fromBytes(carContent);
          const roots = await reader.getRoots();
          if (roots.length === 0) throw new Error("CAR file has no roots");
          ipfsCid = roots[0].toString();
          console.log(`   Root CID: ${ipfsCid}`);
          if (options.password) {
            setDeployAttribute("deploy.encrypted", "true");
            console.log(`   Encrypting CAR file...`);
            carContent = await encryptContent(carContent, options.password);
            console.log(`   Encrypted: ${(carContent.length / 1024 / 1024).toFixed(2)} MB`);
          }
          let carChunks: Uint8Array[];
          if (options.password) {
            carChunks = chunk(carContent, CHUNK_SIZE);
          } else {
            try {
              let prevStableOrder: string[] = [];
              const manifestBytes = await extractManifestFromCar(carContent);
              if (manifestBytes) {
                const parsed = parseManifest(Buffer.from(manifestBytes).toString("utf8"));
                if (parsed.ok) prevStableOrder = parsed.manifest.stableBlockOrder;
              }
              const rebuilt = await rebuildOrderedCarFromBytes(carContent, prevStableOrder);
              if (Buffer.compare(Buffer.from(rebuilt.carBytes), Buffer.from(carContent)) === 0) {
                carChunks = rebuilt.chunks;
              } else {
                captureWarning("input CAR ordered rechunk drift; falling back to size chunking", {
                  rootCid: ipfsCid,
                });
                carChunks = chunk(carContent, CHUNK_SIZE);
              }
            } catch (err: any) {
              captureWarning("input CAR ordered rechunk failed; falling back to size chunking", {
                rootCid: ipfsCid,
                reason: err?.message ?? String(err),
              });
              carChunks = chunk(carContent, CHUNK_SIZE);
            }
          }
          cid = (await storeChunkedContent(carChunks, providerWithReconnect)).storageCid;
        } else if (process.env.IPFS_CID) {
          setDeployAttribute("deploy.content_type", "ipfsCid");
          if (options.password) {
            throw new Error(
              "IPFS_CID and --password are mutually exclusive: IPFS_CID skips the upload step, so there is nothing to encrypt. Either unset IPFS_CID to upload and encrypt fresh content, or remove --password to reuse the existing CID as-is."
            );
          }
          cid = process.env.IPFS_CID;
          ipfsCid = cid;
          console.log(`\n   Using CID: ${cid}`);
        } else if (Array.isArray(content)) {
          setDeployAttribute("deploy.content_type", "multiChunk");
          console.log(`\n   Mode: Multi-chunk (${content.length} chunks)`);
          let contentChunks: Uint8Array[] = content;
          if (options.password) {
            setDeployAttribute("deploy.encrypted", "true");
            console.log(`   Encrypting...`);
            const encrypted = await encryptContent(Buffer.concat(content), options.password);
            console.log(`   Encrypted: ${(encrypted.length / 1024).toFixed(1)} KB`);
            contentChunks = chunk(encrypted);
          }
          cid = (await storeChunkedContent(contentChunks, providerWithReconnect)).storageCid;
        } else if (typeof content === "string") {
          setDeployAttribute("deploy.content_type", "path");
          const contentPath = path.resolve(content);
          if (!fs.existsSync(contentPath)) throw new Error(`Path not found: ${contentPath}`);
          const stats = fs.statSync(contentPath);
          if (stats.isDirectory()) {
            setDeployAttribute("deploy.content_type", "directory");
            console.log(`\n   Mode: Directory`);
            console.log(`   Path: ${contentPath}`);
            if (previousContenthashCid) console.log(`   Incremental: previous contenthash ${previousContenthashCid}`);
            else console.log(`   Incremental: first deploy (no previous contenthash)`);
            // Destructure so carBytes (the third field on the return) isn't
            // pinned through the DotNS phase below. Route through storeDirectoryV2
            // for the incremental-upload-v2 flow when not encrypted; encrypted
            // deploys fall through to the legacy path inside storeDirectoryV2.
            if (options.password) setDeployAttribute("deploy.encrypted", "true");
            const storeFn = options.password ? storeDirectory : storeDirectoryV2;
            const { storageCid: sCid, ipfsCid: iCid } = await storeFn(contentPath, {
              provider: providerWithReconnect,
              password: options.password,
              jsMerkle: options.jsMerkle,
              previousContenthash: previousContenthashCid,
              allowLargeDeploy: options.allowLargeDeploy,
              reproducibleSource: options.reproducibleSource,
              domain: name,
              gateway: envIpfs,
              dumpCar: options.dumpCar,
            });
            cid = sCid;
            ipfsCid = iCid;
          } else {
            setDeployAttribute("deploy.content_type", "file");
            console.log(`\n   Mode: File`);
            console.log(`   Path: ${contentPath}`);
            let fileContent: Uint8Array = fs.readFileSync(contentPath);
            if (options.password) {
              setDeployAttribute("deploy.encrypted", "true");
              console.log(`   Encrypting...`);
              fileContent = await encryptContent(fileContent, options.password);
              console.log(`   Encrypted: ${(fileContent.length / 1024).toFixed(1)} KB`);
            }
            if (fileContent.length > MAX_FILE_SIZE) {
              console.log(`   Exceeds 8MB, chunking...`);
              cid = (await storeChunkedContent(chunk(fileContent), providerWithReconnect)).storageCid;
            } else {
              cid = await storeFile(fileContent, providerWithReconnect);
            }
          }
        } else if (content instanceof Uint8Array) {
          setDeployAttribute("deploy.content_type", "multiChunk");
          console.log(`\n   Mode: Bytes`);
          let bytesContent = content;
          if (options.password) {
            setDeployAttribute("deploy.encrypted", "true");
            console.log(`   Encrypting...`);
            bytesContent = await encryptContent(bytesContent, options.password);
            console.log(`   Encrypted: ${(bytesContent.length / 1024).toFixed(1)} KB`);
          }
          if (bytesContent.length > MAX_FILE_SIZE) {
            console.log(`   Exceeds 8MB, chunking...`);
            cid = (await storeChunkedContent(chunk(bytesContent), providerWithReconnect)).storageCid;
          } else {
            cid = await storeFile(bytesContent, providerWithReconnect);
          }
        } else {
          throw new Error("Invalid content: must be path, Uint8Array, or Array<Uint8Array>");
        }
      });

      setDeployAttribute("deploy.cid", cid as string);
      if (options.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
          setDeployAttribute(key, value);
        }
      }

      console.log("\n" + "=".repeat(60));
      console.log("DotNS");
      console.log("=".repeat(60));

      await withSpan("deploy.dotns", "2. dotns", { "deploy.domain": name, "deploy.subdomain": String(parsed?.isSubdomain ?? false) }, async () => {
        // #893: name already owned by the signed-in recipient (see the matching
        // preflight branch). The worker can't update its content — only the owner
        // is authorised — so re-acquire the session signer and sign as the OWNER.
        if (dotnsPreflight?.plannedAction === "already-owned-by-recipient") {
          console.log(`   You already own ${name}.${envTld} — updating its content needs your signature.`);
          const { getAuthClient } = await import("./auth-config.js");
          const { resolveSigner } = await import("./auth/index.js");
          const authClient = await getAuthClient(envId);
          const owner = await resolveSigner(authClient, {}); // session signer = the OWNER; ignore --suri
          const ownerDotns = new DotNS();
          // Defer teardown to deploy-end (sessionCleanup, run in the final finally).
          // Destroying the session adapter inline mid-deploy fires detached
          // "DestroyedError: Client destroyed" rejections (orphan subscription promises
          // from the statement-store/papi client) that crash the process to exit 2
          // BEFORE post-span finalization (P2P check, DEPLOYMENT COMPLETE). Running it
          // at the very end lets that benign teardown noise fire as the process exits.
          const prevSessionCleanup = sessionCleanup;
          sessionCleanup = () => {
            try { prevSessionCleanup?.(); } catch { /* best-effort */ }
            try { ownerDotns.disconnect(); } catch { /* best-effort */ }
            try { owner.destroy(); } catch { /* best-effort */ }
          };
          await ownerDotns.connect({
            ...resolveDotnsConnectOptions({ ...options, signer: owner.signer, signerAddress: owner.address }, envAssetHub, envAutoAccountMapping, envContracts, envNativeToEthRatio, envId, envPopSelfServe, envRegisterStorageDeposit, envConfiguredTld, contractSources, envNetwork),
            // bulletin #1221: see autoMapPlannedActionFor's doc comment for why this uses the
            // real plannedAction rather than a hardcoded "register".
            autoMapTopUpTarget: topUpTargetFor(autoMapPlannedActionFor(dotnsPreflight), envRegisterStorageDeposit, AUTO_MAP_RENT_HEADROOM),
            confirmPhoneReady: options.confirmPhoneReady,
            phoneSigner: true, // owner path is always a real phone/session signer
          });
          // Wire total so confirmPhoneReady gets the right count.
          ownerDotns.setPhoneSignatureTotal(1);
          const contenthashHex = `0x${encodeContenthash(cid as string)}`;
          // #885: the owner is the PGAS-funded session account; elect PGAS for the
          // AH fee so a zero-native owner can update content faucet-free.
          await ownerDotns.setContenthash(name, contenthashHex, { feeAsset: "pgas" });
          return;
        }

        const dotns = new DotNS();
        await dotns.connect({
          ...resolveDotnsConnectOptions(options, envAssetHub, envAutoAccountMapping, envContracts, envNativeToEthRatio, envId, envPopSelfServe, envRegisterStorageDeposit, envConfiguredTld, contractSources, envNetwork),
          // bulletin #1221: see autoMapPlannedActionFor's doc comment for why this uses the
          // real plannedAction rather than a hardcoded "register".
          autoMapTopUpTarget: topUpTargetFor(autoMapPlannedActionFor(dotnsPreflight), envRegisterStorageDeposit, AUTO_MAP_RENT_HEADROOM),
          confirmPhoneReady: options.confirmPhoneReady,
          // Transfer mode: phoneSigner=false (local worker signs in-process, no phone gate).
          // Genuine phone/session signer: phoneSigner=true (gate enabled). Fixes #50.
          phoneSigner: phoneSignerActive,
        });
        if (phoneSignerActive) {
          dotns.setPhoneSignatureTotal(computePhoneSigningSteps(dotnsPreflight).length);
        }

        // Track whether THIS run freshly registered the name. The transfer-to-
        // signed-in-user handover below only fires on a fresh registration (#928):
        // updating the content of a name that already exists must NOT change its
        // ownership.
        let registeredFresh = false;
        if (parsed?.isSubdomain) {
          const { owned, owner } = await dotns.checkSubdomainOwnership(parsed.sublabel!, parsed.parentLabel!);
          if (owned) {
            console.log(`   Status: Already owned`);
          } else if (owner) {
            throw new Error(`Subdomain ${parsed.fullName} is owned by ${owner}, not ${dotns.evmAddress}`);
          } else {
            // bulletin-deploy #1443: checkNodeAuthorization (registry
            // isAuthorised, owner()-equality fallback), not
            // checkOwnership(parentLabel) — see the comment at the earlier
            // preflight call site for why a registrar-based ownerOf read is
            // wrong once parentLabel can itself be a multi-label nested-subname
            // path.
            const parentNode = computeDomainNode(parsed.parentLabel!, envTld);
            const { authorised: parentAuthorised } = await dotns.checkNodeAuthorization(parentNode, dotns.evmAddress!);
            if (!parentAuthorised) throw new Error(`You must own (or be approved for) ${parsed.parentLabel}.${envTld} to register subdomains under it`);
            console.log(`   Status: Registering subdomain...`);
            await dotns.registerSubdomain(parsed.sublabel!, parsed.parentLabel!);
            registeredFresh = true;
          }
        } else {
          const { owned } = await dotns.checkOwnership(name);
          if (owned) {
            console.log(`   Status: Already owned`);
          } else {
            console.log(`   Status: Registering...`);
            await dotns.register(name);
            registeredFresh = true;
          }
        }

        const contenthashHex = `0x${encodeContenthash(cid as string)}`;
        await dotns.setContenthash(name, contenthashHex);

        // Zero-mobile-sig handover: the worker (Alice/--mnemonic) signed the whole
        // deploy above; now hand the finished name to the signed-in account. One
        // ERC-721 transferFrom moves ownership + resolver authorisation. Idempotent.
        // Own span so a handover failure attributes to deploy.transfer, not to
        // deploy.dotns (register + setContenthash already succeeded by here).
        // #928: only hand over a name THIS run freshly registered — re-deploying
        // (updating content of) a pre-existing name must not change its owner.
        if (options.transferTo && !registeredFresh) {
          console.log(`   ${name}.${envTld} already existed — updated content only; ownership unchanged (not transferred to ${options.transferTo}).`);
          // Actionable, because this also fires when a retry re-ran the whole
          // deploy after attempt 1 freshly registered + then flaked on
          // setContenthash: attempt 2 sees "Already owned", so the
          // handover this run owed never happens. transferName is idempotent,
          // so the recovery command is always safe to run.
          console.log(`   If you meant to claim it, run: ${CLI_NAME} transfer ${name} --env ${envId}${options.suri ? ` --mnemonic "<your worker key>"` : ""}`);
          setDeployAttribute("deploy.transfer.status", "skipped-existing");
        }
        if (shouldHandoverName({ transferTo: options.transferTo, registeredFresh })) {
          const transferTo = options.transferTo!;
          await withSpan("deploy.transfer", `3. transfer ${name}.${envTld}`, { "deploy.transfer.to": transferTo }, async () => {
            setDeployAttribute("deploy.transfer.worker", truncateAddress(options.signerAddress ?? "") as string);
            setDeployAttribute("deploy.transfer.to", transferTo);
            try {
              const transferRes = await dotns.transferName(name, transferTo, (s) => console.log(`   ${s}`));
              setDeployAttribute("deploy.transfer.status", transferRes.status);
              if (transferRes.feeWei != null) setDeployAttribute("deploy.transfer.fee_wei", transferRes.feeWei.toString());
              console.log(`   Handed ${name}.${envTld} to ${transferTo} (${transferRes.status}${transferRes.txHash ? `, tx ${transferRes.txHash}` : ""}).`);
            } catch (e) {
              setDeployAttribute("deploy.transfer.status", "failed");
              const recover = `${CLI_NAME} transfer ${name} --env ${envId}` + (options.suri ? ` --mnemonic "<your worker key>"` : "");
              try { dotns.disconnect(); } catch { /* best-effort */ }
              throw new NonRetryableError(
                `Deploy succeeded but the handover to ${transferTo} failed: ${(e as Error).message}\n` +
                `   The name is owned by the worker with content set. Recover with:\n   ${recover}`,
              );
            }
          });
        }

        dotns.disconnect();
      });

      // P2P retrieval liveness check (issue #456).
      // Uses bitswap_v1_get on the existing bulletin RPC client — zero new deps.
      // Non-fatal: on-chain per-block presence (gate 1 above) is authoritative.
      // See interpretBitswapResult / probeP2pRetrieval for the fidelity caveat.
      await withSpan("deploy.p2p-check", "3. p2p-check", { "deploy.domain": name }, async () => {
        // provider is guaranteed non-null here — storage phase completed above.
        const probe = await probeP2pRetrieval(provider!.client, cid as string);
        setDeployAttribute("deploy.p2p.retrievable", probe.retrievable ? "true" : "false");
        setDeployAttribute("deploy.p2p.check_ms", String(probe.durationMs));
        setDeployAttribute("deploy.p2p.error_variant", probe.errorVariant);
        if (probe.retrievable) {
          console.log(`   P2P retrieval: ✓ (${probe.durationMs}ms)`);
        } else {
          console.log(`   P2P retrieval: ⚠ not yet retrievable (${probe.errorVariant}, ${probe.durationMs}ms)`);
        }
      });

      const browserUrl = browserUrlFor(name, envId, envWebGateway);
      // #1164: a manifest publish immediately follows in bin/polkadot-app-deploy
      // when manifestPending is set — defer the real completion banner (and
      // its browser URL) until that phase actually succeeds, so a manifest
      // failure never leaves a false "DEPLOYMENT COMPLETE!" on screen.
      if (options.manifestPending) {
        console.log("\n" + "=".repeat(60));
        console.log(pickPostDeployBannerText(true));
        console.log("=".repeat(60) + "\n");
      } else {
        printDeploymentCompleteBanner(`${name}.${envTld}`, browserUrl);
      }
      return {
        domainName: name,
        fullDomain: `${name}.${envTld}`,
        cid: cid as string,
        ipfsCid,
        browserUrl,
        // Read off `options`, not the slot resolution above: `options` is what
        // selectStorageReconnect actually consulted, so this reports the identity that
        // stored the bytes even when the caller supplied storageSigner itself.
        storageSigner: options.storageSigner,
        storageSignerAddress: options.storageSignerAddress,
      };
    } finally {
      // Flush the module-level failover flag in case onStatusChanged fired after
      // the deploy span attribute was already written. Idempotent if already set.
      if (_deployRpcFailedOver) setDeployAttribute("deploy.rpc.failed_over", "true");
      provider?.client.destroy();
      for (const c of openedClients) if (c !== provider?.client) try { c.destroy(); } catch { /* already closed */ }
    }
  });
  } finally {
    // Release the QR/mobile session adapter if one was acquired in the resolve branch.
    sessionCleanup?.();
  }
}

/**
 * Compute the ordered list of step labels that will require a phone tap,
 * given the DotNS preflight result.
 * Returns [] when deploy would abort or preflight is null.
 * Exported for unit testing.
 */
export function computePhoneSigningSteps(
  dotnsPreflight: { plannedAction: string; needsPopUpgrade: boolean } | null,
): string[] {
  if (!dotnsPreflight || dotnsPreflight.plannedAction === "abort") return [];
  const steps: string[] = [];
  if (dotnsPreflight.plannedAction === "register") {
    steps.push("Commitment", "Register");
  }
  steps.push("Link content");
  return steps;
}
