// test/commitment-lock.test.js — #1659: the DotNS commitment record is shared
// by every process that commits the same (env, tld, owner, label). A process
// must never delete or overwrite another live process's in-flight record.
// src/run-state.ts provides an O_EXCL lock per record key, a record id, and
// compare-and-replace / compare-and-unlink on the record file.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  writeCommitmentRecord,
  loadCommitmentRecord,
  clearCommitmentRecord,
  replaceCommitmentRecord,
  commitmentRecordKey,
  tryAcquireCommitmentLock,
  commitmentLockFilePath,
} from "../dist/run-state.js";
import { withIsolatedHome } from "./helpers/isolated-home.js";

const ENV_ID = "lock-env";
const TLD = "dot";
const OWNER = "0x3333333333333333333333333333333333333333";
const LABEL = "locktestlabel";

function record(overrides = {}) {
  return {
    savedAt: Date.now(), environmentId: ENV_ID, tld: TLD, protocol: "poprules-startingPrice",
    label: LABEL, owner: OWNER, reserved: false, secret: "0x" + "ab".repeat(32), commitment: "0x" + "cd".repeat(32),
    ...overrides,
  };
}

function writeForeignLock(pid, extra = {}) {
  const file = commitmentLockFilePath(ENV_ID, TLD, OWNER, LABEL);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ pid, host: os.hostname(), token: "foreign-token", createdAt: Date.now(), ...extra }), { mode: 0o600 });
  return file;
}

function deadPid() {
  // A pid that just exited: spawnSync waits for the child to finish.
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

describe("commitment lock (#1659)", () => {
  test("acquire, then a second acquire sees the holder; release frees it", () => {
    withIsolatedHome(() => {
      const a = tryAcquireCommitmentLock(ENV_ID, TLD, OWNER, LABEL);
      assert.ok(a.token, ">> FAIL: commitment-lock: the first acquire must get a lock token");
      const b = tryAcquireCommitmentLock(ENV_ID, TLD, OWNER, LABEL);
      assert.equal(b.heldBy?.pid, process.pid, ">> FAIL: commitment-lock: a second acquire while the first is held must report the holder, not get the lock");
      a.release();
      const c = tryAcquireCommitmentLock(ENV_ID, TLD, OWNER, LABEL);
      assert.ok(c.token, ">> FAIL: commitment-lock: after release the lock must be acquirable again");
      c.release();
    });
  });

  test("release only removes its own lock, never a lock another process took over", () => {
    withIsolatedHome(() => {
      const a = tryAcquireCommitmentLock(ENV_ID, TLD, OWNER, LABEL);
      const file = commitmentLockFilePath(ENV_ID, TLD, OWNER, LABEL);
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "someone-else", createdAt: Date.now() }));
      a.release();
      assert.ok(fs.existsSync(file), ">> FAIL: commitment-lock: release must not unlink a lock whose token is not ours");
    });
  });

  test("the lock file is 0600 and holds no secret", () => {
    if (process.platform === "win32") return;
    withIsolatedHome(() => {
      const a = tryAcquireCommitmentLock(ENV_ID, TLD, OWNER, LABEL);
      const file = commitmentLockFilePath(ENV_ID, TLD, OWNER, LABEL);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, ">> FAIL: commitment-lock: lock file must be created 0600 (#1570 posture)");
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8"))).sort(), ["createdAt", "host", "pid", "token"],
        ">> FAIL: commitment-lock: the lock file must carry only pid/host/token/createdAt");
      a.release();
    });
  });

  test("a lock left by a dead process (SIGKILL) is taken over", () => {
    withIsolatedHome(() => {
      writeForeignLock(deadPid());
      const a = tryAcquireCommitmentLock(ENV_ID, TLD, OWNER, LABEL);
      assert.ok(a.token, ">> FAIL: commitment-lock: a lock whose pid is dead on this host must be taken over, not waited on");
      a.release();
    });
  });

  test("a lock held by a LIVE other process is reported, not taken", async () => {
    await withIsolatedHome(async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      try {
        writeForeignLock(child.pid);
        const a = tryAcquireCommitmentLock(ENV_ID, TLD, OWNER, LABEL);
        assert.equal(a.token, undefined, ">> FAIL: commitment-lock: a live holder's lock must never be taken over");
        assert.equal(a.heldBy?.pid, child.pid, ">> FAIL: commitment-lock: the result must name the live holder");
      } finally {
        child.kill();
      }
    });
  });
});

describe("commitment record compare-and-replace (#1659)", () => {
  test("replace refuses when the on-disk record is not the one we expected", () => {
    withIsolatedHome(() => {
      const theirs = record({ recordId: "theirs" });
      writeCommitmentRecord(theirs);
      assert.equal(replaceCommitmentRecord(record({ recordId: "mine" }), null), false,
        ">> FAIL: commitment-cas: a write expecting no record must not overwrite another process's record");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL)?.recordId, "theirs");
      assert.equal(replaceCommitmentRecord(record({ recordId: "mine" }), "theirs"), true,
        ">> FAIL: commitment-cas: a write expecting the current record id must replace it");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL)?.recordId, "mine");
    });
  });

  test("replace with expected null succeeds when no record exists", () => {
    withIsolatedHome(() => {
      assert.equal(replaceCommitmentRecord(record({ recordId: "mine" }), null), true);
      assert.equal(fs.statSync(commitmentLockFilePath(ENV_ID, TLD, OWNER, LABEL).replace(/\.lock$/, ".json")).isFile(), true);
    });
  });

  test("a record written before #1659 (no recordId) has a stable legacy key", () => {
    const legacy = record();
    assert.equal(commitmentRecordKey(legacy), `legacy:${legacy.commitment}`);
    assert.equal(commitmentRecordKey(record({ recordId: "x" })), "x");
    assert.equal(commitmentRecordKey(null), null);
  });

  test("clear with a key that does not match leaves the record in place", () => {
    withIsolatedHome(() => {
      writeCommitmentRecord(record({ recordId: "theirs" }));
      clearCommitmentRecord(ENV_ID, TLD, OWNER, LABEL, "mine");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL)?.recordId, "theirs",
        ">> FAIL: commitment-cas: clearing with a stale key must never delete another process's record");
      clearCommitmentRecord(ENV_ID, TLD, OWNER, LABEL, "theirs");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null);
    });
  });
});
