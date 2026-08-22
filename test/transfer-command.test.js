import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTransferRecipient } from "../dist/commands/transfer.js";
import { zeroAddress } from "viem";

test("resolveTransferRecipient: explicit 0x passes through", async () => {
  const addr = "0x" + "ab".repeat(20);
  assert.equal(await resolveTransferRecipient(addr, { sessionH160: "0xPROD" }), addr);
});

test("resolveTransferRecipient: no --to falls back to session H160", async () => {
  assert.equal(await resolveTransferRecipient(undefined, { sessionH160: "0xPROD" }), "0xPROD");
});

test("resolveTransferRecipient: no --to and no session throws", async () => {
  await assert.rejects(
    () => resolveTransferRecipient(undefined, { sessionH160: undefined }),
    /no recipient/i,
  );
});

test("resolveTransferRecipient: non-0x --to is rejected", async () => {
  await assert.rejects(
    () => resolveTransferRecipient("alice.dot", { sessionH160: "0xPROD" }),
    /must be a 0x H160/,
  );
});

// --to the zero address must be rejected here, before runTransfer ever opens
// a chain connection — DotNS.transferName/transferSubname guard it too
// (defense in depth against library callers that skip this CLI path), but
// catching it at the CLI boundary means a typo'd --to never even resolves
// environments or connects.
test("resolveTransferRecipient: the zero address is rejected as a burn-guard, not passed through", async () => {
  await assert.rejects(
    () => resolveTransferRecipient(zeroAddress, { sessionH160: "0xPROD" }),
    /zero address/i,
    `>> FAIL: resolveTransferRecipient burn guard: --to ${zeroAddress} must be rejected (it would permanently burn the name), not returned as a valid recipient`,
  );
});

test("resolveTransferRecipient: an uppercase-hex zero address is rejected too (case-insensitive)", async () => {
  const upperZero = "0x" + "0".repeat(40).toUpperCase();
  await assert.rejects(
    () => resolveTransferRecipient(upperZero, { sessionH160: "0xPROD" }),
    /zero address/i,
    `>> FAIL: resolveTransferRecipient burn guard case-insensitivity: --to ${upperZero} must be rejected the same as the lowercase zero address`,
  );
});
