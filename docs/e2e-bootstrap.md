# E2E test setup

> This is a **contributor** guide for running the live-testnet E2E suite. If you only want to deploy your own app, see [DEPLOYMENT.md](../DEPLOYMENT.md) instead.

**Documentation map — read in order:**
1. **[DEPLOYMENT.md](../DEPLOYMENT.md)** — set up `polkadot-app-deploy` for your environment.
2. **[docs/bootstrap.md](bootstrap.md)** — the `polkadot-app-bootstrap` reference (Bulletin storage authorization).
3. **[docs/e2e-bootstrap.md](e2e-bootstrap.md)** (this doc) — a fully worked setup, end to end, for the E2E test environment.

The E2E suite (`test/e2e.test.js`, driven by `.github/workflows/e2e.yml`) deploys real content to Paseo Bulletin testnet via `polkadot-app-deploy` and verifies the on-chain round-trip. It consumes the **shared default pool** (derived from `DEV_PHRASE` — the same pool real users hit in production) for Bulletin chunk upload, so no pool bootstrapping is required.

Three one-time setup items are needed before the workflow can pass. Do them once per testnet lifetime (redo if testnet is wiped).

---

## Chain-admin prerequisites

Some of this setup needs authority a normal contributor doesn't have — the Bulletin chain's storage **authorizer** key, the DotNS `POP_RULES` contract **owner**, and (on faucet-less testnets) a funding source. A network operator ensures the following before the suite can pass.

This repo's `tools/` ships one read-only diagnostic, `probe-env-health.mjs --env <id>` (RPC reachability). It does **not** ship personhood/balance/authorization-quota checkers or fixture-registration tools — those are chain-admin operations performed with tooling outside this repository. If you're a contributor without chain-admin access, ask the operator to confirm the three items below rather than trying to check them yourself.

