import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { createClient, Enum } from "polkadot-api";
import type { PolkadotSigner } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { getWsProvider } from "polkadot-api/ws";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { NonRetryableError } from "./errors.js";

// Both Paseo Asset Hub and Paseo Bulletin report `tokenDecimals: 10` via
// system_properties — same on Polkadot Asset Hub. Display formatter for tools
// and bootstrap logs that read System.Account on either chain. Kept local to
// avoid a module cycle with src/dotns.ts (which already imports from here).
const PAS_DECIMALS_DIVISOR = 10_000_000_000;
export function formatPasBalance(plancks: bigint): string {
  return (Number(plancks) / PAS_DECIMALS_DIVISOR).toFixed(4);
}

export interface PoolAccount {
  index: number;
  path: string;
  publicKey: Uint8Array;
  signer: PolkadotSigner;
  address: string;
}

export interface PoolAuthorization extends PoolAccount {
  transactions: bigint;
  // Renew headroom, NOT "bytes left to store" — store is not byte-gated at all.
  // See remainingRenewBytes.
  renewBytes: bigint;
  expiration: number;
}

export const DEPLOY_PATH_PREFIX = "//deploy";

// Derivation path for pool account N off the pool mnemonic. In E2E, the same
// account is now the DotNS owner as well as the Bulletin storage signer (#1054),
// so the harness derives the DotNS signer with this exact path to match
// derivePoolAccounts() / the pinned BULLETIN_POOL_ACCOUNT_INDEX.
export function poolAccountDerivationPath(index: number): string {
  return `${DEPLOY_PATH_PREFIX}/${index}`;
}

/** Inverse of poolAccountDerivationPath: N for "//deploy/N", else undefined. */
export function parsePoolDerivationIndex(path: string): number | undefined {
  const prefix = `${DEPLOY_PATH_PREFIX}/`;
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  return /^\d+$/.test(rest) ? Number(rest) : undefined;
}

// Pure decision for the #1054 Asset Hub pre-fund: a pool leg pays its own DotNS
// fees (register/setContenthash) on Asset Hub now that it is the DotNS owner.
// The E2E pre-check tops these up FROM ALICE SERIALLY before the matrix runs, so
// concurrent legs never race on Alice's Asset Hub nonce mid-run (funding via the
// in-deploy auto-top-up would reintroduce exactly the #1054 collision on the
// transfer tx). Returns the transfer amount to reach `targetRaw` (0n if already
// at/above `thresholdRaw`).
export function assetHubTopUpAmount(balanceRaw: bigint, thresholdRaw: bigint, targetRaw: bigint): bigint {
  if (balanceRaw >= thresholdRaw) return 0n;
  const amount = targetRaw - balanceRaw;
  return amount > 0n ? amount : 0n;
}

// Exported so scripts/e2e-ensure-authorized.mjs (the E2E prerequisites
// check) can share these quota constants instead of hand-maintaining a
// second copy that can silently drift from this one.
export const TOPUP_TRANSACTIONS = 1000;
export const TOPUP_BYTES = 100_000_000n; // 100MB
const WS_HEARTBEAT_TIMEOUT_MS = 300_000;

/**
 * The mnemonic the `//deploy/N` pool is derived from, for EVERY entry point that touches the
 * pool — the deploy path and `polkadot-app-bootstrap` alike.
 *
 * The two used to disagree: the deploy path read `BULLETIN_POOL_MNEMONIC` only, while bootstrap
 * also accepted `MNEMONIC`. With `MNEMONIC` set and `BULLETIN_POOL_MNEMONIC` unset — the normal
 * shape for anyone exporting a single mnemonic, and what the nightly E2E jobs do — bootstrap
 * authorized one set of accounts while deploys uploaded from another, and the only symptom was
 * an unauthorized-storage failure on an env that had just been bootstrapped.
 *
 * `MNEMONIC` deliberately does NOT participate: it names the DotNS signing account, and the pool
 * is a distinct, shared identity. Accepting it here would silently re-point every pool deploy at
 * an account with no grant. See `describeIgnoredPoolMnemonicEnv` for the warning bootstrap prints
 * when the two are confusable.
 */
export function resolvePoolMnemonic(explicit?: string): string {
  return explicit || process.env.BULLETIN_POOL_MNEMONIC || DEV_PHRASE;
}

/**
 * Warning text for the one case where an operator can reasonably expect `MNEMONIC` to drive pool
 * derivation and it does not, or null when there is nothing to say. Pure so it can be unit-tested
 * without spawning the bootstrap CLI.
 */
export function describeIgnoredPoolMnemonicEnv(
  env: Record<string, string | undefined> = process.env,
  explicitFlag?: string,
): string | null {
  if (explicitFlag || env.BULLETIN_POOL_MNEMONIC || !env.MNEMONIC) return null;
  return (
    "MNEMONIC is set but BULLETIN_POOL_MNEMONIC is not — pool accounts are derived from the " +
    "default dev phrase, NOT from MNEMONIC (the deploy path does the same). Set " +
    "BULLETIN_POOL_MNEMONIC, or pass --mnemonic, to bootstrap a different pool."
  );
}

export function derivePoolAccounts(poolSize: number = 10, mnemonic: string = DEV_PHRASE): PoolAccount[] {
  const entropy = mnemonicToEntropy(mnemonic);
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const keyring = new Keyring({ type: "sr25519" });

  const accounts: PoolAccount[] = [];
  for (let i = 0; i < poolSize; i++) {
    const path = `${DEPLOY_PATH_PREFIX}/${i}`;
    const keyPair = derive(path);
    const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
    const address = keyring.encodeAddress(keyPair.publicKey);
    accounts.push({ index: i, path, publicKey: keyPair.publicKey, signer, address });
  }
  return accounts;
}

// Client-side view of one account's Bulletin storage authorization. Fields mirror
// the runtime API's `AccountAuthorization`, except `expiration` (`expires_at`
// on-chain) — the name every consumer here already speaks.
export interface BulletinAuthorization {
  expiration: number;
  transactionsAllowance: number;
  transactionsUsed: number;    // store + renew
  bytesAllowance: bigint;
  bytesUsed: bigint;           // store — soft, see remainingRenewBytes
  bytesPermanentUsed: bigint;  // renew — the only counter with a hard cap
}

