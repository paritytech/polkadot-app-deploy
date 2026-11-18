import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { blake2b } from "@noble/hashes/blake2b";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { CarWriter } from "@ipld/car/writer";
import { blockSizeViolation, carInspection, storeCarBlocks } from "../dist/store-blocks.js";
import { bulletinSelection, createCID, deploy, deployFlagConflict, resolveBulletinEndpoints, setBulletinEndpoints, setBulletinStack, startPresenceFloor, storeChunkedContent } from "../dist/deploy.js";
import { DEFAULT_STACK_ID, readShippedStack } from "../dist/stacks.js";
import { __setDeployRootSpanForTest } from "../dist/telemetry.js";
import { manifestAssetUpload } from "../dist/manifest/publish.js";
import { presenceFloorActive, _resetProbeSession, _bypassMetadataCheckForTest } from "../dist/chunk-probe.js";
import { buildCliFlagsSummary } from "../dist/bug-report.js";
import { NonRetryableError } from "../dist/errors.js";

const RAW = 0x55;
const DAG_PB = 0x70;
const BLAKE2B = 0xb220;
const SHA256 = 0x12;
const KECCAK = 0x1b;
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "bin/polkadot-app-deploy");

function chainCid(bytes, codec, hashCode) {
  const digest = hashCode === KECCAK ? keccak_256(bytes) : hashCode === SHA256 ? sha256(bytes) : blake2b(bytes, { dkLen: 32 });
  return CID.createV1(codec, createDigest(hashCode, digest));
}

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

const ITEM_A = bytesOf("item a: raw blake2b");
const ITEM_B = bytesOf("item b: dag-pb sha2");
const ITEM_C = bytesOf("item c: raw keccak");
const CID_A = chainCid(ITEM_A, RAW, BLAKE2B);
const CID_B = chainCid(ITEM_B, DAG_PB, SHA256);
const CID_C = chainCid(ITEM_C, RAW, KECCAK);
const BLOCK_A = { cid: CID_A, bytes: ITEM_A };
const BLOCK_B = { cid: CID_B, bytes: ITEM_B };
const BLOCK_C = { cid: CID_C, bytes: ITEM_C };

async function carOf(blocks, roots = []) {
  const { writer, out } = CarWriter.create(roots);
  const parts = [];
  const collected = (async () => { for await (const part of out) parts.push(part); })();
  for (const block of blocks) await writer.put(block);
  await writer.close();
  await collected;
  return Buffer.concat(parts);
}

async function* streamOf(bytes, size = 7) {
  for (let start = 0; start < bytes.length; start += size) yield bytes.subarray(start, start + size);
}

function fakeChain({ present = [], failStoreCall } = {}) {
  const calls = { stores: [] };
  return {
    calls,
    dependencies: {
      cidOf: (bytes, format) => createCID(bytes, format.codec, format.hashCode).toString(),
      store: async (blocks) => {
        if (failStoreCall === calls.stores.length + 1) throw new Error("Connection lost and max reconnections (5) exhausted");
        calls.stores.push(blocks.map((block) => ({
          cid: block.cid,
          format: block.format,
          cidOfBytes: chainCid(block.bytes, block.format.codec, block.format.hashCode).toString(),
        })));
        return new Set(blocks.map((block) => block.cid).filter((cid) => present.includes(cid)));
      },
    },
  };
}

function runBin(args, timeoutMs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "polkadot-app-deploy-store-blocks-"));
  const env = { ...process.env, HOME: home, PAD_TELEMETRY: "0", PAD_UPDATE_CHECK: "0" };
  delete env.IPFS_CID;
  delete env.MNEMONIC;
  delete env.BULLETIN_RPC;
  return spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: "utf8", env, timeout: timeoutMs });
}

const CID_OF = (bytes, format) => createCID(bytes, format.codec, format.hashCode).toString();
const VERSION_0_BLOCK = { cid: CID.createV0(createDigest(SHA256, sha256(ITEM_B))), bytes: ITEM_B };

