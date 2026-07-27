#!/usr/bin/env bash
#
# setup-dnstt.sh — a DNS tunnel to use as the emergency control channel.
#
# This carries no real traffic. Its only job is to still be there when the main
# tunnel is gone, so you can reach the foreign server, see what happened, and
# change the config — instead of being locked out until the outage ends.
#
# Direction: the SERVER half runs abroad, the CLIENT half runs inside Iran.
# During a national-intranet event domestic routes keep working, so the machine
# you lose is the foreign one — this is the channel that reaches it.
#
#   kharej:  setup-dnstt.sh server --domain t.example.com --forward 127.0.0.1:22
#   iran:    setup-dnstt.sh client --domain t.example.com --pubkey <hex>
#
# Options (server):
#   --domain NAME     the delegated subdomain carrying the tunnel (required)
#   --forward ADDR    what to expose over it (default: 127.0.0.1:22)
#   --listen PORT     UDP port for the tunnel server (default: 5300)
#   --no-redirect     do not add the :53 -> :5300 redirect rule
#
# Options (client):
#   --domain NAME     the same subdomain (required)
#   --pubkey HEX      the server's public key, printed by the server half (required)
#   --resolver ADDR   recursive resolver to send queries through
#                     (default: the first nameserver in /etc/resolv.conf)
#   --doh URL         use DNS-over-HTTPS instead of plain UDP/53
#   --local PORT      local port the tunnel appears on (default: 7000)

set -euo pipefail

ROLE="${1:-}"; shift || true
[[ "$ROLE" == "server" || "$ROLE" == "client" ]] \
  || { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

DOMAIN="" FORWARD="127.0.0.1:22" LISTEN=5300 REDIRECT=1
PUBKEY="" RESOLVER="" DOH="" LOCAL=7000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)      DOMAIN="${2:?}"; shift 2 ;;
    --forward)     FORWARD="${2:?}"; shift 2 ;;
    --listen)      LISTEN="${2:?}"; shift 2 ;;
    --no-redirect) REDIRECT=0; shift ;;
    --pubkey)      PUBKEY="${2:?}"; shift 2 ;;
    --resolver)    RESOLVER="${2:?}"; shift 2 ;;
    --doh)         DOH="${2:?}"; shift 2 ;;
    --local)       LOCAL="${2:?}"; shift 2 ;;
    -h|--help)     sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "run as root: sudo $0 $ROLE ..." >&2; exit 1; }
[[ -n "$DOMAIN" ]] || { echo "--domain is required" >&2; exit 2; }

STATE=/etc/paket-tunnel/dnstt
mkdir -p "$STATE"

# --- build the binaries --------------------------------------------------

need_build=0
case "$ROLE" in
  server) [[ -x /usr/local/bin/dnstt-server ]] || need_build=1 ;;
  client) [[ -x /usr/local/bin/dnstt-client ]] || need_build=1 ;;
esac

if [[ $need_build -eq 1 ]]; then
  echo "==> building dnstt-$ROLE"
  if ! command -v go >/dev/null 2>&1; then
    echo "==> installing golang"
    apt-get update -qq || true
    apt-get install -y -qq golang-go git || {
      echo "could not install Go — install it and re-run" >&2; exit 1; }
  fi
  GOBIN=/usr/local/bin go install \
    "www.bamsoftware.com/git/dnstt.git/dnstt-$ROLE@latest" \
    || { echo "go install failed — check outbound access to the module proxy" >&2; exit 1; }
fi

# --- server half ---------------------------------------------------------

if [[ "$ROLE" == "server" ]]; then
  if [[ ! -f "$STATE/server.key" ]]; then
    dnstt-server -gen-key -privkey-file "$STATE/server.key" -pubkey-file "$STATE/server.pub"
    chmod 600 "$STATE/server.key"
  fi
  PUB="$(cat "$STATE/server.pub")"

  cat >/etc/systemd/system/paket-dnstt.service <<EOF
[Unit]
Description=paket-tunnel DNS control channel (server)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/dnstt-server -udp :$LISTEN -privkey-file $STATE/server.key $DOMAIN $FORWARD
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now paket-dnstt.service

  if [[ $REDIRECT -eq 1 ]]; then
    # Queries arrive on :53 because that is where a resolver sends them; the
    # tunnel itself stays on an unprivileged port.
    if ! iptables -t nat -C PREROUTING -p udp --dport 53 -j REDIRECT --to-port "$LISTEN" 2>/dev/null; then
      iptables -t nat -A PREROUTING -p udp --dport 53 -j REDIRECT --to-port "$LISTEN"
      command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || \
        echo "  ! the :53 redirect is not persistent — save your iptables rules"
    fi
  fi

  MYIP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<this-server-ip>')"
  BASE="${DOMAIN#*.}"

  cat <<EOF

DNS control channel (server half) is up, exposing $FORWARD

Add these two records at your DNS provider, on the zone for $BASE:

  $DOMAIN.        IN  NS  tns.$BASE.
  tns.$BASE.      IN  A   $MYIP

The NS record delegates that subdomain to this machine, which is what makes a
recursive resolver anywhere forward its queries here. Give it time to
propagate, then on the Iran server:

  sudo ./control-channel/setup-dnstt.sh client \\
    --domain $DOMAIN \\
    --pubkey $PUB

  PUBLIC KEY  $PUB

Logs: journalctl -u paket-dnstt -f
EOF
  exit 0
fi

# --- client half ---------------------------------------------------------

[[ -n "$PUBKEY" ]] || { echo "--pubkey is required (printed by the server half)" >&2; exit 2; }

if [[ -z "$DOH" && -z "$RESOLVER" ]]; then
  RESOLVER="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)"
  [[ -n "$RESOLVER" ]] || { echo "no nameserver in /etc/resolv.conf — pass --resolver" >&2; exit 1; }
fi

if [[ -n "$DOH" ]]; then
  TRANSPORT_ARGS="-doh $DOH"
else
  TRANSPORT_ARGS="-udp ${RESOLVER}:53"
fi

printf '%s' "$PUBKEY" >"$STATE/server.pub"

cat >/etc/systemd/system/paket-dnstt.service <<EOF
[Unit]
Description=paket-tunnel DNS control channel (client)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/dnstt-client $TRANSPORT_ARGS -pubkey-file $STATE/server.pub $DOMAIN 127.0.0.1:$LOCAL
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now paket-dnstt.service

cat <<EOF

DNS control channel (client half) is up.

Reach the foreign server through it:

  ssh -p $LOCAL root@127.0.0.1

Expect a few hundred kbit/s at best and noticeable latency — this is a DNS
tunnel, not a route. It is enough for a shell and for editing a config, which
is all it is meant for. For a browsable path, add a SOCKS proxy on top:

  ssh -p $LOCAL -D 1080 -N root@127.0.0.1

Using: ${DOH:-UDP/53 via $RESOLVER}
Logs:  journalctl -u paket-dnstt -f
EOF
