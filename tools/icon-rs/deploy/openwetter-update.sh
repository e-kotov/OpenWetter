#!/bin/sh
# Install the newest publisher build if it differs from the installed one.
# GitHub Actions builds every change to tools/icon-rs on main and publishes it
# as the "publisher" release of the public repository (binary + SHA256SUMS).
# Runs from openwetter-update.service under the shared publish lock, so the
# binary is never swapped while a job is starting; a running job keeps the
# file it started with anyway. Changes to the systemd units still need
# install.sh (rare); this only replaces the binary.
set -eu
REPO=${OPENWETTER_REPO:-e-kotov/OpenWetter}
BASE="https://github.com/$REPO/releases/download/publisher"
ASSET=icon-rs-x86_64-linux
BIN=/opt/openwetter/bin/icon-rs
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if ! curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$BASE/SHA256SUMS"; then
  echo "no publisher release reachable; keeping the installed binary"
  exit 0
fi
want=$(awk -v a="$ASSET" '$2==a || $2=="*"a {print $1}' "$tmp/SHA256SUMS")
case "$want" in
  [0-9a-f]*) [ ${#want} -eq 64 ] || { echo "malformed SHA256SUMS" >&2; exit 1; } ;;
  *) echo "SHA256SUMS lists no $ASSET" >&2; exit 1 ;;
esac
have=$(sha256sum "$BIN" 2>/dev/null | cut -d' ' -f1 || true)
[ "$want" = "$have" ] && exit 0

curl -fsSL --retry 3 -o "$tmp/$ASSET" "$BASE/$ASSET"
echo "$want  $tmp/$ASSET" | sha256sum -c --quiet -
chmod 0755 "$tmp/$ASSET"
version=$("$tmp/$ASSET" --version) # must run on this system before it replaces anything
[ -f "$BIN" ] && cp -p "$BIN" "$BIN.previous"
cp "$tmp/$ASSET" "$BIN.new"
mv -f "$BIN.new" "$BIN"
echo "updated publisher to $version"
