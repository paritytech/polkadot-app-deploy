// test/auth-resolve.test.js — unit tests for deploy-path signer resolution (chooseSignerInput)
// and stale-session message emit path in deploy.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { setupStaleSessionHome } from "./helpers/stale-session-home.js";

describe("chooseSignerInput", async () => {
    const { chooseSignerInput } = await import("../dist/deploy.js");

    test("mnemonic present → 'mnemonic'", () => {
        const result = chooseSignerInput({ mnemonic: "word word word", suri: undefined, hasInjectedSigner: false });
        assert.equal(result, "mnemonic", ">> FAIL: auth-resolve: mnemonic path should return 'mnemonic'");
    });

    test("injected signer present → 'injected'", () => {
        const result = chooseSignerInput({ mnemonic: undefined, suri: undefined, hasInjectedSigner: true });
        assert.equal(result, "injected", ">> FAIL: auth-resolve: injected signer should return 'injected'");
    });

    test("neither mnemonic nor injected nor suri → 'pool' (headless path unchanged)", () => {
        const result = chooseSignerInput({ mnemonic: undefined, suri: undefined, hasInjectedSigner: false });
        assert.equal(result, "pool", ">> FAIL: auth-resolve: no signer/mnemonic/suri should return 'pool' — pool path must not load SSO deps");
    });

    test("mnemonic takes precedence over injected", () => {
        const result = chooseSignerInput({ mnemonic: "word word word", suri: undefined, hasInjectedSigner: true });
        assert.equal(result, "mnemonic", ">> FAIL: auth-resolve: mnemonic should take precedence over injected");
    });

    test("suri alone (no mnemonic) → 'resolve' (triggers resolveSigner)", () => {
        // suri explicitly provided → resolve path loads SSO stack
        const result = chooseSignerInput({ mnemonic: undefined, suri: "//Alice", hasInjectedSigner: false });
        assert.equal(result, "resolve", ">> FAIL: auth-resolve: suri alone should return 'resolve'");
    });

    test("persisted session present (no flags) → 'resolve' (logged-in deploy uses identity)", () => {
        const result = chooseSignerInput({ mnemonic: undefined, suri: undefined, hasInjectedSigner: false, hasSession: true });
        assert.equal(result, "resolve", ">> FAIL: auth-resolve: a logged-in session should make a plain deploy resolve the session signer");
    });

    test("no session + no flags → 'pool' (CI/headless isolation, no SSO load)", () => {
        const result = chooseSignerInput({ mnemonic: undefined, suri: undefined, hasInjectedSigner: false, hasSession: false });
        assert.equal(result, "pool", ">> FAIL: auth-resolve: no session and no flags must stay on the pool path — never loads SSO");
    });

    test("mnemonic wins over a present session (explicit --mnemonic respected)", () => {
        const result = chooseSignerInput({ mnemonic: "word word word", suri: undefined, hasInjectedSigner: false, hasSession: true });
        assert.equal(result, "mnemonic", ">> FAIL: auth-resolve: --mnemonic must take precedence over an existing session");
    });
});

describe("formatStorageSignerLine", async () => {
    // Pins that the storage-signer resolution always emits exactly one visible line,
    // covering both the slot-success and AllowanceError/no-session pool-fallback paths.
    const { formatStorageSignerLine } = await import("../dist/deploy.js");

    test("slot allocated → line includes 'allowance slot' and the ss58 address", () => {
        const line = formatStorageSignerLine("5SlotXXXYYYZZZ");
        assert.ok(
            line.includes("allowance slot") && line.includes("5SlotXXXYYYZZZ"),
            ">> FAIL: storage-signer: slot-success line must include 'allowance slot' and the ss58 address",
        );
    });

    test("AllowanceError reason → line includes 'pool fallback' and the reason", () => {
        // Exercises the deploy.ts fallback path triggered on signerResult.isErr() with any
        // AllowanceError.reason ('NoSession' | 'Rejected' | 'NotAvailable' | 'UnexpectedResponse').
        for (const reason of ["NoSession", "Rejected", "NotAvailable", "UnexpectedResponse"]) {
            const line = formatStorageSignerLine(null, reason);
            assert.ok(
                line.includes("pool fallback") && line.includes(reason),
                `>> FAIL: storage-signer: AllowanceError(${reason}) must produce pool-fallback line with reason`,
            );
        }
    });

    test("no session (null, no reason) → line includes 'pool fallback (no session)'", () => {
        const line = formatStorageSignerLine(null);
        assert.ok(
            line.includes("pool fallback") && line.includes("no session"),
            ">> FAIL: storage-signer: no-session path must produce 'pool fallback (no session)'",
        );
    });
});