// The AccountAuthorization fields readAccountAuthorization maps. Exported so the
// live chain-call test guards exactly the set the client reads, never a stale copy.
export const ACCOUNT_AUTHORIZATION_FIELDS = [
  "expires_at",
  "bytes_allowance",
  "bytes_used",
  "bytes_permanent_used",
  "transactions_allowance",
  "transactions_used",
] as const;

/**
 * Read an account's Bulletin storage authorization via the
 * `BulletinTransactionStorageApi::account_authorization` runtime API — the one
 * chain entry point for this, replacing the old `TransactionStorage.Authorizations`
 * read. That entry is no longer client-readable: its `AuthorizationExtent` carries
 * an opaque consumer payload (`extra`) where `bytes_permanent` used to sit.
 *
 * Returns null both when the account was never authorized and when its grant has
 * lapsed — the API filters expired entries, so a non-null result is always active.
 *
 * A `Some` missing any field throws instead of defaulting to 0: a renamed field
 * would otherwise read as "no allowance, expires at block 0" and fail every deploy
 * with a message pointing at the account rather than at the chain.
 */
export async function readAccountAuthorization(api: any, address: string): Promise<BulletinAuthorization | null> {
  const auth = await api.apis.BulletinTransactionStorageApi.account_authorization(address);
  if (auth == null) return null;
  const missing = ACCOUNT_AUTHORIZATION_FIELDS.filter(f => auth[f] == null);
  if (missing.length > 0) {
    throw new Error(
      `Bulletin returned an AccountAuthorization for ${address} without ${missing.join(", ")} — ` +
      `this chain's BulletinTransactionStorageApi does not match what polkadot-app-deploy reads. Upgrade polkadot-app-deploy.`,
    );
  }
  return {
    expiration: Number(auth.expires_at),
    transactionsAllowance: Number(auth.transactions_allowance),
    transactionsUsed: Number(auth.transactions_used),
    // u64: a decoder may hand back number or bigint; the quota arithmetic can't mix.
    bytesAllowance: BigInt(auth.bytes_allowance),
    bytesUsed: BigInt(auth.bytes_used),
    bytesPermanentUsed: BigInt(auth.bytes_permanent_used),
  };
}

// The only byte budget on an authorization that gates anything: `renew` is
// rejected when `bytes_permanent + size > bytes_allowance`
// (pallet_bulletin_data_renewal::check_renew_authorization). `bytesUsed` — the
// store side — is NOT part of that comparison and never gates: the pallet
// documents `bytes`/`transactions` as "soft side (priority signal); saturate,
// never gate", and `can_store` is only `data_size_ok(len) && has active
// authorization`. So do not subtract store bytes here; they buy nothing back and
// would under-report real renew headroom.
//
// Clamped at 0 — a reporting input, never a negative budget.
export function remainingRenewBytes(auth: BulletinAuthorization): bigint {
  const left = auth.bytesAllowance - auth.bytesPermanentUsed;
  return left > 0n ? left : 0n;
}

// Transactions left in the granted allowance. Also not a gate — the runtime API
// documents the pair as predicting whether a `store` gets the *priority boost*.
export function remainingTransactions(auth: BulletinAuthorization): bigint {
  const left = auth.transactionsAllowance - auth.transactionsUsed;
  return left > 0 ? BigInt(left) : 0n;
}

// Bytes headroom on the STORE side (`bytes_used`) — the counter bulletin #1547 cares
// about for the AllowanceBasedPriority boost, as opposed to remainingRenewBytes' PERMANENT
// side (the only counter with a hard cap; see its comment above). Store bytes are
// documented as saturating, never gating: this is a priority signal only, same status
// as remainingTransactions. Clamped at 0 — a reporting input, never a negative budget.
export function remainingStoreBytes(auth: BulletinAuthorization): bigint {
  const left = auth.bytesAllowance - auth.bytesUsed;
  return left > 0n ? left : 0n;
}

// What a caller needs from an authorization to keep its full priority (bulletin #1547):
// one entry per chunk it is about to submit (`transactions`), and optionally the total
// bytes it expects to store (`bytes`, omitted when the caller doesn't know it yet — see
// DEFAULT_AUTHORIZATION_NEEDS).
export interface AuthorizationNeeds {
  transactions: number;
  bytes?: bigint;
}

// "Sensible documented default" (bulletin #1547) for callers that check quota before they
// know the real workload — the 3 provider-connect call sites in deploy.ts, and any external
// caller of ensureAuthorized that doesn't pass `needs`. Deliberately small (below every real
// grant size) so it only trips on an account that is ACTUALLY out of quota (0 remaining),
// not one that merely has less than a fresh grant. storeChunkedContent — the only place that
// knows the true chunk count — passes the real figures instead once chunking has happened.
export const DEFAULT_AUTHORIZATION_NEEDS: AuthorizationNeeds = { transactions: 1 };

// Which quota dimension(s) of `auth` fall short of `needs` (bulletin #1547). Callers must
// confirm `auth` exists and is unexpired first (isAuthorizationSufficient) — this only
// compares quota, not existence/expiry. Bytes are only checked when `needs.bytes` is provided.
export function quotaHeadroomDimensions(
  auth: BulletinAuthorization,
  needs: AuthorizationNeeds = DEFAULT_AUTHORIZATION_NEEDS,
): Array<"transactions" | "bytes"> {
  const dims: Array<"transactions" | "bytes"> = [];
  if (remainingTransactions(auth) < BigInt(needs.transactions)) dims.push("transactions");
  if (needs.bytes != null && remainingStoreBytes(auth) < needs.bytes) dims.push("bytes");
  return dims;
}

// True when `auth` exists and has not expired relative to `currentBlock` (also
// takes a PoolAuthorization — same `expiration` field). A fresh read is always
// active, so the expiry test is for cached/lagging ones; #1059's reauthorization
// window generalizes it over a future deadline. Deliberately expiry-only: an
// unexpired-but-quota-exhausted account is still "sufficient" here — the chain
// never gates `store` on quota, only priority — so quota is checked separately
// via quotaHeadroomDimensions (bulletin #1547), not folded into this predicate.
export function isAuthorizationSufficient(
  auth: { expiration: number } | null | undefined,
  currentBlock: number,
): boolean {
  return auth != null && auth.expiration > currentBlock;
}

