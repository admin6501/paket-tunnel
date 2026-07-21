#!/usr/bin/env bash
#
# spoof-tunnel.sh - Interactive management CLI for the Spoof-Tunnel
# (Iran relay  <->  foreign exit) built on source-spoofed ICMP/UDP + WireGuard.
#
# Requires: root, whiptail, wireguard-tools, iproute2, iptables.
# Target OS: Ubuntu 22.04.
#
# NOTE: This is an interactive whiptail menu. We deliberately do NOT use
# 'set -e'/'set -u' here: many commands legitimately return non-zero (whiptail
# Cancel/ESC, ping failures, 'iptables -C' existence checks, '[[ ]] &&' guards),
# and errexit would make the whole menu exit silently. We keep pipefail only.
set -o pipefail

# --------------------------------------------------------------------------
# Constants / paths
# --------------------------------------------------------------------------
CONF_DIR="/etc/spoof-tunnel"
CONF_FILE="${CONF_DIR}/config"
BACKUP_DIR="${CONF_DIR}/backups"
WG_IFACE="wgtun"
WG_CONF="/etc/wireguard/${WG_IFACE}.conf"
BIN="/usr/local/bin/spooftun"
SVC_TUN="spooftun.service"
SVC_WATCH="spoof-watchdog.service"
WATCHDOG_SCRIPT="/usr/local/bin/spoof-watchdog.sh"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Candidate locations for repo assets (bin/, core/) when the CLI is installed
# to /usr/local/bin and the source tree lives elsewhere.
ASSET_DIRS=("$REPO_DIR" "/opt/paket-tunnel" "/opt/spoof-tunnel")

# whiptail sizing
WT_H=20; WT_W=76; WT_MH=12

# --------------------------------------------------------------------------
# Config defaults
# --------------------------------------------------------------------------
ROLE=""                 # relay | exit
CARRIER="udp"           # udp | icmp
PEER_PUBLIC_IP=""       # public IP of the OTHER server
SPOOF_SRC=""            # whitelisted source IP we impersonate
WG_LOCAL_IP="10.20.20.1"
WG_PEER_IP="10.20.20.2"
WG_SUBNET="10.20.20.0/24"
WG_PORT="51820"         # WireGuard ListenPort
LOCAL_PORT="51821"      # daemon UDP port = WG Endpoint
CARRIER_PORT="8443"     # UDP carrier port
MAGIC="0x53504f46"
MTU="1280"
PUB_IFACE=""
WG_PRIV=""
WG_PUB=""
PEER_WG_PUB=""
FWD_PORTS=""            # space-separated list of "proto:port"

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
die() { echo "ERROR: $*" >&2; exit 1; }

need_root() { [[ $EUID -eq 0 ]] || die "Run as root (sudo)."; }

msg()  { whiptail --title "Spoof-Tunnel" --msgbox "$1" "${2:-$WT_H}" "$WT_W"; }
yesno(){ whiptail --title "Spoof-Tunnel" --yesno "$1" "${2:-$WT_H}" "$WT_W"; }

detect_pub_iface() {
  ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}'
}

load_config() {
  if [[ -f "$CONF_FILE" ]]; then
    source "$CONF_FILE" || true
  fi
  if [[ -z "${PUB_IFACE:-}" ]]; then
    PUB_IFACE="$(detect_pub_iface || true)"
  fi
  return 0
}

save_config() {
  mkdir -p "$CONF_DIR"
  cat > "$CONF_FILE" <<EOF
ROLE="${ROLE}"
CARRIER="${CARRIER}"
PEER_PUBLIC_IP="${PEER_PUBLIC_IP}"
SPOOF_SRC="${SPOOF_SRC}"
WG_LOCAL_IP="${WG_LOCAL_IP}"
WG_PEER_IP="${WG_PEER_IP}"
WG_SUBNET="${WG_SUBNET}"
WG_PORT="${WG_PORT}"
LOCAL_PORT="${LOCAL_PORT}"
CARRIER_PORT="${CARRIER_PORT}"
MAGIC="${MAGIC}"
MTU="${MTU}"
PUB_IFACE="${PUB_IFACE}"
WG_PRIV="${WG_PRIV}"
WG_PUB="${WG_PUB}"
PEER_WG_PUB="${PEER_WG_PUB}"
FWD_PORTS="${FWD_PORTS}"
EOF
  chmod 600 "$CONF_FILE"
}

