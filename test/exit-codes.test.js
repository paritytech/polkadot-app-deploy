import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { createCliTestEnv } from "./helpers/isolated-home.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "bin/polkadot-app-deploy");

// Creates a minimal build directory with one file so the bin doesn't exit
// early with "build directory does not exist".
function makeTmpSite() {
  const dir = mkdtempSync(join(tmpdir(), "bd-exit-code-test-"));
  writeFileSync(join(dir, "index.html"), "<html><body>test</body></html>");
  return dir;
}

// The CLI runs with a temp home, a local stack on an unreachable port and every non-local
// connection blocked, so a regressed guard fails here instead of connecting to a live chain.
function runBin(args) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    timeout: 15000,
    env: createCliTestEnv(mkdtempSync(join(tmpdir(), "pad-exit-code-home-"))),
  });
}

describe("exit codes", () => {
  test("exits 78 (EXIT_CODE_NO_RETRY) when loading the stack throws NonRetryableError due to unknown --env", () => {
    // loadStack() throws NonRetryableError before any fetch; the deploy path's outer catch
    // records the failed run and exits EXIT_CODE_NO_RETRY (78, POSIX EX_CONFIG) so callers do not retry.
    const dir = makeTmpSite();

    const result = runBin([dir, "test.dot", "--env", "nonexistent-env-id-that-does-not-exist"]);

    assert.strictEqual(
      result.status,
      78,
      `>> FAIL: unknown --env: a NonRetryableError must exit 78 (EXIT_CODE_NO_RETRY) so callers do not retry; got ${result.status}`,
    );
    assert.match(
      result.stderr ?? "",
      /Unknown environment 'nonexistent-env-id-that-does-not-exist'/,
      `>> FAIL: unknown --env: stderr must say which environment is unknown; got ${(result.stderr ?? "").split("\n").filter((line) => /error/i.test(line)).join(" | ")}`,
    );
    assert.match(
      result.stderr ?? "",
      /Deployment failed \(not retryable\)/,
      ">> FAIL: unknown --env: the deploy path's outer catch must report the run as failed and not retryable",
    );
  });

  // CI retries exit 1; a selection that can never work must exit 78 from the sign-in commands too.
  test("login --env kusama exits 78", () => {
    const result = runBin(["login", "--env", "kusama"]);
    assert.strictEqual(result.status, 78, `>> FAIL: login --env kusama must exit 78; got ${result.status}: ${result.stderr}`);
  });

  test("--stack with --env exits 78", () => {
    const result = runBin(["whoami", "--env", "paseo-next-v2", "--stack", "./x.json"]);
    assert.strictEqual(result.status, 78, `>> FAIL: --stack with --env must exit 78; got ${result.status}: ${result.stderr}`);
  });

  test("transfer with a removed --env exits 78", () => {
    const result = runBin(["transfer", "foo", "--env", "kusama"]);
    assert.strictEqual(result.status, 78, `>> FAIL: transfer --env kusama must exit 78; got ${result.status}: ${result.stderr}`);
  });
});
