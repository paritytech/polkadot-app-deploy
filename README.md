# polkadot-app-deploy

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

Deploy a static web app to the [Polkadot Bulletin Chain](https://github.com/paritytech/polkadot-bulletin-chain) and serve it under a human-readable `.dot` name — from one command. Names are resolved through DotNS, Polkadot's on-chain naming system.

It targets Polkadot **testnets** (default: `paseo-next-v2`). This is reference tooling for putting a static site on-chain, not a managed hosting service — you run the deploys yourself, and there is no server or account to sign up for.

[![npm](https://img.shields.io/npm/v/polkadot-app-deploy)](https://www.npmjs.com/package/polkadot-app-deploy)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

## Features

- **On-chain static hosting** — Upload a built site (any framework, or plain HTML) to the Bulletin Chain and address it by a `.dot` name. No web server to run.
- **Mobile-wallet signing** — `login` once by scanning a QR with your Polkadot wallet; deploy with no mnemonic stored on disk.
- **Zero-signature testnet deploys** — a local worker registers the name and uploads the content, then transfers ownership to your signed-in account — no wallet taps in the default testnet flow.
- **Incremental uploads** — re-deploys only push the content chunks that changed, so updates are fast and cheap.
- **No native dependency required** — `--js-merkle` does content addressing in pure JavaScript; the IPFS Kubo binary is optional, not required.
- **Built-in environments** — target presets (RPC endpoints + contract addresses) selectable with `--env`, overridable per field.
- **Telemetry off by default** — opt-in only, and honors the `DO_NOT_TRACK` convention.

## Install

```sh
npm install -g @parity/polkadot-app-deploy
```

Installs two commands: **`polkadot-app-deploy`** (and its alias **`pad`**) for deploying, and **`polkadot-app-bootstrap`** (alias **`pad-bootstrap`**) for operator setup.

Requires **Node.js ≥ 22**. Content addressing uses the IPFS [Kubo](https://docs.ipfs.tech/install/) binary if it's on your `PATH`; otherwise pass `--js-merkle` to run it in pure JavaScript with no native dependency.

## Quick start

```sh
# Build your app, then deploy:
polkadot-app-deploy ./dist my-app.dot
# or using the short alias:
pad ./dist my-app.dot
```

Once it finishes, your site is served at `https://my-app.dot.li`.

New here? **[DEPLOYMENT.md](DEPLOYMENT.md)** walks you from prerequisites to a viewable app, step by step — including how to acquire a `.dot` name, what authorization a network requires (the raw "not authorized" chain error is a common first-run trap), and where a deployed site is viewable.

## Signing with a mobile wallet

Sign in once with your mobile Polkadot wallet — no mnemonic on disk:

```sh
polkadot-app-deploy login    # Scan the QR code with your Polkadot wallet app
polkadot-app-deploy whoami   # Show the currently signed-in address
polkadot-app-deploy logout   # Sign out and clear the session
```

After `login`, subsequent deploys hand the name to your signed-in account with **zero mobile signatures** (testnet): a local worker (the default dev account, or your `--mnemonic`) registers the name and uploads the content, then transfers ownership to your signed-in address as the final step. Pass `--no-transfer-to-signedin-user` to sign every DotNS transaction with your mobile session instead.

If a deploy's content lands but the final transfer fails, hand the name over separately:

```sh
polkadot-app-deploy transfer my-app.dot              # → the signed-in account
polkadot-app-deploy transfer my-app.dot --to 0x...   # → an explicit recipient
```

## Options

Run `polkadot-app-deploy --help` for the full option reference.

Key options:

| Option | Description |
|--------|-------------|
| `--env <id>` | Target environment (default: `paseo-next-v2`). Run `--list-environments` to see available IDs. |
| `--mnemonic "..."` | DotNS owner mnemonic (or set `MNEMONIC` env var). Alternative to session signing. |
| `--no-transfer-to-signedin-user` | When signed in, sign every DotNS tx with your mobile session instead of the default register-as-worker-then-hand-over flow. |
| `--to <0xH160>` | Recipient address for the `transfer` subcommand. Defaults to the signed-in account. |
| `--js-merkle` | Use pure-JS merkleization (no IPFS Kubo binary required). |
| `--publish` | List the domain in the on-chain Publisher registry after deploy. |
| `--config <path>` | Explicit path to `polkadot-app-deploy.config.ts` for product deploys. |
| `--tag "..."` | Label the deploy in telemetry. |
| `--version` | Print the installed version and exit. |

Subcommands: `login`, `logout`, `whoami` (session management, above) and `transfer <domain.dot>` (hand a name you registered to the signed-in account or `--to`).

## Environments

polkadot-app-deploy ships with built-in environment presets (RPC endpoints, contract addresses). The default is `paseo-next-v2`, a Polkadot testnet. Use `--list-environments` to print the table; override individual fields with `--environment-file <path>` or `--contract KEY=0x...`. For what a starting account needs on a given network — funding, a `.dot` name, authorization — see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Build from source

```sh
git clone https://github.com/paritytech/polkadot-app-deploy
cd polkadot-app-deploy
npm ci
npm run build
npm test          # offline unit tests
```

This produces the same `polkadot-app-deploy` CLI in `bin/`. See [`docs/testing.md`](docs/testing.md) for the live-testnet E2E suite.

## Releases

Releases use a two-stage flow: a release candidate is validated by the end-to-end test matrix against a live testnet, then the byte-identical source is published to npm under the stable version. Once Trusted Publishing is enabled, npm provenance will let you verify that a published release was built from this repository.

## Telemetry

Deploy telemetry (Sentry) is **off by default** and strictly opt-in. It activates only if you explicitly set `PAD_TELEMETRY=1`. Set `PAD_TELEMETRY=0` — or the cross-tool `DO_NOT_TRACK=1` — to force it off. Any Sentry DSN baked into the package is a public project identifier, not a secret — it grants no access to collected data.

Separately from telemetry, the CLI checks the npm registry for the minimum supported version. Set `PAD_UPDATE_CHECK=0` to disable that check.

## Contributing

Issues and pull requests are welcome on the GitHub repository. Releases are cut by the maintainers.

## Security

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

This repository contains reference and proof-of-concept code. Unless a specific release states otherwise, it has **not** received a full security audit. Use in production or production-like deployments should only follow an independent security review of the relevant code, configuration, generated output, and deployment environment.

Before deploying this for real use cases, you are responsible for:

- Reviewing the code yourself — we publish a reference, not a hardened production build.
- Checking that the dependencies are up to date and free of known vulnerabilities.
- Securing your own fork or deployment environment (keys, secrets, network configuration).
- Tracking the latest tagged release for security fixes; older releases are not backported (exceptions might apply).

Do **not** open a public issue for a suspected vulnerability. Follow Parity's responsible-disclosure process (`SECURITY.md`, inherited org-wide from [`paritytech/.github`](https://github.com/paritytech/.github/blob/main/SECURITY.md)) and email **security@parity.io**. For Parity's Bug Bounty programme, see https://parity.io/bug-bounty.

## License

[GPL-3.0-or-later](LICENSE). Versions up to and including 0.8.3 were published under Apache-2.0; the license changed to GPL-3.0-or-later ahead of the project being open-sourced.
