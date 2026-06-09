/**
 * Build a manifest-config sidecar for an e2e fixture (app modality only).
 *
 * Creates a sibling tmpdir to the build directory containing
 * `polkadot-app-deploy.config.mjs` plus a 1×1 placeholder icon. The CLI
 * loads the config via the `--config <path>` flag (no walk-up
 * dependency), so the deploy bytes inside `buildDir` stay untouched
 * and chunk-skip-rate gates aren't disturbed.
 *
 * Returns `{ configPath, iconPath, sidecarDir }`. Test callers may
 * leave the sidecar to be cleaned up at runner teardown; in-process
 * `fs.rmSync(sidecarDir, { recursive: true, force: true })` is also
 * safe after the deploy completes.
 *
 * The config is written as `.mjs` (native ESM) rather than `.ts` to
 * avoid the bare-specifier `import { defineConfig } from "polkadot-app-deploy"`
 * resolution from a fresh tmpdir, which would fail in the test runner's
 * filesystem layout. The runtime validator doesn't require
 * `defineConfig` — it only inspects the default export shape.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Minimal valid 1×1 transparent PNG (68 bytes). Suffices for the
// manifest's icon allowlist (`format: "png"`) — Hosts that decode it
// just see a transparent pixel.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/**
 * @param {object} opts
 * @param {string} opts.buildDir  Absolute path to the deploy's build directory (the `app` executable bytes).
 * @param {string} opts.label     Domain label as passed to the CLI (with or without `.dot` suffix).
 * @returns {{ sidecarDir: string, configPath: string, iconPath: string }}
 */
export function buildManifestSidecar({ buildDir, label }) {
  const sidecarDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-manifest-"));
  const iconPath = path.join(sidecarDir, "icon.png");
  fs.writeFileSync(iconPath, PNG_1X1);

  const domain = label.endsWith(".dot") ? label : `${label}.dot`;
  const config = {
    domain,
    displayName: domain.replace(/\.dot$/, ""),
    description: "E2E test fixture",
    icon: { path: "./icon.png", format: "png" },
    executables: [
      { kind: "app", path: path.resolve(buildDir), appVersion: [0, 0, 0] },
    ],
  };

  const configPath = path.join(sidecarDir, "polkadot-app-deploy.config.mjs");
  fs.writeFileSync(configPath, `export default ${JSON.stringify(config, null, 2)};\n`);
  return { sidecarDir, configPath, iconPath };
}
