#!/usr/bin/env bash
# Install the Kubo (go-ipfs) binary with a source fallback.
#
# Usage: install-kubo.sh <version>          e.g. install-kubo.sh v0.33.0
#
# Sources are tried in order: dist.ipfs.tech, then the GitHub release asset.
# EVERY source is verified against a sha512 PINNED IN THIS REPO (the case table
# below), not against a .sha512 file fetched from the same host: a compromised
# host could serve a matching tarball/checksum pair. A mismatch is a failure for
# that source and the next one is tried. See paritytech/polkadot-app-deploy#303
# (dist.ipfs.tech outage). A cached binary (KUBO_CACHE_DIR, restored by
# actions/cache) skips the network entirely.
#
# To bump Kubo: take the hash from the release's .sha512 file, cross-check it
# against the tarball you download, and add a case entry here AND in deploy.yml.
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
#   INSTALL_KUBO_TEST_SHA512    URLs / expected hash, used by
#                               test/install-kubo.test.js against a local
#                               server and a fake tarball. Verification still
#                               applies to every source. deploy.yml honours
#                               neither.
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

if [ -n "${INSTALL_KUBO_TEST_SHA512:-}" ]; then
  KUBO_SHA512="$INSTALL_KUBO_TEST_SHA512"
else
# BEGIN install-kubo-pin
case "${KUBO_VERSION}/${KUBO_ARCH}" in
  v0.33.0/linux-amd64) KUBO_SHA512="6551acf9be99f98bb4c853a0b22004f2703f0cb13f34111e863d77aa10032ead2c89eb9a8d6fccb4da11011e8d29a8cb251bd3e6651fdbaa3209e3b1bfb5e4f4" ;;
  *)
    echo "::error::No pinned sha512 for Kubo ${KUBO_VERSION} ${KUBO_ARCH}. Add it to the case table in .github/scripts/install-kubo.sh and in the inline step of .github/workflows/deploy.yml (hash from the release checksum file, cross-checked against the downloaded tarball)."
    exit 1
    ;;
esac
# END install-kubo-pin
fi

# BEGIN install-kubo-fetch
sha512_of() {
  if command -v sha512sum >/dev/null 2>&1; then sha512sum "$1" | cut -d' ' -f1; else shasum -a 512 "$1" | cut -d' ' -f1; fi
}
# --speed-limit/--speed-time abort a host that trickles bytes, so failover is not stalled by --max-time x retries.
KUBO_CURL=(curl --fail --silent --show-error --location --retry 2 --retry-all-errors --retry-delay 1 --connect-timeout 10 --max-time 120 --speed-limit 50000 --speed-time 15)
KUBO_USED=""
for src in "${KUBO_SOURCES[@]}"; do
  rm -f "$WORK/$TARBALL"
  if ! "${KUBO_CURL[@]}" -o "$WORK/$TARBALL" "$src/$TARBALL"; then
    echo "::warning::Kubo source $src failed (download); trying next source"
    continue
  fi
  actual="$(sha512_of "$WORK/$TARBALL")"
  if [ "$actual" != "$KUBO_SHA512" ]; then
    echo "::warning::Kubo source $src failed (sha512 mismatch: pinned $KUBO_SHA512, got $actual); trying next source"
    continue
  fi
  KUBO_USED="$src"
  break
done
if [ -z "$KUBO_USED" ]; then
  echo "::error::Kubo ${KUBO_VERSION} could not be downloaded and verified: all sources failed (${KUBO_SOURCES[*]})"
  exit 1
fi
echo "::notice::Kubo ${KUBO_VERSION} downloaded from $KUBO_USED (sha512 matches the pinned hash)"
# END install-kubo-fetch

tar -xzf "$WORK/$TARBALL" -C "$WORK"
mkdir -p "$CACHE_DIR"
install -m 0755 "$WORK/kubo/ipfs" "$CACHE_DIR/ipfs"
install_bin "$CACHE_DIR/ipfs"