1. **Personhood (PoP) status.** Registering a PoP-Full base label (e.g. `e2epool.dot`) requires Full Personhood on the DotNS Personhood precompile — Alice for the happy-path scenarios. NoStatus fallback labels (e.g. `e2epoolns01.dot`) need no grant; they auto-register on first deploy.
   - Grant: by the `POP_RULES` contract owner — request via an issue on [paritytech/dotns](https://github.com/paritytech/dotns/issues). `polkadot-app-deploy` cannot self-upgrade a signer.

2. **Asset Hub funding (DotNS fees).** The accounts that register or transfer names need a balance on the target Asset Hub.
   - Grant: on Paseo, use the public faucet at [https://faucet.polkadot.io/](https://faucet.polkadot.io/). `paseo-next-v2` has no public faucet — the operator funds the accounts out of band.

3. **Bulletin storage authorization (upload allowance).** Every account that uploads chunks must carry a `TransactionStorage` authorization; `polkadot-app-deploy` never self-authorizes. The authorizer is declared per environment (`bulletinAuthorizer` in `environments.json`) — e.g. `//Alice` on `paseo-next-v2`.
   - Grant: **pool accounts** via `polkadot-app-bootstrap --env <id>` (authorizes them using the env's declared authorizer — see [`docs/bootstrap.md`](bootstrap.md)); **direct-mode signers** (the per-shard `//e2e-*` derivation paths) are authorized by the same operator out of band. Alice is the authorizer itself, and Bob only owns the S3 fixture name (never uploads), so neither needs its own storage grant.

The per-environment sections below are the step-by-step procedures that satisfy these.

---

## Paseo (stable testnet)

### Prerequisites

- `polkadot-app-deploy` built locally (`npm run build`).
- Network access to Paseo Bulletin RPC (`wss://paseo-bulletin-rpc.polkadot.io`) and Asset Hub Paseo (DotNS).
- Alice's dev mnemonic: `bottom drive obey lake curtain smoke basket hold race lonely fit walk`.

### 1. Verify Alice Personhood status

Both happy-path scenarios (S1, S2) deploy as Alice via DotNS. Registering a new un-reserved base name requires Personhood status from the chain's Personhood precompile. This repo ships no personhood-status checker (see "Chain-admin prerequisites" above) — confirm Alice's status with the chain admin. Self-attestation is no longer available; a signer's Personhood status is granted by the `POP_RULES` contract owner. To request a status grant (whitelisting) for a signer, open an issue on [paritytech/dotns](https://github.com/paritytech/dotns/issues).

### 2. Fund and map Bob on Asset Hub Paseo

Bob (`//Bob` from the dev phrase) is the owner of the S3 fixture (see item 3). He needs:

- **Balance** on Asset Hub Paseo for his on-chain fees. Request ~1 PAS from the Paseo faucet at [https://faucet.polkadot.io/](https://faucet.polkadot.io/) sending to Bob's SS58 address `5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty`.
- **Revive mapping** so he can sign EVM transactions. His deterministic H160 is `0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01`. A Bob-signed registration or transfer triggers mapping when the chain supports automatic mapping.

### 3. Register the S3 fixture directly as Bob

The S3 negative scenario asserts that `polkadot-app-deploy` refuses to deploy to a domain owned by a different account (exit 78 with transfer guidance). On this environment the fixture label is `e2eownedns01.dot` — a NoStatus-compatible label (no PoP grant needed for the registering account), so it works regardless of Bob's own PoP status. Have Bob register it with a DotNS registration tool outside `polkadot-app-deploy` — no Alice intermediary, no Bulletin content needed (S3 never reads content).

Expected end state: `e2eownedns01.dot` is owned by Bob's H160 `0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01`. If S3 ever fails because the label drifted to a different owner, the chain admin restores Bob's ownership the same way.

---

## Paseo Next v2 (`--env paseo-next-v2`)

Paseo Next v2 uses a separate Asset Hub (`wss://paseo-asset-hub-next-rpc.polkadot.io`) and Bulletin chain (`wss://paseo-bulletin-next-rpc.polkadot.io`) with different contract addresses. The `map_account` extrinsic does not exist on this chain — account mapping is triggered automatically when an account submits its first on-chain transaction.

> **Note on PoP grants:** The paseo-next-v2 `POP_RULES` contract (`0x2002C1c15b88632Ad01c7770f6EbE1Ca05c8472E`) is **not permissionless** — `setUserPopStatus` can only be called by its owner. `polkadot-app-deploy` cannot upgrade a signer itself; a status grant (whitelisting) is performed out of band by the contract owner. To request one for a signer, open an issue on [paritytech/dotns](https://github.com/paritytech/dotns/issues). CI scenarios pick labels via `pickStableLabel`/`pickDirectLabel`/`pickIncLabel`/`pickRotLabel`, which auto-select between a PoP-Full base name (e.g. `e2epool.paseo`) and a NoStatus fallback (e.g. `e2epoolns01.paseo`) based on what `Personhood.personhoodStatus(<signer>)` returns at test start. The setup below covers both modes.

> **⚠ Testnet wipes reset everything.** When paseo-next-v2 is reset (which happens periodically), Alice's Personhood precompile status drops to NoStatus *and* every `e2e*.paseo` registration is gone. Re-run the relevant steps below after each wipe — there is no on-chain self-recovery. A subtle failure mode to watch for: Alice's status can come back as Full while `e2epool.paseo` is unregistered, so `setContenthash` reverts with `ERC721NonexistentToken`. As long as ownership stays in lockstep with Alice's PoP grade (Full ↔ PoP-Full labels registered; NoStatus ↔ NoStatus labels auto-register on first deploy), the nightly stays green.

### Prerequisites

- `polkadot-app-deploy` built locally (`npm run build`).
- Alice (`5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV`) funded on paseo-next-v2 Asset Hub. This is a restricted testnet with no public faucet — the account must be funded out of band by the network operator.

### 1. Authorize pool accounts on Bulletin Next

```bash
polkadot-app-bootstrap --env paseo-next-v2
```

This grants each pool account `TransactionStorage` quota on Bulletin Next. Alice (`//Alice`) must be funded and mapped on Asset Hub Next for this to succeed (Alice's mapping is triggered automatically by her first on-chain tx, so funding alone is sufficient).

### 2. Verify Alice PoP status

This repo ships no personhood-status checker (see "Chain-admin prerequisites" above) — confirm Alice's status with the chain admin. What it is decides which labels need pre-registration:

- **`NoStatus (0)`** → no extra work. The tests pick the NoStatus fallback labels (`e2epoolns01`, `e2edirect01`, `e2eincpool01`, `e2erotpool01`) which auto-register on first deploy because their shape (base length ≥ 9 with two trailing digits) bypasses the `Requires Full personhood verification` gate.
- **`ProofOfPersonhoodFull (2)`** → Alice has been flipped to Full on the Personhood precompile. The tests will now pick the PoP-Full stable labels (`e2epool`, `e2edirect`, `e2einc`, `e2erot`), and those **must already be registered to Alice** before the matrix runs. Register them once:

  ```bash
  # Pre-built fixture is fine — it's the contenthash, not the content, that the tests overwrite.
  for label in e2epool e2edirect e2einc e2erot; do
    node bin/polkadot-app-deploy test/fixtures/e2e-spa "${label}.paseo" --env paseo-next-v2 --js-merkle
  done
  ```

  Skipping this leaves `setContenthash` reverting with `ERC721NonexistentToken` on whichever PoP-Full label the scenario picks.

### 3. Fund Bob and trigger his account mapping

Bob (`5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty`) needs PAS on paseo-next-v2 Asset Hub so he can pay fees for the S3 fixture registration (item 4). As above, this testnet has no public faucet — fund his SS58 address (~1 PAS) out of band. His H160 mapping (`0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01`) is triggered automatically when he submits his first on-chain tx.

### 4. Register `e2eownedns03.paseo` directly as Bob

The S3 negative scenario picks its owned-elsewhere fixture purely by environment now, not by Alice's PoP status: on `paseo-next-v2` it's always `e2eownedns03.paseo`, owned by Bob. (An older fixture, `e2eownedns02.paseo`, was squatted by an unrelated third party after a testnet re-genesis and could not be recovered — `e2eownedns03` replaced it. A still-older `e2eowned.dot`, which used to be the separate PoP-Full-only fixture, is no longer read by any scenario.)

Have Bob register `e2eownedns03.paseo` with a DotNS registration tool outside `polkadot-app-deploy` — no Alice intermediary, no Bulletin content needed (S3 never reads content). This repo ships no fixture-registration tool (see "Chain-admin prerequisites" above); the chain admin performs this out of band.

Expected end state: `e2eownedns03.paseo` is owned by Bob's H160 (`0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01`). If S3 ever fails because the label drifted to a different owner, the chain admin restores Bob's ownership the same way — `transferFrom(<current>, Bob, tokenId)` on `DOTNS_REGISTRAR` is unconditional on the recipient (no PoP check).

---

## No pre-registration needed for `e2epoolns01.paseo` / direct NoStatus labels

The stable happy-path labels auto-register to the selected test signer on first deploy. Subsequent runs exercise the update path (new contenthash under existing ownership). On paseo-next-v2 these labels must remain NoStatus-compatible because DotNS self-attestation is no longer available.

## Verifying locally

```bash
# Paseo
E2E=1 E2E_SIGNER=pool E2E_MERKLE=js E2E_SCENARIO=s1 \
  BULLETIN_RPC=wss://paseo-bulletin-rpc.polkadot.io \
  npm run test:e2e

# Paseo Next v2
E2E=1 E2E_SIGNER=pool E2E_MERKLE=js E2E_SCENARIO=s1 \
  BULLETIN_RPC=wss://paseo-bulletin-next-rpc.polkadot.io \
  PAD_ENV=paseo-next-v2 \
  npm run test:e2e
# Previously named DOTNS_ENV; kept as deprecated alias for one release.
```

Vary `E2E_SCENARIO` (`s1`, `s2`, `s3`), `E2E_SIGNER` (`pool`, `direct`), and `E2E_MERKLE` (`js`, `kubo`) to cover the full CI matrix.