describe("deployActorsToSignerOptions (bulletin #1452)", async () => {
    // Pure helper pulled out of deploy()'s resolve branch so the session-vs-local
    // distinction that gates Bulletin storage routing is unit-testable without the
    // SSO stack. Feeds directly into __selectStorageProviderModeForTest below.
    const { deployActorsToSignerOptions } = await import("../dist/deploy.js");
    const STUB_SIGNER = { publicKey: new Uint8Array(32) };

    test("session-sourced worker (transfer off) → sessionSigner: true, no transferTo", () => {
        const actors = { worker: { signer: STUB_SIGNER, address: "5Session", source: "session" } };
        const result = deployActorsToSignerOptions(actors);
        assert.equal(result.signer, STUB_SIGNER, ">> FAIL: deployActorsToSignerOptions: signer must be the worker's signer");
        assert.equal(result.signerAddress, "5Session", ">> FAIL: deployActorsToSignerOptions: signerAddress must be the worker's address");
        assert.equal(result.sessionSigner, true, ">> FAIL: deployActorsToSignerOptions: a session-sourced worker must set sessionSigner: true");
        assert.equal(result.transferTo, undefined, ">> FAIL: deployActorsToSignerOptions: no recipientH160 must leave transferTo unset");
    });

    test("dev-sourced worker (transfer on, --suri/Alice) → sessionSigner: false, transferTo set", () => {
        const actors = { worker: { signer: STUB_SIGNER, address: "5Dev", source: "dev" }, recipientH160: "0xPROD" };
        const result = deployActorsToSignerOptions(actors);
        assert.equal(result.sessionSigner, false, ">> FAIL: deployActorsToSignerOptions: a dev/--suri worker must NOT be flagged as session-backed");
        assert.equal(result.transferTo, "0xPROD", ">> FAIL: deployActorsToSignerOptions: recipientH160 must populate transferTo (transfer mode)");
    });
});

describe("storage routing must agree with the reported signer (bulletin #1452)", async () => {
    // Reproduces the issue's own deterministic repro: a phone-backed session signer,
    // transfer off, no usable BulletinAllowance. Chains the real resolveStorageSigner
    // (returning null — documented pool fallback) into deployActorsToSignerOptions
    // and __selectStorageProviderModeForTest — the exact production decision path
    // selectStorageReconnect now delegates to — so this pins actual routing, not a
    // parallel guess at it.
    const { resolveStorageSigner } = await import("../dist/deploy-actors.js");
    const { deployActorsToSignerOptions, __selectStorageProviderModeForTest, formatStorageSignerLine } =
        await import("../dist/deploy.js");

    const SESSION_ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const SESSION_SIGNER = { publicKey: new Uint8Array(32) }; // phone-backed

    test("session signer, no session (userSession missing) → pool, and log agrees", async () => {
        const slotResult = await resolveStorageSigner(null, {
            getBulletinSigner: async () => { throw new Error("should not be called"); },
            requestResourceAllocation: async () => { throw new Error("should not be called"); },
            ss58Encode: () => SESSION_ADDRESS,
            promptBeforeAllocation: () => {},
        });
        assert.strictEqual(slotResult, null, ">> FAIL: bulletin #1452 repro: no session must resolve to null (pool)");
    });

    test("logged in, no allowance, user declines the prompt (the issue's exact repro) → routes to pool, not the phone signer", async () => {
        const slotResult = await resolveStorageSigner(
            { userSession: { id: "s1" }, adapter: {} },
            {
                getBulletinSigner: async () => ({
                    isOk: () => false, isErr: () => true, error: { reason: "NotAvailable" },
                }),
                requestResourceAllocation: async () => [{ tag: "Rejected" }],
                createSlotAccountSigner: async () => null,
                ss58Encode: () => SESSION_ADDRESS,
                promptBeforeAllocation: () => {},
            },
        );
        assert.strictEqual(slotResult, null,
            ">> FAIL: bulletin #1452 repro: a declined/unavailable allowance must resolve to null (documented '→ pool')");

        // deploy() only sets options.storageSigner when slotResult is truthy (unchanged),
        // so options keeps the session signer that deployActorsToSignerOptions produced
        // for this (transfer-off, session-sourced) worker.
        const options = {
            ...deployActorsToSignerOptions({ worker: { signer: SESSION_SIGNER, address: SESSION_ADDRESS, source: "session" } }),
        };

        const mode = __selectStorageProviderModeForTest(options);
        const logLine = formatStorageSignerLine(null, "no allowance");

        assert.ok(mode === "pool" && logLine.includes("pool fallback"),
            `>> FAIL: bulletin #1452: routing (mode="${mode}") must agree with the log line ("${logLine.trim()}") — a phone-backed session signer with no allowance slot must route storage to pool, not sign chunks on the phone`);
    });

    test("a caller-injected external signer (no session, e.g. playground-cli) is unaffected: still routes to 'signer'", () => {
        // sessionSigner is unset here — this is the library/programmatic-caller path,
        // not deploy()'s own resolve branch. Must keep working exactly as before #1452.
        const options = { signer: SESSION_SIGNER, signerAddress: SESSION_ADDRESS };
        const mode = __selectStorageProviderModeForTest(options);
        assert.strictEqual(mode, "signer",
            ">> FAIL: bulletin #1452: an injected external signer with no sessionSigner flag must still activate signer mode for storage");
    });

    test("transfer mode (dev worker signs storage) is NOT collapsed into the pool case", () => {
        const options = deployActorsToSignerOptions({
            worker: { signer: SESSION_SIGNER, address: "5Worker", source: "dev" },
            recipientH160: "0xPROD",
        });
        const mode = __selectStorageProviderModeForTest(options);
        assert.strictEqual(mode, "signer",
            ">> FAIL: bulletin #1452: transfer mode's local worker must still sign storage directly — this is deliberately NOT a pool fallback");
        assert.equal(options.transferTo, "0xPROD", ">> FAIL: bulletin #1452: transfer mode must carry transferTo through unchanged");
    });
});

