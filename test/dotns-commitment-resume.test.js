// test/dotns-commitment-resume.test.js — issue #1412: a DotNS deploy that
// dies between commit and register must be able to resume the on-chain
// commitment instead of abandoning it. Covers both layers:
//   1. src/run-state.ts's commitment-record persistence (pure file I/O,
//      chain-agnostic) — 0600 permission, per-(env,owner) isolation,
//      atomic write, graceful degradation on write failure.
//   2. DotNS.resolveResumableCommitment / DotNS.commitAndRegister (chain
//      validity checks + orchestration) — exercised on an unconnected
//      DotNS instance with generateCommitment/submitCommitment/
//      waitForCommitmentAge/getPriceAndValidate/finalizeRegistration
//      stubbed as call-counting spies, so this runs with no live chain.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { DotNS } from "../dist/dotns.js";
import { getAdapter } from "../dist/dotns-protocol.js";
import {
  writeCommitmentRecord,
  loadCommitmentRecord,
  clearCommitmentRecord,
  commitmentRecordKey,
  commitmentStateFilePath,
  resolveStateDir,
} from "../dist/run-state.js";
import { withIsolatedHome } from "./helpers/isolated-home.js";

const ENV_ID = "test-env";
const TLD = "dot";
const OWNER = "0x1111111111111111111111111111111111111111";
const LABEL = "resumetestlabel";
const COMMITMENT_HASH = "0xaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbcccc00";
const SECRET = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".slice(0, 66);

function baseRecord(overrides = {}) {
  return {
    savedAt: Date.now(),
    environmentId: ENV_ID,
    tld: TLD,
    protocol: "poprules-startingPrice",
    label: LABEL,
    owner: OWNER,
    reserved: false,
    secret: SECRET,
    commitment: COMMITMENT_HASH,
    ...overrides,
  };
}

function makeDotNS({ protocol = "poprules-startingPrice", environmentId = ENV_ID, tld = TLD, owner = OWNER } = {}) {
  const d = new DotNS();
  d.connected = true;
  d._tld = tld;
  d._environmentId = environmentId;
  d._protocolVersion = protocol;
  d._adapter = getAdapter(protocol);
  d.evmAddress = owner;
  d.substrateAddress = "5TestSigner";
  d._sleep = async () => {}; // #1659 re-probe / retry settle waits
  return d;
}

function spy(impl) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

// Wires the 5 sub-steps DotNS.commitAndRegister orchestrates, as spies, so
// the orchestration is testable with zero chain I/O. `generated` controls
// what a fresh generateCommitment call returns.
function wireHappyPathSpies(d, { generated } = {}) {
  d.generateCommitment = spy(async () => generated ?? {
    commitment: COMMITMENT_HASH,
    registration: { label: LABEL, owner: OWNER, secret: SECRET, reserved: false },
  });
  d.submitCommitment = spy(async () => {});
  d.waitForCommitmentAge = spy(async () => {});
  d.getPriceAndValidate = spy(async () => ({ priceWei: 0n, requiredStatus: 0, userStatus: 0, message: "" }));
  d.finalizeRegistration = spy(async () => {});
  return d;
}

// Simulates resolveStateDir() itself throwing — the real-world trigger is
// os.homedir() raising ERR_SYSTEM_ERROR when HOME is unset and the current
// UID has no /etc/passwd entry (containers run with --user), per #1412 code
// review. os.homedir() can't be stubbed from here: it's a Node built-in
// accessed via `import * as os from "node:os"` inside dist/run-state.js, and
// ES module namespace objects reject both direct assignment and
// Object.defineProperty (confirmed empirically) — so mutating the imported
// binding, or even the separate object `require("node:os")` returns, never
// reaches dist/run-state.js's own calls to os.homedir(). Reproducing the
// exact libuv/passwd failure would need a child process running under a
// UID with no passwd entry, which needs privileges this suite doesn't have.
//
// Instead this forces process.platform to a non-darwin/non-win32 value (so
// resolveStateDir() takes the "Linux / other POSIX" branch) and replaces
// process.env with a Proxy that throws when XDG_STATE_HOME is read — an
// exception during the SAME "compute the state directory" step, from a
// mechanism this suite CAN control. Structurally this exercises the exact
// property the fix guarantees (path resolution runs inside every caller's
// try, not as an eagerly-evaluated argument before it), regardless of which
// specific call inside that step is what actually throws.
function withThrowingStateDirResolution(fn) {
  const savedPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const savedEnv = process.env;
  Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
  // Proxy the REAL env object, not a fresh {} — an empty target would make
  // every other env var (PATH, TMPDIR, CI flags, ...) read as undefined for
  // the whole duration of fn(), which risks unrelated knock-on failures in
  // whatever fn() exercises. Only the one targeted key throws; everything
  // else passes through to the real, unmodified environment.
  process.env = new Proxy(savedEnv, {
    get(target, prop) {
      if (prop === "XDG_STATE_HOME") {
        throw new Error("simulated state-dir resolution failure (analogous to os.homedir() throwing on a container with no passwd entry)");
      }
      return Reflect.get(target, prop);
    },
  });
  const restore = () => {
    Object.defineProperty(process, "platform", savedPlatformDescriptor);
    process.env = savedEnv;
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === "function") {
    return result.finally(restore);
  }
  restore();
  return result;
}

