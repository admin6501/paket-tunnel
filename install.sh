#!/usr/bin/env bash
#
# paket-tunnel installer — one command on the VPS (as root):
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/admin6501/paket-tunnel/main/install.sh)
#
# It puts the repo in /opt/paket-tunnel, installs the bundled backpack binary
# for this architecture (checksum-verified, no download), and adds a
# `paket-tunnel` command that fronts the deploy scripts.
#
# Run it on BOTH servers — Iran first, then the foreign one, since the foreign
# side needs the address and token the Iran side prints.
#
# Modes are detected automatically:
#   ONLINE   run straight from GitHub; it clones the repo itself
#   OFFLINE  run from a checkout you already have — no network at all
#
# Force one:  --online | --offline
# Custom source:  REPO_URL=... REPO_BRANCH=... INSTALL_DIR=... bash install.sh
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/admin6501/paket-tunnel.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/paket-tunnel}"
DEST_CLI="/usr/local/bin/paket-tunnel"

# An update must stay on the branch that was installed. Defaulting to main and
# checking it out would silently move a server onto a different branch — which
# is a downgrade, not an update, if that is not where it was installed from.
# So remember whether the branch was actually asked for.
if [[ -n "${REPO_BRANCH:-}" ]]; then
  REPO_BRANCH_EXPLICIT=1
else
  REPO_BRANCH_EXPLICIT=0
  REPO_BRANCH=main
fi

C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YLW=$'\033[0;33m'
C_BLU=$'\033[0;34m'; C_OFF=$'\033[0m'
info() { printf '%s==>%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()   { printf '%s ok %s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s  ! %s %s\n' "$C_YLW" "$C_OFF" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

MODE="auto"
for a in "$@"; do
  case "$a" in
    --online)  MODE="online" ;;
    --offline) MODE="offline" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $a" ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "run as root:  sudo bash install.sh"

case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) : ;;
  *) die "unsupported architecture: $(uname -m) (amd64 and arm64 only)" ;;
esac

# --- find the repo files -------------------------------------------------

# Piped through `bash <(curl ...)` there is no script directory to speak of,
# which is exactly how the online path gets detected.
SELF_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]:-}" ]]; then
  if SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"; then :; else SELF_DIR=""; fi
fi

is_checkout() {
  [[ -n "$1" && -f "$1/deploy/iran-server.sh" && -f "$1/bin/install-backpack.sh" ]]
}

SRC=""
if [[ "$MODE" != "online" ]] && is_checkout "$SELF_DIR"; then
  SRC="$SELF_DIR"
  info "offline mode — using the checkout at $SRC"
elif [[ "$MODE" != "online" ]] && is_checkout "$INSTALL_DIR"; then
  SRC="$INSTALL_DIR"
  info "offline mode — using the existing install at $SRC"
elif [[ "$MODE" == "offline" ]]; then
  die "--offline was requested but no checkout was found (looked in '$SELF_DIR' and '$INSTALL_DIR')"
fi

if [[ -z "$SRC" ]]; then
  info "online mode — fetching the repo"
  command -v curl >/dev/null 2>&1 || command -v git >/dev/null 2>&1 \
    || die "need curl or git to fetch the repo"

  if command -v git >/dev/null 2>&1; then
    if [[ -d "$INSTALL_DIR/.git" ]]; then
      if [[ $REPO_BRANCH_EXPLICIT -eq 0 ]]; then
        CURRENT_BRANCH="$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
        if [[ -n "$CURRENT_BRANCH" && "$CURRENT_BRANCH" != HEAD ]]; then
          REPO_BRANCH="$CURRENT_BRANCH"
        fi
      fi
      info "updating the existing clone at $INSTALL_DIR (branch $REPO_BRANCH)"
      if ! git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_BRANCH"; then
        die "could not fetch $REPO_BRANCH — check the network, or remove $INSTALL_DIR and re-run"
      fi
      # FETCH_HEAD, not origin/<branch>: a clone made with --branch --depth 1
      # carries a refspec for that one branch only, so fetching any other
      # branch never creates its remote-tracking ref. FETCH_HEAD is always
      # what was just fetched, whatever the refspec says.
      if ! git -C "$INSTALL_DIR" checkout -q -B "$REPO_BRANCH" FETCH_HEAD; then
        die "could not check out $REPO_BRANCH — remove $INSTALL_DIR and re-run"
      fi
    else
      rm -rf "$INSTALL_DIR"
      # A shallow clone keeps this quick: the binaries in bin/ make the full
      # history a much larger download than anyone needs to install.
      git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR" \
        || die "clone failed — check the network, or install offline from a copy"
    fi
  else
    warn "git is not installed — falling back to a tarball"
    TARURL="${REPO_URL%.git}/archive/refs/heads/${REPO_BRANCH}.tar.gz"
    TMP="$(mktemp -d)"
    curl -fSL --connect-timeout 15 "$TARURL" -o "$TMP/src.tar.gz" \
      || die "download failed: $TARURL"
    tar -xzf "$TMP/src.tar.gz" -C "$TMP" || die "could not unpack the tarball"
    EXTRACTED="$(find "$TMP" -maxdepth 1 -type d -name 'paket-tunnel-*' | head -1)"
    [[ -n "$EXTRACTED" ]] || die "unexpected tarball layout"
    rm -rf "$INSTALL_DIR"
    mv "$EXTRACTED" "$INSTALL_DIR"
    rm -rf "$TMP"
  fi

  SRC="$INSTALL_DIR"
  is_checkout "$SRC" || die "the fetched copy at $SRC is missing files"
  ok "repo ready at $SRC"