// Returns the subset of `auths` that require a new authorization grant
// (missing or expired relative to `currentBlock`).
export function accountsNeedingAuthorization(auths: PoolAuthorization[], currentBlock: number): PoolAuthorization[] {
  return auths.filter(a => !isAuthorizationSufficient(a, currentBlock));
}

// Bulletin block time, empirically measured (see
// docs-internal/superpowers/plans/2026-07-06-issue-1051.md and
// 2026-05-07-incremental-upload-v2.md). Used to size the #1059 "reauthorize
// within 24h of expiry" pre-check window in blocks rather than wall-clock
// time, since expiration is stored as a block number on-chain.
export const BULLETIN_BLOCK_TIME_SECS = 6;
export const BULLETIN_BLOCKS_PER_DAY = Math.floor(86_400 / BULLETIN_BLOCK_TIME_SECS);

// Like accountsNeedingAuthorization, but proactive: flags accounts whose
// authorization will lapse within `bufferBlocks` of `currentBlock`, not just
// ones that have already lapsed. bufferBlocks=0 reduces to exactly
// accountsNeedingAuthorization's "already expired" check (a deadline of
// `currentBlock` is the same expression isAuthorizationSufficient already
// evaluates) — this is a strict generalization, not a parallel code path.
// #1059: the E2E pre-check uses this (with the default 24h buffer) so
// nightly runs renew pool authorizations before they expire mid-run instead
// of failing on one that's already expired.
export function accountsNeedingReauthorization(
  auths: PoolAuthorization[],
  currentBlock: number,
  bufferBlocks: number = BULLETIN_BLOCKS_PER_DAY,
): PoolAuthorization[] {
  const deadline = currentBlock + bufferBlocks;
  return auths.filter(a => !isAuthorizationSufficient(a, deadline));
}

// Minimal shape of an assets/environments.json entry needed to decide
// whether auto-reauthorization may write to this chain.
export interface AutoReauthorizeEnv {
  network?: string;
  bulletinAutoAuthorize?: boolean;
}

// #1059 maintainer constraint: auto-reauthorize is TESTNET-ONLY and must
// never run on mainnet. `bulletinAutoAuthorize` is an environments.json flag
// gating two things ONLY: the #1054 Asset Hub balance pre-fund
// (ensurePoolAccountsFundedOnAssetHub) and the #1059 hard write-gate in
// bootstrapPool's reauth pre-check (see allowAutoReauthorize below) — both of
// which are explicit, human-invoked bootstrap-tool paths, signed with
// whichever key bootstrapPool resolves as the authorizer (see its
// `authorizerMnemonic` / `envAuthorizer` precedence). polkadot-app-deploy does
// NOT self-authorize on the Bulletin chain during a deploy: ensureAuthorized()
// below never signs anything, it only throws (see its no-self-authorize error
// text) — unlike bulletin-deploy, which this flag's name is inherited from.
// The `network === "testnet"` check is a deliberate second gate on top of the
// flag (not redundant with it): it survives a future config mistake where
// `bulletinAutoAuthorize: true` gets set on a non-testnet entry, mirroring
// the "even if the flag were set by mistake, the dispatch is rejected"
// fail-safe documented on ensureAuthorized's opts.network path.
//
// bulletin #1362/#1095: deliberately an ALLOWLIST (`=== "testnet"`), not a
// denylist (`!== "mainnet"`) — a denylist lets anything that isn't the
// literal string "mainnet" through, including a missing field or a hand-edit
// typo like "Mainnet". An allowlist requires the env to explicitly say
// "testnet", which is the fail-safe direction for a gate that authorizes
// writes.
export function isAutoReauthorizeAllowed(env: AutoReauthorizeEnv | null | undefined): boolean {
  return env?.network === "testnet" && env?.bulletinAutoAuthorize === true;
}

export interface SelectionResult {
  account: PoolAuthorization;
  eligibleCount: number;
}

export function selectAccount(authorizations: PoolAuthorization[], random: () => number = Math.random, pinnedIndex?: number): SelectionResult {
  // Uniform random selection over all accounts. ensureAuthorized() runs immediately after
  // this returns and throws if the selected account's authorization is missing/expired
  // (polkadot-app-deploy never self-authorizes — see isAutoReauthorizeAllowed's comment
  // above). An unexpired account with exhausted transaction/byte quota is NOT a filtering
  // concern here either: it can still store, just loses the priority boost —
  // storeChunkedContent's own check (bulletin #1547) warns on that separately, once the
  // real chunk count is known. Quota is no longer purely self-healing filler either way.
  // Deterministic "best by transactions" was removed (#662) because it funneled
  // every deploy to one account, collapsing the effective pool to one.
  if (pinnedIndex != null) {
    // CI opt-in: pin to a specific pool account index to prevent nonce collisions
    // when multiple legs run concurrently (#863). Never fall back to random on a
    // configured-but-missing index — a misconfigured leg must surface, not flake.
    const pinned = authorizations.find(a => a.index === pinnedIndex);
    if (!pinned) {
      throw new Error(
        `pool account index ${pinnedIndex} not available among authorized accounts [${authorizations.map(a => a.index).join(", ")}]`,
      );
    }
    return { account: pinned, eligibleCount: authorizations.length };
  }
  return { account: authorizations[Math.floor(random() * authorizations.length)], eligibleCount: authorizations.length };
}

