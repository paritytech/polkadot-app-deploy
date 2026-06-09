import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { importer } from "ipfs-unixfs-importer";
import { CarReader } from "@ipld/car/reader";
import { CarWriter } from "@ipld/car/writer";
import { CID } from "multiformats/cid";
import * as dagPB from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { classifyFile } from "./manifest.js";
import { packSection, type SectionFile } from "./chunker.js";
import { createCID } from "./deploy.js";

export interface MerkleizeResult {
  carBytes: Uint8Array;
  cid: string;
}

// Like MerkleizeResult but also returns block ordering metadata used by the
// incremental-upload-v2 flow. `blockOrder` is the sequence of CIDs written to
// the CAR (section 0 → 1 → 2 order); `stableOrder` is the list of file-level
// CIDs classified as stable (section 1). Threading the previous deploy's
// `stableOrder` back into a new buildOrderedCar anchors unchanged stable files
// at their old section-1 positions, preserving chunk-level dedup across deploys.
export interface MerkleizeStableResult extends MerkleizeResult {
  blockOrder: string[];
  stableOrder: string[];
  chunks: Uint8Array[];
  chunkCids: string[];
  section1ChunkCids: string[];
  sectionSizes: { section0: number; section1: number; section2: number };
  sectionChunkCounts: { section0: number; section1: number; section2: number };
  /** All DAG blocks from the merkleize backend: cid → block bytes. */
  blocks: Map<string, Uint8Array>;
  /** File path → user-facing CID (leaf for single-block, dag-pb root for multi-block). */
  fileCids: Map<string, string>;
}

// Backend-neutral output of either merkleizer (JS or Kubo). buildOrderedCar
// consumes this; classification + ordering logic is identical for both.
export interface MerkleizeOutput {
  rootCid: string;
  blocks: Map<string, Uint8Array>;     // cid → block bytes
  fileBlocks: Map<string, string[]>;   // file path → all blocks for the file in walk order (root, intermediates, leaves)
  fileCids: Map<string, string>;       // file path → user-facing CID (leaf for single-block, dag-pb root for multi-block)
  rootBlockCids: string[];             // dag-pb intermediate + root nodes (always volatile)
  subdirCids: string[];                // dag-pb subdirectory nodes only (subset of rootBlockCids; preserved in encounter order: lex by full path)
}

// blockstore-core's MemoryBlockstore reconstructs every stored CID as a
// raw-codec v1 CID from its multihash on getAll(), losing the original
// codec. Writing those rebuilt CIDs into a CAR indexes DAG-PB blocks
// under raw CIDs, so readers following the advertised DAG-PB root find
// nothing and the DAG is un-walkable (issue #104).
class CidPreservingBlockstore {
  private readonly data = new Map<string, { cid: CID; bytes: Uint8Array }>();

  async put(cid: CID, bytes: Uint8Array): Promise<CID> {
    this.data.set(cid.toString(), { cid, bytes });
    return cid;
  }

  *all(): Iterable<{ cid: CID; bytes: Uint8Array }> {
    yield* this.data.values();
  }

  clear(): void {
    this.data.clear();
  }
}

// Lazy walk so the importer reads one file at a time — the importer drains
// each entry's `content` iterator before advancing, so only the current file's
// bytes live in V8 (blockstore + CAR instead of files + blockstore + CAR).
//
// Entries are sorted by name so the walk is deterministic across filesystems
// (ext4 vs APFS vs CI tmpfs return readdir entries in different orders). The
// sort makes the produced CAR byte-identical for identical content regardless
// of the host machine — load-bearing for incremental-upload-v2 portability.
function* walkDirectoryLazy(dirPath: string, prefix: string = ""): Generator<{ path: string; absolutePath: string }> {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`Directory not found: ${dirPath}`);
    if (code === "ENOTDIR") throw new Error(`Not a directory: ${dirPath}`);
    throw err;
  }
  dirents.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of dirents) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walkDirectoryLazy(fullPath, relativePath);
    } else if (entry.isFile()) {
      yield { path: relativePath, absolutePath: fullPath };
    }
  }
}

