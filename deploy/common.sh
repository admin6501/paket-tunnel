#!/usr/bin/env bash
#
# Shared helpers for the deploy scripts. Sourced, not executed.

BACKPACK_BIN="${BACKPACK_BIN:-/usr/local/bin/backpack}"
BACKPACK_CONF_DIR="${BACKPACK_CONF_DIR:-/etc/backpack}"
BACKPACK_INSTALLER="${BACKPACK_INSTALLER:-https://raw.githubusercontent.com/AminMGMT/BackPack/main/install.sh}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"

C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YLW=$'\033[0;33m'
C_BLU=$'\033[0;34m'; C_OFF=$'\033[0m'

info()  { printf '%s==>%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()    { printf '%s ok %s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn()  { printf '%s  ! %s %s\n' "$C_YLW" "$C_OFF" "$*" >&2; }
die()   { printf '%serror%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

require_root() {
  [[ ${EUID:-$(id -u)} -eq 0 ]] || die "run as root:  sudo $0 ..."
}

# The transports Backpack understands, as written in a config's `transport` key.
VALID_TRANSPORTS="tcp tcpmux stealth ws wss wsmux wssmux udp kcp"

validate_transport() {
  local t="$1"
  for v in $VALID_TRANSPORTS; do
    [[ "$t" == "$v" ]] && return 0
  done
  die "unknown transport '$t' (valid: $VALID_TRANSPORTS)"
}

# A CDN can only carry the WebSocket-over-TLS transports; a raw carrier has no
# HTTP layer for the edge to proxy. Warn rather than fail, since the operator
# may be pointing at a plain reverse proxy of their own.
warn_if_cdn_incompatible() {
  case "$1" in
    wss|wssmux) return 0 ;;
    *) warn "transport '$1' cannot pass through a CDN edge — use wss or wssmux for that" ;;
  esac
}

install_backpack() {
  if [[ -x "$BACKPACK_BIN" ]]; then
    ok "backpack already installed ($("$BACKPACK_BIN" -v 2>/dev/null || echo unknown))"
    return 0
  fi
  info "installing backpack..."
  command -v curl >/dev/null 2>&1 || die "curl is required to fetch the installer"
  bash <(curl -fsSL "$BACKPACK_INSTALLER") \
    || die "backpack install failed — install it manually and re-run"
  [[ -x "$BACKPACK_BIN" ]] || die "installer finished but $BACKPACK_BIN is missing"
  ok "backpack installed"
}

# A 64-character token, matching what Backpack's own setup generates. On the
# encrypted transports this never crosses the wire in clear text.
generate_token() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Render a TOML string array from a comma-separated list: a,b -> ["a", "b"]
toml_array() {
  local IFS=','
  read -ra _items <<<"$1"
  local out="" item
  for item in "${_items[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"   # ltrim
    item="${item%"${item##*[![:space:]]}"}"   # rtrim
    [[ -z "$item" ]] && continue
    [[ -n "$out" ]] && out+=", "
    out+="\"$item\""
  done
  printf '[%s]' "$out"
}

write_config() {
  local name="$1" body="$2" path="$BACKPACK_CONF_DIR/$1.toml"
  mkdir -p "$BACKPACK_CONF_DIR"
  if [[ -f "$path" ]]; then
    cp -a "$path" "$path.bak.$(date +%Y%m%d%H%M%S)"
    warn "existing config kept as $path.bak.*"
  fi
  printf '%s\n' "$body" >"$path"
  chmod 600 "$path"
  ok "wrote $path"
}

# Backpack names one unit per tunnel: backpack-<name>.service, running the
# engine against that tunnel's config.
install_unit() {
  local name="$1" unit="$SYSTEMD_DIR/backpack-$1.service"
  cat >"$unit" <<EOF
[Unit]
Description=Backpack Tunnel ($name)
After=network.target

[Service]
Type=simple
ExecStart=$BACKPACK_BIN -c $BACKPACK_CONF_DIR/$name.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "backpack-$name.service" >/dev/null 2>&1 \
    || die "could not start backpack-$name.service — check: journalctl -u backpack-$name -n50"
  ok "backpack-$name.service enabled and started"
}

tune_kernel() {
  info "applying kernel tuning (BBR, buffers, file limits)..."
  cat >/etc/sysctl.d/99-paket-tunnel.conf <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_mtu_probing = 1
net.ipv4.ip_forward = 1
EOF
  sysctl -q --system >/dev/null 2>&1 || warn "sysctl reload reported errors"
  ok "kernel tuned"
}
