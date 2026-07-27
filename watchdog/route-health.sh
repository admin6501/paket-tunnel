#!/usr/bin/env bash
#
# route-health.sh — probe every address the tunnel can use, and make sure the
# one pinned as primary is a live one.
#
# Backpack already fails over between fallback_addrs inside the running
# process. What it cannot do is remember the outcome: after a restart the
# client goes back to dialling remote_addr, which may be the address that was
# filtered in the first place. This job closes that gap — when the pinned
# primary is dead and a spare answers, it promotes the spare in the config so
# the choice survives restarts and reboots.
#
# Runs on the KHAREJ (client) side. Installed as a systemd timer by
# ./install.sh; safe to run by hand at any time.
#
# Usage: route-health.sh [--name main] [--dry-run]

set -euo pipefail

CONF_DIR="${BACKPACK_CONF_DIR:-/etc/backpack}"
NAME="main"
DRY=0
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-6}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)    NAME="${2:?--name needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

CONF="$CONF_DIR/$NAME.toml"
[[ -r "$CONF" ]] || { echo "no readable config at $CONF" >&2; exit 1; }

log() { printf '[route-health] %s\n' "$*"; }

# --- read the addresses out of the config -------------------------------

# remote_addr = "1.2.3.4:443"
primary="$(sed -n 's/^[[:space:]]*remote_addr[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$CONF" | head -1)"
[[ -n "$primary" ]] || { log "no remote_addr in $CONF — is this the client side?"; exit 1; }

# fallback_addrs = ["a:1", "b:2"]  -> one per line
mapfile -t spares < <(
  sed -n 's/^[[:space:]]*fallback_addrs[[:space:]]*=[[:space:]]*\[\(.*\)\].*/\1/p' "$CONF" \
    | head -1 | grep -o '"[^"]*"' | tr -d '"'
)

# --- probe ---------------------------------------------------------------

# A TCP connect is the honest test here: it is exactly what the tunnel does,
# so it fails for the same reasons the tunnel would. ICMP would not — a
# filtered address very often still answers ping.
probe() {
  local addr="$1" host port
  host="${addr%:*}"; port="${addr##*:}"
  [[ "$host" == "$port" ]] && return 1     # no port given, cannot probe
  timeout "$CONNECT_TIMEOUT" bash -c \
    "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null
}

alive=()
if probe "$primary"; then
  log "primary $primary OK"
  primary_ok=1
else
  log "primary $primary DOWN"
  primary_ok=0
fi

for s in "${spares[@]:-}"; do
  [[ -z "$s" ]] && continue
  if probe "$s"; then
    log "spare $s OK"
    alive+=("$s")
  else
    log "spare $s DOWN"
  fi
done

# --- act -----------------------------------------------------------------

unit="backpack-$NAME.service"

if ! systemctl is-active --quiet "$unit"; then
  log "$unit is not running — starting it"
  [[ $DRY -eq 0 ]] && systemctl start "$unit"
fi

if [[ $primary_ok -eq 1 ]]; then
  exit 0
fi

if [[ ${#alive[@]} -eq 0 ]]; then
  # Every route is gone. Restarting will not conjure one, and thrashing the
  # service makes the logs useless for working out when the outage began, so
  # this is deliberately a report and nothing else.
  log "ALL ROUTES DOWN — no address answered. This is an outage, not a config"
  log "problem. Reach the server over the DNS control channel to investigate."
  exit 3
fi

promote="${alive[0]}"
log "promoting $promote to primary (was $primary)"

if [[ $DRY -eq 1 ]]; then
  log "dry run — config not changed"
  exit 0
fi

# Swap the two addresses: the dead primary becomes a spare rather than being
# dropped, since a filtered address very often comes back.
new_spares=()
for s in "${spares[@]:-}"; do
  [[ -z "$s" ]] && continue
  [[ "$s" == "$promote" ]] && continue
  new_spares+=("$s")
done
new_spares+=("$primary")

spare_toml=""
for s in "${new_spares[@]}"; do
  [[ -n "$spare_toml" ]] && spare_toml+=", "
  spare_toml+="\"$s\""
done

cp -a "$CONF" "$CONF.bak.$(date +%Y%m%d%H%M%S)"
tmp="$(mktemp)"
sed -e "s|^\([[:space:]]*remote_addr[[:space:]]*=[[:space:]]*\).*|\1\"$promote\"|" \
    -e "s|^\([[:space:]]*fallback_addrs[[:space:]]*=[[:space:]]*\).*|\1[$spare_toml]|" \
    "$CONF" >"$tmp"
cat "$tmp" >"$CONF"      # preserve the original mode and ownership
rm -f "$tmp"

log "config updated, restarting $unit"
systemctl restart "$unit"
log "done — primary is now $promote"
