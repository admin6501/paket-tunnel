#!/usr/bin/env bash
# =============================================================================
#  PerseTunnel — نصب‌کنندهٔ آفلاین (بدون هیچ دانلودی: نه Go، نه ماژول)
# -----------------------------------------------------------------------------
#  این اسکریپت باینریِ از قبل ساخته‌شده را نصب می‌کند و فقط سرویس systemd +
#  تیونینگ کرنل را راه‌اندازی می‌کند. مناسب سرورهایی که اینترنت محدود دارند.
#
#  باینری از کجا پیدا می‌شود (به ترتیب اولویت):
#    1) آرگومان:    sudo bash install-offline.sh --bin /path/to/persetunnel
#    2) payload داخلیِ خوداستخراج (نسخهٔ .run)
#    3) فایل کنار اسکریپت:  persetunnel-linux-<arch>
#    4) /usr/local/bin/persetunnel موجود
#
#  اجرا:  sudo bash install-offline.sh
# =============================================================================

set -euo pipefail

BIN="/usr/local/bin/persetunnel"
CONF_DIR="/etc/persetunnel"
RUN_SCRIPT="${CONF_DIR}/run.sh"
INFO_FILE="${CONF_DIR}/info.conf"
SERVICE_NAME="persetunnel"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SYSCTL_FILE="/etc/sysctl.d/99-persetunnel.conf"
LIMITS_FILE="/etc/security/limits.d/99-persetunnel.conf"
PAYLOAD_MARKER="__PT_PAYLOAD__"

RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLU=$'\e[36m'; BLD=$'\e[1m'; RST=$'\e[0m'
msg(){ echo -e "${BLU}[*]${RST} $*"; }
ok(){ echo -e "${GRN}[✓]${RST} $*"; }
warn(){ echo -e "${YLW}[!]${RST} $*"; }
err(){ echo -e "${RED}[x]${RST} $*" >&2; }
line(){ echo -e "${BLD}--------------------------------------------------------------${RST}"; }

SELF="$(readlink -f "${BASH_SOURCE[0]:-$0}")"
ARG_BIN=""
[[ "${1:-}" == "--bin" ]] && { ARG_BIN="${2:-}"; shift 2 || true; }

need_root(){ [[ "${EUID}" -eq 0 ]] || { err "با sudo اجرا کن: sudo bash install-offline.sh"; exit 1; }; }

detect_arch(){
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) err "معماری پشتیبانی‌نشده: $(uname -m)"; exit 1 ;;
  esac
}

rand_str(){
  local n="${1:-16}" out=""
  while [[ "${#out}" -lt "$n" ]]; do
    out+="$(LC_ALL=C tr -dc 'a-zA-Z0-9' < <(head -c 64 /dev/urandom))"
  done
  printf '%s' "${out:0:n}"
}

# --------------------- یافتن و نصب باینری (بدون شبکه) ------------------------
install_bin(){
  local arch src=""; arch="$(detect_arch)"
  local selfdir; selfdir="$(dirname "$SELF")"

  if [[ -n "$ARG_BIN" && -f "$ARG_BIN" ]]; then
    src="$ARG_BIN"; msg "استفاده از باینری داده‌شده: $src"
  elif grep -aqx "$PAYLOAD_MARKER" "$SELF" 2>/dev/null; then
    msg "استخراج باینریِ داخلی (self-extract)..."
    local start; start="$(grep -an "^${PAYLOAD_MARKER}\$" "$SELF" | head -1 | cut -d: -f1)"
    tail -n +"$((start + 1))" "$SELF" | base64 -d > "$BIN"
    chmod +x "$BIN"
    ok "باینری نصب شد: $($BIN version 2>/dev/null || echo persetunnel)"
    return
  elif [[ -f "${selfdir}/persetunnel-linux-${arch}" ]]; then
    src="${selfdir}/persetunnel-linux-${arch}"; msg "یافت شد کنار اسکریپت: $src"
  elif [[ -f "${selfdir}/persetunnel" ]]; then
    src="${selfdir}/persetunnel"; msg "یافت شد: $src"
  elif [[ -x "$BIN" ]]; then
    ok "باینری از قبل نصب است: $($BIN version 2>/dev/null || echo ok)"; return
  else
    err "باینری پیدا نشد. یکی از این‌ها را انجام بده:"
    echo "  • فایل persetunnel-linux-${arch} را کنار همین اسکریپت بگذار، یا"
    echo "  • با آرگومان مسیر بده:  sudo bash install-offline.sh --bin /path/to/persetunnel"
    exit 1
  fi

  install -m 0755 "$src" "$BIN"
  ok "باینری نصب شد: $($BIN version 2>/dev/null || echo persetunnel)"
}

