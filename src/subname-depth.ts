/**
 * Subname-depth display helper, used by `src/deploy.ts` to describe how
 * deeply nested a parsed subname is.
 *
 * Depth is observed, not gated (bulletin-deploy #1449, folded into #1443):
 * `src/dotns.ts`'s `parseDomainName` accepts any depth, and there is no cap
 * or override flag anywhere in this CLI. This module is only the pure
 * arithmetic for turning a label count into a "levels of nesting" figure for
 * a deploy-time console notice and telemetry attribute — it carries no
 * policy of its own.
 *
 * Zero imports, zero chain dependencies — kept trivial so it stays cheap to
 * import from both `src/deploy.ts` and any pure test.
 */

/**
 * How many "levels" of subname nesting `labelsBeforeTld` labels represents
 * (e.g. `worker.app.supafaust.<tld>`'s 3 labels are 2 levels of nesting
 * under the leaf sublabel; `worker.app.<tld>`'s 2 labels are 1, the
 * ordinary case).
 */
export function subnameNestingLevels(labelsBeforeTld: number): number {
  return labelsBeforeTld - 1;
}
