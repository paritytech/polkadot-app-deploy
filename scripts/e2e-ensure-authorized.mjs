#!/usr/bin/env node
// scripts/e2e-ensure-authorized.mjs [--env <id>]
//
// E2E prerequisite check: v0.16.0-rc.2's gating matrix was 38 pass / 4 fail,
// and three of the four failures were ONE cause — Bulletin storage
// authorizations for E2E derivation-path signers had lapsed or had never
// been granted (//e2e-s9, //e2e-sgrandpa: LAPSED; //e2e-fresh-pool: never
// authorized because a maintainer provisioning tool's hardcoded signer list
// didn't include it). Two of the three presented exactly like this repo's
// documented flakes (retry-eligible `Invalid::Stale`) — a rerun would have
// failed again identically, because the real cause is an off-chain grant,
// not a chain hiccup.
//
// This script runs BEFORE the scenario matrix (wired as a prerequisites job
// in .github/workflows/e2e.yml) and makes every signer the matrix will use
// E2E-ready: Bulletin storage authorization + Asset Hub balance. Check-first,
// grant-only-if-needed, idempotent — safe to run on every pass.
//
// LIST DRIFT is the root cause this design targets directly: the account
// list below is DERIVED from .github/workflows/e2e.yml + test/e2e.test.js at
// run time (regex-scanned, job-scoped, matrix-template-aware — see
// deriveSignerAccountList), not hand-maintained. A new derivation-path or a
// new matrix value in either source file is picked up automatically the next
// time this script runs, with no second list to remember to update. A
// template that cannot be resolved (e.g. no matching matrix array) is a hard
// error, never a silent skip — that failure mode is exactly how
// //e2e-fresh-pool went unauthorized last time.
//
// This repo deliberately does NOT self-authorize during a deploy
// (src/pool.ts's ensureAuthorized only ever throws) — that stance is
// intentional and unchanged. This script is a separate, explicit,
// human-reviewed CI step, not a runtime code path.
//
// Testnet-only. Refuses to guess an authorizer key: an environment that does
// not declare `bulletinAuthorizer` in environments.json (e.g. devnet, which
// is community-operated) fails with an actionable message instead of an
// opaque on-chain rejection from a wrong guess — see #1213/env-authorizer-read
// and bootstrapPool's identical stance in src/pool.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { createClient, Enum } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { loadEnvironments, resolveEndpoints } from "../dist/environments.js";
import { readAccountAuthorization, isAuthorizationSufficient, assetHubTopUpAmount, formatPasBalance, TOPUP_TRANSACTIONS, TOPUP_BYTES } from "../dist/pool.js";
import { stripYamlCommentLines, extractJobBlocks } from "./lib/workflow-jobs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, "..");
export const E2E_YML_PATH = path.join(REPO_ROOT, ".github", "workflows", "e2e.yml");
export const E2E_TEST_PATH = path.join(REPO_ROOT, "test", "e2e.test.js");

// Well-known Substrate dev phrase — the same key every //deploy/N, //e2e-*,
// and Alice-root signer in this repo's E2E harness derives from (see
// test/e2e.test.js's ALICE_MNEMONIC and src/pool.ts's derivePoolAccounts).
// Public and intentionally so: not a secret, testnet-only.
export const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

// TOPUP_TRANSACTIONS / TOPUP_BYTES imported above from src/pool.ts (via
// dist/pool.js) — that's the same authorize_account quota src/pool.ts's own
// auto-reauthorize path grants, now shared instead of hand-copied here.
// Bulletin and Asset Hub both report tokenDecimals: 10 (see
// reference_paseo_ah_token_decimals_10 — a 1e12 divisor under-reports 100x).
export const ONE_PAS = 10_000_000_000n;
// Headroom above the register call's storage-deposit component (env's
// registerStorageDeposit — NOT the whole register cost) to also cover fees.
const DEFAULT_FUNDING_MARGIN = 20n * ONE_PAS;
const DEFAULT_FUNDING_FLOOR = 200n * ONE_PAS;
const WS_HEARTBEAT_TIMEOUT_MS = 300_000;
const DERIVATION_PATH_RE = /^\/\/[A-Za-z0-9/_-]+$/;

// ---------------------------------------------------------------------------
// Section 1 — derive the signer account list from e2e.yml + test/e2e.test.js.
// No hand-maintained list: everything below is parsed from the two files that
// actually decide which accounts the E2E matrix signs with.
// ---------------------------------------------------------------------------

