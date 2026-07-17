#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <linux/unistd.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#ifndef SECCOMP_USER_NOTIF_FLAG_CONTINUE
#define SECCOMP_USER_NOTIF_FLAG_CONTINUE (1UL << 0)
#endif

#define MAX_ROOTS 64
#define MAX_PATH_ACCESSES 4
#define MAX_FILTER_INSTRUCTIONS 256
#define CONTROL_FD 3
#define ARRAY_LENGTH(items) (sizeof(items) / sizeof((items)[0]))

typedef struct {
    int event_fd;
    int decision_fd;
    char *writable_roots[MAX_ROOTS];
    size_t writable_root_count;
    char **command;
} outer_options;

typedef struct {
    const char *access_type;
    char path[PATH_MAX];
    int sandbox_private;
} path_access;

typedef struct {
    const char *syscall_name;
    const char *operation;
    path_access path_accesses[MAX_PATH_ACCESSES];
    size_t path_access_count;
    char destination[PATH_MAX];
    char detail[256];
} policy_event;

static void fatal(const char *message) {
    perror(message);
    exit(EXIT_FAILURE);
}

static void usage(FILE *stream) {
    fprintf(stream,
            "Usage: pi-sandbox-native --event-fd FD --decision-fd FD "
            "[--writable-root PATH ...] -- command [args...]\n");
}

static int parse_integer(const char *value, const char *name) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(value, &end, 10);
    if (errno != 0 || !end || *end != '\0' || parsed < 0 || parsed > INT32_MAX) {
        fprintf(stderr, "invalid %s: %s\n", name, value);
        exit(EXIT_FAILURE);
    }
    return (int) parsed;
}

static outer_options parse_outer_options(int argc, char **argv) {
    outer_options options = {.event_fd = -1, .decision_fd = -1};
    int index = 1;
    while (index < argc) {
        if (strcmp(argv[index], "--") == 0) {
            index++;
            break;
        }
        if (strcmp(argv[index], "--event-fd") == 0 && index + 1 < argc) {
            options.event_fd = parse_integer(argv[index + 1], "event fd");
            index += 2;
            continue;
        }
        if (strcmp(argv[index], "--decision-fd") == 0 && index + 1 < argc) {
            options.decision_fd = parse_integer(argv[index + 1], "decision fd");
            index += 2;
            continue;
        }
        if (strcmp(argv[index], "--writable-root") == 0 && index + 1 < argc) {
            if (options.writable_root_count == MAX_ROOTS) {
                fprintf(stderr, "too many writable roots\n");
                exit(EXIT_FAILURE);
            }
            options.writable_roots[options.writable_root_count++] = argv[index + 1];
            index += 2;
            continue;
        }
        usage(stderr);
        exit(EXIT_FAILURE);
    }
    if (options.event_fd < 0 || options.decision_fd < 0 || index >= argc) {
        usage(stderr);
        exit(EXIT_FAILURE);
    }
    options.command = &argv[index];
    return options;
}

static void send_descriptor(int socket_fd, int descriptor) {
    char marker = 'L';
    struct iovec iov = {.iov_base = &marker, .iov_len = sizeof(marker)};
    char control[CMSG_SPACE(sizeof(int))];
    memset(control, 0, sizeof(control));

    struct msghdr message = {0};
    message.msg_iov = &iov;
    message.msg_iovlen = 1;
    message.msg_control = control;
    message.msg_controllen = sizeof(control);

    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &descriptor, sizeof(descriptor));

    if (sendmsg(socket_fd, &message, 0) < 0) fatal("sendmsg listener descriptor");
}

static int receive_descriptor(int socket_fd) {
    char marker = 0;
    struct iovec iov = {.iov_base = &marker, .iov_len = sizeof(marker)};
    char control[CMSG_SPACE(sizeof(int))];
    memset(control, 0, sizeof(control));

    struct msghdr message = {0};
    message.msg_iov = &iov;
    message.msg_iovlen = 1;
    message.msg_control = control;
    message.msg_controllen = sizeof(control);

    if (recvmsg(socket_fd, &message, 0) < 0) fatal("recvmsg listener descriptor");
    for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header; header = CMSG_NXTHDR(&message, header)) {
        if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS) {
            int descriptor = -1;
            memcpy(&descriptor, CMSG_DATA(header), sizeof(descriptor));
            return descriptor;
        }
    }
    fprintf(stderr, "worker did not provide a seccomp listener descriptor\n");
    exit(EXIT_FAILURE);
}

static void add_statement(struct sock_filter *filter, size_t *length, uint16_t code, uint32_t value) {
    if (*length >= MAX_FILTER_INSTRUCTIONS) {
        fprintf(stderr, "seccomp filter is too large\n");
        exit(EXIT_FAILURE);
    }
    filter[(*length)++] = (struct sock_filter) {.code = code, .jt = 0, .jf = 0, .k = value};
}

