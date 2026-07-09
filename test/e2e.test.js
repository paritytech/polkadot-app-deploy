import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mutateFixture, makeMultiChunkFixture } from "./helpers/e2e-fixture.js";
import { buildFixture as buildIncrementalFixture } from "./helpers/e2e-incremental-fixture.js";
import { buildManifestSidecar } from "./helpers/e2e-manifest-fixture.js";
import { runBulletinDeploy } from "./helpers/e2e-cli.js";
import { resolveContenthashOnChain } from "./helpers/e2e-verify.js";
import { startFaultProxy } from "./helpers/ws-fault-proxy.mjs";
import { DEFAULT_MNEMONIC, sanitizeDomainLabel, DotNS, loadEnvironments, resolveEndpoints, deploy, poolAccountDerivationPath } from "@parity/polkadot-app-deploy";
import { probeSignerPopStatus } from "./helpers/probe-pop-status.js";
import { encodeContenthash } from "@parity/polkadot-app-deploy/deploy";
import { fetchManifestRoundtrip } from "@parity/polkadot-app-deploy/manifest-roundtrip";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { getPolkadotSigner } from "polkadot-api/signer";
import {
  assertDeploySucceeded,
  assertStdoutMatches,
  parseLineOrExplain,
  assertOnChainMatches,
  failWith,
} from "./helpers/e2e-failure.js";

// The CLI prints "CID: bafy..." at the end of a successful deploy. We parse
// that — not a client-side recomputation — so we verify "what the CLI said
// it uploaded matches what DotNS stores", avoiding any merkleization
// determinism rabbit hole.
function parseDeployedCid(stdout, scenario = "deploy") {
  // Walk lines bottom-up: the CLI prints the final CID near the end, possibly
  // after non-CID lines. parseLineOrExplain on the full blob would match the
  // FIRST occurrence (top-down); we want the last.
  const lines = String(stdout ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^CID:\s+(bafy\S+)/);
    if (m) return m[1];
  }
  // No CID found — throw via the helper for structured output.
  return parseLineOrExplain(stdout, {
    pattern: /^CID:\s+(bafy\S+)/m,
    scenario,
    what: "deployed CID",
    hint: "every successful deploy ends with a 'CID: bafy...' line. Missing means the CLI failed before final-summary emission (check earlier stderr).",
  })[1];
}

// Parse the chunk-skip rate from a deploy's stdout.
// Looks for the Probed summary line emitted by renderSummary in incremental-stats.ts:
//   "  Probed:        18 chunks  →  15 on chain, 2 absent"
// Returns probePresent / probedTotal as a number in [0, 1].
// Throws if the Probed line is missing — a silent pass on a missing parse is
// more dangerous than a false-positive test failure.
function parseChunkSkipRateFromOutput(stdout, scenario = "S-INC") {
  const m = parseLineOrExplain(stdout, {
    pattern: /Probed:\s+(\d+)\s+chunks\s+→\s+(\d+)\s+on chain/,
    scenario,
    what: "chunk-probe summary line",
    hint: "format changed in #518 from 'cached, to upload' to 'on chain, absent'. If the CLI wording changed again, update the pattern here; if the deploy never ran the incremental path, check the manifest-fetch logs.",
  });
  const probedTotal = parseInt(m[1], 10);
  const probePresent = parseInt(m[2], 10);
  // 0/0 = no chunks to probe = fast-path / no work. The caller's regression
  // check (skipRate < 0.6) treats this as "fully skipped" rather than a
  // false-positive regression — returning 0 here would fire even though
  // nothing was actually re-uploaded.
  if (probedTotal === 0) return 1;
  return probePresent / probedTotal;
}

// Parse bytes uploaded from the spec § 9 summary line:
//   "  Upload:        2.1 MB across 3 chunks (vs 5.1 MB if full deploy)"
// Returns bytesUploaded as a number in bytes (decimal MB × 1,000,000).
// Returns 0 when the line is absent — perfect cache case (nothing uploaded)
// legitimately omits the line. Tests asserting "<= N KB" pass trivially in
// that case, which is the right behavior.
function parseBytesUploadedFromOutput(stdout) {
  const m = stdout.match(/Upload:\s+([\d.]+)\s+MB\s+across\s+(\d+)\s+chunks/);
  if (!m) return 0;
  return parseFloat(m[1]) * 1_000_000;
}

// Apply a Vite-rebuild patch to a v1 fixture, producing a "v2" build in-place.
// The patch directory contains:
//   - patch.json: { delete: [...] } listing files to remove from v1
//   - patch/: directory whose contents are copied over v1 (overwrites + adds)
// This simulates a real frontend rebuild where one source file changed,
// causing Vite to emit a new content-hashed bundle filename and update
// index.html's script tag.
function applyVitePatch(targetDir, fixtureRoot) {
  const patchManifest = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "patch.json"), "utf-8")
  );
  for (const rel of patchManifest.delete ?? []) {
    const abs = path.join(targetDir, rel);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
  fs.cpSync(path.join(fixtureRoot, "patch"), targetDir, { recursive: true });
}

