// Tests for .github/scripts/install-kubo.sh and the drift guard that keeps
// deploy.yml's INLINE Kubo step in lockstep with it.
//
// deploy.yml is a reusable workflow called from other repos: a local
// ./.github/... path there resolves against the CALLER's checkout, so it
// cannot call the script and carries the same logic inline. The drift guard
// below fails if the two copies diverge.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, ".github/scripts/install-kubo.sh");
const VERSION = "v9.9.9";
const TARBALL = `kubo_${VERSION}_linux-amd64.tar.gz`;
const DEAD = "http://127.0.0.1:1"; // connection refused immediately

let tmp, goodTar, goodSha, server, goodBase, badSumBase;

function startServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(s));
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-kubo-"));
  const stage = path.join(tmp, "stage/kubo");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "ipfs"), '#!/bin/sh\necho "ipfs version 9.9.9"\n', { mode: 0o755 });
  goodTar = path.join(tmp, TARBALL);
  execFileSync("tar", ["-czf", goodTar, "-C", path.join(tmp, "stage"), "kubo"]);
  goodSha = crypto.createHash("sha512").update(fs.readFileSync(goodTar)).digest("hex");
  // /good/<tarball>[.sha512] serves valid bytes; /badsum/ serves a wrong digest.
  server = await startServer((req, res) => {
    const [, which, file] = req.url.split("/");
    if (file === TARBALL) return res.end(fs.readFileSync(goodTar));
    if (file === `${TARBALL}.sha512`) {
      const digest = which === "badsum" ? "0".repeat(128) : goodSha;
      return res.end(`${digest}  ${TARBALL}\n`);
    }
    res.statusCode = 404;
    res.end();
  });
  const port = server.address().port;
  goodBase = `http://127.0.0.1:${port}/good`;
  badSumBase = `http://127.0.0.1:${port}/badsum`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(sources, { cache } = {}) {
  const installDir = fs.mkdtempSync(path.join(tmp, "bin-"));
  const cacheDir = cache ?? fs.mkdtempSync(path.join(tmp, "cache-"));
  return new Promise((resolve) => {
    const child = spawn("bash", [SCRIPT, VERSION], {
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        KUBO_INSTALL_DIR: installDir,
        KUBO_CACHE_DIR: cacheDir,
        KUBO_ARCH: "linux-amd64",
        INSTALL_KUBO_TEST_SOURCES: sources.join(" "),
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out, installDir, cacheDir }));
  });
}

describe("install-kubo.sh", () => {
  test("primary dead -> fallback used, warning names the dead source, notice names the used one", async () => {
    const r = await run([DEAD, goodBase]);
    assert.equal(r.code, 0, `>> FAIL: install-kubo fallback: exit ${r.code}\n${r.out}`);
    assert.match(r.out, /::warning::.*127\.0\.0\.1:1/);
    assert.match(r.out, new RegExp(`::notice::.*${goodBase.replace(/[.]/g, "\\.")}`));
    assert.ok(fs.existsSync(path.join(r.installDir, "ipfs")), "binary installed");
    assert.ok(fs.existsSync(path.join(r.cacheDir, "ipfs")), "binary cached");
  });

  test("bad checksum on primary -> fallback used, bad bytes never installed from primary", async () => {
    const r = await run([badSumBase, goodBase]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning::.*checksum mismatch/i);
    assert.match(r.out, /::notice::.*\/good/);
  });

  test("bad checksum everywhere -> hard failure, nothing installed", async () => {
    const r = await run([badSumBase]);
    assert.notEqual(r.code, 0);
    assert.equal(fs.existsSync(path.join(r.installDir, "ipfs")), false);
  });

  test("all sources dead -> non-zero exit with a clear error, quickly", async () => {
    const t0 = Date.now();
    const r = await run([DEAD, DEAD + "/x"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /::error::.*(all|every).*source/i);
    assert.ok(Date.now() - t0 < 30000, "dead hosts must fail over in seconds");
  });

  test("cache hit -> no network access at all", async () => {
    const first = await run([goodBase]);
    assert.equal(first.code, 0, first.out);
    const r = await run([DEAD], { cache: first.cacheDir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /cache/i);
    assert.ok(fs.existsSync(path.join(r.installDir, "ipfs")));
  });
});

// ---- drift guard ---------------------------------------------------------

const CORE_RE = /# BEGIN (install-kubo-[a-z]+)\n([\s\S]*?)# END \1/g;
const norm = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
function coreBlocks(text) {
  return [...text.matchAll(CORE_RE)].map((m) => [m[1], norm(m[2])]);
}

describe("deploy.yml inline Kubo step vs install-kubo.sh (drift guard)", () => {
  const script = fs.readFileSync(SCRIPT, "utf8");
  const deploy = fs.readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8");

  test("shared core blocks (sources, checksum, timeouts) are identical", () => {
    const a = coreBlocks(script);
    const b = coreBlocks(deploy);
    assert.ok(a.length >= 2, "script must expose marked core blocks");
    assert.deepEqual(b, a, ">> FAIL: deploy.yml inline Kubo step has drifted from .github/scripts/install-kubo.sh");
  });

  test("core lists dist.ipfs.tech then the GitHub release, verifies sha512, uses 10s connect timeout", () => {
    const core = coreBlocks(script).map(([, b]) => b).join("\n");
    const iDist = core.indexOf("dist.ipfs.tech");
    const iGh = core.indexOf("github.com/ipfs/kubo/releases/download");
    assert.ok(iDist >= 0 && iGh > iDist, "primary dist.ipfs.tech, then GitHub");
    assert.match(core, /\.sha512/);
    assert.match(core, /--connect-timeout 10\b/);
  });

  test("test-only source override is outside the core and absent from deploy.yml", () => {
    assert.match(script, /INSTALL_KUBO_TEST_SOURCES/);
    assert.equal(deploy.includes("INSTALL_KUBO_TEST_SOURCES"), false);
    for (const [, b] of coreBlocks(script)) assert.equal(b.includes("INSTALL_KUBO_TEST_SOURCES"), false);
  });

  test("deploy.yml keeps its skip conditions and does not call a local script", () => {
    const step = deploy.split("- name: Setup IPFS Kubo")[1].split("\n      - name:")[0];
    assert.match(step, /steps\.cache\.outputs\.cache-hit != 'true' && inputs\.js-merkle != true/);
    assert.equal(step.includes("./.github/scripts"), false, "reusable workflow must stay inline");
  });

  test("every workflow Kubo cache key / script call uses one version", () => {
    const versions = new Set();
    for (const f of ["deploy.yml", "e2e.yml", "tests.yml"]) {
      const t = fs.readFileSync(path.join(ROOT, ".github/workflows", f), "utf8");
      for (const m of t.matchAll(/kubo-(v\d+\.\d+\.\d+)-linux-amd64/g)) versions.add(m[1]);
      for (const m of t.matchAll(/install-kubo\.sh\s+(v\d+\.\d+\.\d+)/g)) versions.add(m[1]);
      for (const m of t.matchAll(/KUBO_VERSION:\s*(v\d+\.\d+\.\d+)/g)) versions.add(m[1]);
    }
    assert.equal(versions.size, 1, `Kubo version must be one value, got ${[...versions]}`);
  });

  test("no workflow downloads Kubo straight from dist.ipfs.tech outside the shared core", () => {
    for (const f of ["e2e.yml", "tests.yml"]) {
      const t = fs.readFileSync(path.join(ROOT, ".github/workflows", f), "utf8");
      assert.equal(t.includes("dist.ipfs.tech"), false, `${f} must use install-kubo.sh`);
    }
  });
});
