// Unit tests for the E2E funding verdict (port of bulletin #1636 / #1628): thresholds, roles, table rendering.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  registerFloor,
  evaluateSigner,
  evaluateEnv,
  overallVerdict,
  renderTable,
  renderIssueBody,
} from "../tools/funding-verdict.mjs";
import { feeFloorFor, AUTO_MAP_RENT_HEADROOM, MINIMUM_REGISTER_STORAGE_DEPOSIT } from "../dist/dotns.js";

const pas = (n) => BigInt(Math.round(n * 1e10));
const row = (label, role, freePas, extra = {}) => ({
  label, role, address: `5${label.replace(/\W/g, "")}`.padEnd(48, "x"), free: freePas === null ? null : pas(freePas), ...extra,
});
const opts = { ...DEFAULTS };

describe("registerFloor", () => {
  test("derives from the deploy's own feeFloorFor, not a hardcoded number", () => {
    assert.equal(registerFloor(undefined), feeFloorFor("register", MINIMUM_REGISTER_STORAGE_DEPOSIT, AUTO_MAP_RENT_HEADROOM));
    assert.equal(registerFloor(50_000_000_000n), feeFloorFor("register", 50_000_000_000n, AUTO_MAP_RENT_HEADROOM));
  });
  test("follows a per-env registerStorageDeposit override", () => {
    assert.equal(registerFloor(2_000_000_000_000n) - registerFloor(50_000_000_000n), 2_000_000_000_000n - 50_000_000_000n);
  });
});

describe("evaluateSigner", () => {
  const floor = pas(25); // arbitrary round floor, margin 20% -> 30 PAS
  test("dotns signer: PASS at/above floor+margin, FAIL just below", () => {
    assert.equal(evaluateSigner(row("Bob", "dotns", 30), floor, opts).verdict, "PASS");
    assert.equal(evaluateSigner(row("Bob", "dotns", 29.9999), floor, opts).verdict, "FAIL");
  });
  test("reports the floor including margin", () => {
    assert.equal(evaluateSigner(row("Bob", "dotns", 100), floor, opts).floor, pas(30));
  });
  test("root: FAIL below floor, WARN below the burn-headroom threshold, PASS above", () => {
    assert.equal(evaluateSigner(row("Alice ROOT", "root", 10), floor, opts).verdict, "FAIL");
    assert.equal(evaluateSigner(row("Alice ROOT", "root", opts.rootWarnPas - 1), floor, opts).verdict, "WARN");
    assert.equal(evaluateSigner(row("Alice ROOT", "root", opts.rootWarnPas), floor, opts).verdict, "PASS");
  });
  test("pool signer is advisory: WARN when low, never FAIL", () => {
    assert.equal(evaluateSigner(row("//deploy/3", "pool", 0), floor, opts).verdict, "WARN");
    assert.equal(evaluateSigner(row("//deploy/3", "pool", 500), floor, opts).verdict, "PASS");
  });
  test("refill source //Alice uses its own threshold", () => {
    assert.equal(evaluateSigner(row("//Alice", "refill", opts.refillMinPas - 1), floor, opts).verdict, "FAIL");
    assert.equal(evaluateSigner(row("//Alice", "refill", opts.refillMinPas), floor, opts).verdict, "PASS");
  });
  test("unreadable balance is ERROR, not a funding FAIL", () => {
    const r = evaluateSigner(row("Bob", "dotns", null, { error: "timeout" }), floor, opts);
    assert.equal(r.verdict, "ERROR");
  });
});

describe("evaluateEnv / overallVerdict", () => {
  const rows = (bob) => [row("Alice ROOT", "root", 5000), row("Bob", "dotns", bob), row("//deploy/0", "pool", 0), row("//Alice", "refill", 5000)];
  test("environment floor comes from its registerStorageDeposit", () => {
    const r = evaluateEnv({ envId: "x", registerStorageDeposit: 50_000_000_000n, rows: rows(1000) }, opts);
    assert.equal(r.floor, registerFloor(50_000_000_000n));
    assert.ok(r.results.every((x) => x.envId === "x"));
  });
  test("worst verdict wins: FAIL > ERROR > WARN > PASS", () => {
    const pass = evaluateEnv({ envId: "a", rows: [row("Bob", "dotns", 1000)] }, opts);
    const warn = evaluateEnv({ envId: "b", rows: [row("//deploy/0", "pool", 0)] }, opts);
    const err = evaluateEnv({ envId: "c", rows: [row("Bob", "dotns", null, { error: "x" })] }, opts);
    const fail = evaluateEnv({ envId: "d", rows: rows(1) }, opts);
    assert.equal(overallVerdict([pass]), "PASS");
    assert.equal(overallVerdict([pass, warn]), "WARN");
    assert.equal(overallVerdict([pass, warn, err]), "ERROR");
    assert.equal(overallVerdict([pass, warn, err, fail]), "FAIL");
  });
});

describe("rendering", () => {
  const envResult = evaluateEnv({ envId: "paseo-next-v2", rows: [row("Bob", "dotns", 8.39), row("//Alice", "refill", 224.86), row("Alice ROOT", "root", 5000)] }, opts);
  test("table has the issue's columns and one row per signer", () => {
    const t = renderTable([envResult]);
    const lines = t.trim().split("\n");
    assert.match(lines[0], /\| env \| account \| address \| free PAS \| floor \| verdict \|/);
    assert.equal(lines.length, 2 + 3);
    assert.match(t, /\| paseo-next-v2 \| Bob \| `5Bob/);
    assert.match(t, /8\.3900/);
    assert.match(t, /FAIL/);
  });
  test("onlyProblems hides PASS rows", () => {
    const t = renderTable([envResult], { onlyProblems: true });
    assert.ok(!t.includes("Alice ROOT"));
    assert.ok(t.includes("| Bob |"));
  });
  test("issue body carries the table, the run url and the no-transfer note", () => {
    const body = renderIssueBody([envResult], { runUrl: "https://example/run/1" });
    assert.match(body, /https:\/\/example\/run\/1/);
    assert.match(body, /\| env \| account/);
    assert.match(body, /No transfers are made automatically/);
  });
});
