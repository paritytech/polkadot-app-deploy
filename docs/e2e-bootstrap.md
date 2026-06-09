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

Some of this setup needs authority a normal contributor doesn't have — the Bulletin chain's storage **authorizer** key, the DotNS `POP_RULES` contract **owner**, and (on faucet-less testnets) a funding source. A network operator ensures the following before the suite can pass. The check commands are read-only and safe to run anytime; the grant tools are idempotent — they report current status and do only what is missing.

1. **Personhood (PoP) status.** Registering a PoP-Full base label (e.g. `e2epool.dot`) requires Full Personhood on the DotNS Personhood precompile — Alice for the happy-path scenarios, and Bob once for the `e2eowned.dot` S3 fixture. NoStatus fallback labels (e.g. `e2epoolns01.dot`) need no grant; they auto-register on first deploy.
   - Check: `node tools/check-pop-status.mjs --env <id>`
   - Grant: by the `POP_RULES` contract owner — request via an issue on [paritytech/dotns](https://github.com/paritytech/dotns/issues). `polkadot-app-deploy` cannot self-upgrade a signer.

2. **Asset Hub funding (DotNS fees).** The accounts that register or transfer names need a balance on the target Asset Hub.
   - Check: `node tools/check-balances.mjs --env <id>` (shows balances and Bulletin authorization quota for every E2E signer in one pass)
   - Grant: on Paseo, use the public faucet at [https://faucet.polkadot.io/](https://faucet.polkadot.io/). `paseo-next-v2` has no public faucet — the operator funds the accounts out of band.

3. **Bulletin storage authorization (upload allowance).** Every account that uploads chunks must carry a `TransactionStorage` authorization; `polkadot-app-deploy` never self-authorizes. On testnet the authorizer is `//Alice`.
   - Check: `node tools/check-bulletin-auth.mjs --env <id>`
   - Grant: **pool accounts** via `polkadot-app-bootstrap --env <id>` (authorizes and funds them); **direct-mode signers** (the per-shard `//e2e-*` derivation paths) via `node tools/setup-e2e-derivation-signers.mjs --env <id>`. Alice is the authorizer itself, and Bob only owns the S3 fixture name (never uploads), so neither needs its own storage grant.

The per-environment sections below are the step-by-step procedures that satisfy these.

---

## Paseo (stable testnet)

### Prerequisites

- `polkadot-app-deploy` built locally (`npm run build`).
- Network access to Paseo Bulletin RPC (`wss://paseo-bulletin-rpc.polkadot.io`) and Asset Hub Paseo (DotNS).
- Alice's dev mnemonic: `bottom drive obey lake curtain smoke basket hold race lonely fit walk`.

### 1. Verify Alice Personhood status

Both happy-path scenarios (S1, S2) deploy as Alice via DotNS. Registering a new un-reserved base name requires Personhood status from the chain's Personhood precompile:

```bash
node tools/check-pop-status.mjs
```

Re-run if the check cannot read Alice's status. Self-attestation is no longer available; a signer's Personhood status is granted by the `POP_RULES` contract owner. To request a status grant (whitelisting) for a signer, open an issue on [paritytech/dotns](https://github.com/paritytech/dotns/issues).

### 2. Fund and map Bob on Asset Hub Paseo

Bob (`//Bob` from the dev phrase) is the owner of `e2eowned.dot` (see item 3). He needs:

- **Balance** on Asset Hub Paseo for his on-chain fees. Request ~1 PAS from the Paseo faucet at [https://faucet.polkadot.io/](https://faucet.polkadot.io/) sending to Bob's SS58 address `5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty`.
- **Revive mapping** so he can sign EVM transactions. `check-pop-status` reports Bob's deterministic H160 and Personhood status without submitting transactions. A later Bob-signed registration or transfer triggers mapping when the chain supports automatic mapping.

```bash
node tools/check-pop-status.mjs "bottom drive obey lake curtain smoke basket hold race lonely fit walk//Bob"
```

Expected output: Bob's SS58, his H160 (`0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01`), and PoP status (`NoStatus (0)` initially). Idempotent.

### 3. Register `e2eowned.dot` directly as Bob

The S3 negative scenario asserts that `polkadot-app-deploy` refuses to deploy to a domain owned by a different account (exit 78 with transfer guidance). Have Bob register the label with a DotNS registration tool outside `polkadot-app-deploy` — no Alice intermediary, no Bulletin content needed (S3 never reads content).

```bash
node tools/register-test-fixture.mjs e2eowned
```

Expected: `e2eowned.dot` is owned by Bob's H160 `0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01`. The `e2eowned.dot` label requires PoP Full status and a mature commitment (the tool waits 30s after the minimum commitment age). The tool is idempotent: it exits 0 immediately if Bob already owns it, and transfers the label from Alice back to Bob if fixture drift is detected.

If S3 ever fails because `e2eowned.dot` was transferred back to Alice by mistake, re-run this step to restore Bob's ownership.

---

## Paseo Next v2 (`--env paseo-next-v2`)

Paseo Next v2 uses a separate Asset Hub (`wss://paseo-asset-hub-next-rpc.polkadot.io`) and Bulletin chain (`wss://paseo-bulletin-next-rpc.polkadot.io`) with different contract addresses. The `map_account` extrinsic does not exist on this chain — account mapping is triggered automatically when an account submits its first on-chain transaction.

> **Note on PoP grants:** The paseo-next-v2 `POP_RULES` contract (`0x2002C1c15b88632Ad01c7770f6EbE1Ca05c8472E`) is **not permissionless** — `setUserPopStatus` can only be called by its owner. `polkadot-app-deploy` cannot upgrade a signer itself; a status grant (whitelisting) is performed out of band by the contract owner. To request one for a signer, open an issue on [paritytech/dotns](https://github.com/paritytech/dotns/issues). CI scenarios pick labels via `pickStableLabel`/`pickDirectLabel`/`pickIncLabel`/`pickRotLabel`, which auto-select between a PoP-Full base name (e.g. `e2epool.dot`) and a NoStatus fallback (e.g. `e2epoolns01.dot`) based on what `Personhood.personhoodStatus(<signer>)` returns at test start. The setup below covers both modes.

> **⚠ Testnet wipes reset everything.** When paseo-next-v2 is reset (which happens periodically), Alice's Personhood precompile status drops to NoStatus *and* every `e2e*.dot` registration is gone. Re-run the relevant steps below after each wipe — there is no on-chain self-recovery. A subtle failure mode to watch for: Alice's status can come back as Full while `e2epool.dot` is unregistered, so `setContenthash` reverts with `ERC721NonexistentToken`. As long as ownership stays in lockstep with Alice's PoP grade (Full ↔ PoP-Full labels registered; NoStatus ↔ NoStatus labels auto-register on first deploy), the nightly stays green.

### Prerequisites

- `polkadot-app-deploy` built locally (`npm run build`).
- Alice (`5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV`) funded on paseo-next-v2 Asset Hub. This is a restricted testnet with no public faucet — the account must be funded out of band by the network operator.

### 1. Authorize pool accounts on Bulletin Next

```bash
polkadot-app-bootstrap --env paseo-next-v2
```

This grants each pool account `TransactionStorage` quota on Bulletin Next. Alice (`//Alice`) must be funded and mapped on Asset Hub Next for this to succeed (Alice's mapping is triggered automatically by her first on-chain tx, so funding alone is sufficient).

### 2. Verify Alice PoP status

```bash
node tools/check-pop-status.mjs --env paseo-next-v2
```

What you see decides which labels need pre-registration:

- **`NoStatus (0)`** → no extra work. The tests pick the NoStatus fallback labels (`e2epoolns01`, `e2edirect01`, `e2eincpool01`, `e2erotpool01`) which auto-register on first deploy because their shape (base length ≥ 9 with two trailing digits) bypasses the `Requires Full personhood verification` gate.
- **`ProofOfPersonhoodFull (2)`** → Alice has been flipped to Full on the Personhood precompile. The tests will now pick the PoP-Full stable labels (`e2epool`, `e2edirect`, `e2einc`, `e2erot`), and those **must already be registered to Alice** before the matrix runs. Register them once:

  ```bash
  # Pre-built fixture is fine — it's the contenthash, not the content, that the tests overwrite.
  for label in e2epool e2edirect e2einc e2erot; do
    node bin/polkadot-app-deploy test/fixtures/e2e-spa "${label}.dot" --env paseo-next-v2 --js-merkle
  done
  ```

  Skipping this leaves `setContenthash` reverting with `ERC721NonexistentToken` on whichever PoP-Full label the scenario picks.

### 3. Fund Bob and trigger his account mapping

Bob (`5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty`) needs PAS on paseo-next-v2 Asset Hub so he can pay fees for the `e2eowned.dot` registration. As above, this testnet has no public faucet — fund his SS58 address (~1 PAS) out of band. His H160 mapping (`0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01`) is triggered automatically when he submits his first on-chain tx.

Verify his mapping:

```bash
node tools/check-pop-status.mjs --env paseo-next-v2 \
  "bottom drive obey lake curtain smoke basket hold race lonely fit walk//Bob"
```

Expected output: Bob's SS58, his H160 (`0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01`), and PoP status.

### 4. Verify Bob PoP status

Bob owns both `e2eownedns02.dot` (NoStatus, used by S3 when Alice is NoStatus) and `e2eowned.dot` (PoP-Full, used by S3 when the Personhood precompile has flipped Alice to Full). The NoStatus branch needs no admin help; the PoP-Full branch needed Bob to register it back when he was granted Full status once. After that one-shot registration the label persists until expiry, so Bob can stay NoStatus going forward — ownership and PoP-grade are decoupled after registration.

### 5. Register `e2eownedns02.dot` directly as Bob

Register the domain using the dedicated tool:

```bash
node tools/register-test-fixture.mjs e2eownedns02
```

Expected: `e2eownedns02.dot` is owned by Bob (`0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01`).
The tool is idempotent: it leaves Bob-owned state alone and transfers the label back to Bob if a failed S3 fixture run accidentally left it owned by Alice.

### 6. Ensure Bob owns `e2eowned.dot` on paseo-next-v2

S3 picks `e2eowned.dot` when Alice is PoP-Full at test start. If the label is unregistered, Alice's deploy gets routed through the full register flow and her own H160 lands as owner — at which point every subsequent S3 run on the Full path "succeeds" cleanly (`exit 0`) instead of being rejected (`exit 78`), and the test fails. Bob must own this label.

If Bob already owns it (`ownerOf` on `DOTNS_REGISTRAR` returns `0x41dccbd…`), skip. Otherwise:

- **If nobody owns it yet:** registration needs Bob to hold Full PoP. Request Full PoP for Bob by opening an issue on [paritytech/dotns](https://github.com/paritytech/dotns/issues), then run `node tools/register-test-fixture.mjs e2eowned` (registers the label as Bob via `//Bob`). After registration Bob can drop back to NoStatus.
- **If Alice (or anyone other than Bob) is squatting:** the owner can call `transferFrom(<current>, Bob, tokenId)` on `DOTNS_REGISTRAR`. ERC721 transfer is unconditional on the recipient (no PoP check) and doesn't need Bob's signer. Run `node tools/transfer-dotns-name.mjs --label e2eowned --to 0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01 --env paseo-next-v2` to do this for Alice → Bob in one shot.

---

## No pre-registration needed for `e2epoolns01.dot` / direct NoStatus labels

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
