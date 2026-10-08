#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

/* Pause before returning into the real gateway's child branch. The fixture does
 * not replace any gateway algorithm or alter production signal handling. */
pid_t fork(void) {
    pid_t (*actual_fork)(void);
    void *symbol = dlsym(RTLD_NEXT, "fork");
    memcpy(&actual_fork, &symbol, sizeof(actual_fork));
    if (!actual_fork) _exit(70);
    pid_t child = actual_fork();
    if (child == 0) {
        const char *notification = getenv("PI_GATEWAY_FORK_NOTIFY_FD");
        if (!notification) _exit(70);
        char record[64];
        int length = snprintf(record, sizeof(record), "%ld\n", (long) getpid());
        if (length <= 0 || write(atoi(notification), record, (size_t) length) != length) _exit(70);
        if (kill(getpid(), SIGSTOP) != 0) _exit(70);
    }
    return child;
}
