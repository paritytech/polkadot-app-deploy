import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "bin/polkadot-app-deploy");

// Creates a minimal build directory with one file so the bin doesn't exit
// early with "build directory does not exist".
function makeTmpSite() {
  const dir = mkdtempSync(join(tmpdir(), "bd-exit-code-test-"));
  writeFileSync(join(dir, "index.html"), "<html><body>test</body></html>");
  return dir;
}

describe("exit codes", () => {
  test("exits 78 (EXIT_CODE_NO_RETRY) when deploy throws NonRetryableError due to unknown --env", () => {
    // Passing an unknown --env value causes resolveEndpoints() in src/environments.ts
    // to throw NonRetryableError before any RPC connection is attempted.
    // The bin's catch block (bin/bulletin-deploy:291-297) checks instanceof NonRetryableError
    // and exits EXIT_CODE_NO_RETRY (78, POSIX EX_CONFIG) instead of 1.
    const dir = makeTmpSite();

    const result = spawnSync(
      process.execPath,
      [bin, dir, "test.dot", "--env", "nonexistent-env-id-that-does-not-exist"],
      {
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          // Disable the npm version check network call so the test is
          // deterministic and offline-safe.
          PAD_UPDATE_CHECK: "0",
          // Suppress Sentry noise.
          SENTRY_DSN: "",
        },
      }
    );

    assert.strictEqual(
      result.status,
      78,
      `Expected exit 78 (EXIT_CODE_NO_RETRY) for NonRetryableError from bad --env, ` +
      `got ${result.status}.\nstderr: ${(result.stderr ?? "").slice(0, 500)}`
    );
    assert.match(
      result.stderr ?? "",
      /not retryable/i,
      "Expected 'Deployment failed (not retryable)' in stderr"
    );
  });
});
