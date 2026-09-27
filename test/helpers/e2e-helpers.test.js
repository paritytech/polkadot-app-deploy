import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mutateFixture } from "./e2e-fixture.js";
import { runBulletinDeploy } from "./e2e-cli.js";
import { classifyFixtureState, assertFixtureOwnership, fixtureRemedy, assertFixtureNotDrifted } from "./e2e-failure.js";
import { buildManifestSidecar, buildPvmAppManifest } from "./e2e-manifest-fixture.js";
import { resolveE2eEnv, resolveE2eEnvId } from "./e2e-env.js";
import { preflightProductConfig, DEFAULT_ENV_ID } from "@parity/polkadot-app-deploy";

describe("mutateFixture", () => {
  test("copies fixture to a fresh tempdir and injects runTag into index.html", async () => {
    const { fixtureDir, expectedCid, expectedContenthash } = await mutateFixture("run-abc-1234567");
    try {
      assert.ok(fs.existsSync(path.join(fixtureDir, "index.html")), "index.html copied");
      assert.ok(fs.existsSync(path.join(fixtureDir, "style.css")), "style.css copied");
      const html = fs.readFileSync(path.join(fixtureDir, "index.html"), "utf-8");
      assert.ok(html.includes("<!-- E2E_RUN: run-abc-1234567 -->"), "runTag injected");
      assert.ok(typeof expectedCid === "string" && expectedCid.startsWith("b"), "CIDv1 base32");
      assert.ok(expectedContenthash.startsWith("0xe301"), "contenthash has IPFS prefix");
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("two calls with different runTags produce different CIDs", async () => {
    const a = await mutateFixture("run-aaa");
    const b = await mutateFixture("run-bbb");
    try {
      assert.notStrictEqual(a.expectedCid, b.expectedCid);
    } finally {
      fs.rmSync(a.fixtureDir, { recursive: true, force: true });
      fs.rmSync(b.fixtureDir, { recursive: true, force: true });
    }
  });

  test("ignores generated .bulletin-deploy state in the source fixture", async () => {
    const generatedStateDir = path.resolve("test/fixtures/e2e-spa/.bulletin-deploy");
    fs.mkdirSync(generatedStateDir, { recursive: true });
    fs.writeFileSync(path.join(generatedStateDir, "manifest.json"), "{}");

    let fixtureDir;
    try {
      ({ fixtureDir } = await mutateFixture("run-generated-state"));
      assert.ok(fs.existsSync(path.join(fixtureDir, "index.html")), "index.html copied");
      assert.ok(!fs.existsSync(path.join(fixtureDir, ".bulletin-deploy")), "generated deploy state skipped");
    } finally {
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(generatedStateDir, { recursive: true, force: true });
    }
  });
});

describe("runBulletinDeploy", () => {
  test("returns exit code, stdout, stderr, durationMs for --version", async () => {
    const result = await runBulletinDeploy({ args: ["--version"], timeoutMs: 10_000 });
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /polkadot-app-deploy v\d+\.\d+\.\d+/);
    assert.ok(typeof result.durationMs === "number" && result.durationMs >= 0);
  });

  test("exits with non-zero for missing args", async () => {
    // Passing only a build-dir without a domain — CLI requires both
    const result = await runBulletinDeploy({ args: ["somedir"], env: { CI: "" }, timeoutMs: 10_000 });
    assert.notStrictEqual(result.code, 0);
  });

  test("enforces timeout with SIGTERM", async () => {
    const result = await runBulletinDeploy({
      args: ["./test/fixtures/e2e-spa", "thiswillhang.dot"],
      env: { BULLETIN_RPC: "ws://192.0.2.1:9944" },
      timeoutMs: 2_000,
    });
    assert.notStrictEqual(result.code, 0);
    assert.ok(result.durationMs < 10_000);
  });
});

import { classifyDeployStderr } from "./e2e-failure.js";

describe("e2e-failure: classifyDeployStderr", () => {
  test("classifies tx Invalid (Stale) as nonce_stale", () => {
    const out = classifyDeployStderr("...error...\nInvalid: Stale\n...trailing...");
    assert.strictEqual(out.class, "nonce_stale");
    assert.match(out.summary, /nonce/i);
  });

  test("classifies ChainHead disjointed", () => {
    const out = classifyDeployStderr("ChainHead disjointed at block 12345");
    assert.strictEqual(out.class, "chainhead_disjointed");
    assert.match(out.summary, /reorg|RPC|chain/i);
  });

  test("classifies max reconnections exhausted as connection_lost", () => {
    const out = classifyDeployStderr("WS budget exhausted: max reconnections (3) exhausted");
    assert.strictEqual(out.class, "connection_lost");
    assert.match(out.summary, /budget|reconnect/i);
  });

  test("classifies Connection lost as connection_lost", () => {
    const out = classifyDeployStderr("WebSocket: Connection lost mid-deploy");
    assert.strictEqual(out.class, "connection_lost");
  });

  test("classifies Account mapping race", () => {
    const out = classifyDeployStderr("Account mapping did not take effect on-chain for 5Df...");
    assert.strictEqual(out.class, "account_mapping_race");
  });

  test("classifies node-version drift", () => {
    const out = classifyDeployStderr("Error: bulletin-deploy requires Node.js >=22 (running v18.19.1)");
    assert.strictEqual(out.class, "node_version_drift");
  });

  test("classifies runner shutdown", () => {
    const out = classifyDeployStderr("##[error]The runner has received a shutdown signal.");
    assert.strictEqual(out.class, "runner_shutdown");
  });

  test("classifies gateway timeout (fetchManifestRoundtrip)", () => {
    const out = classifyDeployStderr("fetchManifestRoundtrip failed: roundtrip budget exhausted");
    assert.strictEqual(out.class, "gateway_timeout");
  });

  test("classifies Contract execution would revert", () => {
    const out = classifyDeployStderr("Contract execution would revert during setContenthash");
    assert.strictEqual(out.class, "contract_revert");
  });

  test("classifies Contract reverted flags=1", () => {
    const out = classifyDeployStderr("Contract reverted (flags=1) with data: 0xabcd");
    assert.strictEqual(out.class, "contract_revert");
  });

  test("returns unknown when no pattern matches", () => {
    const out = classifyDeployStderr("Some unrelated error that doesn't match");
    assert.strictEqual(out.class, "unknown");
    assert.match(out.summary, /unrecognized|unknown/i);
  });
});

import { pickContextLines } from "./e2e-failure.js";

describe("e2e-failure: pickContextLines", () => {
  test("returns last N non-blank lines when no keywords provided", () => {
    const text = "first\n\nsecond\nthird\nfourth\n";
    const out = pickContextLines(text, { maxLines: 2 });
    assert.deepStrictEqual(out, ["third", "fourth"]);
  });

  test("prefers lines containing any keyword", () => {
    const text = ["alpha", "beta", "Probed: 12 chunks", "gamma", "Probed: skipped", "delta"].join("\n");
    const out = pickContextLines(text, { keywords: ["Probed"], maxLines: 3 });
    assert.deepStrictEqual(out, ["Probed: 12 chunks", "Probed: skipped"]);
  });

  test("falls back to last N lines when no keyword matches", () => {
    const text = "alpha\nbeta\ngamma\n";
    const out = pickContextLines(text, { keywords: ["nothere"], maxLines: 2 });
    assert.deepStrictEqual(out, ["beta", "gamma"]);
  });

  test("skips banner blocks between ═════ separators", () => {
    const text = [
      "Real signal 1",
      "============================================================",
      "DEPLOYMENT COMPLETE!",
      "============================================================",
      "Real signal 2",
    ].join("\n");
    const out = pickContextLines(text, { maxLines: 5 });
    // Banner content dropped — only the two "Real signal" lines remain.
    assert.deepStrictEqual(out, ["Real signal 1", "Real signal 2"]);
  });

  test("skips blank lines and trailing whitespace", () => {
    const text = "alpha\n   \n\nbeta\n  \ngamma\n";
    const out = pickContextLines(text, { maxLines: 3 });
    assert.deepStrictEqual(out, ["alpha", "beta", "gamma"]);
  });

  test("handles empty text without crashing", () => {
    assert.deepStrictEqual(pickContextLines("", { maxLines: 5 }), []);
    assert.deepStrictEqual(pickContextLines(undefined, { maxLines: 5 }), []);
  });

  test("emits lines after an unclosed banner (treat unpaired separator as content)", () => {
    const text = [
      "line before",
      "================",
      "inside banner",
      "line after",
    ].join("\n");
    const out = pickContextLines(text, { maxLines: 10 });
    // Both "line before" and "line after" must appear; "inside banner" is
    // ambiguous (caller intent unclear) — accept either presence or absence.
    assert.ok(out.includes("line before"), `expected 'line before' in output, got ${JSON.stringify(out)}`);
    assert.ok(out.includes("line after"), `expected 'line after' in output, got ${JSON.stringify(out)}`);
  });
});

import {
  assertDeploySucceeded,
  assertStdoutMatches,
  parseLineOrExplain,
  assertOnChainMatches,
  failWith,
  FLAKE_PATTERNS,
} from "./e2e-failure.js";

describe("e2e-failure: assertDeploySucceeded", () => {
  test("no-op on exit 0", () => {
    assertDeploySucceeded({ code: 0, stdout: "ok", stderr: "" }, { scenario: "S1" });
  });

  test("throws with >> FAIL prefix + scenario + classified summary on non-zero exit", () => {
    assert.throws(
      () => assertDeploySucceeded(
        { code: 1, stdout: "...", stderr: "tx Invalid: Stale\nother stuff" },
        { scenario: "S-INC" },
      ),
      (err) => {
        assert.match(err.message, /^>> FAIL: S-INC deploy: nonce_stale \(exit 1\)/);
        assert.match(err.message, /Asset Hub tx Invalid/);
        return true;
      },
    );
  });

  test("falls back to 'unknown' class when stderr doesn't match any pattern", () => {
    assert.throws(
      () => assertDeploySucceeded(
        { code: 1, stdout: "", stderr: "totally unrelated" },
        { scenario: "S1" },
      ),
      (err) => {
        assert.match(err.message, /^>> FAIL: S1 deploy: unknown \(exit 1\)/);
        return true;
      },
    );
  });

  test("uses ctx.step when provided", () => {
    assert.throws(
      () => assertDeploySucceeded(
        { code: 1, stdout: "", stderr: "" },
        { scenario: "S2", step: "fresh-register" },
      ),
      (err) => {
        assert.match(err.message, /^>> FAIL: S2 fresh-register:/);
        return true;
      },
    );
  });

  test("a Kubo leg that never ran Kubo fails, even with nothing on stderr", () => {
    const prev = process.env.E2E_MERKLE;
    const ranJs = { code: 0, stdout: "   Merkleizing (JS): /tmp/fixture", stderr: "" };
    try {
      process.env.E2E_MERKLE = "kubo";
      assert.throws(() => assertDeploySucceeded(ranJs, { scenario: "S1" }),
        /^Error: >> FAIL: S1 deploy: Kubo leg never ran the Kubo merkleizer/);
      assertDeploySucceeded({ code: 0, stdout: "   Merkleizing (Kubo): /tmp/fixture", stderr: "" }, { scenario: "S1" });
      process.env.E2E_MERKLE = "js";
      assertDeploySucceeded(ranJs, { scenario: "S1" });
    } finally {
      if (prev === undefined) delete process.env.E2E_MERKLE; else process.env.E2E_MERKLE = prev;
    }
  });

  test("a Kubo leg that fell back to JS fails even on exit 0", () => {
    const prev = process.env.E2E_MERKLE;
    const fellBack = { code: 0, stdout: "ok", stderr: "   Kubo merkleize failed, falling back to JS: no IPFS repo found" };
    try {
      process.env.E2E_MERKLE = "kubo";
      assert.throws(() => assertDeploySucceeded(fellBack, { scenario: "S1" }), /^Error: >> FAIL: S1 deploy: Kubo leg fell back to the JS merkleizer/);
      process.env.E2E_MERKLE = "js";
      assertDeploySucceeded(fellBack, { scenario: "S1" });
    } finally {
      if (prev === undefined) delete process.env.E2E_MERKLE; else process.env.E2E_MERKLE = prev;
    }
  });
});

// tools/release-retry-wrapper.mjs has its own, separate FLAKE_PATTERNS list
// (plain substrings, not this file's {needle, class, summary} shape) and
// test/test-release-retry-wrapper.js scans the WHOLE harness file against
// that list — this twin has no equivalent scan against e2e-failure.js's own
// list (tracked separately as #276). This test covers #273's narrower ask:
// S8's WS-fault legs are the scenario most likely to grow a new failure
// message that happens to echo one of e2e-failure.js's classifyDeployStderr
// needles (e.g. "ChainHead disjointed"), which would make a genuine S8
// regression print as a retryable flake instead of failing the run.
describe("e2e-failure: FLAKE_PATTERNS avoidance", () => {
  test("no S8 assertion string in test/e2e.test.js matches a FLAKE_PATTERNS needle", () => {
    const harness = fs.readFileSync(new URL("../e2e.test.js", import.meta.url), "utf8");
    const lines = harness.split("\n");
    const start = lines.findIndex((l) => /describe\("S8 —/.test(l));
    const end = lines.findIndex((l, i) => i > start && /describe\("S9 —/.test(l));
    assert.ok(start >= 0 && end > start, "could not find the S8...S9 describe boundary in test/e2e.test.js — did a title change?");
    const s8Lines = lines.slice(start, end);
    const assertionLines = s8Lines.filter((l) => /(^|\s)(hint|message):/.test(l) || l.includes(">> FAIL:"));
    for (const { needle } of FLAKE_PATTERNS) {
      const offender = assertionLines.find((l) => l.includes(needle));
      assert.strictEqual(
        offender,
        undefined,
        `>> FAIL: e2e-helpers: S8 in test/e2e.test.js prints the flake pattern "${needle}" on a failure path, so tripping that assertion would be misread as a retryable flake. Reword it. Line: ${offender?.trim()}`,
      );
    }
  });
});

describe("e2e-failure: assertStdoutMatches", () => {
  test("no-op when pattern matches", () => {
    assertStdoutMatches("hello world", /world/, { scenario: "S1", what: "greeting" });
  });

  test("throws with structured message on no match", () => {
    const stdout = "alpha\nbeta\nProbed: 12 chunks → 10 on chain\n";
    assert.throws(
      () => assertStdoutMatches(stdout, /Probed:\s+\d+ chunks\s+→\s+\d+ cached/, {
        scenario: "S-INC",
        what: "chunk-cache rate line",
        hint: "CLI wording may have changed (cached → on chain).",
      }),
      (err) => {
        assert.match(err.message, /^>> FAIL: S-INC: chunk-cache rate line/);
        assert.match(err.message, /expected stdout line matching/);
        assert.match(err.message, /Probed: 12 chunks/);
        assert.match(err.message, /hint: CLI wording/);
        return true;
      },
    );
  });
});

describe("e2e-failure: parseLineOrExplain", () => {
  test("returns the match on a hit", () => {
    const m = parseLineOrExplain("CID: bafyabc\n", {
      pattern: /CID:\s+(bafy\S+)/,
      scenario: "S1",
      what: "deployed CID",
    });
    assert.strictEqual(m[1], "bafyabc");
  });

  test("throws with structured message on miss", () => {
    assert.throws(
      () => parseLineOrExplain("no cid here\n", {
        pattern: /CID:\s+(bafy\S+)/,
        scenario: "S1",
        what: "deployed CID",
        hint: "CLI should print a 'CID:' line on every successful deploy.",
      }),
      (err) => {
        assert.match(err.message, /^>> FAIL: S1: deployed CID/);
        assert.match(err.message, /pattern .*CID/);
        assert.match(err.message, /hint:/);
        return true;
      },
    );
  });
});

describe("e2e-failure: assertOnChainMatches", () => {
  test("no-op when on-chain matches expected", () => {
    assertOnChainMatches("0xabc", "0xabc", { scenario: "S1", label: "e2epool" });
  });

  test("throws structured mismatch on differ", () => {
    assert.throws(
      () => assertOnChainMatches("0xdeadbeef", "0xabc", { scenario: "S4", label: "e2epool" }),
      (err) => {
        assert.match(err.message, /^>> FAIL: S4: on-chain contenthash mismatch on e2epool$/m);
        assert.match(err.message, /wrote:\s+0xabc/);
        assert.match(err.message, /chain:\s+0xdeadbeef/);
        return true;
      },
    );
  });
});

describe("e2e-failure: failWith", () => {
  test("throws with structured message including context keywords", () => {
    const stdout = "alpha\nProbed: 12 chunks → 5 on chain\nbeta\n";
    assert.throws(
      () => failWith({
        scenario: "S-INC",
        message: "chunk-skip rate too low (5/12 = 42%)",
        context: stdout,
        keywords: ["Probed"],
        hint: "likely chunk-alignment regression",
      }),
      (err) => {
        assert.match(err.message, /^>> FAIL: S-INC: chunk-skip rate too low/);
        assert.match(err.message, /Probed: 12 chunks/);
        assert.match(err.message, /hint: likely chunk-alignment/);
        return true;
      },
    );
  });
});

// Guards the diagnostic that tells FIXTURE DRIFT apart from a product
// regression. Both look like "expected exit 78, got 0" at the exit-code level,
// and conflating them is what let a scenario like this sit red for a week.
describe("classifyFixtureState", () => {
  const BOB = "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01";

  test("registration wiped by a re-genesis is reported as missing", () => {
    const out = "   Domain: e2eownedns01.dot\n   Domain: available\n   e2eownedns01.dot is available";
    assert.deepStrictEqual(classifyFixtureState({ output: out, expectedOwner: BOB }), { kind: "missing", owner: null },
      ">> FAIL: classifyFixtureState: an unregistered fixture must be reported as missing, not as a product failure");
  });

  test("label re-registered to the deploy signer is reported as drifted, naming the squatter", () => {
    const out = "Deployment failed: Domain e2eownedns01.dot is already owned by 0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20.";
    const got = classifyFixtureState({ output: out, expectedOwner: BOB });
    assert.strictEqual(got.kind, "drifted",
      ">> FAIL: classifyFixtureState: a label owned by someone other than the fixture owner must be reported as drifted");
    assert.strictEqual(got.owner, "0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20",
      ">> FAIL: classifyFixtureState: must name the actual owner so the operator knows who squatted it");
  });

  test("correct owner is ok even when the H160 case differs", () => {
    const out = "Deployment failed: Domain e2eownedns01.dot is already owned by 0x41dCCBD49b26c50d34355Ed86ff0FA9E489d1e01.";
    assert.strictEqual(classifyFixtureState({ output: out, expectedOwner: BOB }).kind, "ok",
      ">> FAIL: classifyFixtureState: H160 comparison must be case-insensitive — chains return EIP-55 checksummed addresses");
  });

  test("a genuine product failure is NOT misreported as drift", () => {
    const out = "Deployment failed: chunk upload timed out after 180s";
    assert.strictEqual(classifyFixtureState({ output: out, expectedOwner: BOB }).kind, "ok",
      ">> FAIL: classifyFixtureState: unrelated failures must fall through to the normal assertions, not be blamed on fixtures");
  });

  // Real shape from a version-nudge line adjacent to the ownership line
  // (bulletin #1398/#1333): the old classifier matched "is available" in the
  // update notice ("A newer version of ... is available") and reported the
  // fixture unregistered even though the deploy correctly refused with the
  // ownership line naming the expected owner.
  const NUDGE = "   A newer version of @parity/polkadot-app-deploy is available (0.16.0-rc.2 → 0.16.0).";
  const RUN_ANCHOR_CASE = [
    NUDGE,
    "Deployment failed (not retryable): Domain e2eownedns01.testnet is already owned by 0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01.",
    NUDGE,
  ].join("\n");

  test("update notice does not override an ownership line naming the expected owner", () => {
    assert.deepStrictEqual(
      classifyFixtureState({ output: RUN_ANCHOR_CASE, expectedOwner: BOB, label: "e2eownedns01.testnet" }),
      { kind: "ok", owner: "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01" },
      ">> FAIL: classifyFixtureState: a correct exit-78 run naming the expected owner must be ok, not 'missing'; the version nudge is not the domain's status",
    );
  });

  test("update notice alone does not mean missing", () => {
    const out = `${NUDGE}\nDeployment failed: chunk upload timed out after 180s`;
    assert.strictEqual(classifyFixtureState({ output: out, expectedOwner: BOB, label: "e2eownedns01.testnet" }).kind, "ok",
      ">> FAIL: classifyFixtureState: with no ownership line and no domain status line the cause is unclassified (ok), never 'missing'");
    assert.strictEqual(classifyFixtureState({ output: out, expectedOwner: BOB }).kind, "ok",
      ">> FAIL: classifyFixtureState: the unanchored fallback must ignore the version nudge too");
  });

  test("ownership line wins over an availability line", () => {
    const out = "   e2eownedns01.dot is available\nDeployment failed: Domain e2eownedns01.dot is already owned by 0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20.";
    assert.deepStrictEqual(classifyFixtureState({ output: out, expectedOwner: BOB, label: "e2eownedns01.dot" }),
      { kind: "drifted", owner: "0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20" },
      ">> FAIL: classifyFixtureState: 'is already owned by' is the CLI's definitive statement and must decide the verdict");
  });

  test("with a label, only that domain's availability line means missing", () => {
    const own = "   Checking availability of e2eownedns03.paseo...\n   e2eownedns03.paseo is available\n   Finalizing registration for e2eownedns03.paseo...";
    assert.strictEqual(classifyFixtureState({ output: own, expectedOwner: BOB, label: "e2eownedns03.paseo" }).kind, "missing",
      ">> FAIL: classifyFixtureState: the domain's own 'is available' line must still be recognised when anchored to the label");
    assert.strictEqual(classifyFixtureState({ output: "   e2eother.paseo is available", expectedOwner: BOB, label: "e2eownedns03.paseo" }).kind, "ok",
      ">> FAIL: classifyFixtureState: another label's availability says nothing about this fixture");
  });
});

// bulletin #1378/#1341: assertFixtureOwnership is the PRECHECK counterpart to
// classifyFixtureState above — it runs BEFORE the scenario, from a direct
// ownerOf-style read, and throws instead of returning a classification. It
// takes the ownership result rather than a live DotNS client precisely so
// the "registry got wiped" and "registry drifted" states can be driven here
// without unregistering or transferring any real fixture on chain.
describe("assertFixtureOwnership", () => {
  const BOB = "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01";
  const args = { label: "e2eownedns03", tld: "paseo", expectedOwner: BOB, scenario: "S3", envLabel: "paseo-next-v2" };

  test("correctly owned by the expected third party: does not throw", () => {
    assert.doesNotThrow(() =>
      assertFixtureOwnership({ ...args, ownership: { owned: false, owner: BOB } }));
  });

  test("owner comparison is case-insensitive (chains return EIP-55 checksummed addresses)", () => {
    assert.doesNotThrow(() =>
      assertFixtureOwnership({ ...args, ownership: { owned: false, owner: "0x41dCCBD49b26c50d34355Ed86ff0FA9E489d1e01" } }));
  });

  test("unowned (registry wiped by a redeploy): throws naming the reset + that this repo has no fixture-registration tool", () => {
    assert.throws(
      () => assertFixtureOwnership({ ...args, ownership: { owned: false, owner: null } }),
      (err) => {
        assert.match(err.message, /^>> FAIL: S3: fixture precheck failed:/);
        assert.match(err.message, /UNOWNED/);
        assert.match(err.message, /registry was probably reset/);
        assert.match(err.message, /ships no fixture-registration tool/);
        return true;
      },
      ">> FAIL: assertFixtureOwnership: an unowned fixture must be reported as a likely registry reset, naming the admin remedy, not left to surface downstream as a confusing exit-code mismatch",
    );
  });

  // register-test-fixture-equivalent admin repair can only move a name the
  // funder holds; anyone else's holding cannot be repaired at all (bulletin #1398).
  test("owned by the funder: names the holder and recommends the admin transfer remedy", () => {
    const funder = "0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20";
    assert.throws(
      () => assertFixtureOwnership({ ...args, funder, ownership: { owned: false, owner: funder } }),
      (err) => {
        assert.match(err.message, /^>> FAIL: S3: fixture precheck failed:/);
        assert.ok(err.message.includes(funder), "names the actual owner");
        assert.ok(err.message.includes(BOB), "names the expected owner");
        assert.match(err.message, /transfer .*from the funder/);
        return true;
      },
      ">> FAIL: assertFixtureOwnership: a funder-held fixture must name the holder and recommend an admin transfer, since it's the one holder an admin CAN move",
    );
  });

  test("owned by a third party: names the holder and does not recommend a transfer", () => {
    const squatter = "0x237a2b18d1e5e3b2a1c4f6e7d8c9b0a1f2e3d4c5";
    assert.throws(
      () => assertFixtureOwnership({ ...args, funder: "0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20", ownership: { owned: false, owner: squatter } }),
      (err) => {
        assert.match(err.message, /^>> FAIL: S3: fixture precheck failed:/);
        assert.ok(err.message.includes(squatter), "names the actual owner");
        assert.ok(err.message.includes(BOB), "names the expected owner");
        assert.doesNotMatch(err.message, /transfer .*from the funder/,
          "must not prescribe a transfer this repo has no authority or tool to perform");
        assert.match(err.message, /fresh fixture label|different fixture label/);
        assert.match(err.message, /cannot be seized/);
        return true;
      },
      ">> FAIL: assertFixtureOwnership: a third-party-held fixture must not recommend a transfer remedy; the honest remedy is a fresh label",
    );
  });
});

// fixtureRemedy follows the twin's admin-repair reality: no register-test-fixture
// tool exists, so every remedy is an admin action, but unowned/funder-held stay
// repairable while third-party-held is not (bulletin #1398).
describe("fixtureRemedy", () => {
  const BOB = "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01";
  const FUNDER = "0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20";
  const base = { label: "e2eownedns03", envLabel: "paseo-next-v2", expectedOwner: BOB, funder: FUNDER };

  test("unowned: admin registers it to the expected owner", () => {
    const { fix, hint } = fixtureRemedy({ ...base, owner: null });
    assert.match(fix, /ask the chain admin to register e2eownedns03/);
    assert.match(hint, /unowned/);
  });

  test("funder-held: admin transfers it (case-insensitive)", () => {
    const { fix, hint } = fixtureRemedy({ ...base, owner: "0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20" });
    assert.match(fix, /ask the chain admin to transfer e2eownedns03 from the funder/);
    assert.match(hint, /is the funder/);
  });

  test("third-party-held: fresh label, no transfer prescribed", () => {
    const { fix, hint } = fixtureRemedy({ ...base, owner: "0x237a2b18d1e5e3b2a1c4f6e7d8c9b0a1f2e3d4c5" });
    assert.doesNotMatch(fix, /transfer/,
      ">> FAIL: fixtureRemedy: must not tell the operator to move a name nobody has authority to seize");
    assert.match(fix, /different fixture label/);
    assert.match(hint, /cannot be seized/);
  });

  test("funder unknown: a wrong holder is not treated as repairable", () => {
    const { fix, hint } = fixtureRemedy({ ...base, funder: undefined, owner: FUNDER });
    assert.doesNotMatch(fix, /transfer/);
    assert.match(hint, /neither .* nor the funder/);
  });
});

// assertFixtureNotDrifted checks the deploy output offline (bulletin #1398).
describe("assertFixtureNotDrifted", () => {
  const BOB = "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01";
  const FUNDER = "0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20";
  const NUDGE = "   A newer version of @parity/polkadot-app-deploy is available (0.16.0-rc.2 → 0.16.0).";
  const args = { label: "e2eownedns01", tld: "testnet", expectedOwner: BOB, funder: FUNDER, scenario: "S3", envLabel: "preview" };

  test("exit-78 refusal naming the expected owner, with the update notice around it, is not drift", () => {
    const output = [NUDGE, "Deployment failed (not retryable): Domain e2eownedns01.testnet is already owned by 0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01.", NUDGE].join("\n");
    assert.doesNotThrow(() => assertFixtureNotDrifted({ ...args, output }),
      ">> FAIL: assertFixtureNotDrifted: a correct exit-78 refusal must pass through to the exit-code assertions, not be reported as drift");
  });

  test("unclassified output returns kind ok without throwing", () => {
    const got = assertFixtureNotDrifted({ ...args, output: `${NUDGE}\nDeployment failed: chunk upload timed out after 180s` });
    assert.deepStrictEqual(got, { kind: "ok", owner: null },
      ">> FAIL: assertFixtureNotDrifted: with no drift evidence the helper must not guess a cause");
  });

  test("name found free and registered by the deploy signer", () => {
    const output = "   Checking availability of e2eownedns01.testnet...\n   e2eownedns01.testnet is available\n   Finalizing registration for e2eownedns01.testnet...";
    assert.throws(() => assertFixtureNotDrifted({ ...args, output }), (err) => {
      assert.match(err.message, /^>> FAIL: S3: fixture drift on env "preview"/);
      assert.match(err.message, /was unregistered when the deploy started/);
      assert.match(err.message, /owned by the deploy signer/);
      assert.match(err.message, /Fix: rerun this scenario/);
      return true;
    }, ">> FAIL: assertFixtureNotDrifted: a wiped fixture must be described as it actually is after the deploy ran");
  });

  test("owned by the funder: names both addresses and recommends the admin transfer remedy", () => {
    const output = "Deployment failed (not retryable): Domain e2eownedns01.testnet is already owned by 0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20.";
    assert.throws(() => assertFixtureNotDrifted({ ...args, output }), (err) => {
      assert.match(err.message, /^>> FAIL: S3: fixture drift on env "preview"/);
      assert.ok(err.message.includes("0x35Cdb23fF7fc86E8DCcd577CA309bFEA9c978D20"), "names the actual owner");
      assert.ok(err.message.includes(BOB), "names the expected owner");
      assert.match(err.message, /transfer e2eownedns01 from the funder/);
      return true;
    }, ">> FAIL: assertFixtureNotDrifted: a funder-held fixture must name both parties and the transfer remedy");
  });

  test("owned by a third party: names both addresses and does not recommend a transfer", () => {
    const output = "Deployment failed (not retryable): Domain e2eownedns01.testnet is already owned by 0x237a2b18d1e5e3b2a1c4f6e7d8c9b0a1f2e3d4c5.";
    assert.throws(() => assertFixtureNotDrifted({ ...args, output }), (err) => {
      assert.ok(err.message.includes("0x237a2b18d1e5e3b2a1c4f6e7d8c9b0a1f2e3d4c5"), "names the actual owner");
      assert.ok(err.message.includes(BOB), "names the expected owner");
      assert.doesNotMatch(err.message, /transfer e2eownedns01/);
      assert.match(err.message, /different fixture label/);
      return true;
    }, ">> FAIL: assertFixtureNotDrifted: a third-party-held fixture must not recommend a remedy nobody has authority to perform");
  });
});

// Offline half of S-MANIFEST-PVM: the deploy's own preflight must accept the fixture.
describe("buildManifestSidecar: App v2 PolkaVM executable", () => {
  test("passes the product preflight and embeds the bytes the executable record carries", async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-build-"));
    const appManifest = buildPvmAppManifest();
    const { configPath, sidecarDir } = buildManifestSidecar({ buildDir, label: "e2epvmman", tld: "dot", appManifest });
    try {
      await preflightProductConfig({ path: configPath });
      assert.equal(fs.readFileSync(path.join(buildDir, "manifest.json"), "utf8"), JSON.stringify(appManifest),
        ">> FAIL: S-MANIFEST-PVM fixture: the embedded manifest.json differs from the bytes the executable record carries");
    } finally {
      fs.rmSync(sidecarDir, { recursive: true, force: true });
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
  });
});

// A run with no PAD_ENV is a DEFAULT_ENV_ID run: deploy() resolves
// `options.env ?? DEFAULT_ENV_ID`, so the TLD, gateway, Bulletin endpoint and
// DotNS contracts the harness reads must come from that same env.
describe("resolveE2eEnv", () => {
  test("no PAD_ENV resolves the env the CLI itself would pick", () => {
    for (const unset of [null, undefined, ""]) {
      assert.equal(resolveE2eEnvId(unset), DEFAULT_ENV_ID,
        `>> FAIL: resolveE2eEnv: ${JSON.stringify(unset)} must resolve to DEFAULT_ENV_ID, the env deploy() falls back to`);
    }
  });

  test("an explicit env is used as given", () => {
    assert.equal(resolveE2eEnvId("devnet"), "devnet",
      ">> FAIL: resolveE2eEnv: an explicit PAD_ENV must win over the default");
  });

  test("the unset path and the explicit default path describe the same chain", async () => {
    const implicit = await resolveE2eEnv(null);
    const explicit = await resolveE2eEnv(DEFAULT_ENV_ID);
    assert.deepEqual(implicit, explicit,
      ">> FAIL: resolveE2eEnv: the no-env path diverged from DEFAULT_ENV_ID, so the harness reads a different chain than the deploy writes");
  });

  test("resolves per-environment values rather than a fixed literal", async () => {
    const dflt = await resolveE2eEnv(null);
    const devnet = await resolveE2eEnv("devnet");
    for (const key of ["tld", "bulletin", "gateway"]) {
      assert.notEqual(dflt[key], devnet[key],
        `>> FAIL: resolveE2eEnv: ${key} is identical across two environments, so it is not being read from environments.json`);
    }
    assert.equal(dflt.dotnsConnectOptions.rpc, dflt.dotnsConnectOptions.assetHubEndpoints[0],
      ">> FAIL: resolveE2eEnv: the DotNS rpc must be the resolved env's own Asset Hub, not a legacy default");
    assert.ok(dflt.dotnsConnectOptions.nativeToEthRatio,
      ">> FAIL: resolveE2eEnv: nativeToEthRatio must be forwarded; DotNS prices the register deposit with it");
    assert.ok(dflt.dotnsConnectOptions.contracts,
      ">> FAIL: resolveE2eEnv: the default env configures contracts; dropping them falls back to DotNS's hardcoded pre-redeploy addresses");
  });
});
