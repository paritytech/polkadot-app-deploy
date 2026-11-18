import { DEFAULT_STACK_ID, loadStack, stackSelectionOf } from "../../dist/stacks.js";

// A run without PAD_ENV still deploys somewhere: deploy() loads
// `options.env ?? DEFAULT_STACK_ID` (src/stacks.ts), so the harness resolves the
// same stack rather than naming a chain of its own.
export function resolveE2eEnvId(padEnv) {
  return padEnv || DEFAULT_STACK_ID;
}

// Everything the harness needs about the target chain, from the stack the CLI
// loads. `loadOptions` goes to loadStack (tests inject `fetch` there).
export async function resolveE2eEnv(padEnv, loadOptions = {}) {
  const envId = resolveE2eEnvId(padEnv);
  const stack = await loadStack({ env: envId }, loadOptions);
  return {
    envId,
    tld: stack.tld,
    bulletin: stack.chains.Bulletin.rpc[0],
    gateway: stack.ipfsGateway,
    dotnsConnectOptions: stackSelectionOf(stack),
  };
}
