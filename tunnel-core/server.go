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
		log.Fatal("server نیازمند -listen و -forward و -key است")
	}
	ln, err := quic.ListenAddr(listen, serverTLS(), quicConfig())
	if err != nil {
		log.Fatalf("listen error: %v", err)
	}
	auth := authBytes(key)
	log.Printf("%s server: گوش‌دادن روی %s (UDP) → فوروارد به %s", appName, listen, forward)
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
			return // کانکشن بسته شد
		}
		go serveStream(st, forward, auth)
	}
}

func serveStream(st *quic.Stream, forward string, auth []byte) {
	// خواندن توکن احراز هویت ۳۲ بایتی با مهلت
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
	_ = st.SetReadDeadline(time.Time{}) // حذف مهلت

	target, err := net.DialTimeout("tcp", forward, 10*time.Second)
	if err != nil {
		st.CancelRead(2)
		st.CancelWrite(2)
		return
	}
	pipe(st, target)
}
