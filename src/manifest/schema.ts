/**
 * Handwritten validators for product-manifest shapes.
 *
 * Domain validation is shape-only. It mirrors dotNS label rules without
 * importing the chain-aware [`parseDomainName`](../dotns.ts) helper, so the
 * module stays free of the polkadot-api dep. Authoritative ownership and
 * eligibility checks happen at publish-time preflight in
 * [`publish.ts`](./publish.ts).
 */

import type {
  AppVersion,
  ExecutableManifest,
  FundingMode,
  IconFormat,
  ProductConfig,
  RootManifest,
} from "./types.js";

export interface ValidationOk<T> {
  ok: true;
  value: T;
}

export interface ValidationErr {
  ok: false;
  errors: string[];
}

export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

const ICON_FORMATS: readonly IconFormat[] = ["jpeg", "png"];
const KIND_APP = "app";
const KIND_WIDGET = "widget";
const KIND_FUNDING = "funding";
const KIND_WORKER = "worker";
const EXECUTABLE_KINDS = [KIND_APP, KIND_WIDGET, KIND_FUNDING, KIND_WORKER] as const satisfies readonly ExecutableManifest["kind"][];
// Strict on the publishing side: Hosts ignore unrecognised modes, publishers MUST NOT emit them.
const FUNDING_MODES: readonly FundingMode[] = ["CARD", "BANK", "CRYPTO"];

/** dotNS label rule: 1 to 63 chars of `[a-z0-9-]`, no leading or trailing hyphen. */
const LABEL = String.raw`(?!-)[a-z0-9-]{1,63}(?<!-)`;
// Mirrors src/dotns.ts's KNOWN_TLDS without importing that chain-aware module
// (see the file doc comment above: this validator stays free of the
// polkadot-api dep). DotNS's TLD is per-environment — paseo-next-v2 uses
// ".paseo" — so a hardcoded ".dot$" here would reject every valid
// paseo-next-v2 product config outright. Keep this list in sync with
// dotns.ts's KNOWN_TLDS by hand; test/test.js asserts the two never drift.
const KNOWN_TLDS = ["dot", "paseo"] as const;
const DOMAIN_RE = new RegExp(`^${LABEL}(\\.${LABEL})*\\.(?:${KNOWN_TLDS.join("|")})$`, "i");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAppVersion(value: unknown): value is AppVersion {
  if (!Array.isArray(value)) return false;
  if (value.length !== 3 && value.length !== 4) return false;
  if (!value.slice(0, 3).every(n => Number.isSafeInteger(n) && (n as number) >= 0)) {
    return false;
  }
  if (value.length === 4 && !isNonEmptyString(value[3])) return false;
  return true;
}

function rejectUnknownFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): string[] {
  return Object.keys(input)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${prefix}contains unknown field '${key}'`);
}

function validateRelativeEntrypoint(
  value: unknown,
  suffix: string,
  prefix: string,
): string[] {
  if (!isNonEmptyString(value)) return [`${prefix}entrypoint must be a non-empty string`];
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return [`${prefix}entrypoint must be a relative path with no empty, '.', or '..' segments`];
  }
  if (!value.toLowerCase().endsWith(suffix)) {
    return [`${prefix}entrypoint must end with ${suffix}`];
  }
  return [];
}

function validateRequiredFeatures(
  value: unknown,
  allowed: readonly string[],
  prefix: string,
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((feature) => typeof feature !== "string") ||
    new Set(value).size !== value.length
  ) {
    return [`${prefix}requiredFeatures must be an array of unique strings`];
  }
  const unknown = value.filter((feature) => !allowed.includes(feature as string));
  return unknown.map(
    (feature) => `${prefix}requiredFeatures contains unsupported feature ${JSON.stringify(feature)}`,
  );
}

const GRAPHICS_PROFILES = ["framebuffer", "tri2d", "webgpu-raster"] as const;
const DEVICE_INPUT_FEATURES = [
  "pointer",
  "keyboard",
  "touch",
  "wheel",
  "text",
  "ime",
  "focus",
] as const;
const GPU_LIMIT_CEILINGS: Readonly<Record<string, number>> = {
  maxTextureDimension2D: 4096,
  maxBufferSize: 16 * 1024 * 1024,
  maxBindingsPerBindGroup: 16,
  maxBindGroups: 4,
  maxVertexBuffers: 8,
  maxVertexAttributes: 16,
  maxColorAttachments: 4,
};

function validateGraphicsRequirement(value: unknown, prefix: string): string[] {
  if (!isPlainObject(value)) return [`${prefix}graphics must be an object`];
  const errors = rejectUnknownFields(
    value,
    ["abiVersion", "profile", "requiredFeatures", "requiredLimits"],
    `${prefix}graphics `,
  );
  if (value.abiVersion !== 1) errors.push(`${prefix}graphics.abiVersion must be 1`);
  if (!GRAPHICS_PROFILES.includes(value.profile as (typeof GRAPHICS_PROFILES)[number])) {
    errors.push(`${prefix}graphics.profile must be one of ${GRAPHICS_PROFILES.join(", ")}`);
  }
  errors.push(...validateRequiredFeatures(value.requiredFeatures, [], `${prefix}graphics.`));
  if (value.requiredLimits !== undefined) {
    if (value.profile !== "webgpu-raster" || !isPlainObject(value.requiredLimits)) {
      errors.push(
        `${prefix}graphics.requiredLimits requires the webgpu-raster profile and an object value`,
      );
    } else {
      for (const [key, minimum] of Object.entries(value.requiredLimits)) {
        const ceiling = GPU_LIMIT_CEILINGS[key];
        if (
          ceiling === undefined ||
          !Number.isSafeInteger(minimum) ||
          (minimum as number) <= 0 ||
          (minimum as number) > ceiling
        ) {
          errors.push(`${prefix}graphics.requiredLimits.${key} is unsupported or outside its profile ceiling`);
        }
      }
    }
  }
  return errors;
}

function validateOptionalCapability(
  value: unknown,
  allowedFeatures: readonly string[],
  prefix: string,
): string[] {
  if (!isPlainObject(value)) return [`${prefix}must be an object`];
  const errors = rejectUnknownFields(value, ["abiVersion", "requiredFeatures"], prefix);
  if (value.abiVersion !== 1) errors.push(`${prefix}abiVersion must be 1`);
  errors.push(...validateRequiredFeatures(value.requiredFeatures, allowedFeatures, prefix));
  return errors;
}

function validateAppV2(input: Record<string, unknown>, prefix: string): string[] {
  const runtime = input.runtime;
  if (!isPlainObject(runtime)) return [`${prefix}runtime must be an object`];

  const commonErrors = isAppVersion(input.appVersion)
    ? []
    : [`${prefix}appVersion must be [major, minor, patch] or [major, minor, patch, build]`];

  if (runtime.kind === "web") {
    return [
      ...commonErrors,
      ...rejectUnknownFields(input, ["$v", "kind", "appVersion", "runtime"], prefix),
      ...rejectUnknownFields(runtime, ["kind", "entrypoint"], `${prefix}runtime `),
      ...validateRelativeEntrypoint(runtime.entrypoint, ".html", `${prefix}runtime.`),
    ];
  }

  if (runtime.kind !== "polkavm") {
    return [...commonErrors, `${prefix}runtime.kind must be web or polkavm`];
  }

  const errors = [
    ...commonErrors,
    ...rejectUnknownFields(input, ["$v", "kind", "appVersion", "runtime", "capabilities"], prefix),
    ...rejectUnknownFields(runtime, ["kind", "abiVersion", "entrypoint"], `${prefix}runtime `),
    ...validateRelativeEntrypoint(runtime.entrypoint, ".polkavm", `${prefix}runtime.`),
  ];
  if (runtime.abiVersion !== 1) errors.push(`${prefix}runtime.abiVersion must be 1`);
  if (!isPlainObject(input.capabilities)) {
    errors.push(`${prefix}capabilities must be an object`);
    return errors;
  }
  const capabilities = input.capabilities;
  errors.push(
    ...rejectUnknownFields(capabilities, ["graphics", "deviceInput", "audio"], `${prefix}capabilities `),
  );
  errors.push(...validateGraphicsRequirement(capabilities.graphics, `${prefix}capabilities.`));
  if (capabilities.deviceInput !== undefined) {
    errors.push(
      ...validateOptionalCapability(
        capabilities.deviceInput,
        DEVICE_INPUT_FEATURES,
        `${prefix}capabilities.deviceInput.`,
      ),
    );
  }
  if (capabilities.audio !== undefined) {
    errors.push(
      ...validateOptionalCapability(capabilities.audio, [], `${prefix}capabilities.audio.`),
    );
  }
  return errors;
}

function validateWidgetFields(input: Record<string, unknown>, p: string): string[] {
  const errors: string[] = [];
  if ("description" in input && input.description !== undefined && typeof input.description !== "string") {
    errors.push(`${p}description must be a string when present`);
  }
  if (!isPlainObject(input.dimensions)) {
    errors.push(`${p}dimensions must be an object`);
    return errors;
  }
  const dims = input.dimensions;
  if (!Array.isArray(dims.height) || dims.height.length === 0 ||
      !dims.height.every(h => typeof h === "number" && Number.isInteger(h) && h >= 0)) {
    errors.push(`${p}dimensions.height must be a non-empty array of non-negative integers`);
  }
  if ("width" in dims && dims.width !== undefined &&
      !(typeof dims.width === "number" && Number.isInteger(dims.width) && dims.width > 0)) {
    errors.push(`${p}dimensions.width must be a positive integer when present`);
  }
  return errors;
}

function validateFundingFields(input: Record<string, unknown>, p: string): string[] {
  if (!Array.isArray(input.modes) || input.modes.length === 0) {
    return [`${p}modes must be a non-empty array`];
  }
  return input.modes
    .filter(mode => !FUNDING_MODES.includes(mode as FundingMode))
    .map(mode => `${p}modes entries must be one of ${FUNDING_MODES.join(", ")} (got ${JSON.stringify(mode)})`);
}

function validateWorkerFields(input: Record<string, unknown>, p: string): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input.entrypoint)) {
    errors.push(`${p}entrypoint must be a non-empty string`);
  } else if (input.entrypoint.startsWith("/") || input.entrypoint.split("/").includes("..")) {
    errors.push(`${p}entrypoint must be a relative path with no '..' segments`);
  }
  if (!isPlainObject(input.includes)) {
    errors.push(`${p}includes must be an object`);
    return errors;
  }
  const inc = input.includes;
  if (typeof inc.chat !== "boolean") errors.push(`${p}includes.chat must be a boolean`);
  if (typeof inc.pocket !== "boolean") errors.push(`${p}includes.pocket must be a boolean`);
  if (inc.chat === false && inc.pocket === false) {
    errors.push(`${p}includes must have at least one of chat / pocket = true`);
  }
  return errors;
}

/** Validate a `RootManifest` JSON value read from a dotNS `manifest` text record. */
export function validateRootManifest(input: unknown): ValidationResult<RootManifest> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["root manifest must be an object"] };
  }
  if (input.$v !== 1) errors.push(`root manifest $v must be 1 (got ${JSON.stringify(input.$v)})`);
  if (!isNonEmptyString(input.displayName)) errors.push("root manifest displayName must be a non-empty string");
  if (typeof input.description !== "string") errors.push("root manifest description must be a string");
  if (!isPlainObject(input.icon)) {
    errors.push("root manifest icon must be an object");
  } else {
    if (!isNonEmptyString(input.icon.cid)) errors.push("root manifest icon.cid must be a non-empty string");
    if (!ICON_FORMATS.includes(input.icon.format as IconFormat)) {
      errors.push(`root manifest icon.format must be one of ${ICON_FORMATS.join(", ")} (got ${JSON.stringify(input.icon.format)})`);
    }
  }
  return errors.length === 0 ? { ok: true, value: input as unknown as RootManifest } : { ok: false, errors };
}

/** Validate an `ExecutableManifest` JSON value (one of `app | widget | funding | worker`). */
export function validateExecutableManifest(input: unknown): ValidationResult<ExecutableManifest> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["executable manifest must be an object"] };
  }
  const kind = input.kind;
  const p = "executable manifest ";
  if (kind === KIND_APP && input.$v === 2) {
    errors.push(...validateAppV2(input, p));
  } else {
    if (input.$v !== 1) errors.push(`executable manifest $v must be 1 (got ${JSON.stringify(input.$v)})`);
    if (!isAppVersion(input.appVersion)) {
      errors.push("executable manifest appVersion must be [major, minor, patch] or [major, minor, patch, build]");
    }
    if (kind === KIND_APP) {
      errors.push(...rejectUnknownFields(input, ["$v", "kind", "appVersion"], p));
    } else if (kind === KIND_WIDGET) {
      errors.push(...validateWidgetFields(input, p));
    } else if (kind === KIND_FUNDING) {
      errors.push(...validateFundingFields(input, p));
    } else if (kind === KIND_WORKER) {
      errors.push(...validateWorkerFields(input, p));
    } else {
      errors.push(`${p}kind must be one of ${EXECUTABLE_KINDS.join(", ")} (got ${JSON.stringify(kind)})`);
    }
  }
  return errors.length === 0 ? { ok: true, value: input as unknown as ExecutableManifest } : { ok: false, errors };
}

/** Validate a `polkadot-app-deploy.config.ts` default export. */
export function validateProductConfig(input: unknown): ValidationResult<ProductConfig> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["product config must be an object (did you forget `export default`?)"] };
  }
  if (!isNonEmptyString(input.domain) || !DOMAIN_RE.test(input.domain)) {
    errors.push(`product config domain must be a non-empty dotNS name ending in one of: ${KNOWN_TLDS.map(t => `.${t}`).join(", ")}`);
  }
  if (!isNonEmptyString(input.displayName)) errors.push("product config displayName must be a non-empty string");
  if (typeof input.description !== "string") errors.push("product config description must be a string");
  if (!isPlainObject(input.icon)) {
    errors.push("product config icon must be an object");
  } else {
    if (!isNonEmptyString(input.icon.path)) errors.push("product config icon.path must be a non-empty string");
    if (!ICON_FORMATS.includes(input.icon.format as IconFormat)) {
      errors.push(`product config icon.format must be one of ${ICON_FORMATS.join(", ")}`);
    }
  }
  if (!Array.isArray(input.executables) || input.executables.length === 0) {
    errors.push("product config executables must be a non-empty array");
  } else {
    const seenKinds = new Set<string>();
    input.executables.forEach((exec, index) => {
      errors.push(...validateExecutableConfig(exec, index));
      if (isPlainObject(exec) && typeof exec.kind === "string") {
        if (seenKinds.has(exec.kind)) errors.push(`executables[${index}]: duplicate kind '${exec.kind}'`);
        seenKinds.add(exec.kind);
      }
    });
  }
  return errors.length === 0 ? { ok: true, value: input as unknown as ProductConfig } : { ok: false, errors };
}

function validateExecutableConfig(input: unknown, index: number): string[] {
  const p = `executables[${index}].`;
  if (!isPlainObject(input)) return [`executables[${index}] must be an object`];
  const errors: string[] = [];
  if (!isNonEmptyString(input.path)) errors.push(`${p}path must be a non-empty string`);
  const kind = input.kind;
  if (kind === KIND_APP) {
    const hasAppVersion = input.appVersion !== undefined;
    const hasManifest = input.manifest !== undefined;
    if (hasAppVersion === hasManifest) {
      errors.push(`${p}must declare exactly one of appVersion (App v1) or manifest (App v2)`);
    } else if (hasAppVersion && !isAppVersion(input.appVersion)) {
      errors.push(`${p}appVersion must be [major, minor, patch] or [major, minor, patch, build]`);
    } else if (hasManifest) {
      const result = validateExecutableManifest(input.manifest);
      if (!result.ok) {
        errors.push(...result.errors.map((error) => `${p}manifest: ${error}`));
      } else if (result.value.kind !== KIND_APP || result.value.$v !== 2) {
        errors.push(`${p}manifest must be an App manifest with $v 2`);
      }
    }
  } else {
    if (!isAppVersion(input.appVersion)) {
      errors.push(`${p}appVersion must be [major, minor, patch] or [major, minor, patch, build]`);
    }
    if (kind === KIND_WIDGET) {
      errors.push(...validateWidgetFields(input, p));
    } else if (kind === KIND_FUNDING) {
      errors.push(...validateFundingFields(input, p));
    } else if (kind === KIND_WORKER) {
      errors.push(...validateWorkerFields(input, p));
    } else {
      errors.push(`${p}kind must be one of ${EXECUTABLE_KINDS.join(", ")} (got ${JSON.stringify(kind)})`);
    }
  }
  return errors;
}