// stripYamlCommentLines / extractJobBlocks now live in ./lib/workflow-jobs.mjs
// (imported above) — shared with test/test.js's jobBlock() helper so there is
// exactly one job-header regex, not two independently drifting copies. See
// that module's header for why this mattered (list-drift bug class).
//
// Does not strip inline trailing comments — none of the fields this script
// reads (derivation-path, poolIndex, matrix arrays) carry one anywhere in
// e2e.yml today (checked by hand); a future one would currently get
// swallowed into the value and fail validateDerivationPath's shape check or
// extractPoolIndicesFromJob's integer check, i.e. fail loud, not silent.

// Values from a `field: [a, b, c]` free-dimension matrix array anywhere in
// the job block (e.g. `signer: [pool, direct]`).
function extractBracketArrayValues(jobBlockText, field) {
  const values = [];
  const re = new RegExp(`\\b${field}:\\s*\\[([^\\]]*)\\]`, "g");
  let m;
  while ((m = re.exec(jobBlockText))) {
    for (const raw of m[1].split(",")) {
      const v = raw.trim().replace(/^["']|["']$/g, "");
      if (v) values.push(v);
    }
  }
  return values;
}

// Values of `field: value` inside `{ ... }` flow-map entries — matrix
// `include:` lists (e.g. `{ scenario: s1, signer: pool, poolIndex: 0 }`).
function extractFlowMapFieldValues(jobBlockText, field) {
  const values = [];
  const re = /\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(jobBlockText))) {
    const fieldRe = new RegExp(`(?:^|,)\\s*${field}\\s*:\\s*([^,}]+)`);
    const fm = m[1].match(fieldRe);
    if (fm) {
      const v = fm[1].trim().replace(/^["']|["']$/g, "");
      if (v) values.push(v);
    }
  }
  return values;
}

// Resolves the values a `${{ matrix.<field> }}` template can take within one
// job, checking BOTH matrix shapes this workflow uses (free-dimension arrays
// and `include:` flow-map lists). Throws — never silently returns an empty
// set — when neither shape yields a value: a templated derivation-path that
// resolves to zero accounts is exactly the //e2e-fresh-pool bug this script
// exists to prevent, and a skip would reproduce it inside the fix.
export function resolveMatrixField(jobBlockText, jobName, field) {
  const values = [...new Set([
    ...extractBracketArrayValues(jobBlockText, field),
    ...extractFlowMapFieldValues(jobBlockText, field),
  ])];
  if (values.length === 0) {
    throw new Error(
      `e2e.yml job '${jobName}': found "\${{ matrix.${field} }}" in a derivation-path but no ` +
      `"${field}: [...]" array or "{ ..., ${field}: ... }" include entry to resolve it against in ` +
      `that job. Refusing to derive zero accounts from it — update the parser or the job.`,
    );
  }
  return values;
}

function validateDerivationPath(raw, jobName) {
  const v = raw.replace(/^["']|["']$/g, "").trim();
  if (!DERIVATION_PATH_RE.test(v)) {
    throw new Error(
      `e2e.yml job '${jobName}': derivation-path value "${raw}" does not look like a Substrate ` +
      `derivation path (expected //segment[/segment...]) — refusing to derive a signing key from it.`,
    );
  }
  return v;
}

// Every `derivation-path:` value in one job block, with `${{ matrix.X }}`
// templates expanded against that job's own matrix (see resolveMatrixField).
export function extractDerivationPathsFromJob(jobName, jobBlockText) {
  const paths = new Set();
  // Capture to end-of-line (not \S+): a "${{ matrix.signer }}" template
  // contains internal spaces, which \S+ would truncate at.
  const re = /derivation-path:\s*(\S.*)$/gm;
  let m;
  while ((m = re.exec(jobBlockText))) {
    const raw = m[1].trim();
    const tmpl = raw.match(/^(.*)\$\{\{\s*matrix\.(\w+)\s*\}\}(.*)$/);
    if (!tmpl) {
      paths.add(validateDerivationPath(raw, jobName));
      continue;
    }
    const [, prefix, field, suffix] = tmpl;
    for (const value of resolveMatrixField(jobBlockText, jobName, field)) {
      paths.add(validateDerivationPath(`${prefix}${value}${suffix}`, jobName));
    }
  }
  return paths;
}

// `poolIndex: N` pins (#863) — each names a distinct //deploy/N pool account.
// bin/polkadot-app-bootstrap's default pool size (10, //deploy/0..9) does NOT
// cover indices pinned above 9 (nightly-pr-coverage currently pins up to 11)
// — reading poolIndex straight from e2e.yml, rather than assuming a pool
// size, is what keeps this script in sync with the real matrix.
export function extractPoolIndicesFromJob(jobBlockText) {
  const indices = new Set();
  for (const raw of extractFlowMapFieldValues(jobBlockText, "poolIndex")) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`e2e.yml: poolIndex value "${raw}" is not a non-negative integer.`);
    }
    indices.add(n);
  }
  return indices;
}

// Literal "//e2e-..." derivation paths hand-maintained in test/e2e.test.js
// (ISOLATED_DIRECT_SIGNERS + the //e2e-direct default fallback). These are
// resolved INSIDE the test file at scenario-selection time, not passed
// through e2e.yml's matrix, so they can't be parsed out of the workflow —
// scanned separately here.
export function extractLiteralE2eSigners(testFileText) {
  const paths = new Set();
  const re = /["'](\/\/e2e-[A-Za-z0-9-]+)["']/g;
  let m;
  while ((m = re.exec(testFileText))) paths.add(m[1]);
  return paths;
}

// The full, order-stable list of E2E signer accounts the workflow + test
// harness actually use, derived from the two files' current content.
export function deriveSignerAccountList(e2eYmlText, e2eTestText) {
  const jobBlocks = extractJobBlocks(stripYamlCommentLines(e2eYmlText));
  const derivationPaths = new Set(extractLiteralE2eSigners(e2eTestText));
  const poolIndices = new Set();
  for (const [jobName, blockText] of jobBlocks) {
    for (const p of extractDerivationPathsFromJob(jobName, blockText)) derivationPaths.add(p);
    for (const i of extractPoolIndicesFromJob(blockText)) poolIndices.add(i);
  }
  const accounts = [];
  for (const p of [...derivationPaths].sort()) accounts.push({ label: p, path: p });
  for (const i of [...poolIndices].sort((a, b) => a - b)) accounts.push({ label: `//deploy/${i}`, path: `//deploy/${i}` });
  return accounts;
}

// ---------------------------------------------------------------------------
// Section 2 — environment guards. Pure functions over a ResolvedEndpoints-
// shaped object so both are independently unit-testable; both run BEFORE any
// chain connection is opened.
// ---------------------------------------------------------------------------

export function assertTestnet(resolved, envId) {
  if (resolved.network !== "testnet") {
    throw new Error(
      `refusing to run against '${envId}' (network=${resolved.network}) — this tool grants Bulletin ` +
      `storage authorizations and Asset Hub funding from well-known dev keys and is testnet-only by ` +
      `design, never mainnet.`,
    );
  }
}

export function requireBulletinAuthorizer(resolved, envId) {
  if (!resolved.bulletinAuthorizer) {
    throw new Error(
      `environment '${envId}' does not declare a bulletinAuthorizer in environments.json — likely ` +
      `community-operated (e.g. devnet), so the real authorizer key is unknown here. Refusing to ` +
      `guess: a wrong guess (e.g. defaulting to //Alice) produces an opaque on-chain rejection instead ` +
      `of this message (see #1213/env-authorizer-read, the same bug class this guard prevents). Add ` +
      `bulletinAuthorizer to this environment's entry once the real key is known, or run this against ` +
      `an environment that already declares one.`,
    );
  }
  return resolved.bulletinAuthorizer;
}

// ---------------------------------------------------------------------------
// Section 3 — check-first, grant-only-if-needed chain operations.
// ---------------------------------------------------------------------------

function deriveSignerKeypair(keyring, account) {
  return keyring.addFromUri(DEV_PHRASE + account.path);
}

// Shared check-first, grant-only-if-needed skeleton. checkAndGrantAuthorizations
// (Bulletin storage authorization) and checkAndFundAssetHub (Asset Hub balance)
// differ only in: which chain/key they run against (rpc/signerUri), any
// once-per-pass setup (prepare), the per-account check (checkFn), and the tx
// itself (actFn) — everything else (keyring + primary signer setup, opening
// one client for the whole pass, building each row, catching a failed
// action into { action: "FAILED", error }, destroying the client) was
// previously duplicated between the two. This file's own header argues
// against exactly that kind of copy for computeStorageDepositLimit; this
// factors it out instead of adding a second instance of the same drift risk.
//
// Writes stay SEQUENTIAL within this loop (never Promise.all across
// accounts within one pass) — a shared signer nonce would race otherwise,
// same #1054 rationale as ensurePoolAccountsFundedOnAssetHub in src/pool.ts.
//
//   prepare(api, primaryKey) -> ctx                      (optional, once per pass)
//   checkFn(api, key, account, ctx) -> { rowFields, needsAction, actionArgs }
//   actFn(api, key, account, ctx, actionArgs, primaryKey, primarySigner) -> Promise<string>
async function runCheckAndAct({ accounts, rpc, signerUri, prepare, checkFn, actFn }) {
  const keyring = new Keyring({ type: "sr25519" });
  const primaryKey = keyring.addFromUri(signerUri);
  const primarySigner = getPolkadotSigner(primaryKey.publicKey, "Sr25519", (d) => primaryKey.sign(d));

  const client = createClient(getWsProvider(rpc, { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS }));
  const api = client.getUnsafeApi();
  const results = [];
  try {
    const ctx = (await prepare?.(api, primaryKey)) ?? {};
    for (const account of accounts) {
      const key = deriveSignerKeypair(keyring, account);
      const { rowFields, needsAction, actionArgs } = await checkFn(api, key, account, ctx);
      const row = { label: account.label, address: key.address, ...rowFields, action: "none" };
      if (needsAction) {
        try {
          row.action = await actFn(api, key, account, ctx, actionArgs, primaryKey, primarySigner);
        } catch (e) {
          row.action = "FAILED";
          row.error = e?.message ?? String(e);
        }
      }
      results.push(row);
    }
  } finally {
    client.destroy();
  }
  return results;
}

async function checkAndGrantAuthorizations({ accounts, bulletinRpc, authorizerUri }) {
  return runCheckAndAct({
    accounts,
    rpc: bulletinRpc,
    signerUri: authorizerUri,
    prepare: async (api) => ({ currentBlock: Number(await api.query.System.Number.getValue()) }),
    checkFn: async (api, key, _account, ctx) => {
      const auth = await readAccountAuthorization(api, key.address);
      const sufficient = isAuthorizationSufficient(auth, ctx.currentBlock);
      return {
        rowFields: { before: sufficient ? "sufficient" : (auth ? "insufficient" : "absent") },
        needsAction: !sufficient,
      };
    },
    actFn: async (api, key, _account, _ctx, _actionArgs, _primaryKey, authorizerSigner) => {
      const tx = api.tx.TransactionStorage.authorize_account({
        who: key.address, transactions: TOPUP_TRANSACTIONS, bytes: TOPUP_BYTES,
      });
      const r = await tx.signAndSubmit(authorizerSigner);
      if (!r?.ok) throw new Error("dispatch was rejected");
      return "granted";
    },
  });
}

async function checkAndFundAssetHub({ accounts, assetHubRpc, funderUri, floorRaw, targetRaw }) {
  return runCheckAndAct({
    accounts,
    rpc: assetHubRpc,
    signerUri: funderUri,
    // Read the shared funder's own balance ONCE, then track it locally.
    // Sends within this loop are already sequential and each is checked
    // for r?.ok before the row is marked "topped up", so a confirmed
    // transfer's effect on the funder's balance is known without a fresh
    // chain read — matches src/pool.ts's ensurePoolAccountsFundedOnAssetHub,
    // which doesn't re-read the funder at all. Saves up to ~17 round trips
    // per run on a WS endpoint documented as timeout-prone under load.
    prepare: async (api, funderKey) => {
      const funderInfo = await api.query.System.Account.getValue(funderKey.address);
      return { funderFree: BigInt(funderInfo?.data?.free ?? 0n) };
    },
    checkFn: async (api, key, _account) => {
      const info = await api.query.System.Account.getValue(key.address);
      const free = BigInt(info?.data?.free ?? 0n);
      const topUp = assetHubTopUpAmount(free, floorRaw, targetRaw);
      return { rowFields: { freeBefore: free }, needsAction: topUp > 0n, actionArgs: { topUp } };
    },
    actFn: async (api, key, _account, ctx, { topUp }, funderKey, funderSigner) => {
      if (ctx.funderFree < topUp) {
        throw new Error(
          `funder ${funderKey.address} has only ${formatPasBalance(ctx.funderFree)} PAS, needs ` +
          `${formatPasBalance(topUp)} PAS — reporting rather than attempting a partial top-up`,
        );
      }
      const tx = api.tx.Balances.transfer_allow_death({ dest: Enum("Id", key.address), value: topUp });
      const r = await tx.signAndSubmit(funderSigner);
      if (!r?.ok) throw new Error("dispatch was rejected");
      ctx.funderFree -= topUp;
      return `topped up +${formatPasBalance(topUp)} PAS`;
    },
  });
}

// ---------------------------------------------------------------------------
// Section 4 — entry point.
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let envId = process.env.PAD_ENV || "paseo-next-v2";
  for (let i = 0; i < args.length; i++) if (args[i] === "--env") envId = args[++i];

  await cryptoWaitReady();

  const { doc } = await loadEnvironments();
  const resolved = resolveEndpoints(doc, envId);

  assertTestnet(resolved, envId);
  const authorizerUri = requireBulletinAuthorizer(resolved, envId);

  const e2eYmlText = fs.readFileSync(E2E_YML_PATH, "utf8");
  const e2eTestText = fs.readFileSync(E2E_TEST_PATH, "utf8");
  const accounts = deriveSignerAccountList(e2eYmlText, e2eTestText);

  console.log(`env=${envId} network=${resolved.network} authorizer=${authorizerUri}`);
  console.log(`Derived ${accounts.length} signer account(s) from e2e.yml + test/e2e.test.js:`);
  for (const a of accounts) console.log(`  ${a.label}`);

  const bulletinRpc = resolved.bulletin[0];
  const assetHubRpc = resolved.assetHub[0];
  const floorRaw = resolved.registerStorageDeposit ?? DEFAULT_FUNDING_FLOOR;
  const targetRaw = floorRaw + DEFAULT_FUNDING_MARGIN;

  console.log(`\n== Bulletin storage authorization (${bulletinRpc}) ==`);
  console.log(`== Asset Hub balance >= funding floor (${assetHubRpc}) ==`);
  console.log(`   floor=${formatPasBalance(floorRaw)} PAS target=${formatPasBalance(targetRaw)} PAS`);

  // Bulletin (signed by the env authorizer) and Asset Hub (signed by the dev
  // phrase) are different chains with different signer keys — no shared
  // nonce, no data dependency between the two passes — so they run
  // concurrently instead of one after the other, roughly halving this
  // gating job's wall clock. Writes stay sequential WITHIN each pass
  // (unchanged, see runCheckAndAct) — only the two passes overlap.
  // allSettled (not all): a crash in one pass must not swallow the other
  // pass's already-computed per-account results.
  const [authSettled, fundSettled] = await Promise.allSettled([
    checkAndGrantAuthorizations({ accounts, bulletinRpc, authorizerUri }),
    checkAndFundAssetHub({ accounts, assetHubRpc, funderUri: DEV_PHRASE, floorRaw, targetRaw }),
  ]);
  const authResults = authSettled.status === "fulfilled" ? authSettled.value : [];
  const fundResults = fundSettled.status === "fulfilled" ? fundSettled.value : [];

  console.log(`\n-- Bulletin storage authorization results --`);
  for (const r of authResults) {
    const suffix = r.action !== "none" ? ` -> ${r.action}` : "";
    console.log(`  [${r.before}${suffix}] ${r.label}  ${r.address}${r.error ? `  (${r.error})` : ""}`);
  }

  console.log(`\n-- Asset Hub funding results --`);
  for (const r of fundResults) {
    console.log(`  [${r.action}] ${r.label}  ${r.address}  free=${formatPasBalance(r.freeBefore)} PAS${r.error ? `  (${r.error})` : ""}`);
  }

  const failures = [
    ...authResults.filter((r) => r.action === "FAILED").map((r) => `Bulletin authorize ${r.label} (${r.address}): ${r.error}`),
    ...fundResults.filter((r) => r.action === "FAILED").map((r) => `Asset Hub fund ${r.label} (${r.address}): ${r.error}`),
  ];
  if (authSettled.status === "rejected") {
    failures.push(`Bulletin authorization pass crashed before completing: ${authSettled.reason?.message ?? authSettled.reason}`);
  }
  if (fundSettled.status === "rejected") {
    failures.push(`Asset Hub funding pass crashed before completing: ${fundSettled.reason?.message ?? fundSettled.reason}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} account(s) could NOT be made E2E-ready:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll ${accounts.length} E2E signer account(s) ready (authorized + funded).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`\ne2e-ensure-authorized: ${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
