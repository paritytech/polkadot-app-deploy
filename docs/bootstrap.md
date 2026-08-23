# polkadot-app-bootstrap

`polkadot-app-bootstrap` is the operator CLI for reporting and granting pool account authorization on the Bulletin chain. It is separate from `polkadot-app-deploy` on purpose: deploys are the normal user path, bootstrap is an admin/setup operation.

**Documentation map — read in order:**
1. **[DEPLOYMENT.md](../DEPLOYMENT.md)** — set up polkadot-app-deploy for your environment.
2. **[docs/bootstrap.md](bootstrap.md)** (this doc) — the polkadot-app-bootstrap reference (Bulletin storage authorization).
3. **[docs/e2e-bootstrap.md](e2e-bootstrap.md)** — a fully worked setup, end to end, for the E2E test environment.

## The authorization model

The Bulletin chain has **no fee model**. Storage access is gated by the `TransactionStorage` pallet's authorization quota, not account balance. Each pool account must be authorized with a transaction count and byte budget. `polkadot-app-bootstrap` inspects and grants that quota.

### The authorizer is declared per environment, not guessed from network type

When `--env <id>` is given and `--authorizer` is omitted, bootstrap falls back to that environment's declared `bulletinAuthorizer` field in `environments.json` (e.g. `//Alice` on `paseo-next-v2`). There is **no other default** — in particular, no "if this looks like a testnet, use `//Alice`" heuristic. An environment operated by someone else — for example the community `devnet` preset, run by the Polkadot Community Foundation — declares no `bulletinAuthorizer` at all, because the actual authorizer key isn't known here. Omitting `--authorizer` there prints a clear "no known authorizer" message and does nothing, rather than guessing and having the grant silently rejected on-chain. Always pass the key that holds `TransactionStorage` authorization authority on that chain explicitly:

```bash
polkadot-app-bootstrap --env devnet --authorizer "<your authorizer seed or mnemonic>"
```

The same applies to `--mnemonic`: pass the pool root mnemonic whose `//deploy/N` accounts your deploys actually use, so bootstrap authorizes the accounts the deploy path will address.

Note that the `bulletinAuthorizer` fallback only applies when `--env` is passed — a bare `polkadot-app-bootstrap` with neither `--env` nor `--authorizer` has no environment to read a fallback from, so it also prints "no known authorizer" rather than defaulting to anything.

### Environment config: Browse Publisher contract

Bootstrap grants **Bulletin storage** authorization only. Listing apps in **Browse** is a separate, Asset-Hub-side capability provided by the `Publisher` contract, and it is configured in `environments.json` — not by this CLI. When you stand up a new environment, check both.

Make sure the env's `contracts` map in `environments.json` includes a **`PUBLISHER`** entry pointing at the Browse Publisher deployed on that environment's Asset Hub. Whether `--publish` does anything is gated purely on that field being present and non-zero — there's no separate allowlist of which environment IDs support it. If it is missing (or zero), `polkadot-app-deploy --publish --env <id>` prints `Publish: not supported on this environment — will be skipped` and silently does nothing: apps deploy but never appear in Browse.

Checklist for a new environment:

1. Confirm the Browse `Publisher` contract is deployed on the env's Asset Hub — there is bytecode at the address, `owner()` is the products deployer, and `isPublished(labelhash)` returns `true` for an already-listed app (and `false` for a control label).
2. Add its address to the env's `contracts.PUBLISHER` in `environments.json`, alongside the other `contracts` entries. It must be a valid, non-zero EVM address (the deploy CLI validates the format).
3. Verify: a deploy with `--publish --env <id>` lists the app and does **not** print the "not supported" message.

## Usage

```bash
polkadot-app-bootstrap [options]
```

Options:

| Flag | What it does |
|---|---|
| `--mnemonic "..."` | Pool root mnemonic used to derive the pool accounts. Also readable from `BULLETIN_POOL_MNEMONIC`, then `MNEMONIC`. Defaults to the well-known dev phrase — the same key the deploy path uses. |
| `--authorizer "..."` | Seed/mnemonic of the key that holds authorization authority on this chain (e.g. `//Alice`, a full mnemonic, or a hex seed). If omitted, falls back to the `--env`'s declared `bulletinAuthorizer` (e.g. `//Alice` on `paseo-next-v2`); if the env declares none (or `--env` isn't given), the run is status-only. |
| `--rpc wss://...` | Override the Bulletin RPC endpoint. Also readable from `BULLETIN_RPC`. |
| `--env <id>` | Load environment by id from `environments.json` (sets the default RPC). |
| `--pool-size N` | Number of pool accounts to check/initialize. Default: `10`. |
| `--version` | Print the CLI version. |
| `--help` | Show help. |

## What it does

1. Connects to the Bulletin chain and derives the pool account set from `--mnemonic` (default: dev phrase, same as `BULLETIN_POOL_MNEMONIC` in the deploy path).
2. Fetches the current `TransactionStorage` authorization for each account and prints its status: index, address, and either `AUTHORIZED — <txs> txs / <MB> MB remaining, expires @<block>` or `NOT AUTHORIZED`.
3. Determines which accounts need authorization (missing or expired).
4. Resolves the authorizer:
   - `--authorizer` provided → use that key.
   - No `--authorizer`, but `--env <id>` names an environment with a declared `bulletinAuthorizer` → use that (e.g. `//Alice` on `paseo-next-v2`).
   - Neither available → print that no known authorizer exists and exit (status-only, nothing written).
5. For each account that needs authorization, submits `TransactionStorage.authorize_account` signed by the authorizer (1000 txs / 100 MB per account).
6. Prints a final summary of all account statuses.

Use it when:

- you are bringing up a fresh pool on a testnet or production chain
- the shared uploader pool's authorizations have expired
- you want to check authorization status without making any changes (omit `--authorizer`, and either omit `--env` or target one with no declared `bulletinAuthorizer`)
- you are initializing a non-default pool mnemonic

Do not use it as part of routine deploys. Normal deploys go through `polkadot-app-deploy`.

## Pool account derivation

Pool accounts are derived from the pool root mnemonic using the path `//deploy/N` for `N` in `[0, pool-size)`. The deploy path uses the same derivation from `BULLETIN_POOL_MNEMONIC` (defaulting to the well-known dev phrase). Bootstrap and deploy must use the same mnemonic to address the same accounts.

## Examples

```bash
# Grant on paseo-next-v2 using its declared authorizer (//Alice)
polkadot-app-bootstrap --env paseo-next-v2

# Check status without granting (no --env, no authorizer provided)
polkadot-app-bootstrap --rpc wss://bulletin.mainnet.example.com

# Grant on a non-testnet with an explicit authorizer
polkadot-app-bootstrap --rpc wss://bulletin.mainnet.example.com --authorizer "word word word ..."

# Larger pool, explicit RPC
polkadot-app-bootstrap --rpc wss://custom-bulletin.example.com --pool-size 20

# Explicit pool mnemonic and authorizer
polkadot-app-bootstrap --mnemonic "word word word ..." --authorizer "//Alice"
```

## Related Docs

- [DEPLOYMENT.md](../DEPLOYMENT.md)
- [E2E test setup](./e2e-bootstrap.md)
- [Main README](../README.md)