// ---------------------------------------------------------------------------
// #1637: stuck pending-tx queue detection.
//
// A pool account can have a valid head tx that never leaves one RPC backend's
// local pool (seen on paseo-next-v2: one of two load-balanced backends held 52
// txs from //deploy/8, head valid per TaggedTransactionQueue_validate_transaction
// but never gossiped). That backend reports system_accountNextIndex far ahead of
// the on-chain nonce, and any chunk nonce read through it is a future nonce that
// never becomes ready: every chunk times out after 180 s, three times over.
//
// Threshold: one deploy keeps at most BATCH_SIZE_INITIAL = 2 chunk txs in flight
// (plus a root/retry tx), so 8 tolerates about three concurrent deploys on the
// same account before calling it stuck. The #1637 gap was 53.
export const STUCK_NONCE_GAP_THRESHOLD = 8;
// nextIndex samples per health check, fired in parallel. Every sample opens a
// fresh connection, so behind a load balancer each one is a new backend pick.
// The #1637 probes hit the bad backend about 1 time in 3, so 8 samples miss it
// about 4% of the time. This is per endpoint: callers take NONCE_HEALTH_SAMPLES
// for each endpoint, round-robin, since each endpoint has its own balancer.
export const NONCE_HEALTH_SAMPLES = 8;
const NONCE_HEALTH_TIMEOUT_MS = 10_000;
// A gap above the threshold can also be a busy account: several concurrent
// deploys from one key (S9, a consumer's CI matrix) that collision recovery
// handles today. Stuck vs busy (#1658):
//   - Re-read the on-chain nonce every ~2 Bulletin blocks, up to
//     NONCE_HEALTH_CONFIRM_READS times (about a minute). Any advance = busy.
//     One 12 s re-read called a busy account stuck whenever no block included
//     its head in that window, the same slow-inclusion condition that makes
//     chunks time out.
//   - "Stuck" also needs the samples to show the
//     #1637 shape: some backend reports nextIndex within the threshold of the
//     chain while another is far ahead, i.e. the queue sits in one backend's
//     local pool and was never gossiped (//deploy/8: samples a mix of 13063
//     and 13114, on-chain 13063). This is a heuristic on the samples. A queue
//     every sample sees is gossiped, so block authors have it: that is a busy
//     account under slow inclusion (or a stuck node that is the only backend,
//     which the spread cannot tell apart). Its verdict is "unknown" at once,
//     with no re-reads; "unknown" never skips and never fails fast.
// Only paid when the gap is already large.
const NONCE_HEALTH_CONFIRM_DELAY_MS = 2 * BULLETIN_BLOCK_TIME_SECS * 1000;
const NONCE_HEALTH_CONFIRM_READS = 5;

export type NonceHealthVerdict = "healthy" | "stuck" | "unknown";

export interface NonceHealth {
  verdict: NonceHealthVerdict;
  onchain?: number;
  /** Max system_accountNextIndex over the successful samples. */
  nextIndex?: number;
  gap?: number;
  samples: number[];
  /** #1658: some sample is within the threshold of the chain while the max is beyond it (a queue local to one backend). */
  backendLocal?: boolean;
  /** Why the verdict is "unknown". */
  reason?: string;
}

export function nonceGapVerdict(onchain: number, nextIndex: number, threshold: number = STUCK_NONCE_GAP_THRESHOLD): "healthy" | "stuck" {
  // A negative gap is a backend lagging behind the chain, not a stuck queue.
  return nextIndex - onchain > threshold ? "stuck" : "healthy";
}

