/*
 * spooftun - Spoof-Tunnel core (pure C)
 * -------------------------------------
 * A low-level userspace pipe that carries WireGuard UDP traffic inside
 * source-spoofed ICMP or UDP carrier packets, in order to traverse a
 * whitelist-based national gateway.
 *
 * Data path (run mode):
 *   WireGuard (ListenPort=WGPORT, Endpoint=127.0.0.1:LPORT)
 *        |  sends UDP  ->  127.0.0.1:LPORT   (this daemon, "local" socket)
 *        v
 *   spooftun  --(encapsulate + spoof source IP)-->  raw AF_INET socket
 *        |                                             |
 *        |                                             v
 *        |                                        national gateway  --> peer public IP
 *        v
 *   spooftun (peer)  --(AF_PACKET RX + decapsulate)--> 127.0.0.1:WGPORT (peer WireGuard)
 *
 * Both endpoints are symmetric and both spoof their source IP.
 *
 * Subcommands:
 *   run          - main bidirectional tunnel
 *   probe-listen - Spoof-Tester receiver: prints claimed source IPs that arrived
 *   probe-send   - Spoof-Tester sender: emits spoofed probes announcing a candidate IP
 *
 * NOTE: Requires root (CAP_NET_RAW). Requires rp_filter=0 on the RX side.
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#include <pthread.h>
#include <getopt.h>

#include <sys/socket.h>
#include <sys/ioctl.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/udp.h>
#include <netinet/ip_icmp.h>
#include <net/if.h>
#include <netpacket/packet.h>
#include <net/ethernet.h>
#include <linux/filter.h>

#define BUF_SZ        65536
#define MAGIC_LEN     4
#define PROBE_MAGIC   0x50524f42u   /* "PROB" */

/* ------------------------------------------------------------------ */
/* Global config                                                       */
/* ------------------------------------------------------------------ */
typedef enum { CARRIER_UDP = 0, CARRIER_ICMP = 1 } carrier_t;

static struct {
    carrier_t carrier;
    char      peer_ip[64];       /* peer public IP (real destination)     */
    char      spoof_src[64];     /* whitelisted source IP we impersonate  */
    char      pub_iface[IFNAMSIZ];
    uint16_t  local_port;        /* daemon UDP port (WireGuard endpoint)  */
    uint16_t  wg_port;           /* WireGuard ListenPort (delivery target)*/
    uint16_t  carrier_port;      /* UDP carrier port                      */
    uint32_t  magic;             /* tunnel identifier tag                 */
    int       verbose;
} cfg;

static volatile sig_atomic_t running = 1;

/* traffic stats */
static volatile unsigned long long tx_pkts = 0, tx_bytes = 0;
static volatile unsigned long long rx_pkts = 0, rx_bytes = 0;

static int  raw_tx_fd = -1;   /* AF_INET SOCK_RAW, IP_HDRINCL           */
static int  pkt_rx_fd = -1;   /* AF_PACKET SOCK_DGRAM                    */
static int  local_fd  = -1;   /* UDP socket bound to 127.0.0.1:LPORT     */

static struct sockaddr_in peer_addr;   /* real peer public IP            */
static struct sockaddr_in wg_addr;     /* 127.0.0.1:WGPORT (deliver here) */

static void on_signal(int s) { (void)s; running = 0; }

/* ------------------------------------------------------------------ */
/* Checksums                                                           */
/* ------------------------------------------------------------------ */
static uint16_t checksum16(const void *data, size_t len)
{
    const uint16_t *p = data;
    uint32_t sum = 0;
    while (len > 1) { sum += *p++; len -= 2; }
    if (len == 1) sum += *(const uint8_t *)p;
    while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
    return (uint16_t)(~sum);
}

