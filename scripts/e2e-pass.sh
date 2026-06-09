#!/usr/bin/env bash
# scripts/e2e-pass.sh — run E2E scenarios locally, mirroring what CI runs.
#
# Usage: bash scripts/e2e-pass.sh [--quiet|-q] [smoke|pr|nightly]
#
# Preconditions: complete docs/e2e-bootstrap.md once per testnet lifetime
# (Alice PoP Full, Bob funded+mapped, e2eowned.dot owned by Bob).
#
# Modes:
#   smoke   — 1 scenario: S1 pool/js. Fastest sanity check (~5 min).
#   pr      — 4 scenarios matching the per-PR CI matrix: S1 pool/js,
#             S1 direct/kubo, S3 pool/js, S4 pool/js (~20 min).
#   nightly — 12 scenarios covering the nightly matrix minus the runner
#             dimension: S1 full signer×merkle cube (4), S2 fresh per signer
#             with unique labels (2), S3 (1), S4 gh-pages mirror (1),
#             S5 commit-reveal race (1), S6 RPC failover (1), S-INC
#             incremental upload v2 per backend (2).
#             ~45–60 min.
#
# --quiet (or E2E_QUIET=1): suppresses live node:test output, bulletin-deploy
#   stdio streaming, and build logs. Summary box + XML report paths still print.
#   Designed for agent-driven invocation where streaming output bloats context.
#
# Each scenario emits a JUnit XML report to e2e-reports/<scenario>-<signer>-<merkle>.xml.
# All scenarios run through to completion even when one fails; results are
# aggregated in a final summary. Exit code = number of failing scenarios.

set -uo pipefail

QUIET="${E2E_QUIET:-0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -q|--quiet) QUIET=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) break ;;
  esac
done

MODE="${1:-smoke}"
TAG="e2e-local-${MODE}"
if [ -n "${DOTNS_ENV:-}" ] && [ -z "${PAD_ENV:-}" ]; then
  echo "warn: DOTNS_ENV is deprecated; use PAD_ENV" >&2