static void add_jump(struct sock_filter *filter, size_t *length, uint16_t code, uint32_t value, uint8_t yes, uint8_t no) {
    if (*length >= MAX_FILTER_INSTRUCTIONS) {
        fprintf(stderr, "seccomp filter is too large\n");
        exit(EXIT_FAILURE);
    }
    filter[(*length)++] = (struct sock_filter) {.code = code, .jt = yes, .jf = no, .k = value};
}

static int install_notification_filter(void) {
    static const int notified_syscalls[] = {
#ifdef SYS_open
        SYS_open,
#endif
        SYS_openat,
#ifdef SYS_openat2
        SYS_openat2,
#endif
        SYS_execve,
#ifdef SYS_execveat
        SYS_execveat,
#endif
#ifdef SYS_stat
        SYS_stat,
#endif
#ifdef SYS_lstat
        SYS_lstat,
#endif
#ifdef SYS_newfstatat
        SYS_newfstatat,
#endif
#ifdef SYS_statx
        SYS_statx,
#endif
#ifdef SYS_access
        SYS_access,
#endif
#ifdef SYS_faccessat
        SYS_faccessat,
#endif
#ifdef SYS_faccessat2
        SYS_faccessat2,
#endif
#ifdef SYS_readlink
        SYS_readlink,
#endif
#ifdef SYS_readlinkat
        SYS_readlinkat,
#endif
        SYS_creat,
        SYS_truncate,
        SYS_ftruncate,
        SYS_mkdir,
        SYS_mkdirat,
        SYS_rmdir,
        SYS_unlink,
        SYS_unlinkat,
        SYS_rename,
        SYS_renameat,
#ifdef SYS_renameat2
        SYS_renameat2,
#endif
        SYS_link,
        SYS_linkat,
        SYS_symlink,
        SYS_symlinkat,
        SYS_chmod,
        SYS_fchmod,
        SYS_fchmodat,
#ifdef SYS_fchmodat2
        SYS_fchmodat2,
#endif
        SYS_mknod,
        SYS_mknodat,
        SYS_connect,
        SYS_sendto,
        SYS_sendmsg,
#ifdef SYS_sendmmsg
        SYS_sendmmsg,
#endif
        SYS_bind,
    };
    static const int denied_syscalls[] = {
#ifdef SYS_io_uring_setup
        SYS_io_uring_setup,
#endif
#ifdef SYS_open_by_handle_at
        SYS_open_by_handle_at,
#endif
#ifdef SYS_bpf
        SYS_bpf,
#endif
#ifdef SYS_ptrace
        SYS_ptrace,
#endif
#ifdef SYS_mount
        SYS_mount,
#endif
#ifdef SYS_umount2
        SYS_umount2,
#endif
#ifdef SYS_pivot_root
        SYS_pivot_root,
#endif
#ifdef SYS_setns
        SYS_setns,
#endif
#ifdef SYS_unshare
        SYS_unshare,
#endif
#ifdef SYS_process_vm_writev
        SYS_process_vm_writev,
#endif
    };

    struct sock_filter filter[MAX_FILTER_INSTRUCTIONS];
    size_t length = 0;
    add_statement(filter, &length, BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
    add_jump(filter, &length, BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
    add_statement(filter, &length, BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
    add_statement(filter, &length, BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));

#ifdef SYS_sendmsg
    /* The launcher must send the listener over CONTROL_FD after installing the filter. */
    add_jump(filter, &length, BPF_JMP | BPF_JEQ | BPF_K, SYS_sendmsg, 0, 4);
    add_statement(filter, &length, BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
    add_jump(filter, &length, BPF_JMP | BPF_JEQ | BPF_K, CONTROL_FD, 1, 0);
    add_statement(filter, &length, BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
    add_statement(filter, &length, BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
#endif

    for (size_t index = 0; index < ARRAY_LENGTH(notified_syscalls); index++) {
#ifdef SYS_sendmsg
        if (notified_syscalls[index] == SYS_sendmsg) continue;
#endif
        add_jump(filter, &length, BPF_JMP | BPF_JEQ | BPF_K, (uint32_t) notified_syscalls[index], 0, 1);
        add_statement(filter, &length, BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
    }
    for (size_t index = 0; index < ARRAY_LENGTH(denied_syscalls); index++) {
        add_jump(filter, &length, BPF_JMP | BPF_JEQ | BPF_K, (uint32_t) denied_syscalls[index], 0, 1);
        add_statement(filter, &length, BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
    }
    add_statement(filter, &length, BPF_RET | BPF_K, SECCOMP_RET_ALLOW);

    struct sock_fprog program = {.len = (unsigned short) length, .filter = filter};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fatal("prctl NO_NEW_PRIVS");
    int listener = (int) syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
    if (listener < 0) fatal("seccomp NEW_LISTENER");
    return listener;
}

static int connect_control_socket(const char *path) {
    int descriptor = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (descriptor < 0) fatal("create worker control socket");
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    if (snprintf(address.sun_path, sizeof(address.sun_path), "%s", path) >= (int) sizeof(address.sun_path)) {
        fprintf(stderr, "worker control socket path is too long\n");
        exit(EXIT_FAILURE);
    }
    if (connect(descriptor, (struct sockaddr *) &address, sizeof(address)) < 0) fatal("connect worker control socket");
    if (descriptor != CONTROL_FD) {
        if (dup2(descriptor, CONTROL_FD) < 0) fatal("dup2 worker control socket");
        close(descriptor);
    }
    return CONTROL_FD;
}

static int worker_main(int argc, char **argv) {
    if (argc < 4 || strcmp(argv[2], "--") != 0) {
        fprintf(stderr, "invalid inner worker invocation\n");
        return EXIT_FAILURE;
    }
    int control_fd = connect_control_socket(argv[1]);
    int listener = install_notification_filter();
    send_descriptor(control_fd, listener);
    close(listener);
    close(control_fd);
    execvp(argv[3], &argv[3]);
    fatal("exec worker command");
    return EXIT_FAILURE;
}

static ssize_t read_process_memory(pid_t pid, uint64_t address, void *output, size_t length) {
    struct iovec local = {.iov_base = output, .iov_len = length};
    struct iovec remote = {.iov_base = (void *) (uintptr_t) address, .iov_len = length};
    return process_vm_readv(pid, &local, 1, &remote, 1, 0);
}

static int read_process_string(pid_t pid, uint64_t address, char *output, size_t capacity) {
    if (address == 0 || capacity == 0) return -1;
    size_t written = 0;
    while (written + 1 < capacity) {
        size_t page_remaining = 4096 - (size_t) ((address + written) & 4095U);
        size_t chunk = capacity - written - 1;
        if (chunk > page_remaining) chunk = page_remaining;
        if (chunk > 256) chunk = 256;
        ssize_t count = read_process_memory(pid, address + written, output + written, chunk);
        if (count <= 0) return -1;
        for (ssize_t index = 0; index < count; index++) {
            if (output[written + (size_t) index] == '\0') return 0;
        }
        written += (size_t) count;
    }
    output[capacity - 1] = '\0';
    return -1;
}

static int read_link_value(const char *path, char *output, size_t capacity) {
    ssize_t count = readlink(path, output, capacity - 1);
    if (count < 0 || (size_t) count >= capacity - 1) return -1;
    output[count] = '\0';
    return 0;
}

static int normalize_lexical_path(const char *input, char *output, size_t capacity) {
    if (!input || input[0] != '/') return -1;
    char copy[PATH_MAX];
    if (snprintf(copy, sizeof(copy), "%s", input) >= (int) sizeof(copy)) return -1;

    const char *parts[PATH_MAX / 2];
    size_t count = 0;
    char *save = NULL;
    for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
        if (strcmp(part, ".") == 0 || part[0] == '\0') continue;
        if (strcmp(part, "..") == 0) {
            if (count > 0) count--;
            continue;
        }
        parts[count++] = part;
    }

    size_t used = 0;
    if (capacity < 2) return -1;
    output[used++] = '/';
    output[used] = '\0';
    for (size_t index = 0; index < count; index++) {
        size_t part_length = strlen(parts[index]);
        if (used + part_length + (index + 1 < count ? 1 : 0) >= capacity) return -1;
        memcpy(output + used, parts[index], part_length);
        used += part_length;
        if (index + 1 < count) output[used++] = '/';
        output[used] = '\0';
    }
    return 0;
}

static int resolve_requested_path(pid_t pid, int dirfd, const char *requested, char *output, size_t capacity) {
    char combined[PATH_MAX];
    if (requested[0] == '/') {
        if (snprintf(combined, sizeof(combined), "%s", requested) >= (int) sizeof(combined)) return -1;
    } else {
        char proc_path[128];
        char base[PATH_MAX];
        if (dirfd == AT_FDCWD) snprintf(proc_path, sizeof(proc_path), "/proc/%d/cwd", pid);
        else snprintf(proc_path, sizeof(proc_path), "/proc/%d/fd/%d", pid, dirfd);
        if (read_link_value(proc_path, base, sizeof(base)) < 0) return -1;
        if (snprintf(combined, sizeof(combined), "%s/%s", base, requested) >= (int) sizeof(combined)) return -1;
    }

    char lexical[PATH_MAX];
    if (normalize_lexical_path(combined, lexical, sizeof(lexical)) < 0) return -1;
    char physical[PATH_MAX];
    if (realpath(lexical, physical)) {
        if (snprintf(output, capacity, "%s", physical) >= (int) capacity) return -1;
        return 0;
    }

    char parent[PATH_MAX];
    char leaf[PATH_MAX];
    const char *slash = strrchr(lexical, '/');
    if (!slash) return -1;
    if (slash == lexical) {
        snprintf(parent, sizeof(parent), "/");
    } else {
        size_t parent_length = (size_t) (slash - lexical);
        if (parent_length >= sizeof(parent)) return -1;
        memcpy(parent, lexical, parent_length);
        parent[parent_length] = '\0';
    }
    if (snprintf(leaf, sizeof(leaf), "%s", slash + 1) >= (int) sizeof(leaf)) return -1;
    if (!realpath(parent, physical)) {
        return snprintf(output, capacity, "%s", lexical) < (int) capacity ? 0 : -1;
    }
    if (snprintf(output, capacity, "%s%s%s", physical, strcmp(physical, "/") == 0 ? "" : "/", leaf) >= (int) capacity) {
        return -1;
    }
    return 0;
}

static int resolve_fd_path(pid_t pid, int fd, char *output, size_t capacity) {
    char proc_path[128];
    snprintf(proc_path, sizeof(proc_path), "/proc/%d/fd/%d", pid, fd);
    return read_link_value(proc_path, output, capacity);
}

static int is_sandbox_private_path(const char *path) {
    return strcmp(path, "/tmp") == 0 || strncmp(path, "/tmp/", 5) == 0;
}

static int path_from_argument(const struct seccomp_notif *request, int dirfd_index, int path_index, char *output) {
    int dirfd = dirfd_index < 0 ? AT_FDCWD : (int) (int64_t) request->data.args[dirfd_index];
    uint64_t address = request->data.args[path_index];
    if (address == 0) {
        return dirfd_index >= 0 && dirfd != AT_FDCWD
            ? resolve_fd_path((pid_t) request->pid, dirfd, output, PATH_MAX)
            : -1;
    }

    char raw[PATH_MAX];
    if (read_process_string((pid_t) request->pid, address, raw, sizeof(raw)) < 0) return -1;
    if (raw[0] == '\0') {
        return dirfd_index >= 0 && dirfd != AT_FDCWD
            ? resolve_fd_path((pid_t) request->pid, dirfd, output, PATH_MAX)
            : -1;
    }
    return resolve_requested_path((pid_t) request->pid, dirfd, raw, output, PATH_MAX);
}

static int write_capable_flags(uint64_t flags) {
    int access = (int) flags & O_ACCMODE;
    if (access == O_WRONLY || access == O_RDWR) return 1;
    uint64_t effects = O_CREAT | O_TRUNC | O_APPEND;
#ifdef O_TMPFILE
    effects |= O_TMPFILE;
#endif
    return (flags & effects) != 0;
}

static void initialize_event(policy_event *event, const char *syscall_name, const char *operation) {
    memset(event, 0, sizeof(*event));
    event->syscall_name = syscall_name;
    event->operation = operation;
}

static int add_path_access(policy_event *event, const char *access_type, const char *path) {
    if (event->path_access_count >= ARRAY_LENGTH(event->path_accesses)) return -1;
    path_access *access = &event->path_accesses[event->path_access_count++];
    access->access_type = access_type;
    access->sandbox_private = is_sandbox_private_path(path);
    return snprintf(access->path, sizeof(access->path), "%s", path) < (int) sizeof(access->path) ? 0 : -1;
}

static int add_path_argument(
    policy_event *event,
    const struct seccomp_notif *request,
    int dirfd_index,
    int path_index,
    const char *access_type
) {
    char resolved[PATH_MAX];
    if (path_from_argument(request, dirfd_index, path_index, resolved) < 0) return -1;
    return add_path_access(event, access_type, resolved);
}

static int add_fd_path(policy_event *event, const struct seccomp_notif *request, int fd_index, const char *access_type) {
    char resolved[PATH_MAX];
    if (resolve_fd_path((pid_t) request->pid, (int) request->data.args[fd_index], resolved, sizeof(resolved)) < 0) return -1;
    return add_path_access(event, access_type, resolved);
}

static int add_open_path_accesses(
    policy_event *event,
    const struct seccomp_notif *request,
    int dirfd_index,
    int path_index,
    uint64_t flags
) {
    char resolved[PATH_MAX];
    if (path_from_argument(request, dirfd_index, path_index, resolved) < 0) return -1;

    int access_mode = (int) flags & O_ACCMODE;
    if ((access_mode == O_RDONLY || access_mode == O_RDWR) && add_path_access(event, "READ", resolved) < 0) return -1;
    if (write_capable_flags(flags) && add_path_access(event, "WRITE", resolved) < 0) return -1;
    return event->path_access_count > 0 ? 0 : -1;
}

static int decode_socket_address(pid_t pid, uint64_t pointer, uint64_t length, char *output, size_t capacity) {
    if (pointer == 0 || length < sizeof(sa_family_t)) return -1;
    struct sockaddr_storage storage;
    memset(&storage, 0, sizeof(storage));
    size_t read_length = length < sizeof(storage) ? (size_t) length : sizeof(storage);
    if (read_process_memory(pid, pointer, &storage, read_length) != (ssize_t) read_length) return -1;

    if (storage.ss_family == AF_INET && read_length >= sizeof(struct sockaddr_in)) {
        const struct sockaddr_in *address = (const struct sockaddr_in *) &storage;
        char host[INET_ADDRSTRLEN];
        if (!inet_ntop(AF_INET, &address->sin_addr, host, sizeof(host))) return -1;
        return snprintf(output, capacity, "%s:%u", host, (unsigned) ntohs(address->sin_port)) < (int) capacity ? 0 : -1;
    }
    if (storage.ss_family == AF_INET6 && read_length >= sizeof(struct sockaddr_in6)) {
        const struct sockaddr_in6 *address = (const struct sockaddr_in6 *) &storage;
        char host[INET6_ADDRSTRLEN];
        if (!inet_ntop(AF_INET6, &address->sin6_addr, host, sizeof(host))) return -1;
        return snprintf(output, capacity, "[%s]:%u", host, (unsigned) ntohs(address->sin6_port)) < (int) capacity ? 0 : -1;
    }
    if (storage.ss_family == AF_UNIX && read_length >= offsetof(struct sockaddr_un, sun_path) + 1) {
        const struct sockaddr_un *address = (const struct sockaddr_un *) &storage;
        size_t available = read_length - offsetof(struct sockaddr_un, sun_path);
        if (address->sun_path[0] == '\0') {
            return snprintf(output, capacity, "unix:@%.*s", (int) (available > 0 ? available - 1 : 0), address->sun_path + 1) < (int) capacity ? 0 : -1;
        }
        return snprintf(output, capacity, "unix:%.*s", (int) available, address->sun_path) < (int) capacity ? 0 : -1;
    }
    return -1;
}

/* Returns 1 for a policy event, 0 for a notified operation with no new resource access, and -1 when decoding fails. */
static int classify_request(const struct seccomp_notif *request, policy_event *event) {
    int syscall_number = request->data.nr;

#ifdef SYS_open
    if (syscall_number == SYS_open) {
        initialize_event(event, "open", "FILESYSTEM");
        return add_open_path_accesses(event, request, -1, 0, request->data.args[1]) == 0 ? 1 : -1;
    }
#endif
    if (syscall_number == SYS_openat) {
        initialize_event(event, "openat", "FILESYSTEM");
        return add_open_path_accesses(event, request, 0, 1, request->data.args[2]) == 0 ? 1 : -1;
    }
#ifdef SYS_openat2
    if (syscall_number == SYS_openat2) {
        struct open_how how;
        memset(&how, 0, sizeof(how));
        size_t size = request->data.args[3] < sizeof(how) ? (size_t) request->data.args[3] : sizeof(how);
        if (size == 0 || read_process_memory((pid_t) request->pid, request->data.args[2], &how, size) != (ssize_t) size) return -1;
        initialize_event(event, "openat2", "FILESYSTEM");
        return add_open_path_accesses(event, request, 0, 1, how.flags) == 0 ? 1 : -1;
    }
#endif

#define ONE_PATH_ACCESS_SYSCALL(number, name, dir_index, path_index, access_type) \
    if (syscall_number == (number)) { \
        initialize_event(event, (name), "FILESYSTEM"); \
        return add_path_argument(event, request, (dir_index), (path_index), (access_type)) == 0 ? 1 : -1; \
    }
#define FD_PATH_ACCESS_SYSCALL(number, name, fd_index, access_type) \
    if (syscall_number == (number)) { \
        initialize_event(event, (name), "FILESYSTEM"); \
        return add_fd_path(event, request, (fd_index), (access_type)) == 0 ? 1 : -1; \
    }
#define TWO_PATH_ACCESS_SYSCALL(number, name, first_dir, first_path, first_access, second_dir, second_path, second_access) \
    if (syscall_number == (number)) { \
        initialize_event(event, (name), "FILESYSTEM"); \
        if (add_path_argument(event, request, (first_dir), (first_path), (first_access)) < 0) return -1; \
        return add_path_argument(event, request, (second_dir), (second_path), (second_access)) == 0 ? 1 : -1; \
    }

    ONE_PATH_ACCESS_SYSCALL(SYS_execve, "execve", -1, 0, "EXECUTE")
#ifdef SYS_execveat
    ONE_PATH_ACCESS_SYSCALL(SYS_execveat, "execveat", 0, 1, "EXECUTE")
#endif
#ifdef SYS_stat
    ONE_PATH_ACCESS_SYSCALL(SYS_stat, "stat", -1, 0, "READ")
#endif
#ifdef SYS_lstat
    ONE_PATH_ACCESS_SYSCALL(SYS_lstat, "lstat", -1, 0, "READ")
#endif
#ifdef SYS_newfstatat
    ONE_PATH_ACCESS_SYSCALL(SYS_newfstatat, "newfstatat", 0, 1, "READ")
#endif
#ifdef SYS_statx
    ONE_PATH_ACCESS_SYSCALL(SYS_statx, "statx", 0, 1, "READ")
#endif
#ifdef SYS_access
    ONE_PATH_ACCESS_SYSCALL(SYS_access, "access", -1, 0, "READ")
#endif
#ifdef SYS_faccessat
    ONE_PATH_ACCESS_SYSCALL(SYS_faccessat, "faccessat", 0, 1, "READ")
#endif
#ifdef SYS_faccessat2
    ONE_PATH_ACCESS_SYSCALL(SYS_faccessat2, "faccessat2", 0, 1, "READ")
#endif
#ifdef SYS_readlink
    ONE_PATH_ACCESS_SYSCALL(SYS_readlink, "readlink", -1, 0, "READ")
#endif
#ifdef SYS_readlinkat
    ONE_PATH_ACCESS_SYSCALL(SYS_readlinkat, "readlinkat", 0, 1, "READ")
#endif

    ONE_PATH_ACCESS_SYSCALL(SYS_creat, "creat", -1, 0, "WRITE")
    ONE_PATH_ACCESS_SYSCALL(SYS_truncate, "truncate", -1, 0, "WRITE")
    FD_PATH_ACCESS_SYSCALL(SYS_ftruncate, "ftruncate", 0, "WRITE")
    ONE_PATH_ACCESS_SYSCALL(SYS_mkdir, "mkdir", -1, 0, "WRITE")
    ONE_PATH_ACCESS_SYSCALL(SYS_mkdirat, "mkdirat", 0, 1, "WRITE")
    ONE_PATH_ACCESS_SYSCALL(SYS_rmdir, "rmdir", -1, 0, "DELETE")
    ONE_PATH_ACCESS_SYSCALL(SYS_unlink, "unlink", -1, 0, "DELETE")
    ONE_PATH_ACCESS_SYSCALL(SYS_unlinkat, "unlinkat", 0, 1, "DELETE")
    TWO_PATH_ACCESS_SYSCALL(SYS_rename, "rename", -1, 0, "DELETE", -1, 1, "WRITE")
    TWO_PATH_ACCESS_SYSCALL(SYS_renameat, "renameat", 0, 1, "DELETE", 2, 3, "WRITE")
#ifdef SYS_renameat2
    TWO_PATH_ACCESS_SYSCALL(SYS_renameat2, "renameat2", 0, 1, "DELETE", 2, 3, "WRITE")
#endif
    TWO_PATH_ACCESS_SYSCALL(SYS_link, "link", -1, 0, "READ", -1, 1, "WRITE")
    TWO_PATH_ACCESS_SYSCALL(SYS_linkat, "linkat", 0, 1, "READ", 2, 3, "WRITE")
    ONE_PATH_ACCESS_SYSCALL(SYS_symlink, "symlink", -1, 1, "WRITE")
    ONE_PATH_ACCESS_SYSCALL(SYS_symlinkat, "symlinkat", 1, 2, "WRITE")
    ONE_PATH_ACCESS_SYSCALL(SYS_chmod, "chmod", -1, 0, "WRITE")
    FD_PATH_ACCESS_SYSCALL(SYS_fchmod, "fchmod", 0, "WRITE")
    ONE_PATH_ACCESS_SYSCALL(SYS_fchmodat, "fchmodat", 0, 1, "WRITE")
#ifdef SYS_fchmodat2
    ONE_PATH_ACCESS_SYSCALL(SYS_fchmodat2, "fchmodat2", 0, 1, "WRITE")
#endif
    ONE_PATH_ACCESS_SYSCALL(SYS_mknod, "mknod", -1, 0, "WRITE")
    ONE_PATH_ACCESS_SYSCALL(SYS_mknodat, "mknodat", 0, 1, "WRITE")

#undef ONE_PATH_ACCESS_SYSCALL
#undef FD_PATH_ACCESS_SYSCALL
#undef TWO_PATH_ACCESS_SYSCALL

    if (syscall_number == SYS_connect || syscall_number == SYS_bind) {
        initialize_event(event, syscall_number == SYS_connect ? "connect" : "bind", "CONNECT");
        if (decode_socket_address((pid_t) request->pid, request->data.args[1], request->data.args[2], event->destination, sizeof(event->destination)) < 0) return -1;
        return 1;
    }
    if (syscall_number == SYS_sendto) {
        if (request->data.args[4] == 0) return 0;
        initialize_event(event, "sendto", "CONNECT");
        if (decode_socket_address((pid_t) request->pid, request->data.args[4], request->data.args[5], event->destination, sizeof(event->destination)) < 0) return -1;
        return 1;
    }
#ifdef SYS_sendmmsg
    if (syscall_number == SYS_sendmmsg) {
        initialize_event(event, "sendmmsg", "UNKNOWN");
        snprintf(event->detail, sizeof(event->detail), "sendmmsg is denied because batch destinations are not decoded");
        return 1;
    }
#endif
    if (syscall_number == SYS_sendmsg) {
        struct msghdr message;
        if (read_process_memory((pid_t) request->pid, request->data.args[1], &message, sizeof(message)) != (ssize_t) sizeof(message)) return -1;
        if (!message.msg_name) return 0;
        initialize_event(event, "sendmsg", "CONNECT");
        if (decode_socket_address((pid_t) request->pid, (uint64_t) (uintptr_t) message.msg_name, message.msg_namelen, event->destination, sizeof(event->destination)) < 0) return -1;
        return 1;
    }

    return -1;
}

static void write_json_string(FILE *stream, const char *value) {
    fputc('"', stream);
    for (const unsigned char *cursor = (const unsigned char *) value; *cursor; cursor++) {
        switch (*cursor) {
            case '"': fputs("\\\"", stream); break;
            case '\\': fputs("\\\\", stream); break;
            case '\b': fputs("\\b", stream); break;
            case '\f': fputs("\\f", stream); break;
            case '\n': fputs("\\n", stream); break;
            case '\r': fputs("\\r", stream); break;
            case '\t': fputs("\\t", stream); break;
            default:
                if (*cursor < 0x20) fprintf(stream, "\\u%04x", *cursor);
                else fputc(*cursor, stream);
        }
    }
    fputc('"', stream);
}

static void send_policy_event(FILE *stream, uint64_t sequence, const struct seccomp_notif *request, const policy_event *event) {
    fprintf(stream, "{\"version\":2,\"sequence\":%llu,\"pid\":%u,\"syscall\":", (unsigned long long) sequence, request->pid);
    write_json_string(stream, event->syscall_name ? event->syscall_name : "unknown");
    fputs(",\"operation\":", stream);
    write_json_string(stream, event->operation ? event->operation : "UNKNOWN");
    fputs(",\"pathAccesses\":[", stream);
    for (size_t index = 0; index < event->path_access_count; index++) {
        const path_access *access = &event->path_accesses[index];
        if (index > 0) fputc(',', stream);
        fputs("{\"access\":", stream);
        write_json_string(stream, access->access_type);
        fputs(",\"path\":", stream);
        write_json_string(stream, access->path);
        fprintf(stream, ",\"sandboxPrivate\":%s}", access->sandbox_private ? "true" : "false");
    }
    fputc(']', stream);
    if (event->destination[0] != '\0') {
        fputs(",\"destination\":", stream);
        write_json_string(stream, event->destination);
    }
    if (event->detail[0] != '\0') {
        fputs(",\"detail\":", stream);
        write_json_string(stream, event->detail);
    }
    fputs("}\n", stream);
    fflush(stream);
}

static int read_policy_decision(FILE *stream) {
    char *line = NULL;
    size_t capacity = 0;
    ssize_t length = getline(&line, &capacity, stream);
    if (length < 0) {
        free(line);
        return 0;
    }
    while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) line[--length] = '\0';
    int allowed = strcmp(line, "ALLOW") == 0;
    free(line);
    return allowed;
}

static int respond_to_notification(int listener, const struct seccomp_notif *request, int allowed) {
    uint64_t id = request->id;
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &id) < 0) return -1;
    struct seccomp_notif_resp response;
    memset(&response, 0, sizeof(response));
    response.id = request->id;
    if (allowed) response.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
    else response.error = -EPERM;
    return ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response);
}

static int supervise_notifications(int listener, pid_t child, int event_fd, int decision_fd) {
    FILE *events = fdopen(event_fd, "w");
    FILE *decisions = fdopen(decision_fd, "r");
    if (!events || !decisions) fatal("fdopen policy protocol");
    setvbuf(events, NULL, _IOLBF, 0);

    uint64_t sequence = 0;
    int child_status = 0;
    int child_exited = 0;
    while (!child_exited) {
        pid_t waited = waitpid(child, &child_status, WNOHANG);
        if (waited == child) {
            child_exited = 1;
            break;
        }
        if (waited < 0 && errno != EINTR) fatal("waitpid");

        struct pollfd poll_descriptor = {.fd = listener, .events = POLLIN};
        int ready = poll(&poll_descriptor, 1, 100);
        if (ready < 0) {
            if (errno == EINTR) continue;
            fatal("poll seccomp listener");
        }
        if (ready == 0) continue;

        struct seccomp_notif request;
        memset(&request, 0, sizeof(request));
        if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request) < 0) {
            if (errno == EINTR || errno == ENOENT) continue;
            fatal("seccomp notification receive");
        }

        policy_event event;
        int classification = classify_request(&request, &event);
        if (classification == 0) {
            if (respond_to_notification(listener, &request, 1) < 0 && errno != ENOENT) fatal("continue unmediated syscall");
            continue;
        }
        if (classification < 0) {
            initialize_event(&event, "unknown", "UNKNOWN");
            snprintf(event.detail, sizeof(event.detail), "could not safely decode syscall %d", request.data.nr);
        }

        send_policy_event(events, ++sequence, &request, &event);
        int allowed = read_policy_decision(decisions);
        if (respond_to_notification(listener, &request, allowed) < 0 && errno != ENOENT) fatal("send seccomp decision");
    }

    if (!child_exited) {
        while (waitpid(child, &child_status, 0) < 0) {
            if (errno != EINTR) fatal("waitpid final");
        }
    }
    fclose(events);
    fclose(decisions);
    if (WIFEXITED(child_status)) return WEXITSTATUS(child_status);
    if (WIFSIGNALED(child_status)) {
        fprintf(stderr, "sandbox worker terminated by signal %d\n", WTERMSIG(child_status));
        return 128 + WTERMSIG(child_status);
    }
    return EXIT_FAILURE;
}

