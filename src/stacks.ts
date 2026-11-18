// Network selection for polkadot-app-deploy, from Trinity stack descriptors.
//
// Each built-in stack ships as a signed copy in .trinity/ (bundled into the build by
// `trinity-stack generate`) plus a local policy entry in assets/stack-policy.json for what a
// descriptor does not carry. A run refreshes the selected built-in stack from its published
// descriptor once and falls back to the shipped copy.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  accept,
  decodeLink,
  fetchDescriptor,
  isTrinityStackError,
  MAX_DESCRIPTOR_BYTES,
  open,
  parse,
  sameStack,
  stackId,
  type Accepted,
  type Chain,
  type Descriptor,
  type Fetch,
  type Pointer,
} from "@parity/trinity-stack";
import { chain, service, type Bundled } from "@parity/trinity-stack/reader";
import { stacks as shippedStackCopies } from "../.trinity/index.js";
import stackPolicyFile from "../assets/stack-policy.json" with { type: "json" };
import { BUILT_IN_STACK_ORIGIN, NonRetryableError } from "./errors.js";

export type StackNetwork = "testnet" | "mainnet";

export interface PopSelfServeConfig {
  /** The label users select in the sudo.personhood.dev env dropdown, e.g. "Next V2". */
  sudoEnvLabel: string;
  /** The stack's `faucet` service, for funding the service account; absent when the stack has none. */
  faucetUrl?: string;
  /** Personhood recognition flow URL on the sudo app. */
  personhoodFaucetUrl: string;
  /** Asset-Hub alias-binding flow URL on the sudo app. */
  dotnsBootstrapUrl: string;
  /** Whether remediation messages can name the signer's alias state (not-bound, stale, wrong context). */
  stateAwareGuidance?: boolean;
}

/** What polkadot-app-deploy decides per built-in stack that a descriptor does not carry. */
export interface StackPolicy {
  aliases: string[];
  description: string;
  /** Deploys may authorize the Bulletin storage account themselves, signed by `bulletinAuthorizer`. Testnet only: ignored on a mainnet stack. */
  bulletinAutoAuthorize?: boolean;
  /** The key with TransactionStorage authorizer rights; //Alice when unset. */
  bulletinAuthorizer?: string;
  e2eEligible?: boolean;
  autoAccountMapping?: boolean;
  registerStorageDeposit?: number;
  recordStorageDeposit?: number;
  popSelfServe?: Omit<PopSelfServeConfig, "faucetUrl">;
}

export interface StackPolicyFile {
  default: string;
  stacks: Record<string, StackPolicy>;
}

const STACK_POLICY = stackPolicyFile as StackPolicyFile;

export const DEFAULT_STACK_ID: string = STACK_POLICY.default;
export const BUILT_IN_STACK_IDS: readonly string[] = Object.keys(STACK_POLICY.stacks);

export const CHAIN_ROLES = ["Bulletin", "AssetHub", "People", "Relay"] as const;
export type ChainRole = (typeof CHAIN_ROLES)[number];

/** The DotNS contract keys polkadot-app-deploy uses, by the key each has in a descriptor's `dotns` map. */
export const DOTNS_CONTRACT_KEYS = {
  DOTNS_PROTOCOL_REGISTRY: "protocolRegistry",
  DOTNS_REGISTRAR: "registrar",
  DOTNS_REGISTRAR_CONTROLLER: "controller",
  DOTNS_REGISTRY: "registry",
  DOTNS_POP_CONTROLLER: "popController",
  DOTNS_RESOLVER: "resolver",
  DOTNS_CONTENT_RESOLVER: "contentResolver",
  DOTNS_REVERSE_RESOLVER: "reverseResolver",
  DOTNS_POP_RESOLVER: "popResolver",
  DOTNS_NAME_ESCROW: "nameEscrow",
  POP_RULES: "popRules",
  STORE_FACTORY: "storeFactory",
  MULTICALL3: "multicall3",
} as const;
export type DotnsContractName = keyof typeof DOTNS_CONTRACT_KEYS;

