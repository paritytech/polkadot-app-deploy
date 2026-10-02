// Tests for the per-tier fixed E2E labels in tools/lib/e2e-fixtures.mjs (port of
// bulletin #1639 / #1623). Every label the harness deploys to and that gets
// provisioned comes from this table, so its shape rules are pinned here once.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  E2E_LABEL_TIERS,
  labelTierFromDeployTag,
  tieredFixtureLabel,
  tieredFixtureLabels,
  TIERED_FIXTURES,
  prSmokeLabel,
  smokeLabel,
  digitsToLetters,
  PAD_LABEL_PREFIX,
  S3_OWNED_LABEL,
  BOB_H160,
} from "../tools/lib/e2e-fixtures.mjs";
import { classifyDotnsLabel, sanitizeDomainLabel, ProofOfPersonhoodStatus } from "../dist/dotns.js";

const PROFILES = ["poprules-startingPrice", "v0.5.8-rc1", "v0.6.0"];

function trailingDigits(label) {
  return label.match(/\d*$/)[0].length;
}

// A fixture label must survive sanitization untouched (the CLI would deploy to
// a different name otherwise) and be registrable by a NoStatus signer on every
// DotNS generation, since Alice ROOT holds no personhood on the e2e envs.
function assertRegistrableFixture(label, what) {
  assert.equal(sanitizeDomainLabel(label), label,
    `>> FAIL: e2e-fixtures: ${what} "${label}" is changed by sanitizeDomainLabel, so the CLI would deploy to a different name than the one provisioned`);
  assert.equal(trailingDigits(label), 2,
    `>> FAIL: e2e-fixtures: ${what} "${label}" must end in exactly 2 digits (DotNS allows 0 or 2; the sanitizer collapses any other count)`);
  assert.ok(label.length - 2 >= 9,
    `>> FAIL: e2e-fixtures: ${what} "${label}" needs a base of at least 9 characters; a 6-8 character base plus 2 digits is PopLite on the older profiles`);
  for (const profile of PROFILES) {
    const { status } = classifyDotnsLabel(label, "dot", profile);
    assert.equal(status, ProofOfPersonhoodStatus.NoStatus,
      `>> FAIL: e2e-fixtures: ${what} "${label}" classifies as status ${status} on ${profile}, not NoStatus, so a NoStatus signer cannot register it`);
  }
}

describe("labelTierFromDeployTag", () => {
  test("maps every CI deploy tag to its own tier", () => {
    assert.deepEqual(
      Object.fromEntries(Object.keys(E2E_LABEL_TIERS).map((tag) => [tag, labelTierFromDeployTag(tag)])),
      {
        "e2e-ci-nightly": "head",
        "e2e-ci-release": "release",
        "e2e-ci-dispatch": "dispatch",
        "e2e-ci-pr": "pr",
      },
    );
  });

  test("local tags share the local tier", () => {
    for (const tag of ["e2e-local", "e2e-local-targeted", "e2e-local-s7"]) {
      assert.equal(labelTierFromDeployTag(tag), "local", `>> FAIL: e2e-fixtures: ${tag} must map to the local tier`);
    }
  });

  test("tiers are distinct, so no two tags write the same fixed label", () => {
    const tiers = [...Object.values(E2E_LABEL_TIERS), "local"];
    assert.equal(new Set(tiers).size, tiers.length, `>> FAIL: e2e-fixtures: two deploy tags share a tier: ${tiers.join(", ")}`);
  });

  test("an unknown or missing tag throws instead of picking a label nobody provisioned", () => {
    // p-a-d has no @latest nightly, so upstream's e2e-ci-nightly-stable is unknown here too.
    for (const tag of [undefined, "", "e2e-ci-nightly-beta", "e2e-ci-nightly-stable", "e2e-localx", "prod"]) {
      assert.throws(() => labelTierFromDeployTag(tag), /no label tier/,
        `>> FAIL: e2e-fixtures: tag ${JSON.stringify(tag)} must throw, not fall back to a tier`);
    }
  });
});