/* ------------------------------------------------------------------ */
/* BPF: accept only IP packets whose protocol == want (UDP/ICMP).      */
/* AF_PACKET SOCK_DGRAM strips the link layer, so offset 0 = IP header. */
/* ------------------------------------------------------------------ */
static int attach_proto_filter(int fd, uint8_t proto)
{
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD  + BPF_B + BPF_ABS, 9),          /* A = ip.proto      */
        BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, proto, 0, 1),/* if != proto reject */
        BPF_STMT(BPF_RET + BPF_K, 0xffffffff),           /* accept            */
        BPF_STMT(BPF_RET + BPF_K, 0),                    /* reject            */
    };
    struct sock_fprog prog = { .len = 4, .filter = code };
    return setsockopt(fd, SOL_SOCKET, SO_ATTACH_FILTER, &prog, sizeof(prog));
}

/* ------------------------------------------------------------------ */
/* Build an IPv4 header with a spoofed source address.                 */
/* ------------------------------------------------------------------ */
static void build_ip_header(struct iphdr *ip, uint16_t payload_len, uint8_t proto)
{
    ip->version  = 4;
    ip->ihl      = 5;
    ip->tos      = 0;
    ip->tot_len  = htons(sizeof(struct iphdr) + payload_len);
    ip->id       = htons((uint16_t)(rand() & 0xffff));
    ip->frag_off = 0;
    ip->ttl      = 64;
    ip->protocol = proto;
    ip->check    = 0;
    ip->saddr    = inet_addr(cfg.spoof_src);
    ip->daddr    = peer_addr.sin_addr.s_addr;
    ip->check    = checksum16(ip, sizeof(struct iphdr));
}

/* ------------------------------------------------------------------ */
/* Transmit one encapsulated payload towards the peer (spoofed).       */
/* magic_tag lets probe mode override the run-mode tunnel magic.       */
/* ------------------------------------------------------------------ */
static int carrier_send(const uint8_t *payload, size_t plen, uint32_t magic_tag)
{
    static uint16_t seq_ctr = 0;
    uint8_t pkt[BUF_SZ];
    struct iphdr *ip = (struct iphdr *)pkt;
    uint32_t net_magic = htonl(magic_tag);
    size_t total;

    if (cfg.carrier == CARRIER_UDP) {
        struct udphdr *udp = (struct udphdr *)(pkt + sizeof(struct iphdr));
        uint8_t *body = (uint8_t *)udp + sizeof(struct udphdr);
        uint16_t ulen = (uint16_t)(sizeof(struct udphdr) + MAGIC_LEN + plen);

        build_ip_header(ip, ulen, IPPROTO_UDP);
        udp->source = htons(cfg.carrier_port);
        udp->dest   = htons(cfg.carrier_port);
        udp->len    = htons(ulen);
        udp->check  = 0;                 /* optional for IPv4 */
        memcpy(body, &net_magic, MAGIC_LEN);
        memcpy(body + MAGIC_LEN, payload, plen);
        total = sizeof(struct iphdr) + ulen;
    } else {
        struct icmphdr *ic = (struct icmphdr *)(pkt + sizeof(struct iphdr));
        uint8_t *body = (uint8_t *)ic + sizeof(struct icmphdr);
        uint16_t ilen = (uint16_t)(sizeof(struct icmphdr) + MAGIC_LEN + plen);

        build_ip_header(ip, ilen, IPPROTO_ICMP);
        ic->type             = ICMP_ECHO;   /* type 8, allowed by most gws */
        ic->code             = 0;
        ic->un.echo.id       = htons((uint16_t)(magic_tag & 0xffff));
        ic->un.echo.sequence = htons(seq_ctr++);
        ic->checksum         = 0;
        memcpy(body, &net_magic, MAGIC_LEN);
        memcpy(body + MAGIC_LEN, payload, plen);
        ic->checksum = checksum16(ic, ilen);
        total = sizeof(struct iphdr) + ilen;
    }

    ssize_t n = sendto(raw_tx_fd, pkt, total, 0,
                       (struct sockaddr *)&peer_addr, sizeof(peer_addr));
    if (n < 0) {
        if (cfg.verbose) perror("sendto(raw)");
        return -1;
    }
    tx_pkts++; tx_bytes += (unsigned)plen;
    return 0;
}