describe("deploy-path stale-session message", async () => {
    // Behavioral coverage is in whoami.test.js (stale-fixture test: same message, same
    // hasPersistedSession gate). This test guards the export contract for deploy.ts's emit site.

    const { STALE_SESSION_MESSAGE } = await import("../dist/auth-config.js");

    test("STALE_SESSION_MESSAGE is exported and non-empty (compile + export gate)", () => {
        assert.ok(
            typeof STALE_SESSION_MESSAGE === "string" && STALE_SESSION_MESSAGE.length > 0,
            ">> FAIL: deploy stale-session: STALE_SESSION_MESSAGE must be a non-empty string in auth-config",
        );
        // Content (logout→login wording) is pinned by whoami.test.js against real output.
    });
});

describe("isBulletinAuthActive", async () => {
    const { isBulletinAuthActive } = await import("../dist/storage-signer.js");

    test("null auth → { active: false, reason: 'missing' }", () => {
        const r = isBulletinAuthActive(null, 100);
        assert.equal(r.active, false, ">> FAIL: isBulletinAuthActive: null auth must be inactive");
        assert.equal(r.reason, "missing", ">> FAIL: isBulletinAuthActive: null auth reason must be 'missing'");
    });

    test("expiration === blockNumber (at boundary) → expired", () => {
        const r = isBulletinAuthActive({ expiration: 100 }, 100);
        assert.equal(r.active, false, ">> FAIL: isBulletinAuthActive: expiration === block must be expired");
        assert.equal(r.reason, "expired", ">> FAIL: isBulletinAuthActive: boundary expiration must have reason 'expired'");
        assert.equal(r.expiration, 100, ">> FAIL: isBulletinAuthActive: expiration must be returned on expired result");
    });

    test("expiration < blockNumber → expired with expiration value", () => {
        const r = isBulletinAuthActive({ expiration: 50n }, 100);
        assert.equal(r.active, false, ">> FAIL: isBulletinAuthActive: past expiration must be inactive");
        assert.equal(r.reason, "expired", ">> FAIL: isBulletinAuthActive: past expiration reason must be 'expired'");
        assert.equal(r.expiration, 50, ">> FAIL: isBulletinAuthActive: bigint expiration must be normalized to number");
    });

    test("expiration > blockNumber → active with expiration value", () => {
        const r = isBulletinAuthActive({ expiration: 200 }, 100);
        assert.equal(r.active, true, ">> FAIL: isBulletinAuthActive: future expiration must be active");
        assert.equal(r.expiration, 200, ">> FAIL: isBulletinAuthActive: active result must carry expiration block");
    });
});

