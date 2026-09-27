// src/mnemonic.ts — single source of truth for MNEMONIC/DOTNS_MNEMONIC precedence (bulletin #1553/#1461).
//
// Before this file existed, two places encoded this precedence and they
// disagreed: `resolveEffectiveMnemonic` (deploy.ts, #1107) put `MNEMONIC`
// before `DOTNS_MNEMONIC`, while `DotNS.connect` (dotns.ts) read
// `process.env.DOTNS_MNEMONIC || process.env.MNEMONIC` directly — the
// opposite order. `bin/polkadot-app-deploy` always pre-resolves a mnemonic
// via `resolveEffectiveMnemonic` and forwards it as `options.mnemonic`, so
// `DotNS.connect`'s own env fallback was unreachable from the CLI and the
// disagreement was invisible there; it only mattered for a direct
// `DotNS.connect()` caller (or a `deploy()` library caller) that left
// `options.mnemonic` unset and relied on the env vars. Both sites now import
// this module so the precedence cannot drift apart again.

/**
 * Resolve the mnemonic that should be used to sign, in precedence order:
 * `--mnemonic` flag / caller-supplied value > `MNEMONIC` env var >
 * `DOTNS_MNEMONIC` env var.
 *
 * `MNEMONIC` is the documented primary (README, `--help`, error messages
 * all name it first); `DOTNS_MNEMONIC` is the DotNS-scoped legacy alias.
 *
 * Empty-string / whitespace-only values are treated as unset rather than as
 * a valid (empty) mnemonic. Without this, a declared-but-blank env var (e.g.
 * a GitHub Actions `MNEMONIC: ${{ secrets.X }}` step where the secret was
 * never set, which resolves to `""`) would win over a real lower-precedence
 * value, or fall all the way through to DotNS's own dev-key default —
 * silently signing with the wrong key instead of falling back correctly.
 */
export function resolveEffectiveMnemonic(opts: {
  flagMnemonic: string | undefined;
  envMnemonic: string | undefined;
  envDotnsMnemonic: string | undefined;
}): string | undefined {
  return (
    normalizeMnemonic(opts.flagMnemonic) ??
    normalizeMnemonic(opts.envMnemonic) ??
    normalizeMnemonic(opts.envDotnsMnemonic)
  );
}

function normalizeMnemonic(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * Pure notice for when `MNEMONIC` and `DOTNS_MNEMONIC` are both set to
 * different values, so the choice `resolveEffectiveMnemonic` makes between
 * them is observable rather than silent. Returns `null` when there is
 * nothing ambiguous to report (either is unset/blank, or they agree).
 *
 * Never includes either mnemonic's value — only the two env var names — so
 * this is safe to print to stdout/stderr without leaking key material.
 */
export function mnemonicConflictNotice(opts: {
  envMnemonic: string | undefined;
  envDotnsMnemonic: string | undefined;
}): string | null {
  const a = normalizeMnemonic(opts.envMnemonic);
  const b = normalizeMnemonic(opts.envDotnsMnemonic);
  if (!a || !b || a === b) return null;
  return "Both MNEMONIC and DOTNS_MNEMONIC are set, to different values — using MNEMONIC. Set only one of the two, or pass --mnemonic explicitly, to avoid ambiguity.";
}
