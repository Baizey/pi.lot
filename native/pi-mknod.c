#define _GNU_SOURCE

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>

static int parse_uint32(const char *value, uint32_t *result) {
    char *end = NULL;
    errno = 0;
    const unsigned long parsed = strtoul(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || parsed > UINT32_MAX) return -1;
    *result = (uint32_t) parsed;
    return 0;
}

static int parse_uint64(const char *value, uint64_t *result) {
    char *end = NULL;
    errno = 0;
    const unsigned long long parsed = strtoull(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0') return -1;
    *result = (uint64_t) parsed;
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 4) return EINVAL;

    uint32_t mode;
    uint64_t device;
    if (parse_uint32(argv[1], &mode) != 0 || parse_uint64(argv[2], &device) != 0) return EINVAL;
    if (mknod(argv[3], (mode_t) mode, (dev_t) device) == 0) return 0;

    return errno > 0 && errno < 256 ? errno : EIO;
}
