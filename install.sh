#!/usr/bin/env bash
#
# install.sh - installer for the Spoof-Tunnel toolkit (paket-tunnel).
#
# Two modes (auto-detected):
#   ONLINE  : run directly from GitHub, it clones the repo itself, e.g.
#               curl -fsSL https://raw.githubusercontent.com/admin6501/paket-tunnel/main/install.sh | sudo bash
#   OFFLINE : run from an already-cloned/copied repo directory:
#               sudo ./install.sh
#
# Force a mode:  sudo ./install.sh --online   |   sudo ./install.sh --offline
# Custom repo :  REPO_URL=... REPO_BRANCH=... sudo bash install.sh
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/admin6501/paket-tunnel.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/paket-tunnel}"
DEST_CLI="/usr/local/bin/spoof-tunnel"
BIN="/usr/local/bin/spooftun"

MODE="auto"
for a in "$@"; do
  case "$a" in
    --online)  MODE="online" ;;
    --offline) MODE="offline" ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run as root:  sudo ./install.sh"; exit 1; }

# ---- resolve where the repo files live ---------------------------------
SELF_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]:-}" ]]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fi

have_local_repo() {
  [[ -n "$1" && -f "$1/scripts/spoof-tunnel.sh" && -f "$1/core/spooftun.c" ]]
}

echo ">> Installing base dependencies..."
apt-get update -qq || true
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    git ca-certificates whiptail wireguard wireguard-tools iproute2 iptables \
    build-essential >/dev/null 2>&1 || true

# Decide source dir
SRC_DIR=""
if [[ "$MODE" != "online" ]] && have_local_repo "$SELF_DIR"; then
  SRC_DIR="$SELF_DIR"
  echo ">> OFFLINE mode: using local files at $SRC_DIR"
else
  echo ">> ONLINE mode: fetching from $REPO_URL ($REPO_BRANCH)"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "   updating existing clone at $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_BRANCH" >/dev/null 2>&1 || true
    git -C "$INSTALL_DIR" reset --hard "origin/${REPO_BRANCH}" >/dev/null 2>&1 || true
  else
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1 \
      || git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  SRC_DIR="$INSTALL_DIR"
fi

have_local_repo "$SRC_DIR" || { echo "ERROR: repo files not found in $SRC_DIR"; exit 1; }

# ---- install the core binary -------------------------------------------
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

# ---- install the manager CLI -------------------------------------------
echo ">> Installing management CLI -> ${DEST_CLI}"
install -m 0755 "${SRC_DIR}/scripts/spoof-tunnel.sh" "$DEST_CLI"

echo
echo "Done. Launch the manager any time with:  sudo spoof-tunnel"

# When piped from curl there is no interactive TTY; only auto-launch if we have one.
if [[ -t 0 && -t 1 ]]; then
  echo "Launching now..."
  exec "$DEST_CLI"
else
  echo "(Non-interactive install detected — run 'sudo spoof-tunnel' to start.)"
fi
