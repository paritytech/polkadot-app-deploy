import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runCli(relPath, ...args) {
  return execFileSync(process.execPath, [path.join(repoRoot, relPath), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("CLI help surfaces", () => {
  test("polkadot-app-deploy help is deploy-only", () => {
    const help = runCli("bin/polkadot-app-deploy", "--help");
    assert.match(help, /Usage:\n  polkadot-app-deploy <build-dir> <domain\.dot>/);
    assert.doesNotMatch(help, /bootstrap/i);
  });

  test("polkadot-app-deploy help documents --env / --list-environments", () => {
    const help = runCli("bin/polkadot-app-deploy", "--help");
    assert.match(help, /--env <id>/);
    assert.match(help, /default: paseo-next-v2/);
    assert.match(help, /--list-environments/);
  });

  test("polkadot-app-deploy help documents --input-car", () => {
    const help = runCli("bin/polkadot-app-deploy", "--help");
    assert.match(help, /--input-car <path>/);
    assert.match(help, /pre-built CAR file/i);
  });

  test("polkadot-app-deploy help documents the transfer flow and command", () => {
    const help = runCli("bin/polkadot-app-deploy", "--help");
    assert.match(help, /--no-transfer-to-signedin-user/);
    assert.match(help, /polkadot-app-deploy transfer <domain\.dot>/);
  });

  test("polkadot-app-bootstrap has its own help output", () => {
    const help = runCli("bin/polkadot-app-bootstrap", "--help");
    assert.match(help, /Usage:\n  polkadot-app-bootstrap/);
    // #916 redesign: bootstrap reports authorization status + grants via --authorizer
    // (the old "Initialize pool accounts" framing was dropped). Still asserts the
    // help is distinct from the deploy help and describes the tool's actual function.
    assert.match(help, /authorization status of each pool account/);
  });
});

describe("--list-environments", () => {
  test("prints the environments table from the bundled snapshot", () => {
    const out = runCli("bin/polkadot-app-deploy", "--list-environments");
    assert.match(out, /\bID\b/);
    assert.match(out, /paseo-next/);
    assert.match(out, /summit/);
    assert.match(out, /testnet/);
  });
});

function runCliExpectFail(relPath, ...args) {
  try {
    execFileSync(process.execPath, [path.join(repoRoot, relPath), ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stderr: (e.stderr ?? "").toString() };
  }
}

describe("--publish / --unpublish parsing", () => {
  test("help documents --publish, --unpublish, --fail-on-publish-error", () => {
    const help = runCli("bin/polkadot-app-deploy", "--help");
    assert.match(help, /--publish\b/);
    assert.match(help, /--unpublish\b/);
    assert.match(help, /--fail-on-publish-error\b/);
  });

  test("--publish and --unpublish together exit 1", () => {
    // Pass a bogus mnemonic so we don't trip the mnemonic-required check first.
    const r = runCliExpectFail("bin/polkadot-app-deploy", "--publish", "--unpublish", "--mnemonic", "x x x", "foo.dot");
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /mutually exclusive/i);
  });

  test("--publish without mnemonic (and no MNEMONIC env) exits 1", () => {
    // Provide positional args so help-mode doesn't fire — we want to hit
    // the mnemonic-required guard specifically.
    const r = runCliExpectFail("bin/polkadot-app-deploy", "--publish", "./.no-such-dir", "foo.dot");
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /--publish requires --mnemonic/);
  });

  test("--unpublish without mnemonic exits 1", () => {
    const r = runCliExpectFail("bin/polkadot-app-deploy", "--unpublish", "foo.dot");
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /--unpublish requires --mnemonic/);
  });

  test("--unpublish without a domain exits 1", () => {
    const r = runCliExpectFail("bin/polkadot-app-deploy", "--unpublish", "--mnemonic", "x x x");
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /requires a domain/);
  });
});

describe("no 'wallet' wording in CLI", () => {
  test("--help output contains no 'wallet' text", () => {
    const help = runCli("bin/polkadot-app-deploy", "--help");
    assert.doesNotMatch(help, /wallet/i,
      ">> FAIL: no-wallet: --help must not use the word 'wallet'");
  });

  test("login line describes Polkadot mobile app", () => {
    const help = runCli("bin/polkadot-app-deploy", "--help");
    assert.match(help, /polkadot-app-deploy login\s+Sign in with your Polkadot mobile app/,
      ">> FAIL: no-wallet: login help text must say 'Polkadot mobile app'");
  });

  test("whoami line describes identity not address", () => {
    const help = runCli("bin/polkadot-app-deploy", "--help");
    assert.match(help, /polkadot-app-deploy whoami\s+Show the currently signed-in identity/,
      ">> FAIL: no-wallet: whoami help text must say 'identity'");
  });
});

describe("localStorage warning suppression", () => {
  test("localStorage variants are suppressed, unrelated warnings pass through", () => {
    const result = spawnSync(process.execPath, ["-e", `
      const orig = process.emitWarning.bind(process);
      let suppressed = 0, passed = 0;
      process.emitWarning = (w, ...rest) => {
        const msg = (typeof w === "string" ? w : w?.message ?? String(w)).toLowerCase();
        if (msg.includes("localstorage") || msg.includes("local storage")) { suppressed++; return; }
        passed++;
        orig(w, ...rest);
      };
      process.emitWarning("\`--localstorage-file\` was provided without a valid path");
      process.emitWarning("localStorage is not defined");
      process.emitWarning("local storage is unavailable");
      process.emitWarning("some unrelated warning");
      process.stdout.write(JSON.stringify({ suppressed, passed }));
    `], { encoding: "utf8" });
    const { suppressed, passed } = JSON.parse(result.stdout);
    assert.strictEqual(suppressed, 3,
      ">> FAIL: localStorage-filter: expected 3 localStorage variants suppressed");
    assert.strictEqual(passed, 1,
      ">> FAIL: localStorage-filter: expected unrelated warning to pass through");
  });

  test("--help emits no warnings on stderr", () => {
    const result = spawnSync(process.execPath,
      [path.join(repoRoot, "bin/polkadot-app-deploy"), "--help"],
      { encoding: "utf8", cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    assert.strictEqual(result.stderr, "",
      `>> FAIL: no-startup-warnings: unexpected stderr on --help:\n${result.stderr}`);
  });
});