const ok = () => ({ subscribe({ next }) { setImmediate(() => next({ type: "inBestBlock", ok: true })); return { unsubscribe() {} }; } });

function recordingApi(submitted) {
  return {
    query: { System: { Number: { getValue: async () => 1000 } } },
    apis: { BulletinTransactionStorageApi: {
      account_authorization: async () => ({ expires_at: 9_999_999, bytes_allowance: 100_000_000n, bytes_used: 0n, bytes_permanent_used: 0n, transactions_allowance: 1000, transactions_used: 0 }),
      can_store: async () => true,
    } },
    tx: { TransactionStorage: { store_with_cid_config: ({ cid, data }) => {
      submitted.push({ codec: Number(cid.codec), hashing: cid.hashing.type, data });
      return { createSubmitAndWatch: () => ok() };
    } } },
  };
}

async function quietly(operation) {
  const original = console.log;
  console.log = () => {};
  try { return await operation(); } finally { console.log = original; }
}

describe("storeCarBlocks", () => {
  test("every block is stored as it is, with the codec and hashing of its CID, so the CID stays the same", async () => {
    const chain = fakeChain();
    const outcome = await storeCarBlocks(streamOf(await carOf([BLOCK_A, BLOCK_B, BLOCK_C])), chain.dependencies);
    const stored = chain.calls.stores.flat();
    assert.deepEqual(stored.map(({ cid, format }) => [cid, format]), [
      [CID_A.toString(), { codec: RAW, hashCode: BLAKE2B }],
      [CID_B.toString(), { codec: DAG_PB, hashCode: SHA256 }],
      [CID_C.toString(), { codec: RAW, hashCode: KECCAK }],
    ], ">> FAIL: store blocks: a block would be stored with another codec or hashing, so its CID would change");
    for (const block of stored) {
      assert.equal(block.cidOfBytes, block.cid, ">> FAIL: store blocks: the stored bytes would get another CID");
    }
    assert.deepEqual(outcome, { stored: [CID_A, CID_B, CID_C].map(String), alreadyStored: [] });
  });

  test("blocks the chain already has are reported apart from the stored ones", async () => {
    const chain = fakeChain({ present: [CID_B.toString()] });
    const outcome = await storeCarBlocks(streamOf(await carOf([BLOCK_A, BLOCK_B, BLOCK_C])), chain.dependencies);
    assert.deepEqual(outcome, { stored: [CID_A, CID_C].map(String), alreadyStored: [CID_B.toString()] },
      ">> FAIL: store blocks: the summary must say which blocks were skipped because the chain has them");
  });

  test("the CAR roots do not limit which blocks are stored", async () => {
    const chain = fakeChain();
    const outcome = await storeCarBlocks(streamOf(await carOf([BLOCK_A, BLOCK_B], [CID_B])), chain.dependencies);
    assert.deepEqual(outcome.stored, [CID_A, CID_B].map(String),
      ">> FAIL: store blocks: every block of the CAR must be stored, not only the roots");
  });

  test("a block that Bulletin cannot store is rejected by number before it is sent", async () => {
    const sha512 = CID.createV1(RAW, createDigest(0x13, new Uint8Array(64)));
    const inline = bytesOf("inline data");
    const identity = CID.createV1(RAW, createDigest(0x00, inline));
    const empty = new Uint8Array(0);
    const cases = [
      [{ cid: sha512, bytes: bytesOf("x") }, /block 2: .*hashing 0x13/, "Bulletin has no hashing for it"],
      [VERSION_0_BLOCK, /block 2: .*is a CIDv0.*CIDv1 only.*--cid-version 1/, "Bulletin nodes do not answer a request for a CIDv0, so the block could not be fetched under its own name"],
      [{ cid: identity, bytes: inline }, /block 2: .*identity CID.*Remove this entry/, "a skip would leave out a block that the caller listed, without notice"],
      [{ cid: chainCid(empty, RAW, BLAKE2B), bytes: empty }, /block 2: .*is empty/, "the chain rejects empty data, so the run would fail after earlier blocks were stored"],
    ];
    for (const [block, reason, why] of cases) {
      const chain = fakeChain();
      await assert.rejects(
        async () => storeCarBlocks(streamOf(await carOf([BLOCK_A, block])), chain.dependencies),
        (error) => error instanceof NonRetryableError && reason.test(error.message),
        `>> FAIL: store blocks: ${block.cid} must be rejected with its reason: ${why}`,
      );
      assert.deepEqual(chain.calls.stores, [], ">> FAIL: store blocks: nothing may reach the chain from a CAR with an unusable block in the same group");
    }
  });

  test("bytes that do not match their CID are rejected", async () => {
    const chain = fakeChain();
    await assert.rejects(
      async () => storeCarBlocks(streamOf(await carOf([{ cid: CID_A, bytes: ITEM_B }])), chain.dependencies),
      (error) => error instanceof NonRetryableError && /do not match/.test(error.message),
      ">> FAIL: store blocks: wrong bytes would be stored under a CID that does not describe them",
    );
  });

  test("input that is not a CAR file, or a CAR without blocks, is rejected without retry", async () => {
    const chain = fakeChain();
    await assert.rejects(() => storeCarBlocks(streamOf(bytesOf("not a car")), chain.dependencies),
      (error) => error instanceof NonRetryableError && /not a CAR file/.test(error.message));
    await assert.rejects(async () => storeCarBlocks(streamOf(await carOf([])), chain.dependencies),
      (error) => error instanceof NonRetryableError && /contains no blocks/.test(error.message),
      ">> FAIL: store blocks: an empty run must not count as success");
  });

  test("a block listed twice is stored once", async () => {
    const chain = fakeChain();
    const outcome = await storeCarBlocks(streamOf(await carOf([BLOCK_A, BLOCK_A])), chain.dependencies);
    assert.deepEqual(outcome.stored, [CID_A.toString()], ">> FAIL: store blocks: a repeated block would be stored twice");
  });

  test("blocks are stored in groups that keep memory bounded, each block once and in order", async () => {
    const sized = [1, 2, 3, 4, 5].map((index) => bytesOf(`group block ${index}`));
    const blocks = sized.map((bytes) => ({ cid: chainCid(bytes, RAW, BLAKE2B), bytes }));
    const chain = fakeChain();
    await storeCarBlocks(streamOf(await carOf(blocks)), { ...chain.dependencies, groupBytes: sized[0].length * 2 });
    assert.ok(chain.calls.stores.length >= 3, `>> FAIL: store groups: ${chain.calls.stores.length} store call(s) for 5 blocks over a 2-block limit`);
    assert.deepEqual(chain.calls.stores.flat().map((block) => block.cid), blocks.map((block) => block.cid.toString()),
      ">> FAIL: store groups: a block was lost, repeated or reordered");
  });

  test("a store failure ends the run with that error after earlier groups were stored", async () => {
    const chain = fakeChain({ failStoreCall: 2 });
    await assert.rejects(
      async () => storeCarBlocks(streamOf(await carOf([BLOCK_A, BLOCK_B, BLOCK_C])), { ...chain.dependencies, groupBytes: 1 }),
      /max reconnections/,
      ">> FAIL: store blocks: a connection failure must fail the run so the caller retries",
    );
    assert.deepEqual(chain.calls.stores.map((group) => group.map((block) => block.cid)), [[CID_A.toString()]]);
  });
});