input() { # prompt default -> echoes value
  local v
  v=$(whiptail --title "Spoof-Tunnel" --inputbox "$1" "$WT_H" "$WT_W" "$2" 3>&1 1>&2 2>&3) || return 1
  echo "$v"
}

# --------------------------------------------------------------------------
# 1. Install & setup
# --------------------------------------------------------------------------
do_install() {
  {
    echo 10; echo "# Updating apt..."
    apt-get update -qq >/dev/null 2>&1 || true
    echo 40; echo "# Installing dependencies (wireguard, iproute2, iptables, build tools)..."
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 \
        apt-get install -y -qq --no-install-recommends \
        wireguard wireguard-tools iproute2 iptables build-essential whiptail \
        >/dev/null 2>&1 || true
    echo 70; echo "# Installing spooftun binary..."
    install_binary
    echo 85; echo "# Applying sysctl (ip_forward, rp_filter=0, BBR)..."
    apply_sysctl
    echo 100; echo "# Done."
    sleep 1
  } | whiptail --title "Install & Setup" --gauge "Starting..." 8 "$WT_W" 0
  save_config
  msg "Installation complete.\n\nBinary: ${BIN}\nConfig: ${CONF_FILE}\n\nNext: choose server role (menu 2)."
}

install_binary() {
  # already installed? nothing to do.
  if [[ -x "$BIN" ]]; then return 0; fi

  local arch bin_name asset_dir bin_src=""
  arch="$(uname -m)"
  case "$arch" in
    x86_64)  bin_name="spooftun-amd64" ;;
    aarch64) bin_name="spooftun-arm64" ;;
    *)       bin_name="" ;;
  esac

  # look for a prebuilt binary across candidate asset dirs
  if [[ -n "$bin_name" ]]; then
    for asset_dir in "${ASSET_DIRS[@]}"; do
      if [[ -f "${asset_dir}/bin/${bin_name}" ]]; then
        bin_src="${asset_dir}/bin/${bin_name}"; break
      fi
    done
  fi

  if [[ -n "$bin_src" ]]; then
    install -m 0755 "$bin_src" "$BIN"
    return 0
  fi

  # fall back to compiling from source if we can find it
  for asset_dir in "${ASSET_DIRS[@]}"; do
    if [[ -f "${asset_dir}/core/spooftun.c" ]]; then
      ( cd "${asset_dir}/core" && make native >/dev/null 2>&1 && install -m 0755 ./spooftun "$BIN" )
      return 0
    fi
  done

  die "No prebuilt binary for ${arch} and no source to compile (searched: ${ASSET_DIRS[*]})."
}

apply_sysctl() {
  local f="/etc/sysctl.d/99-spoof-tunnel.conf"
  cat > "$f" <<EOF
net.ipv4.ip_forward = 1
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
  sysctl --system >/dev/null 2>&1 || true
  # rp_filter per-interface (must be 0 for spoofing to be received)
  [[ -n "$PUB_IFACE" ]] && sysctl -w "net.ipv4.conf.${PUB_IFACE}.rp_filter=0" >/dev/null 2>&1 || true
}

