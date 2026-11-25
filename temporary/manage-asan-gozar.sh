#!/usr/bin/env bash
set -euo pipefail

repository=admin6501/paket-tunnel
branch=asan-gozar-deploy
archive=asan-gozar-standalone.tar.gz
unit=asan-gozar-store.service
configuration=/etc/asan-gozar-store/config.json
installer=/opt/asan-gozar-store/install-asan-gozar.py

die() { printf '%s\n' "$*" >&2; exit 1; }

if [[ ${1:-} == --help ]]; then
    printf 'Usage: sudo asan-gozar [install [DOMAIN]|update|start|restart|stop|status|uninstall]\n'
    exit
fi
(( EUID == 0 )) || die 'این فرمان را با sudo اجرا کنید.'
command -v systemctl >/dev/null || die 'نصب به یک سرور با systemd نیاز دارد.'
command -v flock >/dev/null || die 'فرمان flock در دسترس نیست.'
exec 9>/run/lock/asan-gozar-store.lock
flock -n 9 || die 'یک عملیات دیگر برای فروشگاه در حال اجراست.'

installed_domain() {
    python3 - "$configuration" <<'PY'
import json
import sys
from urllib.parse import urlsplit
with open(sys.argv[1]) as config:
    parsed = urlsplit(json.load(config)['origin'])
if parsed.scheme != 'https' or not parsed.hostname:
    raise SystemExit('Invalid storefront origin')
print(parsed.hostname)
PY
}

install_prerequisites() {
    local utility
    for utility in curl nginx openssl python3 xz; do
        if ! command -v "$utility" >/dev/null; then
            command -v apt-get >/dev/null || die 'نصب خودکار برای Ubuntu و Debian آماده شده است.'
            apt-get update
            apt-get install -y ca-certificates curl nginx openssl python3 xz-utils
            break
        fi
    done
    systemctl enable --now nginx
}

run_bundle() (
    set -o pipefail
    local domain=$1 mode=$2 work commit url expected
    work=$(mktemp -d)
    trap 'unlink "$work/$archive" 2>/dev/null || :; rmdir "$work"' EXIT
    commit=$(curl -fsSL --retry 2 --max-time 30 -H 'Cache-Control: no-cache' "https://api.github.com/repos/$repository/git/ref/heads/$branch" |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["object"]["sha"])')
    [[ $commit =~ ^[a-f0-9]{40}$ ]] || die 'شناسهٔ نسخه معتبر نیست.'
    url="https://raw.githubusercontent.com/$repository/$commit/temporary"
    expected=$(curl -fsSL --retry 2 --max-time 30 "$url/$archive.sha256")
    [[ $expected =~ ^[a-f0-9]{64}$ ]] || die 'هش بسته معتبر نیست.'
    curl -fsSL --retry 2 --max-time 120 "$url/$archive" -o "$work/$archive"
    printf '%s  %s\n' "$expected" "$work/$archive" | sha256sum -c -
    if [[ $mode != --uninstall ]]; then mode="$work/$archive"; fi
    tar -xOf "$work/$archive" install-asan-gozar.py | ASAN_GOZAR_DOMAIN="$domain" python3 - "$mode"
)

action=${1:-}
if [[ -z $action ]]; then
    cat <<'MENU'
آسان‌گذر
۱) نصب وب‌سایت
۲) به‌روزرسانی و پاک‌سازی فایل‌های قدیمی
۳) شروع
۴) ری‌استارت
۵) توقف
۶) وضعیت
۷) حذف کامل وب‌سایت
MENU
    read -r -p 'شمارهٔ گزینه: ' action </dev/tty
fi

case "$action" in
    1|۱|install|2|۲|update)
        if [[ $action == update || $action == 2 || $action == ۲ ]]; then
            [[ -f $configuration ]] || die 'برای راه‌اندازی اولیه گزینهٔ نصب را انتخاب کنید.'
        fi
        install_prerequisites
        if [[ -f $configuration ]]; then
            domain=$(installed_domain)
            [[ $# -lt 2 || $2 == "$domain" ]] || die 'دامنه را برای نصب موجود عوض نکنید.'
        else
            domain=${2:-}
            if [[ -z $domain ]]; then
                read -r -p 'دامنهٔ متصل به سرور [asan-gozar.ir]: ' domain </dev/tty
                domain=${domain:-asan-gozar.ir}
            fi
        fi
        run_bundle "$domain" "$archive"
        ;;
    3|۳|start) systemctl start "$unit" ;;
    4|۴|restart) systemctl restart "$unit" ;;
    5|۵|stop) systemctl stop "$unit" ;;
    6|۶|status) systemctl status --no-pager "$unit" ;;
    7|۷|uninstall)
        [[ -f $configuration ]] || die 'فروشگاه نصب‌شده پیدا نشد.'
        domain=$(installed_domain)
        printf 'با حذف %s تمام حساب‌ها، سفارش‌ها، تیکت‌ها و فایل‌های فروشگاه پاک می‌شوند.\n' "$domain"
        read -r -p 'برای تأیید، نام دامنه را وارد کنید: ' confirmation </dev/tty
        [[ $confirmation == "$domain" ]] || die 'حذف لغو شد.'
        if [[ -f $installer ]]; then
            ASAN_GOZAR_DOMAIN="$domain" python3 "$installer" --uninstall
        else
            run_bundle "$domain" --uninstall
        fi
        ;;
    *) die 'گزینه نامعتبر است. راهنما: asan-gozar --help' ;;
esac
