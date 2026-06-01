#!/usr/bin/env bash
# =============================================================================
#  GOST Tunnel Manager  —  تانل پایدار و کم‌مصرف بین سرور ایران و سرور خارج
# -----------------------------------------------------------------------------
#  ویژگی‌ها:
#   - تانل معکوس مبتنی بر WebSocket + TLS + Multiplexing (mwss) با موتور GOST v3
#   - عبور از فیلترینگ (ترافیک شبیه HTTPS/WebSocket)
#   - مصرف CPU پایین به‌کمک Mux (کاهش تعداد کانکشن و هندشیک)
#   - تیونینگ کرنل (BBR + بافرها) برای حفظ پینگ و سرعت در ساعات اوج
#   - نصب کاملاً اتوماتیک + سرویس systemd با ری‌استارت خودکار (ضد قطعی)
#
#  پشتیبانی: Ubuntu / Debian   |   معماری: amd64 / arm64 / armv7
#  نحوه اجرا:  sudo bash tunnel.sh
# =============================================================================

set -euo pipefail

# ----------------------------- ثابت‌ها و مسیرها ------------------------------
GOST_BIN="/usr/local/bin/gost"
CONF_DIR="/etc/gost-tunnel"
RUN_SCRIPT="${CONF_DIR}/run.sh"
INFO_FILE="${CONF_DIR}/info.conf"
SERVICE_NAME="gost-tunnel"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SYSCTL_FILE="/etc/sysctl.d/99-gost-tunnel.conf"
LIMITS_FILE="/etc/security/limits.d/99-gost-tunnel.conf"
GOST_REPO="go-gost/gost"

# ------------------------------- رنگ‌ها --------------------------------------
RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLU=$'\e[36m'; BLD=$'\e[1m'; RST=$'\e[0m'

msg()  { echo -e "${BLU}[*]${RST} $*"; }
ok()   { echo -e "${GRN}[✓]${RST} $*"; }
warn() { echo -e "${YLW}[!]${RST} $*"; }
err()  { echo -e "${RED}[x]${RST} $*" >&2; }
line() { echo -e "${BLD}--------------------------------------------------------------${RST}"; }

# ------------------------------ پیش‌نیازها -----------------------------------
need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    err "این اسکریپت باید با دسترسی root اجرا شود.  از:  sudo bash tunnel.sh"
    exit 1
  fi
}

detect_arch() {
  local m; m="$(uname -m)"
  case "$m" in
    x86_64|amd64)   echo "amd64" ;;
    aarch64|arm64)  echo "arm64" ;;
    armv7l|armv7)   echo "armv7" ;;
    armv6l)         echo "armv6" ;;
    *) err "معماری پشتیبانی‌نشده: $m"; exit 1 ;;
  esac
}

ensure_tools() {
  local pkgs=()
  command -v curl  >/dev/null 2>&1 || pkgs+=(curl)
  command -v tar   >/dev/null 2>&1 || pkgs+=(tar)
  command -v jq    >/dev/null 2>&1 || pkgs+=(jq)
  if [[ ${#pkgs[@]} -gt 0 ]]; then
    msg "نصب پیش‌نیازها: ${pkgs[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y "${pkgs[@]}" >/dev/null 2>&1 || {
      warn "نصب خودکار jq ناموفق بود؛ بدون jq ادامه می‌دهیم."
    }
  fi
}

# ------------------------------ نصب GOST -------------------------------------
install_gost() {
  if [[ -x "$GOST_BIN" ]]; then
    local cur; cur="$("$GOST_BIN" -V 2>/dev/null | head -n1 || true)"
    ok "GOST از قبل نصب است: ${cur:-نسخه نامشخص}"
    return 0
  fi
  local arch; arch="$(detect_arch)"
  msg "دریافت آخرین نسخهٔ GOST برای linux/${arch} ..."

  local api url tag
  api="$(curl -fsSL "https://api.github.com/repos/${GOST_REPO}/releases/latest")" || {
    err "اتصال به GitHub ناموفق بود. اینترنت/فیلترینگ سرور را بررسی کنید."
    exit 1
  }
  if command -v jq >/dev/null 2>&1; then
    tag="$(echo "$api" | jq -r '.tag_name')"
    url="$(echo "$api" | jq -r ".assets[].browser_download_url" | grep -m1 -E "linux_${arch}\.tar\.gz$")"
  else
    tag="$(echo "$api" | grep -m1 -oE '"tag_name": *"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/')"
    url="$(echo "$api" | grep -m1 -oE 'https://[^"]+linux_'"${arch}"'\.tar\.gz')"
  fi

  [[ -z "${url:-}" || "$url" == "null" ]] && { err "لینک دانلود مناسب پیدا نشد (arch=$arch)."; exit 1; }

  local tmp; tmp="$(mktemp -d)"
  msg "دانلود ${tag} ..."
  curl -fSL "$url" -o "${tmp}/gost.tar.gz"
  tar -xzf "${tmp}/gost.tar.gz" -C "$tmp"
  install -m 0755 "${tmp}/gost" "$GOST_BIN"
  rm -rf "$tmp"
  ok "GOST نصب شد: $("$GOST_BIN" -V 2>/dev/null | head -n1)"
}

