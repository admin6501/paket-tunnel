#!/usr/bin/env bash
# Regression test for the plain-text (whiptail-free) menu of spoof-tunnel.sh.
#
# Verifies:
#   (a) main menu renders 0-11 options + status line
#   (b) option 7 (live status) renders Role/Carrier/Tunnel IPs and returns to menu
#   (c) option 4 (carrier) sub-menu -> selecting UDP writes CARRIER="udp" to config
#   (d) invalid option prints 'گزینه نامعتبر' error and re-shows menu
#   (e) option 0 exits with rc 0
#   (f) regression: config with PUB_IFACE still lets script reach menu

SCRIPT="/app/scripts/spoof-tunnel.sh"
CONF_DIR="/etc/spoof-tunnel"
CONF_FILE="${CONF_DIR}/config"

[[ -f "$SCRIPT" ]] || { echo "MISSING: $SCRIPT"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Must run as root"; exit 1; }

# Backup any existing config
BACKUP=""
if [[ -f "$CONF_FILE" ]]; then
  BACKUP="$(mktemp)"
  cp "$CONF_FILE" "$BACKUP"
fi
rm -f "$CONF_FILE"

FAIL=0
pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; FAIL=1; }

# Strip ANSI color codes for grep-friendly output
strip_ansi() { sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\x1b[()][A-Za-z0-9]//g'; }

# --------------------------------------------------------------------
# Phase 1: main menu renders (option 0 exits immediately)
# --------------------------------------------------------------------
echo "== Phase 1: menu renders + option 0 exits rc 0 =="
OUT=$(printf '0\n' | bash "$SCRIPT" 2>&1 | strip_ansi); RC=${PIPESTATUS[1]}
if [[ $RC -eq 0 ]]; then pass "option 0 -> rc=0"; else fail "option 0 -> rc=$RC"; fi
# check menu content
missing_opts=()
for kw in \
    "SPOOF-TUNNEL" \
    "1)" "2)" "3)" "4)" "5)" "6)" "7)" "8)" "9)" "10)" "11)" "0)" ; do
  echo "$OUT" | grep -Fq "$kw" || missing_opts+=("$kw")
done
if (( ${#missing_opts[@]} == 0 )); then
  pass "menu shows all 0-11 options and banner"
else
  fail "menu missing tokens: ${missing_opts[*]}"
  echo "----- captured output -----"; echo "$OUT" | head -40; echo "---------------------------"
fi

# --------------------------------------------------------------------
# Phase 2: option 7 (Live status) renders and returns to menu
# --------------------------------------------------------------------
echo "== Phase 2: option 7 -> status screen -> back to menu -> exit =="
OUT=$(printf '7\n\n0\n' | bash "$SCRIPT" 2>&1 | strip_ansi); RC=${PIPESTATUS[1]}
if [[ $RC -eq 0 ]]; then pass "path '7,Enter,0' -> rc=0"; else fail "rc=$RC"; fi

status_kw=("Role:" "Carrier:" "Peer public:" "Spoof source:" "Tunnel IPs:" "spooftun:" "watchdog:" "wireguard:")
missing=()
for kw in "${status_kw[@]}"; do
  echo "$OUT" | grep -Fq "$kw" || missing+=("$kw")
done
if (( ${#missing[@]} == 0 )); then
  pass "status screen shows Role/Carrier/Peer/Tunnel IPs/systemd states"
else
  fail "status screen missing: ${missing[*]}"
fi

# menu must have been rendered TWICE (once initially, once after option 7 returns)
menu_count=$(echo "$OUT" | grep -c "شماره گزینه" || true)
if (( menu_count >= 2 )); then
  pass "menu re-rendered after option 7 (${menu_count} prompts)"
else
  fail "menu prompt count = ${menu_count} (expected >=2)"
fi

# --------------------------------------------------------------------
# Phase 3: option 4 (carrier) -> select UDP writes CARRIER="udp"
# --------------------------------------------------------------------
echo "== Phase 3: option 4 -> choose UDP -> config gets CARRIER=\"udp\" =="
rm -f "$CONF_FILE"
# Input: 4 (carrier), 1 (UDP), Enter (accept default port), Enter (pause), 0 (exit)
OUT=$(printf '4\n1\n\n\n0\n' | bash "$SCRIPT" 2>&1 | strip_ansi); RC=${PIPESTATUS[1]}
if [[ $RC -eq 0 ]]; then pass "path '4,1,Enter,Enter,0' -> rc=0"; else fail "rc=$RC"; fi
if [[ -f "$CONF_FILE" ]]; then
  pass "config file created at $CONF_FILE"
  if grep -q '^CARRIER="udp"' "$CONF_FILE"; then
    pass 'CARRIER="udp" written to config'
  else
    fail "CARRIER=udp not in config; got: $(grep ^CARRIER $CONF_FILE || echo none)"
  fi
else
  fail "config file was NOT created"
fi

# --------------------------------------------------------------------
# Phase 4: invalid option '99' prints error and re-shows menu
# --------------------------------------------------------------------
echo "== Phase 4: invalid option '99' -> error message + menu again =="
OUT=$(printf '99\n0\n' | bash "$SCRIPT" 2>&1 | strip_ansi); RC=${PIPESTATUS[1]}
if [[ $RC -eq 0 ]]; then pass "path '99,0' -> rc=0"; else fail "rc=$RC"; fi
if echo "$OUT" | grep -Fq "گزینه نامعتبر"; then
  pass "invalid option error message shown"
else
  fail "invalid option error message NOT shown"
  echo "$OUT" | tail -20
fi
menu_count=$(echo "$OUT" | grep -c "شماره گزینه" || true)
if (( menu_count >= 2 )); then
  pass "menu re-shown after invalid input (${menu_count} prompts)"
else
  fail "menu prompt count = ${menu_count}"
fi

# --------------------------------------------------------------------
# Phase 5: regression -- config with PUB_IFACE still lets script reach menu
# --------------------------------------------------------------------
echo "== Phase 5: regression -- pre-existing config w/ PUB_IFACE reaches menu =="
mkdir -p "$CONF_DIR"
cat > "$CONF_FILE" <<'EOF'
ROLE="relay"
CARRIER="udp"
PEER_PUBLIC_IP="203.0.113.5"
SPOOF_SRC="198.51.100.7"
WG_LOCAL_IP="10.20.20.1"
WG_PEER_IP="10.20.20.2"
WG_SUBNET="10.20.20.0/24"
WG_PORT="51820"
LOCAL_PORT="51821"
CARRIER_PORT="8443"
MAGIC="0x53504f46"
MTU="1280"
PUB_IFACE="eth0"
WG_PRIV=""
WG_PUB=""
PEER_WG_PUB=""
FWD_PORTS=""
EOF
chmod 600 "$CONF_FILE"
OUT=$(printf '0\n' | bash "$SCRIPT" 2>&1 | strip_ansi); RC=${PIPESTATUS[1]}
if [[ $RC -eq 0 ]] && echo "$OUT" | grep -Fq "SPOOF-TUNNEL" && echo "$OUT" | grep -Fq "[relay]"; then
  pass "with PUB_IFACE config present, menu renders and shows [relay] status"
else
  fail "regression: menu did not render or ROLE not applied (rc=$RC)"
  echo "$OUT" | head -20
fi

# --------------------------------------------------------------------
# Phase 6: no functional whiptail invocation in the manager script
# --------------------------------------------------------------------
echo "== Phase 6: no functional 'whiptail' invocation in manager =="
# Non-comment lines mentioning whiptail
bad=$(grep -n whiptail "$SCRIPT" | grep -Ev '^\s*[0-9]+:\s*#' | grep -v "no whiptail" || true)
if [[ -z "$bad" ]]; then
  pass "whiptail appears only in comments in spoof-tunnel.sh"
else
  fail "whiptail still referenced as code:"
  echo "$bad"
fi

# --------------------------------------------------------------------
# Cleanup
# --------------------------------------------------------------------
rm -f "$CONF_FILE"
rmdir "$CONF_DIR" 2>/dev/null || true
if [[ -n "$BACKUP" ]]; then
  mkdir -p "$CONF_DIR"
  cp "$BACKUP" "$CONF_FILE"
  rm -f "$BACKUP"
fi

if (( FAIL == 0 )); then
  echo "ALL_PHASES_PASSED"; exit 0
else
  echo "SOME_PHASES_FAILED"; exit 1
fi
