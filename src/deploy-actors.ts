// Decides WHO signs a deploy and WHO receives the name, for the
// zero-mobile-signature flow. Composes the vendored resolveSigner with the
// session-address lookup. Testnet-only default-to-Alice; mainnet deferred.
import { resolveSigner } from "./auth/index.js";
import type { ResolvedSigner, AuthClient, AllocatableResource } from "./auth/index.js";
import type { PolkadotSigner } from "polkadot-api";
import { BULLETIN_RESOURCE } from "./auth/index.js";
import { DOT_PRODUCT_ID } from "./auth-config.js";
import { DEFAULT_MNEMONIC } from "./dotns.js";

/** Default worker on testnet when no --mnemonic/--suri is supplied: the repo's
 *  default dev mnemonic. Its bare root (no derivation) is the funded, PopFull,
 *  bulletin-authorized "Alice" the rest of the tooling uses (SS58 5DfhGyQ…) —
 *  NOT the `//Alice` derivation (5GrwvaEF…), which is a distinct NoStatus
 *  account on the testnets. resolveSigner treats a full mnemonic phrase as a
 *  seed (root key), so this resolves to 5DfhGyQ…. */
const DEFAULT_WORKER_SURI = DEFAULT_MNEMONIC;

export class MainnetDefaultWorkerError extends Error {
  constructor() {
    super(
      "Refusing to default the deploy worker to Alice on a non-testnet environment. " +
      "Pass --mnemonic <a funded, sufficiently-verified key> to do the transfer flow, " +
      "or --no-transfer-to-signedin-user to sign directly with your mobile session.",
    );
    this.name = "MainnetDefaultWorkerError";
  }
}

export interface DeployActors {
  worker: ResolvedSigner;
  /** Set ⇔ transfer-mode is active (signed in && transfer enabled). */
  recipientH160?: string;
}

export interface ResolveDeployActorsOptions {
  suri?: string;
  transferEnabled: boolean;
  isTestnet: boolean;
  sessionPresent: boolean;
}

export async function resolveDeployActors(
  authClient: AuthClient,
  { suri, transferEnabled, isTestnet, sessionPresent }: ResolveDeployActorsOptions,
): Promise<DeployActors> {
  if (sessionPresent && transferEnabled) {
    if (!suri && !isTestnet) throw new MainnetDefaultWorkerError();
    // Worker is a LOCAL dev/mnemonic signer (Alice by default) — it signs the
    // whole deploy, so the mobile never signs.
    const worker = await resolveSigner(authClient, { suri: suri ?? DEFAULT_WORKER_SURI });
    // Recipient = signed-in product H160, derived locally (no mobile popup).
    const handle = await authClient.getSessionSigner();
    if (!handle) throw new Error("transfer mode active but no session resolved; pass --no-transfer-to-signedin-user.");
    try {
      return { worker, recipientH160: handle.addresses.productH160 };
    } finally {
      handle.destroy();
    }
  }
  // Transfer off, or no session: today's behavior (session signer when present, else dev/Alice).
  const worker = await resolveSigner(authClient, { suri });
  return { worker };
}

/**
 * Result returned by resolveStorageSigner when a Bulletin slot signer was found.
 *
 * `owned` is true when the slot comes from the user's own session (cache-hit or
 * freshly allocated via step-4 prompt). It is used by formatStorageSignerLine to
 * distinguish "your allowance slot" (owned) from "allowance slot" (explicitly
 * injected by a programmatic caller).
 */
export interface StorageSignerResult {
  signer: PolkadotSigner;
  slotAddress: string;
  /** true when the slot comes from the user's own session (not a pre-injected slot). */
  owned: true;
}

/**
 * Injectable dependencies for resolveStorageSigner.
 * All fields are optional — defaults are used when not provided (deploy path).
 * Injecting stubs lets unit tests drive every branch without a real adapter.
 */
export interface StorageSignerDeps {
  /**
   * Calls adapter.allowance.getBulletinSigner(sessionId, productId).
   * Returns an Ok/Err result (product-sdk shape).
   */
  getBulletinSigner: (
    sessionId: string,
    productId: string,
    adapter: any,
  ) => Promise<{ isOk(): boolean; isErr(): boolean; value?: PolkadotSigner; error?: { reason: string } }>;