# --------------------------------------------------------------------------
# 2. Role selection
# --------------------------------------------------------------------------
do_role() {
  local r
  r=$(whiptail --title "Server Role" --menu "Select this server's role:" "$WT_H" "$WT_W" 4 \
      "relay" "Iran side (رله) - users connect here" \
      "exit"  "Foreign side (اکسیت) - reaches free internet" \
      3>&1 1>&2 2>&3) || return
  ROLE="$r"
  if [[ "$ROLE" == "relay" ]]; then
    WG_LOCAL_IP="10.20.20.1"; WG_PEER_IP="10.20.20.2"
  else
    WG_LOCAL_IP="10.20.20.2"; WG_PEER_IP="10.20.20.1"
  fi
  PEER_PUBLIC_IP=$(input "Enter the PUBLIC IP of the OTHER server\n(relay enters exit's IP, exit enters relay's IP):" "$PEER_PUBLIC_IP") || return
  save_config
  msg "Role set: ${ROLE}\nTunnel IP (this): ${WG_LOCAL_IP}\nTunnel IP (peer): ${WG_PEER_IP}\nPeer public IP: ${PEER_PUBLIC_IP}"
}

# --------------------------------------------------------------------------
# 3. Spoof-Tester
# --------------------------------------------------------------------------
do_spoof_test() {
  local mode
  mode=$(whiptail --title "Spoof-Tester" --menu \
     "Find a whitelisted range that actually crosses the gateway.\nRun LISTEN on the EXIT server first, then SEND on the RELAY server." \
     "$WT_H" "$WT_W" 4 \
     "listen" "This is EXIT: receive & log probes" \
     "send"   "This is RELAY: send spoofed probes" \
     3>&1 1>&2 2>&3) || return

  if [[ "$mode" == "listen" ]]; then
    local secs; secs=$(input "Listen duration (seconds):" "30") || return
    msg "Listening for probes for ${secs}s.\nRun SEND on the relay now.\nResults will be shown after."
    local out; out=$("$BIN" probe-listen --carrier "$CARRIER" --iface "$PUB_IFACE" \
                       --cport "$CARRIER_PORT" --seconds "$secs" 2>/dev/null || true)
    [[ -z "$out" ]] && out="(no probes received — that range/carrier likely does NOT pass)"
    whiptail --title "Spoof-Tester Results" --scrolltext --msgbox "$out" "$WT_H" "$WT_W"
  else
    local base cand secs
    base=$(input "Candidate whitelisted range base to test\n(e.g. 2.144.0. — a trailing octet will be appended):" "") || return
    secs=$(input "Probes per candidate:" "20") || return
    local list; list=$(input "Trailing octets to try (space separated):" "1 10 50 100 200") || return
    ( for o in $list; do
        cand="${base}${o}"
        "$BIN" probe-send --carrier "$CARRIER" --peer "$PEER_PUBLIC_IP" \
               --spoof "$cand" --cport "$CARRIER_PORT" --count "$secs" 2>/dev/null || true
      done ) &
    local pid=$!
    { for i in $(seq 1 20); do echo $((i*5)); sleep 0.3; done; wait $pid; echo 100; } \
        | whiptail --title "Sending probes" --gauge "Sending spoofed probes to exit..." 8 "$WT_W" 0
    msg "Probes sent for candidates: ${base}{${list}}.\nCheck the LISTEN results on the exit server to see which arrived, then set that source via menu 5."
  fi
}

# --------------------------------------------------------------------------
# 4. Carrier protocol
# --------------------------------------------------------------------------
do_carrier() {
  local c
  c=$(whiptail --title "Carrier Protocol" --menu "Which protocol passes the gateway?" \
      "$WT_H" "$WT_W" 3 \
      "udp"  "UDP carrier (recommended default)" \
      "icmp" "ICMP echo carrier" \
      3>&1 1>&2 2>&3) || return
  CARRIER="$c"
  if [[ "$CARRIER" == "udp" ]]; then
    CARRIER_PORT=$(input "UDP carrier port:" "$CARRIER_PORT") || return
  fi
  save_config
  msg "Carrier set to: ${CARRIER}"
}

