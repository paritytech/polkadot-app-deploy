// Decides WHO signs a deploy and WHO receives the name, for the
// zero-mobile-signature flow. Composes the vendored resolveSigner with the
// session-address lookup. Testnet-only default-to-Alice; mainnet deferred.
import { resolveSigner } from "./auth/index.js";
import type { ResolvedSigner, AuthClient } from "./auth/index.js";
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
