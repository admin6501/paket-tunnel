#!/usr/bin/env bash
# =============================================================================
#  PerseTunnel — نصب‌کنندهٔ خودکار هستهٔ تانل اختصاصی (QUIC + Connection Pool)
# -----------------------------------------------------------------------------
#  مخصوص مسیر ایران <-> خارج با تمرکز بر:
#    - پینگ پایین و پایدار زیر بار سنگین (بدون TCP-over-TCP و بدون HOL blocking)
#    - throughput بالا (پنجره‌های بزرگ برای BDP بالای ایران<->آلمان)
#    - مصرف CPU پایین (بدون FEC؛ فقط loss-recovery خودِ QUIC)
#    - استخر چند کانکشنی برای پخش بار و عدم فروپاشی زیر مشتری سنگین
#
#  این اسکریپت کاملاً خودکفاست: سورس را در خود دارد، Go را نصب می‌کند،
#  باینری را می‌سازد و سرویس systemd + تیونینگ کرنل را راه‌اندازی می‌کند.
#
#  پشتیبانی: Ubuntu / Debian   |   معماری: amd64 / arm64
#  اجرا:  sudo bash install.sh
# =============================================================================

set -euo pipefail

BIN="/usr/local/bin/persetunnel"
SRC_DIR="/opt/persetunnel/src"
CONF_DIR="/etc/persetunnel"
RUN_SCRIPT="${CONF_DIR}/run.sh"
INFO_FILE="${CONF_DIR}/info.conf"
SERVICE_NAME="persetunnel"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SYSCTL_FILE="/etc/sysctl.d/99-persetunnel.conf"
LIMITS_FILE="/etc/security/limits.d/99-persetunnel.conf"
GO_MIN="1.21"
GO_ROOT="/usr/local/go"
GO="${GO_ROOT}/bin/go"

RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLU=$'\e[36m'; BLD=$'\e[1m'; RST=$'\e[0m'
msg(){ echo -e "${BLU}[*]${RST} $*"; }
ok(){ echo -e "${GRN}[✓]${RST} $*"; }
warn(){ echo -e "${YLW}[!]${RST} $*"; }
err(){ echo -e "${RED}[x]${RST} $*" >&2; }
line(){ echo -e "${BLD}--------------------------------------------------------------${RST}"; }

need_root(){ [[ "${EUID}" -eq 0 ]] || { err "با sudo اجرا کن: sudo bash install.sh"; exit 1; }; }

detect_arch(){
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) err "معماری پشتیبانی‌نشده: $(uname -m)"; exit 1 ;;
  esac
}

