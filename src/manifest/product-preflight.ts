/**
 * Frontloaded product-manifest preflight.
 *
 * The deploy CLI historically loaded + validated the product config only in
 * the post-deploy manifest-publish step — so an invalid config (bad `domain`,
 * oversized text record, missing icon/executable file) surfaced *after*
 * preflight and a full merkleize/upload (see paritytech/polkadot-app-deploy#125).
 *
 * This runs all the pure/local manifest checks up front, before any storage or
 * chain work, so config errors fail fast with one aggregated message:
 *   1. discover + load the config (schema validation, incl. `domain` ending
 *      in `.dot`, via `loadProductConfig`),
 *   2. byte-budget preflight for every text record (`pessimisticSizePreflight`),
 *   3. the referenced icon file + every executable path exist on disk.
 *
 * Returns the loaded+validated config so the caller can reuse it (no double
 * load), or `null` when no config is applicable (opt-in manifest mode).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NonRetryableError } from "../errors.js";
import { getTextRecordBudgetBytes, pessimisticSizePreflight } from "./byte-budget.js";
import { tryLoadProductConfig, type LoadProductConfigOptions, type LoadedProductConfig } from "./config-load.js";
import type { ProductConfig } from "./types.js";

/**
 * Check that every file a product config references exists on disk, resolved
 * relative to the config's own directory. Returns a list of human-readable
 * error strings (empty when everything is present). The icon must be a regular
 * file; an executable path may be a file or a directory (a build dir).
 */
export async function checkProductConfigFilesExist(
  config: ProductConfig,
  configDir: string,
): Promise<string[]> {
  const errors: string[] = [];

  const iconAbs = path.resolve(configDir, config.icon.path);
  try {
    const st = await fs.stat(iconAbs);
    if (!st.isFile()) errors.push(`icon.path "${config.icon.path}" is not a file (${iconAbs})`);
  } catch {
    errors.push(`icon.path "${config.icon.path}" not found (${iconAbs})`);
  }

  for (const exec of config.executables) {
    const execAbs = path.resolve(configDir, exec.path);
    try {
      const st = await fs.stat(execAbs);
      if (exec.kind === "app" && "manifest" in exec && !st.isDirectory()) {
        errors.push(
          `executables[app].path "${exec.path}" must be a directory for App manifest v2 (${execAbs})`,
        );
      }
    } catch {
      errors.push(`executables[${exec.kind}].path "${exec.path}" not found (${execAbs})`);
    }
  }

  return errors;
}

/**
 * Materialize each App v2 manifest inside its executable directory before the
 * directory is content-addressed. The config object is the single source of
 * truth; the same JSON.stringify bytes are later written to DotNS.
 */
export async function writeEmbeddedAppManifests(
  config: ProductConfig,
  configDir: string,
): Promise<string[]> {
  const errors: string[] = [];
  for (const exec of config.executables) {
    if (exec.kind !== "app" || !("manifest" in exec)) continue;
    const manifestPath = path.join(
      path.resolve(configDir, exec.path),
      "manifest.json",
    );
    try {
      await fs.writeFile(manifestPath, JSON.stringify(exec.manifest), "utf8");
    } catch (error) {
      errors.push(
        `cannot write App v2 embedded manifest at ${manifestPath}: ${(error as Error).message}`,
      );
    }
  }
  return errors;
}

/** Fail closed if an App v2 artifact no longer contains the configured bytes. */
export async function verifyEmbeddedAppManifests(
  config: ProductConfig,
  configDir: string,
): Promise<string[]> {
  const errors: string[] = [];
  for (const exec of config.executables) {
    if (exec.kind !== "app" || !("manifest" in exec)) continue;
    const manifestPath = path.join(
      path.resolve(configDir, exec.path),
      "manifest.json",
    );
    const expected = Buffer.from(JSON.stringify(exec.manifest), "utf8");
    try {
      const actual = await fs.readFile(manifestPath);
      if (!actual.equals(expected)) {
        errors.push(
          `App v2 embedded manifest differs from executable text-record bytes (${manifestPath})`,
        );
      }
    } catch (error) {
      errors.push(
        `cannot read App v2 embedded manifest at ${manifestPath}: ${(error as Error).message}`,
      );
    }
  }
  return errors;
}

/**
 * Run the full local manifest preflight. Throws a single aggregated
 * `NonRetryableError` on any schema / byte-budget / missing-file problem.
 * Returns the loaded config (reusable by the publish step) or `null` when no
 * product config is present.
 */
export async function preflightProductConfig(
  options: LoadProductConfigOptions = {},
): Promise<LoadedProductConfig | null> {
  // tryLoad returns null when no config is discoverable (contenthash-only
  // deploy); loadProductConfig inside already runs schema validation and
  // throws its own NonRetryableError on schema errors.
  const loaded = await tryLoadProductConfig(options);
  if (!loaded) return null;

  const { config, sourcePath } = loaded;
  const errors: string[] = [];

  // Byte-budget: every text record the publish flow will write must fit.
  const report = pessimisticSizePreflight(config, getTextRecordBudgetBytes());
  for (const c of report.checks) {
    if (!c.ok) errors.push(`text record "${c.key}" is ${c.bytes} B, over the ${c.budget} B dotNS budget`);
  }

  // Referenced files must exist before we materialize generated manifests.
  const fileErrors = await checkProductConfigFilesExist(config, path.dirname(sourcePath));
  errors.push(...fileErrors);
  if (fileErrors.length === 0) {
    errors.push(...(await writeEmbeddedAppManifests(config, path.dirname(sourcePath))));
  }

  if (errors.length > 0) {
    throw new NonRetryableError(
      `Product config preflight failed for ${sourcePath}:\n  - ${errors.join("\n  - ")}`,
    );
  }

  return loaded;
}
