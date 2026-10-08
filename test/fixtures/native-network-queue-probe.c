/* Mount-free differential oracle: call the original parsers, not copies.
 * P <hex> => exact EVENT (sequence 1) or DROP
 * V <sequence> <dns:0|1> <hex> => MARK <decimal> or INVALID */
#define _GNU_SOURCE
#define main pi_network_queue_program_main
#include "../../native/pi-network-queue.c"
#undef main

static int hex_digit(unsigned char character) {
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    if (character >= 'A' && character <= 'F') return character - 'A' + 10;
    return -1;
}

static unsigned char *decode_hex(const char *hex, size_t *length) {
    size_t hex_length = strlen(hex);
    if (hex_length % 2 != 0) return NULL;
    *length = hex_length / 2;
    unsigned char *bytes = malloc(*length + 1);
    if (!bytes) return NULL;
    for (size_t index = 0; index < *length; index++) {
        int high = hex_digit((unsigned char) hex[index * 2]);
        int low = hex_digit((unsigned char) hex[index * 2 + 1]);
        if (high < 0 || low < 0) { free(bytes); return NULL; }
        bytes[index] = (unsigned char) (high * 16 + low);
    }
    return bytes;
}

static void probe_packet(const unsigned char *bytes, size_t length) {
    packet_metadata metadata = {0};
    int parsed = length == 0 ? -1 : bytes[0] >> 4 == 4
        ? parse_ipv4_packet(bytes, length, &metadata) : bytes[0] >> 4 == 6
        ? parse_ipv6_packet(bytes, length, &metadata) : -1;
    uint16_t source = 0, destination = 0, query_type = 0;
    char name[256] = {0};
    if (parsed < 0 || parse_transport(&metadata, &source, &destination) < 0) {
        puts("DROP");
        return;
    }
    int dns = strcmp(metadata.transport, "udp") == 0 && destination == 53;
    if (dns && parse_dns_query(&metadata, name, sizeof(name), &query_type) < 0) {
        puts("DROP");
        return;
    }
    printf(PROTOCOL_PREFIX "\tEVENT\t1\t%s\t%s\t%s\t%u\t%s\t%u",
        metadata.family, metadata.transport, metadata.source_address, (unsigned int) source,
        metadata.destination_address, (unsigned int) destination);
    if (dns) printf("\tDNS\t%s\t%u", name, (unsigned int) query_type);
    putchar('\n');
}

static int probe_verdict(uint64_t sequence, int dns, unsigned char *bytes, size_t length) {
    FILE *input = fmemopen(bytes, length, "r");
    if (!input) return -1;
    FILE *saved = stdin;
    stdin = input;
    uint32_t mark = 0;
    int result = read_verdict(sequence, dns ? DNS_ALLOW_PACKET_MARK : ALLOW_PACKET_MARK,
        dns ? DNS_DENY_PACKET_MARK : DENY_PACKET_MARK, &mark);
    stdin = saved;
    fclose(input);
    if (result < 0) puts("INVALID");
    else printf("MARK %" PRIu32 "\n", mark);
    return 0;
}

int main(void) {
    char *line = NULL;
    size_t capacity = 0;
    ssize_t count;
    int status = 0;
    while ((count = getline(&line, &capacity, stdin)) >= 0) {
        if (count > 0 && line[count - 1] == '\n') line[--count] = '\0';
        if (strncmp(line, "P ", 2) == 0) {
            size_t length;
            unsigned char *bytes = decode_hex(line + 2, &length);
            if (!bytes) { status = 64; break; }
            probe_packet(bytes, length);
            free(bytes);
        } else if (strncmp(line, "V ", 2) == 0) {
            char *end = NULL;
            errno = 0;
            uint64_t sequence = strtoull(line + 2, &end, 10);
            if (errno || end == line + 2 || *end != ' ' || (end[1] != '0' && end[1] != '1') || end[2] != ' ') {
                status = 64; break;
            }
            int dns = end[1] == '1';
            size_t length;
            unsigned char *bytes = decode_hex(end + 3, &length);
            if (!bytes) { status = 64; break; }
            int result = probe_verdict(sequence, dns, bytes, length);
            free(bytes);
            if (result < 0) { status = 65; break; }
        } else { status = 64; break; }
    }
    free(line);
    return status;
}
