#define _GNU_SOURCE

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

static void close_descriptors_after(unsigned int maximum_preserved_fd) {
    const unsigned int first = maximum_preserved_fd + 1;

#ifdef SYS_close_range
    if (syscall(SYS_close_range, first, UINT_MAX, 0) == 0) return;
    if (errno != ENOSYS && errno != EINVAL) {
        perror("close_range");
        exit(126);
    }
#endif

    long maximum = sysconf(_SC_OPEN_MAX);
    if (maximum < 0) maximum = 65536;
    for (unsigned int fd = first; fd < (unsigned long) maximum; fd++) close((int) fd);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: pi-exec-clean-native MAX_PRESERVED_FD COMMAND [ARG...]\n");
        return 64;
    }

    char *end = NULL;
    errno = 0;
    unsigned long parsed = strtoul(argv[1], &end, 10);
    if (errno != 0 || end == argv[1] || *end != '\0' || parsed >= UINT_MAX) {
        fprintf(stderr, "invalid maximum preserved descriptor: %s\n", argv[1]);
        return 64;
    }

    close_descriptors_after((unsigned int) parsed);
    execvp(argv[2], &argv[2]);
    perror("execvp");
    return 127;
}
