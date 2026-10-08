#define _GNU_SOURCE
/* Compile the original source into this fixture: no alternate relay implementation. */
#define main native_gateway_main
#include "../../native/pi-tcp-gateway.c"
#undef main

#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/resource.h>
#include <sys/stat.h>

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

/* Force both permitted fallback errors and the deliberately fatal close_range error.
 * A small rlimit keeps the original helper's descriptor-by-descriptor fallback cheap. */
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

static int serve_probe(uint16_t broker_port) {
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0 || set_close_on_exec(listener) < 0) return 1;
    struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_addr = {.s_addr = htonl(INADDR_LOOPBACK)},
    };
    socklen_t length = sizeof(address);
    if (bind(listener, (struct sockaddr *) &address, length) < 0
        || getsockname(listener, (struct sockaddr *) &address, &length) < 0
        || listen(listener, LISTEN_BACKLOG) < 0
        || install_signal_handlers() < 0
        || drop_process_privileges() < 0) return 1;
    printf(PROTOCOL_PREFIX "\tREADY\t%u\n", (unsigned int) ntohs(address.sin_port));
    if (fflush(stdout) != 0) return 1;
    while (1) {
        struct pollfd descriptor = {.fd = listener, .events = POLLIN};
        if (poll(&descriptor, 1, -1) < 0) {
            if (errno == EINTR) continue;
            return 1;
        }
        if (descriptor.revents & POLLIN) accept_client(listener, &listener, 1, &address.sin_addr, broker_port);
        if (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) return 1;
    }
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "parse") == 0) {
        for (int index = 2; index < argc; index++) {
            uint16_t port = 0;
            if (parse_port(argv[index], &port) == 0) printf("%u\n", (unsigned int) port);
            else puts("invalid");
        }
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "relay") == 0) return relay_streams(3, 4) == 0 ? 0 : 1;
    if (argc == 2 && strcmp(argv[1], "privileges") == 0) {
        if (drop_process_privileges() < 0) return 1;
        struct __user_cap_header_struct header = {.version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
        struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
        if (syscall(SYS_capget, &header, capabilities) < 0) return 1;
        printf("dumpable=%d no_new_privs=%d\n", prctl(PR_GET_DUMPABLE), prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
        for (int index = 0; index < 2; index++) {
            printf("%u:%u:%u\n", capabilities[index].effective, capabilities[index].permitted, capabilities[index].inheritable);
        }
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "serve") == 0) {
        uint16_t port;
        if (parse_port(argv[2], &port) != 0) return 64;
        return serve_probe(port);
    }
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
    fprintf(stderr, "usage: pi-tcp-gateway-probe parse [PORT...] | relay\n");
    return 64;
}
