import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { mutateFixture } from "./e2e-fixture.js";
import { runBulletinDeploy } from "./e2e-cli.js";

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
        assert.match(err.message, /^>> FAIL: S4: on-chain contenthash mismatch on e2epool\.dot/);
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