static char **build_bwrap_arguments(const outer_options *options, const char *self_path, const char *cwd, const char *control_path) {
    size_t command_count = 0;
    for (char **argument = options->command; *argument; argument++) command_count++;
    size_t capacity = 48 + options->writable_root_count * 3 + command_count;
    char **arguments = calloc(capacity, sizeof(char *));
    if (!arguments) fatal("calloc bwrap arguments");
    size_t count = 0;
#define PUSH(value) do { \
    if (count + 1 >= capacity) { fprintf(stderr, "internal bwrap argument overflow\n"); exit(EXIT_FAILURE); } \
    arguments[count++] = (char *) (value); \
} while (0)
    PUSH("/usr/bin/bwrap");
    PUSH("--ro-bind"); PUSH("/"); PUSH("/");
    PUSH("--dev"); PUSH("/dev");
    PUSH("--proc"); PUSH("/proc");
    PUSH("--tmpfs"); PUSH("/tmp");
    PUSH("--unshare-user");
    PUSH("--unshare-pid");
    PUSH("--unshare-ipc");
    PUSH("--unshare-uts");
    PUSH("--die-with-parent");
    PUSH("--new-session");
    PUSH("--hostname"); PUSH("pi-sandbox");
    PUSH("--chdir"); PUSH(cwd);
    for (size_t index = 0; index < options->writable_root_count; index++) {
        PUSH("--bind");
        PUSH(options->writable_roots[index]);
        PUSH(options->writable_roots[index]);
    }
    PUSH(self_path);
    PUSH("--worker-socket");
    PUSH(control_path);
    PUSH("--");
    for (char **argument = options->command; *argument; argument++) PUSH(*argument);
    arguments[count] = NULL;
