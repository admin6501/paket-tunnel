# PRD — GOST Tunnel Manager (Iran <-> Foreign)

## Problem Statement
کاربر یک تانل بین سرور ایران و سرور خارج می‌خواهد که در ساعات اوج، پینگ و سرعت افت نکند و CPU درگیر نشود + یک اسکریپت bash نصب اتوماتیک.

## User Choices
- نوع تانل: TCP/WebSocket reverse tunnel (پیاده‌سازی با GOST v3)
- OS: Ubuntu/Debian
- ترافیک: یک پورت/سرویس خاص (پنل V2Ray / SSH)
- اولویت: پینگ + سرعت + CPU پایین (هر سه)
- اسکریپت تعاملی

## Architecture
- Engine: GOST v3 (go-gost), باینری از GitHub releases (amd64/arm64/armv7)
- Transport پیش‌فرض: mwss (WebSocket + TLS + Multiplexing) — ضدفیلتر + CPU پایین
- سرور خارج (Exit): listener پروکسی mwss روی پورت تانل + سرویس داخلی روی 127.0.0.1
- سرور ایران (Entry): پورت محلی -> forward از طریق تانل به سرویس خارج
- توکن base64 برای انتقال آسان اعتبارنامه‌ها بین دو سرور
- systemd service با Restart=always (ضد قطعی) + سیستم تیونینگ BBR و بافرها

## Implemented (2026-06-01)
- /app/tunnel.sh: منوی تعاملی + حالت آرگومانی (foreign/iran/status/restart/token/uninstall)
- نصب خودکار GOST، تیونینگ کرنل (sysctl BBR + nofile limits)، systemd
- /app/README.md: مستندات فارسی
- تست end-to-end تانل داخل کانتینر: موفق (HELLO_FROM_FOREIGN_SERVICE از طریق mwss)
- تست round-trip توکن: موفق

## Backlog / Future
- P1: گزینهٔ دامنه + cert واقعی (Let's Encrypt) برای wss روی پورت 443
- P2: load-balancing چند سرور خارج (tunnel.weight)
- P2: مانیتورینگ پینگ/throughput و هلث‌چک خودکار

## Bug Fix (2026-06-01)
- باگ: بعد از سؤال UDP، اسکریپت با کد 141 (SIGPIPE) خارج می‌شد.
- علت: `rand_str` از /dev/urandom بی‌نهایت به `head` پایپ می‌کرد؛ تحت `set -o pipefail` کشته‌شدن `tr` با SIGPIPE کل اسکریپت را می‌بست.
- رفع: بازنویسی `rand_str` با خواندن بلوک‌های محدود (head -c 64) و برش با bsub؛ و تبدیل `grep|head` به `grep -m1` در نصب GOST.
- تست: فلوی کامل foreign (UDP=y) و iran با موفقیت تا تولید/decode توکن و ساخت دستور اجرا شد.

## Latency Improvement (2026-06-01)
- مشکل کاربر: پینگ بالا با ترابری mwss (TCP) به‌علت TCP-over-TCP meltdown روی مسیر پرافت ایران↔خارج.
- افزودن ترابری‌های UDP-محور به اسکریپت برای کاهش پینگ:
  - quic (پیش‌فرض جدید): keepalive=true&ttl=10 — پینگ پایین + CPU کم
  - kcp حالت fast3: nodelay=1&interval=10&resend=2&nc=1 — کمترین پینگ روی خطوط پرافت
- نکتهٔ فایروال برای quic/kcp به udp تغییر کرد.
- تست: نصب foreign/iran با quic + عبور ترافیک واقعی از تانل QUIC ساخته‌شده توسط اسکریپت موفق بود.