describe("tieredFixtureLabel", () => {
  test("every provisioned label is sanitizer-stable and NoStatus on every profile", () => {
    const labels = tieredFixtureLabels();
    assert.ok(labels.length > 0, ">> FAIL: e2e-fixtures: tieredFixtureLabels() returned nothing");
    for (const { label, fixture, tier } of labels) assertRegistrableFixture(label, `${fixture}/${tier}`);
  });

  test("labels are unique across fixtures and tiers", () => {
    const labels = tieredFixtureLabels().map((l) => l.label);
    assert.equal(new Set(labels).size, labels.length, `>> FAIL: e2e-fixtures: duplicate fixture label in ${labels.join(", ")}`);
  });

  test("a label is <base><tier>00", () => {
    assert.equal(tieredFixtureLabel("s-car", "e2e-ci-nightly"), "pade2escarhead00");
    assert.equal(tieredFixtureLabel("s-car", "e2e-ci-release"), "pade2escarrelease00");
    assert.equal(tieredFixtureLabel("s-inc-crosslabel-a-kubo", "e2e-local-targeted"), "pade2exlblakubolocal00");
  });

  // p-a-d: both repos sign DotNS as the same Alice ROOT on the same chain, so a
  // base shared with bulletin-deploy would make the two repos overwrite each
  // other's fixtures (and PR #N's smoke label would be bulletin PR #N's).
  test("every base is in p-a-d's own namespace", () => {
    for (const [fixture, { base }] of Object.entries(TIERED_FIXTURES)) {
      assert.ok(base.startsWith(PAD_LABEL_PREFIX),
        `>> FAIL: e2e-fixtures: ${fixture} base "${base}" must start with "${PAD_LABEL_PREFIX}", or it collides with bulletin-deploy's labels on the shared chain`);
    }
    assert.ok(prSmokeLabel("1623").startsWith(PAD_LABEL_PREFIX), ">> FAIL: e2e-fixtures: the per-PR smoke label must be in p-a-d's namespace");
  });

  // p-a-d: a scenario on an isolated direct signer deploys as that account, so
  // a label owned by Alice ROOT is a hard "already owned" refusal on chain.
  test("a fixture whose scenario signs as an isolated direct signer is owned by that signer", () => {
    const e2e = fs.readFileSync(new URL("./e2e.test.js", import.meta.url), "utf-8");
    const block = e2e.match(/const ISOLATED_DIRECT_SIGNERS = \{([\s\S]*?)\};/);
    assert.ok(block, ">> FAIL: e2e-fixtures: ISOLATED_DIRECT_SIGNERS not found in test/e2e.test.js");
    const isolated = Object.fromEntries([...block[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    assert.ok(Object.keys(isolated).length > 0, ">> FAIL: e2e-fixtures: could not parse ISOLATED_DIRECT_SIGNERS");
    for (const { fixture, label, owner } of tieredFixtureLabels()) {
      const scenario = Object.keys(isolated).find((sc) => fixture === sc || fixture.startsWith(`${sc}-`));
      assert.equal(owner, scenario ? isolated[scenario] : "",
        `>> FAIL: e2e-fixtures: ${label} must be owned by ${scenario ? isolated[scenario] : "Alice ROOT"}, the account ${fixture} signs DotNS as`);
    }
  });

  test("a tier the fixture was not provisioned for throws", () => {
    // crosslabel only runs on the source-build path, so no release label exists.
    assert.throws(() => tieredFixtureLabel("s-inc-crosslabel-a-js", "e2e-ci-release"), /not provisioned/);
    assert.throws(() => tieredFixtureLabel("no-such-fixture", "e2e-ci-nightly"), /unknown fixture/);
  });
});

describe("prSmokeLabel", () => {
  test("a PR number gives that PR its own label", () => {
    assert.equal(prSmokeLabel("1623"), "pade2esmokeprbgcd00");
    assert.notEqual(prSmokeLabel("1623"), prSmokeLabel("1624"));
    for (const n of ["1", "42", "1623", "99999"]) assertRegistrableFixture(prSmokeLabel(n), `PR ${n} smoke label`);
  });

  test("no PR number falls back to the provisioned pr-tier label", () => {
    assert.equal(prSmokeLabel(""), tieredFixtureLabel("s1-smoke", "e2e-ci-pr"));
    assert.equal(prSmokeLabel(undefined), tieredFixtureLabel("s1-smoke", "e2e-ci-pr"));
  });

  test("smokeLabel is per PR only on the pr tier", () => {
    assert.equal(smokeLabel("e2e-ci-pr", "1623"), prSmokeLabel("1623"));
    assert.equal(smokeLabel("e2e-ci-pr", ""), tieredFixtureLabel("s1-smoke", "e2e-ci-pr"));
    assert.equal(smokeLabel("e2e-local", "1623"), tieredFixtureLabel("s1-smoke", "e2e-local"));
  });

  test("a non-numeric PR number throws", () => {
    assert.throws(() => prSmokeLabel("12a"), /PR number/);
  });

  test("digitsToLetters never emits a digit", () => {
    assert.equal(digitsToLetters("0123456789"), "abcdefghij");
  });
});

// Call sites (#1623): the scenarios that moved off fresh registration must keep
// using the table, and the ones whose property IS registration must not.
describe("e2e harness label call sites", () => {
  const e2e = fs.readFileSync(new URL("./e2e.test.js", import.meta.url), "utf-8");
  const workflow = fs.readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf-8");
  const block = (title) => {
    const start = e2e.indexOf(`describe("${title}`);
    assert.ok(start >= 0, `>> FAIL: e2e-fixtures: no describe("${title}...") in test/e2e.test.js`);
    const next = e2e.indexOf("\n  describe(", start + 1);
    return e2e.slice(start, next < 0 ? undefined : next);
  };

  test("moved scenarios deploy to their tier label", () => {
    for (const [title, call] of [
      ["S-CAR", 'tieredLabel("s-car")'],
      ["S-GRANDPA-REUPLOAD", 'tieredLabel("s-grandpa-reupload")'],
      ["S-MORTALITY", 'tieredLabel("s-mortality")'],
      ["S8 ", 'tieredLabel("s8")'],
      ["S-INC-CROSSLABEL", "tieredLabel(`s-inc-crosslabel-a-${MERKLE}`)"],
    ]) {
      const b = block(title);
      assert.ok(b.includes(call), `>> FAIL: e2e-fixtures: ${title} must deploy to ${call}`);
      assert.doesNotMatch(b, /pickFreshRunLabel\(|noStatusRunLabel\(/, `>> FAIL: e2e-fixtures: ${title} registers a fresh name again`);
    }
  });

  test("crosslabel B is a fresh subname of A, so its first deploy has no previous manifest", () => {
    assert.match(block("S-INC-CROSSLABEL"), /const labelB = `b\$\{RUN_TOKEN\}\$\{Date\.now\(\)\.toString\(36\)\}\.\$\{labelA\}`/,
      ">> FAIL: e2e-fixtures: crosslabel label B must be a per-process subname of label A");
  });

  test("scenarios whose property is registration still register a fresh name", () => {
    for (const title of ["S2 ", "S5 ", "S9 ", "S-TRANSFER ", "S-TRANSFER-SUBNAME", "S-SUBDOMAIN"]) {
      assert.match(block(title), /pickFreshRunLabel\(|noStatusRunLabel\(/, `>> FAIL: e2e-fixtures: ${title} must keep a fresh per-run registration`);
    }
  });

  test("S1-SMOKE uses the per-PR label, and test-pr passes the PR number", () => {
    assert.match(block("S1-SMOKE"), /smokeLabel\(process\.env\.DEPLOY_TAG, process\.env\.E2E_PR_NUMBER\)/);
    assert.match(workflow, /E2E_SCENARIO: s1-smoke\n(?:\s+#.*\n)*\s+E2E_PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/,
      ">> FAIL: e2e-fixtures: test-pr must pass E2E_PR_NUMBER, or every PR shares one smoke label");
  });
});

describe("S3 fixture constants (bulletin #1332 / #1642)", () => {
  test("the S3 scenario's paseo-next-v2 label and the readiness probe read the same constant", () => {
    const e2e = fs.readFileSync(new URL("../test/e2e.test.js", import.meta.url), "utf8");
    assert.match(e2e, /\? `\$\{S3_OWNED_LABEL\}\.\$\{tld\}`/,
      ">> FAIL: e2e-fixtures: S3 must build its paseo-next-v2 label from S3_OWNED_LABEL, or the readiness probe checks a different name than the scenario owns");
    assert.equal(S3_OWNED_LABEL, "e2eownedns03");
  });

  test("BOB_H160 is the lower-case //Bob H160 the S3 scenario pins", () => {
    const e2e = fs.readFileSync(new URL("../test/e2e.test.js", import.meta.url), "utf8");
    assert.ok(e2e.includes(`const BOB_H160 = "${BOB_H160}"`), ">> FAIL: e2e-fixtures: BOB_H160 drifted from the value S3 pins");
  });
});