// Calls `fn` inside the race so a synchronous throw becomes a rejection too.
function withTimeout<T>(fn: () => Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export interface NonceHealthDeps {
  /** The account's nonce in System.Account at the BEST block (not finalized: nextIndex is best + pool). */
  readOnchainNonce: (address: string) => Promise<number>;
  /** One system_accountNextIndex read over a fresh connection. `sample` is 0..samples-1. */
  readNextIndex: (address: string, sample: number) => Promise<number>;
  samples?: number;
  timeoutMs?: number;
  threshold?: number;
  /** Wait before each stuck-vs-busy re-read of the on-chain nonce. */
  confirmDelayMs?: number;
  /** How many re-reads (each after confirmDelayMs) before a flat nonce counts. */
  confirmReads?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Never throws: any RPC failure yields verdict "unknown" so the caller can proceed as before. */
export async function checkPoolAccountNonceHealth(address: string, deps: NonceHealthDeps): Promise<NonceHealth> {
  const samples = deps.samples ?? NONCE_HEALTH_SAMPLES;
  const timeoutMs = deps.timeoutMs ?? NONCE_HEALTH_TIMEOUT_MS;
  const [onchainRes, ...sampleRes] = await Promise.allSettled([
    withTimeout(() => deps.readOnchainNonce(address), timeoutMs, "on-chain nonce read"),
    ...Array.from({ length: samples }, (_, i) =>
      withTimeout(() => deps.readNextIndex(address, i), timeoutMs, "system_accountNextIndex")),
  ]);
  const got = sampleRes.flatMap((r) => (r.status === "fulfilled" ? [Number(r.value)] : []));
  if (onchainRes.status === "rejected") {
    return { verdict: "unknown", samples: got, reason: `on-chain nonce: ${onchainRes.reason?.message ?? onchainRes.reason}` };
  }
  if (got.length === 0) {
    const first = sampleRes.find((r): r is PromiseRejectedResult => r.status === "rejected");
    return { verdict: "unknown", samples: got, reason: `nextIndex: every sample failed (${first?.reason?.message ?? first?.reason})` };
  }
  const onchain = Number(onchainRes.value);
  const nextIndex = Math.max(...got);
  const result: NonceHealth = { verdict: nonceGapVerdict(onchain, nextIndex, deps.threshold), onchain, nextIndex, gap: nextIndex - onchain, samples: got };
  if (result.verdict !== "stuck") return result;
  result.backendLocal = nonceGapVerdict(onchain, Math.min(...got), deps.threshold) === "healthy";
  // A queue every sample sees is gossiped: never stuck, whatever the nonce
  // does next, and callers act only on "stuck", so waiting buys nothing.
  if (!result.backendLocal) {
    return {
      ...result,
      verdict: "unknown",
      reason: `gap ${result.gap} on every nextIndex sample (a gossiped queue): a busy account, not a backend-local stuck queue`,
    };
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delayMs = deps.confirmDelayMs ?? NONCE_HEALTH_CONFIRM_DELAY_MS;
  const reads = deps.confirmReads ?? NONCE_HEALTH_CONFIRM_READS;
  for (let i = 0; i < reads; i++) {
    await sleep(delayMs);
    let later: number;
    try {
      later = Number(await withTimeout(() => deps.readOnchainNonce(address), timeoutMs, "on-chain nonce re-read"));
    } catch (e: any) {
      return { ...result, verdict: "unknown", reason: `on-chain nonce re-read: ${e?.message ?? e}` };
    }
    // Advanced: a busy account whose queue is draining, not a stuck one.
    if (later > onchain) return { ...result, verdict: "healthy", onchain: later, gap: nextIndex - later };
  }
  return result;
}

export interface StuckPoolAccount {
  index: number;
  address: string;
  health: NonceHealth;
}

export interface HealthySelectionResult extends SelectionResult {
  skippedStuck: StuckPoolAccount[];
}

/** Thrown when BULLETIN_POOL_ACCOUNT_INDEX pins an account whose queue is stuck. */
export class StuckPoolAccountError extends NonRetryableError {
  constructor(message: string, readonly skippedStuck: StuckPoolAccount[]) {
    super(message);
    this.name = "StuckPoolAccountError";
  }
}

export interface HealthySelectionOptions {
  pinnedIndex?: number;
  random?: () => number;
  checkHealth: (account: PoolAuthorization) => Promise<NonceHealth>;
  log?: { warn: (msg: string) => void };
}

function describeGap(h: NonceHealth): string {
  return `on-chain nonce ${h.onchain}, system_accountNextIndex ${h.nextIndex} (gap ${h.gap} > ${STUCK_NONCE_GAP_THRESHOLD}, on-chain nonce did not advance)`;
}

/** The fail-fast message for a signer whose queue is stuck; `remedy` is the caller-specific way out. */
export function stuckQueueMessage(who: string, address: string, h: NonceHealth, remedy: string): string {
  return (
    `${who} (${address}) has a stuck pending-tx queue: ${describeGap(h)}. ` +
    `Its txs would wait behind a head tx that is not being included, so every chunk would time out. ` +
    `${remedy} ` +
    `The queue clears once the RPC node drops or includes the stuck txs (node-side pool flush).`
  );
}

/**
 * selectAccount() plus a stuck-queue check on the chosen account (#1637).
 * Unpinned: a stuck draw is skipped and the next one is drawn uniformly from
 * the rest. Never sort by gap: that is the bias tools/verify_pool_distribution.py
 * guards against. Pinned: a stuck account fails fast.
 */
export async function selectHealthyPoolAccount(
  authorizations: PoolAuthorization[],
  { pinnedIndex, random = Math.random, checkHealth, log = console }: HealthySelectionOptions,
): Promise<HealthySelectionResult> {
  const eligibleCount = authorizations.length;
  const check = async (a: PoolAuthorization): Promise<NonceHealth> => {
    try {
      return await checkHealth(a);
    } catch (e: any) {
      return { verdict: "unknown", samples: [], reason: e?.message ?? String(e) };
    }
  };

  if (pinnedIndex != null) {
    const { account } = selectAccount(authorizations, random, pinnedIndex);
    const h = await check(account);
    if (h.verdict === "stuck") {
      throw new StuckPoolAccountError(
        stuckQueueMessage(`Pool account ${account.index}`, account.address, h,
          `BULLETIN_POOL_ACCOUNT_INDEX=${account.index} pins it: unset BULLETIN_POOL_ACCOUNT_INDEX or pick another index.`),
        [{ index: account.index, address: account.address, health: h }],
      );
    }
    return { account, eligibleCount, skippedStuck: [] };
  }

  const skippedStuck: StuckPoolAccount[] = [];
  let remaining = authorizations;
  let firstDraw: PoolAuthorization | undefined;
  while (remaining.length > 0) {
    const { account } = selectAccount(remaining, random);
    firstDraw ??= account;
    const h = await check(account);
    if (h.verdict !== "stuck") return { account, eligibleCount, skippedStuck };
    log.warn(`   ⚠ Skipping pool account ${account.index} (${account.address}): stuck pending-tx queue, ${describeGap(h)}`);
    skippedStuck.push({ index: account.index, address: account.address, health: h });
    remaining = remaining.filter((a) => a !== account);
  }
  log.warn(`   ⚠ Every pool account looks stuck; using pool account ${firstDraw!.index} anyway`);
  return { account: firstDraw!, eligibleCount, skippedStuck };
}

export async function fetchPoolAuthorizations(api: any, accounts: PoolAccount[]): Promise<PoolAuthorization[]> {
  const results = await Promise.all(
    accounts.map(async (account): Promise<PoolAuthorization> => {
      try {
        const auth = await readAccountAuthorization(api, account.address);
        return {
          ...account,
          transactions: auth ? remainingTransactions(auth) : 0n,
          renewBytes: auth ? remainingRenewBytes(auth) : 0n,
          expiration: auth ? auth.expiration : 0,
        };
      } catch {
        return { ...account, transactions: 0n, renewBytes: 0n, expiration: 0 };
      }
    })
  );
  return results;
}

// Returns true when the chain spec name identifies a Polkadot-ecosystem
// testnet. This is generic testnet detection, NOT an authorizer check — it
// only decides which of ensureAuthorized's two (non-signing) error messages
// to show, and (via detectTestnet/isAutoReauthorizeAllowed) gates the
// explicit bootstrap-tool write paths. It must not be read as "Alice is the
// authorizer here": testnets can be community-operated with an authorizer
// this codebase doesn't know (e.g. devnet — see environments.json
// `bulletinAuthorizer`, deliberately unset there).
// bulletin #1362/#1095: this is a FALLBACK only, for callers with no
// environments.json context (a raw library caller pointed at a custom RPC,
// some tools/* scripts). Any caller that resolved an env should pass its
// declared `network` field into detectTestnet() instead — spec_name
// substring matching is a lying mirror (Bulletin on Paseo has reported
// different spec_names across chain generations) and must never be the sole
// signal gating a money-movement decision when a better one exists.
export function isTestnetSpecName(specName: string | undefined | null): boolean {
  if (!specName) return false;
  const s = specName.toLowerCase();
  // Polkadot-ecosystem testnets, matched on the testnet qualifier rather than
  // chain name — Bulletin on Paseo reports spec_name "bulletin-westend" (as
  // of 2026-04-17), for example.
  if (s.includes("paseo")) return true;
  if (/\b(westend|rococo)\b/.test(s)) return true;
  if (/\b(testnet|devnet)\b/.test(s)) return true;
  if (/-test$|-testnet$|-dev$/.test(s)) return true;
  return false;
}

// bulletin #1362/#1095: precedence for the environments.json-resolved
// `network` field ("testnet" | "mainnet" | undefined) over a live chain
// spec_name read. Shared by detectTestnet() below and DotNS.isTestnet()
// (dotns.ts) — both need the exact same three-state decision before falling
// back to their own spec_name probe. Three states, deliberately NOT
// collapsed:
//   1. network === "testnet"        → true, authoritative.
//   2. network is a non-empty string that isn't "testnet" (e.g. "mainnet",
//      or a typo/garbage value like "Mainnet" from a hand-edited env file)
//      → false, fail CLOSED. A caller resolved SOME env context and it did
//      not explicitly say "testnet" — never let an unrecognized value fall
//      through to a spec_name guess, or a config typo reopens the exact
//      lying-mirror bug this issue exists to close.
//   3. network is null/undefined    → no env context was resolved at all
//      (no --env, options.bulletinEndpoints, a raw library/tools/* caller on
//      a custom RPC) → undefined, meaning: fall back to the spec_name read.
//      That read itself fails safe (false / not-testnet) on any error.
// Callers must check `!== undefined` before touching (or populating) their
// own spec_name cache — a resolved env value must never be overridden by a
// stale spec_name-derived verdict cached from an earlier, env-less call.
export function testnetFromNetworkField(network?: string | null): boolean | undefined {
  if (network === "testnet") return true;
  if (network != null && network !== "") return false;
  return undefined;
}

let _testnetDetectionCache: boolean | null = null;

export async function detectTestnet(api: any, network?: string | null): Promise<boolean> {
  const override = testnetFromNetworkField(network);
  if (override !== undefined) return override;
  if (_testnetDetectionCache !== null) return _testnetDetectionCache;
  try {
    const version = await api.constants.System.Version();
    const raw = version?.spec_name ?? version?.specName;
    const specName = typeof raw === "string" ? raw : raw?.asText?.() ?? String(raw ?? "");
    _testnetDetectionCache = isTestnetSpecName(specName);
  } catch {
    _testnetDetectionCache = false;
  }
  return _testnetDetectionCache;
}

// Test-only reset hook so the cache doesn't leak across test cases.
export function _resetTestnetCacheForTests(): void {
  _testnetDetectionCache = null;
}

const U32_MAX = 0xFFFFFFFFn;

function clampU32(n: bigint, name: string): number {
  if (n < 0n) throw new Error(`${name} must be non-negative`);
  if (n > U32_MAX) throw new Error(`${name} (${n}) exceeds u32 max — split the deploy into smaller batches`);
  return Number(n);
}

export interface EnsureAuthorizedResult {
  quotaExhausted: boolean;
  dimensions: Array<"transactions" | "bytes">;
}

export async function ensureAuthorized(
  api: any,
  address: string,
  label?: string,
  // bulletin #1547 (check/warn half only): `needs` is what THIS caller is about to ask
  // of the authorization — storeChunkedContent passes the real chunk count/bytes once
  // known; every other caller omits it and gets DEFAULT_AUTHORIZATION_NEEDS, which only
  // trips on an account that is genuinely down to 0 remaining quota. `precheckedAuth`
  // lets a caller that already read the account's authorization + current block moments
  // earlier (storeChunkedContent's own hard-gate read) hand them in instead of paying a
  // second, redundant RPC round trip.
  // bulletin #1362/#1095: `network` is the resolved env's environments.json
  // `network` field ("testnet" | "mainnet" | undefined). Threaded into
  // detectTestnet() below so the failure-message branch (testnet vs. mainnet
  // wording) is driven by the declared env, not a spec_name guess, whenever
  // a caller has one.
  opts: { needs?: AuthorizationNeeds; precheckedAuth?: { auth: BulletinAuthorization | null; currentBlock: number }; network?: string } = {},
): Promise<EnsureAuthorizedResult> {
  const [auth, currentBlock] = opts.precheckedAuth
    ? [opts.precheckedAuth.auth, opts.precheckedAuth.currentBlock]
    : await Promise.all([
        readAccountAuthorization(api, address),
        api.query.System.Number.getValue(),
      ]);

  if (!isAuthorizationSufficient(auth, currentBlock)) {
    const isTestnet = await detectTestnet(api, opts.network);
    const who = `${label ?? "account"} (${address.slice(0, 8)}...)`;
    if (isTestnet) {
      throw new Error(
        `Bulletin storage account ${who} is not authorized (or its authorization expired). ` +
        `polkadot-app-deploy no longer self-authorizes on the Bulletin chain — request authorization for this account from the chain's authorizer (testnet faucet / personhood / pool bootstrap), then retry.`,
      );
    }
    throw new Error(
      `Bulletin storage account ${who} is not authorized to store. ` +
      `On production the storage account must already carry its own authorization/allowance — polkadot-app-deploy cannot grant it.`,
    );
  }

  // bulletin #1547 (check/warn half only): existence+expiry alone doesn't mean full
  // priority — an unexpired account can still be out of transaction/byte quota, which
  // drops it behind accounts that have headroom (never a store failure, only a priority
  // loss — see quotaHeadroomDimensions' comment). Unlike bulletin-deploy, polkadot-app-deploy
  // never self-authorizes Bulletin storage (see isAutoReauthorizeAllowed's comment above),
  // so this never re-grants — it only reports the shortfall for the caller to warn on.
  const needs = opts.needs ?? DEFAULT_AUTHORIZATION_NEEDS;
  const dimensions = quotaHeadroomDimensions(auth as BulletinAuthorization, needs);
  return { quotaExhausted: dimensions.length > 0, dimensions };
}

// #1054: pre-fund each pool leg's //deploy/N account on the env's Asset Hub so
// it can pay its own DotNS fees as the domain owner. Runs SERIALLY from the
// Alice ROOT funder before the concurrent E2E matrix, so legs never race on
// the funder's Asset Hub nonce (funding inside the deploy would reintroduce
// the #1054 nonce collision on the transfer tx itself). Testnet-only, hard-
// gated by isAutoReauthorizeAllowed(envEntry) — same gate + rationale as the
// #1059 Bulletin auto-reauthorize path (one source of truth for "this is a
// chain we may spend Alice funds on").
const DEFAULT_ASSET_HUB_TOPUP_THRESHOLD = 1n * BigInt(PAS_DECIMALS_DIVISOR);
const DEFAULT_ASSET_HUB_TOPUP_TARGET = 2n * BigInt(PAS_DECIMALS_DIVISOR);

export interface EnsurePoolFundedOptions {
  envEntry: AutoReauthorizeEnv | null | undefined;
  thresholdRaw?: bigint;   // top up when free balance < this (default 1 PAS)
  targetRaw?: bigint;      // top up TO this (default 2 PAS)
  funderMnemonic?: string; // default: DEV_PHRASE (Alice ROOT, no derivation) — the account that already pays DotNS fees
  funderDerivationPath?: string; // default "" (root)
}

export async function ensurePoolAccountsFundedOnAssetHub(
  assetHubRpc: string,
  poolSize: number,
  poolMnemonic: string | undefined,
  opts: EnsurePoolFundedOptions,
): Promise<void> {
  if (!isAutoReauthorizeAllowed(opts.envEntry)) {
    console.log(
      `Asset Hub pre-fund skipped: ${opts.envEntry?.network ?? "this environment"} not cleared (testnet-only).`,
    );
    return;
  }

  const thresholdRaw = opts.thresholdRaw ?? DEFAULT_ASSET_HUB_TOPUP_THRESHOLD;
  const targetRaw = opts.targetRaw ?? DEFAULT_ASSET_HUB_TOPUP_TARGET;

  await cryptoWaitReady();
  // Same resolution as bootstrapPool above: fund the accounts a deploy will actually use.
  const accounts = derivePoolAccounts(poolSize, resolvePoolMnemonic(poolMnemonic));

  const entropy = mnemonicToEntropy(opts.funderMnemonic ?? DEV_PHRASE);
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const funderKeyPair = derive(opts.funderDerivationPath ?? "");
  const funderSigner = getPolkadotSigner(funderKeyPair.publicKey, "Sr25519", funderKeyPair.sign);

  console.log(`Pre-funding ${accounts.length} pool account(s) on Asset Hub (${assetHubRpc})...\n`);

  const client = createClient(getWsProvider(
    assetHubRpc,
    { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS },
  ));
  const api: any = client.getUnsafeApi();

  try {
    let fundedCount = 0;
    // Serial by design: awaiting each transfer in turn lets papi's nonce
    // follower advance correctly for the shared funder across the loop.
    // Promise.all here would race the funder's own Asset Hub nonce — exactly
    // the #1054 collision this pre-fund step exists to avoid.
    for (const acct of accounts) {
      const info: any = await api.query.System.Account.getValue(acct.address);
      const free = BigInt(info?.data?.free ?? 0n);
      const topUp = assetHubTopUpAmount(free, thresholdRaw, targetRaw);

      if (topUp === 0n) {
        console.log(`  [${acct.index}] ${acct.address}  OK (${formatPasBalance(free)} PAS)`);
        continue;
      }

      const tx = api.tx.Balances.transfer_allow_death({
        dest: Enum("Id", acct.address),
        value: topUp,
      });
      const result = await tx.signAndSubmit(funderSigner);
      if (!result?.ok) {
        throw new Error(`Asset Hub pre-fund transfer to ${acct.address} failed: dispatch was rejected.`);
      }
      fundedCount++;
      console.log(`  [${acct.index}] ${acct.address}  funded +${formatPasBalance(topUp)} PAS`);
    }
    console.log(`\nAsset Hub pre-fund complete: ${fundedCount}/${accounts.length} account(s) topped up.`);
  } finally {
    client.destroy();
  }
}

export interface BootstrapPoolOptions {
  authorizerMnemonic?: string;
  // The resolved env's `bulletinAuthorizer` (environments.json). Used only
  // when authorizerMnemonic is not given; takes precedence over guessing.
  // Needed because //Alice is NOT the authorizer on every testnet-shaped
  // chain — some (e.g. devnet) are community-operated and their authorizer
  // is unknown, so there is deliberately no blanket testnet fallback below.
  envAuthorizer?: string;
  // Human-readable id/name of the resolved env, used only to name it in the
  // "no known authorizer" message when neither authorizerMnemonic nor
  // envAuthorizer is available. Purely cosmetic — does not affect resolution.
  envLabel?: string;
  bulletinAuthorizeV2?: boolean;
  // #1059 pre-check mode: widen "needs authorization" from "already expired"
  // to "expires within this many blocks" (see accountsNeedingReauthorization).
  // Default 0 preserves bootstrapPool's original behavior exactly — existing
  // bin/bulletin-bootstrap invocations without this flag are unaffected.
  reauthBufferBlocks?: number;
  // #1059 hard safety gate: when reauthBufferBlocks > 0 and any account
  // needs reauthorization, bootstrapPool refuses to write unless this is
  // explicitly true. Callers must derive it from environments.json via
  // isAutoReauthorizeAllowed(envEntry) — never hardcode true. Defaults to
  // false so a caller that forgets to wire this up fails loud instead of
  // silently granting on an unintended chain.
  allowAutoReauthorize?: boolean;
}

function printAuthStatus(a: PoolAuthorization, currentBlock: number): void {
  if (isAuthorizationSufficient(a, currentBlock)) {
    const mb = (Number(a.renewBytes) / 1_000_000).toFixed(1);
    console.log(`  [${a.index}] ${a.address}  AUTHORIZED — ${a.transactions} txs left / ${mb}MB renew headroom, expires @${a.expiration}`);
  } else {
    console.log(`  [${a.index}] ${a.address}  NOT AUTHORIZED`);
  }
}

export async function bootstrapPool(
  bulletinRpc: string,
  poolSize: number = 10,
  mnemonic?: string,
  opts: BootstrapPoolOptions = {},
): Promise<void> {
  console.log(`Checking ${poolSize} pool accounts on ${bulletinRpc}...\n`);

  await cryptoWaitReady();
  // resolvePoolMnemonic, not the raw argument: the deploy path derives from
  // BULLETIN_POOL_MNEMONIC (else the dev phrase), and authorizing any other set of accounts
  // here would leave the env looking bootstrapped while deploys still hit unauthorized ones.
  const accounts = derivePoolAccounts(poolSize, resolvePoolMnemonic(mnemonic));
  // The first account, printed so an operator can compare it against the deploy's own
  // "Using pool account 0: <ss58>" line and spot a mnemonic mismatch at a glance.
  if (accounts.length > 0) console.log(`Pool root: //deploy/0 = ${accounts[0].address}\n`);

  const client = createClient(getWsProvider(
    bulletinRpc,
    { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS },
  ));
  const api: any = client.getUnsafeApi();

  try {
    // --- Step 1: fetch and print current authorization status ---
    const currentBlock: number = await api.query.System.Number.getValue();
    const auths = await fetchPoolAuthorizations(api, accounts);

    console.log("Pool authorization status:");
    for (const a of auths) {
      printAuthStatus(a, currentBlock);
    }
    console.log("");

    // --- Step 2: determine which accounts need authorization ---
    const reauthBufferBlocks = opts.reauthBufferBlocks ?? 0;
    const needsAuth = accountsNeedingReauthorization(auths, currentBlock, reauthBufferBlocks);
    if (needsAuth.length === 0) {
      console.log("All pool accounts are authorized. Nothing to do.");
      return;
    }
    console.log(`${needsAuth.length} account(s) need authorization.\n`);

    // #1059 hard gate: pre-check mode (reauthBufferBlocks > 0) must never
    // write on a chain that isn't explicitly cleared for auto-reauthorize.
    // Checked before an authorizer is resolved or any tx is built — fail
    // loud, naming every affected account, rather than silently skipping or
    // (worse) attempting a write the caller didn't intend.
    if (reauthBufferBlocks > 0 && !opts.allowAutoReauthorize) {
      const details = needsAuth
        .map(a => `  [${a.index}] ${a.address} — expires @${a.expiration} (current block ${currentBlock})`)
        .join("\n");
      throw new Error(
        `Auto-reauthorize is testnet-only (see isAutoReauthorizeAllowed / environments.json ` +
        `bulletinAutoAuthorize) and this call was not cleared to write. ${needsAuth.length} ` +
        `account(s) need reauthorization within the ${reauthBufferBlocks}-block buffer:\n${details}`,
      );
    }

    // --- Step 3: resolve authorizer ---
    let authorizerSigner: PolkadotSigner | undefined;
    const keyring = new Keyring({ type: "sr25519" });

    if (opts.authorizerMnemonic) {
      const authKey = keyring.addFromUri(opts.authorizerMnemonic);
      authorizerSigner = getPolkadotSigner(authKey.publicKey, "Sr25519", (data: Uint8Array) => authKey.sign(data));
      console.log(`Using provided authorizer: ${authKey.address}\n`);
    } else if (opts.envAuthorizer) {
      // The env declares which key holds authorizer rights on its Bulletin
      // chain (environments.json `bulletinAuthorizer`). Preferred over any
      // blanket guess so `polkadot-app-bootstrap --env <id>` works without a
      // flag, and so an env with no known authorizer (e.g. devnet) never
      // gets one guessed on its behalf.
      const authKey = keyring.addFromUri(opts.envAuthorizer);
      authorizerSigner = getPolkadotSigner(authKey.publicKey, "Sr25519", (data: Uint8Array) => authKey.sign(data));
      console.log(`Using environment authorizer ${opts.envAuthorizer} (${authKey.address})\n`);
    } else {
      // Deliberately NOT defaulting to //Alice here. That default used to
      // fire on ANY testnet-shaped chain (detectTestnet), including
      // community-operated ones (e.g. devnet) where //Alice does not
      // actually hold authorizer rights — the grant would be silently
      // rejected on-chain (BadSigner, or a Payment error if Alice is also
      // unfunded there) instead of failing with a clear, actionable message.
      const envNote = opts.envLabel ? ` for environment '${opts.envLabel}'` : "";
      console.log(
        `No known authorizer${envNote} — this environment does not declare a bulletinAuthorizer ` +
        "(likely community-operated, so the actual authorizer key is unknown here).\n" +
        "Re-run with --authorizer \"<seed>\" to grant authorization.",
      );
      return;
    }

    // --- Step 4: grant authorization for each account that needs it ---
    console.log(`Authorizing ${needsAuth.length} account(s) (${TOPUP_TRANSACTIONS} txs / ${Number(TOPUP_BYTES) / 1_000_000}MB each):\n`);
    for (const account of needsAuth) {
      console.log(`  [${account.index}] ${account.address}`);
      try {
        const tx = api.tx.TransactionStorage.authorize_account({
          who: account.address,
          transactions: clampU32(BigInt(TOPUP_TRANSACTIONS), "transactions"),
          bytes: TOPUP_BYTES,
        });
        const result = await tx.signAndSubmit(authorizerSigner);
        if (!result.ok) throw new Error("dispatch failed");
        console.log(`    granted: ${TOPUP_TRANSACTIONS} txs / ${Number(TOPUP_BYTES) / 1_000_000}MB`);
      } catch (e: any) {
        console.log(`    could not grant — is this key the chain's authorizer? (${e.message?.slice(0, 80)})`);
      }
    }
    console.log("");

    // --- Step 5: final summary ---
    console.log("=".repeat(60));
    console.log("Final pool authorization status:");
    console.log("=".repeat(60));
    const finalBlock: number = await api.query.System.Number.getValue();
    const finalAuths = await fetchPoolAuthorizations(api, accounts);
    for (const a of finalAuths) {
      printAuthStatus(a, finalBlock);
    }
  } finally {
    client.destroy();
  }
}