describe("CAR check before the upload", () => {
  test("summary of a valid CAR: distinct blocks, bytes and largest block", async () => {
    const inspection = await carInspection(streamOf(await carOf([BLOCK_A, BLOCK_B, BLOCK_A, BLOCK_C])), CID_OF);
    assert.deepEqual(inspection, {
      blocks: 3,
      bytes: ITEM_A.length + ITEM_B.length + ITEM_C.length,
      largestBlock: { cid: CID_A.toString(), position: 1, bytes: ITEM_A.length },
    }, ">> FAIL: CAR check: the size check after the connection depends on the largest block of the whole file");
  });

  test("unusable block at the end of the CAR: rejected with its number", async () => {
    await assert.rejects(
      async () => carInspection(streamOf(await carOf([BLOCK_A, BLOCK_C, VERSION_0_BLOCK])), CID_OF),
      (error) => error instanceof NonRetryableError && /block 3: .*is a CIDv0/.test(error.message),
      ">> FAIL: CAR check: a check that stops early would let the upload store the first blocks and then fail",
    );
    await assert.rejects(
      async () => carInspection(streamOf(await carOf([BLOCK_A, { cid: CID_C, bytes: ITEM_B }])), CID_OF),
      (error) => error instanceof NonRetryableError && /block 2: the bytes do not match/.test(error.message),
    );
  });

  test("block size limit: the chain's maximum is allowed, one byte more is not", () => {
    const inspection = { blocks: 2, bytes: 3000, largestBlock: { cid: CID_A.toString(), position: 2, bytes: 2048 } };
    assert.equal(blockSizeViolation(inspection, 2048), null,
      ">> FAIL: size check: an item of exactly the chain's maximum exists on chain and must be storable again");
    const violation = blockSizeViolation(inspection, 2047);
    assert.ok(violation instanceof NonRetryableError, ">> FAIL: size check: the chain rejects the block on every attempt, so a retry cannot help");
    assert.match(violation.message, new RegExp(`block 2: ${CID_A} has 2048 bytes.*at most 2047 bytes`),
      ">> FAIL: size check: the error must say which block is over which limit");
  });
});

