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
const KIND_WORKER = "worker";
const EXECUTABLE_KINDS = [KIND_APP, KIND_WIDGET, KIND_WORKER] as const satisfies readonly ExecutableManifest["kind"][];

/** dotNS label rule: 1 to 63 chars of `[a-z0-9-]`, no leading or trailing hyphen. */
const LABEL = String.raw`(?!-)[a-z0-9-]{1,63}(?<!-)`;
const DOMAIN_RE = new RegExp(`^${LABEL}(\\.${LABEL})*\\.dot$`, "i");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAppVersion(value: unknown): value is AppVersion {
  if (!Array.isArray(value)) return false;
  if (value.length !== 3 && value.length !== 4) return false;
  if (!value.slice(0, 3).every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
    return false;
  }
  if (value.length === 4 && typeof value[3] !== "string") return false;
  return true;
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

/** Validate an `ExecutableManifest` JSON value (one of `app | widget | worker`). */
export function validateExecutableManifest(input: unknown): ValidationResult<ExecutableManifest> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["executable manifest must be an object"] };
  }
  if (input.$v !== 1) errors.push(`executable manifest $v must be 1 (got ${JSON.stringify(input.$v)})`);
  if (!isAppVersion(input.appVersion)) {
    errors.push("executable manifest appVersion must be [major, minor, patch] or [major, minor, patch, build]");
  }
  const kind = input.kind;
  const p = "executable manifest ";
  if (kind === KIND_APP) {
    // App has no kind-specific fields beyond the common ones.
  } else if (kind === KIND_WIDGET) {
    errors.push(...validateWidgetFields(input, p));
  } else if (kind === KIND_WORKER) {
    errors.push(...validateWorkerFields(input, p));
  } else {
    errors.push(`${p}kind must be one of ${EXECUTABLE_KINDS.join(", ")} (got ${JSON.stringify(kind)})`);
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
    errors.push("product config domain must be a non-empty dotNS name ending in .dot");
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
  if (!isAppVersion(input.appVersion)) {
    errors.push(`${p}appVersion must be [major, minor, patch] or [major, minor, patch, build]`);
  }
  const kind = input.kind;
  if (kind === KIND_APP) {
    // App has no kind-specific fields beyond the common ones.
  } else if (kind === KIND_WIDGET) {
    errors.push(...validateWidgetFields(input, p));
  } else if (kind === KIND_WORKER) {
    errors.push(...validateWorkerFields(input, p));
  } else {
    errors.push(`${p}kind must be one of ${EXECUTABLE_KINDS.join(", ")} (got ${JSON.stringify(kind)})`);
  }
  return errors;
}
