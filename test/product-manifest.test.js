import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  defineConfig,
  validateRootManifest,
  validateExecutableManifest,
  validateProductConfig,
  pessimisticSizePreflight,
  assertWithinBudget,
  getTextRecordBudgetBytes,
  DEFAULT_TEXT_RECORD_BUDGET_BYTES,
  loadProductConfig,
  preflightProductConfig,
  checkProductConfigFilesExist,
  publishManifest,
  formatConfigLoadError,
} from "../dist/index.js";
import { registerOrEnsureResolver } from "../dist/manifest/publish.js";
import { NonRetryableError } from "../dist/errors.js";
import { BULLETIN_ENDPOINTS, DEFAULT_BULLETIN_RPC, setBulletinEndpoints } from "../dist/deploy.js";
import { KNOWN_TLDS as DOTNS_KNOWN_TLDS } from "../dist/dotns.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("validateRootManifest", () => {
  test("accepts a well-formed v1 root manifest", () => {
    const result = validateRootManifest({
      $v: 1,
      displayName: "DemoApp",
      description: "Short description.",
      icon: { cid: "bafy123", format: "png" },
    });
    assert.equal(result.ok, true);
  });

  test("rejects when $v is not 1", () => {
    const result = validateRootManifest({
      $v: 2,
      displayName: "DemoApp",
      description: "",
      icon: { cid: "bafy", format: "png" },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("$v must be 1")));
  });

  test("rejects unknown icon format", () => {
    const result = validateRootManifest({
      $v: 1,
      displayName: "DemoApp",
      description: "",
      icon: { cid: "bafy", format: "webp" },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("icon.format")));
  });

  test("rejects when icon is missing entirely", () => {
    const result = validateRootManifest({
      $v: 1,
      displayName: "DemoApp",
      description: "",
    });
    assert.equal(result.ok, false);
  });

  test("rejects non-object inputs", () => {
    assert.equal(validateRootManifest(null).ok, false);
    assert.equal(validateRootManifest("string").ok, false);
    assert.equal(validateRootManifest([]).ok, false);
  });
});

describe("validateExecutableManifest — app", () => {
  test("accepts a minimal app manifest", () => {
    const result = validateExecutableManifest({ $v: 1, kind: "app", appVersion: [1, 0, 0] });
    assert.equal(result.ok, true);
  });

  test("accepts a 4-tuple appVersion with build tag", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "app", appVersion: [1, 0, 0, "deadbeef"],
    });
    assert.equal(result.ok, true);
  });

  test("rejects 2-element appVersion", () => {
    const result = validateExecutableManifest({ $v: 1, kind: "app", appVersion: [1, 0] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("appVersion")));
  });

  test("rejects 5-element appVersion", () => {
    const result = validateExecutableManifest({ $v: 1, kind: "app", appVersion: [1, 0, 0, "tag", "extra"] });
    assert.equal(result.ok, false);
  });
});

describe("validateExecutableManifest — widget", () => {
  test("accepts widget with height array", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "widget", appVersion: [1, 0, 0],
      dimensions: { height: [2, 4], width: 1 },
    });
    assert.equal(result.ok, true);
  });

  test("rejects widget missing dimensions", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "widget", appVersion: [1, 0, 0],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("dimensions")));
  });

  test("rejects widget with empty height array", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "widget", appVersion: [1, 0, 0],
      dimensions: { height: [], width: 1 },
    });
    assert.equal(result.ok, false);
  });

  test("rejects widget with non-integer height", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "widget", appVersion: [1, 0, 0],
      dimensions: { height: [2.5] },
    });
    assert.equal(result.ok, false);
  });

  test("accepts widget with height 0 (horizontal preset)", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "widget", appVersion: [1, 0, 0],
      dimensions: { height: [1, 2, 4, 0], width: 2 },
    });
    assert.equal(result.ok, true);
  });

  test("rejects widget with negative height", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "widget", appVersion: [1, 0, 0],
      dimensions: { height: [-1] },
    });
    assert.equal(result.ok, false);
  });
});

