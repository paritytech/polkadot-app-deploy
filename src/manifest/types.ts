/**
 * Product-manifest type definitions per RFC paritytech/triangle-js-sdks #0001.
 *
 * Two-level shape: a `RootManifest` written as the `manifest` text record on
 * `<product_id>.dot`, plus one `ExecutableManifest` per modality written as
 * the `executable` text record on `app|widget|funding|worker.<product_id>.dot`.
 *
 * Unrelated to [src/manifest.ts](../manifest.ts), which models the embedded
 * deploy manifest that ships inside each CAR.
 */

export type IconFormat = "jpeg" | "png";

export type AppVersion =
  | readonly [number, number, number]
  | readonly [number, number, number, string];

export interface Icon {
  cid: string;
  format: IconFormat;
}

/**
 * A grant one product's manifest issues to another product, naming what the
 * grantee may do *to* the grantor when the Host mediates a cross-product
 * interaction. See `RootManifest.trustedProducts` and the RFC's "Trusted
 * products" section (paritytech/host-rust-core `docs/rfcs/product-manifest.md`):
 * `"all"` is a superset wildcard covering every mediated interaction, present
 * and future; `"storage"` covers read-only access to the grantor's
 * host-local storage; `"context"` covers acting as the grantor's account —
 * reading its identity and signing under its keys. A Host ignores any value
 * it does not recognise rather than failing validation over it.
 */
export type Granted = "all" | "storage" | "context";

export interface RootManifest {
  $v: 1;
  displayName: string;
  description: string;
  icon: Icon;
  /**
   * Pre-approved cross-product grants, keyed by the OTHER product's bare
   * label (lowercase, no TLD suffix — e.g. `"wallet"`, never `"wallet.dot"`;
   * the Host appends the TLD of the network it resolves against). Each entry
   * says what that product may do *to this one*; it says nothing about the
   * reverse direction. Absent, `{}`, and an empty grant array all mean "no
   * grants" — the Host prompts for consent as usual. See the RFC's "Trusted
   * products" section for full semantics.
   */
  trustedProducts?: Record<string, Granted[]>;
}

interface CommonExecutableFieldsV1 {
  $v: 1;
  appVersion: AppVersion;
}

interface CommonAppFieldsV2 {
  $v: 2;
  kind: "app";
  appVersion: AppVersion;
}

export interface AppManifestV1 extends CommonExecutableFieldsV1 {
  kind: "app";
}

export interface WebRuntime {
  kind: "web";
  entrypoint: string;
}

export interface PolkaVmRuntime {
  kind: "polkavm";
  abiVersion: 1 | 2;
  entrypoint: string;
}

export interface GraphicsRequirement {
  abiVersion: 1;
  profile: "framebuffer" | "tri2d" | "webgpu-raster";
  requiredFeatures: string[];
  requiredLimits?: Record<string, number>;
}

export interface DeviceInputRequirement {
  abiVersion: 1;
  requiredFeatures: Array<
    "pointer" | "keyboard" | "touch" | "wheel" | "text" | "ime" | "focus"
  >;
}

export interface AudioRequirement {
  abiVersion: 1;
  requiredFeatures: string[];
}

export interface WebAppManifestV2 extends CommonAppFieldsV2 {
  runtime: WebRuntime;
}

export interface PolkaVmAppManifestV2 extends CommonAppFieldsV2 {
  runtime: PolkaVmRuntime;
  capabilities: {
    graphics: GraphicsRequirement;
    deviceInput?: DeviceInputRequirement;
    audio?: AudioRequirement;
  };
}

export type AppManifestV2 = WebAppManifestV2 | PolkaVmAppManifestV2;
export type AppManifest = AppManifestV1 | AppManifestV2;

export interface WidgetDimensions {
  height: number[];
  width?: number;
}

export interface WidgetManifest extends CommonExecutableFieldsV1 {
  kind: "widget";
  description?: string;
  dimensions: WidgetDimensions;
}

export type FundingMode = "CARD" | "BANK" | "CRYPTO";

export interface FundingManifest extends CommonExecutableFieldsV1 {
  kind: "funding";
  modes: FundingMode[];
}

export interface WorkerIncludes {
  chat: boolean;
  pocket: boolean;
  funding?: boolean;
}

export interface WorkerManifest extends CommonExecutableFieldsV1 {
  kind: "worker";
  entrypoint: string;
  includes: WorkerIncludes;
}

export type ExecutableManifest = AppManifest | WidgetManifest | FundingManifest | WorkerManifest;

export type ExecutableKind = ExecutableManifest["kind"];

export interface AppExecutableConfigV1 {
  kind: "app";
  path: string;
  appVersion: AppVersion;
}

export interface AppExecutableConfigV2 {
  kind: "app";
  path: string;
  manifest: AppManifestV2;
}

export type AppExecutableConfig = AppExecutableConfigV1 | AppExecutableConfigV2;

export interface WidgetExecutableConfig {
  kind: "widget";
  path: string;
  appVersion: AppVersion;
  description?: string;
  dimensions: WidgetDimensions;
}

export interface FundingExecutableConfig {
  kind: "funding";
  path: string;
  appVersion: AppVersion;
  modes: FundingMode[];
}

export interface WorkerExecutableConfig {
  kind: "worker";
  path: string;
  appVersion: AppVersion;
  entrypoint: string;
  includes: WorkerIncludes;
}

export type ExecutableConfig =
  | AppExecutableConfig
  | WidgetExecutableConfig
  | FundingExecutableConfig
  | WorkerExecutableConfig;

export interface IconConfig {
  path: string;
  format: IconFormat;
}

export interface ProductConfig {
  domain: string;
  displayName: string;
  description: string;
  icon: IconConfig;
  executables: ExecutableConfig[];
  /**
   * What this product's `RootManifest.trustedProducts` should carry once
   * published — same shape, same rules. See `Granted` and
   * `RootManifest.trustedProducts` above.
   */
  trustedProducts?: Record<string, Granted[]>;
}

/**
 * Identity helper that lets `polkadot-app-deploy.config.ts` authors get IntelliSense on the discriminated `ExecutableConfig` union.
 *
 * @example
 *   import { defineConfig } from "@parity/polkadot-app-deploy";
 *   export default defineConfig({ domain: "demoapp.dot", ... });
 */
export function defineConfig<T extends ProductConfig>(config: T): T {
  return config;
}