ensure_tools(){
  local pkgs=()
  command -v curl >/dev/null 2>&1 || pkgs+=(curl)
  command -v tar  >/dev/null 2>&1 || pkgs+=(tar)
  if [[ ${#pkgs[@]} -gt 0 ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y "${pkgs[@]}" >/dev/null 2>&1 || true
  fi
}

rand_str(){
  local n="${1:-16}" out=""
  while [[ "${#out}" -lt "$n" ]]; do
    out+="$(LC_ALL=C tr -dc 'a-zA-Z0-9' < <(head -c 64 /dev/urandom))"
  done
  printf '%s' "${out:0:n}"
}

# ------------------------------ نصب Go --------------------------------------
install_go(){
  if [[ -x "$GO" ]]; then ok "Go موجود است: $($GO version)"; return; fi
  if command -v go >/dev/null 2>&1; then GO="$(command -v go)"; ok "Go سیستمی: $($GO version)"; return; fi
  local arch ver; arch="$(detect_arch)"
  msg "دریافت آخرین نسخهٔ Go برای linux/${arch} ..."
  ver="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)"
  [[ -z "$ver" ]] && { err "دریافت نسخهٔ Go ناموفق بود."; exit 1; }
  curl -fSL "https://go.dev/dl/${ver}.linux-${arch}.tar.gz" -o /tmp/go.tar.gz
  rm -rf "$GO_ROOT"; tar -C /usr/local -xzf /tmp/go.tar.gz; rm -f /tmp/go.tar.gz
  echo 'export PATH=$PATH:/usr/local/go/bin' > /etc/profile.d/go.sh
  ok "Go نصب شد: $($GO version)"
}

# --------------------------- نوشتن سورس و بیلد -------------------------------
write_source(){
  mkdir -p "$SRC_DIR"

  cat > "${SRC_DIR}/go.mod" <<'GOEOF'
module persetunnel

go 1.21

require github.com/quic-go/quic-go v0.59.1
GOEOF

  cat > "${SRC_DIR}/main.go" <<'GOEOF'
package main

import (
	"crypto/sha256"
	"flag"
	"fmt"
	"os"
)

const appName = "PerseTunnel"
const appVersion = "1.0.0"

func authBytes(key string) []byte {
	h := sha256.Sum256([]byte(appName + "|v1|" + key))
	return h[:]
}

func usage() {
	fmt.Printf("%s %s — tunnel\n", appName, appVersion)
	fmt.Println("server: persetunnel server -listen :443 -forward 127.0.0.1:8080 -key SECRET")
	fmt.Println("client: persetunnel client -listen :8443 -server IP:443 -key SECRET -conns 4")
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	mode := os.Args[1]
	fs := flag.NewFlagSet(mode, flag.ExitOnError)
	listen := fs.String("listen", "", "")
	forward := fs.String("forward", "", "")
	server := fs.String("server", "", "")
	key := fs.String("key", "", "")
	conns := fs.Int("conns", 4, "")
	sni := fs.String("sni", "www.bing.com", "")
	_ = fs.Parse(os.Args[2:])

	switch mode {
	case "server":
		runServer(*listen, *forward, *key)
	case "client":
		runClient(*listen, *server, *key, *conns, *sni)
	case "version", "-v", "--version":
		fmt.Printf("%s %s\n", appName, appVersion)
	default:
		usage()
	}
}
GOEOF

  cat > "${SRC_DIR}/tls.go" <<'GOEOF'
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"time"

	"github.com/quic-go/quic-go"
)

const alpn = "h3"

func genCert(cn string) tls.Certificate {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		panic(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}
}

func serverTLS() *tls.Config {
	return &tls.Config{
		Certificates: []tls.Certificate{genCert("tunnel")},
		NextProtos:   []string{alpn},
		MinVersion:   tls.VersionTLS13,
	}
}

func clientTLS(sni string) *tls.Config {
	return &tls.Config{
		InsecureSkipVerify: true,
		NextProtos:         []string{alpn},
		ServerName:         sni,
		MinVersion:         tls.VersionTLS13,
	}
}

func quicConfig() *quic.Config {
	return &quic.Config{
		MaxIdleTimeout:                 60 * time.Second,
		KeepAlivePeriod:                15 * time.Second,
		HandshakeIdleTimeout:           10 * time.Second,
		MaxIncomingStreams:             1 << 16,
		MaxIncomingUniStreams:          0,
		InitialStreamReceiveWindow:     4 * 1024 * 1024,
		MaxStreamReceiveWindow:         16 * 1024 * 1024,
		InitialConnectionReceiveWindow: 8 * 1024 * 1024,
		MaxConnectionReceiveWindow:     64 * 1024 * 1024,
		DisablePathMTUDiscovery:        false,
	}
}
GOEOF

  cat > "${SRC_DIR}/server.go" <<'GOEOF'
package main

import (
	"context"
	"crypto/subtle"
	"io"
	"log"
	"net"
	"time"

	"github.com/quic-go/quic-go"
)

func runServer(listen, forward, key string) {
	if listen == "" || forward == "" || key == "" {
		log.Fatal("server needs -listen -forward -key")
	}
	ln, err := quic.ListenAddr(listen, serverTLS(), quicConfig())
	if err != nil {
		log.Fatalf("listen error: %v", err)
	}
	auth := authBytes(key)
	log.Printf("%s server: listening %s (UDP) -> forward %s", appName, listen, forward)
	for {
		conn, err := ln.Accept(context.Background())
		if err != nil {
			log.Printf("accept conn error: %v", err)
			continue
		}
		go serveConn(conn, forward, auth)
	}
}

func serveConn(conn *quic.Conn, forward string, auth []byte) {
	for {
		st, err := conn.AcceptStream(context.Background())
		if err != nil {
			return
		}
		go serveStream(st, forward, auth)
	}
}

func serveStream(st *quic.Stream, forward string, auth []byte) {
	hdr := make([]byte, 32)
	_ = st.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.ReadFull(st, hdr); err != nil {
		_ = st.Close()
		return
	}
	if subtle.ConstantTimeCompare(hdr, auth) != 1 {
		st.CancelRead(1)
		st.CancelWrite(1)
		return
	}
	_ = st.SetReadDeadline(time.Time{})

	target, err := net.DialTimeout("tcp", forward, 10*time.Second)
	if err != nil {
		st.CancelRead(2)
		st.CancelWrite(2)
		return
	}
	pipe(st, target)
}
GOEOF

  cat > "${SRC_DIR}/client.go" <<'GOEOF'
package main

import (
	"context"
	"errors"
	"io"
	"log"
	"math"
	"net"
	"sync/atomic"
	"time"

	"github.com/quic-go/quic-go"
)

type slot struct {
	id      int
	conn    atomic.Pointer[quic.Conn]
	streams atomic.Int64
}

type pool struct {
	server string
	sni    string
	auth   []byte
	slots  []*slot
}

func newPool(server, key string, n int, sni string) *pool {
	if n < 1 {
		n = 1
	}
	p := &pool{server: server, sni: sni, auth: authBytes(key)}
	for i := 0; i < n; i++ {
		p.slots = append(p.slots, &slot{id: i})
	}
	return p
}

func (p *pool) maintain(s *slot) {
	backoff := time.Second
	for {
		conn, err := quic.DialAddr(context.Background(), p.server, clientTLS(p.sni), quicConfig())
		if err != nil {
			time.Sleep(backoff)
			if backoff < 10*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		s.conn.Store(conn)
		log.Printf("pool[%d]: connected to %s", s.id, p.server)
		<-conn.Context().Done()
		s.conn.Store(nil)
		s.streams.Store(0)
		log.Printf("pool[%d]: disconnected, reconnecting...", s.id)
	}
}

func (p *pool) start() {
	for _, s := range p.slots {
		go p.maintain(s)
	}
}

func (p *pool) pick() *slot {
	var best *slot
	var bestN int64 = math.MaxInt64
	for _, s := range p.slots {
		if s.conn.Load() == nil {
			continue
		}
		if n := s.streams.Load(); n < bestN {
			bestN = n
			best = s
		}
	}
	return best
}

func (p *pool) openStream() (*quic.Stream, *slot, error) {
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		s := p.pick()
		if s == nil {
			time.Sleep(80 * time.Millisecond)
			continue
		}
		conn := s.conn.Load()
		if conn == nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		st, err := conn.OpenStreamSync(ctx)
		cancel()
		if err != nil {
			conn.CloseWithError(0, "reopen")
			s.conn.CompareAndSwap(conn, nil)
			continue
		}
		s.streams.Add(1)
		return st, s, nil
	}
	return nil, nil, errors.New("no healthy connection")
}

func runClient(listen, server, key string, conns int, sni string) {
	if listen == "" || server == "" || key == "" {
		log.Fatal("client needs -listen -server -key")
	}
	p := newPool(server, key, conns, sni)
	p.start()
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		log.Fatalf("listen error: %v", err)
	}
	log.Printf("%s client: TCP %s -> tunnel %s (pool %d)", appName, listen, server, conns)
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go p.handle(c)
	}
}

func (p *pool) handle(c net.Conn) {
	st, s, err := p.openStream()
	if err != nil {
		_ = c.Close()
		return
	}
	defer func() {
		_ = st.Close()
		s.streams.Add(-1)
	}()
	if _, err := st.Write(p.auth); err != nil {
		_ = c.Close()
		return
	}
	pipe(st, c)
}

func pipe(a, b io.ReadWriteCloser) {
	done := make(chan struct{}, 2)
	cp := func(dst io.Writer, src io.Reader) {
		buf := make([]byte, 32*1024)
		_, _ = io.CopyBuffer(dst, src, buf)
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	_ = a.Close()
	_ = b.Close()
	<-done
}
GOEOF
  ok "سورس نوشته شد در ${SRC_DIR}"
}

build_bin(){
  if [[ -x "$BIN" ]] && "$BIN" version >/dev/null 2>&1; then
    ok "باینری از قبل ساخته شده: $($BIN version)"
    return
  fi
  msg "ساخت باینری (ممکن است ۳۰ تا ۹۰ ثانیه طول بکشد)..."
  export GOPROXY="https://goproxy.io,https://proxy.golang.org,direct"
  export GOSUMDB=off GO111MODULE=on GOFLAGS=-mod=mod
  ( cd "$SRC_DIR" && "$GO" mod tidy >/tmp/gobuild.log 2>&1 && "$GO" build -ldflags "-s -w" -o "$BIN" . >>/tmp/gobuild.log 2>&1 ) || {
    err "ساخت باینری ناموفق بود. لاگ:"; tail -n 20 /tmp/gobuild.log; exit 1;
  }
  ok "باینری ساخته شد: $($BIN version)"
}

# --------------------------- تیونینگ سیستم -----------------------------------
tune_system(){
  msg "اعمال تیونینگ کرنل (BBR + بافرهای بزرگ UDP برای QUIC) ..."
  cat > "$SYSCTL_FILE" <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
# بافرهای بزرگ (مخصوصاً UDP برای QUIC و BDP بالا)
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216
net.core.netdev_max_backlog = 250000
net.core.somaxconn = 65535
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_slow_start_after_idle = 0
fs.file-max = 1048576
EOF
  modprobe tcp_bbr 2>/dev/null || true
  sysctl --system >/dev/null 2>&1 || true
  cat > "$LIMITS_FILE" <<'EOF'
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF
  local cc; cc="$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo ?)"
  [[ "$cc" == "bbr" ]] && ok "BBR فعال شد" || warn "BBR فعال نشد (مقدار: $cc) — تانل بدون آن هم کار می‌کند."
}

# ------------------------- توکن (انتقال آسان تنظیمات) ------------------------
# token v2 = base64(  v2|PORT|KEY|SNI  )
make_token(){ printf 'v2|%s|%s|%s' "$1" "$2" "$3" | base64 -w0; }

write_run(){ mkdir -p "$CONF_DIR"; printf '#!/usr/bin/env bash\nexec %s %s\n' "$BIN" "$1" > "$RUN_SCRIPT"; chmod +x "$RUN_SCRIPT"; }

create_service(){
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=PerseTunnel (Iran <-> Foreign, QUIC pool)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${RUN_SCRIPT}
Restart=always
RestartSec=3
LimitNOFILE=1048576
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "سرویس $SERVICE_NAME فعال شد و در بوت بعدی هم بالا می‌آید."
  else
    err "سرویس اجرا نشد. لاگ: journalctl -u $SERVICE_NAME -n 50 --no-pager"
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true
  fi
}

prepare(){ ensure_tools; install_go; write_source; build_bin; tune_system; }

# --------------------------- نصب سرور خارج -----------------------------------
install_foreign(){
  line; echo -e "${BLD}نصب روی «سرور خارج» (Exit / محل سرویس اصلی)${RST}"; line
  read -rp "پورت تانل (UDP) روی سرور خارج [443]: " PORT; PORT="${PORT:-443}"
  read -rp "هاست سرویس داخلی [127.0.0.1]: " SVCHOST; SVCHOST="${SVCHOST:-127.0.0.1}"
  read -rp "پورت سرویس اصلی که تانل می‌شود (مثلاً پنل/SSH): " SVCPORT
  while ! [[ "$SVCPORT" =~ ^[0-9]+$ ]]; do read -rp "یک پورت معتبر وارد کن: " SVCPORT; done
  read -rp "نام دامنهٔ ظاهری برای استتار TLS (SNI) [www.bing.com]: " SNI; SNI="${SNI:-www.bing.com}"
  local KEY; KEY="$(rand_str 24)"

  prepare
  write_run "server -listen :${PORT} -forward ${SVCHOST}:${SVCPORT} -key ${KEY}"
  mkdir -p "$CONF_DIR"
  cat > "$INFO_FILE" <<EOF
ROLE=foreign
PORT=${PORT}
KEY=${KEY}
SNI=${SNI}
SVCHOST=${SVCHOST}
SVCPORT=${SVCPORT}
EOF
  create_service
  local TOKEN; TOKEN="$(make_token "$PORT" "$KEY" "$SNI")"
  echo; line; ok "نصب سرور خارج کامل شد."
  echo -e "${BLD}توکن اتصال (در سرور ایران وارد کن):${RST}"
  echo -e "${GRN}${TOKEN}${RST}"; line
  echo -e "${YLW}مهم:${RST} پورت ${PORT} را روی ${BLD}UDP${RST} در فایروال و پنل ابری باز کن:"
  echo "  ufw allow ${PORT}/udp"
}

# --------------------------- نصب سرور ایران ----------------------------------
install_iran(){
  line; echo -e "${BLD}نصب روی «سرور ایران» (Entry / نقطه ورود کاربران)${RST}"; line
  read -rp "آی‌پی/دامنهٔ سرور خارج: " FOREIGN
  while [[ -z "${FOREIGN:-}" ]]; do read -rp "آدرس سرور خارج: " FOREIGN; done
  read -rp "توکن اتصال (از سرور خارج): " TOKEN
  while [[ -z "${TOKEN:-}" ]]; do read -rp "توکن: " TOKEN; done
  local DEC; DEC="$(echo "$TOKEN" | base64 -d 2>/dev/null || true)"
  IFS='|' read -r VER PORT KEY SNI <<< "$DEC"
  [[ "${VER:-}" == "v2" && -n "${PORT:-}" ]] || { err "توکن نامعتبر است."; exit 1; }
  read -rp "پورت محلی روی سرور ایران که کاربران به آن وصل می‌شوند: " LPORT
  while ! [[ "$LPORT" =~ ^[0-9]+$ ]]; do read -rp "یک پورت معتبر وارد کن: " LPORT; done
  read -rp "تعداد کانکشن موازی استخر [4]: " CONNS; CONNS="${CONNS:-4}"

  prepare
  write_run "client -listen :${LPORT} -server ${FOREIGN}:${PORT} -key ${KEY} -conns ${CONNS} -sni ${SNI}"
  mkdir -p "$CONF_DIR"
  cat > "$INFO_FILE" <<EOF
ROLE=iran
FOREIGN=${FOREIGN}
PORT=${PORT}
LPORT=${LPORT}
CONNS=${CONNS}
SNI=${SNI}
EOF
  create_service
  echo; line; ok "نصب سرور ایران کامل شد."
  echo "کاربران به  ${BLD}IP_سرور_ایران:${LPORT}${RST}  وصل می‌شوند."
  echo "پورت محلی را باز کن:  ufw allow ${LPORT}/tcp"; line
}

show_status(){
  line; [[ -f "$INFO_FILE" ]] && { echo -e "${BLD}پیکربندی:${RST}"; cat "$INFO_FILE"; line; }
  systemctl status "$SERVICE_NAME" --no-pager 2>/dev/null || warn "سرویس نصب نشده."
  line; echo "لاگ‌ها:"; journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true
}
restart_service(){ systemctl restart "$SERVICE_NAME" && ok "ری‌استارت شد."; }
show_token(){
  [[ -f "$INFO_FILE" ]] || { err "اطلاعاتی نیست."; return; }
  # shellcheck disable=SC1090
  source "$INFO_FILE"
  [[ "${ROLE:-}" == "foreign" ]] || { err "توکن فقط روی سرور خارج ساخته می‌شود."; return; }
  echo -e "${GRN}$(make_token "$PORT" "$KEY" "$SNI")${RST}"
}
uninstall_all(){
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$SERVICE_FILE"; systemctl daemon-reload 2>/dev/null || true
  rm -rf "$CONF_DIR" "$SYSCTL_FILE" "$LIMITS_FILE"
  read -rp "باینری و سورس هم حذف شود؟ [y/N]: " d
  [[ "${d,,}" == "y" ]] && rm -rf "$BIN" "$SRC_DIR"
  ok "حذف شد."
}

banner(){
  clear || true
  echo -e "${BLD}${BLU}"
  echo "  ╔══════════════════════════════════════════════════╗"
  echo "  ║   PerseTunnel — هستهٔ تانل اختصاصی QUIC + Pool      ║"
  echo "  ║   پینگ پایدار و سرعت بالا زیر بار سنگین (IR<->DE)   ║"
  echo "  ╚══════════════════════════════════════════════════╝"
  echo -e "${RST}"
}

menu(){
  banner
  echo "  1) نصب روی سرور خارج  (Exit)"
  echo "  2) نصب روی سرور ایران (Entry)"
  echo "  3) وضعیت و لاگ"
  echo "  4) ری‌استارت"
  echo "  5) نمایش توکن (سرور خارج)"
  echo "  6) حذف کامل"
  echo "  0) خروج"; echo
  read -rp "انتخاب: " ch
  case "$ch" in
    1) install_foreign ;; 2) install_iran ;;
    3) show_status ;; 4) restart_service ;;
    5) show_token ;; 6) uninstall_all ;;
    0) exit 0 ;; *) warn "نامعتبر." ;;
  esac
}

main(){
  need_root
  if [[ $# -gt 0 ]]; then
    case "$1" in
      foreign|server) install_foreign ;;
      iran|client) install_iran ;;
      status) show_status ;;
      restart) restart_service ;;
      token) show_token ;;
      uninstall|remove) uninstall_all ;;
      *) echo "usage: bash install.sh [foreign|iran|status|restart|token|uninstall]" ;;
    esac
  else
    menu
  fi
}
main "$@"
