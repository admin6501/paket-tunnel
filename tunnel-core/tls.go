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

const alpn = "h3" // استتار به‌صورت HTTP/3

// genCert یک گواهی self-signed موقت می‌سازد (احراز هویت واقعی با -key انجام می‌شود)
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
		InsecureSkipVerify: true, // self-signed؛ امنیت با کلید مشترک تأمین می‌شود
		NextProtos:         []string{alpn},
		ServerName:         sni,
		MinVersion:         tls.VersionTLS13,
	}
}

// quicConfig — تنظیمات کلیدی برای پینگ پایین و throughput بالا در مسیر پُرتأخیر
func quicConfig() *quic.Config {
	return &quic.Config{
		MaxIdleTimeout:                 60 * time.Second,
		KeepAlivePeriod:                15 * time.Second,
		HandshakeIdleTimeout:           10 * time.Second,
		MaxIncomingStreams:             1 << 16,
		MaxIncomingUniStreams:          0,
		InitialStreamReceiveWindow:     4 * 1024 * 1024,  // 4MB
		MaxStreamReceiveWindow:         16 * 1024 * 1024, // 16MB
		InitialConnectionReceiveWindow: 8 * 1024 * 1024,  // 8MB
		MaxConnectionReceiveWindow:     64 * 1024 * 1024, // 64MB — برای BDP بالای ایران<->آلمان
		DisablePathMTUDiscovery:        false,
	}
}
