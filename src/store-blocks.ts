import { CarBlockIterator } from "@ipld/car/iterator";
import type { CID } from "multiformats/cid";
import { NonRetryableError } from "./errors.js";

export const STORE_GROUP_BYTES = 64 * 1024 * 1024;

const STORABLE_HASH_CODES = new Set([0xb220, 0x12, 0x1b]);
const IDENTITY_HASH_CODE = 0x00;
const DIGEST_BYTES = 32;

export interface ChunkFormat {
  codec: number;
  hashCode: number;
}

export interface CarBlock {
  cid: string;
  bytes: Uint8Array;
  format: ChunkFormat;
}

type CidOf = (bytes: Uint8Array, format: ChunkFormat) => string;

export interface StoreBlocksDependencies {
  cidOf: CidOf;
  store(blocks: CarBlock[]): Promise<Set<string>>;
  groupBytes?: number;
}

export interface StoreBlocksOutcome {
  stored: string[];
  alreadyStored: string[];
}

export interface CarInspection {
  blocks: number;
  bytes: number;
  largestBlock: { cid: string; position: number; bytes: number };
}

function invalid(message: string): NonRetryableError {
  return new NonRetryableError(`--store-blocks: ${message}`);
}

function blockFormat(cid: CID, position: number): ChunkFormat {
  if (cid.version !== 1) {
    throw invalid(
      `block ${position}: ${cid} is a CIDv0. Bulletin nodes serve CIDv1 only, so this block cannot be fetched under this name. ` +
        "Add the content again with CIDv1 (Kubo: ipfs add --cid-version 1), which gives new CIDs.",
    );
  }
  const hashCode = cid.multihash.code;
  if (hashCode === IDENTITY_HASH_CODE) {
    throw invalid(
      `block ${position}: ${cid} is an identity CID: the data is inside the CID, and Bulletin cannot store it. Remove this entry from the CAR file.`,
    );
  }
  if (!STORABLE_HASH_CODES.has(hashCode) || cid.multihash.digest.length !== DIGEST_BYTES) {
    throw invalid(`block ${position}: ${cid} uses hashing 0x${hashCode.toString(16)}, which Bulletin cannot store`);
  }
  return { codec: cid.code, hashCode };
}

async function openCar(car: AsyncIterable<Uint8Array>): Promise<CarBlockIterator> {
  try {
    return await CarBlockIterator.fromIterable(car);
  } catch (error: any) {
    throw invalid(`not a CAR file: ${error?.message ?? error}`);
  }
}

async function* distinctBlocks(car: AsyncIterable<Uint8Array>, cidOf: CidOf): AsyncGenerator<{ position: number; block: CarBlock }> {
  const blocks = await openCar(car);
  const seen = new Set<string>();
  let position = 0;
  for await (const { cid, bytes } of blocks) {
    position += 1;
    const format = blockFormat(cid, position);
    const text = cid.toString();
    if (bytes.length === 0) throw invalid(`block ${position}: ${text} is empty, and Bulletin does not store empty data`);
    if (cidOf(bytes, format) !== text) throw invalid(`block ${position}: the bytes do not match ${text}`);
    if (seen.has(text)) continue;
    seen.add(text);
    yield { position, block: { cid: text, bytes, format } };
  }
  if (seen.size === 0) throw invalid("the CAR file contains no blocks");
}

export async function carInspection(car: AsyncIterable<Uint8Array>, cidOf: CidOf): Promise<CarInspection> {
  const inspection: CarInspection = { blocks: 0, bytes: 0, largestBlock: { cid: "", position: 0, bytes: 0 } };
  for await (const { position, block } of distinctBlocks(car, cidOf)) {
    inspection.blocks += 1;
    inspection.bytes += block.bytes.length;
    if (block.bytes.length > inspection.largestBlock.bytes) {
      inspection.largestBlock = { cid: block.cid, position, bytes: block.bytes.length };
    }
  }
  return inspection;
}

export function blockSizeViolation(inspection: CarInspection, byteLimit: number): NonRetryableError | null {
  const { cid, position, bytes } = inspection.largestBlock;
  if (bytes <= byteLimit) return null;
  return invalid(`block ${position}: ${cid} has ${bytes} bytes, and this chain stores at most ${byteLimit} bytes per transaction`);
}

export async function storeCarBlocks(car: AsyncIterable<Uint8Array>, dependencies: StoreBlocksDependencies): Promise<StoreBlocksOutcome> {
  const groupLimit = dependencies.groupBytes ?? STORE_GROUP_BYTES;
  const outcome: StoreBlocksOutcome = { stored: [], alreadyStored: [] };
  let group: CarBlock[] = [];
  let groupSize = 0;
  const storeGroup = async () => {
    if (group.length === 0) return;
    const present = await dependencies.store(group);
    for (const block of group) (present.has(block.cid) ? outcome.alreadyStored : outcome.stored).push(block.cid);
    group = [];
    groupSize = 0;
  };
  for await (const { block } of distinctBlocks(car, dependencies.cidOf)) {
    group.push(block);
    groupSize += block.bytes.length;
    if (groupSize >= groupLimit) await storeGroup();
  }
  await storeGroup();
  return outcome;
}