# --------------------------------------------------------------------------
# 5. Fixed IPs + WireGuard keys
# --------------------------------------------------------------------------
do_wg_setup() {
  WG_LOCAL_IP=$(input "This server tunnel IP:" "$WG_LOCAL_IP") || return
  WG_PEER_IP=$(input "Peer tunnel IP:" "$WG_PEER_IP") || return
  SPOOF_SRC=$(input "Spoofed (whitelisted) SOURCE IP to impersonate:" "$SPOOF_SRC") || return

  if [[ -z "$WG_PRIV" ]] || yesno "WireGuard keys exist. Regenerate them?\n(You must update the peer's config with the new public key.)"; then
    WG_PRIV="$(wg genkey)"
    WG_PUB="$(echo "$WG_PRIV" | wg pubkey)"
  fi

  msg "This server WireGuard PUBLIC key:\n\n${WG_PUB}\n\nCopy it to the OTHER server (you'll paste it there as 'peer public key')."
  PEER_WG_PUB=$(input "Paste the PEER's WireGuard PUBLIC key:" "$PEER_WG_PUB") || return

  save_config
  write_wg_conf
  msg "WireGuard config written to ${WG_CONF}\nTunnel: ${WG_LOCAL_IP} <-> ${WG_PEER_IP}"
}

write_wg_conf() {
  local allowed
  if [[ "$ROLE" == "relay" ]]; then
    allowed="${WG_SUBNET}"
  else
    allowed="${WG_SUBNET}"
  fi
  mkdir -p /etc/wireguard
  cat > "$WG_CONF" <<EOF
[Interface]
Address = ${WG_LOCAL_IP}/24
PrivateKey = ${WG_PRIV}
ListenPort = ${WG_PORT}
MTU = ${MTU}

[Peer]
PublicKey = ${PEER_WG_PUB}
Endpoint = 127.0.0.1:${LOCAL_PORT}
AllowedIPs = ${allowed}
PersistentKeepalive = 25
EOF
  chmod 600 "$WG_CONF"
}

# --------------------------------------------------------------------------
# 6. Port forwarding (Xray inputs) — exit side NAT / relay side dnat
# --------------------------------------------------------------------------
do_forward() {
  local act
  act=$(whiptail --title "Port Forwarding" --menu "Manage Xray input forwards:" \
     "$WT_H" "$WT_W" 4 \
     "add"    "Add a forward (proto:port)" \
     "list"   "List current forwards" \
     "del"    "Remove a forward" \
     "apply"  "(Re)apply all iptables rules now" \
     3>&1 1>&2 2>&3) || return
  case "$act" in
    add)
      local p; p=$(input "Enter forward as proto:port (e.g. tcp:443):" "tcp:443") || return
      FWD_PORTS="${FWD_PORTS} ${p}"; FWD_PORTS="$(echo "$FWD_PORTS" | xargs)"
      save_config; apply_forwards; msg "Added ${p}." ;;
    list)
      msg "Current forwards:\n${FWD_PORTS:-<none>}" ;;
    del)
      local p; p=$(input "Remove which forward (proto:port)?:" "") || return
      FWD_PORTS="$(echo "$FWD_PORTS" | tr ' ' '\n' | grep -vx "$p" | xargs || true)"
      save_config; msg "Removed ${p}. Re-apply rules via 'apply'." ;;
    apply) apply_forwards; msg "Rules applied." ;;
  esac
}

