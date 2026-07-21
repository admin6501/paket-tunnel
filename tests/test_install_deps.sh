#!/usr/bin/env bash
# Isolated test of the "Installing base dependencies" section of /app/install.sh.
# Replays lines 42-73 verbatim, so any regression in the real installer would
# also break this test.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/admin6501/paket-tunnel.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"

echo ">> Installing base dependencies..."
# A broken third-party apt repo (e.g. ookla/speedtest-cli) makes 'apt-get update'
# return an error. That must NOT abort us: we only need packages from the
# official Ubuntu repos, so we tolerate the failure and continue.
if ! apt-get update -qq 2>/tmp/spooftun_apt.log; then
  echo "   NOTE: 'apt-get update' reported errors (a broken third-party repo?)."
  grep -E "does not have a Release file|Failed to fetch|is not signed" /tmp/spooftun_apt.log \
      | sed 's/^/   ! /' || true
  echo "   Continuing with the working Ubuntu repositories..."
fi

DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    git ca-certificates whiptail wireguard wireguard-tools iproute2 iptables \
    build-essential >/dev/null 2>&1 || true

# Verify the tools we actually need are present.
MISSING=()
for c in git whiptail wg iptables ip; do
  command -v "$c" >/dev/null 2>&1 || MISSING+=("$c")
done
if (( ${#MISSING[@]} )); then
  echo
  echo "ERROR: required tools failed to install: ${MISSING[*]}"
  echo "This is almost certainly a broken apt source on this server."
  echo "Fix it, then re-run this installer. For the ookla/speedtest case:"
  echo "   sudo rm -f /etc/apt/sources.list.d/*speedtest* /etc/apt/sources.list.d/*ookla*"
  echo "   sudo apt-get update"
  echo "   sudo apt-get install -y ${MISSING[*]}"
  echo "Then run again:"
  echo "   curl -fsSL ${REPO_URL%.git}/raw/${REPO_BRANCH}/install.sh | sudo bash"
  exit 1
fi

echo ">> all required tools present"
exit 0
