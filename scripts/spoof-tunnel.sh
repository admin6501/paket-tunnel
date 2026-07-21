#!/usr/bin/env bash
#
# spoof-tunnel.sh - Interactive management CLI for the Spoof-Tunnel
# (Iran relay  <->  foreign exit) built on source-spoofed ICMP/UDP + WireGuard.
#
# Requires: root, wireguard-tools, iproute2, iptables. (plain-text menu, no whiptail)
# Target OS: Ubuntu 22.04.
#
# NOTE: This is an interactive text menu. We deliberately do NOT use
# 'set -e'/'set -u' here: many commands legitimately return non-zero
# (menu cancel, existence checks, '[[ ]] && cmd' guards), and errexit
# would make the whole menu exit silently. We keep pipefail only.
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

# ---- text UI palette (no whiptail dependency) ----
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_B=$'\033[1m'; C_DIM=$'\033[2m'
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YEL=$'\033[33m'
  C_RED=$'\033[31m'; C_BLUE=$'\033[34m'; C_MAG=$'\033[35m'
else
  C_RESET=""; C_B=""; C_DIM=""; C_CYAN=""; C_GREEN=""; C_YEL=""; C_RED=""; C_BLUE=""; C_MAG=""
fi

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

hr() { printf "${C_DIM}──────────────────────────────────────────────────────────${C_RESET}\n"; }

banner() {
  clear 2>/dev/null || true
  printf "${C_CYAN}${C_B}"
  printf "  ┌──────────────────────────────────────────────────────┐\n"
  printf "  │           SPOOF-TUNNEL  ·  مدیریت تانل                │\n"
  printf "  └──────────────────────────────────────────────────────┘${C_RESET}\n"
}

pause() { printf "\n${C_DIM}Enter برای بازگشت به منو...${C_RESET}"; read -r _ || true; }

msg()  { printf "\n%b\n" "$1"; pause; }

yesno() {
  local ans
  printf "\n%b ${C_YEL}[y/N]${C_RESET}: " "$1"
  read -r ans || true
  [[ "$ans" =~ ^[Yy]([Ee][Ss])?$ ]]
}

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

input() { # "prompt (may contain \n)" "default" -> echoes value on stdout
  local prompt="$1" def="${2:-}" v
  printf "%b" "\n${prompt}" >&2
  [[ -n "$def" ]] && printf " ${C_YEL}[%s]${C_RESET}" "$def" >&2
  printf ": " >&2
  read -r v || true
  echo "${v:-$def}"
}

