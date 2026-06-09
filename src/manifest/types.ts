/**
 * Product-manifest type definitions per RFC paritytech/triangle-js-sdks #0001.
 *
 * Two-level shape: a `RootManifest` written as the `manifest` text record on
 * `<product_id>.dot`, plus one `ExecutableManifest` per modality written as
 * the `executable` text record on `app|widget|worker.<product_id>.dot`.
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

interface CommonExecutableFields {
  $v: 1;
  appVersion: AppVersion;
}

export interface AppManifest extends CommonExecutableFields {
  kind: "app";
}

export interface WidgetDimensions {
  height: number[];
  width?: number;
}

export interface WidgetManifest extends CommonExecutableFields {
  kind: "widget";
  description?: string;
  dimensions: WidgetDimensions;
}

export interface WorkerIncludes {
  chat: boolean;
  pocket: boolean;
}

export interface WorkerManifest extends CommonExecutableFields {
  kind: "worker";
  entrypoint: string;
  includes: WorkerIncludes;
}

export type ExecutableManifest = AppManifest | WidgetManifest | WorkerManifest;

export type ExecutableKind = ExecutableManifest["kind"];

export interface AppExecutableConfig {
  kind: "app";
  path: string;
  appVersion: AppVersion;
}

export interface WidgetExecutableConfig {
  kind: "widget";
  path: string;
  appVersion: AppVersion;
  description?: string;
  dimensions: WidgetDimensions;
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
 *   import { defineConfig } from "polkadot-app-deploy";
 *   export default defineConfig({ domain: "demoapp.dot", ... });
 */
export function defineConfig<T extends ProductConfig>(config: T): T {
  return config;
}
