// Unit tests for the env readiness verdicts (#1624). Pure functions, readers injected.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  NON_GATING_LABELS,
  verdictProfile,
  verdictFunding,
  verdictS3,
  summarize,
  checkReadiness,
  formatSummaryLine,
} from "../tools/check-env-readiness.mjs";
import { evaluateEnv, DEFAULTS } from "../tools/funding-verdict.mjs";
import { BOB_H160, S3_OWNED_LABEL } from "../tools/lib/e2e-fixtures.mjs";

const pas = (n) => BigInt(Math.round(n * 1e10));
const row = (label, role, freePas, extra = {}) => ({
  label, role, address: `5${label.replace(/\W/g, "")}`.padEnd(48, "x"), free: freePas === null ? null : pas(freePas), ...extra,
});
const rowsAllFunded = () => [
  row("Alice ROOT", "root", 5000),
  row("Bob", "dotns", 5000),
  row("//e2e-direct", "dotns", 500),
  row("//e2e-fresh-pool", "dotns", 500),
  row("//e2e-fresh-direct", "dotns", 500),
  row("//deploy/0", "pool", 0),
];
const funding = (rows) => evaluateEnv({ envId: "e", registerStorageDeposit: undefined, rows }, DEFAULTS);
const KNOWN = ["poprules-startingPrice", "v0.5.8-rc1", "v0.6.0"];

describe("verdictProfile", () => {
  test("a known profile is ok and names the profile", () => {
    const v = verdictProfile({ profile: "v0.6.0" }, KNOWN);
    assert.equal(v.status, "ok");
    assert.match(v.detail, /v0\.6\.0/);
  });
  test("a profile this build does not know is not-ready", () => {
    const v = verdictProfile({ profile: "v9.9.9" }, KNOWN);
    assert.equal(v.status, "not-ready");
    assert.match(v.reason, /v9\.9\.9/);
  });
  test("the unclassifiable-ABI connect error is not-ready (a redeploy drifted the ABI)", () => {
    const v = verdictProfile({ error: new Error("paseo-next-v2 (POP_RULES 0x1): Could not determine the DotNS ABI profile: contract code is present") }, KNOWN);
    assert.equal(v.status, "not-ready");
  });
  test("no contract code is not-ready (a chain reset)", () => {
    const v = verdictProfile({ error: new Error("No contract deployed at 0xabc (POP_RULES) env=x") }, KNOWN);
    assert.equal(v.status, "not-ready");
  });
  test("an unrelated connect error is unknown, never not-ready", () => {
    for (const msg of ["WebSocket connection failed", "connect timed out after 120s", "All promises were rejected"]) {
      assert.equal(verdictProfile({ error: new Error(msg) }, KNOWN).status, "unknown", msg);
    }
  });
});

describe("verdictFunding", () => {
  test("all gating signers funded -> ok", () => {
    assert.equal(verdictFunding(funding(rowsAllFunded())).status, "ok");
  });
  test("a //e2e-* DotNS signer below the floor -> not-ready, naming it and the value read", () => {
    const rows = rowsAllFunded();
    rows[2] = row("//e2e-direct", "dotns", 1);
    const v = verdictFunding(funding(rows));
    assert.equal(v.status, "not-ready");
    assert.match(v.reason, /\/\/e2e-direct/);
    assert.match(v.reason, /1\.0000|1 PAS/);
  });
  test("Alice ROOT below the floor -> not-ready", () => {
    const rows = rowsAllFunded();
    rows[0] = row("Alice ROOT", "root", 2);
    assert.equal(verdictFunding(funding(rows)).status, "not-ready");
  });
  test("Bob below the floor does NOT gate (daily funding alarm keeps it)", () => {
    assert.ok(NON_GATING_LABELS.has("Bob"));
    const rows = rowsAllFunded();
    rows[1] = row("Bob", "dotns", 8.39);
    assert.equal(verdictFunding(funding(rows)).status, "ok");
  });
  test("a pool signer at 0 (WARN class) does not gate", () => {
    assert.equal(verdictFunding(funding(rowsAllFunded())).status, "ok");
  });
  test("Alice ROOT below the burn-headroom WARN threshold but above the floor -> ok", () => {
    const rows = rowsAllFunded();
    rows[0] = row("Alice ROOT", "root", 500);
    assert.equal(verdictFunding(funding(rows)).status, "ok");
  });
  test("an unreadable gating signer -> unknown, not not-ready", () => {
    const rows = rowsAllFunded();
    rows[3] = row("//e2e-fresh-pool", "dotns", null, { error: "timeout" });
    assert.equal(verdictFunding(funding(rows)).status, "unknown");
  });
  test("a real FAIL outranks an unreadable signer", () => {
    const rows = rowsAllFunded();
    rows[2] = row("//e2e-direct", "dotns", 1);
    rows[3] = row("//e2e-fresh-pool", "dotns", null, { error: "timeout" });
    assert.equal(verdictFunding(funding(rows)).status, "not-ready");
  });
  test("an unreadable Bob does not make funding unknown", () => {
    const rows = rowsAllFunded();
    rows[1] = row("Bob", "dotns", null, { error: "timeout" });
    assert.equal(verdictFunding(funding(rows)).status, "ok");
  });
});