# ------------------------------ تیونینگ -------------------------------------
tune_system(){
  msg "اعمال تیونینگ کرنل (BBR + بافرهای بزرگ UDP برای QUIC) ..."
  cat > "$SYSCTL_FILE" <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216
net.core.netdev_max_backlog = 250000
net.core.somaxconn = 65535
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_slow_start_after_idle = 0
fs.file-max = 1048576
EOF
  modprobe tcp_bbr 2>/dev/null || true
  sysctl --system >/dev/null 2>&1 || true
  cat > "$LIMITS_FILE" <<'EOF'
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF
  local cc; cc="$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo ?)"
  [[ "$cc" == "bbr" ]] && ok "BBR فعال شد" || warn "BBR فعال نشد (مقدار: $cc) — تانل بدون آن هم کار می‌کند."
}

make_token(){ printf 'v2|%s|%s|%s' "$1" "$2" "$3" | base64 -w0; }
write_run(){ mkdir -p "$CONF_DIR"; printf '#!/usr/bin/env bash\nexec %s %s\n' "$BIN" "$1" > "$RUN_SCRIPT"; chmod +x "$RUN_SCRIPT"; }

create_service(){
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=PerseTunnel (Iran <-> Foreign, QUIC pool)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${RUN_SCRIPT}
Restart=always
RestartSec=3
LimitNOFILE=1048576
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "سرویس $SERVICE_NAME فعال شد و در بوت بعدی هم بالا می‌آید."
  else
    err "سرویس اجرا نشد. لاگ: journalctl -u $SERVICE_NAME -n 50 --no-pager"
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true
  fi
}

install_foreign(){
  line; echo -e "${BLD}نصب آفلاین روی «سرور خارج» (Exit)${RST}"; line
  read -rp "پورت تانل (UDP) [443]: " PORT; PORT="${PORT:-443}"
  read -rp "هاست سرویس داخلی [127.0.0.1]: " SVCHOST; SVCHOST="${SVCHOST:-127.0.0.1}"
  read -rp "پورت سرویس اصلی (پنل/SSH): " SVCPORT
  while ! [[ "$SVCPORT" =~ ^[0-9]+$ ]]; do read -rp "پورت معتبر: " SVCPORT; done
  read -rp "SNI استتار [www.bing.com]: " SNI; SNI="${SNI:-www.bing.com}"
  local KEY; KEY="$(rand_str 24)"

  install_bin; tune_system
  write_run "server -listen :${PORT} -forward ${SVCHOST}:${SVCPORT} -key ${KEY}"
  mkdir -p "$CONF_DIR"
  printf 'ROLE=foreign\nPORT=%s\nKEY=%s\nSNI=%s\nSVCHOST=%s\nSVCPORT=%s\n' "$PORT" "$KEY" "$SNI" "$SVCHOST" "$SVCPORT" > "$INFO_FILE"
  create_service
  echo; line; ok "نصب سرور خارج کامل شد."
  echo -e "${BLD}توکن اتصال:${RST}"; echo -e "${GRN}$(make_token "$PORT" "$KEY" "$SNI")${RST}"; line
  echo -e "${YLW}مهم:${RST} پورت ${PORT} را روی ${BLD}UDP${RST} باز کن:  ufw allow ${PORT}/udp"
}