describe("storeChunkedContent with a format per chunk", () => {
  test("each chunk goes on chain with its own codec and hashing", async () => {
    const submitted = [];
    let nonce = 100;
    await quietly(() => storeChunkedContent([ITEM_A, ITEM_B, ITEM_C], {
      client: { destroy() {} },
      unsafeApi: recordingApi(submitted),
      signer: () => {},
      ss58: SS58,
      fetchNonce: async () => nonce++,
      chunkFormats: [
        { codec: RAW, hashCode: BLAKE2B },
        { codec: DAG_PB, hashCode: SHA256 },
        { codec: RAW, hashCode: KECCAK },
      ],
      skipRootStore: true,
    }));
    assert.deepEqual(submitted.map(({ codec, hashing }) => [codec, hashing]),
      [[RAW, "Blake2b256"], [DAG_PB, "Sha2_256"], [RAW, "Keccak256"]],
      ">> FAIL: chunk formats: a chunk was stored with another codec or hashing, so its CID changed");
    assert.deepEqual(submitted.map(({ codec, hashing, data }) => chainCid(data, codec, { Blake2b256: BLAKE2B, Sha2_256: SHA256, Keccak256: KECCAK }[hashing]).toString()),
      [CID_A, CID_B, CID_C].map(String), ">> FAIL: chunk formats: stored blocks would get other CIDs than the originals");
  });

  test("without formats, chunks keep the raw sha2-256 layout of every existing deploy", async () => {
    const submitted = [];
    let nonce = 100;
    await quietly(() => storeChunkedContent([ITEM_A], {
      client: { destroy() {} },
      unsafeApi: recordingApi(submitted),
      signer: () => {},
      ss58: SS58,
      fetchNonce: async () => nonce++,
      skipRootStore: true,
    }));
    assert.deepEqual(submitted.map(({ codec, hashing }) => [codec, hashing]), [[RAW, "Sha2_256"]],
      ">> FAIL: chunk formats: default chunks must keep their CIDs");
  });
});

