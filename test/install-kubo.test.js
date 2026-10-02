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

let tmp, goodTar, goodSha, server, goodBase, wrongBase;

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
  // /good/<tarball> serves the valid bytes, /wrong/<tarball> serves different bytes.
  // No .sha512 file is served: the expected hash is pinned in the script, never fetched.
  server = await startServer((req, res) => {
    const [, which, file] = req.url.split("/");
    if (file === TARBALL) return res.end(which === "wrong" ? Buffer.from("not the kubo tarball") : fs.readFileSync(goodTar));
    res.statusCode = 404;
    res.end();
  });
  const port = server.address().port;
  goodBase = `http://127.0.0.1:${port}/good`;
  wrongBase = `http://127.0.0.1:${port}/wrong`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(sources, { cache, version = VERSION, sha512 = goodSha } = {}) {
  const installDir = fs.mkdtempSync(path.join(tmp, "bin-"));
  const cacheDir = cache ?? fs.mkdtempSync(path.join(tmp, "cache-"));
  return new Promise((resolve) => {
    const child = spawn("bash", [SCRIPT, version], {
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        KUBO_INSTALL_DIR: installDir,
        KUBO_CACHE_DIR: cacheDir,
        KUBO_ARCH: "linux-amd64",
        ...(sources ? { INSTALL_KUBO_TEST_SOURCES: sources.join(" ") } : {}),
        ...(sha512 ? { INSTALL_KUBO_TEST_SHA512: sha512 } : {}),
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

  test("primary serves a wrong tarball -> sha512 mismatch warning, fallback used, wrong bytes never installed", async () => {
    const r = await run([wrongBase, goodBase]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning::.*\/wrong.*sha512 mismatch/i);
    assert.match(r.out, /::notice::.*\/good.*matches the pinned hash/);
  });

  test("every source wrong -> hard failure, nothing installed", async () => {
    const r = await run([wrongBase, wrongBase + "/"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /::error::.*all sources failed/);
    assert.equal(fs.existsSync(path.join(r.installDir, "ipfs")), false);
  });

  test("unknown version/arch (no pinned hash) -> clear error telling the maintainer to add one, no download", async () => {
    const r = await run(null, { version: "v0.0.1", sha512: null });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /::error::No pinned sha512 for Kubo v0\.0\.1 linux-amd64/);
  });

  test("the pinned hash for the shipped version is a 128-char hex string", () => {
    const m = fs.readFileSync(SCRIPT, "utf8").match(/v0\.33\.0\/linux-amd64\) KUBO_SHA512="([0-9a-f]+)"/);
    assert.ok(m && m[1].length === 128, "v0.33.0/linux-amd64 must be pinned");
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
    assert.ok(a.length >= 3, "script must expose marked core blocks");
    assert.deepEqual(b, a, ">> FAIL: deploy.yml inline Kubo step has drifted from .github/scripts/install-kubo.sh");
  });

  test("core lists dist.ipfs.tech then the GitHub release, verifies sha512, uses 10s connect timeout", () => {
    const core = coreBlocks(script).map(([, b]) => b).join("\n");
    const iDist = core.indexOf("dist.ipfs.tech");
    const iGh = core.indexOf("github.com/ipfs/kubo/releases/download");
    assert.ok(iDist >= 0 && iGh > iDist, "primary dist.ipfs.tech, then GitHub");
    assert.match(core, /KUBO_SHA512/);
    assert.equal(core.includes(".sha512"), false, "hash is pinned in-repo, never fetched");
    assert.match(core, /--connect-timeout 10\b/);
    assert.match(core, /--max-time 120\b/);
    assert.match(core, /--speed-limit 50000 --speed-time 15/);
  });

  test("test-only source override is outside the core and absent from deploy.yml", () => {
    for (const v of ["INSTALL_KUBO_TEST_SOURCES", "INSTALL_KUBO_TEST_SHA512"]) {
      assert.match(script, new RegExp(v));
      assert.equal(deploy.includes(v), false);
      for (const [, b] of coreBlocks(script)) assert.equal(b.includes(v), false);
    }
  });

  test("deploy.yml keeps its skip conditions and does not call a local script", () => {
    const step = deploy.split("- name: Setup IPFS Kubo")[1].split("\n      - name:")[0];
    assert.match(step, /steps\.cache\.outputs\.cache-hit != 'true' && inputs\.js-merkle != true/);
    assert.equal(step.includes("./.github/scripts"), false, "reusable workflow must stay inline");
  });

  test("one Kubo version: deploy.yml KUBO_VERSION equals the setup-kubo action default, nothing else hard-codes one", () => {
    const action = fs.readFileSync(path.join(ROOT, ".github/actions/setup-kubo/action.yml"), "utf8");
    const def = action.match(/default:\s*(v\d+\.\d+\.\d+)/)?.[1];
    assert.ok(def, "setup-kubo must declare a default version");
    const dv = deploy.match(/KUBO_VERSION:\s*(v\d+\.\d+\.\d+)/)?.[1];
    assert.equal(dv, def, "deploy.yml inline KUBO_VERSION must equal the setup-kubo default");
    assert.ok(deploy.includes(`key: kubo-${def}-linux-amd64`), "deploy.yml cache key uses the same version");
    assert.ok(script.includes(`${def}/linux-amd64)`), "script pins a hash for that version");
    for (const f of ["e2e.yml", "tests.yml"]) {
      const t = fs.readFileSync(path.join(ROOT, ".github/workflows", f), "utf8");
      assert.equal(/kubo-v\d|install-kubo\.sh|KUBO_VERSION/.test(t), false, `${f} must take the version from the setup-kubo action only`);
      assert.match(t, /uses: \.\/\.github\/actions\/setup-kubo/);
    }
  });

  test("no workflow downloads Kubo straight from dist.ipfs.tech outside the shared core", () => {
    for (const f of ["e2e.yml", "tests.yml"]) {
      const t = fs.readFileSync(path.join(ROOT, ".github/workflows", f), "utf8");
      assert.equal(t.includes("dist.ipfs.tech"), false, `${f} must use install-kubo.sh`);
    }
  });
});