describe("validateExecutableManifest — worker", () => {
  test("accepts worker with chat=true, pocket=false", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "worker", appVersion: [1, 0, 0],
      entrypoint: "index.js", includes: { chat: true, pocket: false },
    });
    assert.equal(result.ok, true);
  });

  test("rejects worker missing entrypoint", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "worker", appVersion: [1, 0, 0],
      includes: { chat: true, pocket: true },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("entrypoint")));
  });

  test("rejects worker with both includes false", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "worker", appVersion: [1, 0, 0],
      entrypoint: "index.js", includes: { chat: false, pocket: false },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("at least one of chat / pocket")));
  });

  test("rejects worker entrypoint with leading slash", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "worker", appVersion: [1, 0, 0],
      entrypoint: "/abs/path.js", includes: { chat: true, pocket: false },
    });
    assert.equal(result.ok, false);
  });

  test("rejects worker entrypoint with '..' traversal", () => {
    const result = validateExecutableManifest({
      $v: 1, kind: "worker", appVersion: [1, 0, 0],
      entrypoint: "../escape.js", includes: { chat: true, pocket: false },
    });
    assert.equal(result.ok, false);
  });
});

test("validateExecutableManifest rejects unknown kind", () => {
  const result = validateExecutableManifest({ $v: 1, kind: "renderer", appVersion: [1, 0, 0] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes("kind")));
});

const VALID_CONFIG = {
  domain: "demoapp.dot",
  displayName: "DemoApp",
  description: "Short description.",
  icon: { path: "./icon.png", format: "png" },
  executables: [
    { kind: "app", path: "./dist/app", appVersion: [1, 0, 0] },
    {
      kind: "widget", path: "./dist/widget", appVersion: [1, 0, 0],
      dimensions: { height: [2, 4], width: 1 },
    },
    {
      kind: "worker", path: "./dist/worker", appVersion: [1, 0, 0],
      entrypoint: "index.js", includes: { chat: true, pocket: false },
    },
  ],
};