describe("verdictS3", () => {
  const base = { label: S3_OWNED_LABEL, tld: "paseo", expectedOwner: BOB_H160 };
  test("owned by Bob (case-insensitive) -> ok", () => {
    assert.equal(verdictS3({ ...base, owner: BOB_H160.toUpperCase().replace("0X", "0x") }).status, "ok");
  });
  test("owned by someone else -> not-ready, naming both", () => {
    const v = verdictS3({ ...base, owner: "0x2222222222222222222222222222222222222222" });
    assert.equal(v.status, "not-ready");
    assert.match(v.reason, /0x2222/);
    assert.match(v.reason, new RegExp(BOB_H160.slice(0, 8)));
  });
  test("unregistered (null / zero owner / ownerOf revert) -> not-ready", () => {
    assert.equal(verdictS3({ ...base, owner: null }).status, "not-ready");
    assert.equal(verdictS3({ ...base, owner: "0x0000000000000000000000000000000000000000" }).status, "not-ready");
    assert.equal(verdictS3({ ...base, error: new Error("Contract execution would revert during ownerOf on DOTNS_REGISTRAR") }).status, "not-ready");
  });
  test("a transport error -> unknown", () => {
    assert.equal(verdictS3({ ...base, error: new Error("ownerOf timed out after 30s") }).status, "unknown");
  });
});

describe("summarize", () => {
  const ok = { status: "ok", detail: "d" };
  test("ready when nothing is not-ready; unknown is reported, not gating", () => {
    const s = summarize("e", { profile: ok, funding: { status: "unknown", reason: "rpc" }, s3: ok });
    assert.equal(s.ready, true);
    assert.deepEqual(s.unknown, ["funding"]);
    assert.deepEqual(s.reasons, []);
  });
  test("not ready lists each failed check with its reason", () => {
    const s = summarize("e", { profile: { status: "not-ready", reason: "abi" }, funding: ok, s3: { status: "not-ready", reason: "gone" } });
    assert.equal(s.ready, false);
    assert.deepEqual(s.reasons, [{ check: "profile", reason: "abi" }, { check: "s3", reason: "gone" }]);
  });
});

describe("checkReadiness (readers injected)", () => {
  const goodReaders = () => ({
    profile: async () => ({ profile: "v0.6.0" }),
    funding: async () => funding(rowsAllFunded()),
    s3owner: async () => BOB_H160,
  });
  const opts = { envId: "paseo-next-v2", tld: "paseo", knownProfiles: KNOWN, timeoutMs: 200 };
  test("all ok -> ready", async () => {
    const s = await checkReadiness({ ...opts, readers: goodReaders() });
    assert.equal(s.ready, true);
    assert.equal(s.checks.profile.status, "ok");
  });
  test("a throwing reader becomes unknown for that check only", async () => {
    const r = goodReaders();
    r.funding = async () => { throw new Error("boom"); };
    const s = await checkReadiness({ ...opts, readers: r });
    assert.equal(s.ready, true);
    assert.equal(s.checks.funding.status, "unknown");
  });
  test("a hanging reader is bounded by the timeout and becomes unknown", async () => {
    const r = goodReaders();
    r.s3owner = () => new Promise(() => {});
    const s = await checkReadiness({ ...opts, readers: r });
    assert.equal(s.checks.s3.status, "unknown");
    assert.equal(s.ready, true);
  });
  test("profile error classification flows through the reader", async () => {
    const r = goodReaders();
    r.profile = async () => ({ error: new Error("Could not determine the DotNS ABI profile: x") });
    const s = await checkReadiness({ ...opts, readers: r });
    assert.equal(s.ready, false);
    assert.equal(s.reasons[0].check, "profile");
  });
});

describe("summary line", () => {
  test("is one ENV_READINESS line of JSON", () => {
    const s = summarize("e", { profile: { status: "ok", detail: "v0.6.0" }, funding: { status: "ok" }, s3: { status: "ok" } });
    const line = formatSummaryLine(s);
    assert.match(line, /^ENV_READINESS \{/);
    assert.ok(!line.includes("\n"));
    assert.deepEqual(JSON.parse(line.slice("ENV_READINESS ".length)), s);
  });
});
