import crypto from "crypto";
import { createReadStream } from "fs";
import { createClient, Enum } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { getWsProvider } from "polkadot-api/ws";
import { PGAS_ASSET_LOCATION } from "./personhood/constants.js";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Binary } from "polkadot-api";
import {
  encodeFunctionData,
  decodeFunctionResult,
  decodeErrorResult,
  keccak256,
  toBytes,
  formatEther,
  isAddress,
  bytesToHex,
  isHex,
  toHex,
  zeroAddress,
  namehash,
  concatHex,
} from "viem";
import { CID } from "multiformats/cid";
import { withSpan, captureWarning, setDeployAttribute, setDeploySentryTag, truncateAddress, markCodePath } from "./telemetry.js";
import { CODE_PATHS } from "./code-paths.js";
import { isTestnetSpecName } from "./pool.js";
import { validateContractAddresses } from "./environments.js";
import type { PopSelfServeConfig } from "./environments.js";
import { NonRetryableError } from "./errors.js";
import type { PolkadotSigner } from "polkadot-api";

/** One step in the phone-signature plan fired at preflight. */
export type PhoneSignatureStep = "Commitment" | "Register" | "Link content" | "Publish to registry";

// ---------------------------------------------------------------------------
// Exported constants and types
// ---------------------------------------------------------------------------

export interface DotNSConnectOptions { rpc?: string; keyUri?: string; mnemonic?: string; derivationPath?: string; signer?: PolkadotSigner; signerAddress?: string; /**
   * Optional override for the Asset Hub RPC failover list. When provided, the
   * primary RPC (this.rpc) is followed by these endpoints for retries. When
   * omitted, the legacy hardcoded RPC_ENDPOINTS list (paseo) is used —
   * preserves backwards-compatibility for external library consumers. The
   * bulletin-deploy CLI passes the list resolved from environments.json so
   * `--env <id>` drives both bulletin and asset-hub endpoints.
  */
  assetHubEndpoints?: string[];
  autoAccountMapping?: boolean;
  nativeToEthRatio?: bigint;
  contracts?: Record<string, string>;
  /** Optional environment ID (e.g. "paseo-next-v2"). Used in shell command examples in error messages. */
  environmentId?: string;
  /** Optional PoP self-serve config resolved from environments.json. Gates state-aware and generic testnet guidance blocks. */
  popSelfServe?: PopSelfServeConfig | null;
  /** Optional override for the storage deposit required for a fresh TLD register(). Loaded from environments.json per-env. */
  registerStorageDeposit?: bigint;
  /**
   * Called immediately before each on-chain transaction that requires an
   * interactive mobile wallet approval. Only wired in when the session signer
   * is active; pool/mnemonic paths leave this unset.
   */
  onPhoneSigningRequired?: (label: string) => void;
  /**
   * Human-ready gate. Awaited immediately BEFORE each phone signature request
   * is sent. Resolve when the human is at their phone and ready; reject/throw
   * to abort. The per-signature operation timeout starts only AFTER this
   * resolves. `attempt` >= 2 means a re-sign (principle 4).
   */
  confirmPhoneReady?: (ctx: { label: string; attempt: number; total: number }) => Promise<void>;
}
export interface OwnershipResult { owned: boolean; owner: string | null; }

export const TX_KIND_HASH = "hash" as const;
export const TX_KIND_NONCE_ADVANCED = "nonce-advanced" as const;
export const ATTR_TX_RESOLUTION_KIND = "deploy.dotns.tx_resolution_kind";

export type TxResolution =
  | { kind: typeof TX_KIND_HASH; hash: string; block?: { hash: string; number: number } }
  | { kind: typeof TX_KIND_NONCE_ADVANCED; rpc: string };
export interface PriceValidationResult { priceWei: bigint; requiredStatus: number; userStatus: number; message: string; }
export interface ParsedDomainName {
  isSubdomain: boolean;
  label: string;
  sublabel: string | null;
  parentLabel: string | null;
  fullName: string;
}

// Output of `DotNS.preflight(label)`. Carries every diagnostic needed to render a
// user-facing summary and the planned registration/content action. Advisory only:
// `registerDomain` keeps its own chain-level checks because preflight state can
// go stale during commit-reveal wait. See issue #100.
export interface DotnsPreflightResult {
  label: string;
  classification: { status: number; message: string };
  userStatus: number;
  trailingDigits: number;
  baselength: number;
  isAvailable: boolean;
  existingOwner: string | null;
  isBaseNameReserved: boolean;
  reservationOwner: string | null;
  isTestnet: boolean;
  canProceed: boolean;
  reason?: string;
  plannedAction: "register" | "already-owned-by-us" | "already-owned-by-recipient" | "abort";
  needsPopUpgrade: boolean;
  targetPopStatus?: number;
  /** Free PAS balance of the DotNS signer at preflight time, in plancks (10 decimals). */
  signerFreeBalance?: bigint;
  /** Threshold the signer must clear; depends on plannedAction. */
  feeFloor?: bigint;
  /** Set when an auto-top-up was attempted on testnet; describes the source and amount. */
  toppedUp?: { source: "Alice" | "Bob"; transferred: bigint };
}

// Asset Hub Paseo (and Polkadot Asset Hub) PAS uses 10 decimals. All thresholds
// are expressed in plancks so the values stay exact.
const ONE_PAS = 10_000_000_000n;
// Threshold for `setContenthash` on an already-owned label. ~0.001 PAS in
// observed runs; cap at 0.01 PAS to absorb fee variance and a one-off
// map_account if the signer hasn't been mapped yet.
const FEE_FLOOR_OWNED = ONE_PAS / 100n;
// Threshold for `register` (commit + reveal + optional map_account). Worst-case
// observed ~0.05 PAS; cap at 0.1 PAS so the signer can absorb at least one
// retry of a failed reveal before another precheck run.
const FEE_FLOOR_REGISTER = ONE_PAS / 10n;
// When auto-top-up triggers, transfer enough to cover ~10 future deploys before
// the next refill. Larger values drain Alice/Bob faster across nightly history;
// smaller ones cause more transfers. 0.5 PAS is the chosen middle.
const TOP_UP_TARGET = ONE_PAS / 2n;
// Don't drain the auto-top-up source. Skip if balance < TOP_UP_TARGET + this.
const SOURCE_BUFFER = ONE_PAS;
// Conservative fee estimate for reprove_alias_account. The actual fee on
// paseo-next-v2 is well under 0.001 PAS; 0.01 PAS gives comfortable headroom.
// Minimum storage deposit required for a fresh TLD register() on paseo-next-v2.
// pallet-revive dry-run returns flags=1 data=0x when free balance < this amount.
export const MINIMUM_REGISTER_STORAGE_DEPOSIT = 2_000_000_000_000n; // 200 PAS
// The register() msg.value is the tier-resolved deposit from PopRules, NOT a
// fixed RENT_PRICE: 0 for a verified (Lite/Full) signer, PopRules.startingPrice
// for a NoStatus signer. It is a refundable escrow deposit, not a burned fee.
// startingPrice is owner-updatable per env, so it is read live (see
// gateOnFeeBalance) — an on-chain updateStartingPrice is picked up with no
// release. The old hardcoded RENT_PRICE (dotns commit f8a0f963) no longer
// matches the deployed DotnsRegistrarController. See issue #884.
export function registerDepositWei(userStatus: number, startingPriceWei: bigint): bigint {
  return userStatus === ProofOfPersonhoodStatus.NoStatus ? startingPriceWei : 0n;
}
// Apply finalizeRegistration's +10% payment buffer, then convert wei→native.
export function bufferedWeiToNative(weiValue: bigint, nativeToEthRatio: bigint): bigint {
  return weiToNative((weiValue * 110n) / 100n, nativeToEthRatio);
}

// Convert an EVM wei fee to native (planck) units for contractTransaction's
// `value` arg. pallet-revive converts native msg.value back to wei by the same
// ratio, so an exact-multiple fee round-trips. Round UP on a remainder so a
// non-aligned fee can't make a payable call revert on a rounding cliff.
export function weiToNative(feeWei: bigint, nativeToEthRatio: bigint): bigint {
  if (feeWei === 0n) return 0n;
  const native = feeWei / nativeToEthRatio;
  return feeWei % nativeToEthRatio === 0n ? native : native + 1n;
}

const REPROVE_FEE_ESTIMATE = ONE_PAS / 100n; // 0.01 PAS
const REPROVE_FEE_SAFETY_MARGIN_PCT = 110n;  // 110% of estimate
// Cap one transfer + finalization wait so a stalled chain or silent socket
// can't hang preflight indefinitely. Asset Hub Paseo: best-block ~6s,
// finalization ~24s, retry margin → 60s budget per source. Falls through
// to the next candidate (Alice → Bob) on timeout.
const TOP_UP_TRANSFER_TIMEOUT_MS = 60_000;
const PASEO_FAUCET_URL = "https://faucet.polkadot.io";

export function fmtPas(plancks: bigint): string {
  return (Number(plancks) / Number(ONE_PAS)).toFixed(4);
}

function resolveNativeTokenSymbol(envId: string | null): string {
  if (!envId) return "PAS";
  if (envId.includes("paseo")) return "PAS";
  if (envId.includes("westend")) return "WND";
  if (envId.includes("rococo")) return "ROC";
  return "PAS";
}

export type DotnsSuccessAction = Exclude<DotnsPreflightResult["plannedAction"], "abort">;

/** Both owned actions skip the register storage deposit (#893): the name is already
 *  the user's, so only the (flat) owned floor + any transfer fee applies. */
function isOwnedAction(plannedAction: DotnsSuccessAction): boolean {
  return plannedAction === "already-owned-by-us" || plannedAction === "already-owned-by-recipient";
}

export function feeFloorFor(plannedAction: DotnsSuccessAction, storageDeposit = MINIMUM_REGISTER_STORAGE_DEPOSIT, rentPriceNative = 0n, transferFeeNative = 0n): bigint {
  if (isOwnedAction(plannedAction)) return FEE_FLOOR_OWNED + transferFeeNative;
  return FEE_FLOOR_REGISTER + storageDeposit + rentPriceNative + transferFeeNative;
}

function topUpTargetFor(plannedAction: DotnsSuccessAction, storageDeposit = MINIMUM_REGISTER_STORAGE_DEPOSIT, rentPriceNative = 0n, transferFeeNative = 0n): bigint {
  if (isOwnedAction(plannedAction)) return TOP_UP_TARGET + transferFeeNative;
  return TOP_UP_TARGET + storageDeposit + rentPriceNative + transferFeeNative;
}

export const RPC_ENDPOINTS: string[] = [
  "wss://asset-hub-paseo.dotters.network",
  "wss://sys.ibp.network/asset-hub-paseo",
  "wss://pas-rpc.stakeworld.io/assethub",
];

export const CONTRACTS = {
  DOTNS_REGISTRAR: "0x329aAA5b6bEa94E750b2dacBa74Bf41291E6c2BD",
  DOTNS_REGISTRAR_CONTROLLER: "0xd09e0F1c1E6CE8Cf40df929ef4FC778629573651",
  DOTNS_REGISTRY: "0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f",
  DOTNS_RESOLVER: "0x95645C7fD0fF38790647FE13F87Eb11c1DCc8514",
  DOTNS_CONTENT_RESOLVER: "0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7",
  DOTNS_REVERSE_RESOLVER: "0x95D57363B491CF743970c640fe419541386ac8BF",
  STORE_FACTORY: "0x030296782F4d3046B080BcB017f01837561D9702",
  POP_RULES: "0x4e8920B1E69d0cEA9b23CBFC87A17Ee6fE02d2d3",
} as const;

const PERSONHOOD_PRECOMPILE_ADDRESS = "0x000000000000000000000000000000000a010000";
const PERSONHOOD_CONTEXT = "0x646f746e73000000000000000000000000000000000000000000000000000000";

export const DECIMALS: bigint = 12n;
export const NATIVE_TO_ETH_RATIO: bigint = 1_000_000n;
export const CONNECTION_TIMEOUT_MS: number = 30_000;
export const OPERATION_TIMEOUT_MS: number = 300_000;
export const TX_TIMEOUT_MS: number = 90_000;
// DotNS extrinsic deadline measured against **chain time**: if the chain has
// advanced past this much wall-clock-equivalent without our tx landing, give
// up. Wall-clock alone (TX_TIMEOUT_MS) prematurely kills live txs on flaky
// testnets — cf. the #98 fix for waitForCommitmentAge.
export const TX_CHAIN_TIME_BUDGET_MS: number = 180_000;
// Hard ceiling for the chain-time polling loop — engages only when the chain
// itself is stalled (no blocks produced). Lowered to 240s so this fires before
// the outer OPERATION_TIMEOUT_MS=300s kill: 180s chain-time → 240s wall-clock → 300s outer.
export const TX_WALL_CLOCK_CEILING_MS: number = 240_000;
// Maximum allowed gap between signSubmitAndWatch observable events. If no event
// arrives for this long, the watch is considered silently stalled (papi observable
// + dead WS) and the promise rejects with a 'transaction watcher silent for Ns
// after <lastEvent>' error that signAndSubmitWithRetry can retry.
export const TX_NO_PROGRESS_MS: number = 90_000;
// WS heartbeat timeout for the DotNS (Asset Hub) provider. Matches the
// Bulletin-chain provider (src/deploy.ts). Without this, polkadot-api's
// default heartbeat window is much tighter and "WS halt" errors terminate
// subscriptions mid-registration when Asset Hub delivers slow block events.
export const WS_HEARTBEAT_TIMEOUT_MS: number = 300_000;
// Bounded retries for DotNS extrinsic submission. See classifyTxRetryDecision
// for what's considered retry-eligible.
// Kept at 3: each attempt watches the tx up to TX_WALL_CLOCK_CEILING_MS (240s) and
// the retry loop has no total ceiling, so more attempts spend real wall-clock —
// risking the job timeout and holding the mempool longer (evicting sibling jobs).
// The fix for the s-inc nonce_stale flake is the jittered backoff below (it spreads
// concurrent jobs off the same retry tick), NOT more attempts: the old loop retried
// back-to-back with zero delay, so the burst re-collided on the same nonce each time.
export const DOTNS_TX_MAX_ATTEMPTS: number = 3;

/**
 * Thrown by signAndSubmitExtrinsic when the transaction watcher goes silent
 * with NO prior event — i.e. the chain never received a "signed" / "broadcasted"
 * event before the silence deadline. On the phone/session-signer path this
 * typically means the user hasn't approved the request on their phone yet.
 * Typed separately from a plain Error so signAndSubmitWithRetry can apply a
 * different policy (pause-and-resume) instead of the default retry.
 */
export class WatcherSilentNoEventError extends Error {
  constructor(silentMs: number) {
    super(`transaction watcher silent for ${Math.floor(silentMs / 1000)}s — no response received (did you approve on your phone?)`);
    this.name = "WatcherSilentNoEventError";
  }
}

// Retry decision for DotNS extrinsic submission errors. Stale / Future /
// connection errors mean the tx didn't land due to mortality or network
// timing, so a rebuild-and-resubmit with fresh nonce has a real chance.
// Dispatch errors (contract revert, insufficient balance) fail identically
// on retry and abort.
export function classifyTxRetryDecision(err: unknown): "retry" | "abort" {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("nonce-advance fallback")) return "retry";
  if (/\bstale\b/.test(lower)) return "retry";
  if (/"type"\s*:\s*"future"|\binvalid::future\b/.test(lower)) return "retry";
  if (lower.includes("websocket") || lower.includes("connection") || lower.includes("socket closed") || lower.includes("disconnect")) return "retry";
  if (lower.includes("timed out") || lower.includes("timeout")) return "retry";
  if (lower.includes("transaction watcher silent")) return "retry";
  return "abort";
}

// Jittered exponential backoff for DotNS tx retries. Bursty nonce contention
// (parallel deploys briefly sharing the signer's nonce stream) clears within a
// few hundred ms; the jitter spreads concurrent jobs so they don't re-collide on
// the same retry tick. Bounded so a genuine outage still fails fast within the
// attempt budget.
const DOTNS_RETRY_BASE_MS = 400;
const DOTNS_RETRY_MAX_MS = 6_000;
export function dotnsRetryBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const ceil = Math.min(DOTNS_RETRY_BASE_MS * 2 ** (attempt - 1), DOTNS_RETRY_MAX_MS);
  // full-ish jitter: 50–100% of the exponential ceiling
  return Math.round(ceil * (0.5 + rand() * 0.5));
}

/**
 * Whether a failed attempt should be retried: only when the error is
 * retry-eligible AND there's a later attempt left in the budget. Extracted so
 * the loop logs EVERY failed attempt consistently (`attempt N/MAX failed`) and
 * the final/aborted attempt is announced rather than breaking silently — the
 * old loop only printed the line when a retry followed, so the last attempt was
 * invisible and the count appeared to stop one short.
 */
export function shouldRetryTxAttempt(
  attempt: number,
  maxAttempts: number,
  decision: "retry" | "abort",
): boolean {
  return decision === "retry" && attempt < maxAttempts;
}

/** Wraps `sink` so that "failed" status events are buffered and only forwarded
 *  when `flush()` is called (i.e. on final abort). All other statuses pass
 *  through immediately. Call `reset()` at the top of each retry attempt to
 *  discard a buffered "failed" from the previous attempt.
 *
 *  Closes two leak paths (issue #704):
 *  1. Retry-recovered: attempt N emits "failed" before throwing; a later attempt
 *     succeeds → reset() at the top of the next iteration discards the buffer,
 *     and flush() is never called on the success return → sink never sees it.
 *  2. Late watcher event: papi can emit a delayed drop/reorg after
 *     signAndSubmitExtrinsic has already resolved with "finalized"; the buffer
 *     is never flushed on the success path → silently dropped.
 */
export function makeRetryStatusFilter(sink: (status: string) => void): {
  callback: (status: string) => void;
  flush: () => void;
  reset: () => void;
} {
  let buffered = false;
  return {
    callback: (status: string) => {
      if (status === "failed") { buffered = true; return; }
      sink(status);
    },
    flush: () => { if (buffered) sink("failed"); },
    reset: () => { buffered = false; },
  };
}

export const DEFAULT_MNEMONIC: string = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

let _rpcIdCounter: number = 0;
async function fetchNonceFromEndpoint(rpc: string, ss58Address: string): Promise<number> {
  if (!globalThis.WebSocket) throw new Error("WebSocket support is required to fetch nonce");
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn: Function, ...args: any[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(...args);
    };
    const timer = setTimeout(() => settle(reject, new Error(`fetchNonce timed out after 8s for ${rpc}`)), 8_000);
    const ws = new WebSocket(rpc);
    const id = ++_rpcIdCounter;
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "system_accountNextIndex", params: [ss58Address] }));
    ws.onmessage = (e: any) => {
      const d = typeof e.data === "string" ? e.data : e.data.toString();
      const r = JSON.parse(d);
      if (r.id === id) { r.error ? settle(reject, new Error(r.error.message)) : settle(resolve, r.result); }
    };
    ws.onerror = () => settle(reject, new Error(`WebSocket to ${rpc} failed`));
    ws.onclose = () => settle(reject, new Error(`WebSocket to ${rpc} closed before response`));
  });
}

// Initial-lookup fetchNonce: first successful endpoint wins (Promise.any).
// Callers pass either a single RPC URL (legacy) or an array of endpoints for
// multi-endpoint primary lookup. A fast-but-stale primary is fine here — the
// current value is used to SEED the next tx submission, not to verify
// inclusion of a prior one. Cross-RPC VERIFY (see verifyNonceAdvanced below)
// is the place that needs allSettled semantics.
export async function fetchNonce(rpc: string | string[], ss58Address: string): Promise<number> {
  if (Array.isArray(rpc)) return Promise.any(rpc.map((ep) => fetchNonceFromEndpoint(ep, ss58Address)));
  return fetchNonceFromEndpoint(rpc, ss58Address);
}

// Verify a nonce advanced past originalNonce on ANY endpoint. Uses
// Promise.allSettled so a fast-but-stale primary can't mask confirmation
// already seen by a backup peer. Returns `{advanced: true, witnessRpc}` if at
// least one endpoint reports nonce > originalNonce; `{advanced: false}` if
// every successful response agrees the nonce is still pending. Rejected
// endpoints are ignored — if EVERY endpoint errors, this resolves `false`
// (which will then be treated as "pending" by the caller and trigger
// whatever timeout/retry path applies).
export async function verifyNonceAdvanced(
  endpoints: string[],
  ss58Address: string,
  originalNonce: number,
): Promise<{ advanced: true; witnessRpc: string } | { advanced: false }> {
  const results = await Promise.allSettled(
    endpoints.map((ep) => fetchNonceFromEndpoint(ep, ss58Address).then((n) => ({ n, ep }))),
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.n > originalNonce) {
      return { advanced: true, witnessRpc: r.value.ep };
    }
  }
  return { advanced: false };
}

export const ProofOfPersonhoodStatus = {
  NoStatus: 0,
  ProofOfPersonhoodLite: 1,
  ProofOfPersonhoodFull: 2,
  Reserved: 3,
} as const;

