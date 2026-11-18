import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeChunks,
  setPresenceFloor,
  _resetProbeSession,
  _bypassMetadataCheckForTest,
} from "../dist/chunk-probe.js";

const CID = "bafkreidrchwf76kulasoplap3fnd4azwli3djcjp6umuimfgw6h4ojxyme";
const CONTENT_HASH_KEY_HEX_LENGTH = 2 + 2 * (16 + 16 + 16 + 32);

function entryValue(block) {
  const value = Buffer.alloc(8);
  value.writeUInt32LE(block, 0);
  value.writeUInt32LE(0, 4);
  return "0x" + value.toString("hex");
}

function chainWithEntryAt(block) {
  return {
    _request: async (method, params) => {
      if (method !== "state_queryStorageAt") return null;
      const changes = params[0].map((key) => [
        key,
        key.length === CONTENT_HASH_KEY_HEX_LENGTH ? entryValue(block) : null,
      ]);
      return [{ changes }];
    },
  };
}

async function probeWithFloor(entryBlock, floor) {
  _resetProbeSession();
  _bypassMetadataCheckForTest();
  setPresenceFloor(floor);
  try {
    const [result] = await probeChunks([CID], { client: chainWithEntryAt(entryBlock) });
    return result;
  } finally {
    setPresenceFloor(null);
  }
}

test("presence floor: an entry from before the run counts as absent", async () => {
  const result = await probeWithFloor(919, 920);
  assert.equal(result.present, false,
    ">> FAIL: presence floor: the old entry would confirm a store that never reached the chain, and the content would expire");
});

test("presence floor: an entry stored during the run counts as present", async () => {
  const result = await probeWithFloor(920, 920);
  assert.equal(result.present, true, ">> FAIL: presence floor: a store that reached the chain would be sent again");
  assert.equal(result.block, 920);
});

test("presence floor: without a floor an old entry counts as present", async () => {
  const result = await probeWithFloor(1, null);
  assert.equal(result.present, true, ">> FAIL: presence floor: uploads without --force-store must keep skipping chunks already on chain");
});