describe("createCID", () => {
  test("keccak-256 CIDs equal the chain's, so keccak content can be stored again", () => {
    assert.equal(createCID(ITEM_C, RAW, KECCAK).toString(), CID_C.toString(),
      ">> FAIL: createCID: keccak-256 content would be stored under another CID");
  });
});

describe("--store-blocks and --force-store flag checks", () => {
  test("--store-blocks needs a path and excludes flags that it would ignore or that change the stored bytes", () => {
    assert.equal(deployFlagConflict({ storeBlocks: "" }), "--store-blocks needs a path");
    assert.match(deployFlagConflict({ storeBlocks: "b.car", inputCar: "x.car" }), /--input-car/);
    assert.match(deployFlagConflict({ storeBlocks: "b.car", password: "secret" }), /--password/,
      ">> FAIL: store flags: encrypted bytes would get another CID");
    assert.match(deployFlagConflict({ storeBlocks: "b.car", dumpCar: true }), /--dump-car/);
    assert.match(deployFlagConflict({ storeBlocks: "b.car", config: "polkadot-app-deploy.config.ts" }), /--config does not apply/,
      ">> FAIL: store flags: a manifest config would be ignored without notice");
    assert.match(deployFlagConflict({ storeBlocks: "b.car" }, "bafytest"), /IPFS_CID does not apply/,
      ">> FAIL: store flags: IPFS_CID would be ignored without notice");
    assert.equal(deployFlagConflict({ storeBlocks: "b.car", forceStore: true }), null);
    assert.equal(deployFlagConflict({ config: "x.ts" }, "bafytest"), null,
      ">> FAIL: store flags: the checks must not change normal deploys");
  });

  test("--force-store excludes IPFS_CID, which uploads nothing", () => {
    assert.match(deployFlagConflict({ forceStore: true }, "bafytest"), /IPFS_CID does not apply/,
      ">> FAIL: refresh flag: a refresh that uploads nothing would report success");
    assert.equal(deployFlagConflict({ forceStore: true }), null);
  });

  test("flag rules in deploy() for library callers", async () => {
    const previous = process.env.IPFS_CID;
    process.env.IPFS_CID = "bafytest";
    try {
      await assert.rejects(deploy("./dist", "my-app.dot", { forceStore: true }),
        (error) => error instanceof NonRetryableError && /IPFS_CID does not apply/.test(error.message),
        ">> FAIL: library rules: a refresh that uploads nothing would report success to a caller that does not use the CLI");
    } finally {
      if (previous === undefined) delete process.env.IPFS_CID;
      else process.env.IPFS_CID = previous;
    }
    await assert.rejects(deploy("blocks.car", null, { storeBlocks: "blocks.car", password: "secret" }),
      (error) => error instanceof NonRetryableError && /--password/.test(error.message),
      ">> FAIL: library rules: a library caller would get the blocks stored without the encryption it requested");
  });

  test("missing --store-blocks path in the CLI", () => {
    const result = runBin(["--store-blocks"]);
    assert.equal(result.status, 1, `>> FAIL: store CLI: wrong exit code ${result.status}`);
    assert.match(result.stderr, /--store-blocks needs a path/,
      ">> FAIL: store CLI: without a path the CLI must stop, not start a normal deploy");
  });

  test("--store-blocks followed by another flag: missing path", () => {
    const result = runBin(["--store-blocks", "--force-store", "blocks.car"]);
    assert.equal(result.status, 1, `>> FAIL: store CLI: wrong exit code ${result.status}`);
    assert.match(result.stderr, /--store-blocks needs a path/,
      ">> FAIL: store CLI: --force-store would be read as the CAR path, and the error would be about a build directory");
  });

  test("unusable CAR with an unreachable --rpc: exit code 78 before any connection", async () => {
    const carFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "polkadot-app-deploy-unusable-car-")), "blocks.car");
    fs.writeFileSync(carFile, await carOf([BLOCK_A, VERSION_0_BLOCK]));
    const result = runBin(["--store-blocks", carFile, "--rpc", "ws://127.0.0.1:9"], 60_000);
    assert.equal(result.status, 78,
      `>> FAIL: store CLI: the CAR must be checked before the chain connection, and an unusable CAR cannot succeed on a retry (status ${result.status}): ${result.stderr.slice(-300)}`);
    assert.match(result.stderr, /block 2: .*is a CIDv0/);
  });

  test("the CLI rejects a build directory or domain next to --store-blocks", () => {
    const missingCar = path.join(os.tmpdir(), "polkadot-app-deploy-missing-blocks.car");
    const result = runBin(["--store-blocks", missingCar, "my-app.dot"]);
    assert.equal(result.status, 1, `>> FAIL: store CLI: wrong exit code ${result.status}`);
    assert.match(result.stderr, /takes no build directory or domain/,
      ">> FAIL: store CLI: --store-blocks never registers a domain, so the CLI must say so");
  });

  test("the CLI takes --force-store without a value and checks the CAR path", () => {
    const missingCar = path.join(os.tmpdir(), "polkadot-app-deploy-missing-blocks.car");
    const result = runBin(["--force-store", "--store-blocks", missingCar]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not exist/,
      ">> FAIL: store CLI: --force-store must not take the next argument, and the CAR path must be checked");
    assert.doesNotMatch(result.stderr, /domain required/);
  });

  test("help documents both flags", () => {
    const result = runBin(["--help"]);
    assert.match(result.stdout, /polkadot-app-deploy --store-blocks <file\.car>/, ">> FAIL: store CLI: help omits --store-blocks");
    assert.match(result.stdout, /--force-store\s+Store content again/, ">> FAIL: store CLI: help omits --force-store");
    assert.match(result.stdout, /With --rpc or BULLETIN_RPC, only that endpoint is used/,
      ">> FAIL: store CLI: BULLETIN_RPC also removes the --env endpoints, and the help must say so");
  });

  test("the bug report lists both flags without the CAR path", () => {
    const summary = buildCliFlagsSummary({ storeBlocks: "/secret/blocks.car", forceStore: true });
    assert.match(summary, /--store-blocks <set>/);
    assert.match(summary, /--force-store/);
    assert.doesNotMatch(summary, /secret/, ">> FAIL: bug report: a local path must not leave the machine");
  });
});