# --------------------------- تیونینگ سیستم -----------------------------------
tune_system() {
  msg "اعمال تیونینگ کرنل (BBR + بافرها) برای حفظ پینگ/سرعت در ساعات اوج ..."
  cat > "$SYSCTL_FILE" <<'EOF'
# GOST Tunnel performance tuning
# --- صف و کنترل ازدحام (پینگ پایین + سرعت بالا در شلوغی) ---
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
# --- بافرهای بزرگ‌تر برای پهنای باند بالا ---
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864
net.core.netdev_max_backlog = 250000
net.core.somaxconn = 65535
# --- کاهش تأخیر و بهبود رفتار در از دست رفتن بسته ---
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_notsent_lowat = 16384
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_tw_reuse = 1
# --- افزایش سقف فایل/کانکشن ---
fs.file-max = 1048576
EOF

  # فعال‌سازی ماژول BBR در صورت لزوم
  modprobe tcp_bbr 2>/dev/null || true
  sysctl --system >/dev/null 2>&1 || sysctl -p "$SYSCTL_FILE" >/dev/null 2>&1 || true

  cat > "$LIMITS_FILE" <<'EOF'
*    soft nofile 1048576
*    hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF

  local cc; cc="$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo unknown)"
  if [[ "$cc" == "bbr" ]]; then
    ok "کنترل ازدحام فعال: BBR"
  else
    warn "BBR فعال نشد (مقدار فعلی: $cc). کرنل ممکن است از BBR پشتیبانی نکند؛ تانل همچنان کار می‌کند."
  fi
}

# ----------------------- کمک‌توابع توکن/رمز -----------------------------------
rand_str() {
  # تولید رشتهٔ تصادفی بدون SIGPIPE (سازگار با set -o pipefail)
  local n="${1:-16}" out=""
  while [[ "${#out}" -lt "$n" ]]; do
    out+="$(LC_ALL=C tr -dc 'a-zA-Z0-9' < <(head -c 64 /dev/urandom))"
  done
  printf '%s' "${out:0:n}"
}

# token format (base64):  v1|TPORT|USER|PASS|PATH|TRANSPORT|SVCHOST|SVCPORT|UDP
make_token() {
  printf 'v1|%s|%s|%s|%s|%s|%s|%s|%s' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" | base64 -w0
}

# --------------------------- ساخت سرویس systemd ------------------------------
write_run_script() {
  # $1 = full gost command (without binary)
  mkdir -p "$CONF_DIR"
  cat > "$RUN_SCRIPT" <<EOF
#!/usr/bin/env bash
exec ${GOST_BIN} $1
EOF
  chmod +x "$RUN_SCRIPT"
}

create_service() {
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=GOST Tunnel (Iran <-> Foreign)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${RUN_SCRIPT}
Restart=always
RestartSec=3
LimitNOFILE=1048576
# ری‌استارت سریع در صورت قطعی شبکه (ضد قطعی)
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
  systemctl restart "${SERVICE_NAME}"
  sleep 2
  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    ok "سرویس ${SERVICE_NAME} با موفقیت اجرا شد و در بوت بعدی هم خودکار بالا می‌آید."
  else
    err "سرویس اجرا نشد. لاگ:  journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    journalctl -u "${SERVICE_NAME}" -n 20 --no-pager 2>/dev/null || true
  fi
}