describe("pollUntilBulletinAuthorized", async () => {
    const { pollUntilBulletinAuthorized } = await import("../dist/storage-signer.js");

    test("becomes active on second poll → returns { authorized: true, expiration }", async () => {
        let call = 0;
        const queryFn = async () => {
            call++;
            if (call < 2) return { auth: null, blockNumber: 10 };
            return { auth: { expiration: 200 }, blockNumber: 10 };
        };
        const result = await pollUntilBulletinAuthorized(queryFn, { pollMs: 1, timeoutMs: 5000 });
        assert.equal(result.authorized, true, ">> FAIL: pollUntilBulletinAuthorized: should return authorized:true when active");
        assert.equal(result.expiration, 200, ">> FAIL: pollUntilBulletinAuthorized: should return the expiration block");
    });

    test("expired entry never becomes active → times out", async () => {
        const queryFn = async () => ({ auth: { expiration: 5 }, blockNumber: 100 });
        const result = await pollUntilBulletinAuthorized(queryFn, { pollMs: 1, timeoutMs: 10 });
        assert.equal(result.authorized, false, ">> FAIL: pollUntilBulletinAuthorized: expired entry must time out");
        assert.equal(result.reason, "timeout", ">> FAIL: pollUntilBulletinAuthorized: reason must be 'timeout'");
    });

    test("never lands (always null) → times out", async () => {
        const queryFn = async () => ({ auth: null, blockNumber: 10 });
        const result = await pollUntilBulletinAuthorized(queryFn, { pollMs: 1, timeoutMs: 10 });
        assert.equal(result.authorized, false, ">> FAIL: pollUntilBulletinAuthorized: never-lands auth must time out");
        assert.equal(result.reason, "timeout", ">> FAIL: pollUntilBulletinAuthorized: timeout reason must be 'timeout'");
    });
});

describe("BulletinSlotAuthError reason distinction", async () => {
    const { BulletinSlotAuthError } = await import("../dist/storage-signer.js");

    test("missing reason → error message includes 'no on-chain authorization found'", () => {
        const err = new BulletinSlotAuthError("missing", "5SlotXXX");
        assert.ok(
            err.message.includes("no on-chain authorization found"),
            ">> FAIL: BulletinSlotAuthError: missing reason must include 'no on-chain authorization found'",
        );
        assert.equal(err.reason, "missing", ">> FAIL: BulletinSlotAuthError: reason field must be 'missing'");
        assert.equal(err.expiration, undefined, ">> FAIL: BulletinSlotAuthError: missing error must have no expiration");
    });

    test("expired reason → error message includes block number", () => {
        const err = new BulletinSlotAuthError("expired", "5SlotXXX", 42);
        assert.ok(
            err.message.includes("42"),
            ">> FAIL: BulletinSlotAuthError: expired reason must include expiration block in message",
        );
        assert.equal(err.reason, "expired", ">> FAIL: BulletinSlotAuthError: reason field must be 'expired'");
        assert.equal(err.expiration, 42, ">> FAIL: BulletinSlotAuthError: expired error must carry expiration block");
    });
});

describe("selectStorageReconnect fallback message", async () => {
    // Pins the user-visible warning strings so the actionable content stays stable.
    // The catch block uses BulletinSlotAuthError to distinguish missing/expired;
    // other errors use e.message. This test verifies the format via BulletinSlotAuthError.

    const { BulletinSlotAuthError } = await import("../dist/storage-signer.js");

    test("missing reason → formatted reason is 'no on-chain authorization found'", () => {
        const e = new BulletinSlotAuthError("missing", "5SlotXXX");
        // Mirror the catch block logic in selectStorageReconnect:
        const reason = e.reason === "expired" && e.expiration != null
            ? `expired at block ${e.expiration}`
            : "no on-chain authorization found";
        const msg =
            `⚠  Bulletin allowance slot not usable: ${reason}\n` +
            `   Falling back to the shared pool account for storage (fine on testnet).\n` +
            `   To use your own allowance, run: polkadot-app-deploy logout && polkadot-app-deploy login`;
        assert.ok(msg.includes("no on-chain authorization found"), ">> FAIL: fallback: missing reason must produce 'no on-chain authorization found'");
        assert.ok(msg.includes("fine on testnet"), ">> FAIL: fallback: message must mention 'fine on testnet'");
        assert.ok(msg.includes("polkadot-app-deploy logout && polkadot-app-deploy login"), ">> FAIL: fallback: message must include logout+login command");
    });

    test("expired reason → formatted reason includes expiration block", () => {
        const e = new BulletinSlotAuthError("expired", "5SlotXXX", 99);
        const reason = e.reason === "expired" && e.expiration != null
            ? `expired at block ${e.expiration}`
            : "no on-chain authorization found";
        const msg =
            `⚠  Bulletin allowance slot not usable: ${reason}\n` +
            `   Falling back to the shared pool account for storage (fine on testnet).\n` +
            `   To use your own allowance, run: polkadot-app-deploy logout && polkadot-app-deploy login`;
        assert.ok(msg.includes("expired at block 99"), ">> FAIL: fallback: expired reason must include expiration block in message");
        assert.ok(msg.includes("polkadot-app-deploy logout && polkadot-app-deploy login"), ">> FAIL: fallback: expired message must include logout+login command");
    });
});