apply_forwards() {
  # On relay: DNAT the public port to the peer tunnel IP (Xray runs on exit),
  # on exit: MASQUERADE outbound so Xray-forwarded traffic reaches internet.
  [[ -n "$PUB_IFACE" ]] || PUB_IFACE="$(detect_pub_iface || true)"
  if [[ "$ROLE" == "relay" ]]; then
    for entry in $FWD_PORTS; do
      local proto="${entry%%:*}" port="${entry##*:}"
      iptables -t nat -C PREROUTING -i "$PUB_IFACE" -p "$proto" --dport "$port" \
          -j DNAT --to-destination "${WG_PEER_IP}:${port}" 2>/dev/null || \
        iptables -t nat -A PREROUTING -i "$PUB_IFACE" -p "$proto" --dport "$port" \
          -j DNAT --to-destination "${WG_PEER_IP}:${port}"
      iptables -t nat -C POSTROUTING -o "$WG_IFACE" -p "$proto" -d "$WG_PEER_IP" --dport "$port" \
          -j MASQUERADE 2>/dev/null || \
        iptables -t nat -A POSTROUTING -o "$WG_IFACE" -p "$proto" -d "$WG_PEER_IP" --dport "$port" \
          -j MASQUERADE
    done
  else
    iptables -t nat -C POSTROUTING -o "$PUB_IFACE" -j MASQUERADE 2>/dev/null || \
      iptables -t nat -A POSTROUTING -o "$PUB_IFACE" -j MASQUERADE
  fi
}

# Kernel must NOT reply to carrier packets on the public interface.
apply_carrier_firewall() {
  [[ -n "$PUB_IFACE" ]] || PUB_IFACE="$(detect_pub_iface || true)"
  if [[ "$CARRIER" == "udp" ]]; then
    iptables -C INPUT -i "$PUB_IFACE" -p udp --dport "$CARRIER_PORT" -j DROP 2>/dev/null || \
      iptables -A INPUT -i "$PUB_IFACE" -p udp --dport "$CARRIER_PORT" -j DROP
  else
    iptables -C INPUT -i "$PUB_IFACE" -p icmp --icmp-type echo-request -j DROP 2>/dev/null || \
      iptables -A INPUT -i "$PUB_IFACE" -p icmp --icmp-type echo-request -j DROP
  fi
}

# --------------------------------------------------------------------------
# 7. Live status
# --------------------------------------------------------------------------
do_status() {
  local s_tun s_wg s_wd ping_line wg_dump
  s_tun=$(systemctl is-active "$SVC_TUN" 2>/dev/null || echo inactive)
  s_wd=$(systemctl is-active "$SVC_WATCH" 2>/dev/null || echo inactive)
  s_wg=$(wg show "$WG_IFACE" 2>/dev/null | head -1 || echo "wg down")
  wg_dump=$(wg show "$WG_IFACE" transfer 2>/dev/null || echo "n/a")

  if ping -c 3 -W 2 -q "$WG_PEER_IP" >/dev/null 2>&1; then
    ping_line=$(ping -c 3 -W 2 "$WG_PEER_IP" 2>/dev/null | tail -2)
  else
    ping_line="internal ping to ${WG_PEER_IP}: FAILED (tunnel down?)"
  fi

  whiptail --title "Live Status" --scrolltext --msgbox \
"Role:          ${ROLE:-?}
Carrier:       ${CARRIER}  (port ${CARRIER_PORT})
Peer public:   ${PEER_PUBLIC_IP:-?}
Spoof source:  ${SPOOF_SRC:-?}
Tunnel IPs:    ${WG_LOCAL_IP} <-> ${WG_PEER_IP}

spooftun:      ${s_tun}
watchdog:      ${s_wd}
wireguard:     ${s_wg}

Transfer:
${wg_dump}

Internal ping (${WG_PEER_IP}):
${ping_line}" "$WT_H" "$WT_W"
}

# --------------------------------------------------------------------------
# 8. Monitoring + watchdog
# --------------------------------------------------------------------------
do_watchdog() {
  local act
  act=$(whiptail --title "Monitoring & Watchdog" --menu "Watchdog auto-restarts the tunnel on failure:" \
     "$WT_H" "$WT_W" 4 \
     "install" "Install & enable services (spooftun + watchdog)" \
     "start"   "Start services" \
     "stop"    "Stop services" \
     "logs"    "Show recent logs" \
     3>&1 1>&2 2>&3) || return
  case "$act" in
    install) install_services; msg "Services installed & enabled." ;;
    start)   start_stack; msg "Started spooftun + wireguard + watchdog." ;;
    stop)    stop_stack;  msg "Stopped." ;;
    logs)
      local l; l=$(journalctl -u "$SVC_TUN" -u "$SVC_WATCH" -n 40 --no-pager 2>/dev/null || echo "no logs")
      whiptail --title "Logs" --scrolltext --msgbox "$l" "$WT_H" "$WT_W" ;;
  esac
}