fi

# Keep the canonical copy at INSTALL_DIR even when installing from elsewhere,
# so the `paket-tunnel` command has one stable place to find its scripts.
if [[ "$SRC" != "$INSTALL_DIR" ]]; then
  info "copying to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -C "$SRC" --exclude=.git -cf - . | tar -C "$INSTALL_DIR" -xf -
  SRC="$INSTALL_DIR"
fi

chmod +x "$SRC"/deploy/*.sh "$SRC"/watchdog/*.sh "$SRC"/control-channel/*.sh \
         "$SRC"/menu/*.sh "$SRC"/bin/*.sh "$SRC"/install.sh 2>/dev/null || true

# --- backpack ------------------------------------------------------------

info "installing the backpack binary"
PAKET_NO_HINT=1 "$SRC/bin/install-backpack.sh" || die "backpack install failed"

# --- the paket-tunnel command --------------------------------------------

cat >"$DEST_CLI" <<EOF
#!/usr/bin/env bash
# paket-tunnel — front end for the deploy scripts in $INSTALL_DIR
set -euo pipefail
ROOT="$INSTALL_DIR"
EOF
cat >>"$DEST_CLI" <<'EOF'

usage() {
  cat <<'USAGE'
paket-tunnel — set up and maintain the Iran <-> foreign tunnel

Run with no arguments for the interactive menu. The subcommands below are the
same thing without the prompts, for scripting.

  paket-tunnel menu              the interactive manager
  paket-tunnel iran     [args]   set up the Iran side   (server role)
  paket-tunnel kharej   [args]   set up the foreign side (client role)
  paket-tunnel watchdog [args]   install the route health watchdog
  paket-tunnel control  [args]   set up the DNS control channel
  paket-tunnel status            show what is running
  paket-tunnel logs     [name]   follow a tunnel's log (default: main)
  paket-tunnel update            pull the latest version and reinstall
  paket-tunnel backpack [args]   run backpack itself (its own menu with no args)

Add --help to any subcommand for its options, e.g.

  paket-tunnel iran --help
USAGE
}

cmd="${1:-}"; shift || true

# A stale install — one from before a file existed — should say so, not hand
# back a bare "No such file or directory" from bash.
need() {
  [[ -f "$1" ]] && return 0
  echo "missing: $1" >&2
  echo "This install predates that file. Update it with:" >&2
  echo "  paket-tunnel update" >&2
  exit 1
}

case "$cmd" in
  ""|menu)  need "$ROOT/menu/paket-menu.sh"; exec bash "$ROOT/menu/paket-menu.sh" ;;
  iran)     need "$ROOT/deploy/iran-server.sh";        exec "$ROOT/deploy/iran-server.sh" "$@" ;;
  kharej)   need "$ROOT/deploy/kharej-client.sh";      exec "$ROOT/deploy/kharej-client.sh" "$@" ;;
  watchdog) need "$ROOT/watchdog/install.sh";          exec "$ROOT/watchdog/install.sh" "$@" ;;
  control)  need "$ROOT/control-channel/setup-dnstt.sh"; exec "$ROOT/control-channel/setup-dnstt.sh" "$@" ;;
  backpack) exec /usr/local/bin/backpack "$@" ;;
  update)   exec bash "$ROOT/install.sh" --online ;;
  logs)     exec journalctl -u "backpack-${1:-main}" -f ;;
  status)
    echo "--- tunnels ---"
    systemctl list-units 'backpack-*.service' --no-pager --no-legend || true
    echo
    echo "--- control channel ---"
    systemctl is-active paket-dnstt.service 2>/dev/null || echo "not installed"
    echo
    echo "--- watchdog ---"
    systemctl is-active paket-route-health.timer 2>/dev/null || echo "not installed"
    echo
    echo "--- configs ---"
    ls -1 /etc/backpack/*.toml 2>/dev/null || echo "none yet"
    ;;
  -h|--help) usage ;;
  *) echo "unknown command: $cmd" >&2; echo >&2; usage >&2; exit 2 ;;
esac
EOF
chmod 0755 "$DEST_CLI"
ok "installed $DEST_CLI"

# --- done ----------------------------------------------------------------

cat <<EOF

$C_GRN paket-tunnel is installed.$C_OFF

  repo      $INSTALL_DIR
  backpack  $(/usr/local/bin/backpack -v 2>/dev/null || echo '?')
  command   paket-tunnel

Open the menu and pick from there:

  $C_GRN paket-tunnel$C_OFF

$C_YLW Set up the Iran server FIRST$C_OFF — the foreign side needs the token it prints.

Read first:  $INSTALL_DIR/docs/architecture.md
When it breaks:  $INSTALL_DIR/docs/blackout-playbook.md
EOF
