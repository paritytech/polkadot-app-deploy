// Single source of truth for the CLI command name as it appears in user-facing
// strings (command hints, usage text). The public rename flips this one value.
// NOTE: this is the *command* name only — not the npm package name (version-check),
// the repo URL (bug-report), or the SSO dApp host id (auth-config DOT_HOST_NAME).
export const CLI_NAME = "polkadot-app-deploy";