#undef PUSH
    return arguments;
}

static int create_control_server(const char *path) {
    int descriptor = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (descriptor < 0) fatal("create control server socket");
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    if (snprintf(address.sun_path, sizeof(address.sun_path), "%s", path) >= (int) sizeof(address.sun_path)) {
        fprintf(stderr, "control server socket path is too long\n");
        exit(EXIT_FAILURE);
    }
    unlink(path);
    if (bind(descriptor, (struct sockaddr *) &address, sizeof(address)) < 0) fatal("bind control server socket");
    if (chmod(path, 0600) < 0) fatal("chmod control server socket");
    if (listen(descriptor, 1) < 0) fatal("listen control server socket");
    return descriptor;
}

static int wait_for_worker_connection(int server, pid_t child, int *early_status) {
    for (;;) {
        struct pollfd descriptor = {.fd = server, .events = POLLIN};
        int ready = poll(&descriptor, 1, 100);
        if (ready < 0 && errno != EINTR) fatal("poll control server");
        if (ready > 0) {
            int connection = accept4(server, NULL, NULL, SOCK_CLOEXEC);
            if (connection < 0) fatal("accept worker control connection");
            return connection;
        }
        pid_t waited = waitpid(child, early_status, WNOHANG);
        if (waited == child) return -1;
        if (waited < 0 && errno != EINTR) fatal("waitpid before worker connection");
    }
}

