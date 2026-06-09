import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { merkleizeJS } from "../../dist/merkle.js";
import { encodeContenthash } from "../../dist/deploy.js";

const SOURCE_FIXTURE = path.resolve(new URL(".", import.meta.url).pathname, "../fixtures/e2e-spa");

export async function mutateFixture(runTag) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fixture-"));
  for (const name of fs.readdirSync(SOURCE_FIXTURE)) {
    if (name === ".bulletin-deploy") continue;
    const source = path.join(SOURCE_FIXTURE, name);
    const dest = path.join(tmpRoot, name);
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      fs.cpSync(source, dest, { recursive: true });
    } else if (stat.isFile()) {
      fs.copyFileSync(source, dest);
    }
  }
  const htmlPath = path.join(tmpRoot, "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");
  const mutated = html.replace("<!-- E2E_RUN: LOCAL -->", `<!-- E2E_RUN: ${runTag} -->`);
  if (mutated === html) throw new Error("fixture template missing E2E_RUN marker");
  fs.writeFileSync(htmlPath, mutated);

  const { cid } = await merkleizeJS(tmpRoot);
  return { fixtureDir: tmpRoot, expectedCid: cid, expectedContenthash: "0x" + encodeContenthash(cid) };
}

// Multi-chunk fixture for fault-injection tests (#271). Generates a
// deterministic-but-incompressible blob per runTag so chunked-upload (S8)
// produces ≥3 chunks of 2 MB each — enough to span a mid-upload reconnect.
// Content is pseudo-random (PRNG seeded from runTag) rather than zeros so
// the IPFS importer doesn't dedupe blocks and we exercise distinct chunks.
export async function makeMultiChunkFixture(runTag, sizeBytes = 7 * 1024 * 1024) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-multichunk-"));
  // Seed a PRNG from runTag so the same tag yields identical bytes across
  // re-runs (helps debugging) but different tags yield different bytes
  // (avoids cross-run CID collisions on the chain).
  const seed = crypto.createHash("sha256").update(String(runTag)).digest();
  const blob = Buffer.allocUnsafe(sizeBytes);
  // Repeated SHA-256 chain — fast, incompressible, deterministic.
  let prev = seed;
  for (let off = 0; off < sizeBytes; off += 32) {
    prev = crypto.createHash("sha256").update(prev).digest();
    prev.copy(blob, off, 0, Math.min(32, sizeBytes - off));
  }
  fs.writeFileSync(path.join(tmpRoot, "blob.bin"), blob);
  // Add a small index.html so the dir is recognisably a "site" — helps
  // any future static-content checks; not required for the upload itself.
  fs.writeFileSync(path.join(tmpRoot, "index.html"), `<!-- E2E_RUN: ${runTag} -->\n<html><body>multichunk</body></html>\n`);

  const { cid } = await merkleizeJS(tmpRoot);
  return { fixtureDir: tmpRoot, expectedCid: cid, expectedContenthash: "0x" + encodeContenthash(cid), sizeBytes };
}