const DOTNS_REGISTRAR_CONTROLLER_ABI = [
  { inputs: [{ name: "registration", type: "tuple", components: [{ name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "secret", type: "bytes32" }, { name: "reserved", type: "bool" }] }], name: "makeCommitment", outputs: [{ name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "minCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "maxCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commitments", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "registration", type: "tuple", components: [{ name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "secret", type: "bytes32" }, { name: "reserved", type: "bool" }] }], name: "register", outputs: [], stateMutability: "payable", type: "function" },
] as const;

const DOTNS_REGISTRAR_ABI = [
  { inputs: [{ name: "tokenId", type: "uint256" }], name: "ownerOf", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
] as const;

const DOTNS_REGISTRAR_TRANSFER_ABI = [
  ...DOTNS_REGISTRAR_ABI,
  { inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], name: "transferFrom", outputs: [], stateMutability: "payable", type: "function" },
] as const;

const POP_RULES_ABI = [
  { inputs: [{ name: "name", type: "string" }], name: "classifyName", outputs: [{ name: "requirement", type: "uint8" }, { name: "message", type: "string" }], stateMutability: "pure", type: "function" },
  { inputs: [{ name: "name", type: "string" }], name: "price", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "name", type: "string" }, { name: "userAddress", type: "address" }], name: "priceWithCheck", outputs: [{ name: "metadata", type: "tuple", components: [{ name: "price", type: "uint256" }, { name: "status", type: "uint8" }, { name: "userStatus", type: "uint8" }, { name: "message", type: "string" }] }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "name", type: "string" }, { name: "userAddress", type: "address" }], name: "priceWithoutCheck", outputs: [{ name: "metadata", type: "tuple", components: [{ name: "price", type: "uint256" }, { name: "status", type: "uint8" }, { name: "userStatus", type: "uint8" }, { name: "message", type: "string" }] }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "name", type: "string" }], name: "isBaseNameReserved", outputs: [{ name: "isReserved", type: "bool" }, { name: "reservationOwner", type: "address" }, { name: "expiryTimestamp", type: "uint64" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "name", type: "string" }, { name: "from", type: "address" }, { name: "to", type: "address" }], name: "transferFloor", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "startingPrice", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const PERSONHOOD_ABI = [
  {
    type: "function",
    name: "personhoodStatus",
    inputs: [
      { name: "account", type: "address" },
      { name: "context", type: "bytes32" },
    ],
    outputs: [
      {
        name: "info",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "contextAlias", type: "bytes32" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

const DOTNS_REGISTRY_ABI = [
  { inputs: [{ name: "record", type: "tuple", components: [{ name: "parentNode", type: "bytes32" }, { name: "subLabel", type: "string" }, { name: "parentLabel", type: "string" }, { name: "owner", type: "address" }] }], name: "setSubnodeOwner", outputs: [{ name: "subnode", type: "bytes32" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "node", type: "bytes32" }, { name: "newResolver", type: "address" }], name: "setResolver", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "node", type: "bytes32" }], name: "owner", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "node", type: "bytes32" }], name: "resolver", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
] as const;

const DOTNS_CONTENT_RESOLVER_ABI = [
  { inputs: [{ name: "node", type: "bytes32" }, { name: "hash", type: "bytes" }], name: "setContenthash", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "node", type: "bytes32" }], name: "contenthash", outputs: [{ name: "", type: "bytes" }], stateMutability: "view", type: "function" },
] as const;

const DOTNS_TEXT_RESOLVER_ABI = [
  { inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }, { name: "value", type: "string" }], name: "setText", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }], name: "text", outputs: [{ name: "", type: "string" }], stateMutability: "view", type: "function" },
] as const;

export const PUBLISHER_ABI = [
  { inputs: [{ name: "label", type: "string" }], name: "publish", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "label", type: "string" }], name: "unpublish", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "labelhash", type: "bytes32" }], name: "isPublished", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "EmptyLabel", type: "error" },
  { inputs: [], name: "NoPersonhood", type: "error" },
  { inputs: [{ name: "nextAllowedAt", type: "uint64" }], name: "CooldownActive", type: "error" },
  { inputs: [{ name: "caller", type: "address" }, { name: "tokenId", type: "uint256" }], name: "NotOwner", type: "error" },
] as const;

// Thrown when --publish/--unpublish runs against an env that does not have a
// Publisher contract deployed. Caller decides whether to swallow (warn + skip)
// or surface as a fatal error.
export class PublisherNotSupportedError extends Error {
  constructor(envName: string) {
    super(`Publisher contract is not configured for environment '${envName}'. Use an env that has a deployed Publisher (currently: paseo-next-v2).`);
    this.name = "PublisherNotSupportedError";
  }
}

// Thrown by dryRunReviveCall when the contract would revert. Carries the raw
// revert data so callers can decode it against a specific ABI without parsing
// the human-readable message produced by formatContractDryRunFailure.
export class ContractDryRunRevertError extends Error {
  revertData: `0x${string}`;
  revertFlags: bigint;
  constructor(message: string, revertData: `0x${string}`, revertFlags: bigint) {
    super(message);
    this.name = "ContractDryRunRevertError";
    this.revertData = revertData;
    this.revertFlags = revertFlags;
  }
}

// Decodes a Publisher revert. Accepts either a structured ContractDryRunRevertError
// (the happy path — dry-run failed and threw with revertData attached) or a raw
// 0x-prefixed hex string for direct decoding (tests, manual inspection).
// Returns null when the input does not match a known Publisher selector.
export function decodePublisherRevert(source: { revertData?: `0x${string}` } | `0x${string}` | undefined | null): { name: string; args?: readonly unknown[] } | null {
  const data = typeof source === "string" ? source : source?.revertData;
  if (!data || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi: PUBLISHER_ABI, data });
    return { name: decoded.errorName, args: decoded.args };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Note: in Node 22+, Uint8Array.prototype.toHex() exists natively and returns
// hex *without* the `0x` prefix — incompatible with viem ABI decoders. Check
// Uint8Array first so the bytesToHex branch (which adds `0x`) handles it.
// Exported for unit-test regression coverage of the Node 22 footgun.
export function convertToHexString(value: unknown): string {
  if (!value) return "0x";
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (typeof value === "string" && isHex(value)) return value;
  // Defensive fallback: in PAPI 2.x runtime the call sites in this file
  // produce Uint8Array or HexString and never reach here. Kept for shapes
  // that future chain APIs or third-party callers might pass in.
  try { return toHex(value as any); } catch { return "0x"; }
}

function convertToBigInt(value: unknown, fallback: bigint = 0n): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string") return BigInt(value);
    if (value && typeof (value as any).toString === "function") return BigInt((value as any).toString());
    return fallback;
  } catch { return fallback; }
}

function normalizeWeight(weight: unknown): { referenceTime: bigint; proofSize: bigint } {
  const referenceTime = (weight as any)?.ref_time ?? (weight as any)?.refTime ?? 0;
  const proofSize = (weight as any)?.proof_size ?? (weight as any)?.proofSize ?? 0;
  return { referenceTime: convertToBigInt(referenceTime, 0n), proofSize: convertToBigInt(proofSize, 0n) };
}

function extractStorageDepositCharge(rawStorageDeposit: unknown): bigint {
  if (!rawStorageDeposit) return 0n;
  if (typeof (rawStorageDeposit as any)?.isCharge === "boolean") {
    if ((rawStorageDeposit as any).isCharge && (rawStorageDeposit as any).asCharge != null) return convertToBigInt((rawStorageDeposit as any).asCharge, 0n);
    return 0n;
  }
  if ((rawStorageDeposit as any).charge != null) return convertToBigInt((rawStorageDeposit as any).charge, 0n);
  if ((rawStorageDeposit as any).Charge != null) return convertToBigInt((rawStorageDeposit as any).Charge, 0n);
  if ((rawStorageDeposit as any).value != null) return convertToBigInt((rawStorageDeposit as any).value, 0n);
  return 0n;
}

function dotnsContractName(address: string, contracts: Record<string, string> = CONTRACTS): string {
  const normalized = address.toLowerCase();
  for (const [name, contractAddress] of Object.entries({ ...CONTRACTS, ...contracts })) {
    if (contractAddress.toLowerCase() === normalized) return name;
  }
  return "unknown";
}

function stringifyDebugValue(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested));
}

function dotnsTxDebugEnabled(): boolean {
  return process.env.PAD_DOTNS_DEBUG === "1" || process.env.DOTNS_DEBUG === "1";
}

function isContractRevertLike(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\brevert(?:ed|ing)?\b/i.test(message);
}

function formatWeight(weight: { referenceTime: bigint; proofSize: bigint } | undefined): string {
  if (!weight) return "unknown";
  return `ref_time=${weight.referenceTime.toString()} proof_size=${weight.proofSize.toString()}`;
}

const BARE_REVERT_DIAGNOSTIC_FUNCTIONS = new Set(["register", "commit", "setContenthash", "setSubnodeOwner", "setResolver"]);

// Fee election (#885): route Asset-Hub tx fees through ChargeAssetTxPayment → PGAS.
// Passed to signSubmitAndWatch when the signer is a PGAS-funded session account
// (e.g. the owner-signs update path), so a zero-native account can pay fees in PGAS.
// Proven against paseo-next-v2 in the #885 probe; PGAS covers fees only (not msg.value).
const PGAS_FEE_OPTIONS = {
  customSignedExtensions: { ChargeAssetTxPayment: { value: { tip: 0n, asset_id: PGAS_ASSET_LOCATION } } },
} as const;

function formatContractDryRunFailure(
  gasEstimate: {
    revertData?: string;
    revertFlags?: bigint;
    gasConsumed?: { referenceTime: bigint; proofSize: bigint };
    gasRequired?: { referenceTime: bigint; proofSize: bigint };
    storageDeposit?: bigint;
  },
  context: {
    contractAddress: string;
    functionName?: string;
    signerSubstrateAddress: string;
    signerEvmAddress?: string;
    value: bigint;
    encodedData: string;
    args?: unknown[];
    contracts?: Record<string, string>;
  },
): string {
  const functionName = context.functionName ?? "unknown";
  const contractName = dotnsContractName(context.contractAddress, context.contracts);
  const lines = [
    `Contract execution would revert during ${functionName} on ${contractName}`,
    `  contract: ${context.contractAddress}`,
    `  signer: ${context.signerSubstrateAddress}${context.signerEvmAddress ? ` (${context.signerEvmAddress})` : ""}`,
    `  value: ${context.value.toString()}`,
    `  revert: flags=${gasEstimate.revertFlags?.toString() ?? "unknown"} data=${gasEstimate.revertData ?? "0x"}`,
    `  gasRequired: ${formatWeight(gasEstimate.gasRequired)}`,
    `  gasConsumed: ${formatWeight(gasEstimate.gasConsumed)}`,
    `  storageDeposit: ${gasEstimate.storageDeposit?.toString() ?? "unknown"}`,
  ];
  if (dotnsTxDebugEnabled()) {
    lines.push(`  calldata: ${context.encodedData}`);
    if (context.args) lines.push(`  args: ${stringifyDebugValue(context.args)}`);
  }
  // Emit inline diagnostic when a bare revert (empty 0x data + flags=1) occurs on a known
  // DotNS write function. Surfaces the most likely causes without requiring the user to
  // run tools/dotns-dry-run.mjs manually.
  const revertData = gasEstimate.revertData;
  const isBareRevert = (revertData === undefined || revertData.trim() === "0x") && gasEstimate.revertFlags === 1n;
  if (isBareRevert && BARE_REVERT_DIAGNOSTIC_FUNCTIONS.has(functionName)) {
    if (functionName === "register") {
      lines.push(
        `  diagnostic: bare-revert (empty 0x) during register. Most likely cause: insufficient signer balance for storage deposit.`,
        `    A fresh TLD register() requires sufficient free balance to cover the chain's storage deposit (typically 200+ PAS).`,
        `    Other possible causes:`,
        `    1. PoP status changed between preflight and registration (race condition).`,
        `    2. Commitment timing: the revealed commitment is still too new or already expired.`,
        `    3. Label was registered by someone else between preflight and register.`,
        `  To reproduce in isolation: \`node tools/dotns-dry-run.mjs <label>\``,
        `  To rule out a mapping issue: add --fresh (a brand-new unmapped origin) — if --fresh reverts but the mapped one doesn't, it's a mapping bug.`,
      );
    } else {
      lines.push(
        `  diagnostic: bare-revert (empty 0x). Account mapping was verified at connect time, so the cause is likely:`,
        `    1. PoP status changed between preflight and registration (race condition).`,
        `    2. Commitment timing: the revealed commitment is still too new or already expired.`,
        `    3. Label was registered by someone else between preflight and register.`,
        `  To reproduce in isolation: \`node tools/dotns-dry-run.mjs <label>\``,
        `  To rule out a mapping issue: add --fresh (a brand-new unmapped origin) — if --fresh reverts but the mapped one doesn't, it's a mapping bug.`,
      );
    }
  }
  return lines.join("\n");
}

// Exported for unit tests only — mirrors the __setDeployRootSpanForTest pattern.
export function __formatContractDryRunFailureForTest(
  gasEstimate: Parameters<typeof formatContractDryRunFailure>[0],
  context: Parameters<typeof formatContractDryRunFailure>[1],
): string {
  return formatContractDryRunFailure(gasEstimate, context);
}

