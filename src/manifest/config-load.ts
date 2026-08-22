/**
 * Load the developer-authored `polkadot-app-deploy.config.ts`.
 *
 * Configs are TypeScript so authors get IntelliSense on the discriminated
 * `kind` union. We evaluate them at runtime via [jiti](https://github.com/unjs/jiti)
 * and route the default export through [`validateProductConfig`](./schema.ts).
 * TS types are erased at runtime, so a literal like `"jpg"` where the type
 * says `"jpeg" | "png"` still needs a runtime check.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { NonRetryableError } from "../errors.js";
import { validateProductConfig } from "./schema.js";
import type { ProductConfig } from "./types.js";

const CANDIDATE_FILENAMES = [
  "polkadot-app-deploy.config.ts",
  "polkadot-app-deploy.config.js",
  "polkadot-app-deploy.config.mjs",
] as const;

export interface LoadProductConfigOptions {
  /** Explicit path to a config file. Takes precedence over auto-discovery. */
  path?: string;
  /** Directory to search when no explicit path is supplied. Defaults to process.cwd(). */
  cwd?: string;
  /** When true, walks up parent directories from `cwd` until a config is found or the fs root is reached. */
  walkUp?: boolean;
}

export interface LoadedProductConfig {
  config: ProductConfig;
  sourcePath: string;
}

/** Load + validate a product config, throwing on missing-file or schema errors. */
export async function loadProductConfig(
  options: LoadProductConfigOptions = {},
): Promise<LoadedProductConfig> {
  const sourcePath = await resolveConfigPath(options);
  const mod = await importConfig(sourcePath);
  const candidate = pickDefault(mod);
  const result = validateProductConfig(candidate);
  if (!result.ok) {
    throw new NonRetryableError(
      `Invalid product config at ${sourcePath}:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  return { config: result.value, sourcePath };
}

/**
 * Like [`loadProductConfig`](./config-load.ts) but returns `null` when no config is discoverable.
 *
 * Schema errors and explicit-path-not-found still throw. This is the opt-in
 * shape the deploy CLI uses to enter manifest mode only when a config is
 * present, without making the user pass a flag.
 */
export async function tryLoadProductConfig(
  options: LoadProductConfigOptions = {},
): Promise<LoadedProductConfig | null> {
  try {
    return await loadProductConfig(options);
  } catch (err) {
    if (
      err instanceof NonRetryableError &&
      /No product config found/.test(err.message)
    ) {
      return null;
    }
    throw err;
  }
}

async function resolveConfigPath(
  options: LoadProductConfigOptions,
): Promise<string> {
  if (options.path) {
    const resolved = path.resolve(options.path);
    if (!(await fileExists(resolved))) {
      throw new NonRetryableError(`Product config not found at ${resolved}`);
    }
    return resolved;
  }
  const start = path.resolve(options.cwd ?? process.cwd());
  let dir = start;
  while (true) {
    for (const name of CANDIDATE_FILENAMES) {
      const candidate = path.join(dir, name);
      if (await fileExists(candidate)) return candidate;
    }
    if (!options.walkUp) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const where = options.walkUp ? `${start} (walking up)` : start;
  throw new NonRetryableError(
    `No product config found in ${where}. Looked for: ${CANDIDATE_FILENAMES.join(", ")}.`,
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Evaluate the config module. Native `import()` handles `.js` and `.mjs`. jiti handles `.ts`.
 *
 * jiti is dynamic-imported so the non-product-manifest CLI paths don't pay
 * its load cost.
 *
 * A throw here means the consumer's own config file threw while its
 * top-level code ran (e.g. `if (!process.env.X) throw new Error("X is
 * required")`) — distinct from a schema-validation failure on an object
 * that loaded successfully. Wrap it so the raw stack trace never reaches
 * the user; see `formatConfigLoadError`.
 */
async function importConfig(sourcePath: string): Promise<unknown> {
  try {
    if (sourcePath.endsWith(".ts")) {
      const { createJiti } = await import("jiti");
      const jiti = createJiti(import.meta.url, { interopDefault: false });
      return await jiti.import(sourcePath);
    }
    return await import(pathToFileURL(sourcePath).href);
  } catch (err) {
    if (err instanceof NonRetryableError) throw err;
    throw new NonRetryableError(formatConfigLoadError(sourcePath, err));
  }
}

/**
 * Build the user-facing message for a config module that threw while being
 * evaluated. Preserves the original thrown message and, when it matches a
 * "<VAR> is required" / "missing env var VAR" shape, appends a hint naming
 * the specific environment variable — that shape covers the overwhelming
 * majority of consumer config throws (a required `process.env.X` guard).
 */
export function formatConfigLoadError(sourcePath: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const filename = path.basename(sourcePath);
  const base = `Your ${filename} threw while loading: ${message}. Check its required env vars / inputs.`;
  const envVar = extractMissingEnvVar(message);
  return envVar ? `${base}\nHint: set the ${envVar} environment variable.` : base;
}

function extractMissingEnvVar(message: string): string | null {
  const required = message.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s+is required\b/);
  if (required) return required[1];
  const missing = message.match(
    /missing env(?:ironment)? var(?:iable)?s?[:\s]+([A-Za-z_][A-Za-z0-9_]*)/i,
  );
  if (missing) return missing[1];
  return null;
}

function pickDefault(mod: unknown): unknown {
  if (mod && typeof mod === "object" && "default" in mod) {
    return (mod as { default: unknown }).default;
  }
  return mod;
}
