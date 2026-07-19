#include <arpa/inet.h>
#include <errno.h>
#include <inttypes.h>
#include <libnetfilter_queue/libnetfilter_queue.h>
#include <linux/netfilter.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define QUEUE_NUMBER 0
#define QUEUE_LENGTH 128
#define RECEIVE_BUFFER_SIZE (128 * 1024)
#define ALLOW_PACKET_MARK 0x50490001U
#define DENY_PACKET_MARK 0x50490002U
#define IPV4_MORE_FRAGMENTS 0x2000U
#define IPV4_FRAGMENT_OFFSET_MASK 0x1fffU
#define PROTOCOL_PREFIX "PI_NETWORK_QUEUE\t1"

typedef struct {
    uint64_t sequence;
    int failed;
} queue_context;

static void report_error(const char *message) {
    fprintf(stderr, "pi-network-queue: %s: %s\n", message, strerror(errno));
}

static void report_nfq_error(const char *message) {
    fprintf(stderr, "pi-network-queue: %s\n", message);
}

static uint16_t read_be16(const unsigned char *bytes) {
    uint16_t value;
    memcpy(&value, bytes, sizeof(value));
    return ntohs(value);
}

static int drop_packet(struct nfq_q_handle *queue, uint32_t packet_id) {
    return nfq_set_verdict(queue, packet_id, NF_DROP, 0, NULL);
}

static int protocol_failure(
    queue_context *context,
    struct nfq_q_handle *queue,
    uint32_t packet_id,
    const char *message
) {
    fprintf(stderr, "pi-network-queue: %s\n", message);
    if (drop_packet(queue, packet_id) < 0) report_nfq_error("failed to drop packet after protocol error");
    context->failed = 1;
    return -1;
}

static int read_verdict(uint64_t sequence, uint32_t *mark) {
    char line[256];
    if (!fgets(line, sizeof(line), stdin)) return -1;

    char *newline = strchr(line, '\n');
    if (!newline) return -1;
    *newline = '\0';
    if (newline > line && newline[-1] == '\r') newline[-1] = '\0';

    char expected_allow[128];
    char expected_deny[128];
    int allow_length = snprintf(
        expected_allow,
        sizeof(expected_allow),
        PROTOCOL_PREFIX "\tVERDICT\t%" PRIu64 "\tALLOW",
        sequence
    );
    int deny_length = snprintf(
        expected_deny,
        sizeof(expected_deny),
        PROTOCOL_PREFIX "\tVERDICT\t%" PRIu64 "\tDENY",
        sequence
    );
    if (allow_length < 0 || (size_t) allow_length >= sizeof(expected_allow)
        || deny_length < 0 || (size_t) deny_length >= sizeof(expected_deny)) {
        return -1;
    }

    if (strcmp(line, expected_allow) == 0) {
        *mark = ALLOW_PACKET_MARK;
        return 0;
    }
    if (strcmp(line, expected_deny) == 0) {
        *mark = DENY_PACKET_MARK;
        return 0;
    }
    return -1;
}