install_services() {
  save_config
  # spooftun.service
  cat > "/etc/systemd/system/${SVC_TUN}" <<EOF
[Unit]
Description=Spoof-Tunnel core (raw spoofed carrier for WireGuard)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${CONF_FILE}
ExecStart=${BIN} run --carrier \${CARRIER} --peer \${PEER_PUBLIC_IP} --spoof \${SPOOF_SRC} --iface \${PUB_IFACE} --lport \${LOCAL_PORT} --wgport \${WG_PORT} --cport \${CARRIER_PORT} --magic \${MAGIC}
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN

[Install]
WantedBy=multi-user.target
EOF

  # watchdog script
  cat > "$WATCHDOG_SCRIPT" <<'EOF'
#!/usr/bin/env bash
source /etc/spoof-tunnel/config 2>/dev/null || exit 1
FAILS=0
while true; do
  if ping -c 1 -W 2 "$WG_PEER_IP" >/dev/null 2>&1; then
    FAILS=0
  else
    FAILS=$((FAILS+1))
    logger -t spoof-watchdog "internal ping to ${WG_PEER_IP} failed (${FAILS})"
    if [[ $FAILS -ge 3 ]]; then
      logger -t spoof-watchdog "restarting tunnel stack"
      systemctl restart spooftun.service
      wg-quick down wgtun 2>/dev/null || true
      wg-quick up wgtun 2>/dev/null || true
      FAILS=0
    fi
  fi
  sleep 10
done
EOF
  chmod 755 "$WATCHDOG_SCRIPT"

  cat > "/etc/systemd/system/${SVC_WATCH}" <<EOF
[Unit]
Description=Spoof-Tunnel watchdog (auto-restart on link failure)
After=${SVC_TUN}

[Service]
Type=simple
ExecStart=${WATCHDOG_SCRIPT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SVC_TUN" "$SVC_WATCH" >/dev/null 2>&1 || true
}

start_stack() {
  apply_sysctl
  apply_carrier_firewall
  systemctl restart "$SVC_TUN"
  sleep 1
  wg-quick down "$WG_IFACE" 2>/dev/null || true
  wg-quick up "$WG_IFACE"
  apply_forwards
  systemctl restart "$SVC_WATCH"
}

stop_stack() {
  systemctl stop "$SVC_WATCH" 2>/dev/null || true
  wg-quick down "$WG_IFACE" 2>/dev/null || true
  systemctl stop "$SVC_TUN" 2>/dev/null || true
}

# --------------------------------------------------------------------------
# 9. Network optimization
# --------------------------------------------------------------------------
do_optimize() {
  apply_sysctl
  local cc qd rp
  cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo "?")
  qd=$(sysctl -n net.core.default_qdisc 2>/dev/null || echo "?")
  rp=$(sysctl -n net.ipv4.conf.all.rp_filter 2>/dev/null || echo "?")
  MTU=$(input "WireGuard MTU (1280 avoids fragmentation):" "$MTU") || true
  save_config
  [[ -f "$WG_CONF" ]] && write_wg_conf
  msg "Applied network optimizations:\n\ncongestion control: ${cc}\nqdisc: ${qd}\nrp_filter(all): ${rp}\nWireGuard MTU: ${MTU}\n\n(ip_forward=1, rp_filter=0 set)"
}

