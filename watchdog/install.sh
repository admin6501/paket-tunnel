#!/usr/bin/env bash
#
# install.sh — install the route watchdog as a systemd timer.
#
# Runs on the kharej (client) side, where the tunnel is dialled from.
#
# Usage: sudo ./watchdog/install.sh [--name main] [--interval 60]

set -euo pipefail
# Resolve this file before changing directory, so --help can still read it.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")"

NAME="main"
INTERVAL=60

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)     NAME="${2:?--name needs a value}"; shift 2 ;;
    --interval) INTERVAL="${2:?--interval needs a value}"; shift 2 ;;
    -h|--help)  sed -n '2,7p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "run as root: sudo $0" >&2; exit 1; }

install -m 755 route-health.sh /usr/local/bin/paket-route-health

cat >/etc/systemd/system/paket-route-health.service <<EOF
[Unit]
Description=paket-tunnel route health check
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/paket-route-health --name $NAME
EOF

# OnUnitInactiveSec rather than OnCalendar: the interval should be measured
# from the end of the last probe, so a slow run cannot overlap the next one.
cat >/etc/systemd/system/paket-route-health.timer <<EOF
[Unit]
Description=Run the paket-tunnel route health check every ${INTERVAL}s

[Timer]
OnBootSec=90
OnUnitInactiveSec=${INTERVAL}
AccuracySec=5

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now paket-route-health.timer

cat <<EOF

Route watchdog installed — probing every ${INTERVAL}s for tunnel '$NAME'.

  Status:  systemctl status paket-route-health.timer
  Logs:    journalctl -u paket-route-health -f
  Manual:  paket-route-health --name $NAME --dry-run
EOF