describe("--store-blocks endpoints", () => {
  test("an exclusive --rpc drops the environment endpoints", () => {
    assert.deepEqual(resolveBulletinEndpoints(["wss://public-a", "wss://public-b"], "ws://127.0.0.1:9944", true), ["ws://127.0.0.1:9944"],
      ">> FAIL: store endpoints: a failing --rpc must not fall back to another chain");
    assert.deepEqual(resolveBulletinEndpoints(["wss://public-a"], "ws://127.0.0.1:9944"), ["ws://127.0.0.1:9944", "wss://public-a"],
      ">> FAIL: store endpoints: normal deploys keep the environment endpoints as fallback");
    assert.deepEqual(resolveBulletinEndpoints(["wss://public-a"], undefined, true), ["wss://public-a"]);
  });

  test("an exclusive --rpc drops the stack's Bulletin endpoints", () => {
    const saved = bulletinSelection;
    const stack = readShippedStack(DEFAULT_STACK_ID);
    try {
      setBulletinStack(stack, "ws://127.0.0.1:9944", { exclusiveRpc: true });
      assert.deepEqual(bulletinSelection.endpoints, ["ws://127.0.0.1:9944"],
        ">> FAIL: store endpoints: a failing --rpc must not fall back to the stack's Bulletin endpoints");
      assert.equal(bulletinSelection.stack, stack, ">> FAIL: store endpoints: the exclusive --rpc must still be checked against the stack's genesis");
      setBulletinStack(stack, "ws://127.0.0.1:9944");
      assert.deepEqual(bulletinSelection.endpoints, ["ws://127.0.0.1:9944", ...stack.chains.Bulletin.rpc.filter((e) => e !== "ws://127.0.0.1:9944")],
        ">> FAIL: store endpoints: normal deploys keep the stack's Bulletin endpoints as fallback");
    } finally {
      if (saved.stack) setBulletinStack(saved.stack, undefined, { noAutoAuthorize: !saved.autoAuthorize });
      else setBulletinEndpoints(saved.endpoints);
    }
  });
});