# choose "title" key1 desc1 key2 desc2 ... -> echoes selected key (rc 1 on cancel)
choose() {
  local title="$1"; shift
  local -a keys=() descs=()
  while [[ $# -ge 2 ]]; do keys+=("$1"); descs+=("$2"); shift 2; done
  printf "\n${C_B}%s${C_RESET}\n" "$title" >&2
  local i
  for i in "${!keys[@]}"; do
    printf "  ${C_CYAN}%2d${C_RESET}) %s\n" "$((i+1))" "${descs[$i]}" >&2
  done
  local ans
  printf "\n${C_GREEN}شماره را وارد کن${C_RESET} (Enter=لغو): " >&2
  read -r ans || true
  [[ -z "$ans" ]] && return 1
  if [[ "$ans" =~ ^[0-9]+$ ]] && (( ans >= 1 && ans <= ${#keys[@]} )); then
    echo "${keys[$((ans-1))]}"; return 0
  fi
  return 1
}

# --------------------------------------------------------------------------
# 1. Install & setup
# --------------------------------------------------------------------------
do_install() {
  banner
  printf "${C_B}۱) نصب و راه‌اندازی خودکار${C_RESET}\n"; hr
  echo "» به‌روزرسانی apt..."
  apt-get update -qq >/dev/null 2>&1 || true
  echo "» نصب وابستگی‌ها (wireguard, iproute2, iptables, ...)..."
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 \
      apt-get install -y -qq --no-install-recommends \
      wireguard wireguard-tools iproute2 iptables build-essential \
      >/dev/null 2>&1 || true
  echo "» نصب باینری spooftun..."
  install_binary
  echo "» اعمال sysctl (ip_forward, rp_filter=0, BBR)..."
  apply_sysctl
  save_config
  msg "${C_GREEN}نصب کامل شد.${C_RESET}\nBinary: ${BIN}\nConfig: ${CONF_FILE}\n\nمرحله بعد: انتخاب نقش سرور (گزینه 2)."
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
  banner
  local r
  r=$(choose "نقش این سرور را انتخاب کن:" \
        "relay" "ایران (رله) — کاربران اینجا وصل می‌شوند" \
        "exit"  "خارج (اکسیت) — به اینترنت آزاد می‌رسد") || return
  ROLE="$r"
  if [[ "$ROLE" == "relay" ]]; then
    WG_LOCAL_IP="10.20.20.1"; WG_PEER_IP="10.20.20.2"
  else
    WG_LOCAL_IP="10.20.20.2"; WG_PEER_IP="10.20.20.1"
  fi
  PEER_PUBLIC_IP=$(input "آی‌پی عمومی سرور مقابل را وارد کن\n(رله→آی‌پی خارج، اکسیت→آی‌پی ایران):" "$PEER_PUBLIC_IP")
  save_config
  msg "نقش: ${ROLE}\nآی‌پی تانل (این سرور): ${WG_LOCAL_IP}\nآی‌پی تانل (مقابل): ${WG_PEER_IP}\nآی‌پی عمومی مقابل: ${PEER_PUBLIC_IP}"
}

# --------------------------------------------------------------------------
# 3. Spoof-Tester
# --------------------------------------------------------------------------
do_spoof_test() {
  banner
  local mode
  mode=$(choose "Spoof-Tester — پیدا کردن رنج سفیدشده (اول روی EXIT گزینه listen، بعد روی RELAY گزینه send):" \
     "listen" "این سرور EXIT است: دریافت و لاگ probeها" \
     "send"   "این سرور RELAY است: ارسال probeهای اسپوف‌شده") || return

  if [[ "$mode" == "listen" ]]; then
    local secs; secs=$(input "مدت شنود (ثانیه):" "30")
    echo; echo -e "${C_YEL}در حال شنود به مدت ${secs}s ... حالا روی سرور رله گزینه send را بزن.${C_RESET}"; hr
    "$BIN" probe-listen --carrier "$CARRIER" --iface "$PUB_IFACE" \
           --cport "$CARRIER_PORT" --seconds "$secs" 2>/dev/null || true
    echo; echo -e "${C_DIM}(اگر هیچ خطی بالا نیامد، آن رنج/حامل احتمالاً از گیت‌وی رد نمی‌شود.)${C_RESET}"
    pause
  else
    local base secs list cand o
    base=$(input "پایه‌ی رنج کاندید (مثلاً 2.144.0. — اکتت آخر اضافه می‌شود):" "")
    secs=$(input "تعداد probe برای هر کاندید:" "20")
    list=$(input "اکتت‌های آخر برای تست (با فاصله):" "1 10 50 100 200")
    echo; hr
    for o in $list; do
      cand="${base}${o}"
      echo "» ارسال probe با source=${cand} ..."
      "$BIN" probe-send --carrier "$CARRIER" --peer "$PEER_PUBLIC_IP" \
             --spoof "$cand" --cport "$CARRIER_PORT" --count "$secs" 2>/dev/null || true
    done
    msg "probeها ارسال شد. حالا روی سرور EXIT نتیجه‌ی listen را ببین؛ هر آی‌پی که رسیده از گیت‌وی رد شده — آن را در گزینه 5 به‌عنوان Spoof source ست کن."
  fi
}

# --------------------------------------------------------------------------
# 4. Carrier protocol
# --------------------------------------------------------------------------
do_carrier() {
  banner
  local c
  c=$(choose "کدام پروتکل از گیت‌وی رد می‌شود؟" \
      "udp"  "حامل UDP (پیش‌فرض پیشنهادی)" \
      "icmp" "حامل ICMP echo") || return
  CARRIER="$c"
  if [[ "$CARRIER" == "udp" ]]; then
    CARRIER_PORT=$(input "پورت حامل UDP:" "$CARRIER_PORT")
  fi
  save_config
  msg "حامل تنظیم شد: ${CARRIER}"
}

# --------------------------------------------------------------------------
# 5. Fixed IPs + WireGuard keys
# --------------------------------------------------------------------------
do_wg_setup() {
  banner
  WG_LOCAL_IP=$(input "This server tunnel IP:" "$WG_LOCAL_IP")
  WG_PEER_IP=$(input "Peer tunnel IP:" "$WG_PEER_IP")
  SPOOF_SRC=$(input "Spoofed (whitelisted) SOURCE IP to impersonate:" "$SPOOF_SRC")

  if [[ -z "$WG_PRIV" ]] || yesno "WireGuard keys exist. Regenerate them?\n(You must update the peer's config with the new public key.)"; then
    WG_PRIV="$(wg genkey)"
    WG_PUB="$(echo "$WG_PRIV" | wg pubkey)"
  fi

  msg "This server WireGuard PUBLIC key:\n\n${C_GREEN}${WG_PUB}${C_RESET}\n\nCopy it to the OTHER server (you'll paste it there as 'peer public key')."
  PEER_WG_PUB=$(input "Paste the PEER's WireGuard PUBLIC key:" "$PEER_WG_PUB")

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
  banner
  local act
  act=$(choose "مدیریت فوروارد ورودی‌های Xray:" \
     "add"    "افزودن فوروارد (proto:port)" \
     "list"   "نمایش فورواردهای فعلی" \
     "del"    "حذف یک فوروارد" \
     "apply"  "اعمال مجدد قوانین iptables") || return
  case "$act" in
    add)
      local p; p=$(input "فوروارد به شکل proto:port (مثلاً tcp:443):" "tcp:443")
      FWD_PORTS="${FWD_PORTS} ${p}"; FWD_PORTS="$(echo "$FWD_PORTS" | xargs)"
      save_config; apply_forwards; msg "افزوده شد: ${p}." ;;
    list)
      msg "فورواردهای فعلی:\n${FWD_PORTS:-<هیچ>}" ;;
    del)
      local p; p=$(input "کدام فوروارد حذف شود (proto:port)?:" "")
      FWD_PORTS="$(echo "$FWD_PORTS" | tr ' ' '\n' | grep -vx "$p" | xargs || true)"
      save_config; msg "حذف شد: ${p}. برای اعمال، گزینه apply را بزن." ;;
    apply) apply_forwards; msg "قوانین اعمال شد." ;;
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
  banner
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

  local col_ok="${C_GREEN}"; local col_bad="${C_RED}"
  local c_tun c_wd
  [[ "$s_tun" == "active" ]] && c_tun="$col_ok" || c_tun="$col_bad"
  [[ "$s_wd"  == "active" ]] && c_wd="$col_ok"  || c_wd="$col_bad"

  printf "${C_B}۷) وضعیت لحظه‌ای${C_RESET}\n"; hr
  printf "  Role:          %s\n" "${ROLE:-?}"
  printf "  Carrier:       %s  (port %s)\n" "$CARRIER" "$CARRIER_PORT"
  printf "  Peer public:   %s\n" "${PEER_PUBLIC_IP:-?}"
  printf "  Spoof source:  %s\n" "${SPOOF_SRC:-?}"
  printf "  Tunnel IPs:    %s <-> %s\n" "$WG_LOCAL_IP" "$WG_PEER_IP"
  hr
  printf "  spooftun:      ${c_tun}%s${C_RESET}\n" "$s_tun"
  printf "  watchdog:      ${c_wd}%s${C_RESET}\n" "$s_wd"
  printf "  wireguard:     %s\n" "$s_wg"
  hr
  printf "  Transfer:\n%s\n" "$wg_dump"
  hr
  printf "  Internal ping (%s):\n%s\n" "$WG_PEER_IP" "$ping_line"
  pause
}

# --------------------------------------------------------------------------
# 8. Monitoring + watchdog
# --------------------------------------------------------------------------
do_watchdog() {
  banner
  local act
  act=$(choose "واچ‌داگ در قطعی خودکار تانل را ری‌استارت می‌کند:" \
     "install" "نصب و فعال‌سازی سرویس‌ها (spooftun + watchdog)" \
     "start"   "استارت سرویس‌ها" \
     "stop"    "توقف سرویس‌ها" \
     "logs"    "نمایش لاگ‌های اخیر") || return
  case "$act" in
    install) install_services; msg "سرویس‌ها نصب و فعال شدند." ;;
    start)   start_stack; msg "استارت شد: spooftun + wireguard + watchdog." ;;
    stop)    stop_stack;  msg "متوقف شد." ;;
    logs)
      banner; printf "${C_B}لاگ‌های اخیر:${C_RESET}\n"; hr
      journalctl -u "$SVC_TUN" -u "$SVC_WATCH" -n 40 --no-pager 2>/dev/null || echo "no logs"
      pause ;;
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
  banner
  apply_sysctl
  local cc qd rp
  cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo "?")
  qd=$(sysctl -n net.core.default_qdisc 2>/dev/null || echo "?")
  rp=$(sysctl -n net.ipv4.conf.all.rp_filter 2>/dev/null || echo "?")
  MTU=$(input "WireGuard MTU (1280 avoids fragmentation):" "$MTU")
  save_config
  [[ -f "$WG_CONF" ]] && write_wg_conf
  msg "بهینه‌سازی شبکه اعمال شد:\n\ncongestion control: ${cc}\nqdisc: ${qd}\nrp_filter(all): ${rp}\nWireGuard MTU: ${MTU}\n\n(ip_forward=1, rp_filter=0 ست شد)"
}