/** The chains, services and `dotns` keys every stack must carry; buildStack rejects a stack without one. */
export const STACK_REQUIREMENTS = {
  chains: CHAIN_ROLES,
  services: ["ipfs-gateway"],
  contracts: [
    "DOTNS_PROTOCOL_REGISTRY",
    "DOTNS_REGISTRAR",
    "DOTNS_REGISTRAR_CONTROLLER",
    "DOTNS_REGISTRY",
    "DOTNS_CONTENT_RESOLVER",
    "DOTNS_POP_CONTROLLER",
    "POP_RULES",
  ] satisfies DotnsContractName[],
} as const;
export type RequiredContractName = (typeof STACK_REQUIREMENTS.contracts)[number];

export type StackContracts = Record<RequiredContractName, string> & Partial<Record<DotnsContractName, string>>;

/**
 * Where a stack's descriptor came from: the copy shipped with polkadot-app-deploy, the published
 * descriptor of a built-in stack fetched this run, or a `--stack` link, URL or file.
 */
export type CustomStackSource = "link" | "url" | "file";
export type StackSource = "shipped" | "published" | CustomStackSource;

/**
 * A built-in stack, loaded by id or through --stack with a document its key signs, or a custom
 * stack, which only --stack loads. `location` is the link, URL or path passed with --stack.
 */
export type StackOrigin =
  | { builtIn: true; source: StackSource; location?: string }
  | { builtIn: false; source: CustomStackSource; location: string };

export type Stack = StackOrigin & {
  /** A built-in id, or `<descriptor id>-<8 hex>` for any other stack. */
  id: string;
  name: string;
  description: string;
  descriptor: Descriptor;
  network: StackNetwork;
  /** The descriptor's own chain entries, by role. */
  chains: Record<ChainRole, Chain>;
  /** Path-style IPFS gateway: content is at `${ipfsGateway}${cid}`. */
  ipfsGateway: string;
  tld: string;
  contracts: StackContracts;
  autoAccountMapping: boolean;
  registerStorageDeposit?: bigint;
  recordStorageDeposit?: bigint;
  bulletinAutoAuthorize: boolean;
  bulletinAuthorizer?: string;
  e2eEligible: boolean;
  popSelfServe: PopSelfServeConfig | null;
};

/** The CLI flag that selects `stack` again, for commands printed in messages. */
export function stackSelectionFlag(stack: Pick<Stack, "id" | "location">): string {
  const { stack: source } = stackSelectionOf(stack);
  return source !== undefined ? `--stack ${source}` : `--env ${stack.id}`;
}

/** What a run asks for: a built-in stack by id or alias, or a stack link, URL or file. */
export interface StackSelection {
  env?: string;
  /** A stack link, URL or file. */
  stack?: string;
}

export interface LoadStackOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  now?: Date;
  warn?: (message: string) => void;
  /** The signed copies of the built-in stacks; the ones shipped with polkadot-app-deploy by default. */
  shipped?: Record<string, Bundled>;
}

// Genesis hashes of the Polkadot and Kusama chains a descriptor can name. A stack naming any of
// them is a mainnet stack.
export const MAINNET_GENESIS: Readonly<Record<string, string>> = {
  "0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3": "Polkadot relay chain",
  "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f": "Polkadot Asset Hub",
  "0x67fa177a097bfa18f77ea95ab56e9bcdfeb0e5b8a40e46298bb93e16b6fc5008": "Polkadot People",
  "0x2761c95259d59e55ae3daf756c1413b46e45a5a2987299f8ef8e5d8e4776cbc4": "Polkadot Bulletin",
  "0xb0a8d493285c2df73290dfb7e61f870f17b41801197a149ca93654499ea3dafe": "Kusama relay chain",
  "0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a": "Kusama Asset Hub",
  "0xc1af4cb4eb3918e5db15086c0cc5ec17fb334f728b7c65dd44bfe1e174ff8b3f": "Kusama People",
};

/** The Polkadot or Kusama chain among the descriptor's Relay, AssetHub, People and Bulletin chains; undefined when there is none. */
export function findMainnetChain(descriptor: Descriptor): string | undefined {
  return descriptor.chains
    .filter((entry) => (CHAIN_ROLES as readonly string[]).includes(entry.role))
    .map((entry) => MAINNET_GENESIS[entry.genesisHash])
    .find((name) => name !== undefined);
}