/* ------------------------------------------------------------------ */
/* Extract tunnel payload from a captured IP packet.                   */
/* Returns payload length (>=0) and fills *out, or -1 if not ours.     */
/* Also reports the claimed source IP via *claimed (network order).    */
/* ------------------------------------------------------------------ */
static int carrier_parse(const uint8_t *buf, size_t len, uint32_t want_magic,
                         const uint8_t **out, uint32_t *claimed)
{
    if (len < sizeof(struct iphdr)) return -1;
    const struct iphdr *ip = (const struct iphdr *)buf;
    size_t ihl = ip->ihl * 4;
    if (ihl < sizeof(struct iphdr) || len < ihl) return -1;
    if (claimed) *claimed = ip->saddr;

    const uint8_t *magic_ptr;
    size_t remaining;

    if (cfg.carrier == CARRIER_UDP) {
        if (ip->protocol != IPPROTO_UDP) return -1;
        if (len < ihl + sizeof(struct udphdr)) return -1;
        const struct udphdr *udp = (const struct udphdr *)(buf + ihl);
        if (ntohs(udp->dest) != cfg.carrier_port) return -1;
        magic_ptr = buf + ihl + sizeof(struct udphdr);
        remaining = len - ihl - sizeof(struct udphdr);
    } else {
        if (ip->protocol != IPPROTO_ICMP) return -1;
        if (len < ihl + sizeof(struct icmphdr)) return -1;
        const struct icmphdr *ic = (const struct icmphdr *)(buf + ihl);
        if (ic->type != ICMP_ECHO && ic->type != ICMP_ECHOREPLY) return -1;
        magic_ptr = buf + ihl + sizeof(struct icmphdr);
        remaining = len - ihl - sizeof(struct icmphdr);
    }

    if (remaining < MAGIC_LEN) return -1;
    uint32_t got;
    memcpy(&got, magic_ptr, MAGIC_LEN);
    if (ntohl(got) != want_magic) return -1;

    *out = magic_ptr + MAGIC_LEN;
    return (int)(remaining - MAGIC_LEN);
}

/* ------------------------------------------------------------------ */
/* TX thread: read WireGuard datagrams from local UDP -> spoof out.    */
/* ------------------------------------------------------------------ */
static void *tx_loop(void *arg)
{
    (void)arg;
    uint8_t buf[BUF_SZ];
    while (running) {
        ssize_t n = recv(local_fd, buf, sizeof(buf), 0);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) continue;
            if (n < 0) { usleep(1000); }
            continue;
        }
        carrier_send(buf, (size_t)n, cfg.magic);
    }
    return NULL;
}

/* ------------------------------------------------------------------ */
/* RX thread: capture carrier packets -> deliver to WireGuard.         */
/* ------------------------------------------------------------------ */
static void *rx_loop(void *arg)
{
    (void)arg;
    uint8_t buf[BUF_SZ];
    struct sockaddr_ll sll;
    socklen_t slen;
    while (running) {
        slen = sizeof(sll);
        ssize_t n = recvfrom(pkt_rx_fd, buf, sizeof(buf), 0,
                             (struct sockaddr *)&sll, &slen);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) continue;
            continue;
        }
        if (sll.sll_pkttype == PACKET_OUTGOING) continue; /* ignore our own TX */

        const uint8_t *payload = NULL;
        int plen = carrier_parse(buf, (size_t)n, cfg.magic, &payload, NULL);
        if (plen < 0) continue;

        sendto(local_fd, payload, (size_t)plen, 0,
               (struct sockaddr *)&wg_addr, sizeof(wg_addr));
        rx_pkts++; rx_bytes += (unsigned)plen;
    }
    return NULL;
}

