import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTransferRecipient } from "../dist/commands/transfer.js";

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
