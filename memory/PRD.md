# PRD — Spoof-Tunnel (Iran ↔ Foreign)

## Problem statement
Low-level (L3/L4) tunneling toolkit to cross a whitelist-based Iranian national
gateway during international cuts, using **mutual IP spoofing**. Real traffic
(incl. Xray) rides encrypted **WireGuard** over a raw spoofed ICMP/UDP carrier.
No web panel.

## User decisions (locked)
- Core language: **pure C** (single static binary).
- Carrier: **UDP + ICMP** both supported; Spoof-Tester picks; default UDP.
- Delivery: **Bash + whiptail CLI** + **prebuilt binaries** (amd64 + arm64).
- Install: online one-liner (curl | bash, clones GitHub repo) OR offline.
- GitHub repo: https://github.com/admin6501/paket-tunnel (branch main).
- Tunnel IPs configurable; defaults 10.20.20.1 (relay) / 10.20.20.2 (exit).
- Target OS: Ubuntu 22.04, root on both servers.

## Architecture
- `core/spooftun.c` — raw AF_INET TX (IP_HDRINCL, spoofed source) + AF_PACKET RX
  (BPF proto filter) + 2 threads relaying WireGuard UDP <-> spoofed carrier.
  Subcommands: `run`, `probe-send`, `probe-listen`. Prebuilt in `bin/`.
- `scripts/spoof-tunnel.sh` — whiptail manager (11 menu items).
- `install.sh` — dual-mode (online GitHub clone / offline) installer.
- systemd: `spooftun.service` + `spoof-watchdog.service`.
- sysctl: ip_forward=1, rp_filter=0, BBR; MTU 1280; iptables carrier DROP + NAT.

## Implemented / fixed (dates)
- 2026-06: Core C implemented; builds clean amd64 + arm64 (static). Manager +
  installer + systemd units + README. Verified: build, syntax, ELF arch, --help.
- 2026-07: install.sh made resilient to broken third-party apt repos
  (ookla/speedtest-cli) — tolerates apt-get update failure, verifies required
  tools, prints actionable remediation. (iteration_1, 7/7 pass)
- 2026-07: install.sh dual-mode online/offline (GitHub clone to /opt/paket-tunnel).
- 2026-07: FIXED silent-exit bug — manager returned to shell with no menu after
  option 1. Cause: `set -euo pipefail` + load_config() returning non-zero once a
  config existed (PUB_IFACE set). Fix: dropped -e/-u (kept pipefail) on the
  interactive TUI; load_config() rewritten with if-blocks + `return 0`. Also added
  NEEDRESTART_MODE=l to apt to stop SSH disconnects mid-install. (iteration_2, 10/10 pass)

## Known environment limitation
- Dev container is aarch64 without CAP_NET_RAW: raw-socket / spoofing / WireGuard
  cannot be exercised here (expected). Real network validation happens on the
  user's Ubuntu servers. Only build/syntax/logic verified in-container.

## Backlog / next
- P1: auto-rotate across multiple whitelisted ranges on block.
- P1: automated spoof-tester relay↔exit handshake to auto-pick best range.
- P2: second backup tunnel + failover; Telegram outage alerts in the watchdog.
- P2: per-carrier obfuscation randomization (ports, ICMP id jitter).

## Regression tests
- /app/tests/test_load_config_fix.sh — silent-exit fix.
- /app/tests/test_install_deps.sh — broken apt repo happy path.
- /app/tests/test_install_deps_missing.sh — broken apt repo ERROR path.