/** The policy a stack outside the built-in set gets; its network comes from its chains, as for every stack. */
export function customStackPolicy(descriptor: Descriptor): StackPolicy {
  const mainnet = findMainnetChain(descriptor);
  return {
    aliases: [],
    description: mainnet ? `${descriptor.name} (on the ${mainnet})` : descriptor.name,
    bulletinAutoAuthorize: true,
    autoAccountMapping: true,
  };
}

/** The stack a descriptor describes; fails listing every required field it lacks. */
export function buildStack(descriptor: Descriptor, settings: StackOrigin & { id: string; policy: StackPolicy }): Stack {
  const missing = [
    ...STACK_REQUIREMENTS.chains
      .filter((role) => !descriptor.chains.some((entry) => entry.role === role))
      .map((role) => `chain ${role}`),
    ...STACK_REQUIREMENTS.services
      .filter((kind) => !descriptor.services.some((entry) => entry.kind === kind))
      .map((kind) => `service ${kind}`),
    ...STACK_REQUIREMENTS.contracts
      .filter((name) => !descriptor.dotns?.[DOTNS_CONTRACT_KEYS[name]])
      .map((name) => `dotns.${DOTNS_CONTRACT_KEYS[name]}`),
  ];
  if (missing.length > 0) {
    throw new NonRetryableError(`stack ${descriptor.id} lacks ${missing.join(", ")}`);
  }
  const chains = Object.fromEntries(CHAIN_ROLES.map((role) => [role, chain(descriptor, role)])) as Record<ChainRole, Chain>;
  const network: StackNetwork = findMainnetChain(descriptor) ? "mainnet" : "testnet";
  const contracts: Partial<Record<DotnsContractName, string>> = {};
  for (const [name, key] of Object.entries(DOTNS_CONTRACT_KEYS) as [DotnsContractName, string][]) {
    const address = descriptor.dotns?.[key];
    if (address) contracts[name] = address;
  }
  const { policy, ...origin } = settings;
  const faucet = descriptor.services.find((entry) => entry.kind === "faucet")?.urls[0];
  return {
    ...origin,
    name: descriptor.name,
    description: policy.description,
    descriptor,
    network,
    chains,
    ipfsGateway: service(descriptor, "ipfs-gateway").urls[0],
    tld: descriptor.tld,
    // buildStack rejected a descriptor lacking any required contract above.
    contracts: contracts as StackContracts,
    autoAccountMapping: policy.autoAccountMapping ?? false,
    ...(policy.registerStorageDeposit !== undefined ? { registerStorageDeposit: BigInt(policy.registerStorageDeposit) } : {}),
    ...(policy.recordStorageDeposit !== undefined ? { recordStorageDeposit: BigInt(policy.recordStorageDeposit) } : {}),
    bulletinAutoAuthorize: network === "testnet" && (policy.bulletinAutoAuthorize ?? false),
    ...(policy.bulletinAuthorizer !== undefined ? { bulletinAuthorizer: policy.bulletinAuthorizer } : {}),
    e2eEligible: policy.e2eEligible ?? false,
    popSelfServe: policy.popSelfServe ? { ...policy.popSelfServe, ...(faucet ? { faucetUrl: faucet } : {}) } : null,
  };
}

