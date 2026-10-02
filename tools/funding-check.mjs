#!/usr/bin/env node
/**
 * tools/funding-check.mjs
 *
 * Daily E2E funding check (port of bulletin #1636 / #1628), run by
 * .github/workflows/e2e-funding-check.yml at 14:17 UTC, ahead of the 15:00 nightly. For every e2eEligible environment in
 * environments.json it reads the Asset Hub balance of each E2E signer (the
 * tools/check-balances.mjs set) plus the refill source standard //Alice, and
 * judges them with tools/funding-verdict.mjs. READ-ONLY: it never sends a
 * transaction. Money movement stays a human step.
 *
 * Usage:
 *   node tools/funding-check.mjs [--env <id>]... [--out-dir <dir>] [--run-url <url>]
 *        [--margin-pct 20] [--root-warn-pas 1000] [--refill-min-pas 500]
 *
 * Writes <out-dir>/funding-verdict.txt (PASS|WARN|ERROR|FAIL), funding-table.md
 * (every row) and funding-body.md (issue body, problem rows only).
 * Exit: 0 PASS/WARN, 1 FAIL (a balance is low), 2 ERROR (a balance could not be
 * read, or bad usage - not a funding fault, so no funding issue).
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvironments, resolveEndpoints } from "../dist/environments.js";
import { DEFAULT_MNEMONIC } from "../dist/dotns.js";
import { SIGNERS, deriveSigners, readAccounts } from "./check-balances.mjs";
import { DEFAULTS, evaluateEnv, overallVerdict, renderTable, renderIssueBody } from "./funding-verdict.mjs";

const READ_TIMEOUT_MS = 60_000;
const REFILL_SIGNER = { label: "//Alice", path: "//Alice", role: "refill" };

function parseArgs(argv) {
  const out = { envs: [], outDir: null, runUrl: undefined, opts: { ...DEFAULTS } };
  const numeric = { "--margin-pct": "marginPct", "--root-warn-pas": "rootWarnPas", "--refill-min-pas": "refillMinPas" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env") out.envs.push(argv[++i]);
    else if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "--run-url") out.runUrl = argv[++i];
    else if (numeric[a]) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${a} needs a non-negative number`);
      out.opts[numeric[a]] = n;
    } else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

export async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function gatherEnv(doc, envId, signers) {
  const env = doc.environments.find((e) => e.id === envId);
  const base = { envId, registerStorageDeposit: env?.registerStorageDeposit === undefined ? undefined : BigInt(env.registerStorageDeposit) };
  try {
    const rpc = resolveEndpoints(doc, envId).assetHub[0];
    return { ...base, rows: await withTimeout(readAccounts(rpc, signers), READ_TIMEOUT_MS, `${envId} balance read`) };
  } catch (e) {
    const error = (e?.message ?? String(e)).slice(0, 120);
    return { ...base, rows: signers.map((s) => ({ ...s, error })) };
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`>> FAIL: funding-check: ${e.message}`);
    process.exit(2);
  }
  const { doc } = await loadEnvironments();
  const envIds = args.envs.length ? args.envs : doc.environments.filter((e) => e.e2eEligible === true).map((e) => e.id);
  if (envIds.length === 0) {
    console.error(">> FAIL: funding-check: no e2eEligible environment found, so nothing would be checked");
    process.exit(2);
  }
  const signers = await deriveSigners([...SIGNERS, REFILL_SIGNER], DEFAULT_MNEMONIC);
  const gathered = await Promise.all(envIds.map((id) => gatherEnv(doc, id, signers)));
  const envResults = gathered.map((g) => evaluateEnv(g, args.opts));

  const verdict = overallVerdict(envResults);
  const table = renderTable(envResults);
  console.log(table);
  console.log(`Overall: ${verdict}`);
  if (args.outDir) {
    fs.mkdirSync(args.outDir, { recursive: true });
    fs.writeFileSync(path.join(args.outDir, "funding-verdict.txt"), verdict);
    fs.writeFileSync(path.join(args.outDir, "funding-table.md"), table);
    fs.writeFileSync(path.join(args.outDir, "funding-body.md"), renderIssueBody(envResults, { runUrl: args.runUrl }));
  }
  process.exit(verdict === "FAIL" ? 1 : verdict === "ERROR" ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
