import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const repoRoot = path.resolve(import.meta.dirname, "..");
const BIN_SOURCE_PATH = path.join(repoRoot, "bin/polkadot-app-deploy");

// Deliberately synthetic, clearly-fixture-shaped labels — never a real
// consumer's domain.
const CONFIG_LABEL = "manifestpreflighttestcfg";
const DEPLOY_LABEL = "manifestpreflighttestarg";

async function makeFixture({ configDomain }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "polkadot-app-deploy-manifest-preflight-"));
  await fs.writeFile(path.join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const buildDir = path.join(dir, "build");
  await fs.mkdir(buildDir, { recursive: true });
  await fs.writeFile(path.join(buildDir, "index.html"), "<html></html>");
  await fs.mkdir(path.join(dir, "dist/app"), { recursive: true });
  await fs.writeFile(path.join(dir, "dist/app", "index.html"), "<html></html>");
  const config = {
    domain: configDomain,
    displayName: "Fixture",
    description: "Fixture app for #1572 bin preflight test.",
    icon: { path: "./icon.png", format: "png" },
    executables: [{ kind: "app", path: "./dist/app", appVersion: [1, 0, 0] }],
  };
  await fs.writeFile(
    path.join(dir, "polkadot-app-deploy.config.mjs"),
    `export default ${JSON.stringify(config)};\n`,
  );
  return { dir, buildDir };
}

// Defense-in-depth, independent of reconcileManifestDomain's own correctness:
// Node's permission model (--permission, no --allow-net) denies ANY network
// API at the OS/runtime level — fs is explicitly re-allowed (config/build-dir/
// package.json reads), but net is not, so even if a future refactor silently
// broke the pre-deploy wiring without touching the exact source strings the
// sibling wiring-test greps for, this test could not fall through into a real
// deploy() connecting to paseo-next-v2 — it would hit ERR_ACCESS_DENIED
// instead.
function runCli(args) {
  return execFileSync(
    process.execPath,
    ["--permission", "--allow-fs-read=*", "--allow-fs-write=*", BIN_SOURCE_PATH, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
    },
  );
}

describe("bin/polkadot-app-deploy: #1572 pre-deploy manifest domain reconciliation", () => {
  // Note: no live-subprocess test exercises the MATCHING-domain path here — it
  // would need a real (or convincingly unreachable) chain endpoint to stop
  // short of an actual deploy(), and the matching-domain reconciliation
  // behavior itself is already exhaustively covered, with no chain risk at
  // all, by the pure-function `reconcileManifestDomain` tests in
  // test/product-manifest.test.js. This file's job is only to confirm
  // bin/polkadot-app-deploy's WIRING — that it's actually called, with the
  // right arguments, before deploy() — which the mismatched-domain subprocess
  // test below and the source-level check further down both do without ever
  // letting deploy() run.
  test("mismatched label exits before deploy() runs at all (NO_RETRY, nothing uploaded, no network)", async () => {
    // paseo-next-v2's real TLD is ".paseo" — same TLD as the deploy target,
    // different LABEL, so this exercises the "resolves to X, does not match
    // Y" branch specifically (not the separate wrong-env-TLD branch, already
    // covered by test/product-manifest.test.js's reconcileManifestDomain
    // suite).
    const { dir, buildDir } = await makeFixture({ configDomain: `${CONFIG_LABEL}-other.paseo` });
    try {
      runCli([
        buildDir,
        DEPLOY_LABEL,
        "--config",
        path.join(dir, "polkadot-app-deploy.config.mjs"),
        "--env",
        "paseo-next-v2",
      ]);
      assert.fail(
        ">> FAIL: bin-manifest-preflight mismatched-label-exits-before-deploy: expected the CLI to exit non-zero, it exited 0",
      );
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      assert.equal(
        error.status,
        78, // EXIT_CODE_NO_RETRY (src/errors.ts) — a mismatch must be non-retryable
        `>> FAIL: bin-manifest-preflight mismatched-label-exits-before-deploy: expected exit code 78 (EXIT_CODE_NO_RETRY), got ${error.status}: ${output.slice(0, 800)}`,
      );
      assert.match(
        output,
        /does not match|resolves to/,
        `>> FAIL: bin-manifest-preflight mismatched-label-exits-before-deploy: expected a domain-reconciliation error naming the mismatch, got: ${output.slice(0, 800)}`,
      );
      assert.doesNotMatch(
        output,
        /DEPLOYING TO TESTNET|Uploading|Storage:|Merkleizing|Connecting to Bulletin/,
        `>> FAIL: bin-manifest-preflight mismatched-label-exits-before-deploy: must fail BEFORE deploy() ever runs (no "DEPLOYING TO TESTNET" banner, no upload/connect output), but saw: ${output.slice(0, 800)}`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("bin/polkadot-app-deploy: #1572 wiring (source-level, no subprocess/network)", () => {
  test("reconcileManifestDomain is called, using the config domain preflightProductConfig loaded, BEFORE deploy() runs", () => {
    const src = fsSync.readFileSync(BIN_SOURCE_PATH, "utf8");
    const importIdx = src.indexOf("await import(\"../dist/index.js\")");
    assert.ok(
      importIdx >= 0,
      ">> FAIL: bin-wiring reconcile-call-present: bin/polkadot-app-deploy no longer dynamically imports from ../dist/index.js in the preflight block",
    );
    const reconcileCallIdx = src.indexOf("reconcileManifestDomain(loadedConfig.config.domain, domain, envTld, loadedConfig.sourcePath)");
    assert.ok(
      reconcileCallIdx > importIdx,
      ">> FAIL: bin-wiring reconcile-call-present: expected a reconcileManifestDomain(loadedConfig.config.domain, domain, envTld, loadedConfig.sourcePath) call after the preflightProductConfig import — got none, or the exact argument shape changed. If the shape genuinely changed, update this string alongside it.",
    );
    const deployCallIdx = src.indexOf("await deploy(buildDir, domain,");
    assert.ok(
      deployCallIdx > 0,
      ">> FAIL: bin-wiring reconcile-call-present: expected to find the `await deploy(buildDir, domain,` call site to compare ordering against",
    );
    assert.ok(
      reconcileCallIdx < deployCallIdx,
      ">> FAIL: bin-wiring reconcile-before-deploy: reconcileManifestDomain must be called BEFORE deploy() — found it AFTER, which reopens #1572 (upload/registration would run before the domain mismatch is caught)",
    );
  });
});