static int outer_main(int argc, char **argv) {
    pid_t trusted_parent = getppid();
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) fatal("prctl parent death signal");
    if (getppid() != trusted_parent) return EXIT_FAILURE;
    outer_options options = parse_outer_options(argc, argv);
    char self_path[PATH_MAX];
    if (read_link_value("/proc/self/exe", self_path, sizeof(self_path)) < 0) fatal("read /proc/self/exe");
    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof(cwd))) fatal("getcwd");
    char control_path[sizeof(((struct sockaddr_un *) 0)->sun_path)];
    if (snprintf(control_path, sizeof(control_path), "%s.control.%d", self_path, getpid()) >= (int) sizeof(control_path)) {
        fprintf(stderr, "control socket path is too long\n");
        return EXIT_FAILURE;
    }
    int control_server = create_control_server(control_path);

    pid_t child = fork();
    if (child < 0) fatal("fork");
    if (child == 0) {
        close(control_server);
        close(options.event_fd);
        close(options.decision_fd);
        char **bwrap_arguments = build_bwrap_arguments(&options, self_path, cwd, control_path);
        execv(bwrap_arguments[0], bwrap_arguments);
        fatal("exec bubblewrap");
    }

    int early_status = 0;
    int control = wait_for_worker_connection(control_server, child, &early_status);
    close(control_server);
    unlink(control_path);
    if (control < 0) {
        if (WIFEXITED(early_status)) return WEXITSTATUS(early_status);
        if (WIFSIGNALED(early_status)) return 128 + WTERMSIG(early_status);
        return EXIT_FAILURE;
    }
    int listener = receive_descriptor(control);
    close(control);
    int status = supervise_notifications(listener, child, options.event_fd, options.decision_fd);
    close(listener);
    return status;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "--worker-socket") == 0) return worker_main(argc - 1, argv + 1);
    return outer_main(argc, argv);
}