// ---------------------------------------------------------------------------
// Layer 1: src/run-state.ts commitment-record persistence (pure I/O)
// ---------------------------------------------------------------------------
describe("commitment record persistence (run-state.ts)", () => {
  test("round-trips through write/load and cleans up on clear", () => {
    withIsolatedHome(() => {
      const record = baseRecord();
      const ok = writeCommitmentRecord(record);
      assert.equal(ok, true, ">> FAIL: commitment-persistence: write should report success on a writable state dir");
      const loaded = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL);
      assert.deepEqual(loaded, record, ">> FAIL: commitment-persistence: loaded record should equal what was written");
      clearCommitmentRecord(ENV_ID, TLD, OWNER, LABEL, commitmentRecordKey(record));
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commitment-persistence: record should be gone after clear");
    });
  });

  test("file is created 0600 (owner read/write only) from the start", () => {
    if (process.platform === "win32") return; // POSIX permission bits don't apply
    withIsolatedHome(() => {
      writeCommitmentRecord(baseRecord());
      const file = commitmentStateFilePath(ENV_ID, TLD, OWNER, LABEL);
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, `>> FAIL: commitment-persistence: file mode should be 0600, got ${mode.toString(8)} — the secret in this file is the commit-reveal preimage and must not be group/world-readable`);
    });
  });

  test("two different owners in the same environment get separate files (per-caller isolation)", () => {
    withIsolatedHome(() => {
      const ownerA = OWNER;
      const ownerB = "0x2222222222222222222222222222222222222222";
      writeCommitmentRecord(baseRecord({ owner: ownerA, label: "labela" }));
      writeCommitmentRecord(baseRecord({ owner: ownerB, label: "labelb" }));
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, ownerA, "labela").label, "labela", ">> FAIL: commitment-persistence: owner A's record should be unaffected by owner B's write");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, ownerB, "labelb").label, "labelb", ">> FAIL: commitment-persistence: owner B's record should be unaffected by owner A's write");
      assert.notEqual(commitmentStateFilePath(ENV_ID, TLD, ownerA, "labela"), commitmentStateFilePath(ENV_ID, TLD, ownerB, "labelb"), ">> FAIL: commitment-persistence: different owners must resolve to different file paths");
    });
  });

  test("no .tmp leftovers after a write", () => {
    withIsolatedHome(() => {
      writeCommitmentRecord(baseRecord());
      const leftovers = fs.readdirSync(resolveStateDir()).filter((f) => f.endsWith(".tmp"));
      assert.deepEqual(leftovers, [], ">> FAIL: commitment-persistence: atomic write via tmp+rename should leave no .tmp files behind");
    });
  });

  test("loadCommitmentRecord returns null on malformed JSON, never throws", () => {
    withIsolatedHome(() => {
      const dir = resolveStateDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(commitmentStateFilePath(ENV_ID, TLD, OWNER, LABEL), "{not json");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commitment-persistence: malformed JSON must degrade to null, not throw");
    });
  });

  test("writeCommitmentRecord returns false (never throws) when the state dir cannot be created", () => {
    withIsolatedHome((tmp) => {
      // Force the state-dir's own path to already exist as a plain FILE, so
      // fs.mkdirSync(dir, { recursive: true }) fails (ENOTDIR/EEXIST) rather
      // than succeeding. Deliberately not chmod-based (advisor note: a
      // chmod-based permission-denial test silently passes when the test
      // runner is root, e.g. in some CI containers).
      let stateDir;
      if (process.platform === "darwin") stateDir = path.join(tmp, "Library", "Application Support", "polkadot-app-deploy");
      else if (process.platform === "win32") stateDir = path.join(tmp, "AppData", "Local", "polkadot-app-deploy");
      else stateDir = path.join(tmp, ".local", "state", "polkadot-app-deploy");
      fs.mkdirSync(path.dirname(stateDir), { recursive: true });
      fs.writeFileSync(stateDir, "not a directory");

      let ok;
      assert.doesNotThrow(() => { ok = writeCommitmentRecord(baseRecord()); }, ">> FAIL: commitment-persistence: a write failure must never throw — it must degrade to 'no resume', not fail the deploy");
      assert.equal(ok, false, ">> FAIL: commitment-persistence: write should report failure when the state dir path is blocked by a file");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commitment-persistence: nothing should have been persisted");
    });
  });

  test("an abandoned sibling commitment record is pruned on the next load, a live record is unaffected", () => {
    withIsolatedHome(() => {
      const staleOwner = "0x4444444444444444444444444444444444444444";
      const staleLabel = "stalelabel";
      // writeCommitmentRecord itself no longer prunes (only loadCommitmentRecord
      // does — see run-state.ts), so this deliberately-backdated fixture is
      // safe to write through the normal API; it won't be swept until a load runs.
      writeCommitmentRecord(baseRecord({ owner: staleOwner, label: staleLabel, savedAt: Date.now() - 49 * 60 * 60 * 1000 })); // 49h old
      writeCommitmentRecord(baseRecord()); // fresh, unrelated key
      assert.ok(fs.existsSync(commitmentStateFilePath(ENV_ID, TLD, staleOwner, staleLabel)), ">> FAIL: commitment-pruning: sanity check — the stale record must actually exist before any load runs");

      // Loading ANY key triggers a full pruning sweep of every commitment file.
      const fresh = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL);

      assert.notEqual(fresh, null, ">> FAIL: commitment-pruning: the fresh record must survive the pruning sweep triggered by loading it");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, staleOwner, staleLabel), null, ">> FAIL: commitment-pruning: a commitment record older than the fixed ceiling must be pruned by the time the next load runs");
    });
  });

  test("pruning tolerates a malformed sibling record file without throwing or blocking the current load", () => {
    withIsolatedHome(() => {
      const dir = resolveStateDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "commitment-garbage.json"), "{not json at all");
      writeCommitmentRecord(baseRecord());

      let loaded;
      assert.doesNotThrow(() => { loaded = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL); }, ">> FAIL: commitment-pruning: a malformed sibling record must never crash a load for an unrelated key");
      assert.notEqual(loaded, null, ">> FAIL: commitment-pruning: the current record must still be readable after pruning tolerated the malformed sibling");
    });
  });

  test("commitment record path is never under the current working / build directory", () => {
    withIsolatedHome(() => {
      const file = commitmentStateFilePath(ENV_ID, TLD, OWNER, LABEL);
      const cwd = process.cwd();
      assert.ok(!file.startsWith(cwd), `>> FAIL: commitment-persistence: commitment state file must never resolve under the CWD/build directory (got ${file} under cwd ${cwd}) — anything under the build dir risks being published to the public gateway with the deployed site`);
      assert.ok(file.startsWith(resolveStateDir()), `>> FAIL: commitment-persistence: commitment state file must resolve under resolveStateDir() (${resolveStateDir()}), got ${file}`);
      assert.ok(!file.includes(`${path.sep}.bulletin-deploy${path.sep}`) && !file.endsWith(`${path.sep}.bulletin-deploy`), `>> FAIL: commitment-persistence: commitment state file must never land inside a .bulletin-deploy manifest directory, got ${file}`);
    });
  });

  test("loadCommitmentRecord/writeCommitmentRecord never throw when resolving the state dir itself throws (#1412 code review)", () => {
    withThrowingStateDirResolution(() => {
      let loaded, written;
      assert.doesNotThrow(() => { loaded = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL); }, ">> FAIL: run-state-never-throw: loadCommitmentRecord must never throw even when resolveStateDir() itself fails");
      assert.equal(loaded, null, ">> FAIL: run-state-never-throw: a failed state-dir resolution must degrade to null (no resume), not throw");
      assert.doesNotThrow(() => { written = writeCommitmentRecord(baseRecord()); }, ">> FAIL: run-state-never-throw: writeCommitmentRecord must never throw even when resolveStateDir() itself fails");
      assert.equal(written, false, ">> FAIL: run-state-never-throw: a failed state-dir resolution must degrade to false (no persistence), not throw");
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 2: DotNS.resolveResumableCommitment / DotNS.commitAndRegister
// ---------------------------------------------------------------------------
describe("DotNS.commitAndRegister — resume orchestration (#1412)", () => {
  test("fresh run, no stored state: commits fresh, does not attempt resume", async () => {
    await withIsolatedHome(async () => {
      const d = makeDotNS();
      wireHappyPathSpies(d);

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-fresh: no stored commitment means generateCommitment must run exactly once");
      assert.equal(d.submitCommitment.calls.length, 1, ">> FAIL: commit-resume-fresh: no stored commitment means submitCommitment must run exactly once");
      assert.equal(d.finalizeRegistration.calls.length, 1, ">> FAIL: commit-resume-fresh: finalizeRegistration must still run to complete the deploy");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-fresh: the record persisted mid-flow must be cleared after a successful register");
    });
  });

  test("stored commitment still valid on-chain: resumes, skips a new commit", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(baseRecord());
      const d = makeDotNS();
      wireHappyPathSpies(d);
      const commitTimestamp = 1_000;
      const maxAge = 86_400;
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return BigInt(commitTimestamp);
        if (fn === "maxCommitmentAge") return BigInt(maxAge);
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => BigInt((commitTimestamp + 3600) * 1000) } } } } };

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: commit-resume-valid: a still-valid stored commitment must NOT trigger a fresh commit (that's exactly the fee/wait #1412 exists to avoid)");
      assert.equal(d.submitCommitment.calls.length, 0, ">> FAIL: commit-resume-valid: submitCommitment must be skipped — the commit tx already landed");
      assert.equal(d.waitForCommitmentAge.calls.length, 1, ">> FAIL: commit-resume-valid: the resumed commitment must still be waited on / revealed");
      assert.equal(d.waitForCommitmentAge.calls[0][0], COMMITMENT_HASH, ">> FAIL: commit-resume-valid: waitForCommitmentAge must be called with the RESUMED commitment hash, not a fresh one");
      assert.equal(d.finalizeRegistration.calls.length, 1, ">> FAIL: commit-resume-valid: finalizeRegistration must run using the rehydrated registration tuple");
      assert.equal(d.finalizeRegistration.calls[0][0].secret, SECRET, ">> FAIL: commit-resume-valid: the rehydrated registration must carry the ORIGINAL secret, not a new one");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-valid: the record must be cleared once registration finalizes successfully");
    });
  });

  // #1659: was "discarded, fresh commit paid for". The controller accepts
  // commit() again for an expired hash and restarts its clock, so the same
  // commitment is re-committed (same fee) instead: a discard raced a
  // re-submit of this very hash still in the pool (CommitResume CR_Fixed1).
  // The property kept: an expired commitment is never just waited out.
  test("stored commitment expired on-chain: re-committed with the SAME hash (restarts its window), never waited out (#1659)", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(baseRecord());
      const d = makeDotNS();
      wireHappyPathSpies(d);
      const commitTimestamp = 1_000;
      const maxAge = 100; // short window so "now" below is past expiry
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH; // still matches — proves expiry, not corruption, drives the discard
        if (fn === "commitments") return BigInt(commitTimestamp);
        if (fn === "maxCommitmentAge") return BigInt(maxAge);
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => BigInt((commitTimestamp + 200) * 1000) } } } } }; // now=1200s > expiry=1100s

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: commit-resume-expired: an expired stored commitment is revived by re-committing it, not replaced by a second commitment");
      assert.deepEqual(d.submitCommitment.calls.map((c) => c[0]), [COMMITMENT_HASH], ">> FAIL: commit-resume-expired: the expired commitment must be re-committed on-chain before any wait, never just waited out");
      assert.ok(d.submitCommitment.calls.length === 1 && d.waitForCommitmentAge.calls.length === 1, ">> FAIL: commit-resume-expired: re-commit, then wait the fresh window");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-expired: the record is removed from disk once registered");
    });
  });

  test("stored commitment whose recomputed hash doesn't match on-chain: provably corrupt, discarded, fresh commit paid for", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(baseRecord());
      const d = makeDotNS();
      wireHappyPathSpies(d);
      d.contractCall = spy(async (_addr, _abi, fn) => {
        // makeCommitment recomputes a DIFFERENT hash from the rehydrated
        // tuple than what was stored — the tuple didn't round-trip
        // faithfully (a bigint field, a dropped key, ...). Provably corrupt.
        if (fn === "makeCommitment") return "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        throw new Error(`contractCall(${fn}) should not be reached — the hash mismatch must short-circuit before any further chain read`);
      });

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-hash-mismatch: a recomputed-hash mismatch must be discarded in favour of a fresh commit");
      assert.equal(d.submitCommitment.calls.length, 1, ">> FAIL: commit-resume-hash-mismatch: the fresh commitment must actually be submitted on-chain");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-hash-mismatch: the provably-corrupt record must be discarded, not left around to fail the same way again");
    });
  });

  // #1659: this test used to assert "discarded, fresh commit paid for". That
  // was the FV-A-F5 bug: 0 is also a commit tx still in the pool, and the
  // fresh commit abandoned it when it landed. The property kept: a stored
  // commitment that is not on-chain never blocks registration.
  test("stored commitment not on-chain (commitments() returns 0): the SAME commitment is re-submitted, no fresh one, record kept until register (#1659)", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(baseRecord());
      const d = makeDotNS();
      wireHappyPathSpies(d);
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH; // hash matches — the tuple is intact
        if (fn === "commitments") return 0n; // pending, dropped, or never sent
        if (fn === "maxCommitmentAge") return BigInt(86_400);
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      let recordAtSubmit;
      d.submitCommitment = spy(async () => { recordAtSubmit = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL); });

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: commit-resume-not-landed: a stored commitment that reads 0 may still be pending; it must never be replaced by a fresh one");
      assert.deepEqual(d.submitCommitment.calls.map((c) => c[0]), [COMMITMENT_HASH], ">> FAIL: commit-resume-not-landed: the stored hash itself must be re-submitted");
      assert.equal(recordAtSubmit?.secret, SECRET, ">> FAIL: commit-resume-not-landed: the record must stay on disk while the same hash is re-submitted");
      assert.equal(d.finalizeRegistration.calls[0][0].secret, SECRET, ">> FAIL: commit-resume-not-landed: register must reveal the stored secret");
      const commitmentReads = d.contractCall.calls.filter((c) => c[2] === "commitments").length;
      assert.equal(commitmentReads, 5, ">> FAIL: commit-resume-not-landed: a 0 read must be re-probed (1 read + 4 re-probes) before re-submitting");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-not-landed: the record is cleared once registered");
    });
  });

  test("re-submitting a stored commitment that the original tx landed first: a rejected re-submit is fine when the commitment is on-chain (#1659)", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(baseRecord());
      const d = makeDotNS();
      wireHappyPathSpies(d);
      let landed = false;
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return landed ? 1_000n : 0n;
        if (fn === "maxCommitmentAge") return BigInt(86_400);
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => 1_100_000n } } } } };
      d.submitCommitment = spy(async () => { landed = true; throw new Error("Contract execution would revert during commit"); });

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.finalizeRegistration.calls.length, 1, ">> FAIL: commit-resume-resubmit-race: the original commit landed, so the deploy must continue to register");
      assert.equal(d.generateCommitment.calls.length, 0);
    });
  });

  test("re-submitting a stored commitment that fails and is still not on-chain propagates the error, record kept (#1659)", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(baseRecord());
      const d = makeDotNS();
      wireHappyPathSpies(d);
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return 0n;
        if (fn === "maxCommitmentAge") return BigInt(86_400);
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.submitCommitment = spy(async () => { throw new Error("connection reset"); });

      await assert.rejects(() => d.commitAndRegister(LABEL, false), /connection reset/);
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL)?.secret, SECRET, ">> FAIL: commit-resume-resubmit-fail: the record must survive for the next run");
    });
  });

  test("a stored commitment for a DIFFERENT label is a separate file, left untouched, while this label commits fresh", async () => {
    await withIsolatedHome(async () => {
      const otherLabel = "someotherlabel";
      const otherRecord = baseRecord({ label: otherLabel });
      writeCommitmentRecord(otherRecord);
      const d = makeDotNS();
      wireHappyPathSpies(d);
      // No contractCall stub needed — under the key-scoped file layout,
      // LABEL's own file simply doesn't exist yet, so this is a fresh-run
      // path exactly like "no stored state" — no chain read happens before
      // a fresh commit.
      d.contractCall = spy(async (_addr, _abi, fn) => {
        throw new Error(`contractCall(${fn}) should not be reached — LABEL has no stored record, this is a fresh commit`);
      });

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.contractCall.calls.length, 0, ">> FAIL: commit-resume-label-isolation: LABEL has its own key-scoped file, distinct from otherLabel's — resolving it must never read otherLabel's on-chain state");
      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-label-isolation: LABEL has no stored commitment of its own, so it must commit fresh");
      assert.equal(d.submitCommitment.calls.length, 1, ">> FAIL: commit-resume-label-isolation: the fresh commitment for LABEL must actually be submitted on-chain");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-label-isolation: LABEL's own record must be cleared after it successfully registers");
      assert.deepEqual(loadCommitmentRecord(ENV_ID, TLD, OWNER, otherLabel), otherRecord, ">> FAIL: commit-resume-label-isolation: resolving/registering LABEL must leave the OTHER label's still-pending record completely untouched on disk — this is the key-scoped-file isolation #1412 depends on");
    });
  });

  test("stored commitment whose owner field doesn't match the caller: discarded, fresh commit paid for", async () => {
    await withIsolatedHome(async () => {
      // Simulates a corrupted/foreign record landing at this caller's own
      // file path (the file is keyed by (environmentId, tld, owner, label)
      // via the lookup, but the record's OWN `owner` field is what
      // resolveResumableCommitment actually checks against the live
      // evmAddress).
      const file = commitmentStateFilePath(ENV_ID, TLD, OWNER, LABEL);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(baseRecord({ owner: "0x3333333333333333333333333333333333333333" })), { mode: 0o600 });

      const d = makeDotNS();
      wireHappyPathSpies(d);
      d.contractCall = spy(async (_addr, _abi, fn) => {
        throw new Error(`contractCall(${fn}) should not be reached on an owner mismatch`);
      });

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.contractCall.calls.length, 0, ">> FAIL: commit-resume-owner-mismatch: an owner mismatch must be rejected without any chain read");
      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-owner-mismatch: a record whose owner field doesn't match this run must be discarded, fresh commit made");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-owner-mismatch: the mismatched record must be discarded");
    });
  });

  test("a stored record with a malformed/missing owner field never crashes resume: discarded, fresh commit paid for", async () => {
    await withIsolatedHome(async () => {
      // Simulates schema drift or a hand-edited file: a required field is
      // simply absent. resolveResumableCommitment used to do
      // record.owner.toLowerCase() before validating shape, which threw
      // TypeError: Cannot read properties of undefined here.
      const file = commitmentStateFilePath(ENV_ID, TLD, OWNER, LABEL);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const corrupt = baseRecord();
      delete corrupt.owner;
      fs.writeFileSync(file, JSON.stringify(corrupt), { mode: 0o600 });

      const d = makeDotNS();
      wireHappyPathSpies(d);
      d.contractCall = spy(async (_addr, _abi, fn) => {
        throw new Error(`contractCall(${fn}) should not be reached on a malformed record`);
      });

      await assert.doesNotReject(
        () => d.commitAndRegister(LABEL, false),
        ">> FAIL: commit-resume-malformed-record: a record missing a required field must never crash commitAndRegister",
      );
      assert.equal(d.contractCall.calls.length, 0, ">> FAIL: commit-resume-malformed-record: a malformed record must be rejected without any chain read");
      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-malformed-record: a malformed record must be discarded in favour of a fresh commit");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-malformed-record: the malformed record must be discarded, not left around to crash the next run too");
    });
  });

  test("a transient RPC failure reading the chain's current time never crashes resolveResumableCommitment, and doesn't discard the record", async () => {
    await withIsolatedHome(async () => {
      const record = baseRecord();
      writeCommitmentRecord(record);
      const d = makeDotNS();
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return BigInt(1_000);
        if (fn === "maxCommitmentAge") return BigInt(86_400);
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      // Timestamp.Now.getValue() is the one chain read in
      // resolveResumableCommitment that used to run outside any try/catch —
      // an RPC drop here (a known flake class in this repo) used to
      // propagate straight out, crashing commitAndRegister instead of
      // degrading to "don't resume this run".
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => { throw new Error("RPC dropped mid-request"); } } } } } };

      let resumed;
      await assert.doesNotReject(
        async () => { resumed = await d.resolveResumableCommitment(LABEL, false); },
        ">> FAIL: commit-resume-rpc-failure: a transient chain-read failure while checking a resumable commitment must never throw",
      );
      assert.equal(resumed, null, ">> FAIL: commit-resume-rpc-failure: an unverifiable stored commitment must not be resumed this run");
      // A transient RPC failure is NOT evidence the stored record itself is
      // bad — unlike every discard branch above (mismatch, corrupt hash,
      // never-landed, expired, stale pricing), which explicitly clears the
      // record, this path must leave it untouched for a later run to retry
      // once the RPC recovers.
      assert.deepEqual(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), record, ">> FAIL: commit-resume-rpc-failure: the record must be left in place, not discarded, on a transient failure");
    });
  });

  test("state file cannot be created: degrades to today's behaviour, deploy still completes", async () => {
    await withIsolatedHome(async (tmp) => {
      let stateDir;
      if (process.platform === "darwin") stateDir = path.join(tmp, "Library", "Application Support", "polkadot-app-deploy");
      else if (process.platform === "win32") stateDir = path.join(tmp, "AppData", "Local", "polkadot-app-deploy");
      else stateDir = path.join(tmp, ".local", "state", "polkadot-app-deploy");
      fs.mkdirSync(path.dirname(stateDir), { recursive: true });
      fs.writeFileSync(stateDir, "not a directory"); // blocks mkdirSync(dir, {recursive:true})

      const d = makeDotNS();
      wireHappyPathSpies(d);

      await assert.doesNotReject(
        () => d.commitAndRegister(LABEL, false),
        ">> FAIL: commit-resume-write-failure: an unwritable state dir must never fail the deploy — persistence is a resumability aid, not a requirement",
      );
      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-write-failure: the deploy must still commit");
      assert.equal(d.finalizeRegistration.calls.length, 1, ">> FAIL: commit-resume-write-failure: the deploy must still finalize registration — today's behaviour, unresumable but not broken");
    });
  });

  test("resolveStateDir() itself throwing never crashes commitAndRegister: register proceeds via a fresh, unresumable commit (#1412 code review)", async () => {
    await withThrowingStateDirResolution(async () => {
      const d = makeDotNS();
      wireHappyPathSpies(d);
      d.contractCall = spy(async (_addr, _abi, fn) => {
        throw new Error(`contractCall(${fn}) should not be reached — no stored record can even be looked up when the state dir can't be resolved`);
      });

      await assert.doesNotReject(
        () => d.commitAndRegister(LABEL, false),
        ">> FAIL: run-state-never-throw: a state-dir resolution failure (e.g. os.homedir() throwing in a container with no passwd entry) must never crash register() — it must degrade to an unresumable fresh commit, exactly like pre-#1412 behaviour",
      );
      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: run-state-never-throw: the deploy must still commit");
      assert.equal(d.finalizeRegistration.calls.length, 1, ">> FAIL: run-state-never-throw: the deploy must still finalize registration");
    });
  });

  test("bare-revert timing race still gets its one-shot fresh retry when there is no stored commitment", async () => {
    await withIsolatedHome(async () => {
      const d = makeDotNS();
      let attempt = 0;
      d.generateCommitment = spy(async () => ({
        commitment: COMMITMENT_HASH,
        registration: { label: LABEL, owner: OWNER, secret: SECRET, reserved: false },
      }));
      d.submitCommitment = spy(async () => {});
      d.waitForCommitmentAge = spy(async () => {});
      d.getPriceAndValidate = spy(async () => ({ priceWei: 0n, requiredStatus: 0, userStatus: 0, message: "" }));
      d.finalizeRegistration = spy(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Contract execution would revert during register ... bare-revert (empty 0x).");
      });


      await d.commitAndRegister(LABEL, false);

      // #1659: was "exactly one FRESH-commitment retry" (generateCommitment 2).
      // A fresh commit over a still-valid commitment is a double commit
      // (CommitResume NoDoubleCommitValid); the retry now reuses the same
      // commitment. The property kept: exactly one retry, which reaches register.
      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-barerevert-retry: a timing bare-revert must retry with the SAME commitment while it is still valid, not commit fresh");
      assert.equal(d.submitCommitment.calls.length, 1, ">> FAIL: commit-resume-barerevert-retry: the retry must not send a second commit tx");
      assert.equal(d.waitForCommitmentAge.calls.length, 2, ">> FAIL: commit-resume-barerevert-retry: the retry must re-check the commitment's age/validity");
      assert.equal(d.finalizeRegistration.calls.length, 2, ">> FAIL: commit-resume-barerevert-retry: the retry must actually reach finalizeRegistration a second time");
      assert.equal(d.finalizeRegistration.calls[1][0].secret, SECRET, ">> FAIL: commit-resume-barerevert-retry: the retry must reveal the same commitment");
    });
  });

  test("resume-decision does not consume the bare-revert retry budget: an expired resume AND a subsequent timing race both get handled", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(baseRecord());
      const d = makeDotNS();
      const commitTimestamp = 1_000;
      const maxAge = 100;
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return BigInt(commitTimestamp);
        if (fn === "maxCommitmentAge") return BigInt(maxAge);
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => BigInt((commitTimestamp + 200) * 1000) } } } } }; // expired

      let registerAttempt = 0;
      d.generateCommitment = spy(async () => ({
        commitment: COMMITMENT_HASH,
        registration: { label: LABEL, owner: OWNER, secret: SECRET, reserved: false },
      }));
      d.submitCommitment = spy(async () => {});
      d.waitForCommitmentAge = spy(async () => {});
      d.getPriceAndValidate = spy(async () => ({ priceWei: 0n, requiredStatus: 0, userStatus: 0, message: "" }));
      d.finalizeRegistration = spy(async () => {
        registerAttempt += 1;
        if (registerAttempt === 1) throw new Error("Contract execution would revert during register ... bare-revert (empty 0x).");
      });


      await d.commitAndRegister(LABEL, false);

      // The expired-resume discard must not have been counted as the one
      // allowed bare-revert retry: the commit that follows (now a re-commit
      // of the expired hash) still gets its own bare-revert retry when IT races.
      // #1659: the expired record is now revived (same hash re-committed), not
      // replaced, and the race retry reuses it too: no commitment is generated.
      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: commit-resume-budget: the expired record is re-committed, and its race retry reuses it");
      assert.equal(d.submitCommitment.calls.length, 1, ">> FAIL: commit-resume-budget: one re-commit of the expired hash, none for the race retry");
      assert.equal(d.finalizeRegistration.calls.length, 2, ">> FAIL: commit-resume-budget: the retry after the fresh commit must actually run");
    });
  });

  test("bare-revert retry whose commitment expired meanwhile re-commits the SAME hash, never a second commitment (#1659)", async () => {
    await withIsolatedHome(async () => {
      const d = makeDotNS();
      wireHappyPathSpies(d);
      let waits = 0;
      d.waitForCommitmentAge = spy(async () => { if (++waits === 2) throw new Error("Commitment has expired (chain.now=9, expired at=8). A fresh commit cycle is needed."); });
      let attempt = 0;
      d.finalizeRegistration = spy(async () => { if (++attempt === 1) throw new Error("Contract execution would revert during register ... bare-revert (empty 0x)."); });

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-retry-dead: a commitment that expired during the retry is re-committed, not replaced by a second one");
      assert.deepEqual(d.submitCommitment.calls.map((c) => c[0]), [COMMITMENT_HASH, COMMITMENT_HASH], ">> FAIL: commit-resume-retry-dead: the same hash is committed again after it expired");
      assert.equal(d.finalizeRegistration.calls.length, 2, ">> FAIL: commit-resume-retry-dead: exactly two register tries");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null);
    });
  });

  test("a re-commit rejected while the stored commitment is expired discards the record, so the next run commits fresh (#1659)", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(baseRecord());
      const d = makeDotNS();
      wireHappyPathSpies(d);
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return 1_000n;
        if (fn === "maxCommitmentAge") return 100n;
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => 1_200_000n } } } } }; // expired
      d.submitCommitment = spy(async () => { throw new Error("Contract execution would revert during commit (flags=1)"); }); // a controller that refuses the revive

      await assert.rejects(() => d.commitAndRegister(LABEL, false), /would revert during commit/);
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-revive-refused: an expired record the chain refuses to revive is dead and must go, or every later run fails the same way");
    });
  });

  test("a revive of an expired commitment that times out (tx may still be pending) keeps the record (#1659)", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(baseRecord());
      const d = makeDotNS();
      wireHappyPathSpies(d);
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return 1_000n;
        if (fn === "maxCommitmentAge") return 100n;
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => 1_200_000n } } } } }; // expired
      d.submitCommitment = spy(async () => { throw new Error("commit timed out after 120000ms"); });

      await assert.rejects(() => d.commitAndRegister(LABEL, false), /timed out/);
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL)?.secret, SECRET,
        ">> FAIL: commit-resume-revive-timeout: a timed-out revive may still land; discarding its record would abandon it (the #1659 bug)");
    });
  });

  test("a second bare-revert with the same commitment fails after two register tries, never commits fresh (#1659)", async () => {
    await withIsolatedHome(async () => {
      const d = makeDotNS();
      wireHappyPathSpies(d);
      d.finalizeRegistration = spy(async () => { throw new Error("Contract execution would revert during register ... bare-revert (empty 0x)."); });

      await assert.rejects(() => d.commitAndRegister(LABEL, false), /bare-revert/);
      assert.equal(d.finalizeRegistration.calls.length, 2, ">> FAIL: commit-resume-double-revert: a real double revert must fail after two register tries");
      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-double-revert: a rival or collision must never trigger a fresh commit over the still-valid one");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL)?.secret, SECRET, ">> FAIL: commit-resume-double-revert: the still-valid record stays for the next run");
    });
  });

  test("a fresh commit persists the record BEFORE submitCommitment runs; a non-bare-revert finalize failure leaves it on disk for the next run to resume", async () => {
    await withIsolatedHome(async () => {
      const d = makeDotNS();
      let onDiskWhenSubmitRan = "not called yet";
      d.generateCommitment = spy(async () => ({
        commitment: COMMITMENT_HASH,
        registration: { label: LABEL, owner: OWNER, secret: SECRET, reserved: false },
      }));
      d.submitCommitment = spy(async () => {
        // Read from INSIDE submitCommitment's own call — proves
        // persistCommitmentRecord already ran by this point, not just
        // "sometime before this test's own assertions run afterward".
        onDiskWhenSubmitRan = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL);
      });
      d.waitForCommitmentAge = spy(async () => {});
      d.getPriceAndValidate = spy(async () => ({ priceWei: 0n, requiredStatus: 0, userStatus: 0, message: "" }));
      // A plain network/RPC-shaped error, NOT a bare-revert — commitAndRegister's
      // one retry slot is reserved for bare-revert-shaped timing races, so
      // this must propagate uncaught, simulating the process crashing here.
      d.finalizeRegistration = spy(async () => { throw new Error("network error: connection reset"); });

      await assert.rejects(
        () => d.commitAndRegister(LABEL, false),
        /connection reset/,
        ">> FAIL: commit-resume-persist-order: a non-timing finalize failure must propagate, not be swallowed or silently retried",
      );

      assert.notEqual(onDiskWhenSubmitRan, "not called yet", ">> FAIL: commit-resume-persist-order: submitCommitment must actually have run");
      assert.notEqual(onDiskWhenSubmitRan, null, ">> FAIL: commit-resume-persist-order: the commitment record must already be on disk BEFORE submitCommitment runs, not written afterward — a crash during/after submit must still leave a resumable record");
      assert.equal(onDiskWhenSubmitRan.commitment, COMMITMENT_HASH, ">> FAIL: commit-resume-persist-order: the persisted record's commitment hash must match what was actually committed");

      const onDiskAfterCrash = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL);
      assert.notEqual(onDiskAfterCrash, null, ">> FAIL: commit-resume-persist-order: the record must survive a non-timing finalize failure — this simulates the process crashing before finishing, which is the whole scenario #1412 exists for");

      // The next invocation must resume it, not pay for a fresh commitment.
      d.generateCommitment = spy(async () => { throw new Error("generateCommitment should not run — this must resume the crashed commitment"); });
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return BigInt(1_000);
        if (fn === "maxCommitmentAge") return BigInt(86_400);
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => BigInt(1_100 * 1000) } } } } };
      d.finalizeRegistration = spy(async () => {});

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: commit-resume-persist-order: the second invocation must resume the crashed commitment, not pay for a fresh one");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-persist-order: the record must be cleared once the resumed registration finally finalizes");
    });
  });
});