function unwrapExecutionResult(rawResult: unknown): { ok: any; err: any; successFlag: boolean | null } {
  if (!rawResult) return { ok: null, err: null, successFlag: null };
  if (typeof (rawResult as any).success === "boolean") {
    return (rawResult as any).success ? { ok: (rawResult as any).value ?? null, err: null, successFlag: true } : { ok: null, err: (rawResult as any).error ?? (rawResult as any).value ?? null, successFlag: false };
  }
  if (typeof (rawResult as any).isOk === "boolean") {
    return (rawResult as any).isOk ? { ok: (rawResult as any).value ?? null, err: null, successFlag: true } : { ok: null, err: (rawResult as any).value ?? null, successFlag: false };
  }
  if ((rawResult as any).ok != null) return { ok: (rawResult as any).ok, err: null, successFlag: true };
  if ((rawResult as any).err != null) return { ok: null, err: (rawResult as any).err, successFlag: false };
  return { ok: null, err: rawResult, successFlag: null };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

export const DOT_NODE: `0x${string}` = "0x3fce7d1364a893e213bc4212792b517ffc88f5b13b86c8ef9c8d390c3a1370ce";

export function convertWeiToNative(weiValue: bigint): bigint { return weiValue / NATIVE_TO_ETH_RATIO; }
export function computeDomainTokenId(label: string): bigint {
  const labelhash = keccak256(toBytes(label));
  const node = keccak256(concatHex([DOT_NODE, labelhash]));
  return BigInt(node);
}
export function countTrailingDigits(label: string): number { let count = 0; for (let i = label.length - 1; i >= 0; i--) { const code = label.charCodeAt(i); if (code >= 48 && code <= 57) count++; else break; } return count; }
export function stripTrailingDigits(label: string): string { return label.replace(/\d+$/, "").replace(/-$/, ""); }

export function sanitizeDomainLabel(label: string): string {
  const trailingDigitCount = countTrailingDigits(label);
  // PopRules accepts exactly 0 or 2 trailing digits; everything else reverts.
  if (trailingDigitCount === 0 || trailingDigitCount === 2) return label;

  // Strip ALL trailing digit/dash segments — not just the rightmost run — to
  // fixpoint. Single-pass stripping was insufficient for inputs whose base
  // contained embedded digits separated by a hyphen (e.g.
  // `e2esub26648857693-2994449`): the result still had >2 trailing digits and
  // a second sanitize call chopped further, breaking the idempotency
  // invariant `sanitize(sanitize(x)) === sanitize(x)`.
  let stripped = label;
  while (true) {
    const next = stripped.replace(/\d+$/, "").replace(/-+$/, "");
    if (next === stripped) break;
    stripped = next;
  }

  // For >2 original trailing digits, preserve uniqueness by appending the
  // original's last 2 chars when both are digits (yielding exactly 2 trailing
  // digits in the result). For the 1-trailing-digit case, last-2 chars is
  // usually `<letter><digit>` which still leaves 1 trailing digit — strip-only
  // is the right answer there.
  if (trailingDigitCount > 2) {
    const candidate = stripped + label.slice(-2);
    if (countTrailingDigits(candidate) === 2) {
      console.log(`   Domain label sanitized: "${label}" → "${candidate}" (stripped excess trailing digits)`);
      return candidate;
    }
  }

  console.log(`   Domain label sanitized: "${label}" → "${stripped}" (normalized trailing digits to 0)`);
  return stripped;
}

export function validateDomainLabel(label: string, opts: { checkReserved?: boolean; skipSanitize?: boolean } = {}): string {
  if (!/^[a-z0-9-]{3,63}$/.test(label)) throw new Error("Invalid domain label: must be 3-63 chars and contain only lowercase letters, digits, and hyphens");
  if (label.startsWith("-") || label.endsWith("-")) throw new Error("Invalid domain label: cannot start or end with hyphen");
  const sanitized = opts.skipSanitize ? label : sanitizeDomainLabel(label);
  // dotns-cli (paritytech/dotns-sdk packages/cli/src/utils/validation.ts)
  // computes the registry's "base name" by stripping trailing digits only.
  // When the label matches `<word>-<digits>$`, that base name ends in `-` and
  // the on-chain `isBaseNameReserved(baseName)` reverts with
  // `PopError("Name must be lowercase ASCII DNS label")` — after the consumer's
  // Bulletin upload is already done. Reject pre-upload instead.
  // This is a registered-name-only rule: subdomain sublabels have no such
  // constraint (setSubnodeOwner only requires isSingleLabel()). Skip when
  // opts.skipSanitize is set.
  if (!opts.skipSanitize && /-\d+$/.test(sanitized)) {
    const baseWithHyphen = sanitized.replace(/\d+$/, "");
    const dropHyphen = sanitized.replace(/-(\d+)$/, "$1");
    const insertSegment = sanitized.replace(/-(\d+)$/, "-pr$1");
    throw new Error(
      `Invalid domain label: "${sanitized}" — dotns base-name extraction leaves a trailing hyphen ("${baseWithHyphen}"), which the registry rejects with PopError("Name must be lowercase ASCII DNS label"). Drop the hyphen before the digits (e.g. "${dropHyphen}") or add a non-digit segment between (e.g. "${insertSegment}").`,
    );
  }
  // Fast client-side Reserved-class preflight (issue #573).
  // classifyDotnsLabel mirrors PopRules._classifyValidatedName — pure, no chain call.
  // Reserved labels (baselength ≤ 5) always revert on-chain; reject immediately.
  // Called on sanitized so excess-trailing-digit stripping has already run.
  // Opt-out via { checkReserved: false } for sublabel contexts (parseDomainName,
  // exampleNoStatusLabel) where the Reserved rule does not apply — subdomains are
  // user-defined strings, not DotNS-registered names.
  if (opts.checkReserved !== false) {
    const classification = classifyDotnsLabel(sanitized);
    if (classification.status === ProofOfPersonhoodStatus.Reserved) {
      // When sanitization changed the label, surface the trail so the user sees
      // both the original input and the form that was actually classified.
      const sanitizeTrail = label !== sanitized
        ? `Input "${label}" was sanitized to "${sanitized}" (excess trailing digits trimmed). `
        : "";
      throw new NonRetryableError(
        `${sanitizeTrail}Invalid domain label "${sanitized}": ${classification.message}`,
      );
    }
  }
  return sanitized;
}

// Pure helper exposed for tests. The DotNS RegistrarController checks
// `block.timestamp > commitments[c] + minCommitmentAge` — a **strict** greater-
// than, so an age exactly equal to the minimum still reverts. Poll chain time
// until this returns true.
export function isCommitmentMature(chainNowSeconds: number, commitTimestampSeconds: number, minimumAgeSeconds: number): boolean {
  return chainNowSeconds > commitTimestampSeconds + minimumAgeSeconds;
}

// Recognises a bare-revert (empty 0x) from the `register` or `finalize-registration`
// dry-run call. This pattern is the primary signal for a commitment timing race
// (commitment too new or already expired at the time the simulation ran) and
// warrants a one-shot fresh-commitment retry.
export function isCommitmentTimingBarerevert(msg: string): boolean {
  // The error comes from formatContractDryRunFailure which produces:
  //   "Contract execution would revert during register on DOTNS_REGISTRAR_CONTROLLER..."
  // combined with "bare-revert (empty 0x)"
  return /bare-revert.*\(empty 0x\)/i.test(msg) || /commitment.*too new.*expired/i.test(msg) || /expired.*commitment/i.test(msg);
}

// Pure helper exposed for tests. Mirrors `PopRules._classifyValidatedName` in
// dotns/contracts/pop/PopRules.sol — classification is deterministic from
// label length and trailing digits, no chain call required. Useful to
// preflight whether a signer is allowed to register a given label and
// explain the outcome without hitting the network.
//
//   trailing digits must be exactly 0 or 2 (1 or 3+ revert on-chain)
//   baselength <= 5       → Reserved
//   baselength 6-8  + 0d  → PopFull
//   baselength 6-8  + 2d  → PopLite
//   baselength >= 9       → NoStatus (open to all)
//
// The contract's priceWithCheck then enforces:
//   Reserved: always revert
//   PopFull required: userStatus must be PopFull
//   PopLite required: userStatus in { PopLite, PopFull }
//   NoStatus required: any user tier may register
export function classifyDotnsLabel(label: string): { status: number; message: string } {
  const totalLength = label.length;
  const trailingDigits = countTrailingDigits(label);
  // PopRules requires exactly 0 or 2 trailing digits; 1 or 3+ revert on-chain.
  if (trailingDigits === 1 || trailingDigits > 2) {
    return {
      status: ProofOfPersonhoodStatus.Reserved,
      message: `Name has ${trailingDigits} trailing digit${trailingDigits === 1 ? "" : "s"}; DotNS allows exactly 0 or 2 trailing digits. Use a base name with no trailing digits or a 2-digit suffix.`,
    };
  }
  const baselength = totalLength - trailingDigits;
  if (baselength <= 5) {
    return {
      status: ProofOfPersonhoodStatus.Reserved,
      message: `Base name is ${baselength} char${baselength === 1 ? "" : "s"}; DotNS reserves base names of 5 chars or fewer for governance (PopRules). Use a base name of 6+ chars — role prefixes like 'rc<N>pool' / 'rc<N>dir' / 'nightly-<role>' work well.`,
    };
  }
  if (baselength >= 6 && baselength <= 8) {
    if (trailingDigits === 2) return { status: ProofOfPersonhoodStatus.ProofOfPersonhoodLite, message: "Requires Light personhood verification" };
    return { status: ProofOfPersonhoodStatus.ProofOfPersonhoodFull, message: "Requires Full personhood verification" };
  }
  // baselength >= 9: open to any caller (0 or 2 trailing digits already enforced above).
  return { status: ProofOfPersonhoodStatus.NoStatus, message: "Available to all" };
}

// Pure helper — returns whether a user with `userStatus` is allowed to
// register a label with `requiredStatus` per `PopRules.priceWithCheck`.
// NoStatus names are open to any user tier (the NoStatus branch in priceWithCheck
// has no personhood check at all).
export function canRegister(requiredStatus: number, userStatus: number): boolean {
  if (requiredStatus === ProofOfPersonhoodStatus.Reserved) return false;
  if (requiredStatus === ProofOfPersonhoodStatus.ProofOfPersonhoodFull) {
    return userStatus === ProofOfPersonhoodStatus.ProofOfPersonhoodFull;
  }
  if (requiredStatus === ProofOfPersonhoodStatus.ProofOfPersonhoodLite) {
    return userStatus === ProofOfPersonhoodStatus.ProofOfPersonhoodLite
        || userStatus === ProofOfPersonhoodStatus.ProofOfPersonhoodFull;
  }
  // NoStatus: open to any tier per PopRules.priceWithCheck (NoStatus branch has no check).
  return true;
}

function exampleNoStatusLabel(label: string): string {
  // Called when we already know the label is Reserved — bypass checkReserved so
  // we can construct a suggestion from the bad input rather than throwing again.
  const base = stripTrailingDigits(validateDomainLabel(label, { checkReserved: false })).replace(/[^a-z0-9-]/g, "x");
  return `${base.padEnd(9, "x").slice(0, 9)}00.dot`;
}

export function parseDomainName(input: string): ParsedDomainName {
  const name = input.replace(/\.dot$/, "");
  const parts = name.split(".");
  if (parts.length === 1) {
    const sanitized = validateDomainLabel(parts[0]);
    return { isSubdomain: false, label: sanitized, sublabel: null, parentLabel: null, fullName: `${sanitized}.dot` };
  }
  if (parts.length === 2) {
    // Sublabel is a user-defined subdomain leaf, not a DotNS-registered name —
    // skip the Reserved check AND the digit sanitiser (setSubnodeOwner only
    // requires isSingleLabel(); no digit limit on subnode leaves). Parent IS
    // the registered name; apply full validation including sanitiser.
    const sanitizedSub = validateDomainLabel(parts[0], { checkReserved: false, skipSanitize: true });
    const sanitizedParent = validateDomainLabel(parts[1]);
    const fullLabel = `${sanitizedSub}.${sanitizedParent}`;
    return { isSubdomain: true, label: fullLabel, sublabel: sanitizedSub, parentLabel: sanitizedParent, fullName: `${fullLabel}.dot` };
  }
  throw new Error(`Invalid domain: only one level of subdomains supported (got ${parts.length} labels)`);
}

export function parseProofOfPersonhoodStatus(status: string): number {
  const s = (status ?? "none").toLowerCase();
  if (s === "none" || s === "nostatus") return ProofOfPersonhoodStatus.NoStatus;
  if (s === "lite" || s === "poplite") return ProofOfPersonhoodStatus.ProofOfPersonhoodLite;
  if (s === "full" || s === "popfull") return ProofOfPersonhoodStatus.ProofOfPersonhoodFull;
  throw new Error("Invalid status. Use none, lite, or full");
}

export function popStatusName(status: number): string {
  return Object.keys(ProofOfPersonhoodStatus).find((k) => (ProofOfPersonhoodStatus as any)[k] === status) ?? String(status);
}

function normalizeProofOfPersonhoodStatus(status: unknown): number {
  if (typeof status === "number") return status;
  if (typeof status === "bigint") return Number(status);
  if (typeof status === "string") return Number(status);
  throw new Error(`Unexpected ProofOfPersonhoodStatus type: ${typeof status}`);
}

function parsePersonhoodStatusResult(result: unknown): number {
  const status = Array.isArray(result)
    ? ((result[0] as { status?: unknown } | null)?.status ?? result[0])
    : (result as { status?: unknown } | null)?.status;
  return normalizeProofOfPersonhoodStatus(status);
}

class ReviveClientWrapper {
  static DRY_RUN_STORAGE_LIMIT: bigint = 18446744073709551615n;
  static DRY_RUN_WEIGHT_LIMIT: { ref_time: bigint; proof_size: bigint } = { ref_time: 18446744073709551615n, proof_size: 18446744073709551615n };

  client: any;
  mappedAccounts: Set<string>;

  constructor(client: any) { this.client = client; this.mappedAccounts = new Set(); }

  async getEvmAddress(substrateAddress: string): Promise<string> {
    if (isAddress(substrateAddress)) return substrateAddress;
    const address = await this.client.apis.ReviveApi.address(substrateAddress);
    const hex = convertToHexString(address);
    if (!hex || hex === "0x") {
      throw new Error(
        "ReviveApi.address returned empty result — RPC node may not support pallet-revive; try a different endpoint via DOTNS_RPC",
      );
    }
    return hex;
  }

  async performDryRunCall(originSubstrateAddress: string, contractAddress: string, value: bigint, encodedData: string): Promise<any> {
    if (isAddress(originSubstrateAddress)) throw new Error("performDryRunCall requires SS58 Substrate address, not EVM H160 address");
    const executionResults = await this.client.apis.ReviveApi.call(originSubstrateAddress, contractAddress, value, ReviveClientWrapper.DRY_RUN_WEIGHT_LIMIT, ReviveClientWrapper.DRY_RUN_STORAGE_LIMIT, Binary.fromHex(encodedData));
    const { ok, err, successFlag } = unwrapExecutionResult(executionResults.result);
    const flags = ok?.flags ? convertToBigInt(ok.flags, 0n) : 0n;
    const returnData = convertToHexString(ok?.data);
    const didRevert = ok ? (flags & 1n) === 1n : true;
    const gasConsumed = normalizeWeight(executionResults.weight_consumed);
    const gasRequired = normalizeWeight(executionResults.weight_required ?? executionResults.weight_consumed);
    const storageDepositValue = extractStorageDepositCharge(executionResults.storage_deposit);
    const isOk = !!ok && !didRevert;
    const isErr = !ok || didRevert || !!err || (typeof successFlag === "boolean" ? !successFlag : false);
    return { gasConsumed, gasRequired, storageDeposit: { value: storageDepositValue }, result: { isOk, isErr, value: { data: ok ? returnData : "0x", flags: ok ? flags : 1n } } };
  }

  async estimateGasForCall(originSubstrateAddress: string, contractAddress: string, value: bigint, encodedData: string): Promise<any> {
    const result = await this.performDryRunCall(originSubstrateAddress, contractAddress, value, encodedData);
    if (!result.result.isOk) return { success: false, gasConsumed: result.gasConsumed, storageDeposit: result.storageDeposit.value, gasRequired: result.gasRequired, revertData: result.result.value.data, revertFlags: result.result.value.flags };
    return { success: true, gasConsumed: result.gasConsumed, storageDeposit: result.storageDeposit.value, gasRequired: result.gasRequired };
  }

  // Returns true if the address holds contract code, false if it provably does
  // not, and null if this runtime doesn't expose the storage map (caller must
  // not treat null as "no code"). Used to disambiguate an empty-success (`0x`)
  // contract read: on pallet-revive, calling an address with no code succeeds
  // with empty return data, so empty `0x` from a read almost always means the
  // configured contract address is wrong/undeployed rather than a real "unset".
  async hasContractCode(address: string): Promise<boolean | null> {
    try {
      const info = await this.client.query.Revive.AccountInfoOf.getValue(address);
      if (info === undefined || info === null) return false;
      return info.account_type?.type === "Contract";
    } catch {
      return null;
    }
  }

  async checkIfAccountMapped(substrateAddress: string): Promise<boolean> {
    try {
      const evmAddress = await this.getEvmAddress(substrateAddress);
      const mappedAccount = await this.client.query.Revive.OriginalAccount.getValue(evmAddress);
      return mappedAccount !== null && mappedAccount !== undefined;
    } catch { return false; }
  }

  async ensureAccountMapped(substrateAddress: string, signer: PolkadotSigner): Promise<void> {
    if (isAddress(substrateAddress)) throw new Error("ensureAccountMapped requires SS58 Substrate address, not EVM H160 address");
    if (this.mappedAccounts.has(substrateAddress)) return;
    const isMapped = await this.checkIfAccountMapped(substrateAddress);
    if (isMapped) { this.mappedAccounts.add(substrateAddress); return; }
    try {
      await this.signAndSubmitWithRetry(() => this.client.tx.Revive.map_account(), signer, () => {}, "Revive.map_account");
      this.mappedAccounts.add(substrateAddress);
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      if (errorMessage.includes("AccountAlreadyMapped")) { this.mappedAccounts.add(substrateAddress); return; }
      throw error;
    }
  }

  signAndSubmitExtrinsic(
    extrinsic: any,
    signer: PolkadotSigner,
    statusCallback: (status: string) => void,
    opts: { nonceFallback?: { rpcs: string[]; senderSS58: string; expectedNonce: number }; verifyEffect?: () => Promise<boolean>; feeAsset?: "pgas" } = {},
  ): Promise<TxResolution> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadlinePoller: ReturnType<typeof setTimeout> | null = null;
      let sub: any;
      const finish = (fn: (...args: any[]) => void) => (...args: any[]): void => {
        if (!settled) {
          settled = true;
          if (deadlinePoller) clearTimeout(deadlinePoller);
          try { sub?.unsubscribe(); } catch {}
          fn(...args);
        }
      };

      const startWallClockMs = Date.now();
      let lastEventAt = Date.now();
      let lastEventType: string = "(none)";
      let startChainTimeMs: number | null = null;

      const poll = async (): Promise<void> => {
        if (settled) return;
        try {
          if (opts.nonceFallback) {
            const nonce = await verifyNonceAdvanced(opts.nonceFallback.rpcs, opts.nonceFallback.senderSS58, opts.nonceFallback.expectedNonce);
            if (nonce.advanced) {
              if (opts.verifyEffect) {
                statusCallback("verifying");
                const observed = await opts.verifyEffect();
                if (!observed) {
                  statusCallback("failed");
                  finish(reject)(new Error(`nonce-advance fallback: nonce moved past ${opts.nonceFallback.expectedNonce} but expected on-chain effect not observable (likely a different tx of ours consumed the nonce, or our tx was reorged out)`));
                  return;
                }
              }
              statusCallback("included");
              finish(resolve)({ kind: "nonce-advanced", rpc: nonce.witnessRpc });
              return;
            }
          }
          if (Date.now() - startWallClockMs > TX_WALL_CLOCK_CEILING_MS) {
            statusCallback("failed");
            finish(reject)(new Error(`Transaction did not settle within ${TX_WALL_CLOCK_CEILING_MS / 1000}s wall-clock (chain may be stalled)`));
            return;
          }
          const chainNowMs = Number(await this.client.query.Timestamp.Now.getValue());
          if (startChainTimeMs === null) startChainTimeMs = chainNowMs;
          const chainElapsedMs = chainNowMs - startChainTimeMs;
          if (chainElapsedMs > TX_CHAIN_TIME_BUDGET_MS) {
            statusCallback("failed");
            finish(reject)(new Error(`Transaction not included after ${Math.floor(chainElapsedMs / 1000)}s of chain progress (budget=${TX_CHAIN_TIME_BUDGET_MS / 1000}s)`));
            return;
          }
          const silentMs = Date.now() - lastEventAt;
          if (silentMs > TX_NO_PROGRESS_MS) {
            statusCallback("failed");
            // No-event case (never reached "signed"/"broadcasted"): throw a typed
            // error so signAndSubmitWithRetry can detect it and apply phone-signer
            // pause-and-resume instead of the default WS-stall retry.
            if (lastEventType === "(none)") {
              finish(reject)(new WatcherSilentNoEventError(silentMs));
            } else {
              finish(reject)(new Error(`transaction watcher silent for ${Math.floor(silentMs / 1000)}s after ${lastEventType}`));
            }
            return;
          }
        } catch { /* transient RPC hiccup — retry next tick */ }
        if (!settled) deadlinePoller = setTimeout(poll, 6_000);
      };
      deadlinePoller = setTimeout(poll, 6_000);

      try {
        sub = extrinsic.signSubmitAndWatch(signer, { mortality: { mortal: true, period: 256 }, ...(opts.feeAsset === "pgas" ? PGAS_FEE_OPTIONS : {}) }).subscribe({
          next: (event: any) => {
            lastEventAt = Date.now();
            lastEventType = event.type;
            const transactionHash = event.txHash?.toString();
            switch (event.type) {
              case "signed": statusCallback("signing"); break;
              case "broadcasted": statusCallback("broadcasting"); break;
              case "txBestBlocksState":
                if (event.found) statusCallback("included");
                break;
              case "finalized": {
                if (event.dispatchError || event.ok === false) { statusCallback("failed"); finish(reject)(new Error(`Transaction failed: ${formatDispatchError(event.dispatchError)}`)); return; }
                const block = event.block
                  ? { hash: String(event.block.hash), number: Number(event.block.number) }
                  : undefined;
                statusCallback("finalized"); finish(resolve)({ kind: "hash", hash: transactionHash, block }); return;
              }
              case "invalid": case "dropped": statusCallback("failed"); finish(reject)(new Error(`Transaction ${event.type}`)); return;
            }
          },
          error: (error: any) => { statusCallback("failed"); finish(reject)(error); },
          complete: () => {
            if (settled) return;
            statusCallback("failed");
            finish(reject)(new Error("transaction subscription closed before finalization"));
          },
        });
      } catch (error: any) { statusCallback("failed"); finish(reject)(error); }
    });
  }

  async signAndSubmitWithRetry(buildExtrinsic: () => any, signer: PolkadotSigner, statusCallback: (status: string) => void, label: string, opts: { nonceFallback?: { rpcs: string[]; senderSS58: string; expectedNonce: number }; verifyEffect?: () => Promise<boolean>; feeAsset?: "pgas"; isPhoneSigner?: boolean } = {}): Promise<TxResolution> {
    const filter = makeRetryStatusFilter(statusCallback);
    let lastError: unknown;
    for (let attempt = 1; attempt <= DOTNS_TX_MAX_ATTEMPTS; attempt++) {
      filter.reset(); // discard any buffered "failed" from the previous attempt
      try {
        // Rebuilt + re-signed each attempt → papi reads a fresh on-chain nonce
        // (retries never reuse the stale one).
        return await this.signAndSubmitExtrinsic(buildExtrinsic(), signer, filter.callback, opts);
      } catch (e: any) {
        lastError = e;

        // Phone-signer / no-event case: the watcher went silent before any
        // blockchain event arrived — the user never approved on their phone.
        // Fail fast; the confirmPhoneReady gate in contractTransaction is the
        // right place to handle re-sign prompts.
        if (e instanceof WatcherSilentNoEventError && opts.isPhoneSigner === true) {
          filter.flush();
          throw new NonRetryableError(
            "No signature received from the phone — re-run when you can approve on your phone.",
          );
        }

        const decision = classifyTxRetryDecision(e);
        const msg = e?.message ?? String(e);
        if (!shouldRetryTxAttempt(attempt, DOTNS_TX_MAX_ATTEMPTS, decision)) {
          // Final attempt or non-retryable error: announce it (don't break
          // silently) so the count always reaches N/MAX and the reason is clear.
          const reason = decision === "abort" ? "not retryable" : "out of attempts";
          console.log(`   ${label}: attempt ${attempt}/${DOTNS_TX_MAX_ATTEMPTS} failed (${msg}) — giving up (${reason})`);
          break;
        }
        const ms = dotnsRetryBackoffMs(attempt);
        console.log(`   ${label}: attempt ${attempt}/${DOTNS_TX_MAX_ATTEMPTS} failed (${msg}), retrying in ${ms}ms…`);
        // Jittered backoff is the fix: retrying back-to-back just re-collides on the
        // contended nonce; spacing concurrent jobs lets the startup burst drain.
        await new Promise((r) => setTimeout(r, ms));
      }
    }
    filter.flush(); // surface "failed" when the overall operation truly failed
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // Dry-runs one Revive.call and returns the chain-side limits the live
  // submission should use. Throws a formatted error when the call would
  // revert. Shared between single-tx submitTransaction and the batched
  // submitBatchedTransactions so they cannot drift.
  private async dryRunReviveCall(
    contractAddress: string,
    value: bigint,
    encodedData: string,
    signerSubstrateAddress: string,
    context: { functionName?: string; args?: unknown[]; contracts?: Record<string, string> },
  ): Promise<{ weight_limit: { ref_time: bigint; proof_size: bigint }; storage_deposit_limit: bigint }> {
    const gasEstimate = await this.estimateGasForCall(signerSubstrateAddress, contractAddress, value, encodedData);
    if (!gasEstimate.success) {
      const signerEvmAddress = await this.getEvmAddress(signerSubstrateAddress);
      const msg = formatContractDryRunFailure(gasEstimate, {
        contractAddress,
        functionName: context.functionName,
        signerSubstrateAddress,
        signerEvmAddress,
        value,
        encodedData,
        args: context.args,
        contracts: context.contracts,
      });
      throw new ContractDryRunRevertError(msg, (gasEstimate.revertData ?? "0x") as `0x${string}`, gasEstimate.revertFlags ?? 0n);
    }
    const minimumStorageDeposit = 2_000_000_000_000n;
    let storageDepositLimit = gasEstimate.storageDeposit === 0n ? minimumStorageDeposit : (gasEstimate.storageDeposit * 120n) / 100n;
    if (storageDepositLimit < minimumStorageDeposit) storageDepositLimit = minimumStorageDeposit;
    return {
      weight_limit: { ref_time: gasEstimate.gasRequired.referenceTime, proof_size: gasEstimate.gasRequired.proofSize },
      storage_deposit_limit: storageDepositLimit,
    };
  }

  async submitTransaction(
    contractAddress: string,
    value: bigint,
    encodedData: string,
    signerSubstrateAddress: string,
    signer: PolkadotSigner,
    statusCallback: (status: string) => void,
    { rpcs, useNoncePolling, functionName, args, contracts, verifyEffect, feeAsset, isPhoneSigner }: { rpcs: string[]; useNoncePolling?: boolean; functionName?: string; args?: unknown[]; contracts?: Record<string, string>; verifyEffect?: () => Promise<boolean>; feeAsset?: "pgas"; isPhoneSigner?: boolean },
  ): Promise<TxResolution> {
    await this.ensureAccountMapped(signerSubstrateAddress, signer);
    // For register specifically, re-check mapping immediately before the dry-run.
    // ensureAccountMapped() may have confirmed mapping using stale state; if the
    // on-chain mapping did not persist (race between map_account finalization and
    // the subsequent dry-run) the register call will bare-revert with empty 0x.
    if (functionName === "register") {
      try {
        const stillMapped = await this.checkIfAccountMapped(signerSubstrateAddress);
        if (!stillMapped) {
          captureWarning("account mapping not confirmed on-chain immediately before register dry-run", {
            signer: signerSubstrateAddress,
          });
        }
      } catch {
        // mapping check is best-effort; don't block the dry-run
      }
    }
    const prep = await withSpan(
      "chain.dry_run",
      `dry-run ${functionName ?? "Revive.call"}`,
      { "chain.function_name": functionName ?? "Revive.call" },
      () => this.dryRunReviveCall(contractAddress, value, encodedData, signerSubstrateAddress, { functionName, args, contracts }),
    );
    const buildExtrinsic = () => this.client.tx.Revive.call({ dest: contractAddress, value, weight_limit: prep.weight_limit, storage_deposit_limit: prep.storage_deposit_limit, data: Binary.fromHex(encodedData) });
    let nonceFallback: { rpcs: string[]; senderSS58: string; expectedNonce: number } | undefined;
    if (useNoncePolling) {
      try {
        const nonce = await fetchNonce(rpcs, signerSubstrateAddress);
        nonceFallback = { rpcs, senderSS58: signerSubstrateAddress, expectedNonce: nonce };
      } catch {}
    }
    return await withSpan(
      "chain.tx.submit",
      `sign+submit ${functionName ?? "Revive.call"}`,
      { "chain.function_name": functionName ?? "Revive.call", "chain.use_nonce_polling": Boolean(useNoncePolling) },
      () => this.signAndSubmitWithRetry(buildExtrinsic, signer, statusCallback, "Revive.call", { nonceFallback, verifyEffect, feeAsset, isPhoneSigner }),
    );
  }

  // Dry-runs each call individually, then wraps them in a single
  // Utility.batch_all extrinsic. batch_all is atomic over inner calls — only
  // batch operations whose rollback-together is acceptable (e.g. cosmetic
  // setText writes).
  async submitBatchedTransactions(
    calls: { contractAddress: string; value: bigint; encodedData: string; functionName?: string; args?: unknown[] }[],
    signerSubstrateAddress: string,
    signer: PolkadotSigner,
    statusCallback: (status: string) => void,
  ): Promise<TxResolution> {
    if (calls.length === 0) throw new Error("submitBatchedTransactions: at least one call required");
    await this.ensureAccountMapped(signerSubstrateAddress, signer);
    const preps = await withSpan(
      "chain.dry_run",
      "dry-run Utility.batch_all",
      { "chain.function_name": "Utility.batch_all" },
      () => Promise.all(calls.map((c) =>
        this.dryRunReviveCall(c.contractAddress, c.value, c.encodedData, signerSubstrateAddress, { functionName: c.functionName, args: c.args }))),
    );
    const buildExtrinsic = () => {
      const inners = calls.map((c, i) => this.client.tx.Revive.call({
        dest: c.contractAddress,
        value: c.value,
        weight_limit: preps[i].weight_limit,
        storage_deposit_limit: preps[i].storage_deposit_limit,
        data: Binary.fromHex(c.encodedData),
      }).decodedCall);
      return this.client.tx.Utility.batch_all({ calls: inners });
    };
    return await withSpan(
      "chain.tx.submit",
      "sign+submit Utility.batch_all",
      { "chain.function_name": "Utility.batch_all" },
      () => this.signAndSubmitWithRetry(buildExtrinsic, signer, statusCallback, "Utility.batch_all"),
    );
  }
}