/* ------------------------------------------------------------------ */
/* Socket setup helpers                                                */
/* ------------------------------------------------------------------ */
static int open_raw_tx(void)
{
    int fd = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
    if (fd < 0) { perror("socket(AF_INET,SOCK_RAW)"); return -1; }
    int one = 1;
    if (setsockopt(fd, IPPROTO_IP, IP_HDRINCL, &one, sizeof(one)) < 0) {
        perror("IP_HDRINCL"); close(fd); return -1;
    }
    return fd;
}

static int open_packet_rx(uint8_t proto)
{
    int fd = socket(AF_PACKET, SOCK_DGRAM, htons(ETH_P_IP));
    if (fd < 0) { perror("socket(AF_PACKET)"); return -1; }

    if (cfg.pub_iface[0]) {
        struct sockaddr_ll sll = {0};
        sll.sll_family   = AF_PACKET;
        sll.sll_protocol = htons(ETH_P_IP);
        sll.sll_ifindex  = (int)if_nametoindex(cfg.pub_iface);
        if (sll.sll_ifindex == 0) {
            fprintf(stderr, "warning: iface '%s' not found, capturing all\n",
                    cfg.pub_iface);
        } else if (bind(fd, (struct sockaddr *)&sll, sizeof(sll)) < 0) {
            perror("bind(AF_PACKET)");
        }
    }
    if (attach_proto_filter(fd, proto) < 0)
        perror("SO_ATTACH_FILTER (continuing unfiltered)");
    return fd;
}

static int open_local_udp(uint16_t port)
{
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) { perror("socket(local udp)"); return -1; }
    struct sockaddr_in a = {0};
    a.sin_family      = AF_INET;
    a.sin_addr.s_addr = inet_addr("127.0.0.1");
    a.sin_port        = htons(port);
    if (bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0) {
        perror("bind(local udp)"); close(fd); return -1;
    }
    return fd;
}

/* ------------------------------------------------------------------ */
/* run mode                                                            */
/* ------------------------------------------------------------------ */
static int cmd_run(void)
{
    uint8_t proto = (cfg.carrier == CARRIER_UDP) ? IPPROTO_UDP : IPPROTO_ICMP;

    peer_addr.sin_family      = AF_INET;
    peer_addr.sin_addr.s_addr = inet_addr(cfg.peer_ip);
    peer_addr.sin_port        = 0;

    wg_addr.sin_family      = AF_INET;
    wg_addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    wg_addr.sin_port        = htons(cfg.wg_port);

    raw_tx_fd = open_raw_tx();
    pkt_rx_fd = open_packet_rx(proto);
    local_fd  = open_local_udp(cfg.local_port);
    if (raw_tx_fd < 0 || pkt_rx_fd < 0 || local_fd < 0) return 1;

    fprintf(stderr,
        "[spooftun] run: carrier=%s peer=%s spoof=%s iface=%s "
        "lport=%u wgport=%u cport=%u magic=0x%08x\n",
        cfg.carrier == CARRIER_UDP ? "udp" : "icmp",
        cfg.peer_ip, cfg.spoof_src, cfg.pub_iface,
        cfg.local_port, cfg.wg_port, cfg.carrier_port, cfg.magic);

    pthread_t t_tx, t_rx;
    pthread_create(&t_rx, NULL, rx_loop, NULL);
    pthread_create(&t_tx, NULL, tx_loop, NULL);

    time_t last = time(NULL);
    while (running) {
        sleep(1);
        if (cfg.verbose && time(NULL) - last >= 5) {
            fprintf(stderr, "[spooftun] tx=%llu pkt/%llu B  rx=%llu pkt/%llu B\n",
                    tx_pkts, tx_bytes, rx_pkts, rx_bytes);
            last = time(NULL);
        }
    }

    /* wake blocked threads */
    shutdown(local_fd, SHUT_RDWR);
    shutdown(pkt_rx_fd, SHUT_RDWR);
    pthread_cancel(t_tx);
    pthread_cancel(t_rx);
    pthread_join(t_tx, NULL);
    pthread_join(t_rx, NULL);
    close(raw_tx_fd); close(pkt_rx_fd); close(local_fd);
    fprintf(stderr, "[spooftun] stopped.\n");
    return 0;
}

