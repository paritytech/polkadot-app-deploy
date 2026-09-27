/**
 * test/car-section1-dedup.test.js
 *
 * Regression coverage for the Phase A / Phase B section-1 dedup bug in
 * `buildOrderedCar` (src/merkle.ts). Root cause (confirmed via Sentry span
 * 900105899e6fb08e): the `placed` CID set used to skip already-anchored
 * stable files is only consulted/updated inside the `prevStableOrder` loop.
 * The final `newStable` loop — the one that runs on Phase A, where
 * `prevStableOrder` is undefined on a first deploy — pushes every stable
 * file unconditionally, so two or more paths sharing identical content
 * (same fileCid) are packed into section 1 more than once.
 *
 * Phase B (anchored on Phase A's stableOrder) already dedups correctly,
 * because the anchored loop's `placed` check catches the repeat CID. That
 * asymmetry is exactly the bug: Phase A uploads a bigger, differently
 * chunked section 1 than Phase B re-derives, so Phase A's chunks orphan on
 * chain and the "chunks saved" telemetry goes negative.
 *
 * These tests build fixtures directly on disk (no buildFixture helper --
 * we need exact control over which paths share byte-identical content and
 * over file sizes relative to CHUNK_SIZE_TARGET, 1 MiB) and drive
 * merkleizeWithStableOrder from the built dist/, same as neighbouring
 * merkle tests in test/test.js.
 *
 * Fixture bytes are deterministic (Buffer.alloc fills, not crypto.randomBytes)
 * so a content-dependent failure reproduces byte-for-byte across runs and CI.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { merkleizeWithStableOrder } from "../dist/merkle.js";

// All fixture files use a STABLE_EXTENSIONS extension (see src/manifest.ts)
// so classifyFile routes them into section 1 regardless of framework.
const EXT = ".png";

// Six-file fixture: 5 distinct-content files plus one duplicate pair
// (dup1.png / dup2.png hold byte-identical content), with sizes chosen so
// packSection's greedy bin-packing against the 1 MiB CHUNK_SIZE_TARGET
// (src/chunker.ts:20) needs one fewer chunk once the duplicate is dropped --
// confirmed empirically against dist/chunker.js: reverting the fix makes
// Phase A pack 4 section-1 chunks against Phase B's 3. If these sizes ever
// stop producing that count difference (e.g. after a chunker change), size
// them up until they do -- an equal-count-but-different-content failure is
// a much weaker signal that the property is still tested.
const DUPLICATE_FIXTURE_FILES = [
  { name: "a", size: 700_000, fillByte: 0xaa },
  { name: "b", size: 600_000, fillByte: 0xbb },
  { name: "c", size: 500_000, fillByte: 0xcc },
  { name: "e", size: 50_000, fillByte: 0xee },
  { name: "dup1", size: 480_000, fillByte: 0xdd },
  { name: "dup2", size: 480_000, fillByte: 0xdd }, // same fill -> identical bytes -> identical fileCid
];

// Control fixture: same shape (same names/sizes table + loop), but every
// file has distinct content. Guards against over-deduping (e.g. accidentally
// deduping by path or by size instead of by fileCid).
const DISTINCT_FIXTURE_FILES = [
  { name: "a", size: 700_000, fillByte: 0xaa },
  { name: "b", size: 600_000, fillByte: 0xbb },
  { name: "c", size: 500_000, fillByte: 0xcc },
  { name: "e", size: 50_000, fillByte: 0xee },
  { name: "f1", size: 480_000, fillByte: 0xdd },
  { name: "f2", size: 480_000, fillByte: 0xff }, // distinct fill -> distinct fileCid
];

function buildFixture(dir, files) {
  // Reuse the SAME buffer instance for entries sharing a fill byte + size --
  // this is what makes dup1.png / dup2.png byte-identical (and content-addressed
  // to the same fileCid), not two independent buffers that happen to match.
  const buffersByKey = new Map();
  for (const { name, size, fillByte } of files) {
    const key = `${fillByte}:${size}`;
    if (!buffersByKey.has(key)) buffersByKey.set(key, Buffer.alloc(size, fillByte));
    fs.writeFileSync(path.join(dir, `${name}${EXT}`), buffersByKey.get(key));
  }
  // A volatile anchor so the fixture isn't section-1-only (mirrors real deploys).
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
}

describe("buildOrderedCar section-1 dedup (Phase A vs Phase B, issue: negative chunks-saved)", () => {
  // Shared, read-only fixtures: merkleizeWithStableOrder only reads directoryPath,
  // so both the duplicate-content fixture and the all-distinct control fixture are
  // built once here and reused across every test that needs them.
  let dupDir;
  let distinctDir;

  before(() => {
    dupDir = fs.mkdtempSync(path.join(os.tmpdir(), "car-dedup-"));
    buildFixture(dupDir, DUPLICATE_FIXTURE_FILES);
    distinctDir = fs.mkdtempSync(path.join(os.tmpdir(), "car-dedup-control-"));
    buildFixture(distinctDir, DISTINCT_FIXTURE_FILES);
  });

  after(() => {
    fs.rmSync(dupDir, { recursive: true });
    fs.rmSync(distinctDir, { recursive: true });
  });

  test("Phase A and Phase B pack an identical section 1 when stable files share content", async () => {
    // Phase A: first deploy, no prevStableOrder (undefined).
    const phaseA = await merkleizeWithStableOrder(dupDir, undefined, { useKubo: false });
    // Phase B: anchored on Phase A's own stableOrder, as deploy.ts does.
    const phaseB = await merkleizeWithStableOrder(dupDir, phaseA.stableOrder, { useKubo: false });

    assert.deepEqual(
      phaseA.section1ChunkCids,
      phaseB.section1ChunkCids,
      `Phase A and Phase B must pack identical section-1 chunks. ` +
      `Phase A: ${phaseA.section1ChunkCids.length} chunks, Phase B: ${phaseB.section1ChunkCids.length} chunks. ` +
      `>> FAIL: buildOrderedCar section-1 dedup: Phase A emits duplicate-content files twice while Phase B dedups them, so the two phases disagree on section-1 packing`
    );
    assert.equal(
      phaseA.sectionSizes.section1,
      phaseB.sectionSizes.section1,
      `Phase A section1=${phaseA.sectionSizes.section1}B vs Phase B section1=${phaseB.sectionSizes.section1}B. ` +
      `>> FAIL: buildOrderedCar section-1 dedup: Phase A section-1 byte size must match Phase B once both dedup identically`
    );
  });

  test("stableOrder contains no duplicate CIDs", async () => {
    const phaseA = await merkleizeWithStableOrder(dupDir, undefined, { useKubo: false });
    const unique = new Set(phaseA.stableOrder);
    assert.equal(
      unique.size,
      phaseA.stableOrder.length,
      `stableOrder has ${phaseA.stableOrder.length} entries but only ${unique.size} unique CIDs. ` +
      `>> FAIL: buildOrderedCar section-1 dedup: stableOrder (manifest stableBlockOrder) must not carry repeated CIDs`
    );
  });

  test("control: an all-distinct fixture still round-trips identically Phase A -> Phase B", async () => {
    const phaseA = await merkleizeWithStableOrder(distinctDir, undefined, { useKubo: false });
    const phaseB = await merkleizeWithStableOrder(distinctDir, phaseA.stableOrder, { useKubo: false });

    assert.deepEqual(
      phaseA.section1ChunkCids,
      phaseB.section1ChunkCids,
      `>> FAIL: buildOrderedCar section-1 dedup: an all-distinct-content fixture regressed A vs B parity (over-deduping guard)`
    );
    // No dedup should have occurred here: every file has unique content, so
    // stableOrder should carry as many entries as there are stable files.
    assert.equal(
      new Set(phaseA.stableOrder).size,
      phaseA.stableOrder.length,
      ">> FAIL: buildOrderedCar section-1 dedup: control fixture stableOrder unexpectedly lost entries"
    );
  });

  test("deduped content is still reachable through both paths and present exactly once in the CAR", async () => {
    const phaseA = await merkleizeWithStableOrder(dupDir, undefined, { useKubo: false });

    // Both duplicate paths still resolve to the same content-addressed CID:
    // deduping section-1 packing does not touch the unixfs dag-pb tree, so
    // dup1.png and dup2.png both still point at the one CID present in the CAR.
    const dup1Cid = phaseA.fileCids.get(`dup1${EXT}`);
    const dup2Cid = phaseA.fileCids.get(`dup2${EXT}`);
    assert.ok(dup1Cid, "dup1.png must have a fileCid");
    assert.equal(dup1Cid, dup2Cid, "dup1.png and dup2.png must share the same content-addressed CID");

    // stableOrder (post-fix) carries that CID exactly once...
    const occurrencesInStableOrder = phaseA.stableOrder.filter((c) => c === dup1Cid).length;
    assert.equal(
      occurrencesInStableOrder,
      1,
      `>> FAIL: buildOrderedCar section-1 dedup: shared CID appears ${occurrencesInStableOrder} times in stableOrder, expected exactly 1`
    );

    // ...and the shared file's own blocks appear in blockOrder exactly once
    // (not once per path) -- i.e. deduping dropped the repeat emission, not
    // the content itself.
    const occurrencesInBlockOrder = phaseA.blockOrder.filter((c) => c === dup1Cid).length;
    assert.equal(
      occurrencesInBlockOrder,
      1,
      `>> FAIL: buildOrderedCar section-1 dedup: shared file's block CID appears ${occurrencesInBlockOrder} times in blockOrder, expected exactly 1 (content must be packed once, not dropped or duplicated)`
    );
  });

  test("a pre-fix manifest whose stableBlockOrder carries duplicate CIDs still deploys correctly", async () => {
    // Every real consumer's NEXT deploy after this fix ships hits this path: their
    // on-chain manifest was written by the OLD (buggy) code, so its stableBlockOrder
    // already contains duplicate CIDs (confirmed live -- scarcity-console-test's
    // on-chain manifest has 13 entries / 10 unique). deploy.ts passes that array
    // straight in as prevStableOrder on the next deploy. The anchor loop must
    // tolerate the repeats it's handed, not just avoid creating new ones.
    const phaseA = await merkleizeWithStableOrder(dupDir, undefined, { useKubo: false });

    // Simulate a pre-fix manifest: take a real stableOrder and reintroduce a
    // duplicate CID, exactly as the old buggy Phase A would have produced.
    const dupCid = phaseA.stableOrder[0];
    const staleManifestStableOrder = [dupCid, ...phaseA.stableOrder];
    assert.equal(
      new Set(staleManifestStableOrder).size,
      staleManifestStableOrder.length - 1,
      ">> FAIL: buildOrderedCar section-1 dedup: test setup bug, staleManifestStableOrder must contain exactly one duplicate"
    );

    const nextDeploy = await merkleizeWithStableOrder(dupDir, staleManifestStableOrder, { useKubo: false });

    // No crash, no dropped file: every stable file in the fixture is still present.
    const expectedStableFileCount = new Set(
      DUPLICATE_FIXTURE_FILES.map((f) => `${f.fillByte}:${f.size}`)
    ).size;
    assert.equal(
      nextDeploy.stableOrder.length,
      expectedStableFileCount,
      `nextDeploy.stableOrder has ${nextDeploy.stableOrder.length} entries, expected ${expectedStableFileCount} distinct stable files. ` +
      `>> FAIL: buildOrderedCar section-1 dedup: a duplicate-CID prevStableOrder must not drop or duplicate a stable file on the next deploy`
    );

    // Correctly deduped: no repeated CIDs despite the duplicate handed in.
    assert.equal(
      new Set(nextDeploy.stableOrder).size,
      nextDeploy.stableOrder.length,
      `>> FAIL: buildOrderedCar section-1 dedup: nextDeploy.stableOrder must not carry repeated CIDs even when prevStableOrder does`
    );

    // Anchored order is respected: the anchored CID (deduped to one occurrence)
    // is still placed first in section 1, matching prevStableOrder's intent.
    assert.equal(
      nextDeploy.stableOrder[0],
      dupCid,
      `>> FAIL: buildOrderedCar section-1 dedup: the anchored (duplicated-in-input) CID must still lead stableOrder, deduped to a single occurrence`
    );

    // And packing still agrees with a clean Phase A/B run on the same fixture --
    // the stale duplicate in prevStableOrder must not perturb section-1 packing.
    assert.deepEqual(
      nextDeploy.section1ChunkCids,
      phaseA.section1ChunkCids,
      `>> FAIL: buildOrderedCar section-1 dedup: a stale duplicate-CID prevStableOrder must still pack section 1 identically to a clean run`
    );
  });
});
