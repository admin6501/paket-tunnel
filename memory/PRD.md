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
- Tunnel IPs configurable from menu; defaults 10.20.20.1 (relay) / 10.20.20.2 (exit).
- Target OS: Ubuntu 22.04, root on both servers.

## Architecture
- `core/spooftun.c` — raw AF_INET (TX, IP_HDRINCL, spoofed source) + AF_PACKET
  (RX, BPF proto filter) + 2 threads relaying WireGuard UDP <-> spoofed carrier.
  Subcommands: `run`, `probe-send`, `probe-listen`.
- `scripts/spoof-tunnel.sh` — whiptail manager: install, role, spoof-tester,
  carrier, IP/WG keys, port-forward, status, watchdog, optimize, backup, uninstall.
- systemd: `spooftun.service` + `spoof-watchdog.service` (ping-based auto-restart).
- sysctl: ip_forward=1, rp_filter=0, BBR; WireGuard MTU 1280; iptables carrier DROP + NAT.

## Status (2026-06)
- ✅ C core implemented; builds clean for amd64 (x86_64-linux-gnu-gcc) and
  arm64 (aarch64-linux-gnu-gcc); static; prebuilt in `bin/`.
- ✅ whiptail manager (all 11 menu items) + install.sh + reference systemd units + README.
- ✅ bash syntax + shellcheck (only benign SC1090) pass.
- ⚠️ Raw-socket / spoofing / WireGuard runtime NOT testable in this k8s container
  (no CAP_NET_RAW). Binary fails gracefully here; must be run as root on the
  user's Ubuntu servers for real network validation.

## Backlog / next
- P1: auto-rotate across multiple whitelisted ranges on block.
- P1: automated spoof-tester coordination (relay↔exit handshake to auto-pick range).
- P2: second backup tunnel + failover; Telegram outage alerts.
- P2: per-carrier obfuscation randomization (ports, ICMP id jitter).