// Clear each slot as we copy so V8 can reclaim CarWriter output mid-assembly
// instead of holding every chunk alive until the final buffer is built.
async function collectBytes(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: (Uint8Array | undefined)[] = [];
  let totalLength = 0;
  for await (const chunk of iter) {
    parts.push(chunk);
    totalLength += chunk.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    result.set(part, offset);
    offset += part.length;
    parts[i] = undefined;
  }
  return result;
}

// Walk the DAG starting from a directory root, attributing leaf blocks to
// FULL file paths (including any subdirectories). Mirrors what `ipfs refs
// <fileCid>` does for Kubo but works against any block source.
//
// UnixFS-aware: each dag-pb node's Data field carries the UnixFS metadata
// (Type field), distinguishing directory vs file vs raw nodes. We discriminate
// via UnixFS.unmarshal so subdirectories descend recursively (preserving
// "assets/main.js"-style paths) rather than collapsing to "assets".
//
// Intermediate dag-pb nodes (directories, multi-block file UnixFS roots) land
// in `rootBlockCids` — these are always volatile because their content
// references the leaves' CIDs and changes whenever any leaf changes.
//
// CID codec handling:
//   0x55 (raw)    → leaf
//   0x70 (dag-pb) → directory or multi-block file (disambiguated via UnixFS)
function walkFileBlocks(rootCidStr: string, blocks: Map<string, Uint8Array>): {
  fileBlocks: Map<string, string[]>;
  fileCids: Map<string, string>;
  rootBlockCids: string[];
  subdirCids: string[];
} {
  const fileBlocks = new Map<string, string[]>();
  const fileCids = new Map<string, string>();
  const rootBlockCids: string[] = [];
  const subdirCids: string[] = [];
  const subdirSeen = new Set<string>();
  walkNode(rootCidStr, "", "", blocks, fileBlocks, fileCids, rootBlockCids, subdirCids, subdirSeen, true);
  return { fileBlocks, fileCids, rootBlockCids, subdirCids };
}

function walkNode(
  cidStr: string,
  pathSoFar: string,
  fullDirPath: string,
  blocks: Map<string, Uint8Array>,
  fileBlocks: Map<string, string[]>,
  fileCids: Map<string, string>,
  intermediates: string[],
  subdirCids: string[],
  subdirSeen: Set<string>,
  isRoot: boolean,
): void {
  const cid = CID.parse(cidStr);
  if (cid.code === 0x55) {
    if (pathSoFar) {
      fileBlocks.set(pathSoFar, [cidStr]);
      fileCids.set(pathSoFar, cidStr);
    }
    return;
  }
  if (cid.code !== 0x70) {
    if (pathSoFar) {
      fileBlocks.set(pathSoFar, [cidStr]);
      fileCids.set(pathSoFar, cidStr);
    }
    return;
  }

  const bytes = blocks.get(cidStr);
  if (!bytes) throw new Error(`block ${cidStr} not in block source`);
  intermediates.push(cidStr);

  const node = dagPB.decode(bytes);
  let unixfs: UnixFS | undefined;
  if (node.Data) {
    try { unixfs = UnixFS.unmarshal(node.Data); }
    catch { unixfs = undefined; }
  }

  if (unixfs && unixfs.isDirectory()) {
    if (!isRoot && !subdirSeen.has(cidStr)) {
      subdirCids.push(cidStr);
      subdirSeen.add(cidStr);
    }
    for (const link of node.Links ?? []) {
      const childName = link.Name ?? "";
      const childCid = link.Hash.toString();
      const childPath = pathSoFar ? `${pathSoFar}/${childName}` : childName;
      walkNode(childCid, childPath, childPath, blocks, fileBlocks, fileCids, intermediates, subdirCids, subdirSeen, false);
    }
  } else {
    // Multi-block file: this dag-pb is the file's user-facing CID.
    // Collect root + all intermediate dag-pb nodes + all raw leaves into one
    // ordered list so buildOrderedCar can iterate it without special-casing.
    // Root goes first (pre-order DFS), then intermediates, then leaves.
    const fileBlockList: string[] = [cidStr];
    for (const link of node.Links ?? []) {
      collectFileBlocks(link.Hash.toString(), blocks, fileBlockList);
    }
    if (pathSoFar) {
      fileBlocks.set(pathSoFar, fileBlockList);
      fileCids.set(pathSoFar, cidStr);
    }
  }
}