/** Where a stack's values came from, as a phrase an error message can end with. */
export function describeStackOrigin(stack: Pick<Stack, "id" | "builtIn" | "source">): string {
  let via: string;
  switch (stack.source) {
    case "shipped":
      via = "shipped with polkadot-app-deploy";
      break;
    case "published":
      via = "as published by its operator";
      break;
    default:
      via = `passed with --stack as a ${stack.source}`;
  }
  return stack.builtIn ? `${BUILT_IN_STACK_ORIGIN} ${stack.id} (${via})` : `the descriptor of stack ${stack.id} (${via})`;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** The built-in stack `value` is an id or alias of, case-insensitively; undefined when there is none. */
export function findBuiltInStackId(value: string): string | undefined {
  const token = value.trim().toLowerCase();
  return BUILT_IN_STACK_IDS.find(
    (id) => id === token || STACK_POLICY.stacks[id].aliases.some((alias) => alias.toLowerCase() === token),
  );
}

// Names the move to stack descriptors removed, with what to use instead. Delete in a later release.
export const RETIRED_SELECTION_ERRORS = {
  env: {
    "paseo-next": "environment 'paseo-next' was retired (its Bulletin chain no longer runs); use --env paseo-next-v2",
    "paseo-review": "environment 'paseo-review' was retired (its Bulletin chain no longer runs); use --env paseo-next-v2",
    kusama: "environment 'kusama' has no Bulletin chain; use --env polkadot or pass a stack with --stack",
    "polkadot-test": "environment 'polkadot-test' has no published stack descriptor yet; pass it with --stack <descriptor file or link>",
    custom: "environment 'custom' was removed; pass a stack descriptor via --stack <descriptor file>",
  } as Record<string, string>,
  environmentFile: "--environment-file was removed; pass the network with --stack <descriptor file>",
  contract: "--contract was removed; pass a stack descriptor with your contract addresses via --stack <descriptor file>",
  /** Library options of deploy() and publishManifest(), by option name. */
  options: {
    contracts: 'contracts was removed; pass a stack descriptor with your contract addresses via stack: "<descriptor file, URL or link>"',
    bulletinEndpoints: 'bulletinEndpoints was removed; pass a stack descriptor with your Bulletin endpoints via stack: "<descriptor file, URL or link>"',
    assetHubEndpoints: 'assetHubEndpoints was removed; pass a stack descriptor with your Asset Hub endpoints via stack: "<descriptor file, URL or link>"',
  },
} as const;

function resolveBuiltInStackId(value: string): string {
  const token = value.trim().toLowerCase();
  if (Object.hasOwn(RETIRED_SELECTION_ERRORS.env, token)) throw new NonRetryableError(RETIRED_SELECTION_ERRORS.env[token]);
  const id = findBuiltInStackId(value);
  if (id) return id;
  const candidates = BUILT_IN_STACK_IDS.flatMap((builtIn) => [builtIn, ...STACK_POLICY.stacks[builtIn].aliases]);
  const closest = candidates
    .map((name) => ({ name, distance: levenshtein(value.toLowerCase(), name.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance)[0];
  const hint = closest && closest.distance <= Math.max(2, Math.floor(value.length / 3)) ? ` Did you mean '${closest.name}'?` : "";
  throw new NonRetryableError(
    `Unknown environment '${value}'. Valid: ${BUILT_IN_STACK_IDS.join(", ")}, or pass a stack with --stack.${hint}`,
  );
}

function builtInStack(id: string, descriptor: Descriptor, source: StackSource, location?: string): Stack {
  return buildStack(descriptor, {
    id,
    builtIn: true,
    source,
    ...(location !== undefined ? { location } : {}),
    policy: STACK_POLICY.stacks[id],
  });
}

function shippedCopy(id: string, shipped: Record<string, Bundled>): Bundled {
  const copy = shipped[id];
  if (!copy) throw new NonRetryableError(`no shipped copy of stack ${id}; add it with trinity-stack add`);
  return copy;
}

const encode = (text: string) => new TextEncoder().encode(text);

/** A built-in stack from its shipped copy, without fetching. */
export function readShippedStack(idOrAlias: string, shipped: Record<string, Bundled> = shippedStackCopies): Stack {
  const id = resolveBuiltInStackId(idOrAlias);
  return builtInStack(id, parse(encode(shippedCopy(id, shipped).document)).descriptor, "shipped");
}

// The time `seconds` encodes, as ISO text, when `now` is at or past it.
function passedTime(seconds: number | undefined, now: Date): string | undefined {
  return seconds !== undefined && now.getTime() / 1000 >= seconds ? new Date(seconds * 1000).toISOString() : undefined;
}

// Fails when `stack` is past its `expiresAt`; warns when it is past its `validUntil`.
function assertCurrent(stack: Stack, options: LoadStackOptions): Stack {
  const now = options.now ?? new Date();
  const expiredAt = passedTime(stack.descriptor.expiresAt, now);
  if (expiredAt) throw new NonRetryableError(`stack ${stack.id} expired at ${expiredAt}`);
  const staleAt = passedTime(stack.descriptor.validUntil, now);
  if (staleAt) (options.warn ?? console.error)(`polkadot-app-deploy: stack ${stack.id} is past its validUntil (${staleAt}) and may be outdated.`);
  return stack;
}

// Fetches the published descriptor once and uses it when it verifies, is not older than the
// shipped copy and has every required field; otherwise the shipped copy, with a warning.
async function refreshBuiltInStack(id: string, options: LoadStackOptions): Promise<Stack> {
  const shipped = shippedCopy(id, options.shipped ?? shippedStackCopies);
  const now = options.now ?? new Date();
  const fallback = (reason: string) => {
    const { descriptor } = parse(encode(shipped.document));
    (options.warn ?? console.error)(`polkadot-app-deploy: ${reason}; using the copy of stack ${id} shipped with polkadot-app-deploy (sequence ${descriptor.sequence}).`);
    return builtInStack(id, descriptor, "shipped");
  };
  const publishedDocument = await fetchDescriptor(shipped.pointer.url, { fetch: options.fetch, timeoutMs: options.timeoutMs });
  const accepted = accept(shipped.pointer, encode(shipped.document), publishedDocument, now);
  switch (accepted.status) {
    case "updated":
      try {
        return builtInStack(id, accepted.descriptor, "published");
      } catch (error) {
        return fallback(`the published descriptor of stack ${id} is unusable: ${(error as Error).message}`);
      }
    case "unchanged":
      return builtInStack(id, accepted.descriptor, "published");
    case "unreachable":
      return fallback(`could not fetch the published descriptor of stack ${id} from ${shipped.pointer.url}`);
    default:
      return fallback(`the published descriptor of stack ${id} ${describeRejection(accepted)}`);
  }
}

// Why `accept` rejected a document against the shipped copy, whose sequence `accepted.descriptor`
// carries; undefined when it took the document.
function describeRejection(accepted: Accepted): string | undefined {
  switch (accepted.status) {
    case "rollback":
      return `has a sequence below the shipped copy's ${accepted.descriptor.sequence}`;
    case "conflict":
      return `has the shipped copy's sequence ${accepted.descriptor.sequence} with other content`;
    case "refused":
      return `breaks the rule ${accepted.refused}`;
    default:
      return undefined;
  }
}

const LINK_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

// The built-in stack whose key signs `document`. A link that carries its own key matches only
// the built-in stack with that key.
function findBuiltInCopy(document: Uint8Array, pointer: Pointer | undefined, shipped: Record<string, Bundled>) {
  for (const id of BUILT_IN_STACK_IDS) {
    const copy = shipped[id];
    if (!copy || (pointer?.key && !sameStack(pointer, copy.pointer))) continue;
    try {
      if (open(document, copy.pointer).signed) return { id, copy };
    } catch (error) {
      if (!isTrinityStackError(error)) throw error;
    }
  }
  return undefined;
}

function loadBuiltInCopy(
  builtIn: { id: string; copy: Bundled },
  document: Uint8Array,
  source: CustomStackSource,
  location: string,
  now: Date,
): Stack {
  const accepted = accept(builtIn.copy.pointer, encode(builtIn.copy.document), document, now);
  const rejection = describeRejection(accepted);
  if (rejection) throw new Error(`the descriptor ${rejection}`);
  return builtInStack(builtIn.id, accepted.descriptor, source, location);
}

// The id goes into filenames, telemetry, DotNS commitment records and the per-name lock, so it
// is reduced to a-z, 0-9 and "-", and suffixed with a hash of what identifies the stack (the
// link's key; else the descriptor id and its chains' genesis hashes, which stay the same across
// republishes and across a file and a URL), so it never equals a built-in id.
function loadCustomStack(document: Uint8Array, pointer: Pointer | undefined, source: CustomStackSource, location: string): Stack {
  const { descriptor } = pointer?.key ? open(document, pointer) : parse(document);
  const identity = pointer?.key
    ? stackId(pointer)
    : JSON.stringify([descriptor.id, ...descriptor.chains.map((entry) => `${entry.role}:${entry.genesisHash}`).sort()]);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8);
  const name = descriptor.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "stack";
  return buildStack(descriptor, { id: `${name}-${hash}`, builtIn: false, source, location, policy: customStackPolicy(descriptor) });
}

/**
 * The stack at `source`: a `polkadotapp://stack` link (or another link carrying a pointer),
 * fetched and checked against its key; a descriptor URL, fetched without a signature check; or a
 * descriptor file, read without a signature check. A document signed with a built-in stack's key
 * loads as that built-in stack, and fails when it is older than the shipped copy, conflicts with
 * it, or breaks a descriptor rule. Fails when the source is malformed or unreachable, the stack
 * lacks a required field, or it is past its `expiresAt`.
 */
export async function loadStackSource(source: string, options: LoadStackOptions = {}): Promise<Stack> {
  const value = source.trim();
  const now = options.now ?? new Date();
  let pointer: Pointer | undefined;
  let kind: CustomStackSource = "file";
  let document: Uint8Array;
  try {
    if (LINK_PATTERN.test(value)) {
      const isLink = new URL(value).searchParams.has("url");
      pointer = isLink ? decodeLink(value) : { url: value };
      kind = isLink ? "link" : "url";
    }
    const bytes = pointer
      ? await fetchDescriptor(pointer.url, { fetch: options.fetch, timeoutMs: options.timeoutMs })
      : await readFile(value);
    if (!bytes) {
      throw new Error(
        `${pointer!.url} is unreachable: a network error, a non-2xx status, a redirect (not followed), a timeout or a body over ${MAX_DESCRIPTOR_BYTES} bytes`,
      );
    }
    document = bytes;
  } catch (error) {
    throw new NonRetryableError(`failed to read stack '${value}': ${(error as Error).message}`);
  }
  let stack: Stack;
  try {
    const builtIn = findBuiltInCopy(document, pointer, options.shipped ?? shippedStackCopies);
    stack = builtIn
      ? loadBuiltInCopy(builtIn, document, kind, value, now)
      : loadCustomStack(document, pointer, kind, value);
  } catch (error) {
    throw new NonRetryableError(`stack '${value}' is unusable: ${(error as Error).message}`);
  }
  return assertCurrent(stack, options);
}

// One load per selection per process, so the CLI and the library calls it makes fetch a
// descriptor once. A failed load is dropped so the next call retries it.
const stackLoads = new Map<string, Promise<Stack>>();

/**
 * The stack a run uses: `selection.stack` through `loadStackSource`, else the built-in stack
 * `selection.env` (default `DEFAULT_STACK_ID`) refreshed from its published descriptor. Returns
 * the stack loaded earlier in the process for the same selection, unless `options` carries
 * `fetch`, `shipped` or `now`. Fails when PAD_ENV_FILE is set, when both `env` and
 * `stack` are set, and when the stack is past its `expiresAt`.
 */
export async function loadStack(selection: StackSelection = {}, options: LoadStackOptions = {}): Promise<Stack> {
  if (process.env.PAD_ENV_FILE) throw new NonRetryableError(RETIRED_SELECTION_ERRORS.environmentFile);
  if (selection.stack !== undefined && selection.env !== undefined) {
    throw new NonRetryableError("--stack and --env both select the network; pass one of them");
  }
  if (selection.stack !== undefined && typeof selection.stack !== "string") {
    throw new NonRetryableError("stack must be a stack descriptor file, URL or link");
  }
  const source = selection.stack?.trim();
  const id = source === undefined ? resolveBuiltInStackId(selection.env ?? DEFAULT_STACK_ID) : undefined;
  const load = () => (source !== undefined
    ? loadStackSource(source, options)
    : refreshBuiltInStack(id!, options).then((stack) => assertCurrent(stack, options)));
  if (options.fetch || options.shipped || options.now) return load();
  const key = source !== undefined ? `stack:${source}` : `env:${id}`;
  let loaded = stackLoads.get(key);
  if (!loaded) {
    loaded = load();
    stackLoads.set(key, loaded);
    loaded.catch(() => stackLoads.delete(key));
  }
  return loaded;
}

/** The selection that loads `stack` again; `loadStack` returns the same object for it. */
export function stackSelectionOf(stack: Pick<Stack, "id" | "location">): StackSelection {
  return stack.location !== undefined ? { stack: stack.location } : { env: stack.id };
}

/**
 * The selection a CLI run makes: a flag wins over an environment variable; `--stack` with
 * `--env`, or PAD_STACK with PAD_ENV and neither flag, is an error.
 */
export function resolveStackSelection(inputs: {
  flagEnv?: string;
  flagStack?: string;
  envVarEnv?: string;
  envVarStack?: string;
}): StackSelection {
  const pick = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);
  const [flagEnv, flagStack] = [pick(inputs.flagEnv), pick(inputs.flagStack)];
  if (flagEnv && flagStack) throw new NonRetryableError("--stack and --env both select the network; pass one of them");
  if (flagStack) return { stack: flagStack };
  if (flagEnv) return { env: flagEnv };
  const [envVarEnv, envVarStack] = [pick(inputs.envVarEnv), pick(inputs.envVarStack)];
  if (envVarEnv && envVarStack) {
    throw new NonRetryableError("PAD_STACK and PAD_ENV both select the network; set one of them");
  }
  if (envVarStack) return { stack: envVarStack };
  return envVarEnv ? { env: envVarEnv } : {};
}

/**
 * Fails listing every problem with the shipped copies and the policy file that does not depend
 * on the date: a missing copy, a copy without a policy entry, a copy that does not verify under
 * its link's key or lacks a required field, a policy `default` without an entry, and a deposit
 * that is not a safe integer. The build runs it.
 */
export function assertShippedStacks(
  shipped: Record<string, Bundled> = shippedStackCopies,
  policyFile: StackPolicyFile = STACK_POLICY,
): void {
  const problems: string[] = [];
  if (!policyFile.stacks[policyFile.default]) {
    problems.push(`default: ${policyFile.default} has no entry in assets/stack-policy.json`);
  }
  for (const id of new Set([...Object.keys(policyFile.stacks), ...Object.keys(shipped)])) {
    try {
      const policy = policyFile.stacks[id];
      if (!policy) throw new Error("has no entry in assets/stack-policy.json");
      for (const field of ["registerStorageDeposit", "recordStorageDeposit"] as const) {
        const deposit = policy[field];
        if (deposit !== undefined && !Number.isSafeInteger(deposit)) {
          throw new Error(`${field} ${JSON.stringify(deposit)} in assets/stack-policy.json is not a safe integer`);
        }
      }
      const copy = shippedCopy(id, shipped);
      const { descriptor } = open(encode(copy.document), copy.pointer);
      buildStack(descriptor, { id, builtIn: true, source: "shipped", policy });
    } catch (error) {
      problems.push(`${id}: ${(error as Error).message}`);
    }
  }
  if (problems.length > 0) throw new Error(`unusable stack copies in .trinity:\n  ${problems.join("\n  ")}`);
}

/**
 * Returns one warning per shipped copy past its `validUntil` at `now`, and fails listing every
 * copy past its `expiresAt` or unreadable. Not part of the build: a copy going stale must not
 * break installs, including the job that refreshes it.
 */
export function assertShippedStacksUnexpired(shipped: Record<string, Bundled> = shippedStackCopies, now: Date = new Date()): string[] {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const [id, copy] of Object.entries(shipped)) {
    try {
      const { validUntil, expiresAt } = parse(encode(copy.document)).descriptor;
      const expiredAt = passedTime(expiresAt, now);
      if (expiredAt) throw new Error(`expired at ${expiredAt}`);
      const staleAt = passedTime(validUntil, now);
      if (staleAt) warnings.push(`stack copy ${id} in .trinity is past its validUntil ${staleAt} (run npx trinity-stack update)`);
    } catch (error) {
      problems.push(`${id}: ${(error as Error).message}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`expired stack copies in .trinity (run npx trinity-stack update):\n  ${problems.join("\n  ")}`);
  }
  return warnings;
}

export interface StackListing {
  id: string;
  name: string;
  network: StackNetwork;
  aliases: string;
  description: string;
}

/** Each built-in stack, from its shipped copy. */
export function listStacks(shipped: Record<string, Bundled> = shippedStackCopies): StackListing[] {
  return BUILT_IN_STACK_IDS.map((id) => {
    const stack = readShippedStack(id, shipped);
    return {
      id,
      name: stack.name,
      network: stack.network,
      aliases: STACK_POLICY.stacks[id].aliases.join(", "),
      description: stack.description,
    };
  });
}

export function formatStackTable(rows: StackListing[]): string {
  const headers = ["ID", "Name", "Network", "Aliases", "Description"];
  const data = rows.map((row) => [row.id, row.name, row.network, row.aliases, row.description]);
  const widths = headers.map((header, index) => Math.max(header.length, ...data.map((row) => row[index].length)));
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [formatRow(headers), widths.map((width) => "-".repeat(width)).join("  "), ...data.map(formatRow)].join("\n");
}
