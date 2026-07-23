#include <arpa/inet.h>
#include <ctype.h>
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
#define DNS_ALLOW_PACKET_MARK 0x50490004U
#define DNS_DENY_PACKET_MARK 0x50490005U
#define IPV4_MORE_FRAGMENTS 0x2000U
#define IPV4_FRAGMENT_OFFSET_MASK 0x1fffU
#define PROTOCOL_PREFIX "PI_NETWORK_QUEUE\t3"

typedef struct {
    uint64_t sequence;
    int failed;
} queue_context;

typedef struct {
    const char *family;
    const char *transport;
    const unsigned char *transport_header;
    size_t transport_length;
    char source_address[INET6_ADDRSTRLEN];
    char destination_address[INET6_ADDRSTRLEN];
} packet_metadata;

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

static int read_verdict(
    uint64_t sequence,
    uint32_t allow_mark,
    uint32_t deny_mark,
    uint32_t *mark
) {
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
        *mark = allow_mark;
        return 0;
    }
    if (strcmp(line, expected_deny) == 0) {
        *mark = deny_mark;
        return 0;
    }
    return -1;
}

static int parse_ipv4_packet(
    const unsigned char *packet,
    size_t packet_length,
    packet_metadata *metadata
) {
    if (packet_length < 20) return -1;

    size_t header_length = (size_t) (packet[0] & 0x0fU) * 4U;
    uint16_t total_length = read_be16(packet + 2);
    uint16_t fragment = read_be16(packet + 6);
    if (header_length < 20 || header_length > packet_length
        || total_length < header_length || (size_t) total_length > packet_length
        || (fragment & (IPV4_MORE_FRAGMENTS | IPV4_FRAGMENT_OFFSET_MASK)) != 0
        || (packet[9] != IPPROTO_TCP && packet[9] != IPPROTO_UDP)) {
        return -1;
    }

    metadata->family = "IPV4";
    metadata->transport = packet[9] == IPPROTO_TCP ? "tcp" : "udp";
    metadata->transport_header = packet + header_length;
    metadata->transport_length = (size_t) total_length - header_length;
    if (!inet_ntop(AF_INET, packet + 12, metadata->source_address, sizeof(metadata->source_address))
        || !inet_ntop(AF_INET, packet + 16, metadata->destination_address, sizeof(metadata->destination_address))) {
        return -1;
    }
    return 0;
}

static int parse_ipv6_packet(
    const unsigned char *packet,
    size_t packet_length,
    packet_metadata *metadata
) {
    if (packet_length < 40) return -1;

    uint16_t payload_length = read_be16(packet + 4);
    size_t total_length = 40U + (size_t) payload_length;
    uint8_t next_header = packet[6];
    if (payload_length == 0 || total_length > packet_length
        || (next_header != IPPROTO_TCP && next_header != IPPROTO_UDP)) {
        return -1;
    }

    metadata->family = "IPV6";
    metadata->transport = next_header == IPPROTO_TCP ? "tcp" : "udp";
    metadata->transport_header = packet + 40;
    metadata->transport_length = payload_length;
    if (!inet_ntop(AF_INET6, packet + 8, metadata->source_address, sizeof(metadata->source_address))
        || !inet_ntop(AF_INET6, packet + 24, metadata->destination_address, sizeof(metadata->destination_address))) {
        return -1;
    }
    return 0;
}

static int parse_transport(const packet_metadata *metadata, uint16_t *source_port, uint16_t *destination_port) {
    const unsigned char *header = metadata->transport_header;
    if (strcmp(metadata->transport, "tcp") == 0) {
        if (metadata->transport_length < 20) return -1;
        size_t header_length = (size_t) (header[12] >> 4) * 4U;
        unsigned char control_flags = header[13] & 0x17U;
        if (header_length < 20 || header_length > metadata->transport_length || control_flags != 0x02U) return -1;
    } else {
        if (metadata->transport_length < 8) return -1;
        uint16_t datagram_length = read_be16(header + 4);
        if (datagram_length < 8 || (size_t) datagram_length > metadata->transport_length) return -1;
    }

    *source_port = read_be16(header);
    *destination_port = read_be16(header + 2);
    return *source_port > 0 && *destination_port > 0 ? 0 : -1;
}

