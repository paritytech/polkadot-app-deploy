// Embedded-manifest schema for incremental-upload-v2.
//
// The manifest lives at `${buildDir}/.bulletin-deploy/manifest.json` inside
// every deploy and travels with the content. The next deploy fetches the
// previous manifest from the gateway (via the previous contenthash) and uses
// it to drive exact stable/volatile classification + chunk-skip telemetry.
//
// v3 extends v2 with: framework, file sizes, full block list, per-chunk
// metadata (size + deployed_at, replacing v2's sentinel pair). Forward-compat
// parser accepts v2 by defaulting the missing fields and normalising chunk
// sentinels into v3 shape (size=0, deployed_at=epoch).
//
// Spec: docs-internal/superpowers/specs/2026-05-08-incremental-upload-v2-revision-design.md

export const MANIFEST_VERSION = 3;
export const MANIFEST_DIR = ".bulletin-deploy";
export const MANIFEST_FILENAME = "manifest.json";
export const MANIFEST_PATH = `${MANIFEST_DIR}/${MANIFEST_FILENAME}`;

export type FileType = "stable" | "volatile";

export interface ManifestFileEntry {
  cid: string;
  type: FileType;
  size?: number;
}

export interface ManifestChunkEntry {
  size: number;
  deployed_at: string; // ISO 8601
  block?: number;      // chain block where this chunk is stored (from chain probe or Stored event)
  index?: number;      // tx index within that block
}

export interface EmbeddedManifest {
  version: number;
  previous_contenthash: string | null;
  deployed_at: string;
  framework: string | null;
  files: Record<string, ManifestFileEntry>;
  stableBlockOrder: string[];
  blocks: string[];
  chunks: Record<string, ManifestChunkEntry>;
}

const STABLE_EXTENSIONS = new Set([
  "wasm", "woff", "woff2", "ttf", "otf", "eot",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico",
  "mp3", "mp4", "webm", "ogg",
  "pdf",
]);

// Bundler content-hash patterns: -<6+ hex>, -<6+ alnum>, .<6+ hex>.<ext>.
// Examples: main-AbcDef12.js, vendor.a1b2c3d4.css, runtime-Xyz789.wasm.
// {6,16} relaxed from v2's {8,} per PR #11 measurements (Vite hashes can be 6).
const CONTENT_HASH_RE = /[-.](?:[a-f0-9]{6,16}|[A-Za-z0-9]{6,16})\.[a-zA-Z0-9]+$/;

export function isVolatilePath(p: string): boolean {
  return p.startsWith(`${MANIFEST_DIR}/`) || p === MANIFEST_DIR;
}

export type ClassifyContext = {
  prevManifest?: EmbeddedManifest | null;
  framework?: string | null;
  fileCid?: string;
};

// Heuristic classification — used on first deploy or when prev manifest absent.
export function classifyFileHeuristic(filePath: string, framework?: string | null): FileType {
  if (isVolatilePath(filePath)) return "volatile";
  if (CONTENT_HASH_RE.test(filePath)) return "stable";
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext && STABLE_EXTENSIONS.has(ext)) return "stable";
  if (framework === "next") {
    if (filePath.startsWith("_next/static/")) return "stable";
  }
  if (framework === "vite") {
    if (filePath.startsWith("assets/") && CONTENT_HASH_RE.test(filePath)) return "stable";
  }
  return "volatile";
}

// Manifest-driven classification — exact CID match against previous deploy.
export function classifyFile(filePath: string, ctx: ClassifyContext = {}): FileType {
  if (isVolatilePath(filePath)) return "volatile";
  const prev = ctx.prevManifest;
  if (prev && ctx.fileCid !== undefined) {
    const entry = prev.files[filePath];
    if (entry && entry.cid === ctx.fileCid) return "stable";
    return "volatile"; // cid mismatch OR path absent
  }
  return classifyFileHeuristic(filePath, ctx.framework ?? null);
}

export type ParseResult =
  | { ok: true; manifest: EmbeddedManifest }
  | { ok: false; error: string };

export function parseManifest(raw: string): ParseResult {
  let obj: any;
  try { obj = JSON.parse(raw); }
  catch (e: any) { return { ok: false, error: `manifest JSON parse error: ${e.message}` }; }

  if (!obj || typeof obj !== "object") return { ok: false, error: "manifest is not an object" };
  if (typeof obj.version !== "number") return { ok: false, error: "manifest.version missing or not number" };
  if (!(obj.previous_contenthash === null || typeof obj.previous_contenthash === "string")) {
    return { ok: false, error: "manifest.previous_contenthash must be string|null" };
  }
  if (typeof obj.deployed_at !== "string") return { ok: false, error: "manifest.deployed_at missing" };
  if (!obj.files || typeof obj.files !== "object") return { ok: false, error: "manifest.files missing" };
  if (!Array.isArray(obj.stableBlockOrder)) return { ok: false, error: "manifest.stableBlockOrder missing" };
  if (!obj.chunks || typeof obj.chunks !== "object") return { ok: false, error: "manifest.chunks missing" };

  // Normalise chunk entries into v3 shape (preserve v3 fields; coerce v2 sentinels).
  const chunks: Record<string, ManifestChunkEntry> = {};
  for (const [cid, raw] of Object.entries(obj.chunks)) {
    const r: any = raw;
    if (r && typeof r === "object") {
      const size = typeof r.size === "number" ? r.size : 0;
      const deployedAt = typeof r.deployed_at === "string" ? r.deployed_at : "1970-01-01T00:00:00.000Z";
      chunks[cid] = {
        size,
        deployed_at: deployedAt,
        ...(typeof r.block === "number" ? { block: r.block } : {}),
        ...(typeof r.index === "number" ? { index: r.index } : {}),
      };
    } else {
      chunks[cid] = { size: 0, deployed_at: "1970-01-01T00:00:00.000Z" };
    }
  }

  const manifest: EmbeddedManifest = {
    version: obj.version,
    previous_contenthash: obj.previous_contenthash,
    deployed_at: obj.deployed_at,
    framework: typeof obj.framework === "string" ? obj.framework : null,
    files: obj.files,
    stableBlockOrder: obj.stableBlockOrder,
    blocks: Array.isArray(obj.blocks) ? obj.blocks : [],
    chunks,
  };
  return { ok: true, manifest };
}