/* ------------------------------------------------------------------ */
/* probe-send: announce a candidate spoofed source IP to the peer.     */
/* Payload contains the ASCII of the claimed source IP for clarity.    */
/* ------------------------------------------------------------------ */
static int cmd_probe_send(int count)
{
    uint8_t proto = (cfg.carrier == CARRIER_UDP) ? IPPROTO_UDP : IPPROTO_ICMP;
    (void)proto;
    peer_addr.sin_family      = AF_INET;
    peer_addr.sin_addr.s_addr = inet_addr(cfg.peer_ip);

    raw_tx_fd = open_raw_tx();
    if (raw_tx_fd < 0) return 1;

    char msg[128];
    int mlen = snprintf(msg, sizeof(msg), "SPOOF-PROBE src=%s", cfg.spoof_src);

    for (int i = 0; i < count && running; i++) {
        carrier_send((uint8_t *)msg, (size_t)mlen, PROBE_MAGIC);
        usleep(200 * 1000);
    }
    fprintf(stderr, "[probe-send] sent %d probes claiming src=%s to %s (%s)\n",
            count, cfg.spoof_src, cfg.peer_ip,
            cfg.carrier == CARRIER_UDP ? "udp" : "icmp");
    close(raw_tx_fd);
    return 0;
}

/* ------------------------------------------------------------------ */
/* probe-listen: print claimed source IPs whose probes reached us.     */
/* ------------------------------------------------------------------ */
static int cmd_probe_listen(int seconds)
{
    uint8_t proto = (cfg.carrier == CARRIER_UDP) ? IPPROTO_UDP : IPPROTO_ICMP;
    pkt_rx_fd = open_packet_rx(proto);
    if (pkt_rx_fd < 0) return 1;

    struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };
    setsockopt(pkt_rx_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    fprintf(stderr, "[probe-listen] listening %ds on %s (%s)...\n",
            seconds, cfg.pub_iface,
            cfg.carrier == CARRIER_UDP ? "udp" : "icmp");

    time_t end = time(NULL) + seconds;
    uint8_t buf[BUF_SZ];
    unsigned long long hits = 0;
    while (running && time(NULL) < end) {
        struct sockaddr_ll sll; socklen_t sl = sizeof(sll);
        ssize_t n = recvfrom(pkt_rx_fd, buf, sizeof(buf), 0,
                             (struct sockaddr *)&sll, &sl);
        if (n <= 0) continue;
        if (sll.sll_pkttype == PACKET_OUTGOING) continue;

        const uint8_t *payload = NULL; uint32_t claimed = 0;
        int plen = carrier_parse(buf, (size_t)n, PROBE_MAGIC, &payload, &claimed);
        if (plen < 0) continue;

        struct in_addr a; a.s_addr = claimed;
        char body[160]; int c = plen < 159 ? plen : 159;
        memcpy(body, payload, c); body[c] = 0;
        printf("RECV claimed_src=%s payload=\"%s\"\n", inet_ntoa(a), body);
        fflush(stdout);
        hits++;
    }
    fprintf(stderr, "[probe-listen] done. %llu probe(s) received.\n", hits);
    close(pkt_rx_fd);
    return 0;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
static void usage(const char *p)
{
    fprintf(stderr,
"spooftun - Spoof-Tunnel core\n"
"Usage:\n"
"  %s run          [options]\n"
"  %s probe-send   [options] --count N\n"
"  %s probe-listen [options] --seconds S\n"
"\nOptions:\n"
"  --carrier udp|icmp     carrier protocol (default udp)\n"
"  --peer   IP            peer public IP (real destination)\n"
"  --spoof  IP            spoofed/whitelisted source IP\n"
"  --iface  NAME          public interface for RX capture\n"
"  --lport  PORT          local UDP port = WireGuard Endpoint (default 51821)\n"
"  --wgport PORT          WireGuard ListenPort delivery target (default 51820)\n"
"  --cport  PORT          UDP carrier port (default 8443)\n"
"  --magic  HEX           tunnel magic tag (default 0x53504f46)\n"
"  --count  N             probe-send: number of probes (default 20)\n"
"  --seconds S            probe-listen: listen duration (default 15)\n"
"  --verbose              periodic stats\n",
    p, p, p);
}

int main(int argc, char **argv)
{
    srand((unsigned)time(NULL) ^ (unsigned)getpid());

    /* defaults */
    cfg.carrier      = CARRIER_UDP;
    cfg.local_port   = 51821;
    cfg.wg_port      = 51820;
    cfg.carrier_port = 8443;
    cfg.magic        = 0x53504f46u; /* "SPOF" */
    cfg.verbose      = 0;
    strncpy(cfg.pub_iface, "", IFNAMSIZ);

    if (argc < 2) { usage(argv[0]); return 2; }
    const char *sub = argv[1];

    int count = 20, seconds = 15;
    static struct option lo[] = {
        {"carrier", required_argument, 0, 'c'},
        {"peer",    required_argument, 0, 'p'},
        {"spoof",   required_argument, 0, 's'},
        {"iface",   required_argument, 0, 'i'},
        {"lport",   required_argument, 0, 'l'},
        {"wgport",  required_argument, 0, 'w'},
        {"cport",   required_argument, 0, 'C'},
        {"magic",   required_argument, 0, 'm'},
        {"count",   required_argument, 0, 'n'},
        {"seconds", required_argument, 0, 'S'},
        {"verbose", no_argument,       0, 'v'},
        {"help",    no_argument,       0, 'h'},
        {0,0,0,0}
    };

    optind = 2; /* skip subcommand */
    int opt;
    while ((opt = getopt_long(argc, argv, "c:p:s:i:l:w:C:m:n:S:vh", lo, NULL)) != -1) {
        switch (opt) {
        case 'c': cfg.carrier = strcmp(optarg, "icmp") == 0 ? CARRIER_ICMP : CARRIER_UDP; break;
        case 'p': strncpy(cfg.peer_ip, optarg, sizeof(cfg.peer_ip)-1); break;
        case 's': strncpy(cfg.spoof_src, optarg, sizeof(cfg.spoof_src)-1); break;
        case 'i': strncpy(cfg.pub_iface, optarg, IFNAMSIZ-1); break;
        case 'l': cfg.local_port   = (uint16_t)atoi(optarg); break;
        case 'w': cfg.wg_port      = (uint16_t)atoi(optarg); break;
        case 'C': cfg.carrier_port = (uint16_t)atoi(optarg); break;
        case 'm': cfg.magic        = (uint32_t)strtoul(optarg, NULL, 0); break;
        case 'n': count            = atoi(optarg); break;
        case 'S': seconds          = atoi(optarg); break;
        case 'v': cfg.verbose      = 1; break;
        case 'h': usage(argv[0]); return 0;
        default:  usage(argv[0]); return 2;
        }
    }

    signal(SIGINT,  on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, SIG_IGN);

    if (strcmp(sub, "run") == 0) {
        if (!cfg.peer_ip[0] || !cfg.spoof_src[0]) {
            fprintf(stderr, "error: run requires --peer and --spoof\n");
            return 2;
        }
        return cmd_run();
    } else if (strcmp(sub, "probe-send") == 0) {
        if (!cfg.peer_ip[0] || !cfg.spoof_src[0]) {
            fprintf(stderr, "error: probe-send requires --peer and --spoof\n");
            return 2;
        }
        return cmd_probe_send(count);
    } else if (strcmp(sub, "probe-listen") == 0) {
        return cmd_probe_listen(seconds);
    } else if (strcmp(sub, "-h") == 0 || strcmp(sub, "--help") == 0) {
        usage(argv[0]); return 0;
    }

    fprintf(stderr, "unknown subcommand: %s\n", sub);
    usage(argv[0]);
    return 2;
}