# --------------------------------------------------------------------------
# 10. Backup / restore
# --------------------------------------------------------------------------
do_backup() {
  banner
  local act
  act=$(choose "بکاپ/ری‌استور کانفیگ:" \
     "backup"  "ساخت فایل بکاپ" \
     "restore" "بازگردانی از فایل بکاپ") || return
  mkdir -p "$BACKUP_DIR"
  if [[ "$act" == "backup" ]]; then
    local ts f; ts=$(date +%Y%m%d-%H%M%S); f="${BACKUP_DIR}/spoof-tunnel-${ts}.tar.gz"
    tar czf "$f" -C / "etc/spoof-tunnel/config" "etc/wireguard/${WG_IFACE}.conf" 2>/dev/null || true
    msg "بکاپ ساخته شد:\n${f}"
  else
    local f
    f=$(input "مسیر فایل بکاپ .tar.gz:" "$BACKUP_DIR/")
    [[ -f "$f" ]] || { msg "فایل پیدا نشد: $f"; return; }
    tar xzf "$f" -C / && load_config && msg "بازگردانی شد از ${f}. حالا استک را ری‌استارت کن (گزینه 8)."
  fi
}

# --------------------------------------------------------------------------
# 11. Uninstall / cleanup
# --------------------------------------------------------------------------
do_uninstall() {
  banner
  yesno "این کار سرویس‌ها، کانفیگ WireGuard، قوانین iptables و باینری را حذف می‌کند.\nاول بکاپ بگیر (گزینه 10). ادامه؟" || return
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
  msg "حذف شد. (تغییرات sysctl کرنل با ریبوت برمی‌گردند.)"
}

