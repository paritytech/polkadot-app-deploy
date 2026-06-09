# Testing

> Contributor reference. The offline suite runs anywhere; everything past it needs testnet access — see [E2E test setup](./e2e-bootstrap.md) for the one-time chain setup.

The repo has three practical test layers: offline unit tests, live-testnet E2E coverage, and GitHub Actions matrices that exercise the shipped reusable workflow.

## Offline tests

```bash
npm test
```

This runs the local Node test suite without network access.

## Live-testnet E2E

The E2E suite deploys real content to the Bulletin Chain and verifies the on-chain round-trip.

Local launchers:

```bash
npm run test:e2e:smoke
npm run test:e2e:pr
npm run test:e2e:nightly
```

Quiet mode:

```bash
E2E_QUIET=1 npm run test:e2e:smoke
E2E_QUIET=1 npm run test:e2e:pr
E2E_QUIET=1 npm run test:e2e:nightly
```

Each scenario writes a JUnit XML report under `e2e-reports/`.

For one-time chain setup, see [E2E test setup](./e2e-bootstrap.md).

## CI matrices

`.github/workflows/e2e.yml` calls the shipped reusable `.github/workflows/deploy.yml` so the E2E jobs exercise the same path consumers use.

- per-PR: stable happy-path coverage plus negative ownership coverage
- nightly: broader signer, merkleization, and mirror-path coverage

E2E deploys are tagged so telemetry can distinguish them from real-user traffic. See [Telemetry](./telemetry.md).
