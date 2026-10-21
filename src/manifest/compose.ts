/**
 * Shared product-manifest composers.
 *
 * `composeRoot` and `composeExecutable` build the exact wire shape written as
 * dotNS text records (RFC paritytech/triangle-js-sdks #0001). They are used
 * from two call sites that must stay byte-identical: the real publish path
 * ([`publishManifest`](./publish.ts), which passes the real icon/executable
 * CIDs) and the pre-upload size preflight ([`pessimisticSizePreflight`](./byte-budget.ts),
 * which substitutes `PLACEHOLDER_CID` for the root icon before the real CID
 * is known). Kept here, in a module neither of those two imports from each
 * other, so publish.ts (which already imports byte-budget.ts) can't form an
 * import cycle with it.
 */

import type {
  ExecutableConfig,
  ExecutableManifest,
  Granted,
  ProductConfig,
  RootManifest,
} from "./types.js";

export function composeRoot(
  config: ProductConfig,
  iconCid: string,
): RootManifest {
  const trustedProducts = normalizeTrustedProducts(
    config.trustedProducts,
    selfListedKeys(config),
  );
  return {
    $v: 1,
    displayName: config.displayName,
    description: config.description,
    icon: { cid: iconCid, format: config.icon.format },
    ...(trustedProducts !== undefined ? { trustedProducts } : {}),
  };
}

/** The `trustedProducts` keys composeRoot drops because they name the product itself. */
export function selfListedKeys(config: ProductConfig): string[] {
  const self = productLabel(config.domain);
  return Object.keys(config.trustedProducts ?? {}).filter((id) => id.toLowerCase() === self);
}

// The segment directly under the TLD: `worker.demoapp.dot` is `demoapp` (#1449).
// Reading the first segment would drop a grant to an unrelated product named `worker`.
function productLabel(domain: string): string {
  const labels = domain.split(".");
  return (labels[labels.length - 2] ?? labels[0]).toLowerCase();
}

/**
 * Drop what the host would read as "no grant" (or as nothing at all), and
 * emit what is left in a stable order.
 *
 * Absence, `{}` and a per-key `[]` all mean the same thing to the host, so the
 * shortest of them is the one worth writing: `trustedProducts` is the only
 * unbounded field in root-manifest v1 and it shares the same text-record byte
 * budget as everything else. Sorting keys and grants makes the serialised
 * record independent of the order the config happens to list them in, so
 * reordering a config does not defeat setTextRecord's skip-if-unchanged
 * pre-check and bill a pointless on-chain write.
 *
 * Two RFC rules drop entries outright, ahead of the empty-grants filter:
 *
 * - Line 143: "A product listing itself is ignored." The keys in
 *   `selfListed` (see selfListedKeys) are dropped regardless of what grants
 *   they list.
 * - Line 142: "`["all"]` implies `storage` and `context`, so
 *   `["all", "storage"]` is `["all"]`." A grant array containing `"all"`
 *   collapses to exactly `["all"]`, dropping the redundant values — both to
 *   save bytes against the same budget, and so that tidying
 *   `["all","storage"]` down to `["all"]` (a semantically null change) does
 *   not also change the serialised bytes and defeat skip-if-unchanged.
 */
function normalizeTrustedProducts(
  input: Record<string, Granted[]> | undefined,
  selfListed: string[],
): Record<string, Granted[]> | undefined {
  if (input === undefined) return undefined;
  // Plain `.sort()` on both levels: UTF-16 code-unit order is the same on
  // every machine, which localeCompare's collation would not be.
  const ids = Object.keys(input)
    .filter(
      (id) => !selfListed.includes(id) && input[id].length > 0,
    )
    .sort();
  if (ids.length === 0) return undefined;
  return Object.fromEntries(
    ids.map((id): [string, Granted[]] => [id, normalizeGrants(input[id])]),
  );
}

function normalizeGrants(grants: Granted[]): Granted[] {
  const unique = [...new Set(grants)];
  return unique.includes("all") ? ["all"] : unique.sort();
}

export function composeExecutable(exec: ExecutableConfig): ExecutableManifest {
  if (exec.kind === "app") {
    return "manifest" in exec
      ? exec.manifest
      : { $v: 1, kind: "app", appVersion: exec.appVersion };
  }
  if (exec.kind === "widget") {
    return {
      $v: 1,
      kind: "widget",
      appVersion: exec.appVersion,
      dimensions: exec.dimensions,
      ...(exec.description !== undefined
        ? { description: exec.description }
        : {}),
    };
  }
  if (exec.kind === "funding") {
    return {
      $v: 1,
      kind: "funding",
      appVersion: exec.appVersion,
      modes: exec.modes,
    };
  }
  return {
    $v: 1,
    kind: "worker",
    appVersion: exec.appVersion,
    entrypoint: exec.entrypoint,
    includes: exec.includes,
  };
}