// ---------------------------------------------------------------------------
// v0.6.0 / v0.5.8-rc1 priced-profile resume (needsPricingBeforeCommit) — both
// live envs run v0.6.0 in production (per Sentry), and this path had zero
// test coverage before #1412 code review flagged it.
// ---------------------------------------------------------------------------
const PRICED_PROTOCOL = "v0.6.0";
const PRICED_MAX_PRICE_WEI = 123_456_789_000_000_000n;
const PRICED_PRICING_VERSION = 7n;

function pricedRecord(overrides = {}) {
  return baseRecord({
    protocol: PRICED_PROTOCOL,
    maxPrice: PRICED_MAX_PRICE_WEI.toString(),
    pricingVersion: PRICED_PRICING_VERSION.toString(),
    ...overrides,
  });
}

describe("DotNS.commitAndRegister — v0.6.0 priced-profile resume (#1412)", () => {
  test("a fresh commit's maxPrice/pricingVersion survive a real disk round-trip and rehydrate as bigints, byte-equal to the original, on resume", async () => {
    await withIsolatedHome(async () => {
      const d = makeDotNS({ protocol: PRICED_PROTOCOL });
      d.getPriceAndValidate = spy(async () => ({ priceWei: PRICED_MAX_PRICE_WEI, requiredStatus: 0, userStatus: 0, message: "", pricingVersion: PRICED_PRICING_VERSION }));
      d.generateCommitment = spy(async (label, reverse, pricing) => ({
        commitment: COMMITMENT_HASH,
        registration: { label, owner: OWNER, secret: SECRET, reserved: reverse, maxPrice: pricing.priceWei, pricingVersion: pricing.pricingVersion },
      }));
      d.submitCommitment = spy(async () => {});
      d.waitForCommitmentAge = spy(async () => {});
      // Non-timing failure: propagates uncaught, leaving the just-persisted
      // record on disk exactly as if the process had crashed right here.
      d.finalizeRegistration = spy(async () => { throw new Error("network error: connection reset"); });

      await assert.rejects(() => d.commitAndRegister(LABEL, false), /connection reset/, ">> FAIL: commit-resume-priced-roundtrip: the first attempt's non-timing failure must propagate");

      const onDisk = loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL);
      assert.equal(typeof onDisk.maxPrice, "string", ">> FAIL: commit-resume-priced-roundtrip: maxPrice must be persisted as a decimal STRING — bigint has no native JSON representation");
      assert.equal(onDisk.maxPrice, PRICED_MAX_PRICE_WEI.toString(), ">> FAIL: commit-resume-priced-roundtrip: the persisted maxPrice string must match the committed bigint's decimal value");
      assert.equal(onDisk.pricingVersion, PRICED_PRICING_VERSION.toString(), ">> FAIL: commit-resume-priced-roundtrip: the persisted pricingVersion string must match the committed bigint's decimal value");

      // Second attempt: resumes the ON-DISK record. Stub the chain so every
      // resume validity check (hash match, pricingVersion match, price
      // ceiling not exceeded) passes, and prove it's a genuine resume by
      // making generateCommitment throw if it's ever called again.
      d.generateCommitment = spy(async () => { throw new Error("generateCommitment should not run on a resume"); });
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return BigInt(1_000);
        if (fn === "maxCommitmentAge") return BigInt(86_400);
        if (fn === "pricingVersion") return PRICED_PRICING_VERSION;
        if (fn === "priceWithCheckAtVersion") return { price: PRICED_MAX_PRICE_WEI };
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => BigInt(1_100 * 1000) } } } } };
      let finalized = null;
      d.finalizeRegistration = spy(async (registration) => { finalized = registration; });

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: commit-resume-priced-roundtrip: the second attempt must resume, not commit fresh");
      assert.equal(typeof finalized.maxPrice, "bigint", ">> FAIL: commit-resume-priced-roundtrip: the rehydrated registration's maxPrice must be a real bigint, not a string");
      assert.equal(finalized.maxPrice, PRICED_MAX_PRICE_WEI, ">> FAIL: commit-resume-priced-roundtrip: the rehydrated maxPrice must equal the ORIGINAL committed value, byte-for-byte");
      assert.equal(finalized.pricingVersion, PRICED_PRICING_VERSION, ">> FAIL: commit-resume-priced-roundtrip: the rehydrated pricingVersion must equal the ORIGINAL committed value, byte-for-byte");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-priced-roundtrip: the record must be cleared once the resumed registration finalizes successfully");
    });
  });

  test("resuming a valid priced commitment calls getPriceAndValidate exactly once (for the finalize price, not for the resume validity check)", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(pricedRecord());
      const d = makeDotNS({ protocol: PRICED_PROTOCOL });
      wireHappyPathSpies(d);
      d.getPriceAndValidate = spy(async () => ({ priceWei: PRICED_MAX_PRICE_WEI, requiredStatus: 0, userStatus: 0, message: "", pricingVersion: PRICED_PRICING_VERSION }));
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return BigInt(1_000);
        if (fn === "maxCommitmentAge") return BigInt(86_400);
        if (fn === "pricingVersion") return PRICED_PRICING_VERSION;
        if (fn === "priceWithCheckAtVersion") return { price: PRICED_MAX_PRICE_WEI };
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => BigInt(1_100 * 1000) } } } } };

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 0, ">> FAIL: commit-resume-priced-getprice-once: must resume, not commit fresh");
      assert.equal(d.getPriceAndValidate.calls.length, 1, ">> FAIL: commit-resume-priced-getprice-once: resuming a priced profile must call getPriceAndValidate exactly once (for the finalize price), not zero times or twice");
    });
  });

  test("a stale pricingVersion discards the record, fresh commit paid for", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(pricedRecord());
      const d = makeDotNS({ protocol: PRICED_PROTOCOL });
      wireHappyPathSpies(d);
      d.getPriceAndValidate = spy(async () => ({ priceWei: PRICED_MAX_PRICE_WEI, requiredStatus: 0, userStatus: 0, message: "", pricingVersion: PRICED_PRICING_VERSION + 1n }));
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return BigInt(1_000);
        if (fn === "maxCommitmentAge") return BigInt(86_400);
        if (fn === "pricingVersion") return PRICED_PRICING_VERSION + 1n; // moved on since the commitment was made
        throw new Error(`unexpected contractCall: ${fn}`); // priceWithCheckAtVersion must NOT be reached — pricingVersion mismatch short-circuits first
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => BigInt(1_100 * 1000) } } } } };

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-priced-stale-version: a stale pricingVersion must be discarded in favour of a fresh commit");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-priced-stale-version: the stale-pricing record must be discarded, not left around");
    });
  });

  test("pricingVersion matches but the live price now exceeds the committed maxPrice ceiling: discarded, fresh commit paid for", async () => {
    await withIsolatedHome(async () => {
      writeCommitmentRecord(pricedRecord());
      const d = makeDotNS({ protocol: PRICED_PROTOCOL });
      wireHappyPathSpies(d);
      d.getPriceAndValidate = spy(async () => ({ priceWei: PRICED_MAX_PRICE_WEI * 2n, requiredStatus: 0, userStatus: 0, message: "", pricingVersion: PRICED_PRICING_VERSION }));
      d.contractCall = spy(async (_addr, _abi, fn) => {
        if (fn === "makeCommitment") return COMMITMENT_HASH;
        if (fn === "commitments") return BigInt(1_000);
        if (fn === "maxCommitmentAge") return BigInt(86_400);
        if (fn === "pricingVersion") return PRICED_PRICING_VERSION; // unchanged
        if (fn === "priceWithCheckAtVersion") return { price: PRICED_MAX_PRICE_WEI * 2n }; // live price now HIGHER than what was committed
        throw new Error(`unexpected contractCall: ${fn}`);
      });
      d.clientWrapper = { client: { query: { Timestamp: { Now: { getValue: async () => BigInt(1_100 * 1000) } } } } };

      await d.commitAndRegister(LABEL, false);

      assert.equal(d.generateCommitment.calls.length, 1, ">> FAIL: commit-resume-priced-price-exceeded: a live price above the committed maxPrice ceiling must be discarded in favour of a fresh commit");
      assert.equal(loadCommitmentRecord(ENV_ID, TLD, OWNER, LABEL), null, ">> FAIL: commit-resume-priced-price-exceeded: the record must be discarded, not left around to fail the same way at reveal");
    });
  });
});