static int parse_dns_query(
    const packet_metadata *metadata,
    char *name,
    size_t name_capacity,
    uint16_t *query_type
) {
    const unsigned char *udp = metadata->transport_header;
    uint16_t datagram_length = read_be16(udp + 4);
    const unsigned char *dns = udp + 8;
    size_t dns_length = (size_t) datagram_length - 8U;
    if (dns_length < 17 || (read_be16(dns + 2) & 0xf800U) != 0 || read_be16(dns + 4) != 1) return -1;

    size_t input_offset = 12;
    size_t output_offset = 0;
    while (1) {
        if (input_offset >= dns_length) return -1;
        unsigned int label_length = dns[input_offset++];
        if (label_length == 0) break;
        if (label_length > 63 || input_offset + label_length > dns_length) return -1;
        if (output_offset > 0) {
            if (output_offset + 1 >= name_capacity) return -1;
            name[output_offset++] = '.';
        }
        if (output_offset + label_length >= name_capacity) return -1;

        for (unsigned int index = 0; index < label_length; index++) {
            unsigned char character = dns[input_offset + index];
            if (!((character >= 'a' && character <= 'z')
                || (character >= 'A' && character <= 'Z')
                || (character >= '0' && character <= '9')
                || character == '-'
                || character == '_')) {
                return -1;
            }
            if ((index == 0 || index + 1 == label_length) && character == '-') return -1;
            name[output_offset++] = (char) tolower(character);
        }
        input_offset += label_length;
    }

    if (output_offset == 0 || input_offset + 4 > dns_length || read_be16(dns + input_offset + 2) != 1) return -1;
    *query_type = read_be16(dns + input_offset);
    if (*query_type == 0) return -1;
    name[output_offset] = '\0';
    return 0;
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
    int raw_packet_length = nfq_get_payload(packet_data, &packet);
    if (raw_packet_length < 1 || !packet) return drop_packet(queue, packet_id);

    size_t packet_length = (size_t) raw_packet_length;
    packet_metadata metadata = {0};
    unsigned int version = packet[0] >> 4;
    int parsed = version == 4
        ? parse_ipv4_packet(packet, packet_length, &metadata)
        : version == 6
            ? parse_ipv6_packet(packet, packet_length, &metadata)
            : -1;
    uint16_t source_port = 0;
    uint16_t destination_port = 0;
    if (parsed < 0 || parse_transport(&metadata, &source_port, &destination_port) < 0) {
        return drop_packet(queue, packet_id);
    }

    char dns_name[256] = {0};
    uint16_t dns_type = 0;
    int is_dns_query = strcmp(metadata.transport, "udp") == 0 && destination_port == 53;
    if (is_dns_query && parse_dns_query(&metadata, dns_name, sizeof(dns_name), &dns_type) < 0) {
        return drop_packet(queue, packet_id);
    }

    if (context->sequence == UINT64_MAX) {
        return protocol_failure(context, queue, packet_id, "event sequence exhausted");
    }
    uint64_t sequence = ++context->sequence;
    int event_result = is_dns_query
        ? fprintf(
            stdout,
            PROTOCOL_PREFIX "\tEVENT\t%" PRIu64 "\t%s\t%s\t%s\t%u\t%s\t%u\tDNS\t%s\t%u\n",
            sequence,
            metadata.family,
            metadata.transport,
            metadata.source_address,
            (unsigned int) source_port,
            metadata.destination_address,
            (unsigned int) destination_port,
            dns_name,
            (unsigned int) dns_type
        )
        : fprintf(
            stdout,
            PROTOCOL_PREFIX "\tEVENT\t%" PRIu64 "\t%s\t%s\t%s\t%u\t%s\t%u\n",
            sequence,
            metadata.family,
            metadata.transport,
            metadata.source_address,
            (unsigned int) source_port,
            metadata.destination_address,
            (unsigned int) destination_port
        );
    if (event_result < 0 || fflush(stdout) != 0) {
        return protocol_failure(context, queue, packet_id, "failed to send policy event");
    }

    uint32_t mark = 0;
    uint32_t allow_mark = is_dns_query ? DNS_ALLOW_PACKET_MARK : ALLOW_PACKET_MARK;
    uint32_t deny_mark = is_dns_query ? DNS_DENY_PACKET_MARK : DENY_PACKET_MARK;
    if (read_verdict(sequence, allow_mark, deny_mark, &mark) < 0) {
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
    if (nfq_bind_pf(handle, AF_INET) < 0 || nfq_bind_pf(handle, AF_INET6) < 0) {
        report_nfq_error("failed to bind IPv4 and IPv6 network queue families");
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
