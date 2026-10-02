// test/formal-commit-resume.test.js — replays of formal/tla/CommitResume.tla
// counterexamples against the REAL DotNS.commitAndRegister /
// resolveResumableCommitment (dist/), on an unconnected DotNS with the chain
// steps stubbed as spies. Every test runs under an isolated HOME so no real
// commitment secret is ever written to the developer's machine.
//
// FV-A-F5 (#1659) is fixed: these tests assert the FIXED behaviour. See
// formal/tla/FINDINGS.md and the CR_Fixed* configs in formal/tla.
// (Twin note: the formal/ tree is upstream-only and not mirrored; this file drives the
// real dist/ code and loads nothing from formal/.)
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DotNS } from "../dist/dotns.js";
import { getAdapter } from "../dist/dotns-protocol.js";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeCommitmentRecord, loadCommitmentRecord, commitmentLockFilePath } from "../dist/run-state.js";
import { withIsolatedHome } from "./helpers/isolated-home.js";

const ENV_ID = "fv-env";
const TLD = "dot";
const OWNER = "0x2222222222222222222222222222222222222222";
const LABEL = "fvresumelabel";
const H1 = "0x" + "11".repeat(32);
const H2 = "0x" + "22".repeat(32);
const S1 = "0x" + "a1".repeat(32);
const S2 = "0x" + "b2".repeat(32);

function makeDotNS() {
  const d = new DotNS();
  d.connected = true;
  d._tld = TLD;
  d._environmentId = ENV_ID;
  d._protocolVersion = "poprules-startingPrice";
  d._adapter = getAdapter("poprules-startingPrice");
  d.evmAddress = OWNER;
  d.substrateAddress = "5FvSigner";
  d._sleep = async () => {};
  return d;
}

function spy(impl) {
  const fn = (...args) => { fn.calls.push(args); return impl(...args); };
  fn.calls = [];
  return fn;
}

// The record process 1 wrote just BEFORE its commit tx (dotns.ts persists first).
function p1Record() {
  return {
    savedAt: Date.now(), environmentId: ENV_ID, tld: TLD, protocol: "poprules-startingPrice",
    label: LABEL, owner: OWNER, reserved: false, secret: S1, commitment: H1,
  };
}

// A live process (not this one) holding the commitment lock for LABEL.
async function withLiveForeignLock(fn) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const file = commitmentLockFilePath(ENV_ID, TLD, OWNER, LABEL);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid, host: os.hostname(), token: "p1-token", createdAt: Date.now() }), { mode: 0o600 });
    return await fn(file);
  } finally {
    child.kill();
  }
}

function wireChain(d, { commitments = async () => 0n } = {}) {
  d.generateCommitment = spy(async () => ({ commitment: H2, registration: { label: LABEL, owner: OWNER, secret: S2, reserved: false } }));
  d.waitForCommitmentAge = spy(async () => {});
  d.getPriceAndValidate = spy(async () => ({ priceWei: 0n, requiredStatus: 0, userStatus: 0, message: "" }));
  d.finalizeRegistration = spy(async () => {});
  d.contractCall = spy(async (_addr, _abi, fn) => {
    if (fn === "makeCommitment") return H1;    // the stored tuple is intact
    if (fn === "commitments") return commitments();
    if (fn === "maxCommitmentAge") return 86_400n;
    throw new Error(`unexpected contractCall: ${fn}`);
  });
}

