# Telemetry

Telemetry is **strictly opt-in** — it is off by default and never enabled automatically.

## Opt in / opt out

- `PAD_TELEMETRY=1`: explicit opt-in — also overrides `DO_NOT_TRACK`
- `PAD_TELEMETRY=0` or `PAD_TELEMETRY=off`: force off
- `DO_NOT_TRACK=1`: telemetry is disabled (standard EFF Do Not Track convention); overridden only by an explicit `PAD_TELEMETRY=1`
- unset: off (default)

Precedence (highest to lowest): explicit opt-out → explicit opt-in → DO_NOT_TRACK → default off.

## The Sentry DSN (`SENTRY_DSN`)

Telemetry is sent to a Sentry project identified by a **DSN** (Data Source Name). By default the DSN is baked into the package **at build time** from the `SENTRY_DSN` environment variable — `npm run build` embeds it as a build constant. A `SENTRY_DSN` set at **runtime** takes precedence over that baked-in value, so you can point an already-built binary at a different project without rebuilding.

```sh
SENTRY_DSN="https://<key>@<org>.ingest.sentry.io/<project>" npm run build
```

This package is **published with no DSN** — the build that ships to npm embeds an empty DSN, so even with `PAD_TELEMETRY=1` there is nowhere for events to go and telemetry stays inert, unless you supply `SENTRY_DSN` yourself (at build time as above, or at runtime).

A Sentry DSN is a **public project identifier, not a secret**: it only authorizes *sending* events to that project and grants no access to data already collected — so it is safe to commit or ship in a build.

## What is tracked

- deploy duration and success/failure
- storage phase timing
- DotNS phase timing
- pool account selection
- source metadata such as repo, branch, and CI vs local
- tool version

## Ambient Sentry mode

If another app embeds `polkadot-app-deploy` and already owns Sentry initialization, set these before importing or invoking the library:

```sh
PAD_USE_AMBIENT_SENTRY=1
PAD_HOST_APP=<your-app-name>
PAD_HOST_APP_VERSION=<your-app-version>
```

`PAD_HOST_APP_VERSION` is optional but recommended — it populates `deploy.host_app_version` on every span, enabling version-correlated triage in your Sentry dashboard.

That makes `polkadot-app-deploy` reuse the existing Sentry client instead of calling its own `Sentry.init()`.

Requirements:

- the host app must initialize Sentry first
- Sentry SDK compatibility still matters
- quotas and issue grouping remain owned by the host project

## Tagging test traffic

Use `--tag` or `DEPLOY_TAG` to separate test and benchmark traffic from real deploys.

Examples:

```bash
polkadot-app-deploy --tag ci-smoke ./build my-app.paseo
DEPLOY_TAG=load-test polkadot-app-deploy ./build my-app.paseo
```

Use any label that distinguishes a class of deploy — for example, separating CI smoke runs, nightly runs, and load tests from real user traffic so they can be filtered apart in telemetry.
