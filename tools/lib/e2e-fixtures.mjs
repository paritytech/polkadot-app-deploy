// Per-tier fixed E2E labels (port of bulletin #1639 / bulletin #1623).
//
// Node builtins only, no polkadot-api, so tools and the S-CAR npm-path script
// in e2e.yml can import this cheaply. S3_OWNED_LABEL (bulletin #1332) and
// BOB_H160 sit at the bottom.

// --- Per-tier fixed labels (bulletin #1623) ---------------------------------
//
// Scenarios whose property is not registration deploy to a fixed label that
// Alice ROOT already owns, instead of registering a fresh one every run (10 PAS
// PopRules deposit each). Every label listed here is provisioned once, and
// test/e2e.test.js plus the S-CAR npm-path script in e2e.yml read them from
// here, so they cannot drift apart (the bulletin #1332 failure mode).
//
// Each run tier gets its own label, so the 15:00 HEAD nightly, release gates,
// dispatches and PR runs never write the same label concurrently (bulletin
// proposition 8). The tier comes from DEPLOY_TAG, which every scenario job
// already sets. p-a-d has no @latest nightly, so upstream's
// e2e-ci-nightly-stable -> "stable" tier is not in the table.
//
// Namespace: every base starts with PAD_LABEL_PREFIX. Both repos sign DotNS as
// the same Alice ROOT on the same paseo-next-v2 chain, so sharing upstream's
// bases would make the two repos overwrite each other's fixtures.
//
// Provisioning: p-a-d has no bootstrap-env / register-test-fixture (maintainer
// tools of the private sibling repo, see #208). The labels are registered out of
// band with that repo's registrar, owned by Alice ROOT, from tieredFixtureLabels().

export const PAD_LABEL_PREFIX = "pad";

export const E2E_LABEL_TIERS = Object.freeze({
  "e2e-ci-nightly": "head",
  "e2e-ci-release": "release",
  "e2e-ci-dispatch": "dispatch",
  "e2e-ci-pr": "pr",
});

/**
 * The label tier for a deploy tag. Local tags (e2e-local, e2e-local-*) share
 * "local". Anything else throws: a tier nobody provisioned would silently
 * register a new name on first use, which is the cost this table exists to cut.
 */
export function labelTierFromDeployTag(tag) {
  if (Object.hasOwn(E2E_LABEL_TIERS, tag ?? "")) return E2E_LABEL_TIERS[tag];
  if (tag === "e2e-local" || String(tag ?? "").startsWith("e2e-local-")) return "local";
  throw new Error(
    `DEPLOY_TAG ${JSON.stringify(tag)} has no label tier. Known: ${Object.keys(E2E_LABEL_TIERS).join(", ")}, e2e-local, e2e-local-*. ` +
      "Add it to E2E_LABEL_TIERS in tools/lib/e2e-fixtures.mjs and provision its labels (owned by Alice ROOT) before using it.",
  );
}

const ALL_TIERS = Object.freeze([...Object.values(E2E_LABEL_TIERS).filter((t) => t !== "pr"), "local"]);

// Label = <base><tier>00. Bases are letters-led and at least 7 characters, so
// the shortest label (base + "pr" + "00") still has a 9-character base: NoStatus
// on every DotNS profile, untouched by sanitizeDomainLabel (test/e2e-fixtures.test.js).
// `tiers` lists the tiers the scenario actually runs on, which is what gets provisioned.
export const TIERED_FIXTURES = Object.freeze({
  "s-car": { base: "pade2escar", tiers: ALL_TIERS },
  // p-a-d only: S-GRANDPA-REUPLOAD signs DotNS as its isolated direct signer
  // //e2e-sgrandpa (ISOLATED_DIRECT_SIGNERS in test/e2e.test.js, p-a-d #25),
  // not Alice ROOT as upstream does, so its labels must be owned by that account.
  "s-grandpa-reupload": { base: "pade2egrandpa", tiers: ALL_TIERS, owner: "//e2e-sgrandpa" },
  "s-mortality": { base: "pade2emortal", tiers: ALL_TIERS },
  s8: { base: "pade2es8halt", tiers: ALL_TIERS },
  // nightly-s-inc runs only on the source-build path (HEAD cron or a dispatch
  // without test-version), so crosslabel has no release labels.
  "s-inc-crosslabel-a-js": { base: "pade2exlblajs", tiers: ["head", "dispatch", "local"] },
  "s-inc-crosslabel-a-kubo": { base: "pade2exlblakubo", tiers: ["head", "dispatch", "local"] },
  // PR runs get a per-PR label (prSmokeLabel); this one serves push-to-main and
  // test-suite=pr dispatches, which have no PR number.
  "s1-smoke": { base: "pade2esmoke", tiers: ["pr", "local"] },
});

function fixtureLabel(fixture, tier, suffix = "") {
  const entry = TIERED_FIXTURES[fixture];
  if (!entry) throw new Error(`unknown fixture ${JSON.stringify(fixture)}; known: ${Object.keys(TIERED_FIXTURES).join(", ")}`);
  if (!entry.tiers.includes(tier)) {
    throw new Error(`fixture ${fixture} is not provisioned for tier "${tier}" (only ${entry.tiers.join(", ")}); add the tier and provision its label`);
  }
  return `${entry.base}${tier}${suffix}00`;
}

/** The fixed label (no TLD) a scenario deploys to under this deploy tag. */
export function tieredFixtureLabel(fixture, deployTag) {
  return fixtureLabel(fixture, labelTierFromDeployTag(deployTag));
}

/**
 * Every label to provision, as { fixture, tier, label, owner }. `owner` is the
 * DotNS owner as a derivation path from the dev mnemonic: "" (Alice ROOT) unless
 * the fixture names its own.
 */
export function tieredFixtureLabels() {
  return Object.entries(TIERED_FIXTURES).flatMap(([fixture, { tiers, owner = "" }]) =>
    tiers.map((tier) => ({ fixture, tier, label: fixtureLabel(fixture, tier), owner })));
}

/** 0-9 -> a-j, so a number can supply label entropy without adding digits. */
export function digitsToLetters(s) {
  return String(s).replace(/[0-9]/g, (d) => String.fromCharCode(97 + Number(d)));
}

/**
 * S1-SMOKE's label on the PR tier. Concurrent PRs run in different concurrency
 * groups, so a shared label would let one PR read back another's CID; each PR
 * gets its own name, registered on that PR's first E2E run and reused by its
 * later pushes. Without a PR number (push to main, test-suite=pr dispatch) it is
 * the provisioned pr-tier label.
 */
export function prSmokeLabel(prNumber) {
  const n = String(prNumber ?? "");
  if (n && !/^\d+$/.test(n)) throw new Error(`PR number must be digits, got ${JSON.stringify(prNumber)}`);
  return fixtureLabel("s1-smoke", "pr", digitsToLetters(n));
}

/** S1-SMOKE's label: per PR on the pr tier, the tier's fixed label otherwise. */
export function smokeLabel(deployTag, prNumber) {
  const tier = labelTierFromDeployTag(deployTag);
  return tier === "pr" ? prSmokeLabel(prNumber) : fixtureLabel("s1-smoke", tier);
}

// S3 "owned by a different account" fixture (bulletin #1332) and Bob's H160
// (//Bob from the dev phrase, see docs/e2e-bootstrap.md). p-a-d's only
// e2eEligible env is paseo-next-v2, where test/e2e.test.js's S3 scenario uses
// e2eownedns03 owned by Bob. Read by tools/check-env-readiness.mjs.
export const S3_OWNED_LABEL = "e2eownedns03";
export const BOB_H160 = "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01";
