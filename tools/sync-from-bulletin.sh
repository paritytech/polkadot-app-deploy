#!/usr/bin/env bash
# sync-from-bulletin.sh <FROM_REF> <TO_REF>
#
# Ports the bulletin-deploy <FROM_REF>..<TO_REF> delta (src/ + test/) onto this
# polkadot-app-deploy tree. DELTA-based, not copy-based: the twin carries its own
# divergences (Sentry DSN/project in telemetry.ts, package name in
# version-check.ts, env config, auth/SSO in deploy-actors.ts) and this tool must
# NOT clobber them. Hunks that conflict with a twin divergence are left as .rej
# for manual merge — the tool never silently overwrites.
#
# Codename surface is deliberately tiny and NOT auto-rewritten:
#   - the CLI name is centralized in src/cli-name.ts (one constant)
#   - the ".bulletin-deploy/" CAR wire path, the "bulletin-deploy.*" Sentry
#     namespace, the "bulletin-deploy@noreply" git author, and the "Bulletin"
#     chain name ALL stay identical in both repos
#   - package identity (name/bin) lives in package.json + bin/, which are NOT synced
# The delta is almost entirely codename-neutral logic, so no blanket sed is run;
# instead every added line that mentions "bulletin-deploy" is REPORTED so a human
# can confirm it's a wire-path/comment/namespace (keep) and not a package import
# specifier (which would need "@parity/polkadot-app-deploy").
#
# Usage:
#   tools/sync-from-bulletin.sh v0.11.0 v0.12.0
#   BULLETIN_REPO=/path/to/bulletin-deploy tools/sync-from-bulletin.sh <from> <to>
set -uo pipefail
BULLETIN="${BULLETIN_REPO:-/Users/ionut/Documents/GitHub/triangle-deploy}"
FROM="${1:?usage: sync-from-bulletin.sh <from-ref> <to-ref>}"
TO="${2:?usage: sync-from-bulletin.sh <from-ref> <to-ref>}"
TWIN="$(cd "$(dirname "$0")/.." && pwd)"
PATHS=(src test)
PATCH="$TWIN/.sync-from-bulletin.patch"

[ -d "$BULLETIN/.git" ] || { echo "bulletin-deploy repo not found at $BULLETIN (set BULLETIN_REPO)"; exit 1; }

echo "== generating delta: bulletin-deploy $FROM..$TO  (paths: ${PATHS[*]}) =="
git -C "$BULLETIN" diff --no-color "$FROM" "$TO" -- "${PATHS[@]}" > "$PATCH"
[ -s "$PATCH" ] || { echo "empty delta — nothing to sync"; rm -f "$PATCH"; exit 0; }
files=$(grep -cE '^diff --git' "$PATCH"); adds=$(grep -cE '^\+[^+]' "$PATCH"); dels=$(grep -cE '^-[^-]' "$PATCH")
echo "  delta: $files file(s), +$adds / -$dels lines"

echo "== applying to twin (reject-on-conflict; never overwrites divergences) =="
cd "$TWIN"
find src test -name '*.rej' -delete 2>/dev/null || true
# Prefer 3-way (uses ancestry if blobs are present); fall back to context-match.
git apply --reject --whitespace=nowarn --3way "$PATCH" 2>"$TWIN/.sync.log" \
  || git apply --reject --whitespace=nowarn "$PATCH" 2>>"$TWIN/.sync.log" || true

echo ""; echo "== result =="
rejs="$(find src test -name '*.rej' 2>/dev/null | sort)"
rej_count=$(printf '%s' "$rejs" | grep -c . || true)
applied=$(git -C "$TWIN" diff --name-only 2>/dev/null | grep -vE '\.rej$' | wc -l | tr -d ' ')
echo "  files changed (applied cleanly): $applied"
if [ "$rej_count" -gt 0 ]; then
  echo "  CONFLICTS — $rej_count file(s) need manual merge (hunks that hit twin divergences):"
  printf '%s\n' "$rejs" | sed 's/^/    /'
else
  echo "  no conflicts — every hunk applied"
fi

echo ""; echo "== codename review (confirm each is wire-path / comment / telemetry-ns, NOT a package import) =="
grep -nE '^\+.*bulletin-deploy' "$PATCH" \
  | grep -vE '\.bulletin-deploy/|bulletin-deploy@noreply|"bulletin-deploy\.' \
  | sed 's/^/    /' | head -25 || true
echo ""
echo "next: resolve any .rej, review 'git -C $TWIN diff', run build+tests, then commit."
