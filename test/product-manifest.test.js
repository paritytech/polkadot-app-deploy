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
} from "../dist/index.js";
import { NonRetryableError } from "../dist/errors.js";

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
});