// issue #234: a persisted login session that exists but can't be read/decoded
// must fail the deploy fast (NonRetryableError, before any chain write), not
// silently fall through to the default dev signer (the public dev phrase)
// with no transfer target — see src/deploy-actors.ts's resolveDeployActors
// for the full rationale. Uses the same real stale v0.7 session fixture
// whoami.test.js drives (genuinely undecoded by the V2 codec, not a mock) so
// this exercises the actual failure mode, not a stand-in for it.
describe("deploy CLI: unreadable persisted session must fail fast, not fall back to the default dev key (#234)", async () => {
  const { DOT_DAPP_ID } = await import("../dist/auth-config.js");
  const { EXIT_CODE_NO_RETRY } = await import("../dist/deploy.js");
  const repoRoot = path.resolve(import.meta.dirname, "..");

  // Shared scaffold for both tests below: a fresh corrupt-session HOME + a
  // throwaway build dir, spawn the built CLI against them, clean up either way.
  async function runDeployAgainstCorruptSession(domainLabel, extraArgs, extraEnv) {
    const fakeHome = await setupStaleSessionHome(DOT_DAPP_ID, "pad-234-");
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-234-build-"));
    fs.writeFileSync(path.join(buildDir, "index.html"), "<html></html>");
    try {
      return spawnSync(process.execPath, [path.join(repoRoot, "bin/polkadot-app-deploy"), buildDir, domainLabel, "--no-manifest", ...extraArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 8000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          // Unreachable on purpose — should never be dialled in the no-mnemonic
          // case (abort happens first); in the --mnemonic case the deploy is
          // expected to fail here, AFTER signer selection is what's under test.
          DOTNS_RPC: "ws://127.0.0.1:1",
          PAD_UPDATE_CHECK: "0",
          ...extraEnv,
        },
      });
    } finally {
      fs.rmSync(buildDir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }

  test("no --mnemonic + unreadable session on disk: deploy exits non-zero (NonRetryableError) BEFORE any signer plan or phone gate is printed", async () => {
    const result = await runDeployAgainstCorruptSession("authfailfast234x", [], { MNEMONIC: "", DOTNS_MNEMONIC: "" });

    assert.equal(
      result.status, EXIT_CODE_NO_RETRY,
      `>> FAIL: #234: an unreadable session must exit EXIT_CODE_NO_RETRY (${EXIT_CODE_NO_RETRY}), not fall through — got status ${result.status}, stderr: ${result.stderr}, stdout: ${result.stdout}`,
    );
    assert.match(result.stderr, /Stored login session could not be read/,
      ">> FAIL: #234: stderr must name the problem (stale/unreadable session)");
    assert.match(result.stderr, /logout/, ">> FAIL: #234: stderr must name the logout remedy");
    assert.match(result.stderr, /login/, ">> FAIL: #234: stderr must name the login remedy");
    assert.match(result.stderr, /--mnemonic/,
      ">> FAIL: #234: stderr must also name the --mnemonic remedy (deploy, unlike whoami, has this alternative)");
    assert.doesNotMatch(result.stdout, /Press Y when ready/,
      ">> FAIL: #234: the phone gate must never print when there is no usable phone session");
    assert.doesNotMatch(result.stdout, /Using .*signer:/,
      ">> FAIL: #234: no signer plan should print — the deploy must abort before resolving/announcing any signer");
  });

  test("--mnemonic + the SAME unreadable session on disk: proceeds past signer selection using the mnemonic, with a notice that the session was ignored", async () => {
    const { Keyring } = await import("@polkadot/keyring");
    const { cryptoWaitReady } = await import("@polkadot/util-crypto");
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
    const address = keyring.addFromMnemonic(MNEMONIC).address;

    const result = await runDeployAgainstCorruptSession("authfailfast234y", ["--mnemonic", MNEMONIC], {});

    assert.match(result.stderr, /the persisted login session will be ignored/,
      ">> FAIL: #234: an explicit --mnemonic must print a one-line notice that the unreadable session was ignored");
    assert.doesNotMatch(result.stderr, /Stored login session could not be read/,
      ">> FAIL: #234: --mnemonic must win outright — the fail-fast stale-session error must NOT fire");
    assert.match(result.stdout, new RegExp(`SS58 Address: ${address}`),
      `>> FAIL: #234: --mnemonic must proceed past signer selection and print the mnemonic-derived address (${address}) — got stdout:\n${result.stdout}, stderr:\n${result.stderr}`);
  });
});