# --------------------------------------------------------------------------
# 10. Backup / restore
# --------------------------------------------------------------------------
do_backup() {
  local act
  act=$(whiptail --title "Backup / Restore" --menu "Config backup:" "$WT_H" "$WT_W" 3 \
     "backup"  "Create a backup archive" \
     "restore" "Restore from a backup archive" \
     3>&1 1>&2 2>&3) || return
  mkdir -p "$BACKUP_DIR"
  if [[ "$act" == "backup" ]]; then
    local ts f; ts=$(date +%Y%m%d-%H%M%S); f="${BACKUP_DIR}/spoof-tunnel-${ts}.tar.gz"
    tar czf "$f" -C / "etc/spoof-tunnel/config" "etc/wireguard/${WG_IFACE}.conf" 2>/dev/null || true
    msg "Backup created:\n${f}"
  else
    local f
    f=$(input "Path to backup .tar.gz:" "$BACKUP_DIR/") || return
    [[ -f "$f" ]] || { msg "File not found: $f"; return; }
    tar xzf "$f" -C / && load_config && msg "Restored from ${f}. Restart the stack (menu 8)."
  fi
}

# --------------------------------------------------------------------------
# 11. Uninstall / cleanup
# --------------------------------------------------------------------------
do_uninstall() {
  yesno "This removes services, WireGuard config, iptables rules and the binary.\nKeep a backup first (menu 10). Continue?" || return
  stop_stack
  systemctl disable "$SVC_TUN" "$SVC_WATCH" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${SVC_TUN}" "/etc/systemd/system/${SVC_WATCH}"
  systemctl daemon-reload
  # firewall cleanup (best effort)
  [[ -n "$PUB_IFACE" ]] || PUB_IFACE="$(detect_pub_iface || true)"
  iptables -D INPUT -i "$PUB_IFACE" -p udp --dport "$CARRIER_PORT" -j DROP 2>/dev/null || true
  iptables -D INPUT -i "$PUB_IFACE" -p icmp --icmp-type echo-request -j DROP 2>/dev/null || true
  iptables -t nat -F 2>/dev/null || true
  rm -f "$WG_CONF" "$WATCHDOG_SCRIPT" "$BIN" "/etc/sysctl.d/99-spoof-tunnel.conf"
  if yesno "Also delete config directory ${CONF_DIR} (including backups)?"; then
    rm -rf "$CONF_DIR"
  fi
  msg "Uninstalled. (Kernel sysctl changes revert on reboot.)"
}

# --------------------------------------------------------------------------
# Main menu
# --------------------------------------------------------------------------
main_menu() {
  while true; do
    local status="[${ROLE:-no role}] carrier=${CARRIER} peer=${PEER_PUBLIC_IP:-?} spoof=${SPOOF_SRC:-?}"
    local choice
    choice=$(whiptail --title "Spoof-Tunnel Manager" \
      --menu "$status\n\nSelect an action:" "$WT_H" "$WT_W" "$WT_MH" \
      "1"  "Install & auto-setup (deps, binary, sysctl)" \
      "2"  "Select server role (relay / exit)" \
      "3"  "Spoof-Tester (find whitelisted range)" \
      "4"  "Set carrier protocol (UDP / ICMP)" \
      "5"  "Set fixed IPs + WireGuard keys" \
      "6"  "Port forwarding (Xray inputs)" \
      "7"  "Live status (up/down, ping, bandwidth)" \
      "8"  "Monitoring + watchdog (services)" \
      "9"  "Network optimization (BBR, MTU, rp_filter)" \
      "10" "Backup / restore config" \
      "11" "Uninstall & cleanup" \
      "0"  "Exit" \
      3>&1 1>&2 2>&3) || exit 0

    case "$choice" in
      1)  do_install ;;
      2)  do_role ;;
      3)  do_spoof_test ;;
      4)  do_carrier ;;
      5)  do_wg_setup ;;
      6)  do_forward ;;
      7)  do_status ;;
      8)  do_watchdog ;;
      9)  do_optimize ;;
      10) do_backup ;;
      11) do_uninstall ;;
      0)  clear; exit 0 ;;
    esac
  done
}

# --------------------------------------------------------------------------
need_root
command -v whiptail >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq whiptail; }
load_config
main_menu
