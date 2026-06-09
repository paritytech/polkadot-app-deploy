# Setting up an environment

This guide is for the **operator / chain admin** standing up `polkadot-app-deploy` against a Polkadot environment. It covers what you configure and authorize so that deploys work against *your* chain.

For **using** the tool once an environment is set up — building and shipping an app — see the [README](README.md). This document is the setup side.

> [!NOTE]
> `polkadot-app-deploy` is reference / proof-of-concept tooling — see the security notice in the [README](README.md#security). The defaults target Polkadot testnets.

**Documentation map — read in order:**
1. **[DEPLOYMENT.md](DEPLOYMENT.md)** (this doc) — set up `polkadot-app-deploy` for your environment.
2. **[docs/bootstrap.md](docs/bootstrap.md)** — the `polkadot-app-bootstrap` reference (Bulletin storage authorization).
3. **[docs/e2e-bootstrap.md](docs/e2e-bootstrap.md)** — a fully worked setup, end to end, for the E2E test environment.

(Using the tool to ship an app — not setting it up — is the [README](README.md).)

## What an "environment" is

A `polkadot-app-deploy` environment is three things, which it expects to already exist for your network:

- an **Asset Hub** (PolkaVM / `pallet-revive`) with the **DotNS** contracts deployed — names live here;
- a **Bulletin Chain** — content (your site, chunked + content-addressed) is stored here;
- an **IPFS gateway** — serves the stored content over HTTP.

Setup is: tell `polkadot-app-deploy` where those are, authorize the accounts that will write to the Bulletin Chain, and (if your DotNS gates registration) grant the registering account personhood. The steps below.

## 1. Define the environment

`polkadot-app-deploy` resolves environments from `environments.json`. The built-in presets ship in `assets/environments.json`:

```sh
polkadot-app-deploy --list-environments      # list the built-in environment IDs
```

Add your network either by adding an entry to `assets/environments.json`, or by supplying one at runtime:

```sh
polkadot-app-deploy ./dist myapp.dot --environment-file ./my-env.json
polkadot-app-deploy ./dist myapp.dot --env <id> --contract DOTNS_REGISTRAR=0x...   # override single fields
```

An environment entry provides:

- **Chain endpoints** — the `wss://` RPCs for at least the **bulletin** and **asset-hub** chains.
- **DotNS contract addresses** — the contract set deployed on your Asset Hub (`DOTNS_REGISTRAR`, `POP_RULES`, the resolvers, `STORE_FACTORY`, …).
- **`nativeToEthRatio`** — `10^(18 − native_decimals)`; e.g. a 10-decimal native token → `100000000`.
- **`registerStorageDeposit`** — the DotNS registration deposit on your chain.
- **`autoAccountMapping`** — whether the chain maps accounts to H160 automatically on first tx.
- **`ipfs`** — the gateway that serves deployed content.

Use the `paseo-next-v2` and `summit` entries in `assets/environments.json` as worked examples to copy.

## 2. Authorize Bulletin storage

Writing content to the Bulletin Chain requires each **storage account** to hold a `TransactionStorage` **authorization** — a quota of transactions and bytes. Storage is gated by this quota, **not by balance** (Bulletin has no fee model), so the storage accounts need no funds. `polkadot-app-deploy` never grants the authorization itself; the chain's **authorizer** must.

The storage accounts are an upload **pool**, derived as `//deploy/0…N` from `BULLETIN_POOL_MNEMONIC` (default: the well-known `DEV_PHRASE`). The deploy path derives the **same** pool from that env var — so if you use a custom pool, set `BULLETIN_POOL_MNEMONIC` identically for both bootstrap and deploy, or they won't line up.

`polkadot-app-bootstrap` reports each pool account's authorization status, and — given an authorizer key — grants authorization to the ones that lack it:

```sh
polkadot-app-bootstrap --env <id>                        # list pool accounts + their authorization status
polkadot-app-bootstrap --env <id> --authorizer "<seed>"  # grant authorization with the authorizer key
polkadot-app-bootstrap --env <id> --pool-size 20         # inspect/authorize a larger pool
```

On a **testnet** the authorizer defaults to `//Alice` (it holds authorization authority there), so no `--authorizer` is needed. On a **production** chain, pass `--authorizer` with the key that actually holds authorization authority — if it can't grant, the tool reports that rather than pretending. See [`docs/bootstrap.md`](docs/bootstrap.md) for the full reference.

## 3. Personhood (if your DotNS gates registration)

If your `POP_RULES` contract requires Proof-of-Personhood to register a base name, the **registering account** needs a PoP status granted by the `POP_RULES` owner. (NoStatus-eligible label shapes skip this — see the rules in your DotNS deployment.)

- On Parity's testnets, request a grant by opening an issue on [paritytech/dotns](https://github.com/paritytech/dotns/issues).
- On your own chain, your `POP_RULES` owner grants it out of band — `polkadot-app-deploy` cannot upgrade a signer.

## 4. Fund the signing accounts

The accounts that register and transfer names need a balance on your Asset Hub for DotNS fees:

- **Public testnets** — use the faucet (e.g. [faucet.polkadot.io](https://faucet.polkadot.io/)).
- **Restricted networks** — fund the accounts out of band; there is no public faucet.

(These are the DotNS signing accounts on the Asset Hub — distinct from the Bulletin storage pool in step 2, which needs authorization, not funds.)

## 5. Content gateway

Deployed content is content-addressed (a CID) on the Bulletin Chain and served over HTTP by the IPFS gateway you set as `ipfs` in step 1. The `.dot` name resolves to that CID via DotNS. Parity's public testnets resolve a deployed name at `https://<name>.dot.li`; your environment uses whatever gateway / resolver you point it at.

## 6. Verify the setup

A **test deploy** is the real check — run one (see the [README](README.md)) and confirm it completes and resolves. Two failures map straight back to the steps above:

- `not authorized to upload` → the storage account lacks authorization (step 2).
- a personhood / registration gate → the registering account needs PoP (step 3).

If you're working from a **clone of the repository** (not just the npm package), `tools/` has read-only diagnostics that take `--env <id>`: `check-bulletin-auth.mjs` (storage quotas), `check-balances.mjs` (balances + quota), `check-pop-status.mjs` (personhood), `probe-env-health.mjs` (RPC reachability). These ship with the repo, not the published package.

A concrete, fully worked instance of this setup — for the E2E test environment — lives in [`docs/e2e-bootstrap.md`](docs/e2e-bootstrap.md).

---

Once the environment is set up, day-to-day use is in the [README](README.md): build your site, `polkadot-app-deploy ./dist myapp.dot`, done.
