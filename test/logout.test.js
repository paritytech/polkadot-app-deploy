// test/logout.test.js — unit tests for src/commands/logout.ts (formatLogout)
import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("formatLogout", async () => {
    const { formatLogout } = await import("../dist/commands/logout.js");

    test("disconnecting → surfaces address", () => {
        const out = formatLogout({ step: "disconnecting", address: "5XYZ" });
        assert.ok(out.includes("5XYZ"), ">> FAIL: logout: disconnecting should include address");
    });

    test("success → signed-out confirmation", () => {
        const out = formatLogout({ step: "success", address: "5XYZ" });
        assert.ok(out.includes("5XYZ"), ">> FAIL: logout: success should include address");
        assert.match(out, /signed out/i, ">> FAIL: logout: success should say signed out");
    });

    test("partial → surfaces reason", () => {
        const out = formatLogout({ step: "partial", address: "5XYZ", reason: "ws timeout" });
        assert.ok(out.includes("ws timeout"), ">> FAIL: logout: partial should include reason");
    });

    test("error → surfaces message", () => {
        const out = formatLogout({ step: "error", message: "boom" });
        assert.ok(out.includes("boom"), ">> FAIL: logout: error should include message");
    });
});