static int queue_callback(
    struct nfq_q_handle *queue,
    struct nfgenmsg *message,
    struct nfq_data *packet_data,
    void *opaque
) {
    (void) message;
    queue_context *context = opaque;
    struct nfqnl_msg_packet_hdr *header = nfq_get_msg_packet_hdr(packet_data);
    if (!header) {
        context->failed = 1;
        report_nfq_error("queued packet has no packet header");
        return -1;
    }
    uint32_t packet_id = ntohl(header->packet_id);

    unsigned char *packet = NULL;
    int packet_length = nfq_get_payload(packet_data, &packet);
    if (packet_length < 40 || !packet) {
        return drop_packet(queue, packet_id);
    }

    unsigned int version = packet[0] >> 4;
    size_t ip_header_length = (size_t) (packet[0] & 0x0fU) * 4U;
    uint16_t total_length = read_be16(packet + 2);
    uint16_t fragment = read_be16(packet + 6);
    if (version != 4 || ip_header_length < 20 || ip_header_length > (size_t) packet_length
        || total_length < ip_header_length + 20 || (size_t) total_length > (size_t) packet_length
        || packet[9] != IPPROTO_TCP
        || (fragment & (IPV4_MORE_FRAGMENTS | IPV4_FRAGMENT_OFFSET_MASK)) != 0) {
        return drop_packet(queue, packet_id);
    }

    const unsigned char *tcp = packet + ip_header_length;
    size_t tcp_header_length = (size_t) (tcp[12] >> 4) * 4U;
    unsigned char control_flags = tcp[13] & 0x17U;
    uint16_t source_port = read_be16(tcp);
    uint16_t destination_port = read_be16(tcp + 2);
    if (tcp_header_length < 20 || ip_header_length + tcp_header_length > total_length
        || control_flags != 0x02U || source_port == 0 || destination_port == 0) {
        return drop_packet(queue, packet_id);
    }

    char source_address[INET_ADDRSTRLEN];
    char destination_address[INET_ADDRSTRLEN];
    if (!inet_ntop(AF_INET, packet + 12, source_address, sizeof(source_address))
        || !inet_ntop(AF_INET, packet + 16, destination_address, sizeof(destination_address))) {
        return drop_packet(queue, packet_id);
    }

    if (context->sequence == UINT64_MAX) {
        return protocol_failure(context, queue, packet_id, "event sequence exhausted");
    }
    uint64_t sequence = ++context->sequence;
    if (fprintf(
            stdout,
            PROTOCOL_PREFIX "\tEVENT\t%" PRIu64 "\tIPV4\t%s\t%u\t%s\t%u\n",
            sequence,
            source_address,
            (unsigned int) source_port,
            destination_address,
            (unsigned int) destination_port
        ) < 0
        || fflush(stdout) != 0) {
        return protocol_failure(context, queue, packet_id, "failed to send policy event");
    }

    uint32_t mark = 0;
    if (read_verdict(sequence, &mark) < 0) {
        return protocol_failure(context, queue, packet_id, "invalid or closed verdict stream");
    }

    if (nfq_set_verdict2(queue, packet_id, NF_REPEAT, mark, 0, NULL) < 0) {
        context->failed = 1;
        report_nfq_error("failed to return packet verdict");
        return -1;
    }
    return 0;
}

int main(void) {
    signal(SIGPIPE, SIG_IGN);
    if (setvbuf(stdout, NULL, _IOLBF, 0) != 0) {
        report_error("configure protocol output");
        return EXIT_FAILURE;
    }

    struct nfq_handle *handle = nfq_open();
    if (!handle) {
        report_nfq_error("nfq_open failed");
        return EXIT_FAILURE;
    }
    if (nfq_bind_pf(handle, AF_INET) < 0) {
        report_nfq_error("nfq_bind_pf(AF_INET) failed");
        nfq_close(handle);
        return EXIT_FAILURE;
    }

    queue_context context = {0};
    struct nfq_q_handle *queue = nfq_create_queue(handle, QUEUE_NUMBER, queue_callback, &context);
    if (!queue) {
        report_nfq_error("nfq_create_queue failed");
        nfq_close(handle);
        return EXIT_FAILURE;
    }
    if (nfq_set_mode(queue, NFQNL_COPY_PACKET, 0xffff) < 0
        || nfq_set_queue_maxlen(queue, QUEUE_LENGTH) < 0
        || nfq_set_queue_flags(queue, NFQA_CFG_F_FAIL_OPEN, 0) < 0) {
        report_nfq_error("failed to configure fail-closed packet queue");
        nfq_destroy_queue(queue);
        nfq_close(handle);
        return EXIT_FAILURE;
    }

    if (printf(PROTOCOL_PREFIX "\tREADY\n") < 0 || fflush(stdout) != 0) {
        report_error("send readiness record");
        nfq_destroy_queue(queue);
        nfq_close(handle);
        return EXIT_FAILURE;
    }

    int netlink_fd = nfq_fd(handle);
    char buffer[RECEIVE_BUFFER_SIZE] __attribute__((aligned));
    while (!context.failed) {
        ssize_t received = recv(netlink_fd, buffer, sizeof(buffer), 0);
        if (received < 0) {
            if (errno == EINTR) continue;
            report_error("receive queued packet");
            context.failed = 1;
            break;
        }
        if (received == 0) {
            report_nfq_error("netlink queue closed unexpectedly");
            context.failed = 1;
            break;
        }
        if (nfq_handle_packet(handle, buffer, (int) received) < 0) {
            report_nfq_error("failed to process queued packet");
            context.failed = 1;
            break;
        }
    }

    nfq_destroy_queue(queue);
    nfq_close(handle);
    return context.failed ? EXIT_FAILURE : EXIT_SUCCESS;
}
