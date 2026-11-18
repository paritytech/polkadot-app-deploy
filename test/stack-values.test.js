// scripts/stack-values.mjs writes the body of the daily stack update pull request: the reviewer
// sees only the values it lists, so a changed endpoint it misses is merged unread.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runStackValues = (...args) => spawnSync(process.execPath, ["scripts/stack-values.mjs", ...args], { encoding: "utf8" });

describe("scripts/stack-values.mjs", () => {
  test("--compare lists a value that differs from the earlier snapshot", () => {
    const snapshot = runStackValues();
    assert.equal(snapshot.status, 0, `>> FAIL: stack-values.mjs: the snapshot fails: ${snapshot.stderr.trim()}`);
    const before = JSON.parse(snapshot.stdout);
    const current = before["paseo-next-v2"]["chains.Bulletin.rpc"];
    before["paseo-next-v2"]["chains.Bulletin.rpc"] = "wss://old-bulletin.example";
    const beforeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stack-values-")), "before.json");
    fs.writeFileSync(beforeFile, JSON.stringify(before));

    const result = runStackValues("--compare", beforeFile);
    assert.equal(result.status, 0, `>> FAIL: stack-values.mjs --compare: it fails: ${result.stderr.trim()}`);
    assert.ok(result.stdout.includes(`- \`chains.Bulletin.rpc\`: \`wss://old-bulletin.example\` -> \`${current}\``),
      `>> FAIL: stack-values.mjs --compare: the changed Bulletin RPC is missing from the body:\n${result.stdout}`);
    assert.ok(result.stdout.includes("**preview**: no value changed."),
      ">> FAIL: stack-values.mjs --compare: an unchanged stack must say so");
  });

  test("an unknown argument exits 1 with the usage", () => {
    const result = runStackValues("--bogus");
    assert.equal(result.status, 1, ">> FAIL: stack-values.mjs: an unknown argument must exit 1, or the update step reads an empty snapshot");
    assert.match(result.stderr, /usage: stack-values\.mjs/, ">> FAIL: stack-values.mjs: an unknown argument must print the usage");
  });
});
