import { Buffer } from "buffer";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { CLI_NAME } from "./cli-name.js";
import { hasPersistedSession, STALE_SESSION_MESSAGE, DOT_DAPP_ID, DOT_PRODUCT_ID, getPeopleChainEndpoints } from "./auth-config.js";
import { statementSigningAccount } from "./sss-allowance.js";
import { preflightSssAllowance } from "./sss-allowance-cache.js";
import { sha256 } from "@noble/hashes/sha256";
import { blake2b } from "@noble/hashes/blake2b";
import { createClient as createPolkadotClient, Enum } from "polkadot-api";
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
import { MANIFEST_VERSION, MANIFEST_DIR, MANIFEST_PATH, classifyFile, parseManifest, type ManifestFileEntry, type ManifestChunkEntry } from "./manifest.js";
import { probeChunks } from "./chunk-probe.js";
import { computeStats, telemetryAttributes, renderSummary } from "./incremental-stats.js";
import { mirrorToGitHubPages, MirrorSkipped, pollMirrorFreshness } from "./gh-pages-mirror.js";
import type { MirrorResult } from "./gh-pages-mirror.js";
import { keccak256, toBytes } from "viem";
import { DotNS, fetchNonce, verifyNonceAdvanced, TX_TIMEOUT_MS, validateDomainLabel, popStatusName, parseDomainName, PublisherNotSupportedError, PUBLISHER_ABI } from "./dotns.js";
import type { ParsedDomainName, DotnsPreflightResult } from "./dotns.js";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { derivePoolAccounts, fetchPoolAuthorizations, selectAccount, ensureAuthorized, isAuthorizationSufficient, detectTestnet } from "./pool.js";
import type { PoolAuthorization } from "./pool.js";
import { initTelemetry, withSpan, withDeploySpan, setDeployAttribute, setDeploySentryTag, sampleMemory, setDeployReportContext, captureWarning, flush, VERSION, resolveRunner, resolveRunnerType, truncateAddress } from "./telemetry.js";
import { loadEnvironments, resolveEndpoints, getPopSelfServeConfig, DEFAULT_ENV_ID } from "./environments.js";
import type { PopSelfServeConfig } from "./environments.js";
import { setDeployContext as setBugReportContext } from "./bug-report.js";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { mnemonicToEntropy, entropyToMiniSecret, ss58Address } from "@polkadot-labs/hdkd-helpers";
import type { PolkadotSigner } from "polkadot-api";
import { CarReader } from "@ipld/car/reader";
import {
  getSlotSignerProvider,
  BulletinSlotAuthError,
} from "./storage-signer.js";

export interface DeployResult {
  domainName: string;
  fullDomain: string;
  cid: string;
  ipfsCid?: string;
}

export type DeployContent = string | Uint8Array | Uint8Array[];

export { NonRetryableError, EXIT_CODE_NO_RETRY } from "./errors.js";
import { NonRetryableError } from "./errors.js";

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
}
interface ChainReceipt { txHash: string; blockHash: string; blockNumber: number; }
interface StoredChunk { cid: CID; len: number; viaFallback?: boolean; receipt?: ChainReceipt; }
interface WatchTransactionOptions { label?: string; rpc?: string | string[]; senderSS58?: string; expectedNonce?: number; timeoutMs?: number; fetchNonce?: (rpc: string | string[], ss58: string) => Promise<number>; }
interface WatchResult<T> { value: T; viaFallback: boolean; receipt?: ChainReceipt; }