fi
PAD_ENV="${PAD_ENV:-${DOTNS_ENV:-paseo-next-v2}}"
REPORTS_DIR="e2e-reports"
mkdir -p "$REPORTS_DIR"
rm -f "$REPORTS_DIR"/*.xml "$REPORTS_DIR"/*.log 2>/dev/null || true

RESULTS=()
OVERALL_START=$(date +%s)

if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_GREEN=; C_RED=; C_DIM=; C_BOLD=; C_OFF=
fi

upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

# Build once up front so each scenario skips its own build step.
if [ "$QUIET" = "1" ]; then
  npm run build >/dev/null 2>&1
else
  echo "Building..."
  npm run build | tail -6
fi

run() {
  local scenario="$1" signer="$2" merkle="$3"
  local start=$(date +%s)
  local xml="$REPORTS_DIR/${scenario}-${signer}-${merkle}.xml"

  if [ "$QUIET" != "1" ]; then
    echo ""
    echo "══════════════════════════════════════════════════════════════"
    echo "  $(upper "$scenario") · ${signer} · ${merkle} · tag=${TAG}"
    echo "══════════════════════════════════════════════════════════════"
  fi

  # Reporters: always JUnit (for Claude / CI parsing). Add spec-to-stdout
  # only in non-quiet mode so humans see streaming test progress.
  local reporter_args=("--test-reporter=junit" "--test-reporter-destination=$xml")
  if [ "$QUIET" != "1" ]; then
    reporter_args=("--test-reporter=spec" "--test-reporter-destination=stdout" "${reporter_args[@]}")
  fi

  E2E=1 E2E_SCENARIO="$scenario" E2E_SIGNER="$signer" E2E_MERKLE="$merkle" \
    PAD_ENV="$PAD_ENV" DEPLOY_TAG="$TAG" E2E_QUIET="$QUIET" \
    node --test "${reporter_args[@]}" test/e2e.test.js
  local exit=$?

  local elapsed=$(($(date +%s) - start))
  if [ $exit -eq 0 ]; then
    RESULTS+=("PASS|$scenario|$signer|$merkle|$elapsed|$xml")
  else
    RESULTS+=("FAIL|$scenario|$signer|$merkle|$elapsed|$xml|$exit")
  fi
}

case "$MODE" in
  smoke)
    run s1 pool js
    ;;

  pr)
    run s1 pool   js
    run s1 direct kubo
    run s3 pool   js
    run s4 pool   js
    # S8: WS fault injection. dropAtMs=40s accounts for the manifest fetch
    # latency (~30s) that precedes chunk upload in incremental mode.
    GITHUB_RUN_ID=$(date +%s) GITHUB_SHA=$(openssl rand -hex 4) \
      run s8 direct js
    ;;

  nightly)
    for signer in pool direct; do
      for merkle in js kubo; do
        run s1 "$signer" "$merkle"
      done
    done
    for signer in pool direct; do
      GITHUB_RUN_ID=$(date +%s) GITHUB_SHA=$(openssl rand -hex 4) \
        run s2 "$signer" js
    done
    run s3 pool js
    run s4 pool js
    # S5 needs a per-run unique label (its register() retry path can only
    # exercise on a fresh, unowned label). Match the per-shard env override
    # used by S2 so RUN_TAG produces a unique e2e-s5<…> domain each run.
    GITHUB_RUN_ID=$(date +%s) GITHUB_SHA=$(openssl rand -hex 4) \
      run s5 pool js
    run s6 pool js
    # S-TRANSFER: register-as-worker then hand over via the `transfer` command,
    # plus idempotent re-run. Needs a per-run unique label (fresh registration).
    GITHUB_RUN_ID=$(date +%s) GITHUB_SHA=$(openssl rand -hex 4) \
      run s-transfer pool js
    # S-INC: incremental upload v2. Two deploys to e2einc.dot in succession;
    # second must show gateway-probe + chunk-skip signals. Both backends.
    # Same DotNS owner as other s-* scenarios; max-parallel: 1 in CI, here
    # we're sequential by default.
    run s-inc pool js
    run s-inc pool kubo
    # S-INC-RT: round-trip integrity check — verifies the manifest embedded
    # in the deployed CAR is readable back via the gateway and matches the
    # local manifest.json written during deploy.
    run s-inc-roundtrip pool js
    # S-INC-PORTABILITY: cross-workspace dedup — proves the embedded manifest
    # is portable by re-deploying the same fixture from a fresh workspace.
    run s-inc-portability pool js
    # S-INC-ASSET-ROTATION: realistic Vite rebuild — 9.6 MB SPA fixture,
    # one content-hashed bundle rotates (466 KB). Asserts second deploy
    # re-uploads ≤ 1.5 MB. Bounds the bytes-uploaded claim end-to-end.
    run s-inc-asset-rotation pool js
    # S8: WS fault injection — drop-once reconnect + rapid-storm bail.
    # wsHaltCallback fix (#287) prevents the activeBroadcasts.forEach OOM.
    run s8 direct js
    ;;

  *)
    echo "Usage: $0 [--quiet|-q] [smoke|pr|nightly]" >&2
    exit 2
    ;;
esac

# ─────────────────────────────── Summary ───────────────────────────────

TOTAL_ELAPSED=$(($(date +%s) - OVERALL_START))
TOTAL=${#RESULTS[@]}
FAILURES=0

echo ""
echo "${C_BOLD}─── E2E Test Pass Summary ── mode=${MODE} ── env=${PAD_ENV} ── tag=${TAG} ───────${C_OFF}"
echo ""
printf "${C_DIM}  %-10s %-8s %-7s %-8s %8s   %s${C_OFF}\n" "Scenario" "Signer" "Merkle" "Result" "Time" "Report"
echo "${C_DIM}  ──────────────────────────────────────────────────────────────${C_OFF}"

for r in "${RESULTS[@]}"; do
  IFS='|' read -r status scenario signer merkle elapsed xml rest <<< "$r"
  scenario_upper=$(upper "$scenario")
  log="${xml%.xml}.log"
  if [ "$status" = "PASS" ]; then
    printf "  %-10s %-8s %-7s ${C_GREEN}%-8s${C_OFF} %7ss   ${C_DIM}%s${C_OFF}\n" \
      "$scenario_upper" "$signer" "$merkle" "✓ PASS" "$elapsed" "$xml"
  else
    printf "  %-10s %-8s %-7s ${C_RED}%-8s${C_OFF} %7ss   ${C_DIM}%s${C_OFF}  ${C_RED}(exit=%s)${C_OFF}\n" \
      "$scenario_upper" "$signer" "$merkle" "✗ FAIL" "$elapsed" "$xml" "$rest"
    if [ -f "$log" ]; then
      printf "  %-10s %-8s %-7s %-8s %7s    ${C_DIM}↳ bulletin-deploy log: %s${C_OFF}\n" \
        "" "" "" "" "" "$log"
    fi
    FAILURES=$((FAILURES + 1))
  fi
done

echo "${C_DIM}  ──────────────────────────────────────────────────────────────${C_OFF}"
PASSED=$((TOTAL - FAILURES))
echo ""
if [ $FAILURES -eq 0 ]; then
  printf "  ${C_GREEN}✓ %d/%d scenarios passed${C_OFF}  ·  total %ds\n" \
    "$PASSED" "$TOTAL" "$TOTAL_ELAPSED"
else
  printf "  ${C_RED}✗ %d/%d scenarios failed${C_OFF}  (%d passed)  ·  total %ds\n" \
    "$FAILURES" "$TOTAL" "$PASSED" "$TOTAL_ELAPSED"
fi
echo ""
echo "  ${C_DIM}Sentry traces:${C_OFF} https://paritytech.sentry.io/traces/?query=deploy.tag%3A${TAG}"
echo "  ${C_DIM}Reports dir:${C_OFF}   ${REPORTS_DIR}/"
echo ""

exit $FAILURES
