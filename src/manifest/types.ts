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

export interface RootManifest {
  $v: 1;
  displayName: string;
  description: string;
  icon: Icon;
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
  abiVersion: 1;
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
