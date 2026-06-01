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

// slot یک جایگاه در استخر کانکشن‌هاست
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

// maintain هر جایگاه را همیشه متصل نگه می‌دارد (اتصال مجدد خودکار)
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
		log.Printf("استخر[%d]: متصل شد به %s", s.id, p.server)
		<-conn.Context().Done() // تا زمان قطع شدن منتظر بمان
		s.conn.Store(nil)
		s.streams.Store(0)
		log.Printf("استخر[%d]: قطع شد، اتصال مجدد...", s.id)
	}
}

func (p *pool) start() {
	for _, s := range p.slots {
		go p.maintain(s)
	}
}

// pick کم‌بارترین جایگاهِ متصل را برمی‌گرداند
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

// openStream یک استریم روی کم‌بارترین کانکشن باز می‌کند
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
	return nil, nil, errors.New("هیچ کانکشن سالمی در دسترس نیست")
}

func runClient(listen, server, key string, conns int, sni string) {
	if listen == "" || server == "" || key == "" {
		log.Fatal("client نیازمند -listen و -server و -key است")
	}
	p := newPool(server, key, conns, sni)
	p.start()

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		log.Fatalf("listen error: %v", err)
	}
	log.Printf("%s client: گوش‌دادن TCP روی %s → تانل به %s (استخر %d کانکشنی)", appName, listen, server, conns)
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
	// ارسال توکن احراز هویت
	if _, err := st.Write(p.auth); err != nil {
		_ = c.Close()
		return
	}
	pipe(st, c)
}

// pipe داده را دوطرفه بین دو سر منتقل می‌کند
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
