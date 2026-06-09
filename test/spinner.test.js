import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { startSpinner } = await import("../dist/spinner.js");

function fakeStream(isTTY) {
  const writes = [];
  return { isTTY, write: (s) => { writes.push(s); return true; }, writes };
}

describe("startSpinner", () => {
  test("non-TTY prints one static line, no \\r animation", () => {
    const s = fakeStream(false);
    const spin = startSpinner("Doing thing", s);
    spin.stop();
    assert.equal(s.writes.length, 1, ">> FAIL: spinner/non-tty: expected exactly one static write, no frames");
    assert.ok(s.writes[0].includes("Doing thing"), ">> FAIL: spinner/non-tty: static line must include label");
    assert.ok(!s.writes[0].includes("\r"), ">> FAIL: spinner/non-tty: must not emit carriage-return animation");
  });

  test("stop() is idempotent", () => {
    const s = fakeStream(false);
    const spin = startSpinner("X", s);
    spin.stop("done");
    const after = s.writes.length;
    spin.stop("done-again");
    assert.equal(s.writes.length, after, ">> FAIL: spinner/idempotent: second stop() must be a no-op");
  });

  test("TTY render uses carriage return and stop clears the line", () => {
    const s = fakeStream(true);
    const spin = startSpinner("Y", s);
    assert.ok(s.writes.some(w => w.includes("\r") && w.includes("Y")), ">> FAIL: spinner/tty: must \\r-render label");
    spin.stop();
    assert.ok(s.writes[s.writes.length - 1].includes("\r"), ">> FAIL: spinner/tty: stop must clear the line");
  });
});