describe("--store-blocks and --force-store deploy flow", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/deploy.ts"), "utf8");

  test("--store-blocks uses only the --rpc endpoint", () => {
    assert.match(source, /setBulletinStack\(stack, options\.rpc, \{[^}]*exclusiveRpc: options\.storeBlocks !== undefined[^}]*\}\)/,
      ">> FAIL: store flow: the blocks would be stored on the stack's Bulletin chain when --rpc fails");
  });

  test("--store-blocks returns before the DotNS preflight", () => {
    assert.match(source, /try \{\s*if \(options\.storeBlocks\) \{[\s\S]{0,1800}?return \{[^}]*storedBlocks,[^}]*\};\s*\}\s*\/\/ Check domain ownership before uploading anything/,
      ">> FAIL: store flow: the DotNS preflight would check or register a random name");
  });

  test("--store-blocks order: CAR check, chain connection, block size check, upload", () => {
    assert.match(source, /if \(options\.storeBlocks\) \{[\s\S]{0,500}?await carFileInspection\(carFile\);[\s\S]{0,500}?provider = await reconnect\(\);[\s\S]{0,500}?blockSizeViolation\(inspection, [\s\S]{0,900}?storeBlocksFromCar\(carFile, storageProvider\)/,
      ">> FAIL: store flow: an unusable or oversize block would stop the run after earlier blocks were stored");
    assert.match(source, /blockSizeViolation\(inspection, await provider\.unsafeApi\.constants\.TransactionStorage\.MaxTransactionSize\(\)\)/,
      ">> FAIL: store flow: a limit from the tool would reject an item that this chain stores, or accept one that it rejects");
  });

  test("--store-blocks probes every block, so blocks on chain are skipped unless --force-store is set", () => {
    assert.match(source, /skipCids: new Set\(blocks\.map\(\(block\) => block\.cid\)\)/,
      ">> FAIL: store flow: blocks already on chain would be stored again without --force-store");
  });

  test("--force-store sets the presence floor in both upload paths", () => {
    const starts = source.match(/if \(options\.forceStore\) await startPresenceFloor\(provider\.client\);/g) ?? [];
    assert.equal(starts.length, 2, ">> FAIL: refresh flow: one upload path would skip content that the chain already has");
    assert.match(source, /setPresenceFloor\(bestBlock \+ 1\);/,
      ">> FAIL: refresh flow: an old entry would confirm a store that never reached the chain");
  });

  test("--force-store probes manifest-trusted chunks again", () => {
    assert.match(source, /if \(prevManifest\?\.chunks && !presenceFloorActive\(\)\)/,
      ">> FAIL: refresh flow: chunks trusted from the previous manifest would be skipped");
  });

  test("the presence floor is cleared when the deploy ends", () => {
    assert.match(source, /setPresenceFloor\(null\);/,
      ">> FAIL: refresh flow: a floor left behind would change the next deploy in the same process");
  });

  test("floor block in telemetry: a number, one above the best block", async () => {
    const attributes = new Map();
    __setDeployRootSpanForTest({ setAttribute: (key, value) => attributes.set(key, value) });
    try {
      await quietly(() => startPresenceFloor({ _request: async () => ({ number: "0x64" }) }));
    } finally {
      __setDeployRootSpanForTest(null);
      _resetProbeSession();
    }
    assert.strictEqual(attributes.get("deploy.force_store.floor_block"), 101,
      ">> FAIL: refresh telemetry: a text value cannot be compared or aggregated as a block number");
  });
});