// Collect all blocks for a multi-block file in pre-order DFS: dag-pb
// intermediates are pushed before their children, raw leaves are pushed as-is.
// Result is a flat ordered list suitable for direct iteration in buildOrderedCar.
function collectFileBlocks(cidStr: string, blocks: Map<string, Uint8Array>, fileBlockList: string[]): void {
  const cid = CID.parse(cidStr);
  if (cid.code === 0x55) { fileBlockList.push(cidStr); return; }
  if (cid.code !== 0x70) { fileBlockList.push(cidStr); return; }
  fileBlockList.push(cidStr); // intermediate dag-pb node, before its children
  const bytes = blocks.get(cidStr);
  if (!bytes) return;
  const node = dagPB.decode(bytes);
  for (const link of node.Links ?? []) {
    collectFileBlocks(link.Hash.toString(), blocks, fileBlockList);
  }
}

// JS backend: importer + in-memory blockstore. Works in WebContainer / browser /
// any Node environment without a Kubo daemon. Higher peak memory than Kubo on
// large directories.
export async function merkleizeJSBackend(directoryPath: string): Promise<MerkleizeOutput> {
  const blockstore = new CidPreservingBlockstore();
  const source = (function* () {
    for (const file of walkDirectoryLazy(directoryPath)) {
      yield {
        path: file.path,
        content: (async function* () {
          yield fs.readFileSync(file.absolutePath);
        })(),
      };
    }
  })();

  let rootCid: CID | undefined;
  for await (const entry of importer(source, blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    wrapWithDirectory: true,
  })) {
    rootCid = entry.cid;
  }
  if (!rootCid) throw new Error("Merkleization produced no root CID");

  const blocks = new Map<string, Uint8Array>();
  for (const { cid, bytes } of blockstore.all()) {
    blocks.set(cid.toString(), bytes);
  }
  blockstore.clear();
  const { fileBlocks, fileCids, rootBlockCids, subdirCids } = walkFileBlocks(rootCid.toString(), blocks);
  return { rootCid: rootCid.toString(), blocks, fileBlocks, fileCids, rootBlockCids, subdirCids };
}

// Kubo backend: invokes the external `ipfs` binary to merkleize and dump the
// CAR, then reads the CAR back to populate the in-memory block map. Single
// CAR dump (one execSync) plus DAG walk — avoids the per-block `ipfs block get`
// overhead that PR #11's earlier prototype paid.
//
// Available only when `ipfs` binary is on PATH; throws otherwise so the caller
// can fall back to the JS backend.
export async function merkleizeKuboBackend(directoryPath: string): Promise<MerkleizeOutput> {
  const carPath = path.join(path.dirname(directoryPath), `${path.basename(directoryPath)}.car`);
  const cidStr = execSync(
    `ipfs add -Q -r --hidden --cid-version=1 --raw-leaves --pin=false "${directoryPath}"`,
    { encoding: "utf-8" }
  ).trim();
  execSync(`ipfs dag export ${cidStr} > "${carPath}"`);

  const carBytes = fs.readFileSync(carPath);
  const reader = await CarReader.fromBytes(carBytes);
  const blocks = new Map<string, Uint8Array>();
  for await (const { cid, bytes } of reader.blocks()) {
    blocks.set(cid.toString(), bytes);
  }
  const { fileBlocks, fileCids, rootBlockCids, subdirCids } = walkFileBlocks(cidStr, blocks);
  return { rootCid: cidStr, blocks, fileBlocks, fileCids, rootBlockCids, subdirCids };
}

// Backend chooser. useKubo=true requires `ipfs` on PATH; caller is responsible
// for verifying via hasIPFS() before passing true.
export async function merkleizeBackend(directoryPath: string, useKubo: boolean, phase?: string): Promise<MerkleizeOutput> {
  const tag = phase ? ` — ${phase}` : '';
  if (useKubo) {
    console.log(`   Merkleizing (Kubo${tag}): ${directoryPath}`);
    return merkleizeKuboBackend(directoryPath);
  }
  console.log(`   Merkleizing (JS${tag}): ${directoryPath}`);
  return merkleizeJSBackend(directoryPath);
}

