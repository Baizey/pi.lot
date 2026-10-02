/* Exercise the actual callbacks without starting a FUSE mount. */
#define main pi_fuse_program_main
#include "../../native/pi-fuse.c"
#undef main

static struct fuse_context probe_context;

struct fuse_context *fuse_get_context(void) {
    return &probe_context;
}

int main(int argc, char **argv) {
    if (argc < 5) return 64;
    static benchmark_filesystem_t state;
    state.request_fd = 3;
    state.response_fd = 4;
    state.ready_fd = -1;
    signal(SIGPIPE, SIG_IGN);
    if (strlen(argv[1]) >= sizeof(state.snapshot_path)
        || strlen(argv[2]) >= sizeof(state.hidden_path)) return 64;
    strcpy(state.snapshot_path, argv[1]);
    strcpy(state.hidden_path, argv[2]);
    if (make_nonblocking(state.request_fd) != 0
        || make_nonblocking(state.response_fd) != 0
        || load_policy_snapshot(state.snapshot_path, &state.base_snapshot,
            &state.base_snapshot_file_status) != 0
        || receive_initial_once_snapshot(&state) != 0
        || pthread_mutex_init(&state.policy_mutex, NULL) != 0) return 64;
    state.base_snapshot_file_status_valid = true;
    probe_context.private_data = &state;

    struct fuse_operations operations = filesystem_operations();
    struct fuse_file_info info = {0};
    info.fh = UINT64_MAX;
    /* A denial must leave these untouched rather than expose a cached handle. */
    info.direct_io = 1;
    info.keep_cache = 1;
    int result;
    int descriptor_flags = -1;
    int status_flags = -1;
    int first_write = -1;
    int second_write = -1;
    char read_value[64] = {0};
    char retained_value[64] = {0};
    if (strcmp(argv[3], "disconnect") == 0 && argc == 6) {
        bool opening = strcmp(argv[5], "open") == 0;
        if (!opening && strcmp(argv[5], "read") != 0
            && strcmp(argv[5], "write") != 0 && strcmp(argv[5], "truncate") != 0) return 64;
        info.flags = opening ? O_RDONLY : O_RDWR;
        if (!opening && operations.open(argv[4], &info) != 0) return 65;
        /* Node's stdio pipes are Unix sockets. Shut down the live controller
         * receive side so policy checkpoints observe genuine kernel EOF. */
        if (shutdown(state.response_fd, SHUT_RD) != 0) return 65;
        if (opening) {
            result = operations.open(argv[4], &info);
            if (result == 0 && operations.release(argv[4], &info) != 0) return 65;
        } else {
            if (strcmp(argv[5], "read") == 0) {
                result = operations.read(argv[4], read_value, sizeof(read_value) - 1, 0, &info);
            } else if (strcmp(argv[5], "write") == 0) {
                result = operations.write(argv[4], "X", 1, 0, &info);
            } else {
                result = operations.ftruncate(argv[4], 2, &info);
            }
            if (pread((int) info.fh, retained_value, sizeof(retained_value) - 1, 0) < 0
                || operations.release(argv[4], &info) != 0) return 65;
        }
    } else if (strcmp(argv[3], "handle") == 0 && argc == 8) {
        info.flags = O_RDWR;
        if (operations.open(argv[4], &info) != 0) return 65;
        int retained_fd = (int) info.fh;
        if (strcmp(argv[7], "replace") == 0) {
            if (rename(argv[4], argv[5]) != 0) return 65;
            int replacement = open(argv[4], O_CREAT | O_EXCL | O_WRONLY, 0600);
            if (replacement < 0 || write_exact(replacement, "replacement", 11) != 0
                || close(replacement) != 0) return 65;
        } else if (strcmp(argv[7], "missing") == 0) {
            if (unlink(argv[4]) != 0) return 65;
        } else if (strcmp(argv[7], "invalid") == 0 || strcmp(argv[7], "closed") == 0) {
            if (close(retained_fd) != 0) return 65;
            if (strcmp(argv[7], "invalid") == 0) info.fh = UINT64_MAX;
        } else if (strcmp(argv[7], "same") == 0) {
            int external = open(argv[4], O_WRONLY | O_APPEND);
            if (external < 0 || write_exact(external, "!", 1) != 0
                || close(external) != 0) return 65;
        } else return 64;
        if (strcmp(argv[6], "read") == 0) {
            result = operations.read(argv[4], read_value, sizeof(read_value) - 1, 0, &info);
        } else if (strcmp(argv[6], "write") == 0) {
            result = operations.write(argv[4], "X", 1, 0, &info);
        } else if (strcmp(argv[6], "truncate") == 0) {
            result = operations.ftruncate(argv[4], 2, &info);
        } else return 64;
        if (strcmp(argv[7], "invalid") != 0 && strcmp(argv[7], "closed") != 0) {
            if (pread(retained_fd, retained_value, sizeof(retained_value) - 1, 0) < 0
                || operations.release(argv[4], &info) != 0) return 65;
        }
    } else if (strcmp(argv[3], "link") == 0 && argc == 6) {
        result = operations.link(argv[4], argv[5]);
    } else if ((strcmp(argv[3], "create") == 0 || strcmp(argv[3], "open") == 0
        || strcmp(argv[3], "create-append") == 0) && argc == 6) {
        info.flags = atoi(argv[5]);
        result = strcmp(argv[3], "open") == 0
            ? operations.open(argv[4], &info)
            : operations.create(argv[4], 0600, &info);
        if (result == 0) {
            status_flags = fcntl((int) info.fh, F_GETFL);
            descriptor_flags = fcntl((int) info.fh, F_GETFD);
            if (strcmp(argv[3], "create-append") == 0) {
                first_write = operations.write(argv[4], "a", 1, 0, &info);
                second_write = operations.write(argv[4], "b", 1, 0, &info);
            }
            if (operations.release(argv[4], &info) != 0) return 65;
        }
    } else if (strcmp(argv[3], "setxattr") == 0 && argc == 7) {
        result = operations.setxattr(argv[4], "user.pilot_callback_probe", argv[6],
            strlen(argv[6]), atoi(argv[5]));
    } else if (strcmp(argv[3], "getxattr") == 0 && argc == 5) {
        char value[64] = {0};
        result = operations.getxattr(argv[4], "user.pilot_callback_probe", value, sizeof(value) - 1);
        /* Fixtures use simple ASCII values only. */
        printf("{\"result\":%d,\"value\":\"%s\"}\n", result, result < 0 ? "" : value);
        goto complete;
    } else {
        return 64;
    }
    printf("{\"result\":%d,\"statusFlags\":%d,\"descriptorFlags\":%d,"
        "\"directIo\":%u,\"keepCache\":%u,\"handleAssigned\":%s,"
        "\"firstWrite\":%d,\"secondWrite\":%d,\"readValue\":\"%s\",\"retainedValue\":\"%s\"}\n",
        result, status_flags, descriptor_flags, info.direct_io, info.keep_cache,
        info.fh == UINT64_MAX ? "false" : "true", first_write, second_write,
        result < 0 ? "" : read_value, retained_value);

complete:
    destroy_policy_snapshot(&state.base_snapshot);
    destroy_policy_snapshot(&state.once_snapshot);
    pthread_mutex_destroy(&state.policy_mutex);
    close(state.request_fd);
    close(state.response_fd);
    return 0;
}
