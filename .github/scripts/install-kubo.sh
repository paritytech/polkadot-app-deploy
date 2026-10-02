#!/usr/bin/env bash
# Install the Kubo (go-ipfs) binary with a source fallback.
#
# Usage: install-kubo.sh <version>          e.g. install-kubo.sh v0.33.0
#
# Sources are tried in order: dist.ipfs.tech, then the GitHub release asset.
# Each tarball is verified against the .sha512 published NEXT TO IT on the same
# source ("<hash>  <file>"); a mismatch is a hard failure for that source and
# the next one is tried. See paritytech/polkadot-app-deploy#303 (dist.ipfs.tech
# outage). A cached binary (KUBO_CACHE_DIR, restored by actions/cache) skips the
# network entirely.
#
# IMPORTANT: .github/workflows/deploy.yml carries the same download logic
# INLINE (a reusable workflow cannot reference a script from its own repo: the
# path resolves against the caller's checkout). The regions between the
# "BEGIN/END install-kubo-*" markers below must stay byte-identical (modulo
# indentation) in both files; test/install-kubo.test.js enforces it.
#
# Env (all optional):
#   KUBO_ARCH                   default linux-amd64
#   KUBO_CACHE_DIR              default ~/.cache/kubo
#   KUBO_INSTALL_DIR            default /usr/local/bin
#   INSTALL_KUBO_TEST_SOURCES   TEST ONLY. Space-separated replacement base
#                               URLs, used by test/install-kubo.test.js against
#                               a local server. Checksum verification still
#                               applies to every source. deploy.yml does not
#                               honour it.
set -euo pipefail

KUBO_VERSION="${1:?usage: install-kubo.sh <version, e.g. v0.33.0>}"
KUBO_ARCH="${KUBO_ARCH:-linux-amd64}"
CACHE_DIR="${KUBO_CACHE_DIR:-$HOME/.cache/kubo}"
INSTALL_DIR="${KUBO_INSTALL_DIR:-/usr/local/bin}"

install_bin() {
  mkdir -p "$INSTALL_DIR" 2>/dev/null || true
  if [ -w "$INSTALL_DIR" ]; then install -m 0755 "$1" "$INSTALL_DIR/ipfs"; else sudo install -m 0755 "$1" "$INSTALL_DIR/ipfs"; fi
  "$INSTALL_DIR/ipfs" --version
}

if [ -x "$CACHE_DIR/ipfs" ] && "$CACHE_DIR/ipfs" --version 2>/dev/null | grep -qF "${KUBO_VERSION#v}"; then
  echo "::notice::Kubo ${KUBO_VERSION} restored from cache (no download)"
  install_bin "$CACHE_DIR/ipfs"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# BEGIN install-kubo-sources
TARBALL="kubo_${KUBO_VERSION}_${KUBO_ARCH}.tar.gz"
KUBO_SOURCES=(
  "https://dist.ipfs.tech/kubo/${KUBO_VERSION}"
  "https://github.com/ipfs/kubo/releases/download/${KUBO_VERSION}"
)
# END install-kubo-sources

if [ -n "${INSTALL_KUBO_TEST_SOURCES:-}" ]; then
  read -ra KUBO_SOURCES <<< "$INSTALL_KUBO_TEST_SOURCES"
fi

# BEGIN install-kubo-fetch
sha512_of() {
  if command -v sha512sum >/dev/null 2>&1; then sha512sum "$1" | cut -d' ' -f1; else shasum -a 512 "$1" | cut -d' ' -f1; fi
}
KUBO_CURL=(curl --fail --silent --show-error --location --retry 2 --retry-all-errors --retry-delay 1 --connect-timeout 10 --max-time 180)
KUBO_USED=""
for src in "${KUBO_SOURCES[@]}"; do
  rm -f "$WORK/$TARBALL" "$WORK/$TARBALL.sha512"
  if ! "${KUBO_CURL[@]}" -o "$WORK/$TARBALL.sha512" "$src/$TARBALL.sha512"; then
    echo "::warning::Kubo source $src failed (checksum file unreachable); trying next source"
    continue
  fi
  expected="$(awk 'NR==1 {print tolower($1)}' "$WORK/$TARBALL.sha512")"
  if ! [[ "$expected" =~ ^[0-9a-f]{128}$ ]]; then
    echo "::warning::Kubo source $src failed (malformed .sha512 file); trying next source"
    continue
  fi
  if ! "${KUBO_CURL[@]}" -o "$WORK/$TARBALL" "$src/$TARBALL"; then
    echo "::warning::Kubo source $src failed (tarball download); trying next source"
    continue
  fi
  actual="$(sha512_of "$WORK/$TARBALL")"
  if [ "$actual" != "$expected" ]; then
    echo "::warning::Kubo source $src failed (checksum mismatch: expected $expected, got $actual); trying next source"
    continue
  fi
  KUBO_USED="$src"
  break
done
if [ -z "$KUBO_USED" ]; then
  echo "::error::Kubo ${KUBO_VERSION} could not be downloaded and verified: all sources failed (${KUBO_SOURCES[*]})"
  exit 1
fi
echo "::notice::Kubo ${KUBO_VERSION} downloaded from $KUBO_USED (sha512 verified)"
# END install-kubo-fetch

tar -xzf "$WORK/$TARBALL" -C "$WORK"
mkdir -p "$CACHE_DIR"
install -m 0755 "$WORK/kubo/ipfs" "$CACHE_DIR/ipfs"
install_bin "$CACHE_DIR/ipfs"