// Build a CAR from a backend's output, ordering blocks in three sections for
// incremental dedup:
//
//   Section 0 — CAR header + manifest blocks (.bulletin-deploy/manifest.json).
//               Placed first so readers can identify the deploy.
//
//   Section 1 — Stable files: files classified as stable (content-hashed names,
//               stable extensions, etc.). `prevStableOrder` (file CIDs) anchors
//               unchanged stable files at their previous positions, preserving
//               chunk-level dedup across deploys. New stable files appended by
//               size desc + CID asc.
//
//   Section 2 — Volatile blocks: root dir dag-pb + subdir dag-pbs + all
//               volatile files. The root/subdir nodes change on every deploy;
//               grouping them in section 2 avoids polluting section 1 chunks.
//
// The returned `blockOrder` is populated with all block CIDs in section order
// for backward-compatibility with callers that consume it. `stableOrder` is the
// list of file-level CIDs in section 1 (semantic shift from block-level to
// file-level CIDs introduced by v2).
export interface BuildOrderedCarOptions {
  output: MerkleizeOutput;
  classifyFn?: (filePath: string, fileCid?: string) => "stable" | "volatile";
  prevStableOrder?: string[];
  phase?: string;
}

// Encode a single block in CAR-frame format: varint(cid.bytes.length + payload.length)
// followed by cid.bytes followed by payload.
function encodeCarFrame(cid: CID, payload: Uint8Array): Uint8Array {
  const cidBytes = cid.bytes;
  const innerLen = cidBytes.length + payload.length;
  const lenBytes = encodeVarint(innerLen);
  const out = new Uint8Array(lenBytes.length + cidBytes.length + payload.length);
  out.set(lenBytes, 0);
  out.set(cidBytes, lenBytes.length);
  out.set(payload, lenBytes.length + cidBytes.length);
  return out;
}

function encodeVarint(n: number): Uint8Array {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n & 0x7f);
  return new Uint8Array(out);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function encodeCarHeader(root: CID): Promise<Uint8Array> {
  // Run CarWriter with zero blocks and capture only the header bytes.
  const { writer, out } = CarWriter.create([root]);
  const headerPromise = collectBytes(out);
  await writer.close();
  return await headerPromise;
}

// Extract the CID from a CAR-frame (skips varint length prefix, reads CID bytes).
// Uses CID.decodeFirst which handles trailing payload bytes correctly.
function frameBlockCid(frame: Uint8Array): string {
  // Read varint to find where CID starts (varint = length of cidBytes + payload).
  let offset = 0;
  while (offset < frame.length && (frame[offset] & 0x80)) offset++;
  offset++; // consume the last varint byte (high bit clear)
  // CID.decodeFirst reads exactly the CID bytes, leaving payload behind.
  const [cid] = CID.decodeFirst(frame.slice(offset));
  return cid.toString();
}

