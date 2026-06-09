// File-aligned section packer for incremental-upload-v2.
//
// Each "file" is a sequence of encoded blocks (length-prefixed CID + bytes
// for CAR-format blocks). The packer concatenates blocks into chunks subject
// to two budgets: a soft TARGET (1 MiB, the dedup granularity) and a hard MAX
// (2 MiB - 1 KiB, Bulletin's MaxTransactionSize minus tx envelope headroom).
//
// Boundary rules:
//   - Small file (sum of block bytes ≤ TARGET): packs into the current chunk
//     if it fits under TARGET; flushes first otherwise.
//   - Large file (sum > TARGET): flushes the current chunk first (so it
//     doesn't share with small files), then occupies dedicated chunks. Each
//     leading chunk fills up to MAX block-by-block; the tail chunk holds only
//     this file's tail bytes — never another file's bytes.
//   - All comparisons are strict `>` against TARGET / MAX. A file whose bytes
//     equal TARGET fits without flushing.
//
// Spec: docs-internal/superpowers/specs/2026-05-08-incremental-upload-v2-revision-design.md (§ 2)

export const CHUNK_SIZE_TARGET = 1024 * 1024;          // 1 MiB
export const CHUNK_SIZE_MAX = 2 * 1024 * 1024 - 1024;  // 2 MiB - 1 KiB

export interface SectionFile {
  // Encoded block bytes (CAR-frame: varint(len) + cid + bytes). The packer
  // treats them as opaque bytes; concatenating them produces a valid section.
  blocks: Uint8Array[];
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function packSection(files: SectionFile[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let buffer: Uint8Array[] = [];
  let bufferLen = 0;

  const flush = () => {
    if (bufferLen === 0) return;
    chunks.push(concat(buffer));
    buffer = [];
    bufferLen = 0;
  };

  for (const file of files) {
    const fileBytes = file.blocks.reduce((s, b) => s + b.length, 0);
    if (fileBytes === 0) continue;

    if (fileBytes > CHUNK_SIZE_TARGET) {
      flush();
      if (fileBytes > CHUNK_SIZE_MAX) {
        // File exceeds MAX: accumulate blocks up to MAX (must split anyway).
        for (const block of file.blocks) {
          if (bufferLen + block.length > CHUNK_SIZE_MAX) {
            flush();
          }
          buffer.push(block);
          bufferLen += block.length;
        }
        flush();
      } else {
        // TARGET < fileBytes ≤ MAX: each block gets its own chunk for
        // finer-grained dedup (block boundaries are preserved per-file).
        for (const block of file.blocks) {
          buffer.push(block);
          bufferLen += block.length;
          flush();
        }
      }
    } else {
      if (bufferLen + fileBytes > CHUNK_SIZE_TARGET) {
        flush();
      }
      for (const block of file.blocks) {
        buffer.push(block);
        bufferLen += block.length;
      }
    }
  }
  flush();
  return chunks;
}