describe("validateProductConfig", () => {
  test("accepts a full three-variant config", () => {
    const result = validateProductConfig(VALID_CONFIG);
    assert.equal(result.ok, true);
  });

  test("rejects a domain without .dot suffix", () => {
    const result = validateProductConfig({ ...VALID_CONFIG, domain: "demoapp" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("domain")));
  });

  // #paseo-tld: DotNS's TLD is per-environment (paseo-next-v2: "paseo") —
  // a config domain ending in .paseo must validate, not be rejected as if
  // ".dot" were the only legal suffix.
  test("accepts a domain with .paseo suffix (paseo-next-v2)", () => {
    const result = validateProductConfig({ ...VALID_CONFIG, domain: "demoapp.paseo" });
    assert.equal(result.ok, true,
      `>> FAIL: validateProductConfig .paseo: expected ok:true, got errors: ${JSON.stringify(result.ok ? [] : result.errors)}`);
  });

  test("still rejects a domain ending in an unknown TLD", () => {
    const result = validateProductConfig({ ...VALID_CONFIG, domain: "demoapp.example" });
    assert.equal(result.ok, false,
      ">> FAIL: validateProductConfig unknown TLD: 'demoapp.example' must still be rejected — only KNOWN_TLDS suffixes are valid");
  });

  // Keeps src/manifest/schema.ts's hand-copied KNOWN_TLDS list (documented as
  // "kept in sync with dotns.ts's KNOWN_TLDS by hand") from silently drifting
  // — schema.ts deliberately doesn't import dotns.ts (stays free of the
  // polkadot-api dep), so nothing else would catch a divergence.
  test("schema.ts's KNOWN_TLDS list stays in sync with dotns.ts's KNOWN_TLDS", () => {
    const schemaSrc = readFileSync(fileURLToPath(new URL("../src/manifest/schema.ts", import.meta.url)), "utf8");
    const m = schemaSrc.match(/const KNOWN_TLDS = \[([^\]]+)\] as const;/);
    assert.ok(m, ">> FAIL: could not find schema.ts's KNOWN_TLDS declaration to compare");
    const schemaTlds = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    assert.deepEqual(
      schemaTlds.sort(),
      [...DOTNS_KNOWN_TLDS].sort(),
      `>> FAIL: KNOWN_TLDS drift: src/manifest/schema.ts has ${JSON.stringify(schemaTlds)} but src/dotns.ts has ${JSON.stringify(DOTNS_KNOWN_TLDS)} — a config domain valid on-chain could now fail schema validation, or vice versa`,
    );
  });

  test("rejects empty executables array", () => {
    const result = validateProductConfig({ ...VALID_CONFIG, executables: [] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("executables")));
  });

  test("rejects duplicate kinds", () => {
    const result = validateProductConfig({
      ...VALID_CONFIG,
      executables: [
        { kind: "app", path: "./a", appVersion: [1, 0, 0] },
        { kind: "app", path: "./b", appVersion: [1, 0, 0] },
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("duplicate kind")));
  });

  test("aggregates errors across multiple executables", () => {
    const result = validateProductConfig({
      ...VALID_CONFIG,
      executables: [
        { kind: "widget", path: "./w", appVersion: [1, 0, 0] }, // missing dimensions
        { kind: "worker", path: "./wk", appVersion: [1, 0, 0] }, // missing entrypoint + includes
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 2);
  });
});

test("defineConfig returns its input unchanged", () => {
  assert.equal(defineConfig(VALID_CONFIG), VALID_CONFIG);
});

const EXEC_PATHS = ["dist/app", "dist/widget", "dist/worker"];
async function mkTmp(prefix) { return await fs.mkdtemp(path.join(os.tmpdir(), prefix)); }
async function seedFiles(dir, { icon = true, execs = EXEC_PATHS } = {}) {
  if (icon) await fs.writeFile(path.join(dir, "icon.png"), "x");
  for (const p of execs) await fs.mkdir(path.join(dir, p), { recursive: true });
}

describe("checkProductConfigFilesExist", () => {
  test("returns [] when the icon + every executable path exist", async () => {
    const dir = await mkTmp("pcfg-ok-");
    await seedFiles(dir);
    assert.deepEqual(await checkProductConfigFilesExist(VALID_CONFIG, dir), []);
  });

  test("flags a missing icon file", async () => {
    const dir = await mkTmp("pcfg-noicon-");
    await seedFiles(dir, { icon: false });
    const errs = await checkProductConfigFilesExist(VALID_CONFIG, dir);
    assert.equal(errs.length, 1, errs.join("; "));
    assert.ok(errs[0].includes("icon.path"), errs[0]);
  });

  test("flags each missing executable path", async () => {
    const dir = await mkTmp("pcfg-noexec-");
    await seedFiles(dir, { execs: ["dist/app"] }); // widget + worker missing
    const errs = await checkProductConfigFilesExist(VALID_CONFIG, dir);
    assert.equal(errs.length, 2, errs.join("; "));
    assert.ok(errs.some(e => e.includes("widget")));
    assert.ok(errs.some(e => e.includes("worker")));
  });

  test("rejects an icon path that is a directory (must be a file)", async () => {
    const dir = await mkTmp("pcfg-icondir-");
    await fs.mkdir(path.join(dir, "icon.png"), { recursive: true });
    for (const p of EXEC_PATHS) await fs.mkdir(path.join(dir, p), { recursive: true });
    const errs = await checkProductConfigFilesExist(VALID_CONFIG, dir);
    assert.ok(errs.some(e => e.includes("not a file")), errs.join("; "));
  });
});

describe("preflightProductConfig", () => {
  // Use an explicit `path:` (not walk-up discovery) so the test is agnostic to
  // the repo's config filename (bulletin-deploy.config.* vs polkadot-app-deploy.config.*).
  async function writeConfig(dir, cfg) {
    const p = path.join(dir, "product.config.mjs");
    await fs.writeFile(p, `export default ${JSON.stringify(cfg)};`);
    return p;
  }

  test("returns null when no product config is present (contenthash-only deploy)", async () => {
    const dir = await mkTmp("pfl-none-");
    assert.equal(await preflightProductConfig({ cwd: dir }), null);
  });

  test("returns the loaded config when schema + files are all valid", async () => {
    const dir = await mkTmp("pfl-ok-");
    const cfgPath = await writeConfig(dir, VALID_CONFIG);
    await seedFiles(dir);
    const res = await preflightProductConfig({ path: cfgPath });
    assert.ok(res, "expected a loaded config");
    assert.equal(res.config.domain, "demoapp.dot");
  });

  test("throws up front (before deploy) when a referenced file is missing", async () => {
    const dir = await mkTmp("pfl-missing-");
    const cfgPath = await writeConfig(dir, VALID_CONFIG); // no icon / executables seeded
    await assert.rejects(
      () => preflightProductConfig({ path: cfgPath }),
      (e) => {
        assert.ok(e instanceof NonRetryableError, ">> FAIL: preflight-missing-file: expected NonRetryableError");
        assert.match(e.message, /preflight failed/);
        assert.match(e.message, /icon\.path/);
        return true;
      },
    );
  });

  test("throws on invalid schema (domain without .dot) up front", async () => {
    const dir = await mkTmp("pfl-badschema-");
    const cfgPath = await writeConfig(dir, { ...VALID_CONFIG, domain: "demoapp" });
    await seedFiles(dir);
    await assert.rejects(
      () => preflightProductConfig({ path: cfgPath }),
      (e) => {
        assert.ok(e instanceof NonRetryableError, ">> FAIL: preflight-bad-schema: expected NonRetryableError");
        assert.match(e.message, /domain/);
        return true;
      },
    );
  });
});

describe("assertWithinBudget", () => {
  test("ok when value fits", () => {
    const result = assertWithinBudget("k", "short", 100);
    assert.equal(result.ok, true);
    assert.equal(result.bytes, 5);
  });

  test("not ok when value exceeds budget", () => {
    const result = assertWithinBudget("k", "x".repeat(200), 100);
    assert.equal(result.ok, false);
  });
});

describe("getTextRecordBudgetBytes", () => {
  const PREV = process.env.BULLETIN_TEXT_BUDGET;
  test.afterEach(() => {
    if (PREV === undefined) delete process.env.BULLETIN_TEXT_BUDGET;
    else process.env.BULLETIN_TEXT_BUDGET = PREV;
  });

  test("defaults when env unset", () => {
    delete process.env.BULLETIN_TEXT_BUDGET;
    assert.equal(getTextRecordBudgetBytes(), DEFAULT_TEXT_RECORD_BUDGET_BYTES);
  });

  test("respects an explicit override", () => {
    process.env.BULLETIN_TEXT_BUDGET = "2048";
    assert.equal(getTextRecordBudgetBytes(), 2048);
  });

  test("falls back to default on garbage input", () => {
    process.env.BULLETIN_TEXT_BUDGET = "not-a-number";
    assert.equal(getTextRecordBudgetBytes(), DEFAULT_TEXT_RECORD_BUDGET_BYTES);
    process.env.BULLETIN_TEXT_BUDGET = "-5";
    assert.equal(getTextRecordBudgetBytes(), DEFAULT_TEXT_RECORD_BUDGET_BYTES);
  });
});

describe("pessimisticSizePreflight", () => {
  test("passes for a typical config under default budget", () => {
    const report = pessimisticSizePreflight(VALID_CONFIG);
    assert.equal(report.ok, true);
    // root + 3 executables
    assert.equal(report.checks.length, 4);
  });

  test("flags root manifest exceeding a tiny budget", () => {
    const config = {
      ...VALID_CONFIG,
      displayName: "X".repeat(2000),
    };
    const report = pessimisticSizePreflight(config, 256);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some(c => c.key.endsWith("#manifest") && !c.ok));
  });
});

async function tmpDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("loadProductConfig — auto-discovery", () => {
  test("loads a .ts config via jiti", async (t) => {
    const dir = await tmpDir(t, "product-config-ts-");
    const configPath = path.join(dir, "polkadot-app-deploy.config.ts");
    await fs.writeFile(
      configPath,
      `export default ${JSON.stringify(VALID_CONFIG, null, 2)};\n`,
    );
    const { config, sourcePath } = await loadProductConfig({ cwd: dir });
    assert.equal(sourcePath, configPath);
    assert.equal(config.domain, "demoapp.dot");
    assert.equal(config.executables.length, 3);
  });

  test("loads a .mjs config natively", async (t) => {
    const dir = await tmpDir(t, "product-config-mjs-");
    const configPath = path.join(dir, "polkadot-app-deploy.config.mjs");
    await fs.writeFile(
      configPath,
      `export default ${JSON.stringify(VALID_CONFIG, null, 2)};\n`,
    );
    const { config } = await loadProductConfig({ cwd: dir });
    assert.equal(config.domain, "demoapp.dot");
  });

  test("throws NonRetryableError when no config is present", async (t) => {
    const dir = await tmpDir(t, "product-config-missing-");
    await assert.rejects(
      () => loadProductConfig({ cwd: dir }),
      err => err.name === "NonRetryableError",
    );
  });

  test("surfaces schema errors from an invalid config", async (t) => {
    const dir = await tmpDir(t, "product-config-invalid-");
    const configPath = path.join(dir, "polkadot-app-deploy.config.ts");
    await fs.writeFile(
      configPath,
      `export default ${JSON.stringify({ ...VALID_CONFIG, domain: "no-suffix" }, null, 2)};\n`,
    );
    await assert.rejects(
      () => loadProductConfig({ cwd: dir }),
      err => err.message.includes("domain"),
    );
  });

  test("#1103: a config that throws '<VAR> is required' surfaces a friendly NonRetryableError with an env-var hint, preserving the original message", async (t) => {
    const dir = await tmpDir(t, "product-config-throws-required-");
    const configPath = path.join(dir, "polkadot-app-deploy.config.ts");
    await fs.writeFile(
      configPath,
      `if (!process.env.APP_DOTNS_DOMAIN) throw new Error("APP_DOTNS_DOMAIN is required");\nexport default ${JSON.stringify(VALID_CONFIG, null, 2)};\n`,
    );
    await assert.rejects(
      () => loadProductConfig({ cwd: dir }),
      err => {
        assert.equal(err.name, "NonRetryableError", `>> FAIL: config-throws-required: expected NonRetryableError, got ${err.name}`);
        assert.match(err.message, /threw while loading: APP_DOTNS_DOMAIN is required/, `>> FAIL: config-throws-required: friendly wrapper missing or original message not preserved (got "${err.message}")`);
        assert.match(err.message, /Hint: set the APP_DOTNS_DOMAIN environment variable\./, `>> FAIL: config-throws-required: expected env-var hint (got "${err.message}")`);
        return true;
      },
    );
  });

  test("#1103: a config that throws a non-'required' shape surfaces the friendly wrapper with no false hint", async (t) => {
    const dir = await tmpDir(t, "product-config-throws-other-");
    const configPath = path.join(dir, "polkadot-app-deploy.config.ts");
    await fs.writeFile(
      configPath,
      `throw new Error("Cannot read properties of undefined (reading 'foo')");\nexport default ${JSON.stringify(VALID_CONFIG, null, 2)};\n`,
    );
    await assert.rejects(
      () => loadProductConfig({ cwd: dir }),
      err => {
        assert.equal(err.name, "NonRetryableError", `>> FAIL: config-throws-other: expected NonRetryableError, got ${err.name}`);
        assert.match(err.message, /threw while loading: Cannot read properties of undefined \(reading 'foo'\)/, `>> FAIL: config-throws-other: friendly wrapper missing or original message not preserved (got "${err.message}")`);
        assert.ok(!/Hint:/.test(err.message), `>> FAIL: config-throws-other: unexpected env-var hint on a non-required-shape message (got "${err.message}")`);
        return true;
      },
    );
  });
});

describe("formatConfigLoadError — pure helper", () => {
  test("'<VAR> is required' shape produces the friendly wrapper + hint, preserving the original message", () => {
    const message = formatConfigLoadError(
      "/proj/polkadot-app-deploy.config.ts",
      new Error("APP_DOTNS_DOMAIN is required"),
    );
    assert.match(message, /^Your polkadot-app-deploy\.config\.ts threw while loading: APP_DOTNS_DOMAIN is required\. Check its required env vars \/ inputs\./, `>> FAIL: formatConfigLoadError required-shape: unexpected message shape (got "${message}")`);
    assert.match(message, /Hint: set the APP_DOTNS_DOMAIN environment variable\.$/, `>> FAIL: formatConfigLoadError required-shape: missing hint (got "${message}")`);
  });

  test("'missing env var X' shape also produces a hint", () => {
    const message = formatConfigLoadError(
      "/proj/polkadot-app-deploy.config.js",
      new Error("missing env var API_KEY"),
    );
    assert.match(message, /Hint: set the API_KEY environment variable\.$/, `>> FAIL: formatConfigLoadError missing-env-var shape: expected API_KEY hint (got "${message}")`);
  });

  test("a non-'required' shape produces the wrapper with no hint", () => {
    const message = formatConfigLoadError(
      "/proj/polkadot-app-deploy.config.mjs",
      new Error("Cannot read properties of undefined (reading 'foo')"),
    );
    assert.equal(
      message,
      "Your polkadot-app-deploy.config.mjs threw while loading: Cannot read properties of undefined (reading 'foo'). Check its required env vars / inputs.",
      `>> FAIL: formatConfigLoadError non-required-shape: unexpected message (got "${message}")`,
    );
  });

  test("a thrown non-Error value is stringified, not [object Object]", () => {
    const message = formatConfigLoadError("/proj/polkadot-app-deploy.config.ts", "plain string throw");
    assert.match(message, /threw while loading: plain string throw\./, `>> FAIL: formatConfigLoadError non-Error throw: expected stringified value (got "${message}")`);
  });
});

// ---------------------------------------------------------------------------
// Perf win: registerSubdomain already sets a fresh subname's resolver to the
// content resolver atomically (setSubnodeOwner + setResolver, batched via
// Utility.batch_all — see dotns.ts registerSubdomain). The manifest publish
// loop used to call ensureContentResolver unconditionally right after the
// register-or-not branch, wasting one chain read per executable on every
// fresh deploy. registerOrEnsureResolver is the extracted decision (only the
// already-owned branch still calls ensureContentResolver — a pre-existing
// subname can have a stale/unset resolver) — pulled out of publishManifest
// and given an injectable dotns-like interface specifically so this
// call-count regression can be pinned without a live chain connection
// (publishManifest itself always calls it with a real DotNS instance, which
// needs one).
// ---------------------------------------------------------------------------
describe("registerOrEnsureResolver (resolver-read skip)", () => {
  function mockDotns() {
    const calls = { registerSubdomain: 0, ensureContentResolver: 0 };
    return {
      calls,
      async registerSubdomain(sublabel, parentLabel) {
        calls.registerSubdomain++;
        return { sublabel, parentLabel, owner: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" };
      },
      async ensureContentResolver(domainName) {
        calls.ensureContentResolver++;
        return { changed: true };
      },
    };
  }

  test("fresh register (owned:false, no owner): calls registerSubdomain, does NOT call ensureContentResolver", async () => {
    const dotns = mockDotns();
    const result = await registerOrEnsureResolver(dotns, { owned: false, owner: null }, "app", "demoapp", "demoapp.dot");
    assert.equal(result.registered, true, ">> FAIL: registerOrEnsureResolver fresh-register: expected registered:true");
    assert.equal(dotns.calls.registerSubdomain, 1, ">> FAIL: registerOrEnsureResolver fresh-register: registerSubdomain must be called exactly once");
    assert.equal(dotns.calls.ensureContentResolver, 0, ">> FAIL: registerOrEnsureResolver fresh-register: ensureContentResolver must NOT be called — registerSubdomain already batches setResolver atomically (dotns.ts), calling it again is exactly the redundant chain read this port removes");
  });

  test("already owned (owned:true): calls ensureContentResolver, does NOT call registerSubdomain", async () => {
    const dotns = mockDotns();
    const result = await registerOrEnsureResolver(dotns, { owned: true, owner: "5FexistingOwner" }, "widget", "demoapp", "demoapp.dot");
    assert.equal(result.registered, false, ">> FAIL: registerOrEnsureResolver already-owned: expected registered:false");
    assert.equal(dotns.calls.ensureContentResolver, 1, ">> FAIL: registerOrEnsureResolver already-owned: ensureContentResolver must be called exactly once — a pre-existing subname can have a stale/unset resolver");
    assert.equal(dotns.calls.registerSubdomain, 0, ">> FAIL: registerOrEnsureResolver already-owned: registerSubdomain must NOT be called for an already-owned subname");
  });

  test("owned by someone else (owned:false, owner set): throws NonRetryableError, calls neither", async () => {
    const dotns = mockDotns();
    await assert.rejects(
      () => registerOrEnsureResolver(dotns, { owned: false, owner: "5FconflictingOwner" }, "worker", "demoapp", "demoapp.dot"),
      (e) => {
        assert.ok(e instanceof NonRetryableError, ">> FAIL: registerOrEnsureResolver owner-conflict: expected NonRetryableError");
        assert.match(e.message, /worker\.demoapp\.dot is owned by 5FconflictingOwner/, ">> FAIL: registerOrEnsureResolver owner-conflict: error message must name the conflicting owner and subname");
        return true;
      },
    );
    assert.equal(dotns.calls.registerSubdomain, 0, ">> FAIL: registerOrEnsureResolver owner-conflict: registerSubdomain must NOT be called");
    assert.equal(dotns.calls.ensureContentResolver, 0, ">> FAIL: registerOrEnsureResolver owner-conflict: ensureContentResolver must NOT be called");
  });
});

// ---------------------------------------------------------------------------
// #1094: manifest publish uploaded the icon/executables to the DEFAULT
// Bulletin RPC, ignoring the deploy's --env/--rpc — storeFile/storeDirectory
// are called with no client of their own, so they fall back to whatever
// getProvider() reads off the module-level BULLETIN_ENDPOINTS. Asserting
// BULLETIN_ENDPOINTS directly after publishManifest is not a hollow proxy:
// storeFile/storeDirectory connect to exactly BULLETIN_ENDPOINTS[0] (verified
// live against the real chain while fixing this issue — pre-fix connected to
// DEFAULT_BULLETIN_RPC despite env:"paseo-next-v2"; post-fix connected to
// paseo-next-v2's own wss://paseo-bulletin-next-rpc.polkadot.io).
//
// Each test seeds BULLETIN_ENDPOINTS at the module-default seed first — this
// is the state any *standalone* publishManifest() call starts from (a fresh
// process, or any library caller that didn't run deploy() first in-process;
// see the module's own JSDoc: "on top of an already-completed legacy
// deploy"). A broken icon path makes publishManifest throw immediately after
// resolving+setting the endpoint (readFileOrThrow), before any real
// network/chain call — keeps this a fast, deterministic unit test.
//
// "devnet" is used as the non-default env below (this twin's assets/
// environments.json only defines paseo-next-v2 and devnet — bulletin's
// equivalent test used a "paseo-review" env that has no counterpart here).
describe("publishManifest — Bulletin endpoint resolution (#1094)", () => {
  test("resolves the given env's Bulletin endpoint before storeFile/storeDirectory run, not the module default", async (t) => {
    const before = BULLETIN_ENDPOINTS;
    t.after(() => setBulletinEndpoints(before));
    setBulletinEndpoints([DEFAULT_BULLETIN_RPC]);

    const dir = await tmpDir(t, "product-manifest-rpc-");
    const loaded = {
      config: {
        ...VALID_CONFIG,
        domain: "manifestrpctest.dot",
        icon: { path: "./missing-icon.png", format: "png" },
        executables: [],
      },
      sourcePath: path.join(dir, "polkadot-app-deploy.config.mjs"),
    };

    await assert.rejects(
      () => publishManifest({ loaded, domain: "manifestrpctest.dot", env: "devnet" }),
      err => err.name === "NonRetryableError" && /Cannot read icon/.test(err.message),
      ">> FAIL: publishManifest #1094 setup: expected the icon read to fail (fixture icon is intentionally missing) — check the fixture path, not the fix",
    );

    // devnet's Bulletin endpoint(s) (assets/environments.json), distinct
    // from BOTH the module-default seed AND paseo-next-v2's own endpoint —
    // this assertion cannot pass by accident.
    assert.deepStrictEqual(
      BULLETIN_ENDPOINTS,
      ["wss://bulletin-paseo.tservices.es:8443", "wss://bullet.sik.rocks"],
      ">> FAIL: publishManifest #1094: BULLETIN_ENDPOINTS must be set to the resolved env's ('devnet') Bulletin endpoint before storeFile/storeDirectory run — it was left at DEFAULT_BULLETIN_RPC, which is exactly what storeFile/storeDirectory would connect to (getProvider() has no client of its own)",
    );
  });

  test("an --rpc override wins even against a non-default env, with the env endpoint kept as fail-over backup", async (t) => {
    const before = BULLETIN_ENDPOINTS;
    t.after(() => setBulletinEndpoints(before));
    setBulletinEndpoints([DEFAULT_BULLETIN_RPC]);

    const dir = await tmpDir(t, "product-manifest-rpc-override-");
    const loaded = {
      config: {
        ...VALID_CONFIG,
        domain: "manifestrpctest.dot",
        icon: { path: "./missing-icon.png", format: "png" },
        executables: [],
      },
      sourcePath: path.join(dir, "polkadot-app-deploy.config.mjs"),
    };

    await assert.rejects(
      () => publishManifest({ loaded, domain: "manifestrpctest.dot", env: "devnet", rpc: "wss://custom-override.example" }),
      err => err.name === "NonRetryableError" && /Cannot read icon/.test(err.message),
      ">> FAIL: publishManifest #1094 rpc-override setup: expected the icon read to fail (fixture icon is intentionally missing) — check the fixture path, not the fix",
    );

    assert.deepStrictEqual(
      BULLETIN_ENDPOINTS,
      ["wss://custom-override.example", "wss://bulletin-paseo.tservices.es:8443", "wss://bullet.sik.rocks"],
      ">> FAIL: publishManifest #1094 rpc-override: an explicit --rpc must win over the resolved env's own endpoint, with the env endpoint kept behind it as a fail-over backup",
    );
  });

  test("default env (no --env/--rpc passed) resolves to the SAME endpoint deploy() itself would use — non-regression", async (t) => {
    const before = BULLETIN_ENDPOINTS;
    t.after(() => setBulletinEndpoints(before));
    setBulletinEndpoints([DEFAULT_BULLETIN_RPC]);

    const dir = await tmpDir(t, "product-manifest-rpc-default-");
    const loaded = {
      config: {
        ...VALID_CONFIG,
        domain: "manifestrpctest.dot",
        icon: { path: "./missing-icon.png", format: "png" },
        executables: [],
      },
      sourcePath: path.join(dir, "polkadot-app-deploy.config.mjs"),
    };

    await assert.rejects(
      () => publishManifest({ loaded, domain: "manifestrpctest.dot" }),
      err => err.name === "NonRetryableError" && /Cannot read icon/.test(err.message),
      ">> FAIL: publishManifest #1094 default-env setup: expected the icon read to fail (fixture icon is intentionally missing) — check the fixture path, not the fix",
    );

    // paseo-next-v2 is both DEFAULT_ENV_ID (environments.ts) and the CLI's
    // implicit default when --env is omitted — must resolve to its OWN
    // endpoint (wss://paseo-bulletin-next-rpc.polkadot.io), NOT the
    // DEFAULT_BULLETIN_RPC seed constant (a different URL — see #1094).
    assert.deepStrictEqual(
      BULLETIN_ENDPOINTS,
      ["wss://paseo-bulletin-next-rpc.polkadot.io"],
      ">> FAIL: publishManifest #1094 default-env: omitting --env must still resolve to paseo-next-v2's OWN Bulletin endpoint, not the unrelated DEFAULT_BULLETIN_RPC seed constant",
    );
  });
});
