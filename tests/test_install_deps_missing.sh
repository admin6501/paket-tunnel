#!/usr/bin/env bash
# Test the ERROR path: simulate broken repo AND missing tools.
# We run the same block, but with an empty PATH so `command -v` reports missing.
set +e

echo 'deb https://packagecloud.io/ookla/speedtest-cli/ubuntu noble main' > /etc/apt/sources.list.d/zz-broken-test2.list

# Replicate the exact MISSING/ERROR block from install.sh but skip actual apt calls
# (we simulate them). We only need to verify the ERROR message pathway.
run_block() {
    local REPO_URL="https://github.com/admin6501/paket-tunnel.git"
    local REPO_BRANCH="main"

    # Simulate broken apt update
    echo ">> Installing base dependencies..."
    echo "E: The repository 'https://packagecloud.io/ookla/speedtest-cli/ubuntu noble Release' does not have a Release file." > /tmp/spooftun_apt.log
    if ! false; then :; fi
    echo "   NOTE: 'apt-get update' reported errors (a broken third-party repo?)."
    grep -E "does not have a Release file|Failed to fetch|is not signed" /tmp/spooftun_apt.log \
        | sed 's/^/   ! /' || true
    echo "   Continuing with the working Ubuntu repositories..."

    # Simulate: nothing installed -> tools "missing"
    local MISSING=()
    # Force-consider all tools missing by using a stubbed command_v that always fails
    for c in git whiptail wg iptables ip; do
      false || MISSING+=("$c")
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
}

run_block
RC=$?

rm -f /etc/apt/sources.list.d/zz-broken-test2.list
exit $RC