const CONTENT_HASH_KEY_HEX_LENGTH = 2 + 2 * (16 + 16 + 16 + 32);

function contentEntry(block) {
  const value = Buffer.alloc(8);
  value.writeUInt32LE(block, 0);
  return "0x" + value.toString("hex");
}

function manifestStorage({ entryBlock, bestBlock, failure }) {
  const stores = [];
  const client = {
    destroy() {},
    _request: async (method, params) => {
      if (method === "chain_getHeader") return { number: "0x" + bestBlock.toString(16) };
      if (method !== "state_queryStorageAt") return null;
      const changes = params[0].map((key) => [key, key.length === CONTENT_HASH_KEY_HEX_LENGTH ? contentEntry(entryBlock) : null]);
      return [{ changes }];
    },
  };
  const store_with_cid_config = (call) => ({
    createSubmitAndWatch: () => ({
      subscribe({ next, error }) {
        stores.push(call);
        setImmediate(() => (failure ? error(failure) : next({ type: "inBestBlock", ok: true })));
        return { unsubscribe() {} };
      },
    }),
  });
  const provider = { client, unsafeApi: { tx: { TransactionStorage: { store_with_cid_config } } }, signer: () => {}, ss58: SS58 };
  return { stores, reconnect: async () => provider };
}

describe("--force-store in the product manifest step", () => {
  const ICON = bytesOf("product icon");

  function upload(storage, forceStore) {
    _resetProbeSession();
    _bypassMetadataCheckForTest();
    return manifestAssetUpload(storage.reconnect, { iconBytes: ICON, executables: [], configDir: repoRoot, forceStore });
  }

  test("manifest icon from before the run: one store with --force-store, none without", async () => {
    const forced = manifestStorage({ entryBlock: 5, bestBlock: 100 });
    const { iconCid } = await upload(forced, true);
    assert.equal(iconCid, createCID(ICON, RAW, BLAKE2B).toString());
    assert.equal(forced.stores.length, 1,
      ">> FAIL: manifest refresh: the icon would expire on its old date while the refreshed site content stays");
    const plain = manifestStorage({ entryBlock: 5, bestBlock: 100 });
    await upload(plain, false);
    assert.equal(plain.stores.length, 0,
      ">> FAIL: manifest refresh: without --force-store the manifest step must skip content that the chain already has");
  });

  test("manifest icon from this run: no second store", async () => {
    const storage = manifestStorage({ entryBlock: 101, bestBlock: 100 });
    await upload(storage, true);
    assert.equal(storage.stores.length, 0, ">> FAIL: manifest refresh: content stored during the run would be stored twice");
  });

  test("presence floor after the manifest uploads: none, also after a failure", async () => {
    await upload(manifestStorage({ entryBlock: 5, bestBlock: 100 }), true);
    assert.equal(presenceFloorActive(), false,
      ">> FAIL: manifest refresh: an active floor after the uploads would change the next upload in the same process");
    await assert.rejects(upload(manifestStorage({ entryBlock: 5, bestBlock: 100, failure: new Error("store failure") }), true));
    assert.equal(presenceFloorActive(), false,
      ">> FAIL: manifest refresh: an active floor after a failure would change the next upload in the same process");
  });

  test("--force-store from the CLI to the manifest step", () => {
    const cli = fs.readFileSync(bin, "utf8");
    assert.match(cli, /await publishManifest\(\{[\s\S]{0,900}?forceStore: !!flags\.forceStore/,
      ">> FAIL: manifest refresh: the CLI would refresh the site content and leave the manifest assets on their old expiry");
  });
});