# --------------------------- نصب سمت سرور خارج --------------------------------
install_foreign() {
  line
  echo -e "${BLD}نصب روی «سرور خارج» (Exit / محل سرویس اصلی)${RST}"
  line
  read -rp "پورت تانل که روی سرور خارج باز می‌شود [443]: " TPORT; TPORT="${TPORT:-443}"
  read -rp "هاست سرویس داخلی روی همین سرور [127.0.0.1]: " SVCHOST; SVCHOST="${SVCHOST:-127.0.0.1}"
  read -rp "پورت سرویس اصلی که می‌خواهی تانل شود (مثلاً پنل/SSH): " SVCPORT
  while ! [[ "$SVCPORT" =~ ^[0-9]+$ ]]; do read -rp "یک پورت معتبر وارد کن: " SVCPORT; done

  echo
  echo "نوع ترابری (Transport):"
  echo "  1) mwss  — WebSocket+TLS+Mux  (پیشنهادی: ضدفیلتر + CPU پایین)"
  echo "  2) mtls  — TLS+Mux            (سریع‌تر، کمی قابل‌شناسایی‌تر)"
  echo "  3) mws   — WebSocket+Mux      (بدون TLS، مناسب پشت CDN)"
  echo "  4) grpc  — gRPC               (مالتی‌پلکس قوی)"
  read -rp "انتخاب [1]: " t; t="${t:-1}"
  case "$t" in
    1) TRANSPORT="mwss" ;; 2) TRANSPORT="mtls" ;;
    3) TRANSPORT="mws"  ;; 4) TRANSPORT="grpc" ;;
    *) TRANSPORT="mwss" ;;
  esac

  read -rp "آیا UDP هم تانل شود؟ (برای WireGuard/برخی V2Ray) [y/N]: " udp
  [[ "${udp,,}" == "y" ]] && UDP="yes" || UDP="no"

  local USER PASS WPATH
  USER="u$(rand_str 6)"; PASS="$(rand_str 20)"; WPATH="/$(rand_str 8)"

  install_gost
  tune_system

  # ساخت دستور سرور (listener پروکسی)
  local LISTEN
  case "$TRANSPORT" in
    grpc) LISTEN="grpc://${USER}:${PASS}@:${TPORT}" ;;
    *)    LISTEN="${TRANSPORT}://${USER}:${PASS}@:${TPORT}?path=${WPATH}" ;;
  esac
  write_run_script "-L \"${LISTEN}\""

  mkdir -p "$CONF_DIR"
  cat > "$INFO_FILE" <<EOF
ROLE=foreign
TPORT=${TPORT}
USER=${USER}
PASS=${PASS}
WPATH=${WPATH}
TRANSPORT=${TRANSPORT}
SVCHOST=${SVCHOST}
SVCPORT=${SVCPORT}
UDP=${UDP}
EOF

  create_service

  local TOKEN; TOKEN="$(make_token "$TPORT" "$USER" "$PASS" "$WPATH" "$TRANSPORT" "$SVCHOST" "$SVCPORT" "$UDP")"
  echo
  line
  ok "نصب سرور خارج کامل شد."
  echo -e "${BLD}توکن اتصال (این را کپی کن و در سرور ایران وارد کن):${RST}"
  echo -e "${GRN}${TOKEN}${RST}"
  line
  echo "نکته امنیتی: حتماً پورت ${TPORT} را در فایروال سرور خارج باز کن."
  echo "مثال (ufw):  ufw allow ${TPORT}/tcp"
}

# ---------------------------- نصب سمت سرور ایران ------------------------------
install_iran() {
  line
  echo -e "${BLD}نصب روی «سرور ایران» (Entry / نقطه ورود کاربران)${RST}"
  line
  read -rp "آی‌پی یا دامنهٔ سرور خارج: " FOREIGN
  while [[ -z "${FOREIGN:-}" ]]; do read -rp "آدرس سرور خارج را وارد کن: " FOREIGN; done
  read -rp "توکن اتصال (از خروجی نصب سرور خارج): " TOKEN
  while [[ -z "${TOKEN:-}" ]]; do read -rp "توکن را وارد کن: " TOKEN; done

  local DEC; DEC="$(echo "$TOKEN" | base64 -d 2>/dev/null || true)"
  IFS='|' read -r VER TPORT USER PASS WPATH TRANSPORT SVCHOST SVCPORT UDP <<< "$DEC"
  if [[ "${VER:-}" != "v1" || -z "${TPORT:-}" ]]; then
    err "توکن نامعتبر است. لطفاً همان توکن خروجی سرور خارج را وارد کن."
    exit 1
  fi

  read -rp "پورت محلی روی سرور ایران که کاربران به آن وصل می‌شوند [${SVCPORT}]: " LPORT
  LPORT="${LPORT:-$SVCPORT}"

  install_gost
  tune_system

  local FWD
  case "$TRANSPORT" in
    grpc) FWD="grpc://${USER}:${PASS}@${FOREIGN}:${TPORT}" ;;
    *)    FWD="${TRANSPORT}://${USER}:${PASS}@${FOREIGN}:${TPORT}?path=${WPATH}" ;;
  esac

  local CMD="-L \"tcp://:${LPORT}/${SVCHOST}:${SVCPORT}\""
  if [[ "${UDP:-no}" == "yes" ]]; then
    CMD="${CMD} -L \"udp://:${LPORT}/${SVCHOST}:${SVCPORT}\""
  fi
  CMD="${CMD} -F \"${FWD}\""

  write_run_script "$CMD"

  mkdir -p "$CONF_DIR"
  cat > "$INFO_FILE" <<EOF