// On-chain reads can lose a race with tail-in-flight txs from a cancelled
// earlier run (GH cancel-in-progress cancels the job but doesn't rollback
// submitted txs). Retry a few times — the expected value is the last-written
// one, so it wins once all concurrent tx propagation settles.
async function readContenthashWithRetry(label, expected, attempts = 6, delayMs = 10_000) {
  let onChain = "";
  for (let i = 1; i <= attempts; i++) {
    onChain = (await resolveContenthashOnChain(label, PAD_ENV)).toLowerCase();
    if (onChain === expected) return onChain;
    if (i < attempts) {
      console.log(`  verify attempt ${i}/${attempts}: on-chain=${onChain.slice(0, 18)}... expected=${expected.slice(0, 18)}... — retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return onChain;
}

let signerPopStatus = -1;

const ENABLED = process.env.E2E === "1";
const SIGNER = process.env.E2E_SIGNER ?? "pool";
const MERKLE = process.env.E2E_MERKLE ?? "js";
const SCENARIO = process.env.E2E_SCENARIO ?? "s1";
const RPC = process.env.BULLETIN_RPC ?? "wss://paseo-bulletin-rpc.polkadot.io";
const PAD_ENV =
  process.env.PAD_ENV ??
  process.env.DOTNS_ENV ??
  null;
if (process.env.DOTNS_ENV && !process.env.PAD_ENV) {
  console.warn("DOTNS_ENV is deprecated; use PAD_ENV. Will be removed in a future release.");
}
// When PAD_ENV is set, --env drives the Bulletin endpoint from environments.json.
// Injecting BULLETIN_RPC would override it, pointing at the wrong chain.
const rpcEnv = () => PAD_ENV ? {} : { BULLETIN_RPC: RPC };
const RUN_TAG = `${process.env.GITHUB_RUN_ID ?? "local"}-${(process.env.GITHUB_SHA ?? "dev").slice(0, 7)}`;
process.env.DEPLOY_TAG ??= "e2e-local";
if (ENABLED && !process.env.DEPLOY_TAG?.startsWith("e2e-")) {
  throw new Error(`E2E deploy tag must start with 'e2e-' (got: ${process.env.DEPLOY_TAG}). Check DEPLOY_TAG env var.`);
}
const RUN_TOKEN = `${process.env.GITHUB_RUN_ID ?? "local"}${(process.env.GITHUB_SHA ?? "dev").slice(0, 7)}`.toLowerCase().replace(/[^a-z0-9]/g, "");
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;

const ALICE_MNEMONIC = DEFAULT_MNEMONIC;

function pickStableLabel() {
  if (SIGNER === "direct") {
    return signerPopStatus >= 2 ? "e2edirect" : "e2edirect01";
  }
  // #1054: a pinned pool leg owns its own per-leg domain (e2epoolleg<NN>).
  const perLeg = perLegPoolLabel();
  if (perLeg) return perLeg;
  // E2E_POOL_LABEL lets nightly-pr-coverage use a dedicated pool fixture domain
  // (e2eprpool01) so it doesn't contend with nightly-s1-pool on e2epoolns01.
  if (process.env.E2E_POOL_LABEL) return process.env.E2E_POOL_LABEL;
  return signerPopStatus >= 2 ? "e2epool" : "e2epoolns01";
}

function pickDirectLabel() {
  return signerPopStatus >= 2 ? "e2edirect" : "e2edirect01";
}
// Per-leg domain isolation for nightly-pr-coverage (#863 follow-up). Multiple
// pool legs (s-inc js/kubo, s-inc-roundtrip, s-inc-portability) share pickIncLabel
// and otherwise deploy to the SAME domain (e2eincpool01) concurrently → setContenthash
// overwrite race. When BULLETIN_POOL_ACCOUNT_INDEX is set (the matrix pins a distinct
// pool account per leg), append it as a zero-padded 2-digit suffix to give each leg a
// distinct domain. 2 trailing digits pass the DotNS sanitizer unchanged; the NoStatus
// branch keeps a ≥9-char base (e2eincpool/e2erotpool) so the fresh domain is registerable
// without full PoP. Unset (normal/non-CI deploys, main nightly chain) → unchanged.
function poolLegSuffix() {
  const idx = process.env.BULLETIN_POOL_ACCOUNT_INDEX;
  if (idx == null || idx === "") return null;
  const n = Number(idx);
  if (!Number.isInteger(n) || n < 0 || n > 99) return null;
  return String(n).padStart(2, "0");
}
// #1054: when a pool leg is pinned to a pool account (BULLETIN_POOL_ACCOUNT_INDEX),
// that account is the DotNS OWNER too (not bare Alice), so concurrent legs stop
// sharing Alice's single Asset Hub nonce (the `Invalid: Stale` collision class).
function poolLegIndex() {
  const idx = process.env.BULLETIN_POOL_ACCOUNT_INDEX;
  if (idx == null || idx === "") return null;
  const n = Number(idx);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}
// Per-leg DotNS domain owned by that leg's pool account. Base "e2epoolleg" (10 chars,
// ≥9 so a NoStatus account can register it) + zero-padded 2-digit index. Round-trips
// through sanitizeDomainLabel unchanged (asserted in test/test.js).
function perLegPoolLabel() {
  const n = poolLegIndex();
  return n == null ? null : `e2epoolleg${String(n).padStart(2, "0")}`;
}
// DotNS-owner CLI args for a pinned pool leg: sign DotNS ops as //deploy/<index>
// (the SAME account used for Bulletin storage), not the default bare Alice.
function poolOwnerArgs() {
  const n = poolLegIndex();
  return n == null ? [] : ["--mnemonic", ALICE_MNEMONIC, "--derivation-path", poolAccountDerivationPath(n)];
}
function pickIncLabel() {
  const perLeg = perLegPoolLabel();
  if (perLeg) return perLeg;
  const suf = poolLegSuffix();
  if (signerPopStatus >= 2) return suf ? `e2einc${suf}` : "e2einc";
  return suf ? `e2eincpool${suf}` : "e2eincpool01";
}
function pickRotLabel() {
  const perLeg = perLegPoolLabel();
  if (perLeg) return perLeg;
  const suf = poolLegSuffix();
  if (signerPopStatus >= 2) return suf ? `e2erot${suf}` : "e2erot";
  return suf ? `e2erotpool${suf}` : "e2erotpool01";
}

function noStatusRunLabel(prefix) {
  return sanitizeDomainLabel(`${prefix}${RUN_TOKEN}x00`);
}

function pickFreshRunLabel(prefix) {
  if (signerPopStatus < 2) return noStatusRunLabel(prefix);
  // The currently-published rc.1 binary's sanitizeDomainLabel leaves
  // trailing-1 labels unchanged; preflight then rejects them. RUN_TAG ends
  // in a 7-char git short-SHA, which is a digit ~50% of the time. Drop the
  // trailing single digit locally so this test passes against rc.1; rc.2's
  // binary sanitizer handles this case natively (see PR · s1-smoke
  // failure on run 26652530002).
  let label = sanitizeDomainLabel(`${prefix}${RUN_TAG}`);
  if (/[a-z]\d$/.test(label)) label = label.replace(/\d$/, "");
  return label;
}

// Burst-heavy re-upload scenarios get a DEDICATED derived signer so they don't
// contend on Alice's shared nonce stream (the documented Invalid::Stale failure
// mode — see the MANIFEST_SCENARIOS note below). These accounts are provisioned
// (funded + Bulletin-authorized) by tools/setup-e2e-derivation-signers.mjs.
// Applied UNCONDITIONALLY (even on a custom PAD_ENV), unlike the s1-direct
// fallback which still uses Alice root on custom envs.
const ISOLATED_DIRECT_SIGNERS = {
  "s9": "//e2e-s9",
  "s-grandpa-reupload": "//e2e-sgrandpa",
};

function directSignerDerivationPath() {
  if (ISOLATED_DIRECT_SIGNERS[SCENARIO]) return ISOLATED_DIRECT_SIGNERS[SCENARIO];
  if (!PAD_ENV) return "//e2e-direct";
  return null;
}

function buildArgs(fixtureDir, label) {
  const args = [fixtureDir, label, "--tag", process.env.DEPLOY_TAG];
  if (MERKLE === "js") args.push("--js-merkle");
  if (PAD_ENV) args.push("--env", PAD_ENV);
  // Direct-signer e2e leg: on the default env, deploys to e2edirect.dot owned
  // by Alice//e2e-direct (transferred from root Alice in PR #187). On custom
  // envs (e.g. paseo-next-v2), the PR harness falls back to Alice root while
  // still exercising the direct-signer CLI path.
  if (SIGNER === "direct") {
    args.push("--mnemonic", ALICE_MNEMONIC);
    const deriv = directSignerDerivationPath();
    if (deriv) args.push("--derivation-path", deriv);
  } else {
    // #1054: a pinned pool leg signs DotNS as its own pool account (//deploy/<index>),
    // which owns its per-leg domain — no more shared bare-Alice Asset Hub nonce.
    args.push(...poolOwnerArgs());
  }
  // Manifest sidecar is restricted to the scenarios where the manifest path is
  // load-bearing for coverage (s1 happy-path, s-inc incremental). Running it
  // unconditionally on every @HEAD scenario added ~70 extra Asset Hub txs per
  // run on Alice's shared nonce stream, evicting sibling jobs from the mempool
  // and blowing through the 3-attempt × 180s retry budget — observed as the
  // S9/S6/S4 chain-progress failures on v0.7.28-rc.1 ([run 26410360929]).
  const MANIFEST_SCENARIOS = new Set(["s1", "s-inc"]);
  if (MANIFEST_SCENARIOS.has(SCENARIO)) {
    const { configPath } = buildManifestSidecar({ buildDir: fixtureDir, label });
    args.push("--config", configPath);
  }
  return args;
}

function buildInputCarArgs(dumpPath, label) {
  const args = ["--input-car", dumpPath, label, "--tag", process.env.DEPLOY_TAG];
  if (PAD_ENV) args.push("--env", PAD_ENV);
  if (SIGNER === "direct") {
    args.push("--mnemonic", ALICE_MNEMONIC);
    const deriv = directSignerDerivationPath();
    if (deriv) args.push("--derivation-path", deriv);
  } else {
    // #1054: a pinned pool leg signs DotNS as its own pool account (//deploy/<index>).
    args.push(...poolOwnerArgs());
  }
  return args;
}

async function resolveDotnsEnvConnectOptions() {
  if (!PAD_ENV) return {};
  const { doc } = await loadEnvironments();
  const resolved = resolveEndpoints(doc, PAD_ENV);
  return {
    rpc: resolved.assetHub[0],
    assetHubEndpoints: resolved.assetHub,
    autoAccountMapping: resolved.autoAccountMapping,
    contracts: Object.keys(resolved.contracts).length > 0 ? resolved.contracts : undefined,
    nativeToEthRatio: resolved.nativeToEthRatio,
  };
}

async function resolveE2eGateway() {
  if (process.env.BULLETIN_GATEWAY) return normalizeGatewayBase(process.env.BULLETIN_GATEWAY);
  if (!PAD_ENV) return "https://paseo-ipfs.polkadot.io";
  const { doc } = await loadEnvironments();
  const env = doc.environments.find((entry) => entry.id === PAD_ENV);
  return normalizeGatewayBase(env?.ipfs ?? "https://paseo-ipfs.polkadot.io");
}

async function resolveE2eBulletinRpc() {
  if (!PAD_ENV) return RPC;
  const { doc } = await loadEnvironments();
  return resolveEndpoints(doc, PAD_ENV).bulletin[0];
}

function normalizeGatewayBase(url) {
  return url.replace(/\/+$/, "").replace(/\/ipfs$/, "");
}

describe("e2e", { skip: !ENABLED }, () => {
  before(async () => {
    signerPopStatus = await probeSignerPopStatus({
      dotnsFactory: () => new DotNS(),
      signer: SIGNER,
      bulletinDeployEnv: PAD_ENV,
      resolveEnvConnectOptions: resolveDotnsEnvConnectOptions,
      defaultMnemonic: DEFAULT_MNEMONIC,
    });
  });

  describe("S1 — happy path, stable label", { skip: SCENARIO !== "s1" }, () => {
    test(`deploy ${SIGNER}/${MERKLE} to stable label`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const label = pickStableLabel();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.dot`),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S1" });

        const deployedCid = parseDeployedCid(stdout, "S1");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(label, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S1", label });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S1-SMOKE — happy path, per-run fresh label", { skip: SCENARIO !== "s1-smoke" }, () => {
    test(`smoke ${SIGNER}/${MERKLE} on fresh label`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const label = pickFreshRunLabel("e2esmoke");
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.dot`),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assert.strictEqual(code, 0, `deploy failed (exit ${code}). Stderr tail: ${stderr.slice(-500)}`);

        const deployedCid = parseDeployedCid(stdout);
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(label, expected);
        assert.strictEqual(onChain, expected,
          `on-chain contenthash must match the CID the CLI uploaded (${deployedCid})`);
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S2 — happy path, fresh registration", { skip: SCENARIO !== "s2" }, () => {
    test(`fresh-register ${SIGNER}/${MERKLE}`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      // Full-status signers keep the historical fresh label. NoStatus signers
      // need a base length >= 9 with exactly two trailing digits so v2 does not
      // require Personhood status that the signer does not already have.
      const label = pickFreshRunLabel("e2e-fresh");
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.dot`),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S2" });

        const deployedCid = parseDeployedCid(stdout, "S2");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(label, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S2", label });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S-TRANSFER — register then hand over via the transfer command", { skip: SCENARIO !== "s-transfer" }, () => {
    // Exercises the zero-mobile-sig transfer mechanism on chain: a worker
    // (Alice) registers a name, then the `transfer` recovery command hands it to
    // a recipient and is idempotent on re-run. A NoStatus-class label keeps this
    // registrable regardless of Alice's live PoP tier. The recipient is an
    // explicit H160 (Bob) so the scenario needs no mobile session — the deploy
    // orchestration's session→recipient path is covered by unit tests +
    // resolveDeployActors, and the full session flow by the manual e2e-local proof.
    const BOB_H160 = "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01";
    test(`register as Alice → transfer to recipient → idempotent re-run`, { timeout: DEPLOY_TIMEOUT_MS + 60_000 }, async () => {
      const label = noStatusRunLabel("e2exfer");
      const connectOpts = await resolveDotnsEnvConnectOptions();
      const envArgs = PAD_ENV ? ["--env", PAD_ENV] : [];

      // 1. Register a fresh name owned by Alice (in-process — no storage upload,
      //    keeping the flake surface to the DotNS commit-reveal path only).
      const reg = new DotNS();
      await reg.connect({ mnemonic: DEFAULT_MNEMONIC, ...connectOpts });
      const aliceH160 = reg.evmAddress;
      assert.notEqual(
        aliceH160.toLowerCase(), BOB_H160.toLowerCase(),
        ">> FAIL: S-TRANSFER: worker must differ from the recipient or the transfer is a no-op",
      );
      try {
        await reg.register(label);
      } finally {
        reg.disconnect();
      }

      // 2. Hand over via the `transfer` CLI command (exercises commands/transfer.ts
      //    + DotNS.transferName + the live transferFloor quote). transferName
      //    asserts ownerOf == recipient before returning, so exit 0 IS the
      //    on-chain proof the transfer landed.
      const t1 = await runBulletinDeploy({
        args: ["transfer", label, "--to", BOB_H160, ...envArgs],
        env: rpcEnv(),
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      assert.equal(
        t1.code, 0,
        `>> FAIL: S-TRANSFER: transfer command exited ${t1.code}: ${(t1.stderr || t1.stdout).split("\n").slice(-3).join(" ")}`,
      );
      assert.match(
        t1.stdout, /Transferred .* to 0x41dccbd4/i,
        ">> FAIL: S-TRANSFER: transfer command did not report a successful handover to the recipient",
      );

      // 3. Re-run: idempotent no-op (recipient already owns it).
      const t2 = await runBulletinDeploy({
        args: ["transfer", label, "--to", BOB_H160, ...envArgs],
        env: rpcEnv(),
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      assert.equal(
        t2.code, 0,
        `>> FAIL: S-TRANSFER: idempotent re-run exited ${t2.code}: ${(t2.stderr || t2.stdout).split("\n").slice(-3).join(" ")}`,
      );
      assert.match(
        t2.stdout, /already owned by/i,
        ">> FAIL: S-TRANSFER: second transfer should be a no-op (already-owned), not a re-transfer",
      );
    });
  });

  describe("S4 — gh-pages mirror serves the deployed CAR", { skip: SCENARIO !== "s4" }, () => {
    // GitHub Pages builds usually land within ~1-2 minutes of the push, but
    // first-time branch creation can take longer and a busy queue bumps it
    // further. 5 minutes is enough in practice without parking the test
    // indefinitely on a broken Pages build.
    const PAGES_WAIT_MS = 5 * 60 * 1000;
    const PAGES_POLL_INTERVAL_MS = 10_000;

    function parseMirrorUrl(stdout) {
      return parseLineOrExplain(stdout, {
        pattern: /Mirror:\s+(https:\/\/\S+\.car)\b/,
        scenario: "S4",
        what: "gh-pages mirror URL",
        hint: "S4 expects '--gh-pages-mirror' to print a 'Mirror: https://...car' line. Missing means the mirror step didn't execute (check the gh-pages push log).",
      })[1];
    }

    async function pollUntil200(url, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let lastStatus = 0;
      while (Date.now() < deadline) {
        const res = await fetch(url, { redirect: "follow" });
        if (res.status === 200) return res;
        lastStatus = res.status;
        await new Promise((r) => setTimeout(r, PAGES_POLL_INTERVAL_MS));
      }
      throw new Error(`${url} never served 200 within ${timeoutMs}ms (last status ${lastStatus})`);
    }

    // Pages is CDN-backed; a fresh commit can return 200 for several seconds
    // while the edge still serves stale bytes. Poll the manifest (which the
    // CLI writes atomically alongside the CAR) until its `cid` field matches
    // this deploy's CID — at that point the edge has picked up our commit
    // and a subsequent CAR fetch is guaranteed fresh. Cache-busting via a
    // query string is used for the CAR fetch too as a second line of defence.
    async function pollUntilManifestCidMatches(url, expectedCid, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let lastCid = null;
      let lastStatus = 0;
      while (Date.now() < deadline) {
        const res = await fetch(url, { redirect: "follow", cache: "no-store" });
        if (res.status === 200) {
          const m = await res.json();
          if (m.cid === expectedCid) return m;
          lastCid = m.cid;
        } else {
          lastStatus = res.status;
        }
        await new Promise((r) => setTimeout(r, PAGES_POLL_INTERVAL_MS));
      }
      throw new Error(`${url} manifest CID never reached ${expectedCid} within ${timeoutMs}ms (last seen cid=${lastCid ?? "n/a"}, last status=${lastStatus})`);
    }

    test(`deploy ${SIGNER}/${MERKLE} with --gh-pages-mirror and fetch via Pages`, { timeout: DEPLOY_TIMEOUT_MS + PAGES_WAIT_MS + 60_000 }, async () => {
      const label = pickStableLabel();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      // Reference copy of the exact bytes the CLI sends to Bulletin. We
      // can't HTTP-GET from Bulletin directly (content lives in the
      // TransactionStorage pallet split into chunks; there's no gateway
      // that ships with Paseo), so we ask the CLI to save the pre-upload
      // CAR via PAD_DUMP_CAR and compare that file against the
      // mirror download. Dump is post-encryption, so the bytes match
      // exactly what Bulletin receives AND what the mirror publishes —
      // same bytes, same content-hash, same object.
      const dumpPath = path.join(os.tmpdir(), `e2e-s4-car-${Date.now()}.bin`);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: [...buildArgs(fixtureDir, `${label}.dot`), "--gh-pages-mirror"],
          env: { ...rpcEnv(), PAD_DUMP_CAR: dumpPath },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S4" });

        assert.ok(fs.existsSync(dumpPath), `CLI should have dumped the pre-upload CAR to ${dumpPath}`);
        const bulletinBytes = new Uint8Array(fs.readFileSync(dumpPath));

        // Mirror URL comes from the CLI output; trusting the CLI's own claim
        // means a mis-wired Mirror: log line (wrong owner/repo) would fail
        // the subsequent fetch rather than silently passing.
        const mirrorUrl = parseMirrorUrl(stdout);
        const manifestUrl = mirrorUrl.replace(/\.car$/, ".json");
        const deployedCid = parseDeployedCid(stdout, "S4");

        // Wait for Pages to serve THIS deploy's manifest (CID-matched), then
        // fetch the CAR with a cache-busting query string. Without this,
        // the CDN can return 200 while still serving a prior deploy's CAR
        // for seconds-to-minutes, surfacing as a spurious byte mismatch.
        const manifest = await pollUntilManifestCidMatches(manifestUrl, deployedCid, PAGES_WAIT_MS);
        assert.strictEqual(manifest.domain, `${label}.dot`);
        assert.strictEqual(manifest.encrypted, false);

        const carResp = await fetch(`${mirrorUrl}?v=${deployedCid}`, { redirect: "follow", cache: "no-store" });
        assert.strictEqual(carResp.status, 200, `CAR URL must serve 200 once manifest is fresh`);
        const pagesBytes = new Uint8Array(await carResp.arrayBuffer());

        assert.strictEqual(pagesBytes.length, bulletinBytes.length,
          `Pages CAR is ${pagesBytes.length} bytes; Bulletin CAR is ${bulletinBytes.length} bytes`);
        assert.ok(Buffer.from(pagesBytes).equals(Buffer.from(bulletinBytes)),
          `Pages and Bulletin CAR bytes differ (same length ${pagesBytes.length} but content mismatch)`);
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
        fs.rmSync(dumpPath, { force: true });
      }
    });
  });

  describe("S3 — domain owned by different account", { skip: SCENARIO !== "s3" }, () => {
    test(`deploy to pre-owned label rejects with exit 78`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stderr } = await runBulletinDeploy({
          // S3 needs a label owned by a DIFFERENT account from the deploy signer.
          // `e2eowned.dot` was the historical fixture for PopFull signers but its
          // chain ownership drifted to Alice (see e2e run 26648857693 / v0.7.30-rc.1
          // S3 failure — `transferFrom` reverts with a custom error so we can't easily
          // restore it). Both `e2eownedns01.dot` and `e2eownedns02.dot` are
          // PoP-class-compatible with all signers (≥9-char NoStatus, accepts Full
          // signers fine) and are stable-owned by Bob on both paseo-next-v2 and
          // preview — use the same env-conditional for every PoP status.
          args: buildArgs(fixtureDir, PAD_ENV === "paseo-next-v2" ? "e2eownedns02.dot" : "e2eownedns01.dot"),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        if (code !== 78) {
          failWith({
            scenario: "S3",
            message: `expected EXIT_CODE_NO_RETRY (78), got ${code}`,
            context: stderr,
            keywords: ["Error", "already owned", "domain"],
            hint: "S3 deploys to a domain owned by a DIFFERENT account; the CLI must refuse with exit 78 (no-retry).",
          });
        }
        // Bob's H160 (from docs/e2e-bootstrap.md). Pinning to this specific
        // owner rather than a generic pattern catches regressions where the
        // preflight rejects for the wrong reason (e.g. network error).
        assert.match(stderr, /is already owned by 0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01/i);
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  // S5 sets DOTNS_COMMITMENT_BUFFER=0 to remove the safety margin against
  // the dotns-sdk#105 timing race (CLI's waitForMinimumCommitmentAge compares
  // wall-clock to block.timestamp; when block-time lags wall-clock, the
  // reveal can fire too early and revert with CommitmentTooNew). Whether the
  // race manifests on a given run is timing-dependent — sometimes the chain
  // produces blocks fast enough that buffer=0 is plenty.
  //
  // Hard assertions (always-on contract):
  //   - deploy exits 0 (buffer=0 must not break the flow)
  //   - actionable-error text never appears (if both attempts failed, that
  //     would be a real regression)
  //
  // Soft signal (timing-dependent, informational only):
  //   - if "with DOTNS_COMMITMENT_BUFFER=60s" is present, the retry path
  //     fired and recovered — extra confidence in the recovery.
  //   - if absent, the race didn't manifest this run; not a failure.
  //
  // The retry-path code itself is covered by the unit tests on
  // isExplicitCommitmentBuffer + the buffer-escalation logic in
  // test/test.js. This E2E proves only that buffer=0 doesn't break a real
  // chain deploy.
  describe("S5 — DOTNS_COMMITMENT_BUFFER=0 race + retry recovery", { skip: SCENARIO !== "s5" }, () => {
    test(`deploy ${SIGNER}/${MERKLE} with buffer=0 succeeds (retry path covered when race fires)`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      // Per-run unique label so the deploy actually goes through register()
      // (where the retry path lives in src/dotns.ts), not setContenthash.
      // Mirrors the .github/workflows/e2e.yml nightly-s5 fix from #205.
      const label = pickFreshRunLabel("e2e-s5");
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.dot`),
          env: { ...rpcEnv(), DOTNS_COMMITMENT_BUFFER: "0" },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S5", step: "deploy after retry" });
        // Verbatim from src/dotns.ts: actionable-error throw on double-failure.
        if (/DotNS register failed after retry:/.test(stdout)) {
          failWith({
            scenario: "S5",
            message: "actionable-error text appeared — BOTH register attempts failed instead of recovering on retry",
            context: stdout,
            keywords: ["DotNS register", "retry", "commit"],
            hint: "S5 expects the in-tool retry path (DOTNS_COMMITMENT_BUFFER bump) to succeed on attempt 2. If both attempts fail, the bug is in commit-reveal handling.",
          });
        }
        const retryFired = /with DOTNS_COMMITMENT_BUFFER=60s/.test(stdout);
        console.log(`[S5] retry path ${retryFired ? "fired and recovered" : "did not fire — race did not manifest this run"}`);
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  // S6 forces transport-level failover by pointing BULLETIN_RPC at an
  // unroutable address (RFC 3330). src/deploy.ts:811-813 prepends user-rpc
  // to BULLETIN_ENDPOINTS, leaving the public Bulletin endpoint as the
  // backup; papi rotates after the first endpoint fails fast. The
  // captureWarning("Bulletin RPC failover", …) is Sentry-only — we don't
  // assert against stdout here. Sentry-side assertion lives in
  // tools/verify_nightly_telemetry.py (#181 P1).
  describe("S6 — primary RPC unreachable, papi rotates to backup", { skip: SCENARIO !== "s6" }, () => {
    test(`deploy ${SIGNER}/${MERKLE} with unroutable primary RPC succeeds via failover`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const label = pickStableLabel();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.dot`),
          env: { BULLETIN_RPC: "ws://127.0.0.1:1/" },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S6", step: "deploy via failover" });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  // S7 exercises the in-process Revive transaction path restored by PR #237.
  // When a host process — playground-cli's phone/QR session — passes its own
  // PolkadotSigner to DotNS.connect(), bulletin-deploy must submit DotNS
  // contract calls through polkadot-api/Revive. This path was broken after
  // the #158 dotns-cli migration and is restored in PR #237.
  //
  // The test calls DotNS directly (not via the CLI subprocess) so the
  // injected signer actually reaches the in-process path. No file upload
  // is needed — setContenthash is what exercises the restored code.
  //
  // A fixed CIDv1 is used so retries are idempotent (the contract stores
  // whatever bytes you write; it doesn't validate the CID exists anywhere).
  describe("S7 — external PolkadotSigner injects into DotNS.connect (in-process Revive path)", { skip: SCENARIO !== "s7" }, () => {
    test(`setContenthash via injected PolkadotSigner`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      // S7 has no pool/direct split: the point is to test the external-signer
      // code path itself, not the CLI signer selection. Always use the pool
      // account (Alice root mnemonic → stable pool label) regardless of E2E_SIGNER.
      //
      // Cannot use pickFreshRunLabel here: this test calls setContenthash
      // DIRECTLY via the external PolkadotSigner, without going through the
      // CLI's register() path. A fresh unregistered label reverts on chain.
      // Tier 4 fresh-label cleanup is therefore limited to S8 (which deploys
      // through the CLI and gets register() for free).
      const label = signerPopStatus >= 2 ? "e2epool" : "e2epoolns01";

      // Build a signer using the same Keyring + getPolkadotSigner pattern
      // that DotNS uses internally (src/dotns.ts:676-680). The difference is
      // that we pass it as an external object to DotNS.connect() rather than
      // letting DotNS construct it from a mnemonic.
      await cryptoWaitReady();
      const keyring = new Keyring({ type: "sr25519" });
      const account = keyring.addFromMnemonic(ALICE_MNEMONIC);
      const polkadotSigner = getPolkadotSigner(
        account.publicKey,
        "Sr25519",
        async (input) => account.sign(input),
      );

      const testCid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
      const expected = ("0x" + encodeContenthash(testCid)).toLowerCase();

      const dotns = new DotNS();
      try {
        await dotns.connect({
          signer: polkadotSigner,
          signerAddress: account.address,
          ...(await resolveDotnsEnvConnectOptions()),
        });
        // setContenthash routes through contractTransaction (in-process Revive)
        // when _usesExternalSigner is true, and does an internal post-write
        // read-back before returning. A throw here means either the Revive call
        // reverted or the on-chain value didn't match — both are real failures.
        await dotns.setContenthash(label, expected);
        // Cross-verify via the resolver read path, independent of the
        // setContenthash write path used above.
        const onChain = await readContenthashWithRetry(label, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S7", label });
      } finally {
        dotns.disconnect();
      }
    });

    // S7b: verify that Bulletin storage uploads use storageSigner when provided.
    // Programmatic callers pass both signer (DotNS) and storageSigner (Bulletin).
    // Confirms "Using slot signer:" appears in console output, proving
    // getSlotSignerProvider was selected over pool fallback.
    test(`full deploy() routes Bulletin storage through storageSigner when provided`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const label = signerPopStatus >= 2 ? "e2epool" : "e2epoolns01";

      await cryptoWaitReady();
      const keyring = new Keyring({ type: "sr25519" });
      const account = keyring.addFromMnemonic(ALICE_MNEMONIC);
      const polkadotSigner = getPolkadotSigner(
        account.publicKey,
        "Sr25519",
        async (input) => account.sign(input),
      );

      // Intercept console.log to capture storage-path log lines without
      // suppressing them (forward to process.stdout so the test log is intact).
      const capturedLogs = [];
      const originalConsoleLog = console.log;
      console.log = (...args) => {
        capturedLogs.push(args.map(String).join(" "));
        originalConsoleLog(...args);
      };

      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-s7b-"));
      fs.writeFileSync(path.join(fixtureDir, "index.html"), "<h1>S7b external signer storage test</h1>");

      try {
        // Resolve the whole env (endpoints + contracts + ipfs) the same way the
        // CLI's --env does — pass `env`, NOT a partial mix of rpc + contracts,
        // so the bulletin RPC and the DotNS contract addresses stay consistent.
        const bulletinRpc = await resolveE2eBulletinRpc();
        await deploy(fixtureDir, `${label}.dot`, {
          signer: polkadotSigner,
          signerAddress: account.address,
          // S7b contract: programmatic callers pass storageSigner explicitly.
          // Alice is the pool account and is authorized on Bulletin.
          storageSigner: polkadotSigner,
          storageSignerAddress: account.address,
          ...(PAD_ENV ? { env: PAD_ENV } : { rpc: bulletinRpc }),
          jsMerkle: true,
        });
      } finally {
        console.log = originalConsoleLog;
        try { fs.rmSync(fixtureDir, { recursive: true }); } catch {}
      }

      // The decisive assertion: getSlotSignerProvider emits this line when storageSigner
      // is selected. If this fails, the reconnect factory fell back to pool (regression).
      const signerLog = capturedLogs.find((l) => l.includes(`Using slot signer: ${account.address}`));
      assert.ok(
        signerLog != null,
        `>> FAIL: S7: Bulletin storage did not go through storageSigner — expected "Using slot signer: ${account.address}" in console output but it was absent; pool fallback likely`,
      );
    });
  });

  // S-INC-ROUNDTRIP verifies that the manifest embedded in the deployed CAR
  // is readable back via the gateway and matches the local manifest.json
  // written during the deploy. Uses fetchManifestRoundtrip from
  // src/manifest-roundtrip.ts, which GETs the full CAR and parses the
  // .bulletin-deploy/manifest.json leaf.
  //
  // Spec: docs-internal/superpowers/specs/2026-05-08-incremental-upload-v2-revision-design.md (§ 10)
  describe("S-INC-ROUNDTRIP — gateway readback integrity", { skip: SCENARIO !== "s-inc-roundtrip" }, () => {
    test(`manifest embedded in deployed CAR matches local manifest.json`, { timeout: (DEPLOY_TIMEOUT_MS + 30_000) * 2 }, async () => {
      const label = pickIncLabel();
      const gateway = await resolveE2eGateway();
      const fix1 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-rt-"));
      buildIncrementalFixture({ targetDir: fix1, seed: "s-inc-roundtrip", runTag: RUN_TAG + "-rt" });
      try {
        const r1 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.dot`),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-INC-ROUNDTRIP" });

        const deployedCid = parseDeployedCid(r1.stdout, "S-INC-ROUNDTRIP");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        await readContenthashWithRetry(label, expected);

        // Read the local manifest.json the CLI wrote during deploy.
        const localManifestPath = path.join(fix1, ".bulletin-deploy", "manifest.json");
        assert.ok(fs.existsSync(localManifestPath),
          `CLI must write .bulletin-deploy/manifest.json to the build dir`);
        const localManifestJson = JSON.parse(fs.readFileSync(localManifestPath, "utf8"));

        // Fetch the same manifest from the gateway — poll with a 5-min budget
        // to account for gateway indexing delay.
        const result = await fetchManifestRoundtrip(deployedCid, {
          gateway,
          budgetMs: 5 * 60 * 1000,
          pollIntervalMs: 10_000,
          perRequestTimeoutMs: 30_000,
        });
        assert.ok(result.ok,
          `fetchManifestRoundtrip failed: ${result.ok ? "" : result.reason}`);

        // JSON-equality (not byte-equality) to tolerate whitespace differences
        // between what the CLI writes and what the gateway serves.
        const gatewayManifestJson = JSON.parse(new TextDecoder().decode(result.manifestBytes));
        assert.deepStrictEqual(gatewayManifestJson, localManifestJson,
          `gateway manifest must match local manifest.json`);
      } finally {
        fs.rmSync(fix1, { recursive: true, force: true });
      }
    });
  });

  // S-INC-PORTABILITY verifies that a manifest written by workspace A is
  // usable as the incremental baseline for workspace B (a "fresh clone" of the
  // same content). If the chunk-hash encoding or file-path normalization is
  // workspace-specific, the second deploy from B would miss all cached chunks
  // and show 0 % skip rate instead of the expected ≥ 95 %.
  //
  // Spec: docs-internal/superpowers/specs/2026-05-08-incremental-upload-v2-revision-design.md (§ 11 — portability)
  describe("S-INC-PORTABILITY — cross-workspace dedup", { skip: SCENARIO !== "s-inc-portability" }, () => {
    test(`second deploy from a fresh workspace gets ≥ 95 % chunk-skip rate`, { timeout: (DEPLOY_TIMEOUT_MS + 30_000) * 2 }, async () => {
      const label = pickIncLabel();
      const fix1 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-port-A-"));
      const fix2 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-port-B-"));
      buildIncrementalFixture({ targetDir: fix1, seed: "s-inc-portability", runTag: RUN_TAG + "-port" });
      try {
        // Deploy from workspace A
        const r1 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.dot`),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-INC-PORTABILITY", step: "first deploy" });

        // Verify the manifest was written.
        const localManifestPath = path.join(fix1, ".bulletin-deploy", "manifest.json");
        assert.ok(fs.existsSync(localManifestPath),
          `CLI must write .bulletin-deploy/manifest.json in workspace A`);

        // Copy the entire fixture (including the .bulletin-deploy directory) to
        // workspace B. fs.cpSync preserves the manifest.json, simulating a
        // "fresh clone" that carries the prior manifest for incremental dedup.
        fs.cpSync(fix1, fix2, { recursive: true });
        assert.ok(fs.existsSync(path.join(fix2, ".bulletin-deploy", "manifest.json")),
          `manifest must be present in workspace B after copy`);

        // Deploy from workspace B (same content, manifest imported from A)
        const r2 = await runBulletinDeploy({
          args: buildArgs(fix2, `${label}.dot`),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r2, { scenario: "S-INC-PORTABILITY", step: "second deploy" });

        // Bytes-uploaded gate: byte-identical redeploy from a fresh workspace
        // should upload only the section 0 (manifest, ~5-10 KB) + section 2
        // (root dir + volatile, ~5-10 KB) delta. Section 1 (5.1 MB stable
        // content) must be 100 % cached if the manifest is portable across
        // workspaces. Live observation: ~10-20 KB uploaded.
        const bytesUploaded = parseBytesUploadedFromOutput(r2.stdout);
        if (bytesUploaded > 50_000) {
          failWith({
            scenario: "S-INC-PORTABILITY",
            message: `bytes uploaded ${(bytesUploaded / 1024).toFixed(1)} KB > 50 KB ceiling`,
            context: r2.stdout,
            keywords: ["Probed", "Cache", "Manifest"],
            hint: "byte-identical redeploy from another workspace should re-upload only manifest+section-2 overhead. If section 1 chunks were re-uploaded, the manifest is not portable.",
          });
        }
      } finally {
        // Cleanup tmp dirs (best-effort).
        try { fs.rmSync(fix1, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(fix2, { recursive: true, force: true }); } catch {}
      }
    });
  });

  // S-INC-ASSET-ROTATION simulates a real frontend rebuild: one source file
  // changed, Vite emits a new content-hashed bundle filename and updates
  // index.html's script tag. The expected behaviour: the unchanged 9.1 MB
  // worth of stable content-hashed assets (vendor/css/fonts/metadata bundles)
  // stay cached in section 1, only the rotated bundle (~466 KB) and the
  // tiny volatile section (HTML + manifest) need re-uploading.
  //
  // Fixture: github.com/paritytech/Rock-Paper-Scissors built with Vite 7.0,
  // 60 files / 9.6 MB total. Patch swaps the index-*.js bundle (1 source-line
  // string change). Stored as v1 + patch (~10 MB total) instead of v1+v2 (20 MB).
  //
  // Assertions:
  //   - First deploy uploads the full ~9.6 MB (probe finds 0 of N chunks on chain)
  //   - Second deploy uploads ≤ 1.5 MB (rotated bundle + section-2 overhead)
  //   - Chunk-skip rate ≥ 85 % on second deploy
  describe("S-INC-ASSET-ROTATION — realistic Vite rebuild", { skip: SCENARIO !== "s-inc-asset-rotation" }, () => {
    test(`bundle filename rotation re-uploads only the changed file`, { timeout: (DEPLOY_TIMEOUT_MS + 30_000) * 2 }, async () => {
      const label = pickRotLabel();
      const fixtureRoot = path.resolve("test/fixtures/realistic-vite");
      const fix1 = fs.mkdtempSync(path.join(os.tmpdir(), "e2erot-"));
      // Stage v1 of the build into the deploy workspace.
      fs.cpSync(path.join(fixtureRoot, "v1"), fix1, { recursive: true });
      try {
        // First deploy: 9.6 MB site, all chunks new (or already on chain from
        // a prior test run — we don't assert on first-deploy chunk-skip rate).
        const r1 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.dot`),
          env: { ...rpcEnv(), NODE_OPTIONS: "--max-old-space-size=512" },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-INC-ASSET-ROTATION", step: "first deploy" });

        // Manifest must be written so the second deploy can do prev-anchor
        // ordering + classification.
        const localManifestPath = path.join(fix1, ".bulletin-deploy", "manifest.json");
        assert.ok(fs.existsSync(localManifestPath),
          `CLI must write .bulletin-deploy/manifest.json after first deploy`);

        // Apply the Vite-rebuild patch: delete the old bundle, write the new
        // bundle + updated index.html. Manifest in .bulletin-deploy/ is
        // preserved (patch.json doesn't touch it).
        applyVitePatch(fix1, fixtureRoot);

        // Second deploy: only the rotated bundle + HTML should be new.
        // Same heap bump for the redeploy — phase B re-merkleizes the same site.
        const r2 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.dot`),
          env: { ...rpcEnv(), NODE_OPTIONS: "--max-old-space-size=512" },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r2, { scenario: "S-INC-ASSET-ROTATION", step: "second deploy" });

        // Bytes-uploaded gate: rotating one ~466 KB content-hashed bundle in a
        // 9.6 MB site should re-upload only the bundle bytes + section 2 overhead.
        // Live observation: ~700 KB uploaded. 1.5 MB ceiling = ~2× headroom for
        // chunk-packing variability (sibling small files in the same chunk as the
        // rotated bundle may also re-upload).
        const bytesUploaded = parseBytesUploadedFromOutput(r2.stdout);
        if (bytesUploaded > 1_500_000) {
          failWith({
            scenario: "S-INC-ASSET-ROTATION",
            message: `bytes uploaded ${(bytesUploaded / 1024 / 1024).toFixed(2)} MB > 1.5 MB ceiling`,
            context: r2.stdout,
            keywords: ["Probed", "Cache", "Manifest"],
            hint: "a 466 KB asset rotation should re-upload ≤ 1.5 MB; significantly more suggests a chunk-alignment regression.",
          });
        }

        console.log(`   ✓ Asset rotation: uploaded ${(bytesUploaded / 1024 / 1024).toFixed(2)} MB ` +
                    `(rotated bundle is 466 KB).`);
      } finally {
        try { fs.rmSync(fix1, { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe("S-INC — incremental upload v2 (chunk reuse on re-deploy)", { skip: SCENARIO !== "s-inc" }, () => {
    test(`re-deploy identical content reuses chunks via gateway probe`, { timeout: (DEPLOY_TIMEOUT_MS + 30_000) * 2 }, async () => {
      const label = pickIncLabel();
      // 5MB fixture so chunks > 1 — gives the incremental path actual chunk
      // reuse to exercise. The mutated SPA fixture (~500B) fits in a single
      // chunk; a single chunk always changes between deploys because the
      // embedded manifest's `deployed_at` shifts.
      const fix1 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-1-"));
      buildIncrementalFixture({ targetDir: fix1, seed: "s-inc", runTag: RUN_TAG + "-inc" });
      try {
        const r1 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.dot`),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-INC", step: "first deploy" });
        const cid1 = parseDeployedCid(r1.stdout, "S-INC");
        const expected1 = ("0x" + encodeContenthash(cid1)).toLowerCase();
        await readContenthashWithRetry(label, expected1);

        // The gateway needs a moment to index newly-stored content before the
        // 2nd deploy can fetch the embedded manifest. Poll HEAD on the root
        // URL (the deployed CID's bytes ARE the inner CAR; v2 fetch grabs
        // the whole CAR and parses locally rather than sub-path GET — see
        // src/manifest-fetch.ts). Falls through after timeout; the test's
        // assertions will catch a stale gateway clearly.
        const gateway = await resolveE2eGateway();
        const rootUrl = `${gateway}/ipfs/${cid1}`;
        const propagationDeadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < propagationDeadline) {
          try {
            const res = await fetch(rootUrl, { method: "HEAD" });
            if (res.status === 200) break;
          } catch { /* network blips OK */ }
          await new Promise((r) => setTimeout(r, 10_000));
        }

        // Second deploy of the same content — incremental flow should skip
        // chunks for the stable files (vendor.js, runtime.wasm, css, fonts,
        // images). Only the chunk(s) containing the embedded manifest +
        // index.html differ between deploys (deployed_at moves).
        const fix2 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-2-"));
        buildIncrementalFixture({ targetDir: fix2, seed: "s-inc", runTag: RUN_TAG + "-inc" });
        try {
          const r2 = await runBulletinDeploy({
            args: buildArgs(fix2, `${label}.dot`),
            env: rpcEnv(),
            timeoutMs: DEPLOY_TIMEOUT_MS,
          });
          assertDeploySucceeded(r2, { scenario: "S-INC", step: "second deploy" });

          // Regression canary: chunk-skip rate floor. A drop below 60 % typically
          // signals a chunk-alignment bug (the v3 file-aligned chunker should
          // produce > 90 % section-1 hits on unchanged stable files).
          const skipRate = parseChunkSkipRateFromOutput(r2.stdout, "S-INC");
          if (skipRate < 0.6) {
            failWith({
              scenario: "S-INC",
              message: `chunk-skip regression: ${(skipRate * 100).toFixed(1)} % < 60 %`,
              context: r2.stdout,
              keywords: ["Probed", "Cache", "Manifest"],
              hint: "likely a chunk-alignment bug. The v3 file-aligned chunker should produce > 90 % section-1 hits on unchanged stable files.",
            });
          }

          // Bytes-uploaded gate: byte-identical redeploy should upload only the
          // section 0 (manifest) + section 2 (root dir + volatile) overhead, which
          // is well under 50 KB for the synthetic 5 MB fixture. Catches any
          // regression where incremental upload silently stops working.
          const bytesUploaded = parseBytesUploadedFromOutput(r2.stdout);
          if (bytesUploaded > 50_000) {
            failWith({
              scenario: "S-INC",
              message: `bytes uploaded ${(bytesUploaded / 1024).toFixed(1)} KB > 50 KB ceiling on byte-identical redeploy`,
              context: r2.stdout,
              keywords: ["Probed", "Cache", "Manifest"],
              hint: "live observation is ~10-20 KB. Significantly more means incremental upload silently stopped working.",
            });
          }

          // Manifest fetch path: must be either embedded (optimized) or
          // heuristic_fallback (graceful degradation when gateway times out).
          // Both produce correct deploys; we just confirm the prev-manifest
          // pipeline ran (didn't silently bypass).
          assertStdoutMatches(r2.stdout, /Manifest:\s+(embedded|heuristic_fallback)/, {
            scenario: "S-INC",
            what: "prev-manifest pipeline (embedded or heuristic_fallback)",
            hint: "second deploy should run the prev-manifest pipeline (not bypass it).",
          });
          assertStdoutMatches(r2.stdout, /Probed:\s+\d+ chunks\b/, {
            scenario: "S-INC",
            what: "probe summary line",
            hint: "second deploy should print a 'Probed: N chunks' summary.",
          });
          assertStdoutMatches(r2.stdout, /Cache:\s/, {
            scenario: "S-INC",
            what: "incremental Cache summary line",
            hint: "second deploy should print a 'Cache:' summary line.",
          });

          // CID may shift (deployed_at in manifest changes), but DotNS must still
          // resolve the new contenthash on-chain.
          const cid2 = parseDeployedCid(r2.stdout, "S-INC");
          const expected2 = ("0x" + encodeContenthash(cid2)).toLowerCase();
          await readContenthashWithRetry(label, expected2);
        } finally {
          fs.rmSync(fix2, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(fix1, { recursive: true, force: true });
      }
    });
  });

  // S8 exercises the chunk-upload retry/reconnect path under fault injection
  // — the actual failure mode behind #142 / #216 / #271. A local WS reverse
  // proxy (test/helpers/ws-fault-proxy.mjs) sits between bulletin-deploy and
  // the real Bulletin RPC and injects mid-upload disconnects via terminate()
  // (abrupt TCP close, closer to chain-side `WS halt (3)` than a graceful
  // close-with-code).
  //
  // Two test cases:
  //   - drop-once: one mid-upload halt → deploy survives via reconnect.
  //                 Regression guard for #278's fix (suppress unhandled
  //                 connection errors so doReconnect can engage).
  //   - rapid-storm: drops every 2s → deploy bails with the new
  //                  "Retry budget exhausted" error (#271). Regression
  //                  guard for the budget bound NOT being silently broken,
  //                  AND for #278's suppression NOT trapping us in an
  //                  infinite loop.
  //
  // Uses a fresh per-run label (pickFreshRunLabel("s8smoke")) so concurrent
  // nightly runs don't race on the same domain. Both subtests use the same
  // label binding — pick once at describe scope, use twice. Keep the two
  // subtests serial: both use the same signer/account on paseo-next-v2, so
  // overlapping deploys can race nonces and make fallback inclusion checks
  // ambiguous.
  //
  // Background — what the harness validates:
  //   - PAPI's getProxy().connect re-broadcasts active transactions by
  //     iterating a Map it then mutates inside the iteration callback.
  //     V8's forEach visits the new entries, generating thousands of
  //     4 MB JSON-RPC strings until OOM. Heap snapshot at near-OOM
  //     showed proxyOpaque IDs counting from 4 to 364 from a single
  //     halt — i.e. PAPI emitted ~360 distinct broadcasts during one
  //     reconnect cycle. Tracked upstream as bulletin-deploy #287.
  //   - Workaround in src/deploy.ts: hook onStatusChanged for
  //     WsEvent.CLOSE/ERROR, synchronously call client.destroy() so
  //     PAPI's forEach guard (state.type === 0) short-circuits before
  //     the next iteration step. Combined with a flag the chunk-upload
  //     loop checks before each batch (so halts in the gap between
  //     batches still trigger doReconnect rather than running the next
  //     batch against a destroyed client).
  describe("S8 — chunk-upload survives WS halt + budget bails clean on storm", { skip: SCENARIO !== "s8", concurrency: false }, () => {
    const label = pickFreshRunLabel("s8smoke");
    test("drop-once mid-upload: deploy succeeds via reconnect, budget never trips", { timeout: DEPLOY_TIMEOUT_MS + 60_000 }, async () => {
      // Multi-chunk fixture so the upload spans long enough that mid-upload
      // is a real point in time (not after-the-fact). 7 MB → 4 chunks of 2 MB.
      const { fixtureDir } = await makeMultiChunkFixture(`s8a-${RUN_TAG}`);
      // dropAtMs=40s lands well into chunk submission. With incremental upload,
      // the manifest fetch (up to ~30s with gateway timeout) precedes the chunk
      // loop, so drops before that window hit the probe phase, not doReconnect.
      const proxy = await startFaultProxy({
        mode: "once",
        dropAtMs: 40_000,
        upstream: await resolveE2eBulletinRpc(),
      });
      try {
        const args = buildArgs(fixtureDir, `${label}.dot`);
        const { code, stdout, stderr } = await runBulletinDeploy({
          args,
          env: { BULLETIN_RPC: proxy.url },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        if (code !== 0) {
          failWith({
            scenario: "S8",
            message: `drop-once deploy must succeed (exit ${code}, drops injected: ${proxy.stats.dropsInjected})`,
            context: stderr,
            keywords: ["Error", "Stale", "Connection"],
            hint: "S8 drop-once injects one mid-upload WS drop; the CLI must reconnect and finish the upload. Any non-zero exit here means the reconnect logic broke — check src/deploy.ts WS-halt handling.",
          });
        }
        // The drop must actually have fired — otherwise we proved nothing.
        assert.ok(proxy.stats.dropsInjected >= 1, `proxy injected ${proxy.stats.dropsInjected} drops; expected ≥1`);
        // No assertion on the reconnect log line: the drop can land outside the
        // chunk-upload window (e.g. during DotNS root-node confirmation), in which
        // case PAPI's WsProvider reconnects transparently without our code logging.
        // The invariant is code===0 + dropsInjected>=1, not which reconnect path fired.
        // Budget must NOT have tripped on a single drop.
        assert.doesNotMatch(stderr + stdout, /Retry budget exhausted/, "budget should not trip on a single transient drop");
      } finally {
        await proxy.close();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    test("rapid-storm: deploy doesn't crash with uncaught (either survives or bails clean)", { timeout: DEPLOY_TIMEOUT_MS + 60_000 }, async () => {
      const { fixtureDir } = await makeMultiChunkFixture(`s8b-${RUN_TAG}`);
      // 10s warmup so auth completes, then drops every 2s for a BOUNDED 40s window,
      // then the storm stops so the deploy can recover and complete. The storm must
      // be bounded: the progress-aware retry budget (#864) recovers through an
      // *unbounded* storm indefinitely rather than bailing, so it would never reach a
      // clean outcome and would hit the job timeout. With a bounded burst we assert the
      // stronger property — the deploy SURVIVES the storm and finishes (clean success).
      // A clean "Retry budget exhausted" bail is still acceptable; only an uncaught
      // crash (exit 2) is a regression.
      const proxy = await startFaultProxy({
        mode: "rapid",
        initialDelayMs: 10_000,
        dropEveryMs: 2_000,
        dropDurationMs: 40_000,
        upstream: await resolveE2eBulletinRpc(),
      });
      try {
        const args = buildArgs(fixtureDir, `${label}.dot`);
        const { code, stdout, stderr } = await runBulletinDeploy({
          args,
          env: { BULLETIN_RPC: proxy.url },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        const combined = stderr + stdout;
        // Acceptable: clean success (PAPI absorbed all drops) OR clean
        // budget bail. Unacceptable: exit 2 from uncaughtException, which
        // would mean #278's suppression broke.
        const cleanSuccess = code === 0;
        const cleanBail = code === 1 && /Retry budget exhausted|max reconnections.*exhausted|ChainHead disjointed/i.test(combined);
        if (!(cleanSuccess || cleanBail)) {
          failWith({
            scenario: "S8",
            message: `deploy must either survive cleanly or bail with budget/reconnect-exhausted error or ChainHead disjointed; got exit ${code}. Drops injected: ${proxy.stats.dropsInjected}`,
            context: stderr,
            keywords: ["Error", "Stale", "Connection"],
            hint: "an uncaught crash (exit 2) means #278's suppression broke.",
          });
        }
        // Either way, must not crash with uncaught.
        assert.doesNotMatch(combined, /Suppressed.*connection error.*[A-Z][a-zA-Z]*Error: (?!.*WS halt|.*heartbeat|.*Unable to connect)/, "no non-connection error should leak through the suppression filter");
      } finally {
        await proxy.close();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S9 — parallel deploys from same direct signer (nonce-collision resilience)", { skip: SCENARIO !== "s9", concurrency: false }, () => {
    test("two fresh-label deploys from same key both exit 0, nonce-advance fires on collision", { timeout: DEPLOY_TIMEOUT_MS * 2 + 5 * 60 * 1000 + 60_000 }, async () => {
      // Prefix must be ≥6 chars per PopRules (`baselength <= 5 → Reserved`).
      // The old 3-char `s9a`/`s9b` prefixes got trimmed-to-base by the
      // sanitizer and rejected (see e2e run 26648857693 / v0.7.30-rc.1 S9).
      const labelA = pickFreshRunLabel("s9racea");
      const labelB = pickFreshRunLabel("s9raceb");

      function s9Args(fixtureDir, label) {
        return [
          fixtureDir,
          `${label}.dot`,
          "--tag", process.env.DEPLOY_TAG,
          "--mnemonic", ALICE_MNEMONIC,
          ...(MERKLE === "js" ? ["--js-merkle"] : []),
          ...(directSignerDerivationPath() ? ["--derivation-path", directSignerDerivationPath()] : []),
          ...(PAD_ENV ? ["--env", PAD_ENV] : []),
        ];
      }

      // Multi-chunk fixture (~7 MB / 4 chunks) gives ~30-60s upload so both
      // deploys overlap on Bulletin chain chunk txs and contend on the same nonce.
      // GRANDPA wait is capped at 30s (vs 90s default) because S9 tests nonce
      // collision resilience, not GRANDPA recovery — lower wait keeps runtime
      // within the 15-min per-deploy limit on slower testnets (paseo-next-v2).
      const S9_GRANDPA_WAIT_MS = 30_000;
      const { fixtureDir: fixA } = await makeMultiChunkFixture(`s9a-${RUN_TAG}`);
      const { fixtureDir: fixB } = await makeMultiChunkFixture(`s9b-${RUN_TAG}`);
      try {
        const s9Env = { ...rpcEnv(), BULLETIN_GRANDPA_NATURAL_WAIT_MS: String(S9_GRANDPA_WAIT_MS) };
        // Per-deploy timeout extends DEPLOY_TIMEOUT_MS by 5 min to absorb
        // nonce-collision retries on slower testnets (paseo-next-v2 12s blocks).
        const S9_DEPLOY_TIMEOUT_MS = DEPLOY_TIMEOUT_MS + 5 * 60 * 1000;
        const [rA, rB] = await Promise.all([
          runBulletinDeploy({ args: s9Args(fixA, labelA), env: s9Env, timeoutMs: S9_DEPLOY_TIMEOUT_MS }),
          runBulletinDeploy({ args: s9Args(fixB, labelB), env: s9Env, timeoutMs: S9_DEPLOY_TIMEOUT_MS }),
        ]);

        assertDeploySucceeded(rA, { scenario: "S9", step: "deploy A" });
        assertDeploySucceeded(rB, { scenario: "S9", step: "deploy B" });

        const combined = rA.stdout + rA.stderr + rB.stdout + rB.stderr;
        // Accept ANY of the deploy's nonce-collision-recovery signals — not just
        // the "consumed → included" heuristic (deploy.ts nonce-advance fallback /
        // consumed-heuristic logs), but crucially the "Nonce-collision re-upload"
        // line (deploy.ts:1346), which is the DEFINITIVE evidence the resilience
        // path engaged: it only fires when a chunk's nonce advanced under it AND
        // the chunk was actually missing, forcing a fresh-nonce re-upload. The
        // earlier grep missed this — #1100 saw a run emit "Nonce-collision
        // re-upload" 34× (both deploys succeeded, recovery worked) while the old
        // regex's phrases appeared 0× → false red. This is a stronger signal, not
        // a weaker assertion.
        assert.match(
          combined,
          /(nonce (advanced past \d+|consumed \(current=|\d+ consumed)|Nonce-collision re-upload|nonce-advance collision)/i,
          ">> FAIL: S9: neither parallel deploy logged any nonce-collision-recovery signal " +
            "(expected one of: 'Nonce-collision re-upload', 'nonce advanced past N', or 'nonce N consumed (current=...)'). " +
            "Both use the same signer, so their Bulletin chunk txs share a nonce counter and MUST contend. " +
            "If this fails, the deploys ran sequentially / fixture overlap was insufficient (the race did not stage) — " +
            "widen makeMultiChunkFixture rather than weakening this check; not necessarily a product defect (check timestamps).",
        );
      } finally {
        fs.rmSync(fixA, { recursive: true, force: true });
        fs.rmSync(fixB, { recursive: true, force: true });
      }
    });
  });

  describe("S-GRANDPA-REUPLOAD — stale finalized head must NOT trigger re-upload (#1049)", { skip: SCENARIO !== "s-grandpa-reupload", concurrency: false }, () => {
    // staleDurationMs (15s) > NATURAL_WAIT_MS (10s): the proxy stale window
    // outlasts the natural wait, so the finality-lag path fires reliably.
    //
    // Pre-#1049 this scenario asserted the OLD (buggy) behavior: a re-upload
    // fired and succeeded. That was the exact regression the issue reports —
    // the proxy only freezes chain_getFinalizedHead; chunks are genuinely
    // present in best-block the entire time. Post-#1049, the correct
    // behavior is to detect best-block presence and skip re-upload entirely,
    // then let GRANDPA catch up (bounded) once the stale window ends.
    const STALE_DURATION_MS = 15_000;
    const NATURAL_WAIT_MS = 10_000;
    const LAGGING_WAIT_MS = 20_000;

    test("stale chain_getFinalizedHead does not trigger re-upload; deploy exits 0", { timeout: DEPLOY_TIMEOUT_MS + STALE_DURATION_MS + 60_000 }, async () => {
      const rpc = await resolveE2eBulletinRpc();
      const proxy = await startFaultProxy({
        mode: "stale-finalized-head",
        staleDurationMs: STALE_DURATION_MS,
        upstream: rpc,
      });
      const { fixtureDir } = await makeMultiChunkFixture(`s-grandpa-reupload-${RUN_TAG}`);
      try {
        const label = pickFreshRunLabel("sgreupload");
        const args = [
          fixtureDir,
          `${label}.dot`,
          "--tag", process.env.DEPLOY_TAG,
          "--mnemonic", ALICE_MNEMONIC,
          ...(directSignerDerivationPath() ? ["--derivation-path", directSignerDerivationPath()] : []),
          ...(PAD_ENV ? ["--env", PAD_ENV] : []),
        ];
        const result = await runBulletinDeploy({
          args,
          env: {
            BULLETIN_RPC: proxy.url,
            BULLETIN_GRANDPA_NATURAL_WAIT_MS: String(NATURAL_WAIT_MS),
            BULLETIN_GRANDPA_LAGGING_WAIT_MS: String(LAGGING_WAIT_MS),
          },
          timeoutMs: DEPLOY_TIMEOUT_MS + STALE_DURATION_MS,
        });

        if (result.code !== 0) {
          failWith({
            scenario: "S-GRANDPA-REUPLOAD",
            message: `deploy must exit 0 despite stale finalized head; got exit ${result.code}`,
            context: result.stderr,
            keywords: ["Error", "finalised", "missing", "lagging"],
            hint: "Proxy held a stale chain_getFinalizedHead hash for 15s so chunks appear absent at finalized head, " +
              "but they are genuinely present in best-block the whole time. Code must detect best-block presence, " +
              "skip re-upload, and succeed once GRANDPA catches up (or after the bounded lagging wait).",
          });
        }

        assert.ok(
          proxy.stats.dropsInjected >= 1,
          `>> FAIL: S-GRANDPA-REUPLOAD: proxy intercepted ${proxy.stats.dropsInjected} chain_getFinalizedHead responses; ` +
            "expected ≥ 1 — if 0, the GRANDPA probe never called chain_getFinalizedHead (path may have been skipped)",
        );

        const combined = result.stdout + result.stderr;
        assert.match(
          combined,
          /chunks? (?:not yet finalised|still missing after wait)/i,
          ">> FAIL: S-GRANDPA-REUPLOAD: expected 'chunks not yet finalised' log — stale-head path did not fire",
        );
        assert.match(
          combined,
          /finality-lagging/i,
          ">> FAIL: S-GRANDPA-REUPLOAD: expected a 'finality-lagging' log — deploy.ts did not detect best-block " +
            "presence for chunks missing only at (stale) finalized head",
        );
        assert.doesNotMatch(
          combined,
          /re-upload(?:ed|ing)/i,
          ">> FAIL: S-GRANDPA-REUPLOAD: a re-upload fired even though chunks were present in best-block the whole " +
            "time — this is exactly the #1049 regression (stale finalized head must never cause a re-upload)",
        );
      } finally {
        await proxy.close();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S-MORTALITY — chunk tx mortal era expiry triggers retry path", { skip: SCENARIO !== "s-mortality", concurrency: false }, () => {
    // What this scenario validates: when chunk txs hit their mortal era and
    // expire, the production retry path (storeChunkedContent retry loop)
    // detects the expiry and reissues the tx with a fresh nonce. Whether
    // the deploy ultimately succeeds is NOT the test's concern — the
    // artificial expiry pressure may overwhelm even the resilience layer
    // on a slow chain. What we measure is whether the resilience FIRED.
    //
    // Pass condition: the "mortal era expiry — reissuing with fresh nonce"
    // log line appears in the deploy output (sufficient evidence the retry
    // path engaged).
    // Fail condition: the log line never appears (resilience didn't engage,
    // either because no chunk expired or because the code path is broken).
    // Deploy exit code: explicitly NOT asserted. Either outcome is fine.
    //
    // Label uses noStatusRunLabel (PoP-independent) so the test works in
    // both PopFull and NoStatus signer environments. Period=4 (~24s on 6s
    // blocks) is generous enough to let SOME chunks land while still
    // triggering expiry on slower batches.
    test("forced chunk expiry engages the retry path", { timeout: DEPLOY_TIMEOUT_MS + 3 * 60 * 1000 }, async () => {
      const label = noStatusRunLabel("smortality");
      const { fixtureDir } = await makeMultiChunkFixture(`s-mortality-${RUN_TAG}`);
      try {
        const args = [
          fixtureDir,
          `${label}.dot`,
          "--tag", process.env.DEPLOY_TAG,
          "--mnemonic", ALICE_MNEMONIC,
          ...(MERKLE === "js" ? ["--js-merkle"] : []),
          ...(directSignerDerivationPath() ? ["--derivation-path", directSignerDerivationPath()] : []),
          ...(PAD_ENV ? ["--env", PAD_ENV] : []),
        ];
        const result = await runBulletinDeploy({
          args,
          env: {
            ...(PAD_ENV ? {} : { BULLETIN_RPC: RPC }),
            BULLETIN_CHUNK_MORTALITY_PERIOD: "4",
            // Forced expiry pushes the global recovery-budget guard
            // (RETRY_BUDGET_MAX_EVENTS=5 in RETRY_BUDGET_WINDOW_MS=30000)
            // into the path of the mortality-retry path. Without raising
            // the budget, "Retry budget exhausted" fires before any
            // chunk reaches its mortal era — different resilience layer
            // wins the race. Raising the budget gives the mortality path
            // room to engage and be observed in the log.
            BULLETIN_RETRY_BUDGET_MAX: "30",
            BULLETIN_RETRY_BUDGET_WINDOW_MS: "180000",
          },
          timeoutMs: DEPLOY_TIMEOUT_MS + 3 * 60 * 1000,
        });

        const combined = result.stdout + result.stderr;
        // The resilience layer for failed chunk submissions has two log
        // surfaces, depending on how the chain rejected the tx:
        //   - "Retrying chunk N (attempt X/Y)" — generic retry log, fires
        //     for any failure mode (BadProof, subscription error,
        //     isValid:false, timeout). storeChunkedContent retry loop.
        //   - "mortal era expiry — reissuing with fresh nonce" — specific
        //     path for isValid:false (clean detection of mortality on the
        //     submission side, before the chain rejects).
        // Either log appearing in the deploy output is sufficient evidence
        // the resilience mechanism engaged. With BULLETIN_CHUNK_MORTALITY_PERIOD=4
        // and several chunks, at least one chunk should hit retry under
        // organic chain timing.
        const resilienceFired =
          /Retrying chunk \d+ \(attempt \d+\/\d+\)/i.test(combined) ||
          /mortal era expiry — reissuing with fresh nonce/i.test(combined);
        assert.ok(
          resilienceFired,
          ">> FAIL: S-MORTALITY: resilience didn't fire — no chunk-retry log appeared. " +
            "BULLETIN_CHUNK_MORTALITY_PERIOD=4 means chunk txs expire after ~4 blocks (~24s on paseo-next-v2). " +
            "If no retry log appeared, the chain was unusually stable (all chunks landed first try — consider " +
            "reducing the period further) or the retry code path is broken (check storeChunkedContent retry " +
            "loop in src/deploy.ts).\n\nstderr tail:\n" + (result.stderr ?? "").slice(-500),
        );
        // Deploy exit code is NOT asserted. Artificial expiry pressure may
        // overwhelm even the resilience layer (per-chunk retries exhaust at
        // MAX_CHUNK_RETRIES=3, or recovery-budget exhausts at 5/30s); both
        // are acceptable outcomes — we've already proven the retry mechanism
        // engaged via the log assertion above. Tests of resilience layers
        // measure that the mechanism FIRED, not that the deploy succeeded.
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  // S-SUBDOMAIN — subdomain registration under a fresh parent (#655).
  // Deploys three legs under a fresh-per-run parent label:
  //   basic       — happy-path subdomain (app.<parent>.dot)
  //   long-digits — regression guard for #654 trailing-digit sanitiser bug (pr265.<parent>.dot)
  //   orphan      — deploy to <sub>.nonexistent<token>.dot with no parent; must fail with
  //                 naming.subdomain_orphan classification (exit 78, NonRetryableError)
  describe("S-SUBDOMAIN — subdomain registration under a fresh parent", { skip: SCENARIO !== "s-subdomain", concurrency: false }, () => {
    // Scoped to this describe block; set in before() and read by the three legs.
    let freshParent = "";

    before(async () => {
      // Register a fresh parent name for this run so legs don't depend on
      // persistent fixture state. Mirrors exactly how S2 does fresh registration.
      freshParent = pickFreshRunLabel("e2esub");
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${freshParent}.dot`),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S-SUBDOMAIN before()" });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    // Leg 1: basic happy-path subdomain deploy.
    test("basic — app.<parent>.dot deploys and resolves on-chain", { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const target = `app.${freshParent}.dot`;
      const { fixtureDir } = await mutateFixture(RUN_TAG + "-sub-basic");
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, target),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S-SUBDOMAIN basic" });

        const deployedCid = parseDeployedCid(stdout, "S-SUBDOMAIN basic");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        // readContenthashWithRetry takes the bare label (no .dot); getContenthash
        // does namehash("app.<parent>.dot") — correct subnode hash.
        const onChain = await readContenthashWithRetry(`app.${freshParent}`, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S-SUBDOMAIN basic", label: target });
        // Owner check is implicit: only the parent owner can write to app.<parent>.dot
        // via setSubnodeOwner; a contenthash readback that matches proves successful registration.
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    // Leg 2: long-digits regression guard (#654 trailing-digit sanitiser bug).
    // parseDomainName now uses skipSanitize:true for sublabels, so "pr265" is
    // preserved as-is. This leg MUST pass on current main; the assertion at the
    // subnode "pr265.<parent>" would return empty if the digit suffix was stripped.
    test("long-digits — pr265.<parent>.dot sublabel preserved (regression guard #654)", { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const target = `pr265.${freshParent}.dot`;
      const { fixtureDir } = await mutateFixture(RUN_TAG + "-sub-digits");
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, target),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S-SUBDOMAIN long-digits" });

        const deployedCid = parseDeployedCid(stdout, "S-SUBDOMAIN long-digits");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        // Querying exactly "pr265.<freshParent>" — if the sublabel was sanitised to
        // "pr" this read would return "0x" (empty) and assertOnChainMatches would fail,
        // catching the regression.
        const onChain = await readContenthashWithRetry(`pr265.${freshParent}`, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S-SUBDOMAIN long-digits", label: target });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    // Leg 3: orphan — parent does NOT exist; must fail deterministically.
    // noStatusRunLabel produces a PoP-independent unique label (appends x00 to
    // prevent trailing-digit sanitiser from reducing the uniqueness guarantee).
    // isExpectedError("Cannot deploy ...: parent ....dot is owned by no one") → true
    // → deploy.expected='true', exit 78 (NonRetryableError → EXIT_CODE_NO_RETRY).
    test("orphan — sub.<nonexistent>.dot rejected with exit 78", { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const orphanParent = noStatusRunLabel("nonexist");
      const target = `sub.${orphanParent}.dot`;
      const { fixtureDir } = await mutateFixture(RUN_TAG + "-sub-orphan");
      try {
        const { code, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, target),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        if (code !== 78) {
          failWith({
            scenario: "S-SUBDOMAIN orphan",
            message: `expected EXIT_CODE_NO_RETRY (78), got ${code}`,
            context: stderr,
            keywords: ["Cannot deploy", "parent", "owned", "subdomain"],
            hint: "S-SUBDOMAIN orphan deploys to a subdomain whose parent does not exist; the CLI must refuse with exit 78 (NonRetryableError). A non-78 exit means either the guard path is broken or the parent was unexpectedly registered.",
          });
        }
        assert.match(
          stderr,
          /Cannot deploy\s+[\w.-]+\.dot:\s*parent\s+[\w.-]+\.dot\s+is owned by no one/i,
          `>> FAIL: S-SUBDOMAIN orphan: expected "Cannot deploy ... parent ....dot is owned by no one" in stderr — naming.subdomain_orphan guard did not fire`,
        );
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S-CAR — deploy from pre-built CAR file (--input-car)", { skip: SCENARIO !== "s-car" }, () => {
    test(`deploy pool/${MERKLE} via --input-car matches normal deploy CID`, { timeout: DEPLOY_TIMEOUT_MS * 2 + 60_000 }, async () => {
      // Use a fresh per-run label so first deploy hits register() rather than
      // racing with S1 on the stable pool label. Env var LABEL lets the nightly workflow
      // pass a unique per-run label; default falls back to a local stable label.
      const label = process.env.LABEL ?? (signerPopStatus >= 2 ? "e2escarpool.dot" : "e2escarpool01.dot");
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      const dumpPath = path.join(os.tmpdir(), `e2e-s-car-${Date.now()}.car`);
      try {
        // Step 1: Normal deploy + CAR dump — establishes the expected CID.
        const r1 = await runBulletinDeploy({
          args: buildArgs(fixtureDir, label),
          env: { ...rpcEnv(), PAD_DUMP_CAR: dumpPath },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-CAR", step: "first (normal) deploy" });
        assert.ok(fs.existsSync(dumpPath),
          `PAD_DUMP_CAR should have written ${dumpPath}`);
        const cid1 = parseDeployedCid(r1.stdout, "S-CAR");

        // Step 2: Redeploy the same content via --input-car.
        // No build-dir positional arg when --input-car is set.
        const r2 = await runBulletinDeploy({
          args: buildInputCarArgs(dumpPath, label),
          env: rpcEnv(),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r2, { scenario: "S-CAR", step: "--input-car deploy" });
        const cid2 = parseDeployedCid(r2.stdout, "S-CAR");

        // CID from --input-car must exactly match what the normal deploy computed.
        assert.strictEqual(cid2, cid1,
          `--input-car CID (${cid2}) must match normal deploy CID (${cid1})`);

        // On-chain DotNS contenthash must reflect the --input-car deploy.
        const expectedHash = ("0x" + encodeContenthash(cid2)).toLowerCase();
        const labelBare = label.replace(/\.dot$/, "");
        const onChain = await readContenthashWithRetry(labelBare, expectedHash, 6, 10_000);
        assertOnChainMatches(onChain.toLowerCase(), expectedHash, { scenario: "S-CAR", label: labelBare });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
        fs.rmSync(dumpPath, { force: true });
      }
    });
  });
});
