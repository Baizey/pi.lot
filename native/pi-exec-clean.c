#define _GNU_SOURCE

#include <dirent.h>
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

    /* A lowered RLIMIT_NOFILE does not close descriptors already above its new
     * value. Enumerate the actual open descriptors rather than trusting that limit. */
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) {
        perror("opendir /proc/self/fd");
        exit(126);
    }
    const int enumeration_fd = dirfd(directory);
    if (enumeration_fd < 0) {
        int saved_errno = errno;
        closedir(directory);
        errno = saved_errno;
        perror("dirfd /proc/self/fd");
        exit(126);
    }
    while (1) {
        /* close and strtoul can change errno between successful readdir calls. */
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (!entry) {
            int saved_errno = errno;
            closedir(directory);
            if (saved_errno != 0) {
                errno = saved_errno;
                perror("readdir /proc/self/fd");
                exit(126);
            }
            return;
        }
        char *end = NULL;
        unsigned long descriptor = strtoul(entry->d_name, &end, 10);
        if (end == entry->d_name || *end != '\0' || descriptor > INT_MAX) continue;
        if (descriptor >= first && (int) descriptor != enumeration_fd) close((int) descriptor);
    }
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
