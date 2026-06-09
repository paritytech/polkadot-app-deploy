/**
 * Registry of instrumented code paths for dead-branch coverage monitoring.
 *
 * Each ID is emitted as a "code.path.<id>" span attribute the first time a deploy
 * exercises that branch. The nightly check-code-path-coverage.py queries
 * Sentry for zero-hit paths over a rolling 30-day window and files a GitHub
 * issue if any are found.
 *
 * Rule: never remove an ID without also removing the corresponding branch.
 * Add a new ID whenever you add a conditional branch worth monitoring.
 *
 * When adding a new ID here, ALSO add it to CODE_PATHS in
 * tools/check-code-path-coverage.py with an `introduced` date of today
 * (YYYY-MM-DD UTC). The grace window prevents the brand-new path from
 * triggering a false "0 hits over 30d" alarm before any consumer has
 * had time to upgrade and exercise the branch.
 */
export const CODE_PATHS = {
  // Auto-account-mapping branch (ensureMappedAccountReady, dotns.ts)
  // true  → automated mapping via EVM key derivation
  // false → standard check (already-mapped or manually register)
  DOTNS_AUTO_MAPPING:   "dotns.auto-mapping",
  DOTNS_MANUAL_MAPPING: "dotns.manual-mapping",
} as const;

export type CodePath = typeof CODE_PATHS[keyof typeof CODE_PATHS];
