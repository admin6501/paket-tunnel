#!/usr/bin/env bash
#
# paket-menu.sh — the interactive manager.
#
# Everything the deploy scripts do, driven by numbered prompts instead of
# flags. Opened by running `paket-tunnel` with no arguments.
#
# Deliberately NOT `set -e` / `set -u`. An interactive menu that exits on the
# first non-zero return is worse than useless: one failed probe, one grep that
# found nothing, and the operator is dropped back to a shell with no idea why.
# Errors are checked where they matter instead.
set -o pipefail

ROOT="$(cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")" && pwd)"
CONF_DIR="${BACKPACK_CONF_DIR:-/etc/backpack}"
BACKPACK_BIN="${BACKPACK_BIN:-/usr/local/bin/backpack}"
STATE_DIR=/etc/paket-tunnel

R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[0;33m'
B=$'\033[0;34m'; C=$'\033[0;36m'; W=$'\033[1;37m'; D=$'\033[0;90m'; N=$'\033[0m'

say()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
ok()   { printf '%s ok %s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s  ! %s %s\n' "$Y" "$N" "$*"; }
oops() { printf '%serror%s %s\n' "$R" "$N" "$*"; }

pause() { printf '\n%s' "${D}اینتر بزن تا برگردی به منو...${N}"; read -r _; }

hr() { printf '%s%s%s\n' "$D" "────────────────────────────────────────────────────────" "$N"; }

# ask VAR "prompt" ["default"]
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __in=""
  if [[ -n "$__default" ]]; then
    read -r -p "$(printf '%s%s%s [%s%s%s]: ' "$W" "$__prompt" "$N" "$C" "$__default" "$N")" __in
    [[ -z "$__in" ]] && __in="$__default"
  else
    read -r -p "$(printf '%s%s%s: ' "$W" "$__prompt" "$N")" __in
  fi
  printf -v "$__var" '%s' "$__in"
}

# ask_required VAR "prompt" — keeps asking until something is entered
ask_required() {
  local __var="$1" __prompt="$2"
  while :; do
    ask "$__var" "$__prompt"
    [[ -n "${!__var}" ]] && return 0
    warn "این مورد اجباری است."
  done
}

confirm() {
  local a=""
  read -r -p "$(printf '%s%s%s [y/N]: ' "$Y" "$1" "$N")" a
  [[ "$a" == [yY] || "$a" == [yY][eE][sS] ]]
}