  /**
   * Triggers a phone prompt to allocate the BulletInAllowance resource.
   * Returns AllocationOutcome[] — one per resource in order.
   */
  requestResourceAllocation: (
    userSession: any,
    adapter: any,
    resources: AllocatableResource[],
  ) => Promise<{ tag: string; value?: unknown }[]>;

  /**
   * Read the cached slot account signer written by requestResourceAllocation.
   * Returns null on a miss (graceful fallback).
   */
  createSlotAccountSigner?: (adapter: any, resource: AllocatableResource) => Promise<PolkadotSigner | null>;

  /** Encode a public key as SS58. */
  ss58Encode: (publicKey: Uint8Array) => string;

  /**
   * Called BEFORE requestResourceAllocation to print the user-facing prompt.
   * Should print the "check your phone" warning so the user knows what's coming.
   * Ctrl-C will interrupt the subsequent requestResourceAllocation call directly.
   */
  promptBeforeAllocation: () => void;
}

/**
 * Resolve a user-owned Bulletin slot signer from the active session.
 *
 * Implements steps 3–4 of the storage-signer precedence:
 *   3. Cache-hit: adapter.allowance.getBulletinSigner(sessionId) → slot signer.
 *   4. Cache-miss (NotAvailable / Rejected): prompt then requestResourceAllocation
 *      ([BulletInAllowance]) → newly-allocated slot signer.
 *   5. Fall through: returns null → caller falls back to pool.
 *
 * Non-goals: explicit storageSigner / signer / mnemonic paths — those are handled
 * upstream by selectStorageReconnect. This function only handles session-derived slots.
 *
 * Layer-3 isolation is preserved: when `session` is null (no session file on disk,
 * no --suri), this function returns null immediately without touching the SSO stack.
 *
 * @param session  The resolved session object from resolveDeployActors (or null when
 *                 no session is present). Must have { userSession, adapter } shape.
 * @param deps     Injectable dependencies for testing. Production callers pass
 *                 undefined to use the real auth functions.
 * @returns        A { signer, slotAddress, owned: true } result or null (→ pool).
 */
export async function resolveStorageSigner(
  session: { userSession: { id: string }; adapter: any } | null | undefined,
  deps: StorageSignerDeps,
): Promise<StorageSignerResult | null> {
  if (!session?.userSession || !session?.adapter) return null;

  const { userSession, adapter } = session;

  try {
    // Step 3: cache-hit — getBulletinSigner reads the AES-encrypted terminal cache.
    const signerResult = await deps.getBulletinSigner(userSession.id, DOT_PRODUCT_ID, adapter);

    if (signerResult.isOk() && signerResult.value) {
      const signer = signerResult.value;
      const slotAddress = deps.ss58Encode(signer.publicKey);
      return { signer, slotAddress, owned: true };
    }

    // Step 4: cache-miss. Only prompt when the error indicates "no allocation" rather
    // than "no session" (NoSession means the session itself is invalid — re-allocating
    // won't help and we should not prompt). Rejected from a *previous* allocation
    // attempt is also a candidate for step 4 (user may approve this time).
    const reason = signerResult.error?.reason;
    if (reason === "NoSession") {
      // Session invalid — skip to pool silently.
      return null;
    }

    // NotAvailable / Rejected / UnexpectedResponse → offer the phone dialog.
    deps.promptBeforeAllocation();

    const outcomes = await deps.requestResourceAllocation(
      userSession,
      adapter,
      [BULLETIN_RESOURCE],
    );

    // Read the newly-cached slot (first outcome corresponds to BulletInAllowance).
    const outcome = outcomes[0];
    if (!outcome || outcome.tag !== "Allocated") {
      // Declined or not available → pool.
      return null;
    }

    // Use createSlotAccountSigner to read from the terminal cache written by
    // requestResourceAllocation (guaranteed cache-hit, no second phone prompt).
    if (deps.createSlotAccountSigner) {
      const slotSigner = await deps.createSlotAccountSigner(adapter, BULLETIN_RESOURCE);
      if (slotSigner) {
        const slotAddress = deps.ss58Encode(slotSigner.publicKey);
        return { signer: slotSigner, slotAddress, owned: true };
      }
    }

    // Fallback: createSlotAccountSigner not injected or returned null (rare).
    return null;
  } catch {
    // getBulletinSigner or requestResourceAllocation threw unexpectedly — pool fallback.
    // Non-fatal on testnet (pool is always available). On mainnet the caller should handle.
    return null;
  }
}