# --------------------------------------------------------------------------
# Main menu (plain-text, colored — no whiptail)
# --------------------------------------------------------------------------
main_menu() {
  while true; do
    banner
    printf "  ${C_DIM}%s${C_RESET}\n" "[${ROLE:-no role}] carrier=${CARRIER} peer=${PEER_PUBLIC_IP:-?} spoof=${SPOOF_SRC:-?}"
    hr
    printf "  ${C_CYAN}1${C_RESET})  نصب و راه‌اندازی خودکار (deps، binary، sysctl)\n"
    printf "  ${C_CYAN}2${C_RESET})  انتخاب نقش سرور (رله / اکسیت)\n"
    printf "  ${C_CYAN}3${C_RESET})  Spoof-Tester (یافتن رنج سفیدشده)\n"
    printf "  ${C_CYAN}4${C_RESET})  تنظیم پروتکل حامل (UDP / ICMP)\n"
    printf "  ${C_CYAN}5${C_RESET})  تنظیم آی‌پی‌های فیکس + کلید WireGuard\n"
    printf "  ${C_CYAN}6${C_RESET})  مدیریت فوروارد پورت (ورودی Xray)\n"
    printf "  ${C_CYAN}7${C_RESET})  وضعیت لحظه‌ای (up/down، پینگ، پهنای‌باند)\n"
    printf "  ${C_CYAN}8${C_RESET})  مانیتورینگ + واچ‌داگ (سرویس‌ها)\n"
    printf "  ${C_CYAN}9${C_RESET})  بهینه‌سازی شبکه (BBR، MTU، rp_filter)\n"
    printf "  ${C_CYAN}10${C_RESET}) بکاپ / ری‌استور کانفیگ\n"
    printf "  ${C_CYAN}11${C_RESET}) حذف کامل و پاک‌سازی\n"
    printf "  ${C_CYAN}0${C_RESET})  خروج\n"
    hr
    local choice
    printf "${C_GREEN}شماره گزینه: ${C_RESET}"
    read -r choice || { echo; exit 0; }

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
      0)  clear 2>/dev/null || true; exit 0 ;;
      "") : ;;
      *)  printf "${C_RED}گزینه نامعتبر: %s${C_RESET}\n" "$choice"; sleep 1 ;;
    esac
  done
}

# --------------------------------------------------------------------------
need_root
load_config
main_menu