export async function buildOrderedCar(
  options: BuildOrderedCarOptions
): Promise<MerkleizeStableResult> {
  const { output, prevStableOrder = [] } = options;
  const clsFn = options.classifyFn ?? ((p: string) => classifyFile(p));
  const tag = options.phase ? ` — ${options.phase}` : '';

  // Per-file classification. Manifest path is always section 0 (special-cased).
  const MANIFEST_PATH_LITERAL = ".bulletin-deploy/manifest.json";

  // ─── Build per-file block-frame lists ───────────────────────────────────────
  type FileEntry = { path: string; fileCid: string; blocks: Uint8Array[]; size: number };
  const stableFiles: FileEntry[] = [];
  const volatileFiles: FileEntry[] = [];

  for (const [filePath, fileBlockCids] of output.fileBlocks) {
    if (filePath === MANIFEST_PATH_LITERAL) continue;
    const fileCid = output.fileCids.get(filePath)!;
    const frames: Uint8Array[] = [];

    // fileBlocks now contains all blocks in walk order: root (if multi-block),
    // then intermediate dag-pb nodes, then raw leaves. Iterate directly.
    for (const blockCid of fileBlockCids) {
      const blockBytes = output.blocks.get(blockCid);
      if (!blockBytes) throw new Error(`buildOrderedCar: block ${blockCid} missing`);
      frames.push(encodeCarFrame(CID.parse(blockCid), blockBytes));
    }

    const size = frames.reduce((s, b) => s + b.length, 0);
    const cls = clsFn(filePath, fileCid);
    (cls === "stable" ? stableFiles : volatileFiles).push({ path: filePath, fileCid, blocks: frames, size });
  }

  // ─── Section 1 file order (stable): prev-anchor first, then size desc + CID asc ─
  const fileByCid = new Map(stableFiles.map((f) => [f.fileCid, f] as const));
  const placed = new Set<string>();
  const section1Files: FileEntry[] = [];
  for (const cid of prevStableOrder) {
    const f = fileByCid.get(cid);
    if (f && !placed.has(cid)) { section1Files.push(f); placed.add(cid); }
  }
  const newStable = stableFiles.filter((f) => !placed.has(f.fileCid));
  newStable.sort((a, b) =>
    (b.size - a.size) || (a.fileCid < b.fileCid ? -1 : a.fileCid > b.fileCid ? 1 : 0)
  );
  for (const f of newStable) section1Files.push(f);

  // ─── Section 2 file order (volatile): size desc + CID asc ───────────────────
  volatileFiles.sort((a, b) =>
    (b.size - a.size) || (a.fileCid < b.fileCid ? -1 : a.fileCid > b.fileCid ? 1 : 0)
  );

  // ─── Section 0: CAR header + manifest leaf blocks ────────────────────────────
  const rootCidParsed = CID.parse(output.rootCid);
  const headerBytes = await encodeCarHeader(rootCidParsed);
  const section0Frames: Uint8Array[] = [headerBytes];
  const manifestBlockCids = output.fileBlocks.get(MANIFEST_PATH_LITERAL) ?? [];
  if (manifestBlockCids.length > 0) {
    // fileBlocks contains all blocks in walk order (root, intermediates, leaves).
    for (const blockCid of manifestBlockCids) {
      const blockBytes = output.blocks.get(blockCid);
      if (!blockBytes) throw new Error(`buildOrderedCar: manifest block ${blockCid} missing`);
      section0Frames.push(encodeCarFrame(CID.parse(blockCid), blockBytes));
    }
  }
  const section0Bytes = concatBytes(section0Frames);

  // ─── Section 2 leading blocks: root dir + subdir dag-pbs ────────────────────
  const rootDirBytes = output.blocks.get(output.rootCid);
  if (!rootDirBytes) throw new Error(`buildOrderedCar: root block ${output.rootCid} missing`);
  const section2LeadFrames: Uint8Array[] = [encodeCarFrame(rootCidParsed, rootDirBytes)];
  for (const cid of output.subdirCids) {
    const bytes = output.blocks.get(cid);
    if (!bytes) continue;
    section2LeadFrames.push(encodeCarFrame(CID.parse(cid), bytes));
  }

  // ─── Pack sections via file-aligned chunker ──────────────────────────────────
  const section1SectionFiles: SectionFile[] = section1Files.map((f) => ({ blocks: f.blocks }));
  const section2SectionFiles: SectionFile[] = [
    { blocks: section2LeadFrames },
    ...volatileFiles.map((f) => ({ blocks: f.blocks })),
  ];

  const section1Chunks = packSection(section1SectionFiles);
  const section2Chunks = packSection(section2SectionFiles);
  const section0Chunks = section0Bytes.length > 0 ? [section0Bytes] : [];

  const allChunks = [...section0Chunks, ...section1Chunks, ...section2Chunks];
  const carBytes = concatBytes(allChunks);

  // ─── Derive chunk-level CIDs (SHA-256, raw codec) ────────────────────────────
  const chunkCids = allChunks.map((b) => createCID(b).toString());
  const section1ChunkCids = section1Chunks.map((b) => createCID(b).toString());

  // ─── Build blockOrder for backward-compat (all block CIDs in CAR write order) ─
  // Skip the header (it's in section0Bytes but is not a block frame).
  const blockOrder: string[] = [];
  const collectFrameCids = (frames: Uint8Array[]) => {
    for (const frame of frames) {
      // section0Frames[0] is the header bytes (no CID), skip it.
      if (frame === headerBytes) continue;
      try { blockOrder.push(frameBlockCid(frame)); } catch { /* skip malformed */ }
    }
  };
  collectFrameCids(section0Frames);
  for (const f of section1Files) collectFrameCids(f.blocks);
  collectFrameCids(section2LeadFrames);
  for (const f of volatileFiles) collectFrameCids(f.blocks);

  // ─── stableOrder: file-level CIDs of section-1 files ────────────────────────
  const stableOrder: string[] = section1Files.map((f) => f.fileCid);

  const s1Bytes = section1Chunks.reduce((s, b) => s + b.length, 0);
  const s2Bytes = section2Chunks.reduce((s, b) => s + b.length, 0);
  console.log(
    `   CAR (3-section${tag}): ${(carBytes.length / 1024 / 1024).toFixed(2)} MB ` +
    `(s0=${section0Bytes.length}B s1=${s1Bytes}B s2=${s2Bytes}B), ` +
    `${allChunks.length} frames (${section0Chunks.length} header + ${section1Chunks.length} data + ${section2Chunks.length} manifest)`
  );

  return {
    carBytes,
    cid: output.rootCid,
    blockOrder,
    stableOrder,
    chunks: allChunks,
    chunkCids,
    section1ChunkCids,
    sectionSizes: {
      section0: section0Bytes.length,
      section1: s1Bytes,
      section2: s2Bytes,
    },
    sectionChunkCounts: { section0: section0Chunks.length, section1: section1Chunks.length, section2: section2Chunks.length },
    blocks: output.blocks,
    fileCids: output.fileCids,
  };
}

