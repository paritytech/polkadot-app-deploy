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
// Lower bound {6,} relaxed from v2's {8,} per PR #11 measurements (Vite
// hashes can be 6).
//
// #1355: the alnum class alone (`[A-Za-z0-9]`) missed Vite/Rollup's actual
// hash alphabet, which is base64url (`A-Za-z0-9_-`) — e.g. errors-CHrKVge_.js,
// index-B_NQy5Da.js, descriptors-7XDUQZP4-Q_l81UXa.js. Those hash-suffixed
// bundles fell through to "volatile" on every deploy despite being
// byte-identical between deploys, forcing a full re-upload each time. Widened
// to `[A-Za-z0-9_-]` so the whole base64url alphabet — including a "-"
// separator inside a multi-segment hash — is recognised as part of the hash,
// not just the class boundary. Classification here is name-only: it never
// looks at file history, so — unlike a CID-match-against-prevManifest
// approach — it cannot make a file's section membership depend on the
// previous deploy's manifest (that dependency is what breaks the invariant
// that chunking is a pure function of content). Measured against
// test/fixtures/realistic-vite/v1/assets/ (59 files): 14 failed the old
// alnum-only class, 0 fail this one.
//
// #1390: the old upper bound of 16 was narrower than common bundler digest
// lengths, so a stock webpack config's whole JS/CSS bundle fell through to
// "volatile" and re-uploaded every deploy. The two branches take different
// caps because they carry different false-positive risk — the alnum branch
// already accepts "-" and ordinary words, per #1355 above:
// - hex: 32, the length of an md5 digest, the longest hash shape mainstream
//   bundlers emit. webpack's 20-char `output.hashDigestLength` default and
//   the issue's 17/20/32-char cases are all hex and sit inside it.
// - alnum/base64url: 20, webpack's `hashDigestLength` default exactly, which
//   is also the only non-hex case in the issue's table. Reusing the hex
//   branch's 32 here would flip a 21-32 char ordinary segment such as
//   "data-longdescriptivefilename.json" from volatile to stable — the
//   regression test pins that.
export const CONTENT_HASH_RE = /[-.](?:[a-f0-9]{6,32}|[A-Za-z0-9_-]{6,20})\.[a-zA-Z0-9]+$/;

// ── Per-framework rule table ────────────────────────────────────────────────
//
// #1355/#1390/#1527: CONTENT_HASH_RE started as one global regex and each new
// bundler shape (Vite's base64url alphabet, webpack's longer digest, Nuxt's
// separator-less hash) was handled by loosening it for every project. That
// trades a cheap error (a stable file wrongly re-uploaded) for an expensive
// one (mutable content wrongly cached in section 1) globally, to serve one
// bundler.
//
// This table runs per-framework rules BEFORE the global fallback instead.
// Each entry must NARROW — scope a claim to a path prefix the bundler
// provably owns — never WIDEN a pattern that applies everywhere (C2: a false
// "stable" is the expensive error; a false "volatile" only wastes an
// upload). An unknown or undetected framework falls straight through to the
// unchanged global fallback (CONTENT_HASH_RE + STABLE_EXTENSIONS), which is
// the majority case (C3: detection degrades to the fallback, never guesses a
// wrong rule set).
export type FrameworkRules = {
  /** Prefixes the bundler content-addresses wholesale — every file under them is stable. */
  stablePrefixes?: readonly string[];
  /** A hash shape accepted ONLY under the given prefix. */
  scopedHashRe?: readonly { prefix: string; re: RegExp }[];
  /** Basenames that stay volatile even inside a stablePrefix. */
  volatileExact?: readonly string[];
};

// Separator-less basenames, e.g. _nuxt/CJPnFZM_2.js. Deliberately NOT global:
// accepting this shape everywhere would make any 8+ char basename a hash.
const NUXT_HASH_RE = /(?:^|\/)[A-Za-z0-9_-]{8,20}\.[a-zA-Z0-9]+$/;

export const FRAMEWORK_RULES: Record<string, FrameworkRules> = {
  // Next.js self-hosting docs: static assets under _next/static/ carry an
  // immutable Cache-Control because "these immutable files contain a
  // SHA-hash in the file name" — but _buildManifest.js and _ssgManifest.js
  // sit under a build-id directory and carry no hash of their own. Their
  // path is unique only while the build id is (Next keeps it constant when
  // `deploymentId` is set), so with a fixed build id they are a stable path
  // with mutable content — the C2 expensive error — unless excluded.
  next: {
    stablePrefixes: ["_next/static/"],
    volatileExact: ["_buildManifest.js", "_ssgManifest.js"],
  },
  // Nuxt's app manifest writes _nuxt/builds/latest.json — re-read on every
  // page load to detect a new deployment, so it has a fixed filename and
  // changes content every build. A blanket `_nuxt/` stablePrefix would put
  // it in section 1, so the rule is scoped to the hash shape instead of the
  // prefix. _nuxt/builds/meta/<buildId>.json IS stable: that name is unique
  // per build, so its content never changes under it.
  nuxt: { scopedHashRe: [{ prefix: "_nuxt/", re: NUXT_HASH_RE }] },
  // A PolkaVM app bundle. Nothing here is content-addressed, so the rules
  // are about what the bundle means, not what its filenames look like: the
  // payload directories never change, the executable and its manifest
  // change every release. `game/` and `LICENSES/` are generic enough to be
  // someone else's mutable content, so they are earned entirely by the
  // detection marker (a parsed manifest.json field) being specific.
  "polkavm-app": {
    stablePrefixes: ["game/", "LICENSES/"],
    volatileExact: ["app.polkavm", "manifest.json"],
  },
};

export function isVolatilePath(p: string): boolean {
  return p.startsWith(`${MANIFEST_DIR}/`) || p === MANIFEST_DIR;
}

export type ClassifyContext = {
  prevManifest?: EmbeddedManifest | null;
  framework?: string | null;
  fileCid?: string;
};

// Heuristic classification — used on first deploy or when prev manifest absent.
//
// Framework rules run BEFORE the global pattern and never replace it. An
// unknown/null framework falls straight through the STABLE_EXTENSIONS +
// CONTENT_HASH_RE fallback unchanged — the majority (unknown) case must
// stay untouched.
export function classifyFileHeuristic(filePath: string, framework?: string | null): FileType {
  if (isVolatilePath(filePath)) return "volatile";

  const rules = framework ? FRAMEWORK_RULES[framework] : undefined;
  if (rules) {
    // Split only when a rule set actually consults the basename — nuxt's
    // rules test the full path, so it would otherwise allocate per file.
    if (rules.volatileExact && rules.volatileExact.includes(filePath.split("/").pop() ?? filePath)) return "volatile";
    if (rules.stablePrefixes?.some((prefix) => filePath.startsWith(prefix))) return "stable";
    if (rules.scopedHashRe?.some(({ prefix, re }) => filePath.startsWith(prefix) && re.test(filePath))) return "stable";
  }

  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext && STABLE_EXTENSIONS.has(ext)) return "stable";
  if (CONTENT_HASH_RE.test(filePath)) return "stable";
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
