// `bulletin-deploy transfer <label>` — stand-alone handover + recovery for a
// deploy whose transfer step failed. Resolves the worker (current owner: Alice
// or --mnemonic) and recipient (signed-in product H160 by default, else --to),
// then calls the idempotent DotNS.transferName. A subname argument (e.g.
// `app.foo.dot`) is routed to DotNS.transferSubname instead, since subnames are
// reassigned by the parent owner via setSubnodeOwner rather than transferred as
// ERC-721 tokens.
import { DotNS, DEFAULT_MNEMONIC, parseDomainName } from "../dotns.js";
import { loadEnvironments, resolveEndpoints, getPopSelfServeConfig } from "../environments.js";
import { CLI_NAME } from "../cli-name.js";

export interface TransferRecipientContext {
  sessionH160?: string;
}

/** Pure: pick the recipient H160 from --to (0x) or the signed-in session.
 *  Label/SS58 recipient resolution is intentionally out of scope for the
 *  recovery command — it takes an explicit 0x address or the live session. */
export async function resolveTransferRecipient(
  to: string | undefined,
  ctx: TransferRecipientContext,
): Promise<string> {
  if (to && to.startsWith("0x") && to.length === 42) return to;
  if (to) throw new Error(`--to must be a 0x H160 address (got "${to}").`);
  if (ctx.sessionH160) return ctx.sessionH160;
  throw new Error("No recipient: pass --to <0xH160> or sign in first (no session found).");
}

export async function runTransfer(
  envId: string,
  opts: { label?: string; to?: string; mnemonic?: string },
): Promise<void> {
  const rawLabel = (opts.label ?? "").trim();
  if (!rawLabel) {
    throw new Error(`Usage: ${CLI_NAME} transfer <label> [--to <0xH160>] [--mnemonic <key>]`);
  }
  // Detect a subname (e.g. `app.foo.dot`) vs a base name (`foo.dot`); each takes
  // a different on-chain path (setSubnodeOwner vs ERC-721 transferFrom).
  const parsed = parseDomainName(rawLabel);

  // Recipient from the signed-in session unless --to was given.
  let sessionH160: string | undefined;
  if (!opts.to) {
    const { getAuthClient } = await import("../auth-config.js");
    const authClient = await getAuthClient(envId);
    const handle = await authClient.getSessionSigner();
    if (handle) {
      sessionH160 = handle.addresses.productH160;
      handle.destroy();
    }
  }
  const recipient = await resolveTransferRecipient(opts.to, { sessionH160 });

  const { doc } = await loadEnvironments();
  const resolved = resolveEndpoints(doc, envId);
  const dotns = new DotNS();
  await dotns.connect({
    mnemonic: opts.mnemonic ?? DEFAULT_MNEMONIC,
    rpc: resolved.assetHub[0],
    assetHubEndpoints: resolved.assetHub,
    autoAccountMapping: resolved.autoAccountMapping,
    environmentId: envId,
    contracts: Object.keys(resolved.contracts).length > 0 ? resolved.contracts : undefined,
    nativeToEthRatio: resolved.nativeToEthRatio,
    popSelfServe: getPopSelfServeConfig(doc, envId),
    registerStorageDeposit: resolved.registerStorageDeposit,
  });
  try {
    const result = parsed.isSubdomain
      ? await dotns.transferSubname(parsed.sublabel!, parsed.parentLabel!, recipient, (s) => console.log(`   ${s}`))
      : await dotns.transferName(parsed.label, recipient, (s) => console.log(`   ${s}`));
    if (result.status === "skipped-already-owned") {
      console.log(`✓ ${parsed.fullName} is already owned by ${recipient}. Nothing to do.`);
    } else {
      console.log(`✓ Transferred ${parsed.fullName} to ${recipient}${result.txHash ? ` (tx ${result.txHash})` : ""}.`);
    }
  } finally {
    dotns.disconnect();
  }
}
