/**
 * tools/funding-verdict.mjs
 *
 * Pure verdict + rendering layer for the daily E2E funding check (port of
 * bulletin #1636 / #1628). No
 * chain access: tools/funding-check.mjs gathers balances and feeds them in.
 *
 * Roles (set in tools/check-balances.mjs SIGNERS):
 *   root   - Alice ROOT: signs DotNS for every pool leg and is the top-up source.
 *            FAIL below the register floor + margin; WARN below rootWarnPas
 *            (headroom for the nightly's burn: ~10 PAS deposit per registration).
 *   dotns  - Bob and the //e2e-* sub-accounts: sign DotNS. FAIL below floor + margin.
 *   pool   - //deploy/N: sign Bulletin only, so the Asset Hub balance is advisory.
 *            WARN, never FAIL.
 *   refill - standard //Alice, the human refill source. FAIL below refillMinPas.
 *
 * The register floor is NOT a number of ours: it is the deploy's own
 * feeFloorFor("register", ...) from src/dotns.ts, at the env's
 * registerStorageDeposit, with AUTO_MAP_RENT_HEADROOM as the worst-case
 * (NoStatus) rent. If the deploy's floor moves, this moves with it.
 */

import { feeFloorFor, fmtPas as fmtPlanck, AUTO_MAP_RENT_HEADROOM, MINIMUM_REGISTER_STORAGE_DEPOSIT } from "../dist/dotns.js";

export const ONE_PAS = 10n ** 10n;

// marginPct: headroom above the register floor so a signer one deploy from the
//   gate still alarms. rootWarnPas / refillMinPas are in whole PAS.
export const DEFAULTS = Object.freeze({
  marginPct: 20,
  rootWarnPas: 1000,
  refillMinPas: 500,
});

const SEVERITY = { PASS: 0, WARN: 1, ERROR: 2, FAIL: 3 };

/** Register floor in plancks for an env, from the same function the deploy gates on. */
export function registerFloor(registerStorageDeposit) {
  return feeFloorFor("register", registerStorageDeposit ?? MINIMUM_REGISTER_STORAGE_DEPOSIT, AUTO_MAP_RENT_HEADROOM);
}

export function evaluateSigner(row, registerFloorPlanck, opts = DEFAULTS) {
  const withMargin = (registerFloorPlanck * BigInt(100 + opts.marginPct)) / 100n;
  const base = { label: row.label, role: row.role, address: row.address, free: row.free };
  if (row.free === null || row.free === undefined) {
    return { ...base, free: null, floor: withMargin, verdict: "ERROR", note: `balance read failed: ${row.error ?? "unknown"}` };
  }
  if (row.role === "refill") {
    const floor = BigInt(opts.refillMinPas) * ONE_PAS;
    return { ...base, floor, verdict: row.free < floor ? "FAIL" : "PASS" };
  }
  if (row.role === "pool") {
    return { ...base, floor: withMargin, verdict: row.free < withMargin ? "WARN" : "PASS" };
  }
  if (row.free < withMargin) return { ...base, floor: withMargin, verdict: "FAIL" };
  if (row.role === "root" && row.free < BigInt(opts.rootWarnPas) * ONE_PAS) {
    return { ...base, floor: BigInt(opts.rootWarnPas) * ONE_PAS, verdict: "WARN", note: "below burn headroom" };
  }
  return { ...base, floor: withMargin, verdict: "PASS" };
}

export function evaluateEnv({ envId, registerStorageDeposit, rows }, opts = DEFAULTS) {
  const floor = registerFloor(registerStorageDeposit);
  return { envId, floor, results: rows.map((r) => ({ envId, ...evaluateSigner(r, floor, opts) })) };
}

export function overallVerdict(envResults) {
  let worst = "PASS";
  for (const env of envResults) {
    for (const r of env.results) if (SEVERITY[r.verdict] > SEVERITY[worst]) worst = r.verdict;
  }
  return worst;
}

const fmtPas = (planck) => (planck === null || planck === undefined ? "n/a" : fmtPlanck(planck));

export function renderTable(envResults, { onlyProblems = false } = {}) {
  const lines = ["| env | account | address | free PAS | floor | verdict |", "| --- | --- | --- | ---: | ---: | --- |"];
  for (const env of envResults) {
    for (const r of env.results) {
      if (onlyProblems && r.verdict === "PASS") continue;
      const verdict = r.note ? `${r.verdict} (${r.note})` : r.verdict;
      lines.push(`| ${r.envId} | ${r.label} | \`${r.address}\` | ${fmtPas(r.free)} | ${fmtPas(r.floor)} | ${verdict} |`);
    }
  }
  return lines.join("\n") + "\n";
}

export function renderIssueBody(envResults, { runUrl } = {}) {
  return [
    "The daily E2E funding check found a signer below its floor. The nightly E2E runs at 15:00 UTC and gates on these balances.",
    "",
    renderTable(envResults, { onlyProblems: true }),
    "Floor = the deploy's register floor (`feeFloorFor(\"register\", ...)`) plus margin; //Alice and Alice ROOT use their own thresholds. See tools/funding-verdict.mjs.",
    "",
    "No transfers are made automatically. Refill by hand from //Alice (Alice ROOT is the usual target).",
    ...(runUrl ? ["", `Run: ${runUrl}`] : []),
  ].join("\n");
}