install_iran(){
  line; echo -e "${BLD}نصب آفلاین روی «سرور ایران» (Entry)${RST}"; line
  read -rp "آی‌پی/دامنهٔ سرور خارج: " FOREIGN
  while [[ -z "${FOREIGN:-}" ]]; do read -rp "آدرس سرور خارج: " FOREIGN; done
  read -rp "توکن اتصال: " TOKEN
  while [[ -z "${TOKEN:-}" ]]; do read -rp "توکن: " TOKEN; done
  local DEC; DEC="$(echo "$TOKEN" | base64 -d 2>/dev/null || true)"
  IFS='|' read -r VER PORT KEY SNI <<< "$DEC"
  [[ "${VER:-}" == "v2" && -n "${PORT:-}" ]] || { err "توکن نامعتبر است."; exit 1; }
  read -rp "پورت محلی کاربران: " LPORT
  while ! [[ "$LPORT" =~ ^[0-9]+$ ]]; do read -rp "پورت معتبر: " LPORT; done
  read -rp "تعداد کانکشن موازی استخر [6]: " CONNS; CONNS="${CONNS:-6}"

  install_bin; tune_system
  write_run "client -listen :${LPORT} -server ${FOREIGN}:${PORT} -key ${KEY} -conns ${CONNS} -sni ${SNI}"
  mkdir -p "$CONF_DIR"
  printf 'ROLE=iran\nFOREIGN=%s\nPORT=%s\nLPORT=%s\nCONNS=%s\nSNI=%s\n' "$FOREIGN" "$PORT" "$LPORT" "$CONNS" "$SNI" > "$INFO_FILE"
  create_service
  echo; line; ok "نصب سرور ایران کامل شد."
  echo "کاربران به  ${BLD}IP_ایران:${LPORT}${RST}  وصل می‌شوند.  ufw allow ${LPORT}/tcp"; line
}

show_status(){
  line; [[ -f "$INFO_FILE" ]] && { cat "$INFO_FILE"; line; }
  systemctl status "$SERVICE_NAME" --no-pager 2>/dev/null || warn "سرویس نصب نشده."
  line; journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true
}
restart_service(){ systemctl restart "$SERVICE_NAME" && ok "ری‌استارت شد."; }
show_token(){
  [[ -f "$INFO_FILE" ]] || { err "اطلاعاتی نیست."; return; }
  # shellcheck disable=SC1090
  source "$INFO_FILE"
  [[ "${ROLE:-}" == "foreign" ]] || { err "توکن فقط روی سرور خارج است."; return; }
  echo -e "${GRN}$(make_token "$PORT" "$KEY" "$SNI")${RST}"
}
uninstall_all(){
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$SERVICE_FILE"; systemctl daemon-reload 2>/dev/null || true
  rm -rf "$CONF_DIR" "$SYSCTL_FILE" "$LIMITS_FILE"
  read -rp "باینری هم حذف شود؟ [y/N]: " d; [[ "${d,,}" == "y" ]] && rm -f "$BIN"
  ok "حذف شد."
}

banner(){
  clear || true
  echo -e "${BLD}${BLU}"
  echo "  ╔══════════════════════════════════════════════════╗"
  echo "  ║   PerseTunnel — نصب آفلاین (بدون دانلود)            ║"
  echo "  ╚══════════════════════════════════════════════════╝"
  echo -e "${RST}"
}

menu(){
  banner
  echo "  1) نصب روی سرور خارج  (Exit)"
  echo "  2) نصب روی سرور ایران (Entry)"
  echo "  3) وضعیت و لاگ"
  echo "  4) ری‌استارت"
  echo "  5) نمایش توکن (سرور خارج)"
  echo "  6) حذف کامل"
  echo "  0) خروج"; echo
  read -rp "انتخاب: " ch
  case "$ch" in
    1) install_foreign ;; 2) install_iran ;;
    3) show_status ;; 4) restart_service ;;
    5) show_token ;; 6) uninstall_all ;;
    0) exit 0 ;; *) warn "نامعتبر." ;;
  esac
}

main(){
  need_root
  if [[ $# -gt 0 ]]; then
    case "$1" in
      foreign|server) install_foreign ;;
      iran|client) install_iran ;;
      status) show_status ;;
      restart) restart_service ;;
      token) show_token ;;
      uninstall|remove) uninstall_all ;;
      *) echo "usage: bash install-offline.sh [foreign|iran|status|restart|token|uninstall] [--bin PATH]" ;;
    esac
  else
    menu
  fi
}
main "$@"
