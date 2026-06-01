// PerseTunnel — هستهٔ تانل اختصاصی برای مسیر ایران <-> خارج
// معماری: QUIC (UDP) + استخر چند کانکشنی + پنجره‌های بزرگ + رمزنگاری TLS1.3
package main

import (
	"crypto/sha256"
	"flag"
	"fmt"
	"os"
)

const appName = "PerseTunnel"
const appVersion = "1.0.0"

// authBytes کلید مشترک را به یک توکن احراز هویت ۳۲ بایتی تبدیل می‌کند
func authBytes(key string) []byte {
	h := sha256.Sum256([]byte(appName + "|v1|" + key))
	return h[:]
}

func usage() {
	fmt.Printf(`%s %s — تانل اختصاصی QUIC

حالت سرور خارج (Exit):
  persetunnel server -listen :443 -forward 127.0.0.1:8080 -key SECRET

حالت سرور ایران (Entry):
  persetunnel client -listen :8443 -server DE_IP:443 -key SECRET -conns 4

پارامترها:
  -listen   آدرس گوش‌دادن (server: UDP تانل | client: TCP محلی کاربران)
  -forward  (server) سرویس مقصد روی سرور خارج، مثل 127.0.0.1:8080
  -server   (client) آدرس سرور خارج، مثل 1.2.3.4:443
  -key      کلید/رمز مشترک بین دو سرور
  -conns    (client) تعداد کانکشن‌های موازی در استخر [پیش‌فرض 4]
  -sni      (client) نام دامنهٔ ظاهری برای استتار TLS [پیش‌فرض www.bing.com]
`, appName, appVersion)
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
