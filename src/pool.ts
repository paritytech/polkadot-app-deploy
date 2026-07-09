import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { createClient, Enum } from "polkadot-api";
import type { PolkadotSigner } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { getWsProvider } from "polkadot-api/ws";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

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
  bytes: bigint;
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

const TOPUP_TRANSACTIONS = 1000;
const TOPUP_BYTES = 100_000_000n; // 100MB
const WS_HEARTBEAT_TIMEOUT_MS = 300_000;

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

// Checks whether the given authorization is sufficient for the intended use.
// Returns true when `auth` exists and has not expired relative to `currentBlock`.
export function isAuthorizationSufficient(
  auth: any,
  currentBlock: number,
): boolean {
  if (auth === undefined) return false;
  if (Number(auth.expiration ?? 0) <= currentBlock) return false;
  return true;
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
// never run on mainnet. `bulletinAutoAuthorize` is the existing
// environments.json flag that already gates //Alice-based auto-authorize in
// ensureAuthorized() below — reusing it here keeps one source of truth. The
// `network !== "mainnet"` check is a deliberate second gate on top of the
// flag (not redundant with it): it survives a future config mistake where
// `bulletinAutoAuthorize: true` gets set on a mainnet entry, mirroring the
// "even if the flag were set by mistake, the dispatch is rejected" fail-safe
// documented on ensureAuthorized's opts.autoAuthorize path.
export function isAutoReauthorizeAllowed(env: AutoReauthorizeEnv | null | undefined): boolean {
  return env?.network !== "mainnet" && env?.bulletinAutoAuthorize === true;
}

export interface SelectionResult {
  account: PoolAuthorization;
  eligibleCount: number;
}

export function selectAccount(authorizations: PoolAuthorization[], random: () => number = Math.random, pinnedIndex?: number): SelectionResult {
  // Uniform random selection over all accounts. ensureAuthorized() tops up the
  // selected account immediately after this returns, so neither expired auths
  // nor low quota are filtering concerns — they self-heal on every selection.
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

export async function fetchPoolAuthorizations(api: any, accounts: PoolAccount[]): Promise<PoolAuthorization[]> {
  const results = await Promise.all(
    accounts.map(async (account): Promise<PoolAuthorization> => {
      try {
        const auth = await api.query.TransactionStorage.Authorizations.getValue(
          Enum("Account", account.address)
        );
        return {
          ...account,
          transactions: auth ? BigInt(auth.extent.transactions_allowance) - BigInt(auth.extent.transactions) : 0n,
          bytes: auth ? BigInt(auth.extent.bytes_allowance) - BigInt(auth.extent.bytes) : 0n,
          expiration: auth ? Number(auth.expiration) : 0,
        };
      } catch {
        return { ...account, transactions: 0n, bytes: 0n, expiration: 0 };
      }
    })
  );
  return results;
}

// Returns true when the chain spec name identifies a testnet where Alice has
// authorization authority. Mainnet Bulletin will not have //Alice as authorizer,
// so defensive Alice-based top-ups must be gated.
export function isTestnetSpecName(specName: string | undefined | null): boolean {
  if (!specName) return false;
  const s = specName.toLowerCase();
  // Polkadot-ecosystem testnets where //Alice has authorization authority.
  // Bulletin on Paseo reports spec_name "bulletin-westend" (as of 2026-04-17),
  // so match on the testnet qualifier, not the chain name itself.
  if (s.includes("paseo")) return true;
  if (/\b(westend|rococo)\b/.test(s)) return true;
  if (/\b(testnet|devnet)\b/.test(s)) return true;
  if (/-test$|-testnet$|-dev$/.test(s)) return true;
  return false;
}

let _testnetDetectionCache: boolean | null = null;

export async function detectTestnet(api: any): Promise<boolean> {
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

export async function ensureAuthorized(
  api: any,
  address: string,
  label?: string,
): Promise<void> {
  const [auth, currentBlock] = await Promise.all([
    api.query.TransactionStorage.Authorizations.getValue(Enum("Account", address)),
    api.query.System.Number.getValue(),
  ]);
  if (isAuthorizationSufficient(auth, currentBlock)) return;

  const isTestnet = await detectTestnet(api);
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
  const accounts = derivePoolAccounts(poolSize, poolMnemonic);

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
    const mb = (Number(a.bytes) / 1_000_000).toFixed(1);
    console.log(`  [${a.index}] ${a.address}  AUTHORIZED — ${a.transactions} txs / ${mb}MB remaining, expires @${a.expiration}`);
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
  const accounts = derivePoolAccounts(poolSize, mnemonic);

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
    } else {
      const isTestnet = await detectTestnet(api);
      if (isTestnet) {
        const alice = keyring.addFromUri("//Alice");
        authorizerSigner = getPolkadotSigner(alice.publicKey, "Sr25519", (data: Uint8Array) => alice.sign(data));
        console.log(`Testnet detected — defaulting to //Alice as authorizer (${alice.address})\n`);
      } else {
        console.log(
          "Authorization is needed but no authorizer key was provided.\n" +
          "Re-run with --authorizer \"<seed>\" to grant authorization.",
        );
        return;
      }
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