// ---------------------------------------------------------------------------
// TxResolution log + telemetry helper
// ---------------------------------------------------------------------------

/**
 * Formats a papi 2.x dispatchError object into a readable string.
 * papi typed enums default .toString() returns "[object Object]"; this
 * serialises the structure with BigInt-safe JSON so error messages are
 * useful for debugging (e.g. {type:"Module",value:{type:"Revive",...}}).
 */
export function formatDispatchError(err: unknown): string {
  if (err === undefined || err === null) return "dispatch error";
  if (typeof err === "string") return err;
  try {
    const out = JSON.stringify(err, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    return typeof out === "string" ? out : "dispatch error";
  } catch {
    return String(err);
  }
}

function logTxResolution(res: TxResolution): void {
  setDeployAttribute(ATTR_TX_RESOLUTION_KIND, res.kind);
  if (res.kind === TX_KIND_HASH) {
    console.log(`   Tx: ${res.hash}`);
  } else {
    let rpcHost = res.rpc;
    try { rpcHost = new URL(res.rpc).host; } catch { /* fallback to raw */ }
    console.log(`   Tx: confirmed via nonce-advance on ${rpcHost}`);
  }
}

// ---------------------------------------------------------------------------
// Personhood remediation helpers (Stage 0)
// ---------------------------------------------------------------------------

export type AliasAccountState =
  | "not-bound"          // No AccountToAlias row — user has never bound
  | "bound-likely-stale" // Row exists, paid=true, dotns context — stale revision likely
  | "wrong-context"      // Row exists but different context or paid=false
  | "bound-fresh";       // Row exists, paid=true, dotns context, and genuinely fresh

export interface AliasAccountClassification {
  state: AliasAccountState;
  storedContextHex?: string;
  paid?: boolean;
  revision?: number;
}

const DOTNS_CONTEXT_HEX_LOWER =
  "0x646f746e73000000000000000000000000000000000000000000000000000000";

/**
 * Pure classifier — interprets an `AliasAccounts.AccountToAlias` storage row
 * (or `undefined` for "no row") and returns the alias-state classification.
 *
 * Split out from `classifyAliasAccountState` so the row → state mapping can
 * be unit-tested without a chain connection.
 *
 * AliasAccounts pallet rewrite (paritytech/individuality#955, May 2026)
 * collapsed the paid/free path split — every binding now pays `AliasFee`
 * and the `paid` field no longer exists on the row. Classification keys
 * on context alone: rows under the `dotns` context are heuristically
 * flagged stale for reprove; rows under any other context are wrong-context;
 * absent rows are not-bound. See docs-internal/dotns-bootstrap-handover.md
 * §3 for the pallet contract.
 */
export function classifyAliasAccountRow(row: unknown): AliasAccountClassification {
  if (!row) return { state: "not-bound" };
  const r = row as { ca?: { context?: unknown }; revision?: unknown };
  const contextHex: string = typeof r.ca?.context === "string"
    ? (r.ca.context as string).toLowerCase()
    : "";
  const revision: number = Number(r.revision ?? 0);
  if (contextHex === DOTNS_CONTEXT_HEX_LOWER) {
    return { state: "bound-likely-stale", storedContextHex: contextHex, revision };
  }
  return { state: "wrong-context", storedContextHex: contextHex, revision };
}

/**
 * Render the numbered self-serve steps for a popSelfServe config.
 * When faucetUrl is present the first step funds the service account; when absent
 * that step is omitted and the remaining steps renumber from 1.
 */
function formatSelfServeSteps(popSelfServe: PopSelfServeConfig): string {
  const steps: string[] = [];
  if (popSelfServe.faucetUrl) {
    steps.push(`Fund the service account mnemonic via ${popSelfServe.faucetUrl}`);
  }
  steps.push(`Go to ${popSelfServe.personhoodFaucetUrl}, pick your env (e.g. ${popSelfServe.sudoEnvLabel}), and paste the mnemonic`);
  steps.push(`Go to ${popSelfServe.dotnsBootstrapUrl} and follow each step (first and last can probably be skipped)`);
  return steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
}

/**
 * Format a user-facing remediation message for the "no personhood" preflight failure.
 * Pure function — unit-testable without a chain connection.
 *
 * When popSelfServe.stateAwareGuidance is true, returns actionable advice based on alias state.
 * Otherwise falls back to the generic "contact DotNS team" message.
 *
 * The environmentId parameter is forwarded for use in shell command examples (e.g.
 * `--env paseo-next-v2`) so users can copy-paste the correct env id. It does NOT gate
 * the state-aware branch — that is controlled by popSelfServe.stateAwareGuidance.
 */
export function formatPersonhoodRemediation(
  state: AliasAccountClassification,
  popSelfServe: PopSelfServeConfig | null,
  environmentId: string | null,
): string {
  if (!popSelfServe?.stateAwareGuidance) {
    return "Self-attestation is no longer available. Contact the DotNS team for whitelisting / Personhood status help.";
  }
  switch (state.state) {
    case "not-bound":
      return (
        `Your account has no DotNS alias binding on ${environmentId ?? "this environment"}. ` +
        "On testnets you can self-serve:\n" +
        formatSelfServeSteps(popSelfServe)
      );
    case "bound-likely-stale":
      return (
        "Your alias binding exists but may have a stale ring revision. " +
        `Run \`node tools/reprove-alias.mjs --mnemonic <your-mnemonic> --env ${environmentId ?? "this environment"}\` to refresh the proof, ` +
        "then retry the registration."
      );
    case "wrong-context":
      return (
        "Your alias binding exists but is for a different application context" +
        (state.storedContextHex ? ` (context: ${state.storedContextHex})` : "") +
        ". Re-bind under the 'dotns' context using the bootstrap flow: " +
        popSelfServe.dotnsBootstrapUrl
      );
    case "bound-fresh":
      // Genuine chain-team problem — fall through to generic message.
      return "Self-attestation is no longer available. Contact the DotNS team for whitelisting / Personhood status help.";
  }
}

/**
 * Build a complete user-facing PoP shortfall reason string.
 * Pure function — unit-testable without a chain connection.
 *
 * Composes:
 *   1. Lead-in from the caller (`${label}.dot requires X, but signer is Y.`)
 *   2. State-tailored guidance (when isTestnet && popSelfServe.stateAwareGuidance === true)
 *      — delegates to formatPersonhoodRemediation for state-specific text.
 *      — When aliasState is null on a stateAwareGuidance env, treated as "not-bound".
 *   3. When isTestnet && popSelfServe != null but stateAwareGuidance is false/absent:
 *      the generic 3-step self-serve bootstrap block using the env's config URLs/label.
 *   4. When isTestnet && popSelfServe == null: no testnet block (env opted out).
 *   5. Always: the "Alternatives" block (NoStatus-compatible label + whitelist link).
 */
export function formatPopShortfallReason(opts: {
  label: string;
  requiredName: string;
  currentName: string;
  isTestnet: boolean;
  environmentId: string | null;
  popSelfServe: PopSelfServeConfig | null;
  aliasState: AliasAccountClassification | null;
  exampleNoStatusLabel: string;
}): string {
  const { label, requiredName, currentName, isTestnet, environmentId, popSelfServe, aliasState, exampleNoStatusLabel: noStatusEx } = opts;
  const leadIn = `${label}.dot requires ${requiredName}, but this signer is ${currentName}.`;

  let testnetBlock = "";
  if (isTestnet && popSelfServe != null) {
    if (popSelfServe.stateAwareGuidance) {
      // State-aware guidance — delegate to the inner helper.
      const state: AliasAccountClassification = aliasState ?? { state: "not-bound" };
      testnetBlock = "\n\n" + formatPersonhoodRemediation(state, popSelfServe, environmentId);
    } else {
      // Generic multi-step bootstrap using the env's config URLs and label.
      testnetBlock = "\n\nOn testnets you can self-serve:\n" + formatSelfServeSteps(popSelfServe);
    }
  }

  const alternativesBlock =
    "\n\nAlternatively:\n" +
    `  - Use a NoStatus-compatible label (base length >= 9 with exactly two trailing digits, e.g. ${noStatusEx})\n` +
    "  - Raise a whitelist issue at https://github.com/paritytech/dotns/";

  return leadIn + testnetBlock + alternativesBlock;
}

// ---------------------------------------------------------------------------
// DotNS class
// ---------------------------------------------------------------------------

export class DotNS {
  client: any | null;
  clientWrapper: ReviveClientWrapper | null;
  rpc: string | null;
  substrateAddress: string | null;
  evmAddress: string | null;
  signer: PolkadotSigner | null;
  connected: boolean;
  // Per-instance failover list. Populated from options.assetHubEndpoints when
  // bulletin-deploy resolves the asset-hub list via environments.json; falls
  // back to the legacy paseo-only RPC_ENDPOINTS for direct library callers.
  assetHubEndpoints: string[];

  private _usesExternalSigner = false;
  private _localMnemonic: string | null = null;
  private _contracts: typeof CONTRACTS & { PUBLISHER?: string } = CONTRACTS;
  private _nativeToEthRatio: bigint = NATIVE_TO_ETH_RATIO;
  private _environmentId: string | null = null;
  private _popSelfServe: PopSelfServeConfig | null = null;
  private _registerStorageDeposit: bigint = MINIMUM_REGISTER_STORAGE_DEPOSIT;
  private _onPhoneSigningRequired: ((label: string) => void) | undefined = undefined;
  private _confirmPhoneReady: ((ctx: { label: string; attempt: number; total: number }) => Promise<void>) | undefined = undefined;
  /** Total phone-signature count for this DotNS session (drives the `total` field passed to confirmPhoneReady). */
  private _phoneSignatureTotal = 0;
  /** Running attempt counter per label for re-sign detection. Reset at connect/disconnect. */
  private _phoneSignatureAttempts: Map<string, number> = new Map();
  // Test-only seam: consumed once by classifyAliasAccountState() then cleared.
  // Mirrors the __setDeployRootSpanForTest / __setSentryForTest pattern.
  private _classifyOverrideForTest: AliasAccountClassification | null = null;

  /** Test-only: inject a fixed classifyAliasAccountState return value for the next call. Consumed once. */
  __setClassifyOverrideForTest(state: AliasAccountState): void {
    this._classifyOverrideForTest = { state, revision: 0 };
  }

  // Test-only seam: consumed once by getUserPopStatus() then cleared.
  private _userPopStatusOverrideForTest: number | null = null;

  /** Test-only: inject a fixed getUserPopStatus return value for the next call. Consumed once. */
  __setUserPopStatusForTest(status: number): void {
    this._userPopStatusOverrideForTest = status;
  }

  // Test-only seam: fallback result for reprove() when the real call throws "not strictly
  // greater than stored" (account already at latest revision). Any other error propagates.
  private _reproveFallbackForTest: { oldRevision: number; newRevision: number; blockHash: string } | null = null;

  /** Test-only: register a fallback reprove result used only if the real reprove() throws "not strictly greater than stored". Consumed once. */
  __setReproveFallbackForTest(result: { oldRevision: number; newRevision: number; blockHash: string }): void {
    this._reproveFallbackForTest = result;
  }

  constructor() { this.client = null; this.clientWrapper = null; this.rpc = null; this.substrateAddress = null; this.evmAddress = null; this.signer = null; this.connected = false; this.assetHubEndpoints = RPC_ENDPOINTS; }

  async connect(options: DotNSConnectOptions = {}): Promise<this> {
    if (options.assetHubEndpoints && options.assetHubEndpoints.length > 0) {
      this.assetHubEndpoints = options.assetHubEndpoints;
    }
    if (options.contracts && Object.keys(options.contracts).length > 0) {
      // Validate early — before any chain calls — so a stale environments.json
      // surfaces a clear error rather than a confusing RPC revert.
      validateContractAddresses(options.contracts, options.environmentId ?? "unknown");
      this._contracts = { ...CONTRACTS, ...options.contracts } as typeof CONTRACTS & { PUBLISHER?: string };
    }
    if (options.environmentId) {
      this._environmentId = options.environmentId;
    }
    if (options.popSelfServe !== undefined) {
      this._popSelfServe = options.popSelfServe ?? null;
    }
    if (options.registerStorageDeposit !== undefined) {
      this._registerStorageDeposit = options.registerStorageDeposit;
    }
    if (options.onPhoneSigningRequired !== undefined) {
      this._onPhoneSigningRequired = options.onPhoneSigningRequired;
    }
    if (options.confirmPhoneReady !== undefined) {
      this._confirmPhoneReady = options.confirmPhoneReady;
    }
    const rpc = options.rpc || process.env.DOTNS_RPC || this.assetHubEndpoints[0];
    this.rpc = rpc;
    this._usesExternalSigner = Boolean(options.signer && options.signerAddress);

    if (this._usesExternalSigner) {
      this.signer = options.signer!;
      this.substrateAddress = options.signerAddress!;
    } else {
      const mnemonicArg = options.mnemonic || process.env.DOTNS_MNEMONIC || process.env.MNEMONIC;
      const keyUriArg = options.keyUri || process.env.DOTNS_KEY_URI;
      let source = keyUriArg || mnemonicArg || DEFAULT_MNEMONIC;
      const isKeyUri = Boolean(keyUriArg);

      // Store for auto-reprove: reprove() needs the raw BIP39 mnemonic to derive
      // ring-VRF keys. Only store when we have a pure mnemonic (not a key URI or
      // derivation path) so the stored value unambiguously maps to the root key.
      if (!isKeyUri && !options.derivationPath) {
        this._localMnemonic = mnemonicArg || DEFAULT_MNEMONIC;
      }

      if (options.derivationPath && !isKeyUri && source) {
        // Append derivation path to mnemonic as a Substrate-style URI.
        source = `${source}${options.derivationPath}`;
      }

      // Derive substrate SS58 from keyring — no chain calls, deterministic.
      await cryptoWaitReady();
      const keyring = new Keyring({ type: "sr25519" });
      const account = isKeyUri || options.derivationPath
        ? keyring.addFromUri(source)
        : keyring.addFromMnemonic(source);
      this.signer = getPolkadotSigner(account.publicKey, "Sr25519", async (input: Uint8Array) => account.sign(input));
      this.substrateAddress = account.address;
    }
    console.log(`   SS58 Address: ${this.substrateAddress}`);
    setDeployAttribute("deploy.dotns.signer", truncateAddress(this.substrateAddress) as string);
    setDeploySentryTag("deploy.dotns.signer", truncateAddress(this.substrateAddress) as string);

    // Resolve EVM via ReviveApi.address — a deterministic substrate→H160
    // runtime call that does NOT require the origin to be mapped. Set up the
    // polkadot-api client first since the wrapper holds the chain handle.
    return withSpan("deploy.dotns.connect", "dotns connect", {}, async () => {
      try {
        this.client = createClient(getWsProvider(rpc, { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS }));
        const unsafeApi = this.client.getUnsafeApi();
        this.clientWrapper = new ReviveClientWrapper(unsafeApi);
        this.evmAddress = await withTimeout(
          this.clientWrapper.getEvmAddress(this.substrateAddress!),
          CONNECTION_TIMEOUT_MS,
          "ReviveApi.address",
        );
        console.log(`   H160 Address: ${this.evmAddress}`);
      } catch (e: any) {
        const inner = e.message?.slice(0, 200) ?? String(e).slice(0, 200);
        const rpcHint = inner.includes("timed out") ? `; RPC: ${rpc} — retry or set DOTNS_RPC to another endpoint` : "";
        throw new Error(
          `DotNS connect: failed to resolve EVM address from ${this.substrateAddress} via ReviveApi.address (${inner})${rpcHint}`,
        );
      }
      setDeployAttribute("deploy.dotns.rpc_used", rpc);
      setDeployAttribute("deploy.dotns.evm_address", this.evmAddress!);
      this.connected = true;

      // Ensure the account is mapped before any dry-run that requires a mapped
      // origin. Auto-map chains may reject explicit map_account; fall back to
      // the Revive.call trigger when that path is unavailable.
      await this.resolveNativeToEthRatio(options);
      try {
        await this.ensureMappedAccountReady(options.autoAccountMapping ?? false);
      } catch (e) {
        this.connected = false;
        throw e;
      }

      return this;
    });
  }

  async ensureMappedAccountReady(autoAccountMapping: boolean = false): Promise<void> {
    this.ensureConnected();
    if (!this.clientWrapper || !this.substrateAddress || !this.signer) {
      throw new Error("Account mapping unavailable before DotNS signer is initialized");
    }

    if (autoAccountMapping) {
      markCodePath(CODE_PATHS.DOTNS_AUTO_MAPPING);
      setDeployAttribute("deploy.dotns.mapping_source", "auto-account-mapping");
      await this.ensureAutoMappedAccountReady();
      return;
    }

    markCodePath(CODE_PATHS.DOTNS_MANUAL_MAPPING);
    if (await this.clientWrapper.checkIfAccountMapped(this.substrateAddress)) {
      setDeployAttribute("deploy.dotns.mapping_source", "already-mapped");
      console.log(`   Account: mapped`);
      return;
    }

    console.log(`   Mapping account on Asset Hub Revive...`);
    try {
      await this.clientWrapper.ensureAccountMapped(this.substrateAddress, this.signer);
    } catch (e: any) {
      if (await this.clientWrapper.checkIfAccountMapped(this.substrateAddress)) {
        setDeployAttribute("deploy.dotns.mapping_source", "direct-mapped");
        console.log(`   Account: mapped`);
        return;
      }
      captureWarning("explicit account mapping failed; falling back to Revive auto-map trigger", {
        signer: this.substrateAddress,
        error: e?.message?.slice?.(0, 200) ?? String(e).slice(0, 200),
      });
      setDeployAttribute("deploy.dotns.mapping_source", "auto-map-fallback");
      await this.ensureAutoMappedAccountReady();
      return;
    }

    setDeployAttribute("deploy.dotns.mapping_source", "direct-mapped");
    console.log(`   Account: mapped`);
  }

  async ensureAutoMappedAccountReady(): Promise<void> {
    this.ensureConnected();
    if (!this.clientWrapper || !this.substrateAddress || !this.signer) {
      throw new Error("Account auto-mapping unavailable before DotNS signer is initialized");
    }

    if (await this.clientWrapper.checkIfAccountMapped(this.substrateAddress)) {
      console.log(`   Account: auto-mapped (Revive.OriginalAccount confirmed)`);
      return;
    }

    if (await this.isTestnet()) {
      const free = await this.readFreeBalance(this.substrateAddress);
      if (free < FEE_FLOOR_REGISTER) {
        console.log(`   DotNS signer ${this.substrateAddress.slice(0, 8)}... balance ${fmtPas(free)} PAS before auto-map — attempting testnet auto top-up...`);
        const toppedUp = await this.attemptTestnetTopUp(this.substrateAddress, TOP_UP_TARGET);
        if (toppedUp) {
          console.log(`   Topped up ${fmtPas(toppedUp.transferred)} PAS from ${toppedUp.source} for auto-map`);
          setDeployAttribute("deploy.dotns.signer_below_floor", "true");
          setDeployAttribute("deploy.dotns.toppedup", "true");
          setDeployAttribute("deploy.dotns.toppedup_source", toppedUp.source);
        }
      }
    }

    if (!(await this.clientWrapper.checkIfAccountMapped(this.substrateAddress))) {
      try {
        // On paseo-next-v2 there is no map_account extrinsic; the Revive.call
        // submission itself creates the OriginalAccount mapping that subsequent
        // dry-runs need.
        const cd = encodeFunctionData({ abi: DOTNS_REGISTRAR_CONTROLLER_ABI, functionName: "minCommitmentAge", args: [] });
        await this.clientWrapper.signAndSubmitWithRetry(
          () => this.clientWrapper!.client.tx.Revive.call({
            dest: this._contracts.DOTNS_REGISTRAR_CONTROLLER,
            value: 0n,
            weight_limit: { ref_time: 10_000_000_000n, proof_size: 131072n },
            storage_deposit_limit: 5_000_000_000_000n,
            data: Binary.fromHex(cd),
          }),
          this.signer,
          () => {},
          "auto-map trigger",
        );
      } catch (e: any) {
        captureWarning("DotNS auto-map trigger failed", {
          signer: this.substrateAddress,
          error: e?.message?.slice?.(0, 200) ?? String(e).slice(0, 200),
        });
      }
    }

    if (!(await this.clientWrapper.checkIfAccountMapped(this.substrateAddress))) {
      throw new Error(`Account auto-mapping did not take effect on-chain for ${this.substrateAddress}. The signer needs enough testnet PAS to submit the Revive auto-map trigger before DotNS preflight can run. Top up at ${PASEO_FAUCET_URL} or fund Alice/Bob so auto-top-up can help.`);
    }

    console.log(`   Account: auto-mapped (Revive.OriginalAccount confirmed)`);
  }

  ensureConnected(): void { if (!this.connected) throw new Error("Not connected. Call connect() first."); }

  /**
   * Resolve the authoritative nativeToEthRatio for this session.
   *
   * Priority: chain constant (Revive.NativeToEthRatio) > options.nativeToEthRatio > default.
   * On mismatch between the env-configured value and the chain value, logs a WARNING naming
   * both values and proceeds with the chain value (it is the source of truth).
   * On query failure, falls back to the configured/default value without throwing.
   *
   * Must be called after clientWrapper is established (i.e. inside connect()).
   */
  async resolveNativeToEthRatio(options: DotNSConnectOptions): Promise<void> {
    // Apply env/default baseline first so it always wins over the class default on its own.
    const configuredRatio: bigint = options.nativeToEthRatio ?? NATIVE_TO_ETH_RATIO;
    this._nativeToEthRatio = configuredRatio;
    if (!this.clientWrapper) return;
    try {
      const chainValue = await this.clientWrapper.client.constants.Revive.NativeToEthRatio();
      const chainRatio = BigInt(chainValue as bigint | number);
      if (chainRatio !== configuredRatio) {
        const msg = `DotNS: Revive.NativeToEthRatio from chain (${chainRatio}) differs from configured value (${configuredRatio}); using chain value`;
        console.warn(msg);
        captureWarning("nativeToEthRatio mismatch: chain value overrides env config", {
          chain_value: String(chainRatio),
          configured_value: String(configuredRatio),
        });
      }
      this._nativeToEthRatio = chainRatio;
    } catch {
      // Chain query failed — keep the configured/default baseline. Do not break connect.
    }
  }

  // Returns true when the DotNS chain (Asset Hub) reports a testnet spec_name.
  // Used to gate test-only behaviors like self-granting Full PoP on a Lite
  // signer for a NoStatus label.
  private _testnetCache: boolean | null = null;
  async isTestnet(): Promise<boolean> {
    if (this._testnetCache !== null) return this._testnetCache;
    this.ensureConnected();
    // Prefer the polkadot-api chain read (authoritative spec_name).
    if (this.clientWrapper) {
      try {
        const version = await this.clientWrapper.client.constants.System.Version();
        const raw = (version as any)?.spec_name ?? (version as any)?.specName;
        const specName = typeof raw === "string" ? raw : raw?.asText?.() ?? String(raw ?? "");
        this._testnetCache = isTestnetSpecName(specName);
        return this._testnetCache;
      } catch {}
    }
    // Fallback: infer from RPC endpoint string. The default RPC_ENDPOINTS are
    // all Paseo (testnet); an explicit mainnet RPC would not contain "paseo".
    const rpc = this.rpc ?? "";
    this._testnetCache = isTestnetSpecName(rpc) || rpc.includes("paseo") || rpc.includes("westend") || rpc.includes("rococo");
    return this._testnetCache;
  }

  /**
   * Classify the AliasAccounts state for a substrate address.
   * Only called on paseo-next-v2 testnets inside the preflight's NoStatus branch.
   * Returns "not-bound" if the chain is unreachable (safe fallback to generic advice).
   */
  private async classifyAliasAccountState(ss58: string): Promise<AliasAccountClassification> {
    if (this._classifyOverrideForTest !== null) {
      const result = this._classifyOverrideForTest;
      this._classifyOverrideForTest = null; // consume once
      return result;
    }
    if (!this.clientWrapper) return { state: "not-bound" };
    try {
      const api = this.clientWrapper.client as any;
      const row = await api.query.AliasAccounts.AccountToAlias.getValue(ss58, { at: "best" });
      return classifyAliasAccountRow(row);
    } catch {
      // Chain read failed — return safe fallback so preflight still gives some advice.
      return { state: "not-bound" };
    }
  }

  // Free PAS balance for a substrate address on the connected DotNS chain.
  // Used by preflight to gate the deploy on whether the signer can pay tx
  // fees before the chunk upload runs. Returns 0n if the account doesn't
  // exist on chain.
  async readFreeBalance(ss58: string): Promise<bigint> {
    this.ensureConnected();
    if (!this.clientWrapper) throw new Error("readFreeBalance: polkadot-api client not available");
    const acc = await this.clientWrapper.client.query.System.Account.getValue(ss58);
    return BigInt(acc?.data?.free ?? 0n);
  }

  // Testnet-only: try to top the deploy signer up from the well-known dev
  // phrase's Alice (root) or Bob (//Bob) account. Each candidate is read,
  // skipped if it can't spare the transfer, and otherwise used to send
  // `targetAmount` to `recipientSs58`. Returns the source label + amount on
  // success, or null if neither candidate had the funds. The dev phrase is
  // hardcoded on purpose — this only fires on testnet (gated by caller) and
  // runs against accounts every Substrate-Polkadot tester can fund.
  async attemptTestnetTopUp(recipientSs58: string, targetAmount: bigint): Promise<{ source: "Alice" | "Bob"; transferred: bigint } | null> {
    this.ensureConnected();
    if (!this.clientWrapper) throw new Error("attemptTestnetTopUp: polkadot-api client not available");
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const sources: Array<{ label: "Alice" | "Bob"; uri: string }> = [
      { label: "Alice", uri: DEFAULT_MNEMONIC },
      { label: "Bob", uri: `${DEFAULT_MNEMONIC}//Bob` },
    ];
    for (const src of sources) {
      const account = keyring.addFromUri(src.uri);
      // Self-transfer guard: when the user is already deploying as Alice
      // (root), Alice can't fund herself; fall through to Bob.
      if (account.address === recipientSs58) continue;
      const sourceBalance = await this.readFreeBalance(account.address);
      if (sourceBalance < targetAmount + SOURCE_BUFFER) {
        console.log(`   ${src.label} (${account.address.slice(0, 8)}...) low: ${fmtPas(sourceBalance)} PAS — skipping`);
        // Surface in Sentry so we can see the testnet helper accounts
        // running low before they fully drain — the operator can refill
        // proactively from another funded signer or the faucet.
        captureWarning(`DotNS auto-top-up: ${src.label} insufficient`, {
          source: src.label,
          sourceAddress: account.address,
          free: sourceBalance.toString(),
          required: (targetAmount + SOURCE_BUFFER).toString(),
        });
        continue;
      }
      const signer = getPolkadotSigner(
        account.publicKey,
        "Sr25519",
        async (input: Uint8Array) => account.sign(input),
      );
      console.log(`   Trying ${src.label} (${account.address.slice(0, 8)}...): transferring ${fmtPas(targetAmount)} PAS to ${recipientSs58.slice(0, 8)}...`);
      try {
        await withTimeout(
          this.submitTransfer(signer, recipientSs58, targetAmount),
          TOP_UP_TRANSFER_TIMEOUT_MS,
          `Balances.transfer_allow_death from ${src.label}`,
        );
        return { source: src.label, transferred: targetAmount };
      } catch (e) {
        console.log(`   Top-up via ${src.label} failed: ${(e as Error).message?.slice(0, 200)}`);
      }
    }
    return null;
  }

  // Helper: submit a Balances.transfer_allow_death tx and resolve only after
  // GRANDPA finalization (not best-block inclusion). Auto-top-up writes to
  // the deploy signer's balance; if a re-org rolls back a best-block credit
  // before the deploy's next tx, preflight reports success but setContenthash
  // / register fail with Insufficient funds again. Waiting for finalization
  // adds ~18s on Asset Hub Paseo but eliminates the re-org window.
  // Logs a per-block-progress line so the operator sees the wait isn't a hang.
  // Note: Enum("Id", ss58) is required to decode the SS58 to AccountId32;
  // the structural literal { type: "Id", value } encodes wrong.
  // Companion in tools/setup-e2e-derivation-signers.mjs uses best-block only;
  // that's a one-time setup script, not a runtime gate, so the trade-off there
  // is different.
  private submitTransfer(signer: PolkadotSigner, destSubstrate: string, valueRaw: bigint): Promise<void> {
    const api = this.clientWrapper!.client;
    const tx = api.tx.Balances.transfer_allow_death({
      dest: Enum("Id", destSubstrate),
      value: valueRaw,
    });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let bestBlockSeen = false;
      const sub = tx.signSubmitAndWatch(signer).subscribe({
        next: (event: any) => {
          if (settled) return;
          // First confirmation: in best block. Log and keep waiting for finality.
          if (event.type === "txBestBlocksState" && event.found && !bestBlockSeen) {
            bestBlockSeen = true;
            if (!event.ok) {
              settled = true;
              try { sub.unsubscribe(); } catch {}
              reject(new Error("Balances.transfer_allow_death dispatch error"));
              return;
            }
            console.log(`   Tx in best block — waiting for finalization...`);
            return;
          }
          // Final confirmation: GRANDPA finalized.
          if (event.type === "finalized") {
            settled = true;
            try { sub.unsubscribe(); } catch {}
            if (event.ok === false) reject(new Error("Balances.transfer_allow_death finalization error"));
            else resolve();
          }
        },
        error: (e: any) => {
          if (settled) return;
          settled = true;
          reject(e instanceof Error ? e : new Error(String(e)));
        },
        // Defensive: papi can complete the stream after a network drop without
        // emitting finalized. Without this, the promise hangs forever and
        // preflight stalls. Reject so the caller falls back to Bob.
        complete: () => {
          if (settled) return;
          settled = true;
          reject(new Error("transfer subscription closed without finalization"));
        },
      });
    });
  }

  async contractCall(contractAddress: string, contractAbi: readonly any[], functionName: string, args: any[] = []): Promise<any> {
    this.ensureConnected();
    if (!this.clientWrapper) throw new Error("contractCall: polkadot-api client not available");
    const encodedCallData = encodeFunctionData({ abi: contractAbi, functionName, args });
    const callResult = await this.clientWrapper.performDryRunCall(this.substrateAddress!, contractAddress, 0n, encodedCallData);
    if (!callResult.result.isOk) {
      const errorData = callResult.result.value;
      throw new Error(formatContractDryRunFailure({
        revertData: errorData?.data ?? "0x",
        revertFlags: errorData?.flags ?? 0n,
        gasConsumed: callResult.gasConsumed,
        gasRequired: callResult.gasRequired,
        storageDeposit: callResult.storageDeposit?.value,
      }, {
        contractAddress,
        functionName,
        signerSubstrateAddress: this.substrateAddress!,
        signerEvmAddress: this.evmAddress ?? undefined,
        value: 0n,
        encodedData: encodedCallData,
        args,
        contracts: this._contracts,
      }));
    }
    const rawData: string = callResult.result.value.data ?? "0x";
    // Empty success (`0x`) means the call returned but produced no bytes.
    // On pallet-revive this almost always means the target address has no
    // contract code (wrong or undeployed contract address): calling a bare
    // account with no code succeeds with empty return data. A real contract
    // would return a populated tuple or a structured EVM revert — never silent
    // empty success. Check code-presence to give an actionable error message.
    // A decodable payload is `0x` + ≥1 byte (length ≥ 4); ≤ 2 means empty.
    if (rawData.length <= 2) {
      const hasCode = await this.clientWrapper!.hasContractCode(contractAddress);
      const name = dotnsContractName(contractAddress, this._contracts);
      if (hasCode === false) {
        throw new Error(
          `No contract deployed at ${contractAddress} (${name}) — the dry-run call to ${functionName} returned empty success data, which on pallet-revive means the target address has no contract code. Check environments.json / --contract config for this network.`,
        );
      }
      if (hasCode === null) {
        throw new Error(
          `Contract call returned empty data — contract=${name} (${contractAddress}) functionName=${functionName}. Could not verify whether contract code exists at this address (runtime code-presence query failed); investigate the contract/ABI or the configured address.`,
        );
      }
      throw new Error(
        `Contract call returned empty data — contract=${name} (${contractAddress}) functionName=${functionName}. The address has contract code but the call returned no bytes, which is unexpected for this read. Investigate the contract/ABI rather than masking it with a default.`,
      );
    }
    return decodeFunctionResult({ abi: contractAbi, functionName, data: rawData as `0x${string}` });
  }

  /**
   * Like contractCall, but returns null when the chain replies with empty data
   * ("0x"). Use this for view functions where an unset storage slot is a
   * meaningful answer (e.g. resolver(node) for a name with no resolver,
   * text records, optional ownership lookups). Use the strict contractCall
   * for read paths that must always return a value.
   */
  async contractCallNullable(
    contractAddress: string,
    contractAbi: readonly any[],
    functionName: string,
    args: any[] = [],
  ): Promise<any | null> {
    this.ensureConnected();
    if (!this.clientWrapper) throw new Error("contractCallNullable: polkadot-api client not available");
    const encodedCallData = encodeFunctionData({ abi: contractAbi, functionName, args });
    const callResult = await this.clientWrapper.performDryRunCall(this.substrateAddress!, contractAddress, 0n, encodedCallData);
    if (!callResult.result.isOk) {
      const errorData = callResult.result.value;
      throw new Error(formatContractDryRunFailure({
        revertData: errorData?.data ?? "0x",
        revertFlags: errorData?.flags ?? 0n,
        gasConsumed: callResult.gasConsumed,
        gasRequired: callResult.gasRequired,
        storageDeposit: callResult.storageDeposit?.value,
      }, {
        contractAddress,
        functionName,
        signerSubstrateAddress: this.substrateAddress!,
        signerEvmAddress: this.evmAddress ?? undefined,
        value: 0n,
        encodedData: encodedCallData,
        args,
        contracts: this._contracts,
      }));
    }
    const rawData: string = callResult.result.value.data ?? "0x";
    // Empty success — chain returned no data. Common for unset storage slots
    // (resolver(node) on a name without a resolver, ownerOf(token) on a
    // non-existent token in some impls). viem decodeFunctionResult throws
    // "Cannot decode zero data" on this; we return null so callers can decide.
    // A decodable payload is `0x` + ≥1 byte (length ≥ 4); ≤ 2 means empty.
    if (rawData.length <= 2) return null;
    return decodeFunctionResult({ abi: contractAbi, functionName, data: rawData as `0x${string}` });
  }

  async contractTransaction(contractAddress: string, value: bigint, contractAbi: readonly any[], functionName: string, args: any[] = [], statusCallback: (status: string) => void = () => {}, { useNoncePolling, verifyEffect, feeAsset, phoneLabel }: { useNoncePolling?: boolean; verifyEffect?: () => Promise<boolean>; feeAsset?: "pgas"; phoneLabel?: string } = {}): Promise<TxResolution> {
    this.ensureConnected();
    if (!this.clientWrapper) throw new Error("contractTransaction: polkadot-api client not available");
    const encodedCallData = encodeFunctionData({ abi: contractAbi, functionName, args });
    const rpcs = this.rpc ? [this.rpc, ...this.assetHubEndpoints.filter((ep) => ep !== this.rpc)] : this.assetHubEndpoints;
    // Split timeout (#969): await the human-ready gate OUTSIDE withTimeout so
    // the human wait is never counted against the machine budget. The chain
    // timeout starts only after the user confirms (or immediately for non-phone signers).
    if (phoneLabel !== undefined) {
      await this._awaitPhoneReady(phoneLabel);
    }
    return await withTimeout(
      this.clientWrapper.submitTransaction(contractAddress, value, encodedCallData, this.substrateAddress!, this.signer!, statusCallback, { rpcs, useNoncePolling, functionName, args, contracts: this._contracts, verifyEffect, feeAsset, isPhoneSigner: this._usesExternalSigner }),
      OPERATION_TIMEOUT_MS,
      functionName,
    );
  }

  async checkOwnership(label: string, ownerAddress: string | null = null): Promise<OwnershipResult> {
    this.ensureConnected();
    const checkAddress = (ownerAddress || this.evmAddress!).toLowerCase();
    const tokenId = computeDomainTokenId(label);
    try {
      const owner = await withTimeout(this.contractCallNullable(this._contracts.DOTNS_REGISTRAR, DOTNS_REGISTRAR_ABI, "ownerOf", [tokenId]), 30000, "ownerOf");
      if (owner === null) return { owned: false, owner: null };
      const owned = owner.toLowerCase() === checkAddress;
      return { owned, owner };
    } catch { return { owned: false, owner: null }; }
  }

  /** Live transfer-fee quote. transferFloor is a pure PopRules view — it
   *  classifies the label and reads both tiers, so it works BEFORE the name is
   *  registered (unlike quoteTransferFee, which reverts on an unregistered token). */
  async quoteTransferFloorNative(label: string, fromH160: string, toH160: string): Promise<{ feeWei: bigint; feeNative: bigint }> {
    this.ensureConnected();
    const feeWei = (await withTimeout(
      this.contractCall(this._contracts.POP_RULES, POP_RULES_ABI, "transferFloor", [validateDomainLabel(label), fromH160, toH160]),
      30000, "transferFloor",
    )) as bigint;
    return { feeWei, feeNative: weiToNative(feeWei, this._nativeToEthRatio) };
  }

  /** Hand `label`.dot from the connected signer (the worker, current owner) to
   *  `toH160`, paying the transferFloor friction fee. Idempotent: a no-op if the
   *  recipient already owns it; errors if a third party does. */
  async transferName(
    label: string,
    toH160: string,
    statusCallback: (status: string) => void = () => {},
  ): Promise<{ status: "ok" | "skipped-already-owned"; txHash?: string; feeWei?: bigint }> {
    this.ensureConnected();
    const validated = validateDomainLabel(label);
    const tokenId = computeDomainTokenId(validated);
    const owner = (await withTimeout(this.contractCall(this._contracts.DOTNS_REGISTRAR, DOTNS_REGISTRAR_TRANSFER_ABI, "ownerOf", [tokenId]), 30000, "ownerOf")) as string;
    if (owner.toLowerCase() === toH160.toLowerCase()) {
      statusCallback("already owned by recipient");
      return { status: "skipped-already-owned" };
    }
    if (owner.toLowerCase() !== this.evmAddress!.toLowerCase()) {
      throw new Error(`Cannot transfer ${validated}.dot: it is owned by ${owner}, not the worker ${this.evmAddress}.`);
    }
    const { feeWei, feeNative } = await this.quoteTransferFloorNative(validated, this.evmAddress!, toH160);
    const txRes = await this.contractTransaction(
      this._contracts.DOTNS_REGISTRAR, feeNative, DOTNS_REGISTRAR_TRANSFER_ABI, "transferFrom",
      [this.evmAddress, toH160, tokenId], statusCallback,
    );
    const after = (await withTimeout(this.contractCall(this._contracts.DOTNS_REGISTRAR, DOTNS_REGISTRAR_TRANSFER_ABI, "ownerOf", [tokenId]), 30000, "ownerOf")) as string;
    if (after.toLowerCase() !== toH160.toLowerCase()) {
      throw new Error(`Transfer of ${validated}.dot did not land: owner is ${after}, expected ${toH160}.`);
    }
    return { status: "ok", txHash: txRes.kind === TX_KIND_HASH ? txRes.hash : undefined, feeWei };
  }

  async getUserPopStatus(ownerAddress: string | null = null): Promise<number> {
    if (this._userPopStatusOverrideForTest !== null) {
      const result = this._userPopStatusOverrideForTest;
      this._userPopStatusOverrideForTest = null;
      return result;
    }
    this.ensureConnected();
    const checkAddress = ownerAddress || this.evmAddress!;
    try {
      const result = await withTimeout(
        this.contractCall(PERSONHOOD_PRECOMPILE_ADDRESS, PERSONHOOD_ABI, "personhoodStatus", [checkAddress, PERSONHOOD_CONTEXT]),
        30000,
        "personhoodStatus",
      );
      return parsePersonhoodStatusResult(result);
    } catch (e: any) {
      throw new Error(
        `Could not read DotNS Personhood status for ${checkAddress} from the Personhood precompile. ` +
        `Check the Asset Hub RPC/environment and contact the DotNS team if the signer should be whitelisted. Underlying: ${e?.message ?? String(e)}`,
      );
    }
  }

  async checkSubdomainOwnership(sublabel: string, parentLabel: string): Promise<OwnershipResult> {
    this.ensureConnected();
    // The CLI does not expose subdomain registry lookups. Fall back to polkadot-api
    // contractCall on DOTNS_REGISTRY.owner(node). This is only needed for
    // subdomain deploys which are a minority path.
    if (!this.clientWrapper) return { owned: false, owner: null };
    const node = namehash(`${sublabel}.${parentLabel}.dot`);
    try {
      const owner = await withTimeout(this.contractCallNullable(this._contracts.DOTNS_REGISTRY, DOTNS_REGISTRY_ABI, "owner", [node]), 30000, "owner");
      if (!owner || owner === zeroAddress) return { owned: false, owner: null };
      const owned = owner.toLowerCase() === this.evmAddress!.toLowerCase();
      return { owned, owner };
    } catch { return { owned: false, owner: null }; }
  }

  async registerSubdomain(sublabel: string, parentLabel: string): Promise<{ sublabel: string; parentLabel: string; owner: string }> {
    return withSpan("deploy.dotns.register-subdomain", `2a. register ${sublabel}.${parentLabel}.dot`, {}, async () => {
      this.ensureConnected();
      console.log(`\n   Registering subdomain ${sublabel}.${parentLabel}.dot...`);
      const parentNode = namehash(`${parentLabel}.dot`);
      const subnodeNode = namehash(`${sublabel}.${parentLabel}.dot`);
      const subnodeRecord = { parentNode, subLabel: sublabel, parentLabel, owner: this.evmAddress! };

      // verifyEffect: mirrors setContenthash/setTextRecord. Guards the nonce-advance
      // fallback path in signAndSubmitWithRetry — without it, a sibling concurrent
      // writer consuming the expected nonce would be mistaken for a successful batch,
      // and the following setContenthash/setTextRecord steps would dry-run against
      // state where the subnode doesn't yet exist (records[node].exists == false →
      // _authorised → NotAuthorised, 0x1648fd01). Polls checkSubdomainOwnership
      // until the subnode is queryable, using the same chain-time budget as
      // setContenthash. See setContenthash (line ~1937) for the pattern this mirrors.
      const MAX_VERIFY_CHAIN_SECONDS = 30;
      const POLL_INTERVAL_MS = 2_000;
      const verifyEffect = async (): Promise<boolean> => {
        // Capture clientWrapper once; bail if session torn down (same guard as
        // setContenthash — prevents orphaned rejections on disconnect, #515).
        const wrapper = this.clientWrapper;
        if (!this.connected || !wrapper) return false;
        const startChainMs = Number(await wrapper.client.query.Timestamp.Now.getValue());
        let lastPrintedElapsed = -1;
        while (true) {
          const liveWrapper = this.clientWrapper;
          if (!this.connected || !liveWrapper) return false;
          const [ownership, nowChainMs] = await Promise.all([
            this.checkSubdomainOwnership(sublabel, parentLabel),
            liveWrapper.client.query.Timestamp.Now.getValue().then(Number),
          ]);
          if (ownership.owned) return true;
          const chainElapsed = (nowChainMs - startChainMs) / 1000;
          if (chainElapsed >= MAX_VERIFY_CHAIN_SECONDS) return false;
          const floored = Math.floor(chainElapsed);
          if (floored > lastPrintedElapsed) {
            console.log(`   Awaiting subnode finalization [verifyEffect] (chain time +${floored}s / ${MAX_VERIFY_CHAIN_SECONDS}s)...`);
            lastPrintedElapsed = floored;
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
      };

      // setSubnodeOwner and setResolver are committed atomically via
      // Utility.batch_all so the runtime sees them as one transaction.
      // Submitting separately raced: setResolver's dry-run ran against
      // pre-setSubnodeOwner state and the registry reverted with
      // flags=1 data=0x1648fd01 (caller is not the node owner).
      const txResolution = await this.submitBatchedContractCalls(
        [
          { contractAddress: this._contracts.DOTNS_REGISTRY, abi: DOTNS_REGISTRY_ABI, functionName: "setSubnodeOwner", args: [subnodeRecord] },
          { contractAddress: this._contracts.DOTNS_REGISTRY, abi: DOTNS_REGISTRY_ABI, functionName: "setResolver", args: [subnodeNode, this._contracts.DOTNS_CONTENT_RESOLVER] },
        ],
        (s: string) => console.log(`      ${s}`),
        `Utility.batch_all (register ${sublabel}.${parentLabel}.dot)`,
        { verifyEffect },
      );
      logTxResolution(txResolution);
      setDeployAttribute("deploy.subnode.tx_resolution_kind", txResolution.kind);
      if (txResolution.kind === TX_KIND_HASH) {
        setDeployAttribute("deploy.subnode.tx", txResolution.hash);
        if (txResolution.block) {
          setDeployAttribute("deploy.subnode.block", String(txResolution.block.number));
          setDeployAttribute("deploy.subnode.block_hash", txResolution.block.hash);
          console.log(`      finalised @ block ${txResolution.block.number} (tx ${txResolution.hash})`);
        } else {
          console.log(`      finalised (tx ${txResolution.hash})`);
        }
      }

      console.log(`   Subdomain registered!`);
      return { sublabel, parentLabel, owner: this.evmAddress! };
    });
  }

  /**
   * Submit multiple contract calls as a single atomic `Utility.batch_all`
   * extrinsic.
   *
   * Each call is encoded as a `pallet-revive::call(...)` extrinsic and
   * batched into one outer dispatch. The runtime executes them in
   * sequence and rolls back the entire batch on any inner revert. Only
   * the leading call is dry-run for gas — its weight is reused as the
   * budget for every subsequent call, on the assumption sibling
   * registry/resolver writes are similarly sized.
   */
  private async submitBatchedContractCalls(
    calls: { contractAddress: string; abi: readonly any[]; functionName: string; args: any[]; value?: bigint }[],
    statusCallback: (status: string) => void,
    label: string,
    { verifyEffect }: { verifyEffect?: () => Promise<boolean> } = {},
  ): Promise<TxResolution> {
    this.ensureConnected();
    if (!this.clientWrapper) throw new Error(`${label}: polkadot-api client not available`);
    if (calls.length === 0) throw new Error(`${label}: at least one inner call required`);

    await this.clientWrapper.ensureAccountMapped(this.substrateAddress!, this.signer!);

    const encoded = calls.map(c => ({
      contractAddress: c.contractAddress,
      value: c.value ?? 0n,
      data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args }),
    }));

    const headEstimate = await this.clientWrapper.estimateGasForCall(
      this.substrateAddress!,
      encoded[0].contractAddress,
      encoded[0].value,
      encoded[0].data,
    );
    if (!headEstimate.success) {
      throw new Error(formatContractDryRunFailure(headEstimate, {
        contractAddress: encoded[0].contractAddress,
        functionName: calls[0].functionName,
        signerSubstrateAddress: this.substrateAddress!,
        signerEvmAddress: this.evmAddress!,
        value: encoded[0].value,
        encodedData: encoded[0].data,
        args: calls[0].args,
        contracts: this._contracts,
      }));
    }

    const weight_limit = {
      proof_size: headEstimate.gasRequired.proofSize,
      ref_time: headEstimate.gasRequired.referenceTime,
    };
    const minimumStorageDeposit = 2_000_000_000_000n;
    let storage_deposit_limit = headEstimate.storageDeposit === 0n
      ? minimumStorageDeposit
      : (headEstimate.storageDeposit * 120n) / 100n;
    if (storage_deposit_limit < minimumStorageDeposit) storage_deposit_limit = minimumStorageDeposit;

    const client = this.clientWrapper.client;
    const buildBatch = () => {
      const inner = encoded.map(e =>
        client.tx.Revive.call({
          dest: e.contractAddress,
          value: e.value,
          weight_limit,
          storage_deposit_limit,
          data: Binary.fromHex(e.data),
        }),
      );
      return client.tx.Utility.batch_all({ calls: inner.map((c: any) => c.decodedCall) });
    };

    return await withTimeout(
      this.clientWrapper.signAndSubmitWithRetry(buildBatch, this.signer!, statusCallback, label, { verifyEffect }),
      OPERATION_TIMEOUT_MS,
      label,
    );
  }

  async setContenthash(domainName: string, contenthashHex: string, opts: { feeAsset?: "pgas" } = {}): Promise<{ node: string }> {
    return withSpan("deploy.dotns.set-contenthash", "2b. set-contenthash", {}, async () => {
      this.ensureConnected();
      const node = namehash(`${domainName}.dot`);
      // Decode the contenthash hex to the IPFS CID string the CLI expects.
      let ipfsCid: string | null = null;
      if (contenthashHex && contenthashHex !== "0x") {
        const bytes = Buffer.from(contenthashHex.slice(2), "hex");
        if (bytes[0] === 0xe3 && bytes.length >= 4) {
          const cidBytes = bytes.slice(2);
          ipfsCid = CID.decode(cidBytes).toString();
        }
      }
      if (!ipfsCid) throw new Error(`setContenthash: cannot decode contenthash ${contenthashHex} to an IPFS CID`);
      console.log(`   Setting contenthash: ${ipfsCid}`);

      // Pre-check: skip the tx if already set to the same CID.
      const expected = contenthashHex.toLowerCase();
      try {
        const current = ((await this.getContenthash(domainName)) || "0x").toLowerCase();
        if (current === expected) {
          console.log(`   Contenthash already set: ${ipfsCid} — skipping tx`);
          setDeployAttribute("deploy.dotns.contenthash_unchanged", "true");
          return { node };
        }
      } catch (_) {
        // Read failure — proceed with the normal set path.
      }
      setDeployAttribute("deploy.dotns.contenthash_unchanged", "false");

      const MAX_VERIFY_CHAIN_SECONDS = 30;
      const POLL_INTERVAL_MS = 2_000;
      const verifyEffect = async (): Promise<boolean> => {
        // verifyEffect is awaited from a recursive-setTimeout poller in
        // signAndSubmitExtrinsic. Multiple poller ticks can be mid-flight
        // when the outer tx promise settles (e.g. via the subscription's
        // `finalized` event) and the caller of setContenthash then calls
        // dotns.disconnect() — clearing this.clientWrapper. Any in-flight
        // verifyEffect iteration that resumes after that point would, on
        // its next loop, evaluate:
        //   [ this.getContenthash(domainName),  // returns REJECTED promise (ensureConnected throws)
        //     this.clientWrapper!.client.query…  // sync TypeError on null
        //   ]
        // The sync throw aborts array construction BEFORE Promise.all sees
        // it, orphaning the getContenthash rejection → unhandled at process
        // level → CI crash (S-ext-signer release run, v0.7.25-rc.4..rc.6).
        // Fix: capture clientWrapper into a local and bail early when the
        // session has been torn down. See #515 (introducing commit).
        const wrapper = this.clientWrapper;
        if (!this.connected || !wrapper) return false;
        const startChainMs = Number(await wrapper.client.query.Timestamp.Now.getValue());
        let lastPrintedElapsed = -1;
        while (true) {
          const liveWrapper = this.clientWrapper;
          if (!this.connected || !liveWrapper) return false;
          const [onChainRaw, nowChainMs] = await Promise.all([
            this.getContenthash(domainName),
            liveWrapper.client.query.Timestamp.Now.getValue().then(Number),
          ]);
          const onChain = (onChainRaw || "0x").toLowerCase();
          if (onChain === expected) return true;
          const chainElapsed = (nowChainMs - startChainMs) / 1000;
          if (chainElapsed >= MAX_VERIFY_CHAIN_SECONDS) return false;
          const floored = Math.floor(chainElapsed);
          if (floored > lastPrintedElapsed) {
            console.log(`   Awaiting finalization (chain time +${floored}s / ${MAX_VERIFY_CHAIN_SECONDS}s)...`);
            lastPrintedElapsed = floored;
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
      };

      console.log(`\n   Linking content...`);
      const txRes = await this.contractTransaction(this._contracts.DOTNS_CONTENT_RESOLVER, 0n, DOTNS_CONTENT_RESOLVER_ABI, "setContenthash", [node, contenthashHex], (s) => console.log(`      ${s}`), { useNoncePolling: true, verifyEffect, feeAsset: opts.feeAsset, phoneLabel: "Link content" });

      // Final read-back catches a rare post-finality reorg.
      const finalOnChain = ((await this.getContenthash(domainName)) || "0x").toLowerCase();
      if (finalOnChain !== expected) {
        throw new Error(
          `Post-deploy verification failed for ${domainName}.dot: on-chain contenthash is ${finalOnChain}, ` +
          `not the ${expected} we just wrote. The setContenthash tx may have silently failed, ` +
          `or another party overwrote the domain. Re-run the deploy to retry.`,
        );
      }
      setDeployAttribute("deploy.dotns.tx_resolution", txRes.kind);
      logTxResolution(txRes);
      if (txRes.kind === TX_KIND_HASH) {
        setDeployAttribute("deploy.contenthash.tx", txRes.hash);
        if (txRes.block) {
          setDeployAttribute("deploy.contenthash.block", String(txRes.block.number));
          setDeployAttribute("deploy.contenthash.block_hash", txRes.block.hash);
          console.log(`      finalised @ block ${txRes.block.number} (tx ${txRes.hash})`);
        } else {
          console.log(`      finalised (tx ${txRes.hash})`);
        }
      }
      console.log(`   Verified on-chain: ${ipfsCid}\n`);
      return { node };
    });
  }

  /**
   * Point a node's registered resolver at `DOTNS_CONTENT_RESOLVER` (RFC §Step 3.2).
   *
   * Hosts read text records via `IDotnsRegistry.resolver(node)`, so the
   * registered slot must point at the content resolver for manifest text
   * records to be discoverable. The pre-read is best-effort: pallet-revive
   * returns `isOk=true` with empty data when a selector isn't in the
   * deployed bytecode, which makes viem's decoder throw. Any decode failure
   * is treated as "unset" and the write fires unconditionally. `setResolver`
   * is idempotent against the same target, so registries that pre-date the
   * `resolver(bytes32)` getter just pay one extra extrinsic per publish.
   */
  async ensureContentResolver(domainName: string): Promise<{ changed: boolean }> {
    this.ensureConnected();
    const node = namehash(`${domainName}.dot`);
    const target = this._contracts.DOTNS_CONTENT_RESOLVER;
    let current: unknown = null;
    try {
      current = await this.contractCall(this._contracts.DOTNS_REGISTRY, DOTNS_REGISTRY_ABI, "resolver", [node]);
    } catch {
      // Treat unreadable resolver as unset and fall through to the write.
    }
    if (typeof current === "string" && current.toLowerCase() === target.toLowerCase()) {
      return { changed: false };
    }
    console.log(`   Redirecting resolver for ${domainName}.dot to content resolver ${target}…`);
    await this.contractTransaction(this._contracts.DOTNS_REGISTRY, 0n, DOTNS_REGISTRY_ABI, "setResolver", [node, target], (s) => console.log(`      ${s}`), { useNoncePolling: true });
    return { changed: true };
  }

  /** Read a text record off `DOTNS_CONTENT_RESOLVER`. Returns `""` when unset. */
  async getTextRecord(domainName: string, key: string): Promise<string> {
    this.ensureConnected();
    const node = namehash(`${domainName}.dot`);
    const result = await this.contractCall(
      this._contracts.DOTNS_CONTENT_RESOLVER,
      DOTNS_TEXT_RESOLVER_ABI,
      "text",
      [node, key],
    );
    return typeof result === "string" ? result : "";
  }

  async setTextRecord(
    domainName: string,
    key: string,
    value: string,
  ): Promise<{ value: string; txHash: string }> {
    return withSpan("deploy.dotns.set-text", `2c. set-text ${key}`, {}, async () => {
      this.ensureConnected();
      console.log(`   Setting text[${key}]: ${value}`);
      const node = namehash(`${domainName}.dot`);

      // verifyEffect: mirrors setContenthash — used by submitTransaction's
      // nonce-advance fallback path so a nonce consumed by a concurrent writer
      // is not mistaken for a successful setText (false-positive nonce-advance).
      // Without this, a sibling parallel job consuming Alice's expected nonce
      // caused the nonce-advance path to declare success; the 90s post-hoc poll
      // below then threw "Post-set verification failed" with no retry attempted.
      const MAX_VERIFY_CHAIN_SECONDS = 30;
      const TEXT_POLL_INTERVAL_MS = 2_000;
      const verifyEffect = async (): Promise<boolean> => {
        // Capture wrapper once; bail if session torn down (same guard as
        // setContenthash — prevents orphaned rejections on disconnect, #515).
        const wrapper = this.clientWrapper;
        if (!this.connected || !wrapper) return false;
        const startChainMs = Number(await wrapper.client.query.Timestamp.Now.getValue());
        let lastPrintedElapsed = -1;
        while (true) {
          const liveWrapper = this.clientWrapper;
          if (!this.connected || !liveWrapper) return false;
          const [onChainRaw, nowChainMs] = await Promise.all([
            this.contractCallNullable(this._contracts.DOTNS_CONTENT_RESOLVER, DOTNS_TEXT_RESOLVER_ABI, "text", [node, key]),
            liveWrapper.client.query.Timestamp.Now.getValue().then(Number),
          ]);
          const onChain = onChainRaw ?? "";
          if (onChain === value) return true;
          const chainElapsed = (nowChainMs - startChainMs) / 1000;
          if (chainElapsed >= MAX_VERIFY_CHAIN_SECONDS) return false;
          const floored = Math.floor(chainElapsed);
          if (floored > lastPrintedElapsed) {
            console.log(`   Awaiting text finalization [verifyEffect] (chain time +${floored}s / ${MAX_VERIFY_CHAIN_SECONDS}s)...`);
            lastPrintedElapsed = floored;
          }
          await new Promise((r) => setTimeout(r, TEXT_POLL_INTERVAL_MS));
        }
      };

      const textTxRes = await this.contractTransaction(this._contracts.DOTNS_CONTENT_RESOLVER, 0n, DOTNS_TEXT_RESOLVER_ABI, "setText", [node, key, value], (s) => console.log(`      ${s}`), { useNoncePolling: true, verifyEffect });
      logTxResolution(textTxRes);
      // verifyEffect above runs a 30s chain-time budget inside contractTransaction;
      // this post-hoc poll adds up to 90s more — worst-case latency is 120s chain time.
      const MAX_CHAIN_WAIT_SECONDS = 90;
      const POLL_INTERVAL_MS = 2_000;
      const startChainMs = Number(await this.clientWrapper!.client.query.Timestamp.Now.getValue());
      let onChainValue = "";
      let lastPrintedElapsed = -1;
      while (true) {
        const onChain = await withTimeout(this.contractCall(this._contracts.DOTNS_CONTENT_RESOLVER, DOTNS_TEXT_RESOLVER_ABI, "text", [node, key]), 30000, "text");
        onChainValue = onChain ?? "";
        if (onChainValue === value) break;
        const nowChainMs = Number(await this.clientWrapper!.client.query.Timestamp.Now.getValue());
        const chainElapsed = (nowChainMs - startChainMs) / 1000;
        if (chainElapsed >= MAX_CHAIN_WAIT_SECONDS) break;
        const floored = Math.floor(chainElapsed);
        if (floored > lastPrintedElapsed) {
          console.log(`   Awaiting text finalization (chain time +${floored}s / ${MAX_CHAIN_WAIT_SECONDS}s)...`);
          lastPrintedElapsed = floored;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (onChainValue !== value) {
        throw new Error(
          `Post-set verification failed for text[${key}] on ${domainName}.dot: on-chain value is ${JSON.stringify(onChainValue)}, not ${JSON.stringify(value)} we just wrote. The setText tx may have silently failed, or another writer overwrote the record.`,
        );
      }
      console.log(`   Verified text[${key}]: ${onChainValue}\n`);
      const txHashStr = textTxRes.kind === TX_KIND_HASH ? textTxRes.hash : TX_KIND_NONCE_ADVANCED;
      return { value, txHash: txHashStr };
    });
  }

  // Atomicity boundary: setContenthash and publish stay outside this batch
  // so a cosmetic setText failure cannot roll back the on-chain CID.
  async setTextRecords(
    domainName: string,
    entries: { key: string; value: string }[],
  ): Promise<{ txHash: string | null; batched: boolean }> {
    if (entries.length === 0) return { txHash: null, batched: false };
    if (entries.length === 1) {
      const r = await this.setTextRecord(domainName, entries[0].key, entries[0].value);
      return { txHash: r.txHash, batched: false };
    }
    return withSpan("deploy.dotns.set-text-batch", `2c. set-text batch (${entries.length})`, {}, async () => {
      this.ensureConnected();
      const node = namehash(`${domainName}.dot`);
      const calls = entries.map((e) => {
        console.log(`   Setting text[${e.key}]: ${e.value}`);
        return {
          contractAddress: this._contracts.DOTNS_CONTENT_RESOLVER,
          value: 0n,
          encodedData: encodeFunctionData({ abi: DOTNS_TEXT_RESOLVER_ABI, functionName: "setText", args: [node, e.key, e.value] }),
          functionName: "setText",
          args: [node, e.key, e.value],
        };
      });
      // TODO: verifyEffect not plumbed through the batched path —
      // submitBatchedTransactions does not accept an opts object with verifyEffect.
      // The 90s post-hoc poll below is the backstop. setTextRecords has no active
      // callers as of PR #484 (single-entry path delegates to setTextRecord which
      // has verifyEffect). Plumb when the batched path is revived.
      const batchTxRes = await withTimeout(
        this.clientWrapper!.submitBatchedTransactions(calls, this.substrateAddress!, this.signer!, (s) => console.log(`      ${s}`)),
        OPERATION_TIMEOUT_MS,
        "Utility.batch_all(setText)",
      );
      logTxResolution(batchTxRes);
      const txHash = batchTxRes.kind === TX_KIND_HASH ? batchTxRes.hash : TX_KIND_NONCE_ADVANCED;
      // Chain-time polling for verification, mirroring setTextRecord. Dry-run RPC
      // reads can lag block finalization; poll up to 90s of chain time before
      // declaring failure. Reads run in parallel each round so an N-entry batch
      // only costs N concurrent RPCs per poll, not N sequential.
      const MAX_CHAIN_WAIT_SECONDS = 90;
      const POLL_INTERVAL_MS = 2_000;
      const startChainMs = Number(await this.clientWrapper!.client.query.Timestamp.Now.getValue());
      let lastResults: { key: string; expected: string; onChain: string }[] = [];
      while (true) {
        lastResults = await Promise.all(entries.map((e) =>
          withTimeout(this.contractCall(this._contracts.DOTNS_CONTENT_RESOLVER, DOTNS_TEXT_RESOLVER_ABI, "text", [node, e.key]), 30000, "text")
            .then((onChain) => ({ key: e.key, expected: e.value, onChain: onChain ?? "" }))));
        if (lastResults.every((v) => v.onChain === v.expected)) break;
        const nowChainMs = Number(await this.clientWrapper!.client.query.Timestamp.Now.getValue());
        const chainElapsed = (nowChainMs - startChainMs) / 1000;
        if (chainElapsed >= MAX_CHAIN_WAIT_SECONDS) break;
        console.log(`   Awaiting batched text finalization (chain time +${Math.floor(chainElapsed)}s / ${MAX_CHAIN_WAIT_SECONDS}s)...`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      for (const v of lastResults) {
        if (v.onChain !== v.expected) {
          throw new Error(
            `Post-set verification failed for text[${v.key}] on ${domainName}.dot: on-chain value is ${JSON.stringify(v.onChain)}, not ${JSON.stringify(v.expected)} we just wrote. The batched setText tx may have silently failed, or another writer overwrote the record.`,
          );
        }
        console.log(`   Verified text[${v.key}]: ${v.onChain}`);
      }
      return { txHash, batched: true };
    });
  }

  // Adds `<label>.dot` to the on-chain Publisher registry. Pre-checks
  // isPublished and returns "already-published" instead of resubmitting,
  // which is both cheaper and avoids waking the Lite cooldown. A
  // CooldownActive revert is treated as success-equivalent — the registry
  // is already in the desired state from a recent prior publish.
  async publishLabel(label: string): Promise<{ status: "published" | "already-published" | "cooldown-skipped"; txHash?: string }> {
    return withSpan("deploy.publish", `3. publish ${label}.dot`, { "deploy.publish.label": label }, async () => {
      this.ensureConnected();
      const publisher = this._contracts.PUBLISHER;
      if (!publisher || publisher === zeroAddress) {
        throw new PublisherNotSupportedError(this.rpc ?? "unknown");
      }
      const labelhash = keccak256(toBytes(label));
      const already = await withTimeout(
        this.contractCall(publisher, PUBLISHER_ABI, "isPublished", [labelhash]),
        30000,
        "isPublished",
      );
      if (already === true) {
        console.log(`   Already published — skipping`);
        return { status: "already-published" as const };
      }

      const MAX_VERIFY_CHAIN_SECONDS = 30;
      const PUBLISH_POLL_INTERVAL_MS = 2_000;
      const verifyEffect = async (): Promise<boolean> => {
        // Capture wrapper once; bail if session torn down (same guard as
        // setContenthash — prevents orphaned rejections on disconnect, #515).
        const wrapper = this.clientWrapper;
        if (!this.connected || !wrapper) return false;
        const startChainMs = Number(await wrapper.client.query.Timestamp.Now.getValue());
        let lastPrintedElapsed = -1;
        while (true) {
          const liveWrapper = this.clientWrapper;
          if (!this.connected || !liveWrapper) return false;
          const [published, nowChainMs] = await Promise.all([
            this.contractCall(publisher, PUBLISHER_ABI, "isPublished", [labelhash]),
            liveWrapper.client.query.Timestamp.Now.getValue().then(Number),
          ]);
          if (published === true) return true;
          const chainElapsed = (nowChainMs - startChainMs) / 1000;
          if (chainElapsed >= MAX_VERIFY_CHAIN_SECONDS) return false;
          const floored = Math.floor(chainElapsed);
          if (floored > lastPrintedElapsed) {
            console.log(`   Awaiting publish finalization [verifyEffect] (chain time +${floored}s / ${MAX_VERIFY_CHAIN_SECONDS}s)...`);
            lastPrintedElapsed = floored;
          }
          await new Promise((r) => setTimeout(r, PUBLISH_POLL_INTERVAL_MS));
        }
      };

      try {
        const txRes = await this.contractTransaction(publisher, 0n, PUBLISHER_ABI, "publish", [label], (s) => console.log(`      ${s}`), { useNoncePolling: true, verifyEffect, phoneLabel: "Publish to registry" });
        // Final read-back catches a rare post-finality reorg or nonce-advance false-positive.
        const finalPublished = await withTimeout(
          this.contractCall(publisher, PUBLISHER_ABI, "isPublished", [labelhash]),
          30000,
          "isPublished",
        );
        if (finalPublished !== true) {
          throw new Error(
            `Post-publish verification failed for ${label}.dot: isPublished returned ${finalPublished} after the publish tx. ` +
            `The publish tx may have silently failed via nonce-advance, or another party removed the label. Re-run to retry.`,
          );
        }
        logTxResolution(txRes);
        const txHash = txRes.kind === TX_KIND_HASH ? txRes.hash : TX_KIND_NONCE_ADVANCED;
        return { status: "published" as const, txHash };
      } catch (e: any) {
        const decoded = decodePublisherRevert(e);
        if (decoded?.name === "CooldownActive") {
          const nextAllowed = decoded.args?.[0];
          console.log(`   Cooldown active (next allowed at ${nextAllowed}) — treating as already published`);
          return { status: "cooldown-skipped" as const };
        }
        if (decoded?.name) throw new Error(`Publisher.publish reverted: ${decoded.name}${decoded.args ? `(${decoded.args.join(", ")})` : ""}`);
        throw e;
      }
    });
  }

  // Removes `<label>.dot` from the on-chain Publisher registry. Pre-checks
  // isPublished and returns "already-unpublished" instead of resubmitting,
  // which both saves gas and avoids emitting a spurious Unpublished event
  // for a label that was never in the set.
  async unpublishLabel(label: string): Promise<{ status: "unpublished" | "already-unpublished"; txHash?: string }> {
    return withSpan("deploy.unpublish", `unpublish ${label}.dot`, { "deploy.unpublish.label": label }, async () => {
      this.ensureConnected();
      const publisher = this._contracts.PUBLISHER;
      if (!publisher || publisher === zeroAddress) {
        throw new PublisherNotSupportedError(this.rpc ?? "unknown");
      }
      const labelhash = keccak256(toBytes(label));
      const isPub = await withTimeout(
        this.contractCall(publisher, PUBLISHER_ABI, "isPublished", [labelhash]),
        30000,
        "isPublished",
      );
      if (isPub !== true) {
        console.log(`   Not currently published — skipping`);
        return { status: "already-unpublished" as const };
      }

      const MAX_VERIFY_CHAIN_SECONDS = 30;
      const UNPUBLISH_POLL_INTERVAL_MS = 2_000;
      const verifyEffect = async (): Promise<boolean> => {
        // Capture wrapper once; bail if session torn down (same guard as
        // setContenthash — prevents orphaned rejections on disconnect, #515).
        const wrapper = this.clientWrapper;
        if (!this.connected || !wrapper) return false;
        const startChainMs = Number(await wrapper.client.query.Timestamp.Now.getValue());
        let lastPrintedElapsed = -1;
        while (true) {
          const liveWrapper = this.clientWrapper;
          if (!this.connected || !liveWrapper) return false;
          const [published, nowChainMs] = await Promise.all([
            this.contractCall(publisher, PUBLISHER_ABI, "isPublished", [labelhash]),
            liveWrapper.client.query.Timestamp.Now.getValue().then(Number),
          ]);
          if (published !== true) return true;
          const chainElapsed = (nowChainMs - startChainMs) / 1000;
          if (chainElapsed >= MAX_VERIFY_CHAIN_SECONDS) return false;
          const floored = Math.floor(chainElapsed);
          if (floored > lastPrintedElapsed) {
            console.log(`   Awaiting unpublish finalization [verifyEffect] (chain time +${floored}s / ${MAX_VERIFY_CHAIN_SECONDS}s)...`);
            lastPrintedElapsed = floored;
          }
          await new Promise((r) => setTimeout(r, UNPUBLISH_POLL_INTERVAL_MS));
        }
      };

      try {
        const txRes = await this.contractTransaction(publisher, 0n, PUBLISHER_ABI, "unpublish", [label], (s) => console.log(`      ${s}`), { useNoncePolling: true, verifyEffect });
        // Final read-back catches a rare post-finality reorg or nonce-advance false-positive.
        const finalPublished = await withTimeout(
          this.contractCall(publisher, PUBLISHER_ABI, "isPublished", [labelhash]),
          30000,
          "isPublished",
        );
        if (finalPublished === true) {
          throw new Error(
            `Post-unpublish verification failed for ${label}.dot: isPublished still returned true after the unpublish tx. ` +
            `The unpublish tx may have silently failed via nonce-advance, or another party re-published the label. Re-run to retry.`,
          );
        }
        logTxResolution(txRes);
        const txHash = txRes.kind === TX_KIND_HASH ? txRes.hash : TX_KIND_NONCE_ADVANCED;
        return { status: "unpublished" as const, txHash };
      } catch (e: any) {
        const decoded = decodePublisherRevert(e);
        if (decoded?.name) throw new Error(`Publisher.unpublish reverted: ${decoded.name}${decoded.args ? `(${decoded.args.join(", ")})` : ""}`);
        throw e;
      }
    });
  }

  async getContenthash(domainName: string): Promise<string> {
    this.ensureConnected();
    const node = namehash(`${domainName}.dot`);
    const result = await withTimeout(
      this.contractCall(this._contracts.DOTNS_CONTENT_RESOLVER, DOTNS_CONTENT_RESOLVER_ABI, "contenthash", [node]),
      30000,
      "contenthash",
    );
    return typeof result === "string" ? result : result?.toString?.() ?? String(result);
  }

  async classifyName(label: string): Promise<{ requiredStatus: number; message: string }> {
    this.ensureConnected();
    console.log(`\n   Classifying name via PopOracle...`);
    const result = await withTimeout(this.contractCall(this._contracts.POP_RULES, POP_RULES_ABI, "classifyName", [label]), 30000, "classifyName");
    const requiredStatus = typeof result[0] === "bigint" ? Number(result[0]) : result[0];
    const message = result[1];
    console.log(`   Required status: ${popStatusName(requiredStatus)}`);
    console.log(`   Message: ${message}`);
    return { requiredStatus, message };
  }

  async ensureNotRegistered(label: string): Promise<void> {
    this.ensureConnected();
    console.log(`\n   Checking availability of ${label}.dot...`);
    const tokenId = computeDomainTokenId(label);
    try {
      const owner = await withTimeout(this.contractCall(this._contracts.DOTNS_REGISTRAR, DOTNS_REGISTRAR_ABI, "ownerOf", [tokenId]), 30000, "Availability check");
      if (owner !== zeroAddress) throw new Error(`Domain ${label}.dot already owned by ${owner}`);
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("already owned")) throw error;
    }
    console.log(`   ${label}.dot is available`);
  }

  async generateCommitment(label: string, includeReverse: boolean = false): Promise<{ commitment: any; registration: any }> {
    this.ensureConnected();
    console.log(`\n   Generating commitment hash...`);
    label = validateDomainLabel(label);
    const secret = `0x${crypto.randomBytes(32).toString("hex")}`;
    const registration = { label, owner: this.evmAddress, secret, reserved: includeReverse };
    const commitment = await withTimeout(this.contractCall(this._contracts.DOTNS_REGISTRAR_CONTROLLER, DOTNS_REGISTRAR_CONTROLLER_ABI, "makeCommitment", [registration]), 30000, "Commitment generation");
    console.log(`   Commitment: ${commitment}`);
    return { commitment, registration };
  }

  async submitCommitment(commitment: any): Promise<void> {
    this.ensureConnected();
    console.log(`\n   Submitting commitment...`);
    const commitTxRes = await this.contractTransaction(this._contracts.DOTNS_REGISTRAR_CONTROLLER, 0n, DOTNS_REGISTRAR_CONTROLLER_ABI, "commit", [commitment], (s) => console.log(`      ${s}`), { phoneLabel: "Commitment" });
    logTxResolution(commitTxRes);
    console.log(`   Committed at: ${new Date().toISOString()}`);
  }

  async waitForCommitmentAge(commitment: any): Promise<void> {
    this.ensureConnected();
    const POLL_TIMEOUT_MS = 90_000;
    const POLL_INTERVAL_MS = 3_000;

    console.log(`\n   Reading minimum commitment age...`);
    const [minimumAge, maximumAge, initialCommitTimestamp] = await Promise.all([
      withTimeout(this.contractCall(this._contracts.DOTNS_REGISTRAR_CONTROLLER, DOTNS_REGISTRAR_CONTROLLER_ABI, "minCommitmentAge", []), 30000, "minCommitmentAge"),
      withTimeout(this.contractCall(this._contracts.DOTNS_REGISTRAR_CONTROLLER, DOTNS_REGISTRAR_CONTROLLER_ABI, "maxCommitmentAge", []), 30000, "maxCommitmentAge"),
      withTimeout(this.contractCall(this._contracts.DOTNS_REGISTRAR_CONTROLLER, DOTNS_REGISTRAR_CONTROLLER_ABI, "commitments", [commitment]), 30000, "commitments"),
    ]);

    const minimumAgeSeconds = typeof minimumAge === "bigint" ? Number(minimumAge) : minimumAge;
    const maximumAgeSeconds = typeof maximumAge === "bigint" ? Number(maximumAge) : (maximumAge ?? 86400);
    const commitTimestamp = typeof initialCommitTimestamp === "bigint" ? Number(initialCommitTimestamp) : initialCommitTimestamp;

    if (commitTimestamp === 0) {
      throw new Error("Commitment not found on-chain. It may not have been included in a block yet.");
    }

    console.log(`   Minimum commitment age: ${minimumAgeSeconds}s, maximum: ${maximumAgeSeconds}s`);
    console.log(`   Commitment valid window: ${commitTimestamp + minimumAgeSeconds} – ${commitTimestamp + maximumAgeSeconds}`);
    console.log(`   Commitment stored on-chain (timestamp: ${commitTimestamp})`);
    console.log(`   Waiting for on-chain block.timestamp > ${commitTimestamp + minimumAgeSeconds} (timeout ${POLL_TIMEOUT_MS / 1000}s)`);

    const pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < pollDeadline) {
      const nowMs = await this.clientWrapper!.client.query.Timestamp.Now.getValue();
      const chainNowSeconds = Math.floor(Number(nowMs) / 1000);
      if (isCommitmentMature(chainNowSeconds, commitTimestamp, minimumAgeSeconds)) {
        console.log(`   Commitment age requirement met (chain.now=${chainNowSeconds}, target>${commitTimestamp + minimumAgeSeconds})`);
        console.log(`   Buffering ${POLL_INTERVAL_MS / 1000}s for block propagation (guard against node lag after maturity)...`);
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        // Re-read chain time after the buffer sleep for an accurate expiry check.
        const nowAfterBuffer = Math.floor(Number(await this.clientWrapper!.client.query.Timestamp.Now.getValue()) / 1000);
        const expiresAt = commitTimestamp + maximumAgeSeconds;
        const remainingSecs = expiresAt - nowAfterBuffer;
        if (remainingSecs <= 0) {
          throw new Error(`Commitment has expired (chain.now=${nowAfterBuffer}, expired at=${expiresAt}). A fresh commit cycle is needed.`);
        }
        if (remainingSecs < 30) {
          console.log(`   Warning: commitment expires in ${remainingSecs}s — proceeding immediately.`);
        }

        return;
      }
      const chainSecondsToTarget = Math.max(0, (commitTimestamp + minimumAgeSeconds) - chainNowSeconds);
      console.log(`   Chain time ${chainNowSeconds} — need +${chainSecondsToTarget}s more chain progress`);
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Commitment still too new after ${POLL_TIMEOUT_MS / 1000}s of polling chain time. The chain may be stalled.`);
  }

  async getPriceAndValidate(label: string): Promise<PriceValidationResult> {
    this.ensureConnected();
    console.log(`\n   Checking price and eligibility...`);
    label = validateDomainLabel(label);
    const baseName = stripTrailingDigits(label);
    const reservationInfo = await withTimeout(this.contractCall(this._contracts.POP_RULES, POP_RULES_ABI, "isBaseNameReserved", [baseName]), 30000, "isBaseNameReserved");
    const [isReserved, reservationOwner] = reservationInfo;
    if (isReserved && reservationOwner.toLowerCase() !== this.evmAddress!.toLowerCase()) throw new Error("Base name reserved for original Lite registrant");
    const { requiredStatus, message } = await this.classifyName(label);
    const userStatus = await this.getUserPopStatus();
    if (requiredStatus === ProofOfPersonhoodStatus.Reserved) throw new Error(message);
    // Eligibility decision lives in one place (canRegister, mirrors PopRules.priceWithCheck):
    // NoStatus names are open to any tier; only Full/Lite-required names gate. The on-chain
    // priceWithCheck call below is authoritative — this is an early, friendlier pre-check.
    if (!canRegister(requiredStatus, userStatus)) {
      throw new Error(
        requiredStatus === ProofOfPersonhoodStatus.ProofOfPersonhoodFull
          ? "Requires Full Personhood verification"
          : "Requires Personhood Lite verification",
      );
    }
    const priceMeta = await withTimeout(this.contractCall(this._contracts.POP_RULES, POP_RULES_ABI, "priceWithCheck", [label, this.evmAddress!]), 30000, "priceWithCheck");
    const priceRaw = (priceMeta as any)?.price;
    if (priceRaw == null) {
      throw new Error(
        `priceWithCheck returned unexpected shape (expected object with .price): ` +
        JSON.stringify(priceMeta, (_, v) => typeof v === "bigint" ? v.toString() : v)
      );
    }
    const priceWei = typeof priceRaw === "bigint" ? priceRaw : BigInt(priceRaw);
    // Required status was already printed by classifyName() above; only the new
    // facts (the signer's own status + the resolved price) need printing here.
    console.log(`   User status: ${popStatusName(userStatus)}`);
    console.log(`   Price: ${formatEther(priceWei)} PAS`);
    return { priceWei, requiredStatus, userStatus, message };
  }

  async finalizeRegistration(registration: any, priceWei: bigint): Promise<void> {
    this.ensureConnected();
    console.log(`\n   Finalizing registration for ${registration.label}.dot...`);
    const bufferedPaymentWei = (priceWei * 110n) / 100n;
    const bufferedPaymentNative = bufferedPaymentWei / this._nativeToEthRatio;
    if (priceWei > 0n && bufferedPaymentNative === 0n) {
      throw new Error(
        `Payment conversion underflow: priceWei=${priceWei} rounds to 0 native units ` +
        `(nativeToEthRatio=${this._nativeToEthRatio}). Cannot call register with zero payment.`
      );
    }
    setDeployAttribute("deploy.payment_wei", priceWei.toString());
    console.log(`   Oracle price: ${formatEther(priceWei)} PAS`);
    console.log(`   Paying: ${formatEther(bufferedPaymentWei)} PAS`);
    const registerTxRes = await this.contractTransaction(this._contracts.DOTNS_REGISTRAR_CONTROLLER, bufferedPaymentNative, DOTNS_REGISTRAR_CONTROLLER_ABI, "register", [registration], (s) => console.log(`      ${s}`), { phoneLabel: "Register" });
    logTxResolution(registerTxRes);
    if (registerTxRes.kind === TX_KIND_HASH) {
      setDeployAttribute("deploy.register.tx", registerTxRes.hash);
      if (registerTxRes.block) {
        setDeployAttribute("deploy.register.block", String(registerTxRes.block.number));
        setDeployAttribute("deploy.register.block_hash", registerTxRes.block.hash);
        console.log(`      finalised @ block ${registerTxRes.block.number} (tx ${registerTxRes.hash})`);
      } else {
        console.log(`      finalised (tx ${registerTxRes.hash})`);
      }
    }
  }

  async verifyOwnership(label: string): Promise<void> {
    this.ensureConnected();
    console.log(`\n   Verifying ownership...`);
    const tokenId = computeDomainTokenId(label);
    const actualOwner = await withTimeout(this.contractCall(this._contracts.DOTNS_REGISTRAR, DOTNS_REGISTRAR_ABI, "ownerOf", [tokenId]), 30000, "ownerOf");
    if (actualOwner.toLowerCase() !== this.evmAddress!.toLowerCase()) {
      console.log(`   Expected: ${this.evmAddress}`);
      console.log(`   Actual: ${actualOwner}`);
      throw new Error(`Owner mismatch for ${label}.dot`);
    }
    console.log(`   Owner: ${actualOwner}`);
  }

  // View-only readiness check. Runs every chain read needed to predict whether
  // `register(label)` will succeed, so the caller can fail-fast BEFORE the
  // Bulletin chunk upload. Never writes to chain. See issue #100.
  async preflight(label: string, opts: { transferRecipientH160?: string } = {}): Promise<DotnsPreflightResult> {
    return this._preflightInternal(label, false, opts.transferRecipientH160);
  }

  private async _preflightInternal(label: string, reproveAttempted: boolean, transferRecipientH160?: string): Promise<DotnsPreflightResult> {
    return withSpan("deploy.dotns.preflight", `preflight ${label}.dot`, {}, async () => {
      // Seed auto-reprove telemetry for every span, including ones that never
      // reach the stale-alias branch (boolean-both-values rule).
      setDeployAttribute("deploy.dotns.reprove.auto", "false");

      this.ensureConnected();
      const validated = validateDomainLabel(label);
      const trailingDigits = countTrailingDigits(validated);
      const baselength = validated.length - trailingDigits;
      const classification = classifyDotnsLabel(validated);

      // Reserved is a terminal rejection — no chain reads needed.
      if (classification.status === ProofOfPersonhoodStatus.Reserved) {
        const sanitizeTrail = label !== validated
          ? `Input "${label}" was sanitized to "${validated}" (excess trailing digits trimmed). `
          : "";
        return {
          label: validated, classification, userStatus: 0, trailingDigits, baselength,
          isAvailable: false, existingOwner: null, isBaseNameReserved: false, reservationOwner: null,
          isTestnet: false, canProceed: false,
          reason: `${sanitizeTrail}${classification.message}`,
          plannedAction: "abort", needsPopUpgrade: false,
        };
      }

      const baseName = stripTrailingDigits(validated);
      const [userStatus, baseReservation, ownership, isTestnet, signerFreeBalance] = await Promise.all([
        this.getUserPopStatus(),
        withTimeout(this.contractCall(this._contracts.POP_RULES, POP_RULES_ABI, "isBaseNameReserved", [baseName]), 30000, "isBaseNameReserved") as Promise<[boolean, string, bigint]>,
        this.checkOwnership(validated),
        this.isTestnet(),
        this.readFreeBalance(this.substrateAddress!),
      ]);

      const [isReserved, reservationOwnerRaw] = baseReservation;
      const reservationOwner = isReserved ? reservationOwnerRaw.toLowerCase() : null;
      const ownerRaw = ownership.owner?.toLowerCase() ?? null;
      const existingOwner = ownerRaw && ownerRaw !== zeroAddress ? ownerRaw : null;
      const selfAddress = this.evmAddress!.toLowerCase();

      // Domain owned by the transfer recipient (issue #893): the worker can't
      // update its content — only the owner is authorised. Signal the caller to
      // re-acquire the session signer (one phone tap) and sign setContenthash
      // directly as the owner. No register, no transfer needed.
      if (transferRecipientH160 && existingOwner !== null && existingOwner === transferRecipientH160.toLowerCase()) {
        return {
          label: validated, classification, userStatus, trailingDigits, baselength,
          isAvailable: false, existingOwner, isBaseNameReserved: isReserved, reservationOwner,
          isTestnet, canProceed: true, plannedAction: "already-owned-by-recipient",
          needsPopUpgrade: false, signerFreeBalance,
        };
      }

      // Domain owned by someone else — terminal rejection.
      if (existingOwner !== null && existingOwner !== selfAddress) {
        return {
          label: validated, classification, userStatus, trailingDigits, baselength,
          isAvailable: false, existingOwner, isBaseNameReserved: isReserved, reservationOwner,
          isTestnet, canProceed: false,
          reason: `Domain ${validated}.dot is already owned by ${existingOwner}.`,
          plannedAction: "abort", needsPopUpgrade: false, signerFreeBalance,
        };
      }

      // Quote the transfer fee ONCE when a recipient is supplied (no-op otherwise).
      let transferFeeNative = 0n;
      if (transferRecipientH160) {
        try {
          ({ feeNative: transferFeeNative } = await this.quoteTransferFloorNative(validated, this.evmAddress!, transferRecipientH160));
        } catch { /* fee quote failure must not block preflight; gate uses 0 */ }
      }

      // Domain already owned by US — skip commit-register, go straight to setContenthash.
      if (existingOwner !== null && existingOwner === selfAddress) {
        return await this.gateOnFeeBalance({
          label: validated, classification, userStatus, trailingDigits, baselength,
          isAvailable: true, existingOwner, isBaseNameReserved: isReserved, reservationOwner,
          isTestnet, canProceed: true, plannedAction: "already-owned-by-us", needsPopUpgrade: false,
        }, signerFreeBalance, isTestnet, transferFeeNative);
      }

      // Base name locked by a different Lite registrant — terminal rejection.
      if (isReserved && reservationOwner !== selfAddress) {
        return {
          label: validated, classification, userStatus, trailingDigits, baselength,
          isAvailable: true, existingOwner: null, isBaseNameReserved: true, reservationOwner,
          isTestnet, canProceed: false,
          reason: `Base name ${baseName} is reserved for ${reservationOwner}.`,
          plannedAction: "abort", needsPopUpgrade: false, signerFreeBalance,
        };
      }

      const targetPopStatus = userStatus;

      if (!canRegister(classification.status, userStatus)) {
        // When the signer has NoStatus and the env supports the personhood bootstrap
        // flow, classify the AliasAccounts state and give actionable advice.
        if (
          userStatus === ProofOfPersonhoodStatus.NoStatus &&
          isTestnet &&
          this._popSelfServe?.stateAwareGuidance === true &&
          this.substrateAddress
        ) {
          const aliasState = await this.classifyAliasAccountState(this.substrateAddress);

          // Auto-reprove path: testnet + local mnemonic + stale alias + not already retried.
          if (
            aliasState.state === "bound-likely-stale" &&
            !this._usesExternalSigner &&
            this._localMnemonic &&
            !reproveAttempted
          ) {
            const minBalance = REPROVE_FEE_ESTIMATE * REPROVE_FEE_SAFETY_MARGIN_PCT / 100n;
            const symbol = resolveNativeTokenSymbol(this._environmentId);
            if (signerFreeBalance < minBalance) {
              setDeployAttribute("deploy.dotns.reprove.auto", "true");
              setDeployAttribute("deploy.dotns.reprove.outcome", "insufficient_funds");
              return {
                label: validated, classification, userStatus, trailingDigits, baselength,
                isAvailable: true, existingOwner: null, isBaseNameReserved: isReserved, reservationOwner,
                isTestnet, canProceed: false,
                reason: `Cannot auto-refresh: signer balance ${fmtPas(signerFreeBalance)} ${symbol} < estimated fee ${fmtPas(REPROVE_FEE_ESTIMATE)} ${symbol}. Top up via the testnet faucet or run \`tools/reprove-alias.mjs --mnemonic <your-mnemonic> --env ${this._environmentId}\` manually.`,
                plannedAction: "abort", needsPopUpgrade: false, targetPopStatus, signerFreeBalance,
              };
            }

            console.log(`   Personhood: alias revision stale (stored=${aliasState.revision ?? "unknown"}) — refreshing on testnet`);
            console.log(`      Estimated fee: ${fmtPas(REPROVE_FEE_ESTIMATE)} ${symbol} (signer balance: ${fmtPas(signerFreeBalance)} ${symbol})`);

            setDeployAttribute("deploy.dotns.reprove.auto", "true");
            let reproveSucceeded = false;
            try {
              console.log(`      Submitting reprove_alias_account…`);
              const reproveResult = await this.reprove(this._localMnemonic);
              console.log(`      Refresh complete (revision ${reproveResult.oldRevision} → ${reproveResult.newRevision}, block ${reproveResult.blockHash})`);
              setDeployAttribute("deploy.dotns.reprove.outcome", "success");
              setDeployAttribute("deploy.dotns.reprove.old_revision", String(reproveResult.oldRevision));
              setDeployAttribute("deploy.dotns.reprove.new_revision", String(reproveResult.newRevision));
              reproveSucceeded = true;
            } catch (e: any) {
              const msg = e?.message ?? String(e);
              console.log(`      Auto-reprove failed: ${msg}`);
              setDeployAttribute("deploy.dotns.reprove.outcome", "failed_submission");
            }

            if (reproveSucceeded) {
              console.log(`   Continuing with registration of ${validated}.dot.`);
              return this._preflightInternal(label, true, transferRecipientH160);
            }
            // Fall through to manual remediation below.
          }

          const remediationMessage = formatPersonhoodRemediation(aliasState, this._popSelfServe, this._environmentId);
          const currentName = popStatusName(userStatus);
          const requiredName = popStatusName(classification.status);
          return {
            label: validated, classification, userStatus, trailingDigits, baselength,
            isAvailable: true, existingOwner: null, isBaseNameReserved: isReserved, reservationOwner,
            isTestnet, canProceed: false,
            reason: `${validated}.dot requires ${requiredName}, but this signer is ${currentName}. ${remediationMessage}`,
            plannedAction: "abort", needsPopUpgrade: false, targetPopStatus, signerFreeBalance,
          };
        }
        const currentName = popStatusName(userStatus);
        const requiredName = popStatusName(classification.status);
        return {
          label: validated, classification, userStatus, trailingDigits, baselength,
          isAvailable: true, existingOwner: null, isBaseNameReserved: isReserved, reservationOwner,
          isTestnet, canProceed: false,
          reason: formatPopShortfallReason({
            label: validated, requiredName, currentName,
            isTestnet, environmentId: this._environmentId, popSelfServe: this._popSelfServe,
            aliasState: null,
            exampleNoStatusLabel: exampleNoStatusLabel(validated),
          }),
          plannedAction: "abort", needsPopUpgrade: false, targetPopStatus, signerFreeBalance,
        };
      }

      return await this.gateOnFeeBalance({
        label: validated, classification, userStatus, trailingDigits, baselength,
        isAvailable: true, existingOwner: null, isBaseNameReserved: isReserved, reservationOwner,
        isTestnet, canProceed: true, plannedAction: "register",
        needsPopUpgrade: false, targetPopStatus,
      }, signerFreeBalance, isTestnet, transferFeeNative);
    });
  }

  // Final preflight stage: check the DotNS signer can pay tx fees on the
  // connected fee chain (Asset Hub Paseo for testnet, Asset Hub Polkadot for
  // mainnet). On testnet, attempts a one-shot auto-top-up from the dev
  // phrase's Alice or Bob if the signer is short. Replaces the original
  // canProceed:true result with an actionable canProceed:false when even the
  // top-up can't get the signer above the threshold.
  private async gateOnFeeBalance(
    candidate: Omit<DotnsPreflightResult, "plannedAction"> & { canProceed: true; plannedAction: DotnsSuccessAction },
    signerFreeBalance: bigint,
    isTestnet: boolean,
    transferFeeNative = 0n,
  ): Promise<DotnsPreflightResult> {
    // Register deposit is tier-resolved and read live (issue #884): a verified
    // (Lite/Full) signer is charged 0; a NoStatus signer pays PopRules.startingPrice,
    // which is owner-updatable per env. Already-owned (setContenthash-only) and
    // verified-register paths add nothing here.
    let rentPriceNative = 0n;
    if (candidate.plannedAction === "register" && candidate.userStatus === ProofOfPersonhoodStatus.NoStatus) {
      const startingPriceWei = (await withTimeout(
        this.contractCall(this._contracts.POP_RULES, POP_RULES_ABI, "startingPrice", []),
        30000, "startingPrice",
      )) as bigint;
      rentPriceNative = bufferedWeiToNative(startingPriceWei, this._nativeToEthRatio);
    }
    const feeFloor = feeFloorFor(candidate.plannedAction, this._registerStorageDeposit, rentPriceNative, transferFeeNative);
    let effectiveBalance = signerFreeBalance;
    let toppedUp: { source: "Alice" | "Bob"; transferred: bigint } | undefined;

    if (effectiveBalance < feeFloor && isTestnet) {
      setDeployAttribute("deploy.dotns.signer_below_floor", "true");
      console.log(`   DotNS signer ${this.substrateAddress?.slice(0, 8)}... balance ${fmtPas(effectiveBalance)} PAS < ${fmtPas(feeFloor)} PAS floor — attempting testnet auto top-up...`);
      const result = await this.attemptTestnetTopUp(this.substrateAddress!, topUpTargetFor(candidate.plannedAction, this._registerStorageDeposit, rentPriceNative, transferFeeNative));
      if (result) {
        console.log(`   Topped up ${fmtPas(result.transferred)} PAS from ${result.source}`);
        // submitTransfer only resolves on event.ok, so the transferred amount
        // is guaranteed to land. The deploy signer is idle until preflight
        // returns, so no concurrent debit is possible — skip the re-read.
        effectiveBalance += result.transferred;
        toppedUp = result;
        setDeployAttribute("deploy.dotns.toppedup", "true");
        setDeployAttribute("deploy.dotns.toppedup_source", result.source);
      }
    } else if (effectiveBalance < feeFloor) {
      // Mainnet (or non-testnet) below-floor: still record the boolean so
      // dashboards can count the abort.
      setDeployAttribute("deploy.dotns.signer_below_floor", "true");
    }

    if (effectiveBalance < feeFloor) {
      const op = candidate.plannedAction === "already-owned-by-us" ? "setContenthash" : "register";
      const tail = isTestnet
        ? ` Testnet auto-top-up via Alice/Bob failed (both also low). Top up at ${PASEO_FAUCET_URL}.`
        : ` Top up the signer's balance and re-deploy.`;
      captureWarning("DotNS preflight balance gate: signer cannot pay fees", {
        signer: this.substrateAddress,
        free: effectiveBalance.toString(),
        floor: feeFloor.toString(),
        plannedAction: candidate.plannedAction,
        isTestnet: String(isTestnet),
        autoTopUpAttempted: String(isTestnet),
      });
      return {
        ...candidate,
        canProceed: false,
        plannedAction: "abort",
        reason: `DotNS signer ${this.substrateAddress} has ${fmtPas(effectiveBalance)} PAS free; needs ≥${fmtPas(feeFloor)} PAS for ${op}.${tail}`,
        signerFreeBalance: effectiveBalance,
        feeFloor,
      };
    }

    return { ...candidate, signerFreeBalance: effectiveBalance, feeFloor, toppedUp };
  }

  async register(
    label: string,
    options: DotNSConnectOptions & { status?: string; reverse?: boolean } = {},
  ): Promise<{ label: string; owner: string }> {
    return withSpan("deploy.dotns.register", `2a. register ${label}.dot`, {}, async () => {
      if (!this.connected) await this.connect(options);
      label = validateDomainLabel(label);

      const preClassification = classifyDotnsLabel(label);
      const preRequiredStatus = preClassification.status;

      if (preRequiredStatus === ProofOfPersonhoodStatus.Reserved) {
        throw new Error(preClassification.message);
      }

      const isTestnet = await this.isTestnet();
      // Pre-classify the alias state when the env supports state-aware guidance,
      // so rejectIneligible can provide state-tailored guidance without an extra async call inside the closure.
      const registerAliasState: AliasAccountClassification | null =
        isTestnet && this._popSelfServe?.stateAwareGuidance === true && this.substrateAddress
          ? await this.classifyAliasAccountState(this.substrateAddress)
          : null;
      const rejectIneligible = (statusRequired: number, userStatus: number): never => {
        throw new Error(
          formatPopShortfallReason({
            label, requiredName: popStatusName(statusRequired), currentName: popStatusName(userStatus),
            isTestnet, environmentId: this._environmentId, popSelfServe: this._popSelfServe,
            aliasState: registerAliasState,
            exampleNoStatusLabel: exampleNoStatusLabel(label),
          })
        );
      };

      const reverse = options.reverse ?? (process.env.DOTNS_REVERSE ?? "false").toLowerCase() === "true";

      const [classification] = await Promise.all([
        this.classifyName(label),
        this.ensureNotRegistered(label),
      ]);

      const requiredStatus = classification.requiredStatus;
      if (requiredStatus === ProofOfPersonhoodStatus.Reserved) {
        throw new Error(classification.message);
      }

      const userStatus = await this.getUserPopStatus();

      if (!canRegister(requiredStatus, userStatus)) {
        rejectIneligible(requiredStatus, userStatus);
      }

      const doCommitAndRegister = async (): Promise<void> => {
        const { commitment, registration } = await this.generateCommitment(label, reverse);
        await withSpan("deploy.dotns.submit-commitment", "2a-i. submit-commitment", {}, () => this.submitCommitment(commitment));
        await withSpan("deploy.dotns.wait-commitment-age", "2a-ii. wait-commitment-age", {}, () => this.waitForCommitmentAge(commitment));
        const pricing = await withSpan("deploy.dotns.price-validation", "2a-iii. price-validation", {}, () => this.getPriceAndValidate(label));
        await withSpan("deploy.dotns.finalize-registration", "2a-iv. finalize-registration", {}, () => this.finalizeRegistration(registration, pricing.priceWei));
      };

      try {
        await doCommitAndRegister();
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!isCommitmentTimingBarerevert(msg)) throw err;
        // Commitment timing race: the register dry-run saw a block where the
        // commitment was still too new (node lag) or had just expired. Generate
        // a fresh commitment (new secret, new on-chain entry) and retry once.
        // Bounded to one attempt so a real double-revert (label collision, PoP
        // status mismatch) fails after two tries, not N.
        console.log(`\n   Register bare-reverted (commitment timing race — node saw a block where commitment was too new or expired).`);
        console.log(`   Retrying with a fresh commitment. This usually resolves in one block.\n`);
        await doCommitAndRegister();
      }

      await this.verifyOwnership(label);
      console.log(`\n   Registration complete!`);
      return { label, owner: this.evmAddress! };
    });
  }

  /**
   * Reprove a stale DotNS alias binding.
   * Opens a People-chain client internally, builds the ring proof, and submits
   * reprove_alias_account on AH. Use when the alias exists but the ring root
   * has advanced past the stored revision.
   *
   * Requires a mnemonic — the DotNS instance must have been connected with one.
   */
  async reprove(mnemonic: string): Promise<{ oldRevision: number; newRevision: number; blockHash: string }> {
    this.ensureConnected();
    if (!this.substrateAddress || !this.signer) {
      throw new Error("reprove: DotNS must be connected with a signer");
    }
    const envId = this._environmentId ?? "paseo-next-v2";

    // Import lazily to avoid pulling verifiablejs into the main bundle for
    // callers who never use the bootstrap/reprove path.
    const { connectPeopleClient } = await import("./personhood/people-client.js");
    const { reproveAliasToAccount } = await import("./personhood/reprove.js");
    const { deriveMemberEntropy, deriveMemberKey } = await import("./personhood/member-key.js");
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — verifiablejs/nodejs DTS path differs from the types field
    const verifiable = await import("verifiablejs/nodejs") as typeof import("verifiablejs/nodejs");

    const memberEntropy = deriveMemberEntropy(mnemonic);
    const memberKey = deriveMemberKey(mnemonic);

    const peopleConn = await connectPeopleClient(envId);
    try {
      const result = await reproveAliasToAccount({
        peopleUnsafeApi: peopleConn.unsafeApi,
        ahUnsafeApi: this.clientWrapper!.client,
        account: this.substrateAddress as any,
        memberKey,
        signCall: this.signer,
        buildRingProof: async ({ ringExponent, members, context, msg }) => {
          const r = verifiable.one_shot(ringExponent, memberEntropy, members, context, msg);
          return { proof: r.proof, alias: r.alias };
        },
      });
      return result;
    } catch (e: any) {
      if (this._reproveFallbackForTest && typeof e?.message === "string" && e.message.includes("not strictly greater than stored")) {
        const fb = this._reproveFallbackForTest;
        this._reproveFallbackForTest = null;
        return fb;
      }
      throw e;
    } finally {
      peopleConn.disconnect();
    }
  }

  /**
   * Run the personhood bootstrap flow for this DotNS signer.
   * Idempotent: each step is gated on chain state being "still needs doing".
   * Does NOT auto-run from preflight — call explicitly.
   *
   * Throws RecognizeRequiredError if the account hasn't been recognized by the
   * personhood faucet.
   */
  async bootstrap(mnemonic: string): Promise<import("./personhood/bootstrap.js").BootstrapResult> {
    const { runBootstrap } = await import("./personhood/bootstrap.js");
    const envId = this._environmentId ?? "paseo-next-v2";
    return runBootstrap({ mnemonic, environmentId: envId });
  }

  /**
   * Set the expected total number of phone signatures for this DotNS session.
   * Called from deploy() at preflight after computePhoneSigningSteps so that
   * confirmPhoneReady receives the correct `total`.
   */
  setPhoneSignatureTotal(total: number): void {
    this._phoneSignatureTotal = total;
  }

  /**
   * Internal: await the human-ready gate then fire the "check your phone"
   * notification. Must be called OUTSIDE any withTimeout — the human wait is
   * unbounded and must never be inside the machine timeout.
   *
   * Behaviour:
   * - confirmPhoneReady provided → await it (counts re-signs via attempt map).
   * - not provided + non-TTY → fail fast (NonRetryableError).
   * - not provided + TTY → no-op (bin must have supplied the hook; if it did
   *   not, the caller proceeds without a gate — backward-compat for library
   *   consumers that supply neither hook nor TTY check).
   * After the gate resolves, fires onPhoneSigningRequired (the "check your
   * phone" notification) so the user knows the request is now being sent.
   */
  private async _awaitPhoneReady(label: string): Promise<void> {
    if (!this._usesExternalSigner) return; // only phone signers need the gate
    const attempt = (this._phoneSignatureAttempts.get(label) ?? 0) + 1;
    this._phoneSignatureAttempts.set(label, attempt);
    if (this._confirmPhoneReady) {
      await this._confirmPhoneReady({ label, attempt, total: this._phoneSignatureTotal });
    } else if (!(process.stdout.isTTY && process.stdin.isTTY)) {
      throw new NonRetryableError(
        "phone signer active but no confirmPhoneReady hook provided and not running in a TTY — " +
        "re-run interactively or provide the confirmPhoneReady option",
      );
    }
    // TTY + no hook → proceed; bin always supplies the hook for the CLI path.
    // Fire "check your phone" notification AFTER gate resolves, immediately
    // before the chain request goes out.
    this._onPhoneSigningRequired?.(label);
  }

  disconnect(): void {
    if (this.client) { this.client.destroy(); this.client = null; this.clientWrapper = null; this.connected = false; }
    this._usesExternalSigner = false;
    this._onPhoneSigningRequired = undefined;
    this._confirmPhoneReady = undefined;
    this._phoneSignatureTotal = 0;
    this._phoneSignatureAttempts.clear();
  }
}

export const dotns: DotNS = new DotNS();
