# polkadot-app-bootstrap

`polkadot-app-bootstrap` is the operator CLI for reporting and granting pool account authorization on the Bulletin chain. It is separate from `polkadot-app-deploy` on purpose: deploys are the normal user path, bootstrap is an admin/setup operation.

**Documentation map — read in order:**
1. **[DEPLOYMENT.md](../DEPLOYMENT.md)** — set up polkadot-app-deploy for your environment.
2. **[docs/bootstrap.md](bootstrap.md)** (this doc) — the polkadot-app-bootstrap reference (Bulletin storage authorization).
3. **[docs/e2e-bootstrap.md](e2e-bootstrap.md)** — a fully worked setup, end to end, for the E2E test environment.

## The authorization model

The Bulletin chain has **no fee model**. Storage access is gated by the `TransactionStorage` pallet's authorization quota, not account balance. Each pool account must be authorized with a transaction count and byte budget. `polkadot-app-bootstrap` inspects and grants that quota.

## Usage

```bash
polkadot-app-bootstrap [options]
```

Options:

| Flag | What it does |
|---|---|
| `--mnemonic "..."` | Pool root mnemonic used to derive the pool accounts. Also readable from `BULLETIN_POOL_MNEMONIC`, then `MNEMONIC`. Defaults to the well-known dev phrase — the same key the deploy path uses. |
| `--authorizer "..."` | Seed/mnemonic of the key that holds authorization authority on this chain (e.g. `//Alice`, a full mnemonic, or a hex seed). On testnets, defaults to `//Alice` if omitted. On non-testnets, required to grant — omit to get status only. |
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
   - No `--authorizer` and chain is a testnet → default to `//Alice`.
   - No `--authorizer` and chain is not a testnet → print that authorization is needed and exit (status-only, nothing written).
5. For each account that needs authorization, submits `TransactionStorage.authorize_account` signed by the authorizer (1000 txs / 100 MB per account).
6. Prints a final summary of all account statuses.

Use it when:

- you are bringing up a fresh pool on a testnet or production chain
- the shared uploader pool's authorizations have expired
- you want to check authorization status without making any changes (omit `--authorizer` on non-testnet)
- you are initializing a non-default pool mnemonic

Do not use it as part of routine deploys. Normal deploys go through `polkadot-app-deploy`.

## Pool account derivation

Pool accounts are derived from the pool root mnemonic using the path `//deploy/N` for `N` in `[0, pool-size)`. The deploy path uses the same derivation from `BULLETIN_POOL_MNEMONIC` (defaulting to the well-known dev phrase). Bootstrap and deploy must use the same mnemonic to address the same accounts.

## Examples

```bash
# Check status on the default testnet (//Alice as authorizer)
polkadot-app-bootstrap

# Check status without granting (non-testnet, no authorizer provided)
polkadot-app-bootstrap --rpc wss://bulletin.mainnet.example.com

# Grant on a non-testnet with an explicit authorizer
polkadot-app-bootstrap --rpc wss://bulletin.mainnet.example.com --authorizer "word word word ..."

# Larger pool, explicit RPC
polkadot-app-bootstrap --rpc wss://custom-bulletin.example.com --pool-size 20

# Explicit pool mnemonic and authorizer
polkadot-app-bootstrap --mnemonic "word word word ..." --authorizer "//Alice"

# Load environment from environments.json
polkadot-app-bootstrap --env paseo-next-v2
```

## Related Docs

- [DEPLOYMENT.md](../DEPLOYMENT.md)
- [E2E test setup](./e2e-bootstrap.md)
- [Main README](../README.md)