export const DEFAULT_BULLETIN_RPC = "wss://paseo-bulletin-rpc.polkadot.io";
export const DEFAULT_POOL_SIZE = 10;
// Full endpoint list for multi-endpoint transport. Index 0 is always the
// effective primary. Only one public Bulletin endpoint is known today — add
// backups here once the Bulletin team publishes them (no code change needed).
export let BULLETIN_ENDPOINTS: string[] = [DEFAULT_BULLETIN_RPC];
let POOL_SIZE = DEFAULT_POOL_SIZE;
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
// Chunk tx mortality window. At 24s/block, period:16 ≈ 6.4 min.
// With CHUNK_TIMEOUT_MS=180s and MAX_CHUNK_RETRIES=3, worst-case retry
// span is ~9 min — exceeding the window. This is intentional: by retry 2+
// the original tx has expired by construction, so there is never a live
// duplicate-tx for the same nonce. (storeFile and root-node stay at
// period:256 — they have no retry loop that could produce duplicates.)
// Overridable via BULLETIN_CHUNK_MORTALITY_PERIOD (integer, default 16).
// Tests set a short period (e.g. 2) to exercise the expiry-retry path.
export const CHUNK_MORTALITY_PERIOD: number = (() => {
  const v = parseInt(process.env.BULLETIN_CHUNK_MORTALITY_PERIOD ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 16;
})();
const RETRY_BASE_DELAY_MS: number = 2_000;
const RETRY_MAX_DELAY_MS: number = 15_000;
export const WS_HEARTBEAT_TIMEOUT_MS: number = 300_000;

// GRANDPA finality poll constants.
// Phase B's just-uploaded chunks (especially the root, the last extrinsic
// submitted) are in best chain but not yet at finalised head — give them
// time to finalise naturally before assuming something went wrong.
const GRANDPA_NATURAL_WAIT_MS: number = parseInt(process.env.BULLETIN_GRANDPA_NATURAL_WAIT_MS ?? "90000", 10);
const GRANDPA_REUPLOAD_POLL_MS: number = 5_000;
// 120s: paseo-next-v2 has 12s block times; a re-uploaded chunk needs inclusion
// (~12s) + 2 finality rounds (~24s) = ~36s minimum. 120s gives 3× headroom.
const GRANDPA_REUPLOAD_TIMEOUT_MS: number = 120_000;
// Up to 3 re-upload rounds: a re-uploaded tx can land in a block that gets
// forked off; retrying submits a fresh tx on the canonical chain.
const GRANDPA_REUPLOAD_MAX_ROUNDS: number = 3;

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
 *  - connection errors (recoverable via the storage reconnect path), and
 *  - "DestroyedError: Client destroyed" — orphaned pending-response promises the
 *    SSO/papi client rejects while a session adapter is torn down AFTER the work
 *    is done (e.g. the owner-signs update path destroying its re-acquired session).
 * The CLI's crash handlers use this so a successful deploy isn't marked killed
 * (exit 2) by late teardown noise. Checks name+message so DestroyedError matches
 * even when its message differs.
 */
export function isBenignTeardownError(error: any): boolean {
  if (isConnectionError(error)) return true;
  const s = error instanceof Error ? `${error.name ?? ""} ${error.message ?? ""}` : String(error);
  return /DestroyedError|Client destroyed/.test(s);
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

async function getProvider(): Promise<ProviderResult> {
  const primary = BULLETIN_ENDPOINTS[0];
  console.log(`   Connecting to Bulletin: ${primary}`);
  const client = createPolkadotClient(getWsProvider(
    BULLETIN_ENDPOINTS,
    { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS, onStatusChanged: makeBulletinStatusHandler(primary) },
  ));
  const unsafeApi: any = client.getUnsafeApi();

  try {
    await cryptoWaitReady();
    const poolMnemonic = process.env.BULLETIN_POOL_MNEMONIC || undefined;
    const poolAccounts = derivePoolAccounts(POOL_SIZE, poolMnemonic);
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
    const selectionResult = selectAccount(authorizations, Math.random, pinnedPoolIndex);
    const selectedAccount = selectionResult.account;
    const eligibleCount = selectionResult.eligibleCount;
    await ensureAuthorized(unsafeApi, selectedAccount.address, `pool account ${selectedAccount.index}`);

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

async function getDirectProvider(mnemonic: string, derivationPath: string = ""): Promise<ProviderResult> {
  const primary = BULLETIN_ENDPOINTS[0];
  console.log(`   Connecting to Bulletin: ${primary}`);
  const client = createPolkadotClient(getWsProvider(
    BULLETIN_ENDPOINTS,
    { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS, onStatusChanged: makeBulletinStatusHandler(primary) },
  ));
  const unsafeApi: any = client.getUnsafeApi();
  const { signer, ss58 } = deriveRootSigner(mnemonic, derivationPath);

  console.log(`   Using direct signer: ${ss58}${derivationPath ? ` (path: ${derivationPath})` : ""}`);

  let [auth, currentBlock] = await Promise.all([
    unsafeApi.query.TransactionStorage.Authorizations.getValue(Enum("Account", ss58)),
    client.getFinalizedBlock(),
  ]);
  let now = currentBlock.number;
  if (!auth || Number(auth.expiration ?? 0) <= now) {
    try {
      await ensureAuthorized(unsafeApi, ss58 as string, "direct signer");
      [auth, currentBlock] = await Promise.all([
        unsafeApi.query.TransactionStorage.Authorizations.getValue(Enum("Account", ss58)),
        client.getFinalizedBlock(),
      ]);
      now = currentBlock.number;
    } catch (e: any) {
      client.destroy();
      throw new NonRetryableError(`Account ${ss58} is not authorized for Bulletin storage and auto-authorization failed: ${e.message}`);
    }
  }
  console.log(`   Authorization: expires at block ${Number(auth?.expiration ?? 0)} (current: ${now})`);

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
    unsafeApi.query.TransactionStorage.Authorizations.getValue(Enum("Account", ss58)),
    client.getFinalizedBlock(),
  ]);
  let now = currentBlock.number;
  if (!auth || Number(auth.expiration ?? 0) <= now) {
    try {
      await ensureAuthorized(unsafeApi, ss58, "external signer");
      [auth, currentBlock] = await Promise.all([
        unsafeApi.query.TransactionStorage.Authorizations.getValue(Enum("Account", ss58)),
        client.getFinalizedBlock(),
      ]);
      now = currentBlock.number;
    } catch (e: any) {
      client.destroy();
      throw new NonRetryableError(`Account ${ss58} is not authorized for Bulletin storage and auto-authorization failed: ${e.message}`);
    }
  }
  console.log(`   Authorization: expires at block ${Number(auth?.expiration ?? 0)} (current: ${now})`);

  setDeployAttribute("deploy.signer.mode", "external");
  setDeployAttribute("deploy.signer.address", truncateAddress(ss58) as string);
  return { client, unsafeApi, signer, ss58 };
}

/** storageSigner > signer > mnemonic > pool precedence for storage routing. Exported for unit testing. */
export function __selectStorageProviderModeForTest(
  options: Pick<DeployOptions, "storageSigner" | "storageSignerAddress" | "signer" | "signerAddress" | "mnemonic">,
): "storageSigner" | "signer" | "direct" | "pool" {
  if (options.storageSigner && options.storageSignerAddress) return "storageSigner";
  if (options.signer && options.signerAddress) return "signer";
  if (options.mnemonic) return "direct";
  return "pool";
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
  options: Pick<DeployOptions, "signer" | "signerAddress" | "transferTo">,
): boolean {
  return !!(options.signer && options.signerAddress && !options.transferTo);
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
 *   Success: "   Storage signer: allowance slot <ss58>"
 *   Fallback: "   Storage signer: pool fallback (<reason>)"
 */
export function formatStorageSignerLine(slotAddress: string | null, failReason?: string): string {
  if (slotAddress) return `   Storage signer: allowance slot ${slotAddress}`;
  return `   Storage signer: pool fallback (${failReason ?? "no session"})`;
}

function selectStorageReconnect(options: DeployOptions): () => Promise<ProviderResult> {
  if (options.storageSigner && options.storageSignerAddress) {
    // Committed-signer: once the slot provider fails on the first attempt,
    // every subsequent reconnect uses pool. Prevents signer drift mid-upload
    // (nonce/attribution would break if storage switched signers between chunks).
    let useSlot = true;
    return async () => {
      if (!useSlot) return getProvider();
      try {
        return await getSlotSignerProvider(options.storageSigner!, options.storageSignerAddress!);
      } catch (e) {
        useSlot = false;
        setDeployAttribute("deploy.signer.mode", "pool-fallback");
        // Produce an actionable reason string for the user-visible warning.
        // BulletinSlotAuthError carries a typed reason; other errors (WS/connection) use their message.
        let reason: string;
        if (e instanceof BulletinSlotAuthError) {
          reason =
            e.reason === "expired" && e.expiration != null
              ? `expired at block ${e.expiration}`
              : "no on-chain authorization found";
        } else {
          reason = e instanceof Error ? e.message : String(e);
        }
        console.warn(
          `⚠  Bulletin allowance slot not usable: ${reason}\n` +
          `   Falling back to the shared pool account for storage (fine on testnet).\n` +
          `   To use your own allowance, run: ${CLI_NAME} logout && ${CLI_NAME} login`,
        );
        // TODO (mainnet): hard-fail here instead of pool fallback when running against mainnet
        // (tie to the open mainnet-storage-signer gap in src/CLAUDE.md). Env-gating deferred
        // until mainnet is live.
        return getProvider();
      }
    };
  }
  // External signer (options.signer + options.signerAddress): use getSignerProvider for
  // Bulletin storage when no dedicated slot signer is available. This supports
  // programmatic callers (playground-cli, library consumers) that pass their own
  // PolkadotSigner without a pre-allocated BulletInAllowance slot key.
  if (options.signer && options.signerAddress)
    return () => getSignerProvider(options.signer!, options.signerAddress!);
  if (options.mnemonic)
    return () => getDirectProvider(options.mnemonic!, options.derivationPath);
  return () => getProvider();
}

function watchTransaction<T>(tx: any, signer: PolkadotSigner, txOpts: any, onSuccess: (event?: any) => T, { label = "transaction", rpc, senderSS58, expectedNonce, timeoutMs, fetchNonce: fetchNonceOverride }: WatchTransactionOptions = {}): Promise<WatchResult<T>> {
  const timeout = timeoutMs ?? TX_TIMEOUT_MS;
  const _fetchNonce = fetchNonceOverride ?? fetchNonce;
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
    // Nonce-based fallback: check whether nonce advanced (tx actually got
    // included) even though the subscription can't confirm it. Uses
    // verifyNonceAdvanced (allSettled + any-peer-advanced) when multiple
    // endpoints are provided — prevents a fast-but-stale primary from masking
    // confirmation seen by a backup peer (AC#1 from #153).
    const tryNonceFallback = async (): Promise<boolean> => {
      if (!rpc || !senderSS58 || expectedNonce == null) return false;
      try {
        const endpoints = Array.isArray(rpc) ? rpc : [rpc];
        const verified = await verifyNonceAdvanced(endpoints, senderSS58, expectedNonce);
        if (settled) return true;
        if (verified.advanced) {
          console.log(`      ${label}: nonce advanced past ${expectedNonce} (witnessed by ${verified.witnessRpc}), tx was included`);
          settle(resolve)({ value: onSuccess(), viaFallback: true });
          return true;
        }
      } catch (e: any) {
        if (settled) return true;
        console.log(`      ${label}: nonce fallback failed: ${e.message?.slice(0, 80)}`);
      }
      return false;
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      if (await tryNonceFallback()) return;
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
        //                   include. Run the nonce fallback (in case the chain
        //                   actually included it but a peer disagrees) then
        //                   reject so the retry loop can reissue with a fresh
        //                   nonce. The previous code counted every isValid:true
        //                   event as a "drop" and failed after 5, producing
        //                   spurious `tx dropped from best chain 5 times`
        //                   failures on slow blocks.
        if (event.isValid === false) {
          console.log(`      ${label}: tx rejected by pool (isValid:false), checking nonce fallback...`);
          if (await tryNonceFallback()) return;
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

async function storeChunk(unsafeApi: any, signer: PolkadotSigner, chunkBytes: Uint8Array, nonce: number, ss58: string, opts: { fetchNonce?: WatchTransactionOptions["fetchNonce"] } = {}): Promise<StoredChunk> {
  const cid = createCID(chunkBytes, CID_CONFIG.codec, CID_CONFIG.hashCode);
  const tx = unsafeApi.tx.TransactionStorage.store_with_cid_config({ cid: { codec: BigInt(CID_CONFIG.codec), hashing: toHashingEnum(CID_CONFIG.hashCode) }, data: chunkBytes });
  const txOpts = { mortality: { mortal: true, period: CHUNK_MORTALITY_PERIOD }, nonce };
  const { value, viaFallback, receipt } = await watchTransaction(tx, signer, txOpts, () => {
    console.log(`      CID: ${cid.toString()}`);
    return { cid, len: chunkBytes.length };
  }, { label: `chunk(nonce:${nonce})`, rpc: BULLETIN_ENDPOINTS, senderSS58: ss58, expectedNonce: nonce, timeoutMs: CHUNK_TIMEOUT_MS, fetchNonce: opts.fetchNonce });
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

export async function storeChunkedContent(chunks: Uint8Array[], { client: existingClient, unsafeApi: existingApi, signer: existingSigner, ss58: existingSS58, reconnect, fetchNonce: fetchNonceOverride, skipCids, probeFailedCids, gateway: providerGateway, trustedCids, skipRootStore }: ExistingProvider = {}): Promise<{ storageCid: string; tier2Verified: number; tier2Inconclusive: number; tier2Fallback: number; liveProvider: ExistingProvider; skipProbeResults: Map<string, true | false | null>; rootSkipped: boolean }> {
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
  // (the allowance fields are no longer the gate). Deploy no longer
  // self-authorizes (#745); fail fast if there is no active authorization —
  // it must be granted out-of-band (testnet faucet / personhood / pool bootstrap).
  const readUploadAuthorization = () => Promise.all([
    unsafeApi.query.TransactionStorage.Authorizations.getValue(Enum("Account", ss58)),
    unsafeApi.query.System.Number.getValue(),
  ]);
  let uploadAuth: any;
  let currentBlockNum: any;
  try {
    [uploadAuth, currentBlockNum] = await readUploadAuthorization();
  } catch (e: any) {
    if (existingClient && reconnect && isConnectionError(e)) {
      await refreshExistingClient("authorization preflight hit a stale chainHead");
      [uploadAuth, currentBlockNum] = await readUploadAuthorization();
    } else {
      throw e;
    }
  }
  const sufficient = isAuthorizationSufficient(uploadAuth, currentBlockNum);
  if (!sufficient) {
    throw new NonRetryableError(`Account ${ss58} has no active Bulletin authorization (missing or expired). Request authorization on-chain (testnet faucet / personhood / pool bootstrap), then retry.`);
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

  try {

    let startNonce = await _fetchNonce(BULLETIN_ENDPOINTS, ss58 as string);
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
        trustedIndices.push(i);
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
      const probeResults = await probeChunks(cidStrings, { client });
      const probeResultMap = new Map(probeResults.map(r => [r.cid, r.present]));
      for (const r of probeResults) skipProbeResults.set(r.cid, r.present);

      let confirmedCount = 0;
      for (const { index: i, cid } of skipCidsCandidates) {
        const cidStr = cid.toString();
        const present = probeResultMap.get(cidStr) ?? null;
        if (present !== false) {
          stored[i] = { cid, len: chunks[i].length, viaFallback: true };
          confirmedCount++;
          if (present === true) {
            tier2Verified++;
          } else {
            tier2Inconclusive++;
          }
        } else {
          tier2Fallback++;
        }
      }
      console.log(`   Cache check: ${confirmedCount} confirmed, ${tier2Fallback} missing${tier2Fallback > 0 ? " (will upload)" : ""}`);
    }

    // Pre-compute dense nonces: skipped chunks consume zero nonce slots, so the
    // actually-submitted chunks receive consecutive nonces startNonce..N.
    // Re-running assignDenseNonces after reconnect (see startNonce re-fetch below)
    // is safe: by that point more stored[] entries may be non-null, so the map
    // shrinks further — still dense, still correct.
    const assignedNonces = assignDenseNonces(stored, startNonce);

    // Upload-pass numerator: how many chunks we will actually submit. The
    // reconnect path only re-tries existing stored[]===null entries; it never
    // introduces new ones, so this value is stable across reconnects.
    const uploadTotal = stored.filter((s) => s === null).length;
    let uploadEmitted = 0;
    const nonceAdvanceIndices = new Set<number>();

    let b = 0;
    while (b < chunks.length) {
      // If the WS halt callback fired since the last batch, the current
      // client was destroyed but no chunk error triggered doReconnect (the
      // halt landed in the gap between batches). Build a fresh client now
      // before submitting any chunks against the destroyed one.
      if (wsHaltDetected && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
        wsHaltDetected = false;
        await doReconnect();
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
        uploadEmitted++;
        console.log(`   [${uploadEmitted}/${uploadTotal}] chunk ${i} — ${(chunkData.length / 1024 / 1024).toFixed(2)} MB (nonce: ${nonce})`);
        return storeChunk(unsafeApi, signer as PolkadotSigner, chunkData, nonce, ss58 as string, { fetchNonce: fetchNonceOverride });
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
        await doReconnect();
        const currentNonce = await _fetchNonce(BULLETIN_ENDPOINTS, ss58 as string);
        for (const idx of batchIndices) {
          const chunkNonce = assignedNonces.get(idx);
          if (chunkNonce !== undefined && chunkNonce < currentNonce && stored[idx] === null) {
            console.log(`   Chunk ${idx + 1}: nonce ${chunkNonce} consumed (current=${currentNonce}), treating as included`);
            stored[idx] = { cid: createCID(chunks[idx], CID_CONFIG.codec, 0x12), len: chunks[idx].length, viaFallback: true };
            nonceAdvanceIndices.add(idx);
            assignedNonces.delete(idx);
          }
        }
        startNonce = Math.max(startNonce, currentNonce);
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
        // the chunk's CID was probe-failed (present:null), the chunk is already on
        // chain — the probe was a false-negative. Treat as success immediately,
        // before burning retries on a tx the chain will keep rejecting.
        const failCid = createCID(fail.chunkData, CID_CONFIG.codec, 0x12);
        if (
          probeFailedCids &&
          probeFailedCids.has(failCid.toString()) &&
          fail.error?.message?.includes("isValid:false")
        ) {
          console.log(`   Chunk ${fail.index + 1}: isValid:false but CID was probe-failed — treating as already on chain`);
          captureWarning("isValid:false treated as success (probe-failed backstop)", { chunkIndex: fail.index + 1, cid: failCid.toString() });
          stored[fail.index] = { cid: failCid, len: fail.chunkData.length, viaFallback: true };
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
          // If this was a connection error, reconnect before retrying
          if (isConnectionError(fail.error) && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
            try {
              await doReconnect();
            } catch (reconnectErr: any) {
              console.log(`   Reconnect failed: ${reconnectErr.message?.slice(0, 80)}`);
              break;
            }
          }
          try {
            const currentNonce = await _fetchNonce(BULLETIN_ENDPOINTS, ss58 as string);
            const originalNonce = assignedNonces.get(fail.index);
            if (originalNonce !== undefined && originalNonce < currentNonce) {
              console.log(`   Chunk ${fail.index + 1}: nonce ${originalNonce} consumed (current=${currentNonce}), treating as included`);
              stored[fail.index] = { cid: createCID(fail.chunkData, CID_CONFIG.codec, 0x12), len: fail.chunkData.length, viaFallback: true };
              nonceAdvanceIndices.add(fail.index);
              assignedNonces.delete(fail.index);
              // progress resets the recovery budget — a landed chunk means recovery is
              // healthy, not thrashing (the budget guards no-progress thrashing only). #864
              recoveryHistory.length = 0;
              retried = true;
              break;
            }
            const retryNonce = originalNonce ?? currentNonce;
            const result = await storeChunk(unsafeApi, signer as PolkadotSigner, fail.chunkData, retryNonce, ss58 as string, { fetchNonce: fetchNonceOverride });
            stored[fail.index] = result;
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
              console.log(`   Chunk ${fail.index + 1}: retry isValid:false but CID was probe-failed — treating as already on chain`);
              captureWarning("isValid:false retry treated as success (probe-failed backstop)", { chunkIndex: fail.index + 1, cid: failCid.toString(), attempt });
              stored[fail.index] = { cid: failCid, len: fail.chunkData.length, viaFallback: true };
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

    if (nonceAdvanceIndices.size > 0) {
      const cidToIndex = new Map([...nonceAdvanceIndices].map(i => [(stored[i] as StoredChunk).cid.toString(), i]));
      setDeployAttribute("deploy.pool.nonce_collision_count", nonceAdvanceIndices.size);

      const probeResults = await probeChunks([...cidToIndex.keys()], { client });
      const missingResults = probeResults.filter(r => r.present === false);
      setDeployAttribute("deploy.pool.nonce_collision_missing", missingResults.length);

      if (missingResults.length > 0) {
        captureWarning("nonce-advance collision: re-uploading missing chunks", {
          collision_count: missingResults.length,
        });
      }

      let reuploadCount = 0;
      for (const m of missingResults) {
        const idx = cidToIndex.get(m.cid)!;
        for (let attempt = 1; attempt <= MAX_REPROBE_RETRIES; attempt++) {
          console.log(`   Nonce-collision re-upload: chunk ${idx + 1} (attempt ${attempt}/${MAX_REPROBE_RETRIES})`);
          try {
            const freshNonce = await _fetchNonce(BULLETIN_ENDPOINTS, ss58 as string);
            const result = await storeChunk(unsafeApi, signer as PolkadotSigner, chunks[idx], freshNonce, ss58 as string, { fetchNonce: fetchNonceOverride });
            stored[idx] = result;
            reuploadCount++;
            break;
          } catch (e: any) {
            if (attempt === MAX_REPROBE_RETRIES) {
              throw new Error(`Nonce-collision re-upload of chunk ${idx + 1} failed after ${MAX_REPROBE_RETRIES} attempts: ${e.message?.slice(0, 100)}`);
            }
          }
        }
      }
      setDeployAttribute("deploy.pool.nonce_collision_reupload_count", reuploadCount);
    }

    setDeployAttribute("deploy.pool.account", truncateAddress(ss58) as string);

    const submittedCount = stored.filter((s): s is StoredChunk => !!s && !s.viaFallback).length;
    console.log(submittedCount === 0
      ? `\n   All ${chunks.length} chunks already on chain — nothing submitted`
      : `\n   All ${chunks.length} chunks included in block`);

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
        const rootNonce = await _fetchNonce(BULLETIN_ENDPOINTS, ss58 as string);
        console.log(`   Storing root node (nonce: ${rootNonce})...`);
        const rootTx = unsafeApi.tx.TransactionStorage.store_with_cid_config({ cid: { codec: BigInt(0x70), hashing: toHashingEnum(hashCode) }, data: dagBytes });
        const rootTxOpts = { mortality: { mortal: true, period: 256 }, nonce: rootNonce };
        try {
          const watchResult = await watchTransaction(rootTx, signer!, rootTxOpts, () => {
            console.log(`   Root CID: ${rootCid.toString()}\n`);
            return rootCid.toString();
          }, { label: "root-node", rpc: BULLETIN_ENDPOINTS, senderSS58: ss58, expectedNonce: rootNonce, timeoutMs: CHUNK_TIMEOUT_MS, fetchNonce: fetchNonceOverride });
          result = watchResult.value;
          // Root tx is the canonical upload receipt — it finalises the DAG.
          uploadReceipt = watchResult.receipt;
          break;
        } catch (e: any) {
          if (reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
            await doReconnect();
            continue;
          }
          if (rootAttempt < MAX_ROOT_RETRIES) {
            console.log(`   Root node attempt ${rootAttempt} failed: ${e.message?.slice(0, 80)}`);
            await new Promise(r => setTimeout(r, 6000));
            continue;
          }
          throw e;
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
    // (System.Number can resolve on a destroyed client while
    // TransactionStorage.Authorizations fails with "ChainHead disjointed").
    // Reconnect here so liveProvider carries a healthy client.
    // ownsClient is reset to false: the fresh client is handed off via
    // liveProvider, not destroyed below.
    if (wsHaltDetected && reconnect && reconnectionsUsed < MAX_RECONNECTIONS) {
      wsHaltDetected = false;
      await doReconnect();
      ownsClient = false;
    }

    if (ownsClient) client.destroy();
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
// so callers (notably the gh-pages mirror) can predict the deploy's final
// storage CID from the CAR bytes alone — no chain round-trip required. This
// lets the mirror push fire in parallel with the Bulletin upload: by the
// time Bulletin + DotNS complete the mirror has long since landed and
// Pages has built/propagated, eliminating the "deploy then hit a stale CDN"
// window that plagues sequential publication.
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

export interface StoreDirectoryOptions {
  provider?: ExistingProvider;
  password?: string;
  jsMerkle?: boolean;
  /**
   * Fires exactly once, right after the CAR has been merkleized + encrypted
   * and the final storage CID is known, but BEFORE the chunk upload to
   * Bulletin starts. Use to kick off parallel side-effects (e.g. the
   * gh-pages mirror) that can run concurrently with the slow upload. The
   * returned promise is awaited at the end of the deploy; errors are passed
   * through to the caller so they can decide fatal / non-fatal policy.
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
   * When provided, `fetchPreviousManifest` also tries the GitHub Pages mirror
   * before falling through to the IPFS gateway.
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
  // onCarReady callback fire a parallel mirror push with the final CID in
  // the manifest. Verified against Bulletin's own rootCid computation below.
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
async function readPreviousContenthashSafe(dotns: DotNS, domainName: string): Promise<string | null> {
  try {
    const hex = await dotns.getContenthash(domainName);
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
export function buildFilesMap(buildDir: string, fileCids: Map<string, string> = new Map()): Record<string, ManifestFileEntry> {
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
        const type = classifyFile(rel, { fileCid: fileCid || undefined });
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

// Cheap heuristic: detect the frontend framework used to generate the build dir.
export function detectFramework(directoryPath: string): string | null {
  if (fs.existsSync(path.join(directoryPath, "_next"))) return "next";
  if (fs.existsSync(path.join(directoryPath, "assets"))) return "vite";
  return null;
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
  //   - jsMerkle: false      → Kubo, hard-required (throws if ipfs not on PATH)
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
    const r = await merkleizeWithStableOrder(directoryPath, prevManifest?.stableBlockOrder, { useKubo, phase: "Phase A" });
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
  if (!hasNewChunks) {
    // All section-1 chunks trusted from prev manifest — skip storeChunkedContent entirely.
    console.log(`   Phase A: nothing to upload (all ${phaseAUploadCids.length} section-1 chunks trusted from prev manifest)`);
    phaseASkipProbeResults = new Map(phaseAUploadCids.map(c => [c, true as true]));
    // phaseALiveProvider stays as provider (no extrinsics submitted yet; Phase B will populate its own)
  } else {
    const trustedCount = phaseAUploadCids.length - skipCidsA.size;
    if (trustedCount > 0) {
      console.log(`   Phase A: ${skipCidsA.size} new chunks to upload, ${trustedCount} trusted from prev manifest`);
    }
    await withSpan("deploy.chunk-upload", "1b. chunk-upload (phase A)", {
      "deploy.chunks.total": phaseAUploadChunks.length,
      "deploy.car.bytes": phaseA.carBytes.length,
      "deploy.car.mb": carMbA,
    }, async () => {
      sampleMemory("chunk_upload_start");
      const phaseAUpload = await storeChunkedContent(phaseAUploadChunks, { ...provider, gateway, skipCids: skipCidsA, trustedCids: trustedCidsA, skipRootStore: true }); // phase A: single internal probe, no root store (Phase B's root supersedes), Tier 2 counts discarded (intermediate CAR)
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
  const filesMap = buildFilesMap(directoryPath, phaseA.fileCids);
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
    framework: detectFramework(directoryPath),
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
    const r = await merkleizeWithStableOrder(directoryPath, phaseA.stableOrder, { useKubo, phase: "Phase B" });
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
  // the gh-pages mirror can fire concurrently with the Phase B upload.
  const predictedStorageCid = computeStorageCid(carChunksB);
  if (opts.onCarReady) await opts.onCarReady(phaseB.carBytes, predictedStorageCid);

  // 9. Phase B upload — submits only the chunks that actually changed
  // (typically just the chunk(s) covering the manifest file).
  const carMbB = String(Math.round((phaseB.carBytes.length / 1024 / 1024) * 100) / 100);
  const newPhaseBChunks = carChunkCidsB.filter((c) => !trustedCidsB.has(c)).length;
  const phaseBResult = await withSpan("deploy.chunk-upload", "1d. chunk-upload (phase B)", {
    "deploy.chunks.total": carChunksB.length,
    "deploy.chunks.phase_b_new": newPhaseBChunks,
    "deploy.car.bytes": phaseB.carBytes.length,
    "deploy.car.mb": carMbB,
  }, async () => {
    sampleMemory("chunk_upload_b_start");
    const r = await storeChunkedContent(carChunksB, { ...phaseALiveProvider, gateway, trustedCids: trustedCidsB, probeFailedCids: probeFailedCidsA });
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
    let missingCids = new Set(finalityResults.filter(r => r.present === false).map(r => r.cid));
    setDeployAttribute("deploy.probe.finality_miss_count", missingCids.size);

    let reuploadCount = 0;
    if (missingCids.size === 0) {
      console.log(`   ✓ All ${grandpaCids.length} chunks finalised`);
    } else {
      // Step 2: wait for natural finalisation. Phase B's just-landed chunks
      // (and especially the root, which was the LAST extrinsic submitted)
      // are in best chain but not yet at finalised head — give them time.
      console.log(`   ${missingCids.size} chunks not yet finalised — waiting up to ${GRANDPA_NATURAL_WAIT_MS / 1000}s for natural finalisation`);
      for (const cid of missingCids) console.log(`      ${cid.slice(0, 20)}…`);
      const waitStart = Date.now();
      while (Date.now() - waitStart < GRANDPA_NATURAL_WAIT_MS && missingCids.size > 0) {
        await new Promise(r => setTimeout(r, GRANDPA_REUPLOAD_POLL_MS));
        const poll = await probeChunks([...missingCids], { client: phaseALiveProvider.client!, atFinalized: true });
        for (const r of poll) {
          if (r.present === true) missingCids.delete(r.cid);
        }
      }

      if (missingCids.size === 0) {
        const elapsed = Math.round((Date.now() - waitStart) / 1000);
        console.log(`   ✓ All ${grandpaCids.length} chunks finalised (waited ${elapsed}s)`);
      } else {
        // Step 3: re-upload anything still missing, including root if needed.
        // Root uses DAG-PB codec (0x70); chunks use raw codec (0x55).

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
        const fetchNonceFn = phaseALiveProvider.fetchNonce ?? fetchNonce;

        for (let round = 1; round <= GRANDPA_REUPLOAD_MAX_ROUNDS && missingCids.size > 0; round++) {
          const roundSuffix = round > 1 ? ` (round ${round}/${GRANDPA_REUPLOAD_MAX_ROUNDS}, retry after fork)` : '';
          console.log(`   ${missingCids.size} chunks still missing after wait — re-uploading${roundSuffix}`);

          // Submit all re-uploads first (each takes a fresh nonce, so they must
          // be sequential), then poll all of them together in one shared loop.
          // Saves up to ~(N-1) × poll-interval vs. polling each chunk in turn.
          const reuploadList = [...missingCids];
          for (let i = 0; i < reuploadList.length; i++) {
            const cid = reuploadList[i];
            const freshNonce = await fetchNonceFn(BULLETIN_ENDPOINTS, phaseALiveProvider.ss58 as string);
            if (cid === storageCid) {
              // Root re-upload: store_with_cid_config with DAG-PB codec.
              const rootTx = phaseALiveProvider.unsafeApi.tx.TransactionStorage.store_with_cid_config({
                cid: { codec: BigInt(0x70), hashing: toHashingEnum(rootHashCode) },
                data: rootDagBytes,
              });
              await watchTransaction(rootTx, phaseALiveProvider.signer as PolkadotSigner, { mortality: { mortal: true, period: 256 }, nonce: freshNonce }, () => storageCid, {
                label: "root-reupload",
                rpc: BULLETIN_ENDPOINTS,
                senderSS58: phaseALiveProvider.ss58 as string,
                expectedNonce: freshNonce,
                timeoutMs: CHUNK_TIMEOUT_MS,
                fetchNonce: phaseALiveProvider.fetchNonce,
              });
            } else {
              const chunkBytes = phaseBChunkByCid.get(cid);
              if (!chunkBytes) {
                throw new Error(
                  `Deploy verification failed: chunk ${cid.slice(0, 20)}… missing at finalised head and ` +
                  `its bytes are not in phaseB.chunks (cannot re-upload). This indicates an internal state issue.`
                );
              }
              await storeChunk(phaseALiveProvider.unsafeApi, phaseALiveProvider.signer as PolkadotSigner, chunkBytes, freshNonce, phaseALiveProvider.ss58 as string, { fetchNonce: phaseALiveProvider.fetchNonce });
            }
            reuploadCount++;
            console.log(`      [${i + 1}/${reuploadList.length}] re-uploaded ${cid.slice(0, 20)}… (nonce ${freshNonce})`);
          }

          const reuploadStart = Date.now();
          while (Date.now() - reuploadStart < GRANDPA_REUPLOAD_TIMEOUT_MS && missingCids.size > 0) {
            await new Promise(r => setTimeout(r, GRANDPA_REUPLOAD_POLL_MS));
            const poll = await probeChunks([...missingCids], { client: phaseALiveProvider.client!, atFinalized: true });
            for (const r of poll) {
              if (r.present === true) missingCids.delete(r.cid);
            }
          }
        }

        if (missingCids.size > 0) {
          const stuck = [...missingCids][0];
          throw new Error(
            `Deploy verification failed: ${missingCids.size} chunk(s) not finalised after ${GRANDPA_REUPLOAD_MAX_ROUNDS} re-upload round(s) ` +
            `(first: ${stuck.slice(0, 20)}…). The chain may have dropped chunks due to a persistent fork. Re-run deploy.`
          );
        }
        console.log(`   ✓ All ${grandpaCids.length} chunks finalised after re-upload`);
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
  const framework = detectFramework(directoryPath);
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
  // Tolerance: this fires only on a DEFINITIVE absent (probe returned
  // present:false). Probe-failure (present:null, e.g. transient RPC error)
  // is treated as "unverifiable but the GRANDPA probe seconds ago said
  // present, so trust that" — same policy as the GRANDPA block, which
  // filters missing as `r.present === false` only.
  console.log(`   Final root check: ${storageCid}`);
  const rootProbe = await probeChunks([storageCid], { client: phaseALiveProvider.client!, atFinalized: true });
  if (rootProbe[0]?.present === false) {
    throw new Error(
      `Deploy verification failed: DAG-PB root ${storageCid.slice(0, 20)}… not finalised. ` +
      `The chain may have evicted the root extrinsic. Re-run deploy.`
    );
  }
  if (rootProbe[0]?.present === true) {
    console.log(`   ✓ Root finalised on chain`);
  } else {
    console.log(`   Root re-check inconclusive (RPC error) — GRANDPA probe above already verified; continuing.`);
  }

  return { storageCid, ipfsCid: phaseB.cid, carBytes: phaseB.carBytes };
}

export interface DeployOptions {
  mnemonic?: string;
  /** Optional derivation path applied to the mnemonic (e.g. "//deploy/3"). Defaults to "" (root key). */
  derivationPath?: string;
  /** Pre-built signer — skips mnemonic derivation. Use for QR/mobile signing. */
  signer?: PolkadotSigner;
  /** SS58 address for the signer (required when signer is provided). */
  signerAddress?: string;
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
  /**
   * Opt-in: after a successful deploy, push the CAR to the current repo's
   * `gh-pages` branch under `bulletin/<domain>.dot.car` so hosts can fetch it
   * via `https://<owner>.github.io/<repo>/bulletin/<domain>.dot.car` as a
   * fast-path cache. Non-fatal on failure. See docs/… for the discoverability
   * caveat.
   */
  ghPagesMirror?: boolean;
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
   * After a successful deploy, list the label in the on-chain Publisher
   * registry. Silently skipped on envs that do not have a Publisher contract.
   */
  publish?: boolean;
  /**
   * When true, a publish failure after a successful deploy fails the run.
   * Default (false): warning is logged, deploy still exits 0 — the bytes
   * landed on Bulletin and the contenthash is on chain, the registry is a
   * discovery courtesy.
   */
  failOnPublishError?: boolean;
  /**
   * Override/supply DotNS contract addresses, shallow-merged OVER the chosen
   * env's `contracts` map (these win). The `custom` env ships no addresses, so
   * this is how they are provided. Keys are the DOTNS_* names used in
   * environments.json (e.g. DOTNS_REGISTRY, DOTNS_CONTENT_RESOLVER).
   * CLI: --contract <KEY>=<0xADDRESS> (repeatable).
   */
  contracts?: Record<string, string>;
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
): { signer?: PolkadotSigner; signerAddress?: string; mnemonic?: string; derivationPath?: string; assetHubEndpoints?: string[]; autoAccountMapping?: boolean; contracts?: Record<string, string>; nativeToEthRatio?: bigint; environmentId?: string; popSelfServe?: PopSelfServeConfig | null; registerStorageDeposit?: bigint } {
  const tail = assetHubEndpoints && assetHubEndpoints.length > 0 ? { assetHubEndpoints } : {};
  const mappingTail = autoAccountMapping ? { autoAccountMapping } : {};
  const contractsTail = contracts && Object.keys(contracts).length > 0 ? { contracts } : {};
  const ratioTail = nativeToEthRatio ? { nativeToEthRatio } : {};
  const envTail = environmentId ? { environmentId } : {};
  const popTail = popSelfServe !== undefined ? { popSelfServe } : {};
  const storageTail = registerStorageDeposit !== undefined ? { registerStorageDeposit } : {};
  if (options.signer && options.signerAddress) {
    return { signer: options.signer, signerAddress: options.signerAddress, ...tail, ...mappingTail, ...contractsTail, ...ratioTail, ...envTail, ...popTail, ...storageTail };
  }
  return { mnemonic: options.mnemonic, derivationPath: options.derivationPath, ...tail, ...mappingTail, ...contractsTail, ...ratioTail, ...envTail, ...popTail, ...storageTail };
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
): void {
  if (result.owned && result.owner?.toLowerCase() !== signerEvmAddress?.toLowerCase()) {
    throw new NonRetryableError(
      `Subdomain ${sublabel}.${parentLabel}.dot is already owned by ${result.owner} (signer is ${signerEvmAddress}). ` +
      `Use a fresh subdomain label, or release the existing registration.`
    );
  }
}

// Publish step. Subdomains are not supported by the Publisher contract (it only
// indexes top-level `.dot` labels) so we skip rather than publish the parent.
async function publish(
  dotns: DotNS,
  parsed: ParsedDomainName,
  failOnError: boolean | undefined,
): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("Publish");
  console.log("=".repeat(60));
  if (parsed.isSubdomain) {
    console.log(`   Subdomains are not supported by the Publisher registry — skipping.`);
    return;
  }
  try {
    const result = await dotns.publishLabel(parsed.label);
    setDeployAttribute("deploy.publish.status", result.status);
    if (result.txHash) setDeployAttribute("deploy.publish.tx", result.txHash);
    console.log(`   Status: ${result.status}`);
  } catch (e: any) {
    if (e instanceof PublisherNotSupportedError) {
      console.log(`   Skipped: ${e.message}`);
      return;
    }
    setDeployAttribute("deploy.publish.status", "failed");
    if (failOnError) throw e;
    const msg = e?.message ?? String(e);
    console.log(`   Publish failed: ${msg}`);
  }
}

// Entrypoint for `bulletin-deploy --unpublish`. Opens a DotNS connection on
// the chosen env, calls Publisher.unpublish, and exits. Does not touch
// Bulletin, IPFS, or the build directory — there is nothing to deploy.
export async function unpublish(
  domainName: string,
  options: { mnemonic?: string; derivationPath?: string; rpc?: string; env?: string } = {},
): Promise<{ domainName: string; status: "unpublished" | "already-unpublished"; txHash?: string }> {
  const envId = options.env ?? DEFAULT_ENV_ID;
  const { doc } = await loadEnvironments();
  const resolved = resolveEndpoints(doc, envId);
  const popSelfServe = getPopSelfServeConfig(doc, envId);
  const parsed = parseDomainName(domainName);
  if (parsed.isSubdomain) {
    throw new Error(`Subdomains are not supported by the Publisher registry. To unpublish ${parsed.parentLabel}.dot (which controls ${domainName}), pass that label directly.`);
  }
  const label = parsed.label;
  const dotns = new DotNS();
  try {
    await dotns.connect(resolveDotnsConnectOptions(
      { mnemonic: options.mnemonic, derivationPath: options.derivationPath },
      resolved.assetHub,
      resolved.autoAccountMapping,
      resolved.contracts,
      resolved.nativeToEthRatio,
      envId,
      popSelfServe,
      resolved.registerStorageDeposit,
    ));
    const result = await dotns.unpublishLabel(label);
    return { domainName: `${label}.dot`, status: result.status, txHash: result.txHash };
  } finally {
    try { dotns.disconnect(); } catch {}
  }
}

/**
 * Returns the dot.li browser URL for the given domain name, optionally
 * suffixed with a network query parameter so the SPA opens the right chain.
 * Currently only the "preview" env needs a suffix — the SPA defaults to
 * paseo-next-v2 which would show "no content" for preview deployments.
 * @param name - the DotNS label (e.g. "myapp")
 * @param envId - the environment id from options.env ?? DEFAULT_ENV_ID
 */
export function browserUrlFor(name: string, envId: string | undefined): string {
  const base = `https://${name}.dot.li`;
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
  // Resolve the target environment. options.bulletinEndpoints / assetHubEndpoints
  // bypass the loader for tests and library callers.
  const envId = options.env ?? DEFAULT_ENV_ID;
  let envBulletin: string[] = [DEFAULT_BULLETIN_RPC];
  let envAssetHub: string[] | undefined;
  let envSource: string | undefined;
  let envNetwork: string | undefined;
  let envName: string | undefined;
  let envIpfs: string | undefined;
  let envAutoAccountMapping = false;
  let envContracts: Record<string, string> = {};
  let envNativeToEthRatio: bigint | undefined;
  let envRegisterStorageDeposit: bigint | undefined;
  let envPopSelfServe: PopSelfServeConfig | null = null;
  if (options.bulletinEndpoints && options.bulletinEndpoints.length > 0) {
    envBulletin = options.bulletinEndpoints;
    envAssetHub = options.assetHubEndpoints;
  } else {
    try {
      const { doc, source } = await loadEnvironments();
      const resolved = resolveEndpoints(doc, envId);
      envBulletin = resolved.bulletin;
      envAssetHub = options.assetHubEndpoints ?? resolved.assetHub;
      envSource = source;
      envNetwork = resolved.network;
      envName = resolved.envName;
      envIpfs = resolved.ipfs;
      envAutoAccountMapping = resolved.autoAccountMapping;
      envContracts = resolved.contracts;
      envNativeToEthRatio = resolved.nativeToEthRatio;
      envRegisterStorageDeposit = resolved.registerStorageDeposit;
      envPopSelfServe = getPopSelfServeConfig(doc, envId);
    } catch (e) {
      if (e instanceof NonRetryableError) throw e;
      if (options.env !== undefined) throw e;
      captureWarning(`environments load failed: ${(e as Error)?.message ?? e}`);
    }
  }
  // CLI/library-supplied contract addresses win over the env's map. The `custom`
  // env intentionally ships no addresses, so they must be provided this way.
  if (options.contracts && Object.keys(options.contracts).length > 0) {
    envContracts = { ...envContracts, ...options.contracts };
  }
  const userRpc = options.rpc ?? process.env.BULLETIN_RPC;
  BULLETIN_ENDPOINTS = userRpc
    ? [userRpc, ...envBulletin.filter(e => e !== userRpc)]
    : envBulletin;
  _deployRpcFailedOver = false;
  POOL_SIZE = options.poolSize ?? parseInt(process.env.BULLETIN_POOL_SIZE ?? String(DEFAULT_POOL_SIZE), 10);

  // Signer resolution — "resolve" fires ONLY when --suri is explicitly passed.
  // Pool mode (no mnemonic, no signer, no suri) falls through unchanged — no SSO load.
  // Injected signer (options.signer) and mnemonic paths are also unchanged.

  // Validate the label up-front (parseDomainName runs the pure, chain-free
  // validateDomainLabel) so an invalid one — e.g. a Reserved <=5-char base name —
  // fails before we print a signer plan that can never matter.
  const parsed: ParsedDomainName | null = domainName ? parseDomainName(domainName) : null;

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
      options = {
        ...options,
        signer: actors.worker.signer,
        signerAddress: actors.worker.address,
        ...(actors.recipientH160 ? { transferTo: actors.recipientH160 } : {}),
      };
      sessionCleanup = actors.worker.destroy.bind(actors.worker);
      if (actors.worker.source === "session") resolvedUserSession = actors.worker;
      if (actors.recipientH160) {
        console.log(`   Worker: ${actors.worker.source} signer ${actors.worker.address} (final owner: ${actors.recipientH160})`);
      } else {
        console.log(`   Using ${actors.worker.source} signer: ${actors.worker.address}`);
      }
    } catch (e) {
      if (options.suri) throw e;
      if ((e as { name?: string } | null)?.name === "SignerNotAvailableError") {
        if (hasSession) console.error(STALE_SESSION_MESSAGE);
        else console.log(`   Login session unavailable or expired — falling back to pool. Run \`${CLI_NAME} login\` to use your identity.`);
      } else {
        throw e; // includes MainnetDefaultWorkerError — surface it
      }
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
        throw new NonRetryableError(
          "Session signing allowance has expired (~2-3 days after login). " +
          `Run \`${CLI_NAME} logout\`, then \`${CLI_NAME} login\`, to renew ` +
          "(login alone won't refresh a stale session).",
        );
      }
      // allowed === null → People chain unreachable; don't block the deploy.
    } catch (e) {
      if (e instanceof NonRetryableError) throw e;
      // Any other error (network, bad endpoint) — skip the check, don't block.
    }
  }

  // Resolve slot-account signer for Bulletin storage for ALL callers.
  // Programmatic callers are expected to pass storageSigner directly; if they
  // don't (or if their slot account is not yet authorized), we try to obtain
  // one via the host-papp allowance service.
  //
  // host-papp's getBulletinSigner sends callingProductId = DOT_PRODUCT_ID.
  // Identity is now unified (DOT_PRODUCT_ID === DOT_DAPP_ID === adapter.appId ===
  // "polkadot-app-deploy", #885), so this productId matches both the QR-pairing
  // product and the terminal allowance cache — the historical productId≠appId
  // mismatch that forced this host-papp path is gone. (Follow-up: this read could
  // move to the terminal-cache reader createSlotAccountSigner, same as login step 2.)
  //
  // Pool is always the final fallback; nothing here aborts the deploy.
  if (!options.storageSigner) {
    let storageLine: string | null = null;
    try {
      if (resolvedUserSession?.userSession && resolvedUserSession?.adapter) {
        const { ss58Encode } = await import("@parity/product-sdk-address");
        const signerResult = await resolvedUserSession.adapter.allowance.getBulletinSigner(
          resolvedUserSession.userSession.id,
          DOT_PRODUCT_ID,
        );
        if (signerResult.isOk()) {
          const slotSigner = signerResult.value;
          const slotAddress = ss58Encode(slotSigner.publicKey);
          options = { ...options, storageSigner: slotSigner, storageSignerAddress: slotAddress };
          storageLine = formatStorageSignerLine(slotAddress);
        } else {
          // On Err (NoSession / Rejected / NotAvailable / UnexpectedResponse) — fall through to pool.
          storageLine = formatStorageSignerLine(null, signerResult.error.reason);
        }
      } else {
        storageLine = formatStorageSignerLine(null);
      }
    } catch {
      // getBulletinSigner threw (rare) — fall back to pool silently.
      storageLine = formatStorageSignerLine(null, "error");
    }
    if (storageLine) console.log(storageLine);
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
    if (envNetwork) setDeployAttribute("deploy.network", envNetwork);
    if (envSource) setDeployAttribute("deploy.environments_source", envSource);
    setDeployAttribute("deploy.transfer.enabled", options.transferTo ? "true" : "false");

    let cid: string | undefined;
    let ipfsCid: string | undefined;
    // Parallel mirror push: fires from storeDirectory's onCarReady the moment
    // the CAR is ready, runs concurrently with the (typically slow) Bulletin
    // upload + DotNS. By the time we reach the final-checks section below,
    // Pages has usually long since built and propagated the CDN, so the
    // "freshness" poll at the end completes almost immediately for small
    // apps and well within timeout for larger ones.
    let mirrorPromise: Promise<MirrorResult | MirrorSkipped | Error | null> = Promise.resolve(null);
    console.log("\n" + "=".repeat(60));
    console.log(`DEPLOYING TO TESTNET                    v${VERSION}`);
    console.log("=".repeat(60));
    if (envName) console.log(`   Environment: ${envName}`);
    console.log(`   Domain: ${name}.dot`);
    if (deployTag) console.log(`   Tag: ${deployTag}`);
    if (options.inputCar) console.log(`   Input CAR: ${path.resolve(options.inputCar)}`);
    else if (typeof content === "string") console.log(`   Build dir: ${path.resolve(content)}`);
    if (process.env.CI) console.log(`   Runner: ${resolveRunner()} (${resolveRunnerType()})`);
    if (options.password) console.log(`   Encrypted: yes`);

    let provider: ProviderResult | undefined;
    const reconnect = selectStorageReconnect(options);
    // Hoisted so the DotNS phase below can reuse the pre-upload eligibility
    // result when deciding whether registration can continue.
    let dotnsPreflight: DotnsPreflightResult | null = null;
    // Hoisted so the storage phase below can pass it to storeDirectoryV2
    // for incremental upload. Resolved during preflight (or null if no
    // existing contenthash / read failed). Decoded from on-chain e3-prefixed
    // bytes to the IPFS CID string.
    let previousContenthashCid: string | null = null;
    // Hoisted so the phone-signing banner and the publish skip below can both
    // read the preflight-determined publish state. false = already published or
    // publish not requested or not supported.
    let preflightPublishNeeded = false;
    try {
      // Check domain ownership before uploading anything
      console.log("\n" + "=".repeat(60));
      console.log("Preflight");
      console.log("=".repeat(60));


      const preflight = new DotNS();
      await preflight.connect(resolveDotnsConnectOptions(options, envAssetHub, envAutoAccountMapping, envContracts, envNativeToEthRatio, envId, envPopSelfServe, envRegisterStorageDeposit));
      // connect() now guarantees the account is mapped before returning — no
      // post-connect mapping wait needed here. See DotNS.connect() in dotns.ts.

      // Subdomain deploys use a different on-chain path (setSubnodeOwner on
      // the Registry, no commit-reveal or PoP). Skip the TLD preflight and
      // just verify the signer owns the parent; if the subname is already
      // ours or unowned, the DotNS phase below will do the right thing.
      if (parsed?.isSubdomain) {
        try {
          const subResult = await preflight.checkSubdomainOwnership(parsed.sublabel!, parsed.parentLabel!);
          assertSubdomainOwnerMatchesSigner(subResult, preflight.evmAddress, parsed.sublabel!, parsed.parentLabel!);
          if (!subResult.owned) {
            const { owned: parentOwned, owner: parentOwner } = await preflight.checkOwnership(parsed.parentLabel!);
            if (!parentOwned) {
              throw new NonRetryableError(
                `Cannot deploy ${parsed.fullName}: parent ${parsed.parentLabel}.dot is owned by ${parentOwner ?? "no one"}, not by this signer.`
              );
            }
          }
          // Best-effort: read the existing contenthash so the storage phase
          // can drive incremental upload. Non-fatal — first deploy returns "0x".
          previousContenthashCid = await readPreviousContenthashSafe(preflight, parsed.fullName);
          setDeployAttribute("deploy.incremental", previousContenthashCid ? "true" : "false");
        } finally {
          preflight.disconnect();
        }
        console.log(`   Mode: subdomain (parent ${parsed.parentLabel}.dot owned by signer)`);
      } else {
        // Full DotNS readiness check — runs every view-only rule we know
        // (classification, ownership, reservation, PoP gate) BEFORE touching
        // Bulletin. Advisory; registerDomain keeps its own internal checks.
        // Issue #100.
        preflightPublishNeeded = false;
        try {
          dotnsPreflight = await preflight.preflight(name, { transferRecipientH160: options.transferTo });
          previousContenthashCid = await readPreviousContenthashSafe(preflight, name);
          setDeployAttribute("deploy.incremental", previousContenthashCid ? "true" : "false");

          // Check publish state during preflight so tap count is accurate upfront.
          if (options.publish && parsed && !parsed.isSubdomain) {
            const publisher = (preflight as any)._contracts?.PUBLISHER;
            const zeroAddr = "0x0000000000000000000000000000000000000000";
            if (!publisher || publisher === zeroAddr) {
              console.log(`   Publish: not supported on this environment — will be skipped`);
            } else {
              const labelhash = keccak256(toBytes(name));
              try {
                const alreadyPublished = await preflight.contractCall(
                  publisher,
                  PUBLISHER_ABI,
                  "isPublished",
                  [labelhash],
                );
                preflightPublishNeeded = !alreadyPublished;
                if (!preflightPublishNeeded) {
                  console.log(`   Publish: already published — will be skipped`);
                }
              } catch {
                // isPublished read failed — conservative: assume publish will be needed
                preflightPublishNeeded = true;
              }
            }
          }
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
        console.log(`   DotNS: ${name}.dot requires ${popStatusName(dotnsPreflight.classification.status)}${reqSuffix}`);
        if (dotnsPreflight.canProceed) {
          const fromName = popStatusName(dotnsPreflight.userStatus);
          console.log(`   Your PoP: ${fromName}`);
          console.log(`   Domain: ${alreadyOwned ? "owned by you" : "available"}`);
        }

        if (!dotnsPreflight.canProceed) {
          throw new NonRetryableError(
            dotnsPreflight.reason ?? "DotNS preflight rejected the deploy; please check the label and signer."
          );
        }
      }

      // Phone signing summary — only for a phone-backed signer (see phoneSignerActive).
      if (phoneSignerActive) {
        const steps = computePhoneSigningSteps(dotnsPreflight, preflightPublishNeeded);
        if (steps.length === 1) {
          console.log(`\nHave your phone ready — 1 signature needed (${steps[0].toLowerCase()})`);
        } else if (steps.length > 1) {
          const display = steps.flatMap((s, i) =>
            s === "Register" && steps[i - 1] === "Commitment" ? ["(wait)", s] : [s]
          );
          console.log(`\nHave your phone ready — ${steps.length} signatures needed`);
          console.log(`   ${display.map(s => s.toLowerCase()).join(" · ")}`);
        }
      }

      // Storage provider selection: signer > mnemonic > pool (mirrors resolveDotnsConnectOptions precedence).
      // When options.signer + options.signerAddress are set, Bulletin uploads use the external signer
      // and go through getSignerProvider — ensureAuthorized throws when the account is not authorized.
      provider = await reconnect();
      const providerWithReconnect: ExistingProvider = { ...provider, reconnect };

      const isTestnet = await detectTestnet(provider.unsafeApi);
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
          const predictedStorageCid = computeStorageCid(carChunks);
          if (options.ghPagesMirror) {
            mirrorPromise = mirrorToGitHubPages({
              domain: name,
              carBytes: carContent,
              cid: predictedStorageCid,
              toolVersion: VERSION,
              bulletinRpc: BULLETIN_ENDPOINTS[0],
              encrypted: Boolean(options.password),
              repoPath: process.env.PAD_GH_PAGES_REPO || undefined,
            }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
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
            // pinned through DotNS + mirror wait. Route through storeDirectoryV2
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
              onCarReady: (carBytes, predictedCid) => {
                // Kick off the gh-pages mirror the instant the CAR is ready
                // so it overlaps with the Bulletin chunk upload. The Bulletin
                // upload is minutes; the mirror push + Pages build is ~1–2 min.
                // Running them in parallel means the final-checks URL probe
                // at the end of the deploy usually passes immediately.
                if (options.ghPagesMirror) {
                  mirrorPromise = mirrorToGitHubPages({
                    domain: name,
                    carBytes,
                    cid: predictedCid,
                    toolVersion: VERSION,
                    bulletinRpc: BULLETIN_ENDPOINTS[0],
                    encrypted: Boolean(options.password),
                    repoPath: process.env.PAD_GH_PAGES_REPO || undefined,
                  }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
                }
              },
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
          console.log(`   You already own ${name}.dot — updating its content needs your signature.`);
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
            ...resolveDotnsConnectOptions({ ...options, signer: owner.signer, signerAddress: owner.address }, envAssetHub, envAutoAccountMapping, envContracts, envNativeToEthRatio, envId, envPopSelfServe, envRegisterStorageDeposit),
            onPhoneSigningRequired: (label: string) => console.log(`\n   Check your phone → ${label}`),
          });
          // Publish (if requested) needs a second owner signature; reflect that in the
          // heads-up so the count matches the phone taps that follow.
          const willPublish = !!(options.publish && parsed && preflightPublishNeeded !== false);
          console.log(willPublish
            ? `\nHave your phone ready — 2 signatures needed (link content · publish)`
            : `\nHave your phone ready — 1 signature needed (link content)`);
          const contenthashHex = `0x${encodeContenthash(cid as string)}`;
          // #885: the owner is the PGAS-funded session account; elect PGAS for the
          // AH fee so a zero-native owner can update content faucet-free.
          await ownerDotns.setContenthash(name, contenthashHex, { feeAsset: "pgas" });
          // Mirror the main path's publish step — the owner is authorised to publish too.
          if (willPublish) await publish(ownerDotns, parsed!, options.failOnPublishError);
          return;
        }

        const dotns = new DotNS();
        await dotns.connect({
          ...resolveDotnsConnectOptions(options, envAssetHub, envAutoAccountMapping, envContracts, envNativeToEthRatio, envId, envPopSelfServe, envRegisterStorageDeposit),
          // Per-step "check your phone" reminder — only for a phone-backed signer
          // (see phoneSignerActive); a transfer-mode local worker signs locally.
          ...(phoneSignerActive
            ? { onPhoneSigningRequired: (label: string) => console.log(`\n   Check your phone → ${label}`) }
            : {}),
        });

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
            const parentOwnership = await dotns.checkOwnership(parsed.parentLabel!);
            if (!parentOwnership.owned) throw new Error(`You must own ${parsed.parentLabel}.dot to register subdomains under it`);
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

        // Publish step. Runs after the durable on-chain state (contenthash)
        // is in place so a publish revert can never roll back the CID write.
        // Skipped silently on envs without a Publisher contract — the
        // mirror-to-paseo-next-v2 run will pick it up when relevant.
        if (options.publish && parsed) {
          if (preflightPublishNeeded !== false) {
            await publish(dotns, parsed, options.failOnPublishError);
          }
          // preflightPublishNeeded === false: preflight confirmed already-published — skip silently.
        }

        // Zero-mobile-sig handover: the worker (Alice/--mnemonic) signed the whole
        // deploy above; now hand the finished name to the signed-in account. One
        // ERC-721 transferFrom moves ownership + resolver authorisation. Idempotent.
        // Own span so a handover failure attributes to deploy.transfer, not to
        // deploy.dotns (register + setContenthash already succeeded by here).
        // #928: only hand over a name THIS run freshly registered — re-deploying
        // (updating content of) a pre-existing name must not change its owner.
        if (options.transferTo && !registeredFresh) {
          console.log(`   ${name}.dot already existed — updated content only; ownership unchanged (not transferred to ${options.transferTo}).`);
          // Actionable, because this also fires when a retry re-ran the whole
          // deploy after attempt 1 freshly registered + then flaked on
          // setContenthash/publish: attempt 2 sees "Already owned", so the
          // handover this run owed never happens. transferName is idempotent,
          // so the recovery command is always safe to run.
          console.log(`   If you meant to claim it, run: ${CLI_NAME} transfer ${name} --env ${envId}${options.suri ? ` --mnemonic "<your worker key>"` : ""}`);
          setDeployAttribute("deploy.transfer.status", "skipped-existing");
        }
        if (shouldHandoverName({ transferTo: options.transferTo, registeredFresh })) {
          const transferTo = options.transferTo!;
          await withSpan("deploy.transfer", `3. transfer ${name}.dot`, { "deploy.transfer.to": transferTo }, async () => {
            setDeployAttribute("deploy.transfer.worker", truncateAddress(options.signerAddress ?? "") as string);
            setDeployAttribute("deploy.transfer.to", transferTo);
            try {
              const transferRes = await dotns.transferName(name, transferTo, (s) => console.log(`   ${s}`));
              setDeployAttribute("deploy.transfer.status", transferRes.status);
              if (transferRes.feeWei != null) setDeployAttribute("deploy.transfer.fee_wei", transferRes.feeWei.toString());
              console.log(`   Handed ${name}.dot to ${transferTo} (${transferRes.status}${transferRes.txHash ? `, tx ${transferRes.txHash}` : ""}).`);
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

      // Final checks: join the mirror push (which has been running in
      // parallel since onCarReady fired mid-storage) and verify Pages is
      // actually serving this deploy's bytes. Non-fatal: on-chain state is
      // authoritative, and a late-blooming Pages build would catch up soon
      // after the CLI exits — but surfacing the wait here means a user who
      // immediately opens dot.li / Desktop after the CLI returns sees fresh
      // content instead of racing against CDN propagation.
      if (options.ghPagesMirror) {
        console.log("\n" + "=".repeat(60));
        console.log("Final checks");
        console.log("=".repeat(60));
        await withSpan("deploy.gh-pages-mirror", "4. gh-pages-mirror", { "deploy.domain": name }, async () => {
          const mirror = await mirrorPromise;
          if (mirror === null) {
            console.log("   GitHub Pages mirror: skipped (only directory deploys produce a CAR suitable for mirroring).");
            return;
          }
          if (mirror instanceof MirrorSkipped) {
            console.log(`   GitHub Pages mirror: skipped — ${mirror.message}`);
            return;
          }
          if (mirror instanceof Error) {
            console.log(`   GitHub Pages mirror: failed (non-fatal) — ${mirror.message}`);
            captureWarning("gh-pages mirror failed", { error: mirror.message.slice(0, 200) });
            return;
          }
          console.log(`   Mirror: ${mirror.url}`);
          console.log(`   Manifest: https://${mirror.owner}.github.io/${mirror.repo}/${mirror.manifestPath}`);
          setDeployAttribute("deploy.gh_pages_url", mirror.url);
          process.stdout.write("   Verifying Pages serves this deploy's CAR... ");
          const freshness = await pollMirrorFreshness(mirror.url, cid as string, { timeoutMs: 3 * 60 * 1000, intervalMs: 10_000 });
          if (freshness.verified) {
            console.log(`ok (${freshness.attempts} attempt${freshness.attempts === 1 ? "" : "s"}, ${(freshness.durationMs / 1000).toFixed(0)}s).`);
            setDeployAttribute("deploy.gh_pages_freshness_verified", "true");
          } else {
            // Non-fatal: courtesy poll only. Pages CDN propagation can run past our 3-min budget,
            // especially on self-hosted runners. Record the outcome as a span attribute (both
            // values, per ratio-attribute convention) without flipping deploy.sad.
            console.log(`timed out.`);
            console.log(`   GitHub Pages last served cid=${freshness.lastCid ?? "n/a"} (expected ${cid}); it should catch up shortly. Non-fatal.`);
            setDeployAttribute("deploy.gh_pages_freshness_verified", "false");
          }
        });
      }

      console.log("\n" + "=".repeat(60));
      console.log("DEPLOYMENT COMPLETE!");
      console.log("=".repeat(60));
      console.log("\nCheck it out here:");
      console.log(`   ${browserUrlFor(name, envId)}`);
      console.log(`   ${name}.dot  (in a Polkadot-aware browser)`);
      console.log("\n" + "=".repeat(60) + "\n");
      return { domainName: name, fullDomain: `${name}.dot`, cid: cid as string, ipfsCid };
    } finally {
      // Flush the module-level failover flag in case onStatusChanged fired after
      // the deploy span attribute was already written. Idempotent if already set.
      if (_deployRpcFailedOver) setDeployAttribute("deploy.rpc.failed_over", "true");
      provider?.client.destroy();
    }
  });
  } finally {
    // Release the QR/mobile session adapter if one was acquired in the resolve branch.
    sessionCleanup?.();
  }
}

/**
 * Compute the ordered list of step labels that will require a phone tap,
 * given the DotNS preflight result and whether publish is needed.
 * Returns [] when deploy would abort or preflight is null.
 * Exported for unit testing.
 */
export function computePhoneSigningSteps(
  dotnsPreflight: { plannedAction: string; needsPopUpgrade: boolean } | null,
  publishNeeded: boolean,
): string[] {
  if (!dotnsPreflight || dotnsPreflight.plannedAction === "abort") return [];
  const steps: string[] = [];
  if (dotnsPreflight.plannedAction === "register") {
    steps.push("Commitment", "Register");
  }
  steps.push("Link content");
  if (publishNeeded) steps.push("Publish to registry");
  return steps;
}