export async function rebuildOrderedCarFromBytes(
  carBytes: Uint8Array,
  prevStableOrder: string[] = [],
): Promise<MerkleizeStableResult> {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  if (roots.length === 0) throw new Error("CAR file has no roots");

  const blocks = new Map<string, Uint8Array>();
  for await (const { cid, bytes } of reader.blocks()) {
    blocks.set(cid.toString(), bytes);
  }

  const rootCid = roots[0].toString();
  const { fileBlocks, fileCids, rootBlockCids, subdirCids } = walkFileBlocks(rootCid, blocks);
  return buildOrderedCar({
    output: { rootCid, blocks, fileBlocks, fileCids, rootBlockCids, subdirCids },
    prevStableOrder,
  });
}

// Convenience: merkleize + build ordered CAR in one call. Used by callers
// that don't need to inspect the intermediate `MerkleizeOutput` (e.g. tests
// + the storeDirectoryV2 happy path).
export async function merkleizeWithStableOrder(
  directoryPath: string,
  prevStableOrder?: string[],
  options?: { useKubo?: boolean; classifyFn?: (filePath: string) => "stable" | "volatile"; phase?: string }
): Promise<MerkleizeStableResult> {
  const useKubo = options?.useKubo ?? false;
  const phase = options?.phase;
  const output = await merkleizeBackend(directoryPath, useKubo, phase);
  return buildOrderedCar({ output, classifyFn: options?.classifyFn, prevStableOrder, phase });
}

// Legacy entry-point: merkleize without ordering. Retained for backward
// compatibility with callers that don't need incremental upload (e.g. the
// encrypted-deploy path which produces non-deterministic CAR bytes anyway).
export async function merkleizeJS(directoryPath: string): Promise<MerkleizeResult> {
  console.log(`   Merkleizing (JS): ${directoryPath}`);
  const blockstore = new CidPreservingBlockstore();

  const source = (function* () {
    for (const file of walkDirectoryLazy(directoryPath)) {
      yield {
        path: file.path,
        content: (async function* () {
          yield fs.readFileSync(file.absolutePath);
        })(),
      };
    }
  })();

  let rootCid: CID | undefined;
  for await (const entry of importer(source, blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    wrapWithDirectory: true,
  })) {
    rootCid = entry.cid;
  }
  if (!rootCid) throw new Error("Merkleization produced no root CID");

  const { writer, out } = CarWriter.create([rootCid]);
  const collectPromise = collectBytes(out);
  for (const { cid, bytes } of blockstore.all()) {
    await writer.put({ cid, bytes });
  }
  await writer.close();

  const carBytes = await collectPromise;
  blockstore.clear();
  console.log(`   CAR (JS): ${(carBytes.length / 1024 / 1024).toFixed(2)} MB`);

  return { carBytes, cid: rootCid.toString() };
}
