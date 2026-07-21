#!/usr/bin/env bash
#
# install.sh - one-shot bootstrap for the Spoof-Tunnel toolkit.
# Copies the management CLI and (pre)builds the core binary, then launches
# the interactive menu. Run as root on Ubuntu 22.04.
#
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root: sudo ./install.sh"; exit 1; }

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_CLI="/usr/local/bin/spoof-tunnel"
BIN="/usr/local/bin/spooftun"

echo ">> Installing base dependencies..."
apt-get update -qq || true
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    whiptail wireguard wireguard-tools iproute2 iptables build-essential >/dev/null 2>&1 || true

echo ">> Installing spooftun core binary..."
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  CAND="${SRC_DIR}/bin/spooftun-amd64" ;;
  aarch64) CAND="${SRC_DIR}/bin/spooftun-arm64" ;;
  *)       CAND="" ;;
esac
if [[ -n "$CAND" && -f "$CAND" ]]; then
  install -m 0755 "$CAND" "$BIN"
  echo "   installed prebuilt binary for $ARCH"
else
  echo "   no prebuilt binary for $ARCH; compiling from source..."
  ( cd "${SRC_DIR}/core" && make native && install -m 0755 ./spooftun "$BIN" )
fi

echo ">> Installing management CLI -> ${DEST_CLI}"
install -m 0755 "${SRC_DIR}/scripts/spoof-tunnel.sh" "$DEST_CLI"

echo
echo "Done. Launch the manager any time with:  spoof-tunnel"
echo "Launching now..."
exec "$DEST_CLI"
