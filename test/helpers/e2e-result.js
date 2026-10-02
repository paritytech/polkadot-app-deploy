// Harness side of the per-leg e2e-result.json (#1625). Call installE2eResultHook()
// inside the top-level describe: it records each test's outcome and, when the
// suite ends, writes the result JSON to E2E_RESULT_PATH (a no-op when unset).
//
// The builder lives in .github/scripts/e2e-result.mjs and is imported
// dynamically inside try/catch: a result file is reporting, and must never be
// able to fail or hang a scenario. If the runtime cannot say whether a test
// passed (`t.passed` is undefined), nothing is written and the workflow's
// fallback step derives the file from job.status instead.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, after } from "node:test";

let builder = null;
try {
  builder = await import("../../.github/scripts/e2e-result.mjs");
} catch {
  /* fallback step covers it */
}

function messageOf(err) {
  const inner = err?.cause ?? err;
  return String(inner?.message ?? inner ?? "");
}

/**
 * @param {{ scenario: string, signer?: string, merkle?: string, env?: string }} meta
 */
export function installE2eResultHook(meta) {
  const outPath = process.env.E2E_RESULT_PATH;
  if (!outPath || !builder) return;
  const failures = [];
  let outcomesKnown = true;
  let seen = 0;

  afterEach((t) => {
    try {
      seen++;
      if (typeof t?.passed !== "boolean") outcomesKnown = false;
      else if (!t.passed) failures.push(messageOf(t.error));
    } catch {
      outcomesKnown = false;
    }
  });

  after(() => {
    try {
      if (!outcomesKnown || seen === 0) return;
      const text = failures.join("\n");
      const failed = failures.length > 0;
      // Not every failure follows the >> FAIL: convention; keep its first line as the signature.
      const firstLine = failed ? (failures[0].split("\n")[0] || "").slice(0, 300) : "";
      const result = builder.buildResult({
        ...meta,
        status: failed ? "failure" : "success",
        log: text,
        harness: { signature: builder.extractSignature(text) || firstLine },
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      });
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
    } catch {
      /* never fail a scenario over a reporting file */
    }
  });
}