ROLE=iran
FOREIGN=${FOREIGN}
TPORT=${TPORT}
LPORT=${LPORT}
TRANSPORT=${TRANSPORT}
SVCHOST=${SVCHOST}
SVCPORT=${SVCPORT}
UDP=${UDP}
EOF

  create_service
  echo
  line
  ok "نصب سرور ایران کامل شد."
  echo "حالا کاربران به  ${BLD}${FOREIGN_DISPLAY:-آی‌پی سرور ایران}:${LPORT}${RST}  وصل می‌شوند و ترافیک از تانل عبور می‌کند."
  echo "فراموش نکن پورت ${LPORT} را در فایروال سرور ایران باز کنی:  ufw allow ${LPORT}/tcp"
  line
}

# ------------------------------ مدیریت ---------------------------------------
show_status() {
  line
  if [[ -f "$INFO_FILE" ]]; then
    echo -e "${BLD}پیکربندی فعلی:${RST}"; cat "$INFO_FILE"; line
  fi
  systemctl status "${SERVICE_NAME}" --no-pager 2>/dev/null || warn "سرویس نصب نشده است."
  line
  echo "آخرین لاگ‌ها:"
  journalctl -u "${SERVICE_NAME}" -n 20 --no-pager 2>/dev/null || true
}

restart_service() { systemctl restart "${SERVICE_NAME}" && ok "ری‌استارت شد." ; }

uninstall_all() {
  warn "در حال حذف کامل تانل ..."
  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "$SERVICE_FILE"; systemctl daemon-reload 2>/dev/null || true
  rm -rf "$CONF_DIR"
  rm -f "$SYSCTL_FILE" "$LIMITS_FILE"
  read -rp "باینری GOST هم حذف شود؟ [y/N]: " d
  [[ "${d,,}" == "y" ]] && rm -f "$GOST_BIN"
  ok "حذف کامل انجام شد."
}

show_token() {
  [[ -f "$INFO_FILE" ]] || { err "اطلاعاتی یافت نشد."; return; }
  # shellcheck disable=SC1090
  source "$INFO_FILE"
  if [[ "${ROLE:-}" != "foreign" ]]; then
    err "توکن فقط روی سرور خارج ساخته می‌شود."; return
  fi
  local TOKEN; TOKEN="$(make_token "$TPORT" "$USER" "$PASS" "$WPATH" "$TRANSPORT" "$SVCHOST" "$SVCPORT" "$UDP")"
  echo -e "${GRN}${TOKEN}${RST}"
}

# ------------------------------- منو ----------------------------------------
banner() {
  clear || true
  echo -e "${BLD}${BLU}"
  echo "  ╔══════════════════════════════════════════════════╗"
  echo "  ║          GOST Tunnel Manager  (IR <-> Abroad)      ║"
  echo "  ║   تانل پایدار، ضدفیلتر و کم‌مصرف برای ساعات اوج     ║"
  echo "  ╚══════════════════════════════════════════════════╝"
  echo -e "${RST}"
}

menu() {
  banner
  echo "  1) نصب روی سرور خارج  (Exit / محل سرویس)"
  echo "  2) نصب روی سرور ایران (Entry / نقطه ورود)"
  echo "  3) وضعیت و لاگ سرویس"
  echo "  4) ری‌استارت سرویس"
  echo "  5) نمایش توکن اتصال (سرور خارج)"
  echo "  6) حذف کامل تانل"
  echo "  0) خروج"
  echo
  read -rp "انتخاب: " ch
  case "$ch" in
    1) install_foreign ;;
    2) install_iran ;;
    3) show_status ;;
    4) restart_service ;;
    5) show_token ;;
    6) uninstall_all ;;
    0) exit 0 ;;
    *) warn "گزینهٔ نامعتبر." ;;
  esac
}

# ------------------------------- اجرا ----------------------------------------
main() {
  need_root
  ensure_tools
  if [[ $# -gt 0 ]]; then
    case "$1" in
      foreign|server|exit) install_foreign ;;
      iran|client|entry)   install_iran ;;
      status)  show_status ;;
      restart) restart_service ;;
      token)   show_token ;;
      uninstall|remove) uninstall_all ;;
      *) echo "usage: bash tunnel.sh [foreign|iran|status|restart|token|uninstall]" ;;
    esac
  else
    menu
  fi
}

main "$@"
