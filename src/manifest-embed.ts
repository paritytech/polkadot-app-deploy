// Write the embedded manifest into the build directory.
//
// Two-phase write: a placeholder lands before phase A merkleize so the path
// gets a CID slot; the finalised payload (with chunks map populated for
// section 1) is written before phase B merkleize.
//
// Spec: docs-internal/superpowers/specs/2026-05-08-incremental-upload-v2-revision-design.md

import * as fs from "fs";
import * as path from "path";
import {
  MANIFEST_DIR,
  MANIFEST_PATH,
  type EmbeddedManifest,
  type ManifestFileEntry,
  type ManifestChunkEntry,
} from "./manifest.js";

interface PlaceholderInput {
  version: number;
  previousContenthash: string | null;
  deployedAt: string;
  framework: string | null;
}

interface FinaliseInput extends PlaceholderInput {
  files: Record<string, ManifestFileEntry>;
  stableBlockOrder: string[];
  blocks: string[];
  chunks: Record<string, ManifestChunkEntry>;
}

function writeAtomic(filePath: string, body: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, filePath);
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeEmbeddedManifestPlaceholder(buildDir: string, data: PlaceholderInput): void {
  ensureDir(path.join(buildDir, MANIFEST_DIR));
  const payload: EmbeddedManifest = {
    version: data.version,
    previous_contenthash: data.previousContenthash,
    deployed_at: data.deployedAt,
    framework: data.framework,
    files: {},
    stableBlockOrder: [],
    blocks: [],
    chunks: {},
  };
  writeAtomic(path.join(buildDir, MANIFEST_PATH), JSON.stringify(payload, null, 2));
}

export function finaliseEmbeddedManifest(buildDir: string, data: FinaliseInput): void {
  ensureDir(path.join(buildDir, MANIFEST_DIR));
  const payload: EmbeddedManifest = {
    version: data.version,
    previous_contenthash: data.previousContenthash,
    deployed_at: data.deployedAt,
    framework: data.framework,
    files: data.files,
    stableBlockOrder: data.stableBlockOrder,
    blocks: data.blocks,
    chunks: data.chunks,
  };
  writeAtomic(path.join(buildDir, MANIFEST_PATH), JSON.stringify(payload, null, 2));
}
