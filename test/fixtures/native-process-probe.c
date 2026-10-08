#define _GNU_SOURCE
/* Test-only syscall/ABI launcher and inspector. No production helper implementation. */
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static void print_hex(const char *value) {
    for (const unsigned char *byte = (const unsigned char *) value; *byte; byte++) printf("%02x", *byte);
    putchar('\n');
}

static int raw_exec(const char *helper, const char *self, int invalid_maximum) {
    char argument[] = {'a', (char) 0xff, (char) 0x80, 'z', 0};
    char environment[] = {'P', 'I', '_', 'R', 'A', 'W', '=', (char) 0xfe, (char) 0x81, 0};
    if (putenv(environment) != 0) return 70;
    char *arguments[] = {(char *) helper, invalid_maximum ? argument : "2", (char *) self, "inspect-raw", argument, NULL};
    execv(helper, arguments);
    perror("raw exec");
    return 70;
}

/* Inject close_range/procfs failures and lower the descriptor limit after the
 * high-descriptor mode opens fd 512, without implementing descriptor cleanup. */
static int filtered_exec(int argc, char **argv) {
    if (argc < 5) return 64;
    int error = atoi(argv[2]);
    struct rlimit limit = {.rlim_cur = 64, .rlim_max = 64};
    if (setrlimit(RLIMIT_NOFILE, &limit) != 0) return 70;
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_close_range, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (unsigned int) error),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_getdents64, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, strcmp(argv[1], "filtered-exec-unreadable") == 0 ? SECCOMP_RET_ERRNO | EACCES : SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_openat, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, O_DIRECTORY, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, strcmp(argv[1], "filtered-exec-unopenable") == 0 ? SECCOMP_RET_ERRNO | EACCES : SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {.len = sizeof(instructions) / sizeof(instructions[0]), .filter = instructions};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) {
        perror("install test seccomp filter");
        return 70;
    }
    execv(argv[3], &argv[3]);
    perror("filtered exec");
    return 70;
}

int main(int argc, char **argv) {
    if (argc == 4 && strcmp(argv[1], "exec-raw") == 0) return raw_exec(argv[2], argv[3], 0);
    if (argc == 4 && strcmp(argv[1], "exec-invalid-raw") == 0) return raw_exec(argv[2], argv[3], 1);
    if (argc == 3 && strcmp(argv[1], "inspect-raw") == 0) {
        print_hex(argv[2]);
        const char *value = getenv("PI_RAW");
        if (!value) return 70;
        print_hex(value);
        return 0;
    }
    if (argc >= 4 && strcmp(argv[1], "exec-closed-stdio") == 0) {
        int mask = atoi(argv[2]);
        for (int descriptor = 0; descriptor < 3; descriptor++) {
            if (mask & (1 << descriptor)) close(descriptor);
        }
        execv(argv[3], &argv[3]);
        return 70;
    }
    if (argc == 2 && strcmp(argv[1], "inspect-stdio") == 0) {
        for (int descriptor = 0; descriptor < 3; descriptor++) {
            dprintf(3, "%d:%d\n", descriptor, fcntl(descriptor, F_GETFD));
        }
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "check-fds") == 0) {
        int maximum = atoi(argv[2]);
        for (int descriptor = 0; descriptor < 10; descriptor++) {
            if ((fcntl(descriptor, F_GETFD) >= 0) != (descriptor <= maximum)) return 71;
        }
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "inspect-fds") == 0) {
        for (int descriptor = 0; descriptor < 10; descriptor++) {
            int flags = fcntl(descriptor, F_GETFD);
            printf("%d:%d\n", descriptor, flags);
        }
        return 0;
    }
    if (argc >= 2 && strcmp(argv[1], "filtered-exec-high") == 0) {
        int descriptor = open("/dev/null", O_RDONLY);
        if (descriptor < 0 || dup2(descriptor, 512) < 0) return 70;
        if (descriptor != 512) close(descriptor);
        return filtered_exec(argc, argv);
    }
    if (argc == 2 && strcmp(argv[1], "inspect-high") == 0) {
        struct stat status;
        puts(fstat(512, &status) == 0 ? "open" : "closed");
        return 0;
    }
    if (argc >= 2 && strncmp(argv[1], "filtered-exec", 13) == 0) return filtered_exec(argc, argv);
    fprintf(stderr, "usage: native-process-probe EXEC_OR_INSPECT_MODE [ARG...]\n");
    return 64;
}
