#!/usr/bin/env bash
#
# install-backpack.sh — install the bundled backpack binary for this machine's
# architecture, with no network access needed.
#
# This is the offline path. It matters more than it looks: the moment you
# actually need to bring a tunnel up is the moment GitHub is least likely to be
# reachable, and the upstream one-line installer downloads a release archive.
# The binaries here are already in the repo, so a clone you took earlier is
# enough.
#
# Usage: sudo ./bin/install-backpack.sh [--dest /usr/local/bin/backpack]

set -euo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
HERE="$(dirname "$SELF")"

DEST=/usr/local/bin/backpack

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)    DEST="${2:?--dest needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "run as root: sudo $0" >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64)  ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m) (amd64 and arm64 only)" >&2; exit 1 ;;
esac

SRC="$HERE/backpack-linux-$ARCH"
[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }

# The checksum is the only thing standing between a clone that travelled over a
# mirror or a USB stick and a binary you are about to run as root.
if [[ -f "$HERE/SHA256SUMS" ]] && command -v sha256sum >/dev/null 2>&1; then
  if ( cd "$HERE" && sha256sum -c --ignore-missing --quiet SHA256SUMS ); then
    echo "checksum OK"
  else
    echo "CHECKSUM MISMATCH — refusing to install $SRC" >&2
    exit 1
  fi
else
  echo "  ! could not verify the checksum (no SHA256SUMS or no sha256sum)" >&2
fi

install -m 0755 "$SRC" "$DEST"
mkdir -p /etc/backpack

echo "installed $ARCH build -> $DEST  ($("$DEST" -v 2>/dev/null || echo '?'))"
echo
echo "Next: set up a role with the deploy scripts, e.g."
echo "  sudo ./deploy/iran-server.sh --ports 443"