# choose VAR "title" "value|label" ...
choose() {
  local __var="$1" __title="$2"; shift 2
  local -a vals=() labels=()
  local item
  for item in "$@"; do
    vals+=("${item%%|*}")
    labels+=("${item#*|}")
  done
  say ""
  printf '%s%s%s\n' "$W" "$__title" "$N"
  local i
  for i in "${!vals[@]}"; do
    printf '  %s%2d%s) %s\n' "$C" "$((i + 1))" "$N" "${labels[$i]}"
  done
  local pick=""
  while :; do
    read -r -p "$(printf '%sانتخاب%s [1]: ' "$W" "$N")" pick
    [[ -z "$pick" ]] && pick=1
    if [[ "$pick" =~ ^[0-9]+$ ]] && (( pick >= 1 && pick <= ${#vals[@]} )); then
      printf -v "$__var" '%s' "${vals[$((pick - 1))]}"
      return 0
    fi
    warn "عددی بین ۱ تا ${#vals[@]} وارد کن."
  done
}

pick_transport() {
  choose "$1" "ترنسپورت را انتخاب کن:" \
    "wssmux|${G}wssmux${N}  — پیش‌فرض. عین HTTPS معمولی با اثرانگشت کروم؛ تنها گزینه‌ای که از CDN رد می‌شود" \
    "stealth|${G}stealth${N} — بایت تصادفی روی سیم، بدون امضا. وقتی DPI الگو را می‌گیرد" \
    "wss|wss     — مثل wssmux ولی بدون مالتی‌پلکس" \
    "kcp|kcp     — UDP با تصحیح خطا (FEC). مسیر پرلاست" \
    "tcpmux|tcpmux  — TCP خام با مالتی‌پلکس. سریع، ولی امضادار" \
    "tcp|tcp     — ساده‌ترین. فقط مسیر تمیز" \
    "wsmux|wsmux   — WebSocket بدون TLS" \
    "ws|ws      — WebSocket بدون TLS، بدون مالتی‌پلکس" \
    "udp|udp     — دیتاگرام خام، بدون لایه‌ی اطمینان"
}

# The tunnel name doubles as the systemd unit name, so keep it to something
# systemd will accept without escaping.
ask_tunnel_name() {
  local __var="$1" v=""
  while :; do
    ask v "نام تونل (برای چند تونل موازی)" "main"
    if [[ "$v" =~ ^[A-Za-z0-9_-]+$ ]]; then
      printf -v "$__var" '%s' "$v"
      return 0
    fi
    warn "فقط حروف انگلیسی، عدد، خط تیره و آندرلاین."
  done
}

list_tunnels() {
  local f
  for f in "$CONF_DIR"/*.toml; do
    [[ -e "$f" ]] || continue
    basename "$f" .toml
  done
}

# pick_tunnel VAR — returns 1 when there is nothing configured yet
pick_tunnel() {
  local __var="$1"
  local -a names=()
  mapfile -t names < <(list_tunnels)
  if [[ ${#names[@]} -eq 0 ]]; then
    warn "هنوز هیچ تونلی تنظیم نشده."
    return 1
  fi
  if [[ ${#names[@]} -eq 1 ]]; then
    printf -v "$__var" '%s' "${names[0]}"
    return 0
  fi
  local -a opts=()
  local n
  for n in "${names[@]}"; do opts+=("$n|$n"); done
  choose "$__var" "کدام تونل؟" "${opts[@]}"
}

role_of() {
  local f="$CONF_DIR/$1.toml"
  if grep -q '^[[:space:]]*bind_addr[[:space:]]*=' "$f" 2>/dev/null; then
    echo server
  elif grep -q '^[[:space:]]*remote_addr[[:space:]]*=' "$f" 2>/dev/null; then
    echo client
  else
    echo unknown
  fi
}

value_of() { # value_of <file> <key>
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -1
}

# unit_state <unit> — distinguishes "never installed" from "installed but
# down", which are different problems with different fixes.
unit_state() {
  if ! systemctl list-unit-files "$1" >/dev/null 2>&1 \
     || [[ -z "$(systemctl list-unit-files "$1" --no-legend 2>/dev/null)" ]]; then
    printf '%sنصب نشده%s' "$D" "$N"
    return
  fi
  if systemctl is-active --quiet "$1" 2>/dev/null; then
    printf '%sفعال%s' "$G" "$N"
  else
    printf '%s%s%s' "$R" "$(systemctl is-active "$1" 2>/dev/null || echo 'غیرفعال')" "$N"
  fi
}

banner() {
  clear 2>/dev/null
  local ver="-"
  [[ -x "$BACKPACK_BIN" ]] && ver="$("$BACKPACK_BIN" -v 2>/dev/null || echo '?')"
  printf '%s\n' "$W╔══════════════════════════════════════════════════════╗$N"
  printf '%s\n' "$W║$N            ${C}paket-tunnel${N}  —  مدیریت تونل            $W║$N"
  printf '%s\n' "$W╚══════════════════════════════════════════════════════╝$N"
  printf '  %sbackpack%s %s    %sتونل‌ها%s %s\n\n' \
    "$D" "$N" "$ver" "$D" "$N" "$(list_tunnels | tr '\n' ' ' | sed 's/ $//;s/^$/—/')"
}

# ---------------------------------------------------------------- actions

setup_iran() {
  banner
  say "${W}راه‌اندازی سرور ایران${N} (نقش server)"
  hr
  say "${D}این سمت پورت‌ها را برای کاربر باز می‌کند و منتظر می‌ماند سرور خارج${N}"
  say "${D}به آن وصل شود. اول این را بزن، بعد سمت خارج.${N}"
  say ""

  local name transport ports bindport domain email extra=()
  ask_tunnel_name name
  pick_transport transport

  say ""
  say "${D}پورت‌هایی که کاربر به آن وصل می‌شود. سه شکل قبول است:${N}"
  say "${D}  443                  ورودی ۴۴۳، تحویل به همان ۴۴۳ سمت خارج${N}"
  say "${D}  443=127.0.0.1:8080   ورودی ۴۴۳، تحویل به این آدرس سمت خارج${N}"
  say "${D}  8000-8100            یک بازه${N}"
  ask_required ports "پورت‌ها (با ویرگول جدا کن)"

  ask bindport "پورتی که سرور خارج به آن وصل می‌شود" "443"

  if [[ "$transport" == wss || "$transport" == wssmux ]]; then
    say ""
    if confirm "گواهی Let's Encrypt بگیرم؟ (دامنه باید همین حالا به این سرور اشاره کند)"; then
      ask_required domain "دامنه"
      ask_required email "ایمیل برای ثبت ACME"
      extra+=(--domain "$domain" --email "$email")
    fi
  fi

  say ""
  hr
  say "  تونل      $C$name$N"
  say "  ترنسپورت  $C$transport$N"
  say "  پورت‌ها    $C$ports$N"
  say "  بایند     ${C}0.0.0.0:$bindport$N"
  [[ -n "$domain" ]] && say "  دامنه     $C$domain$N"
  hr
  confirm "ادامه بدهم؟" || { warn "لغو شد."; pause; return; }

  say ""
  "$ROOT/deploy/iran-server.sh" --name "$name" --transport "$transport" \
    --ports "$ports" --bind "0.0.0.0:$bindport" "${extra[@]}"
  pause
}

setup_kharej() {
  banner
  say "${W}راه‌اندازی سرور خارج${N} (نقش client)"
  hr
  say "${D}این سمت به سرور ایران وصل می‌شود. چون اتصال همیشه از اینجا${N}"
  say "${D}شروع می‌شود، هیچ بسته‌ای از ایران به سمت آی‌پی این ماشین نمی‌رود.${N}"
  say ""

  local name transport server token backup edge pool extra=()
  ask_tunnel_name name
  pick_transport transport

  say ""
  warn "ترنسپورت باید با سمت ایران یکی باشد، وگرنه تونل بالا نمی‌آید."
  say ""

  ask_required server "آدرس سرور ایران (به شکل IP:PORT)"
  while [[ "$server" != *:* ]]; do
    warn "پورت را هم بنویس، مثل 1.2.3.4:443"
    ask_required server "آدرس سرور ایران (به شکل IP:PORT)"
  done
  ask_required token "توکنی که سمت ایران چاپ کرد"

  say ""
  say "${D}آدرس‌های پشتیبان: آی‌پی دوم همان سرور، پورت دیگرش، یا لبه‌ی CDN جلویش.${N}"
  say "${D}همه باید به یک سرور برسند. اگر آدرس اصلی جواب نداد، خودکار می‌چرخد.${N}"
  ask backup "آدرس‌های پشتیبان (با ویرگول، خالی = ندارم)"
  [[ -n "$backup" ]] && extra+=(--backup "$backup")

  say ""
  if [[ "$transport" == wss || "$transport" == wssmux ]]; then
    ask edge "آی‌پی لبه‌ی CDN (خالی = مستقیم به سرور ایران)"
    [[ -n "$edge" ]] && extra+=(--edge "$edge")
  else
    say "${D}ترنسپورت $transport از CDN رد نمی‌شود، پس گزینه‌ی لبه پرسیده نشد.${N}"
  fi

  ask pool "اندازه‌ی connection pool" "8"
  extra+=(--pool "$pool")

  if [[ -n "$backup" ]]; then
    say ""
    say "${D}تعادل بار: آدرس‌های پشتیبان به‌جای اینکه بیکار بمانند، هم‌زمان ترافیک${N}"
    say "${D}می‌برند؛ آن‌وقت یک مسیر کند فقط سهم خودش را کند می‌کند.${N}"
    confirm "تعادل بار روشن باشد؟" && extra+=(--load-balance)
  fi

  say ""
  hr
  say "  تونل      $C$name$N"
  say "  ترنسپورت  $C$transport$N"
  say "  مقصد      $C$server$N"
  say "  پشتیبان   $C${backup:-—}$N"
  say "  لبه CDN   $C${edge:-—}$N"
  hr
  confirm "ادامه بدهم؟" || { warn "لغو شد."; pause; return; }

  say ""
  "$ROOT/deploy/kharej-client.sh" --name "$name" --transport "$transport" \
    --server "$server" --token "$token" "${extra[@]}"
  pause
}

change_transport() {
  banner
  say "${W}تغییر ترنسپورت${N}"
  hr
  local name
  pick_tunnel name || { pause; return; }

  local f="$CONF_DIR/$name.toml"
  local cur; cur="$(value_of "$f" transport)"
  say "  ترنسپورت فعلی: $C$cur$N"

  local new
  pick_transport new
  if [[ "$new" == "$cur" ]]; then
    warn "همان قبلی است، تغییری لازم نیست."
    pause; return
  fi

  say ""
  warn "این را روی سرور مقابل هم عوض کن. تا وقتی دو طرف یکی نشوند، تونل بالا نمی‌آید."
  confirm "ترنسپورت $name را به $new تغییر بدهم؟" || { warn "لغو شد."; pause; return; }

  cp -a "$f" "$f.bak.$(date +%Y%m%d%H%M%S)"
  sed -i "s|^\([[:space:]]*transport[[:space:]]*=[[:space:]]*\).*|\1\"$new\"|" "$f"
  if systemctl restart "backpack-$name" 2>/dev/null; then
    ok "تغییر کرد و سرویس ری‌استارت شد."
  else
    oops "کانفیگ عوض شد ولی ری‌استارت نشد — journalctl -u backpack-$name"
  fi
  pause
}

manage_backups() {
  banner
  say "${W}آدرس‌های پشتیبان${N}"
  hr
  local name
  pick_tunnel name || { pause; return; }

  local f="$CONF_DIR/$name.toml"
  if [[ "$(role_of "$name")" != client ]]; then
    warn "آدرس پشتیبان فقط روی سمت خارج (client) معنی دارد."
    pause; return
  fi

  say "  آدرس اصلی: $C$(value_of "$f" remote_addr)$N"
  say "  پشتیبان‌ها: $C$(sed -n 's/^[[:space:]]*fallback_addrs[[:space:]]*=[[:space:]]*\(.*\)/\1/p' "$f" | head -1)$N"
  say ""
  say "${D}همه باید به یک سرور برسند — آی‌پی دوم، پورت دیگر، یا لبه‌ی CDN.${N}"

  local list
  ask list "آدرس‌های پشتیبان جدید (با ویرگول، خالی = پاک کن)"

  local toml="" item
  local IFS=','
  for item in $list; do
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    [[ -z "$item" ]] && continue
    [[ -n "$toml" ]] && toml+=", "
    toml+="\"$item\""
  done
  unset IFS

  cp -a "$f" "$f.bak.$(date +%Y%m%d%H%M%S)"
  sed -i "s|^\([[:space:]]*fallback_addrs[[:space:]]*=[[:space:]]*\).*|\1[$toml]|" "$f"
  systemctl restart "backpack-$name" 2>/dev/null
  ok "به‌روزرسانی شد."
  pause
}

control_channel() {
  banner
  say "${W}کانال کنترلی (تونل DNS)${N}"
  hr
  say "${D}ترافیک واقعی حمل نمی‌کند. کارش این است که وقتی همه‌چیز خوابید،${N}"
  say "${D}هنوز بتوانی به سرور خارج برسی و درستش کنی.${N}"
  say ""
  say "${D}نیمه‌ی server روی سرور خارج می‌نشیند، نیمه‌ی client داخل ایران.${N}"

  local role
  choose role "این سرور کدام است؟" \
    "server|${G}سرور خارج${N} — نیمه‌ی server، SSH خودش را عرضه می‌کند" \
    "client|${G}سرور ایران${N} — نیمه‌ی client، کوئری DNS از اینجا بیرون می‌رود" \
    "back|بازگشت"
  [[ "$role" == back ]] && return

  local domain args=()
  ask_required domain "زیردامنه‌ی تونل (مثل t.example.com)"
  args=(--domain "$domain")

  if [[ "$role" == server ]]; then
    local fwd
    ask fwd "چه چیزی روی این کانال عرضه شود" "127.0.0.1:22"
    args+=(--forward "$fwd")
  else
    local pub resolver doh
    ask_required pub "کلید عمومی که سمت خارج چاپ کرد"
    args+=(--pubkey "$pub")
    say ""
    say "${D}اگر شبکه فقط اجازه می‌دهد با ریزالور خودش حرف بزنی، آدرسش را بده.${N}"
    ask resolver "ریزالور (خالی = اولین مورد در resolv.conf)"
    [[ -n "$resolver" ]] && args+=(--resolver "$resolver")
    ask doh "آدرس DoH (خالی = از UDP/53 استفاده کن)"
    [[ -n "$doh" ]] && args+=(--doh "$doh")
  fi

  say ""
  confirm "ادامه بدهم؟" || { warn "لغو شد."; pause; return; }
  say ""
  "$ROOT/control-channel/setup-dnstt.sh" "$role" "${args[@]}"
  pause
}

watchdog_menu() {
  banner
  say "${W}نگهبان مسیر${N}"
  hr
  say "${D}هر چند ثانیه همه‌ی آدرس‌های تونل را می‌سنجد و اگر آدرس اصلی مرده${N}"
  say "${D}باشد، یک پشتیبانِ زنده را جای آن می‌نشاند — و در کانفیگ ثبت می‌کند،${N}"
  say "${D}تا انتخاب بعد از ری‌استارت هم بماند.${N}"

  local act
  choose act "چه کار کنم؟" \
    "install|نصب یا به‌روزرسانی نگهبان" \
    "check|یک بار همین حالا بسنج (بدون تغییر)" \
    "logs|دیدن لاگ" \
    "remove|حذف نگهبان" \
    "back|بازگشت"

  case "$act" in
    install)
      local name interval
      pick_tunnel name || { pause; return; }
      ask interval "فاصله‌ی بررسی (ثانیه)" "60"
      "$ROOT/watchdog/install.sh" --name "$name" --interval "$interval"
      ;;
    check)
      local name
      pick_tunnel name || { pause; return; }
      say ""
      bash "$ROOT/watchdog/route-health.sh" --name "$name" --dry-run
      ;;
    logs)    journalctl -u paket-route-health -n 50 --no-pager ;;
    remove)
      systemctl disable --now paket-route-health.timer 2>/dev/null
      rm -f /etc/systemd/system/paket-route-health.{service,timer} /usr/local/bin/paket-route-health
      systemctl daemon-reload
      ok "حذف شد."
      ;;
    back) return ;;
  esac
  pause
}

show_status() {
  banner
  say "${W}وضعیت${N}"
  hr

  local -a names=()
  mapfile -t names < <(list_tunnels)
  if [[ ${#names[@]} -eq 0 ]]; then
    warn "هنوز تونلی تنظیم نشده."
  else
    local n f state
    for n in "${names[@]}"; do
      f="$CONF_DIR/$n.toml"
      state="$(systemctl is-active "backpack-$n" 2>/dev/null || echo unknown)"
      if [[ "$state" == active ]]; then
        printf '  %s●%s %-12s %s\n' "$G" "$N" "$n" "${G}فعال${N}"
      else
        printf '  %s●%s %-12s %s\n' "$R" "$N" "$n" "${R}$state${N}"
      fi
      printf '      نقش       %s\n' "$(role_of "$n")"
      printf '      ترنسپورت  %s\n' "$(value_of "$f" transport)"
      if [[ "$(role_of "$n")" == server ]]; then
        printf '      بایند     %s\n' "$(value_of "$f" bind_addr)"
      else
        printf '      مقصد      %s\n' "$(value_of "$f" remote_addr)"
        printf '      پشتیبان   %s\n' \
          "$(sed -n 's/^[[:space:]]*fallback_addrs[[:space:]]*=[[:space:]]*\(.*\)/\1/p' "$f" | head -1)"
      fi
      say ""
    done
  fi

  hr
  printf '  کانال کنترلی  %s\n' "$(unit_state paket-dnstt.service)"
  printf '  نگهبان مسیر   %s\n' "$(unit_state paket-route-health.timer)"
  printf '  backpack      %s\n' "$("$BACKPACK_BIN" -v 2>/dev/null || echo 'نصب نشده')"
  pause
}

show_logs() {
  banner
  local name
  pick_tunnel name || { pause; return; }
  say "${D}Ctrl+C برای خروج از لاگ${N}"
  say ""
  journalctl -u "backpack-$name" -f
}

service_menu() {
  banner
  say "${W}کنترل سرویس${N}"
  hr
  local name
  pick_tunnel name || { pause; return; }

  local act
  choose act "روی تونل «$name» چه کار کنم؟" \
    "restart|ری‌استارت" \
    "stop|توقف" \
    "start|شروع" \
    "delete|حذف کامل این تونل" \
    "back|بازگشت"

  case "$act" in
    restart) systemctl restart "backpack-$name" && ok "ری‌استارت شد." ;;
    stop)    systemctl stop "backpack-$name" && ok "متوقف شد." ;;
    start)   systemctl start "backpack-$name" && ok "شروع شد." ;;
    delete)
      confirm "تونل «$name» و کانفیگش حذف شود؟" || { warn "لغو شد."; pause; return; }
      systemctl disable --now "backpack-$name" 2>/dev/null
      rm -f "/etc/systemd/system/backpack-$name.service" "$CONF_DIR/$name.toml"
      systemctl daemon-reload
      ok "حذف شد."
      ;;
    back) return ;;
  esac
  pause
}

backup_restore() {
  banner
  say "${W}بکاپ و بازیابی${N}"
  hr
  local act
  choose act "چه کار کنم؟" \
    "backup|گرفتن بکاپ" \
    "restore|بازیابی از بکاپ" \
    "back|بازگشت"

  case "$act" in
    backup)
      mkdir -p "$STATE_DIR/backups"
      local out
      out="$STATE_DIR/backups/paket-$(date +%Y%m%d-%H%M%S).tar.gz"
      tar -czf "$out" -C / "etc/backpack" 2>/dev/null
      [[ -d "$STATE_DIR/dnstt" ]] && tar -rzf "$out" -C / "etc/paket-tunnel/dnstt" 2>/dev/null
      ok "ذخیره شد: $out"
      warn "یک نسخه از این را بیرون از هر دو سرور نگه دار."
      ;;
    restore)
      local -a files=()
      mapfile -t files < <(ls -1t "$STATE_DIR/backups"/*.tar.gz 2>/dev/null)
      if [[ ${#files[@]} -eq 0 ]]; then
        warn "بکاپی پیدا نشد."
      else
        local -a opts=(); local f
        for f in "${files[@]}"; do opts+=("$f|$(basename "$f")"); done
        local pick
        choose pick "کدام بکاپ؟" "${opts[@]}"
        confirm "کانفیگ فعلی با «$(basename "$pick")» جایگزین شود؟" || { warn "لغو شد."; pause; return; }
        tar -xzf "$pick" -C / && ok "بازیابی شد. تونل‌ها را ری‌استارت کن."
      fi
      ;;
    back) return ;;
  esac
  pause
}

optimize_kernel() {
  banner
  say "${W}بهینه‌سازی شبکه${N}"
  hr
  say "${D}BBR، بافرهای بزرگ‌تر، MTU probing و ip_forward.${N}"
  confirm "اعمال کنم؟" || { warn "لغو شد."; pause; return; }
  # shellcheck source=/dev/null
  source "$ROOT/deploy/common.sh"
  tune_kernel
  pause
}

uninstall_all() {
  banner
  say "${R}حذف کامل${N}"
  hr
  say "همه‌ی تونل‌ها، کانال کنترلی، نگهبان، باینری backpack و کانفیگ‌ها."
  say ""
  confirm "مطمئنی؟" || { warn "لغو شد."; pause; return; }
  confirm "واقعاً مطمئنی؟ این برگشت‌پذیر نیست" || { warn "لغو شد."; pause; return; }

  local n
  while read -r n; do
    [[ -z "$n" ]] && continue
    systemctl disable --now "backpack-$n" 2>/dev/null
    rm -f "/etc/systemd/system/backpack-$n.service"
  done < <(list_tunnels)

  systemctl disable --now paket-dnstt.service paket-route-health.timer 2>/dev/null
  rm -f /etc/systemd/system/paket-dnstt.service \
        /etc/systemd/system/paket-route-health.{service,timer} \
        /usr/local/bin/paket-route-health /usr/local/bin/backpack \
        /usr/local/bin/dnstt-server /usr/local/bin/dnstt-client
  systemctl daemon-reload
  rm -rf "$CONF_DIR" "$STATE_DIR"
  ok "حذف شد. خود ریپو در $ROOT دست‌نخورده ماند."
  say "${D}برای حذف دستور paket-tunnel هم:  rm -f /usr/local/bin/paket-tunnel${N}"
  pause
}

docs_menu() {
  banner
  say "${W}راهنما${N}"
  hr
  local pick
  choose pick "چه چیزی را باز کنم؟" \
    "$ROOT/docs/architecture.md|معماری — چرا این‌طور چیده شده" \
    "$ROOT/docs/blackout-playbook.md|دستورالعمل قطعی — وقتی مسیر مرد" \
    "$ROOT/control-channel/README.md|کانال کنترلی DNS" \
    "$ROOT/configs/README.md|کانفیگ‌ها و انتخاب ترنسپورت" \
    "back|بازگشت"
  [[ "$pick" == back ]] && return
  if command -v less >/dev/null 2>&1; then
    less -R "$pick"
  else
    cat "$pick"; pause
  fi
}

# ---------------------------------------------------------------- main

[[ ${EUID:-$(id -u)} -eq 0 ]] || { oops "با root اجرا کن:  sudo paket-tunnel"; exit 1; }

while :; do
  banner
  say "  ${C} 1${N}) راه‌اندازی ${W}سرور ایران${N}   ${D}(نقش server — اول این)${N}"
  say "  ${C} 2${N}) راه‌اندازی ${W}سرور خارج${N}    ${D}(نقش client — بعد از ایران)${N}"
  say ""
  say "  ${C} 3${N}) تغییر ترنسپورت"
  say "  ${C} 4${N}) آدرس‌های پشتیبان"
  say "  ${C} 5${N}) کانال کنترلی DNS         ${D}(قبل از اینکه لازم شود)${N}"
  say "  ${C} 6${N}) نگهبان مسیر"
  say ""
  say "  ${C} 7${N}) وضعیت"
  say "  ${C} 8${N}) لاگ زنده"
  say "  ${C} 9${N}) کنترل سرویس            ${D}(ری‌استارت / توقف / حذف تونل)${N}"
  say ""
  say "  ${C}10${N}) بکاپ و بازیابی"
  say "  ${C}11${N}) بهینه‌سازی شبکه"
  say "  ${C}12${N}) راهنما"
  say "  ${C}13${N}) منوی خود backpack"
  say ""
  say "  ${C}88${N}) حذف کامل"
  say "  ${C} 0${N}) خروج"
  say ""
  read -r -p "$(printf '%sانتخاب%s: ' "$W" "$N")" choice

  case "$choice" in
    1)  setup_iran ;;
    2)  setup_kharej ;;
    3)  change_transport ;;
    4)  manage_backups ;;
    5)  control_channel ;;
    6)  watchdog_menu ;;
    7)  show_status ;;
    8)  show_logs ;;
    9)  service_menu ;;
    10) backup_restore ;;
    11) optimize_kernel ;;
    12) docs_menu ;;
    13) "$BACKPACK_BIN" ;;
    88) uninstall_all ;;
    0|q|Q) clear 2>/dev/null; exit 0 ;;
    *)  warn "گزینه‌ی نامعتبر."; sleep 1 ;;
  esac
done
