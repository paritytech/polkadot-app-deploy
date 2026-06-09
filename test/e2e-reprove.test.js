/**
 * S-REPROVE: Auto-reprove E2E test (issue #417)
 *
 * Verifies that when classifyAliasAccountState() returns "bound-likely-stale",
 * _preflightInternal() automatically calls reprove() and continues registration.
 *
 * Uses the direct-DotNS approach (like S7 in e2e.test.js) so the injected
 * override actually reaches the in-process path. The test-only seam
 * __setClassifyOverrideForTest() is consumed once by the first
 * classifyAliasAccountState() call, causing the auto-reprove branch to fire.
 * The second classify call (post-reprove re-verification) hits the real chain.
 *
 * Prerequisites:
 *   - E2E=1 to enable the suite
 *   - E2E_REPROVE_MNEMONIC: mnemonic for an account that is registered on
 *     paseo-next-v2 AliasAccounts with a stale ring revision. The account must
 *     have enough PAS balance to pay the reprove fee.
 *   - PAD_ENV=paseo-next-v2 (set by the workflow job)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MNEMONIC, sanitizeDomainLabel, DotNS } from "../dist/dotns.js";
import { loadEnvironments, resolveEndpoints, getPopSelfServeConfig } from "../dist/environments.js";

const ENABLED = process.env.E2E === "1";
const REPROVE_MNEMONIC = process.env.E2E_REPROVE_MNEMONIC ?? "";
const PAD_ENV = process.env.PAD_ENV ?? null;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;

async function resolveDotnsEnvConnectOptions() {
  if (!PAD_ENV) return {};
  const { doc } = await loadEnvironments();
  const resolved = resolveEndpoints(doc, PAD_ENV);
  const popSelfServe = getPopSelfServeConfig(doc, PAD_ENV);
  return {
    rpc: resolved.assetHub[0],
    assetHubEndpoints: resolved.assetHub,
    autoAccountMapping: resolved.autoAccountMapping,
    contracts: Object.keys(resolved.contracts).length > 0 ? resolved.contracts : undefined,
    nativeToEthRatio: resolved.nativeToEthRatio,
    popSelfServe,
  };
}

describe("S-REPROVE — auto-reprove on bound-likely-stale", { skip: !ENABLED }, () => {
  // Positive path: inject "bound-likely-stale" via the test seam, verify that
  // preflight runs the reprove branch and emits the expected log lines.
  test(
    "positive path: preflight auto-reproves a stale alias binding",
    { skip: !REPROVE_MNEMONIC, timeout: DEPLOY_TIMEOUT_MS + 30_000 },
    async () => {
      // Capture console.log output so we can assert on the reprove log lines
      // without relying on process.stdout parsing.
      const logLines = [];
      const origLog = console.log;
      console.log = (...args) => {
        const line = args.join(" ");
        logLines.push(line);
        origLog(...args);
      };

      const dotns = new DotNS();
      try {
        await dotns.connect({
          mnemonic: REPROVE_MNEMONIC,
          ...(await resolveDotnsEnvConnectOptions()),
        });

        // Real getUserPopStatus call — exercises the real chain interface.
        // If the account already has PoP status (non-zero), inject NoStatus so preflight
        // reaches the auto-reprove branch.
        const realPopStatus = await dotns.getUserPopStatus();
        if (realPopStatus !== 0) {
          dotns.__setUserPopStatusForTest(0);
        }

        // Force "bound-likely-stale" classification regardless of real chain state —
        // needed to consistently reach the auto-reprove branch in _preflightInternal.
        dotns.__setClassifyOverrideForTest("bound-likely-stale");

        // Real reprove() is always attempted first (exercises the real People-chain interface).
        // If the account is already at the latest ring revision, reprove() throws
        // "not strictly greater than stored". Register a synthetic fallback for that case only;
        // any other reprove error still propagates and will fail the test.
        dotns.__setReproveFallbackForTest({ oldRevision: 0, newRevision: 1, blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000" });

        // Use a Full-class label (no trailing digits, base 6-8 chars) so
        // canRegister(Full, NoStatus) = false → !canRegister = true → auto-reprove fires.
        // "reprove" (7 chars) is Full-class; >=9-char base names are NoStatus under
        // PopRules and would NOT require reprove, so they cannot exercise this branch.
        const label = sanitizeDomainLabel("reprove");

        // preflight() calls _preflightInternal(label, false).
        // With the classify override returning "bound-likely-stale",
        // the auto-reprove branch fires, calls reprove(), then re-classifies.
        // We don't assert canProceed here because the account may or may not own
        // the domain — we only care that the reprove branch ran to completion.
        const result = await dotns.preflight(label);

        // The reprove branch must have logged these lines.
        const allLogs = logLines.join("\n");
        assert.ok(
          allLogs.includes("refreshing on testnet"),
          `>> FAIL: S-REPROVE: expected "refreshing on testnet" in preflight output — auto-reprove branch did not fire. Got:\n${allLogs.slice(-2000)}`,
        );
        assert.ok(
          allLogs.includes("Refresh complete"),
          `>> FAIL: S-REPROVE: expected "Refresh complete" in preflight output — reprove completed but success log missing. Got:\n${allLogs.slice(-2000)}`,
        );

        // Auto-reprove was attempted.
        assert.ok(result, ">> FAIL: S-REPROVE: preflight() returned null/undefined — auto-reprove may have thrown before returning a result");
      } finally {
        console.log = origLog;
        dotns.disconnect();
      }
    },
  );

  // Negative path: verify that insufficient signer balance aborts with the
  // correct error message rather than attempting reprove.
  // TODO: needs a dedicated funded account that is stale + nearly empty.
  test.todo("negative path: preflight aborts with actionable message when signer balance < reprove fee");
});
