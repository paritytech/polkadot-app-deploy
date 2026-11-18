import fs from "node:fs";
import { CarWriter } from "@ipld/car/writer";
import { createCID } from "@parity/polkadot-app-deploy/deploy";

const RAW = 0x55;
const DAG_PB = 0x70;
const BLOCK_FORMATS = [
  { codec: RAW, hashCode: 0xb220 },
  { codec: DAG_PB, hashCode: 0x12 },
  { codec: RAW, hashCode: 0x1b },
];

export async function storeBlocksCar(carFile, salt) {
  const blocks = BLOCK_FORMATS.map(({ codec, hashCode }, index) => {
    const bytes = new TextEncoder().encode(`S-STORE-BLOCKS ${salt} block ${index}`);
    return { cid: createCID(bytes, codec, hashCode), bytes };
  });
  const { writer, out } = CarWriter.create([]);
  const carParts = [];
  const carCollection = (async () => {
    for await (const part of out) carParts.push(part);
  })();
  for (const block of blocks) await writer.put(block);
  await writer.close();
  await carCollection;
  fs.writeFileSync(carFile, Buffer.concat(carParts));
  return blocks.map((block) => block.cid.toString());
}