describe("formal CommitResume: a pending commit is not a dead one (FV-A-F5, #1659 fixed)", () => {
  test("FV-A-F5: a restart whose record's commit tx is still in flight re-submits the SAME commitment, never a fresh one, and keeps the record", async () => {
    await withIsolatedHome(async () => {
      // Process 1 persisted H1 (a pre-#1659 record: no recordId) and submitted
      // its commit; the tx is still in the pool, so commitments(H1) reads 0.
      // Process 1 then crashed and this is the restart.
      writeCommitmentRecord(p1Record());
      const d = makeDotNS();
      wireChain(d);
      const submitted = [];
      let recordDuringSubmit;
      d.submitCommitment = spy(async (c) => {
        submitted.push(c);
        recordDuringSubmit = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL);
      });

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: FV-A-F5: a fresh commitment was generated while H1's commit tx may still be pending");
      assert.deepEqual(submitted, [H1], ">> FAIL: FV-A-F5: the restart must re-submit H1 itself (same hash, same secret), not a second commitment");
      assert.equal(recordDuringSubmit?.commitment, H1, ">> FAIL: FV-A-F5: H1's record must stay on disk while H1 is re-submitted");
      assert.equal(recordDuringSubmit?.secret, S1, ">> FAIL: FV-A-F5: H1's secret must stay on disk");
      assert.deepEqual(d.finalizeRegistration.calls[0][0], { label: LABEL, owner: OWNER, secret: S1, reserved: false },
        ">> FAIL: FV-A-F5: register must reveal H1's tuple");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: FV-A-F5: the record is cleared once H1 is registered");
    });
  });

  test("FV-A-F5: a pending commit that lands during the bounded re-probe is resumed with no second commit tx", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(p1Record());
      const d = makeDotNS();
      let reads = 0;
      wireChain(d, { commitments: async () => (++reads >= 3 ? 1_000n : 0n) });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => 1_100_000n } } } } };
      d.submitCommitment = spy(async () => {});

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.submitCommitment.calls.length, 0, ">> FAIL: FV-A-F5: H1 landed during the re-probe; no commit tx should be sent at all");
      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: FV-A-F5: no fresh commitment while H1 is valid");
      assert.equal(d.finalizeRegistration.calls.length, 1);
    });
  });

  test("FV-A-F5 (shared record): a second same-owner process never deletes, overwrites or commits over a live process's in-flight record", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(p1Record());
      await withLiveForeignLock(async (lockFile) => {
        const d = makeDotNS();
        wireChain(d);
        d.submitCommitment = spy(async () => {});
        d._commitLockWaitPolls = 3;

        await assert.rejects(() => d.commitAndRegister(LABEL, false), /Another bulletin-deploy process .* is registering fvresumelabel\.dot/,
          ">> FAIL: FV-A-F5: a live holder must make the second process wait, then stop with a clear error");

        assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: FV-A-F5: the second process generated a commitment while the first one's is in flight");
        assert.equal(d.submitCommitment.calls.length, 0, ">> FAIL: FV-A-F5: the second process sent a commit tx");
        const rec = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL);
        assert.equal(rec?.commitment, H1, ">> FAIL: FV-A-F5: process 1's record must be untouched");
        assert.equal(rec?.secret, S1, ">> FAIL: FV-A-F5: process 1's secret must be untouched");
        assert.ok(fs.existsSync(lockFile), ">> FAIL: FV-A-F5: process 1's lock must be untouched");
      });
    });
  });

  test("FV-A-F5 (shared record): when the live holder finishes and the name is ours, the second process stops without committing", async () => {
    await withIsolatedHome(async () => {
      await withLiveForeignLock(async (lockFile) => {
        const d = makeDotNS();
        wireChain(d);
        d.submitCommitment = spy(async () => {});
        let polls = 0;
        d._sleep = async () => { if (++polls === 2) fs.rmSync(lockFile); };
        d.checkOwnership = async () => ({ owned: true, owner: OWNER });

        await d.commitAndRegister(LABEL, false);

        assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: FV-A-F5: the name was registered by the sibling; no commitment may be generated");
        assert.equal(d.finalizeRegistration.calls.length, 0, ">> FAIL: FV-A-F5: the name was registered by the sibling; no register may be sent");
      });
    });
  });

  test("FV-A-F5 (shared record): the sibling registered and released the lock before we asked for it: ownership is re-checked under the lock, no commit", async () => {
    await withIsolatedHome(async () => {
      const d = makeDotNS();
      wireChain(d);
      d.submitCommitment = spy(async () => {});
      d.checkOwnership = async () => ({ owned: true, owner: OWNER });

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: FV-A-F5: the name is already ours; a commit now is a second commitment for a registered name (CR_FixedShared)");
      assert.equal(d.submitCommitment.calls.length, 0);
      assert.ok(!fs.existsSync(commitmentLockFilePath(ENV_ID, TLD, OWNER, LABEL)), ">> FAIL: FV-A-F5: the lock must be released");
    });
  });
});
