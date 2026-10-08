/* Exercise the actual callbacks without starting a FUSE mount. */
#include "native-fuse-probe.h"
/* Fixture setup writes are not filesystem algorithms. */
static int write_exact(int descriptor, const void *buffer, size_t size) {
    const unsigned char *bytes = buffer;
    size_t offset = 0;
    while (offset < size) {
        ssize_t result = write(descriptor, bytes + offset, size - offset);
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0) return -1;
        offset += (size_t) result;
    }
    return 0;
}

static struct fuse_context probe_context;
static uint64_t unset_requested_flags;

/* The real helper also updates its enclosing private fuse_session. This
 * mount-free fixture has no session, so mock only the public flag contract. */
void fuse_unset_feature_flag(struct fuse_conn_info *connection, uint64_t flag) {
    unset_requested_flags |= flag;
    connection->want &= ~(uint32_t) flag;
    connection->want_ext &= ~flag;
}

typedef struct {
    unsigned int entries;
    off_t offset;
    bool name_only;
    bool stopped;
} probe_directory_t;

static int probe_fill_directory(void *buffer, const char *name, const struct stat *attributes,
    off_t offset, enum fuse_fill_dir_flags flags) {
    (void) name;
    probe_directory_t *directory = buffer;
    directory->name_only = directory->name_only && attributes == NULL && flags == 0;
    if (directory->entries == 1 && !directory->stopped) {
        directory->stopped = true;
        return 1;
    }
    directory->entries++;
    directory->offset = offset;
    return 0;
}

typedef struct {
    char names[64][256];
    unsigned int count;
    bool name_only;
} probe_names_t;

static int probe_fill_names(void *buffer, const char *name, const struct stat *attributes,
    off_t offset, enum fuse_fill_dir_flags flags) {
    (void) offset;
    probe_names_t *directory = buffer;
    directory->name_only = directory->name_only && attributes == NULL && flags == 0;
    if (directory->count == 64 || strlen(name) >= sizeof(directory->names[0])) return 1;
    strcpy(directory->names[directory->count++], name);
    return 0;
}

static void probe_print_hex(const char *bytes, size_t size) {
    for (size_t index = 0; index < size; index++) printf("%02x", (unsigned char) bytes[index]);
}

struct fuse_context *fuse_get_context(void) {
    return &probe_context;
}

static int probe_operations(void) {
    struct probe_operations_storage {
        uint64_t before[2];
        struct fuse_operations operations;
        uint64_t after[2];
    } guarded;
    memset(&guarded, 0xa5, sizeof(guarded));
    unsigned char original[sizeof(guarded)];
    memcpy(original, &guarded, sizeof(guarded));
    const size_t wrong_sizes[] = {0, sizeof(guarded.operations) - 1,
        sizeof(guarded.operations) + 1, SIZE_MAX};
    bool sizes_rejected = true;
    bool rejection_untouched = true;
    for (size_t index = 0; index < sizeof(wrong_sizes) / sizeof(wrong_sizes[0]); index++) {
        sizes_rejected = pilot_fuse_operations(&guarded.operations, wrong_sizes[index]) == -EINVAL
            && sizes_rejected;
        rejection_untouched = memcmp(&guarded, original, sizeof(guarded)) == 0
            && rejection_untouched;
    }
    bool null_rejected = pilot_fuse_operations(NULL, sizeof(guarded.operations)) == -EINVAL;
    int result = pilot_fuse_operations(&guarded.operations, sizeof(guarded.operations));
    bool guards_preserved = memcmp(guarded.before, original, sizeof(guarded.before)) == 0
        && memcmp(guarded.after, original + offsetof(struct probe_operations_storage, after), sizeof(guarded.after)) == 0;
    struct fuse_operations expected;
    memset(&expected, 0, sizeof(expected));
    bool callbacks_present = true;
    /* This is a mask of required C-header slots, not a substitute callback
     * table: every pointer still comes exclusively from the Rust factory. */
#define CHECK_CALLBACK(name) do { \
    callbacks_present = guarded.operations.name != NULL && callbacks_present; \
    expected.name = guarded.operations.name; \
} while (0)
    CHECK_CALLBACK(init);
    CHECK_CALLBACK(destroy);
    CHECK_CALLBACK(access);
    CHECK_CALLBACK(getattr);
    CHECK_CALLBACK(readlink);
    CHECK_CALLBACK(statfs);
    CHECK_CALLBACK(opendir);
    CHECK_CALLBACK(readdir);
    CHECK_CALLBACK(fsyncdir);
    CHECK_CALLBACK(releasedir);
    CHECK_CALLBACK(open);
    CHECK_CALLBACK(create);
    CHECK_CALLBACK(utimens);
    CHECK_CALLBACK(chmod);
    CHECK_CALLBACK(chown);
    CHECK_CALLBACK(getxattr);
    CHECK_CALLBACK(listxattr);
    CHECK_CALLBACK(setxattr);
    CHECK_CALLBACK(removexattr);
    CHECK_CALLBACK(mknod);
    CHECK_CALLBACK(read);
    CHECK_CALLBACK(write);
    CHECK_CALLBACK(truncate);
    CHECK_CALLBACK(flush);
    CHECK_CALLBACK(fsync);
    CHECK_CALLBACK(release);
    CHECK_CALLBACK(mkdir);
    CHECK_CALLBACK(rmdir);
    CHECK_CALLBACK(unlink);
    CHECK_CALLBACK(rename);
    CHECK_CALLBACK(link);
    CHECK_CALLBACK(symlink);
#undef CHECK_CALLBACK
    printf("{\"result\":%d,\"sizesRejected\":%s,\"rejectionUntouched\":%s,"
        "\"nullRejected\":%s,\"guardsPreserved\":%s,\"callbacksPresent\":%s,"
        "\"unusedSlotsZero\":%s,\"initExportMatches\":%s}\n",
        result, sizes_rejected ? "true" : "false", rejection_untouched ? "true" : "false",
        null_rejected ? "true" : "false",
        guards_preserved ? "true" : "false", callbacks_present ? "true" : "false",
        memcmp(&guarded.operations, &expected, sizeof(expected)) == 0 ? "true" : "false",
        guarded.operations.init == pilot_fuse_init ? "true" : "false");
    return 0;
}

static int probe_callbacks(int argc, char **argv, struct pilot_fuse_state *state) {
    void *private_state = state;
    probe_context.private_data = private_state;

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
    if ((strcmp(argv[3], "abi-open") == 0 || strcmp(argv[3], "abi-create") == 0) && argc == 8) {
        struct probe_info_storage {
            uint64_t before[2];
            struct fuse_file_info info;
            uint64_t after[2];
        } guarded;
        /* Sentinel-fill every neighboring field, reserved bit and padding byte
         * without depending on fields added by a newer libfuse SDK. */
        memset(&guarded, 0xff, sizeof(guarded));
        guarded.before[0] = guarded.after[0] = UINT64_C(0x0123456789abcdef);
        guarded.before[1] = guarded.after[1] = UINT64_C(0xfedcba9876543210);
        struct fuse_file_info *sentinel = &guarded.info;
        sentinel->flags = atoi(argv[5]);
        sentinel->direct_io = atoi(argv[6]) != 0;
        sentinel->keep_cache = atoi(argv[7]) != 0;
        sentinel->fh = UINT64_MAX;
        unsigned char expected_bytes[sizeof(guarded)];
        memcpy(expected_bytes, &guarded, sizeof(guarded));
        struct fuse_file_info expected_info;
        memcpy(&expected_info, sentinel, sizeof(expected_info));
        result = strcmp(argv[3], "abi-open") == 0
            ? operations.open(argv[4], sentinel) : operations.create(argv[4], 0600, sentinel);
        if (result == 0) {
            expected_info.fh = sentinel->fh;
            expected_info.direct_io = (expected_info.flags & O_ACCMODE) != O_RDONLY;
            expected_info.keep_cache = 0;
            status_flags = fcntl((int) sentinel->fh, F_GETFL);
            descriptor_flags = fcntl((int) sentinel->fh, F_GETFD);
        }
        memcpy(expected_bytes + offsetof(struct probe_info_storage, info),
            &expected_info, sizeof(expected_info));
        bool fields_preserved = memcmp(&guarded, expected_bytes, sizeof(guarded)) == 0;
        bool handle_assigned = sentinel->fh != UINT64_MAX;
        unsigned int direct_io = sentinel->direct_io;
        unsigned int keep_cache = sentinel->keep_cache;
        if (result == 0 && operations.release(argv[4], sentinel) != 0) return 65;
        bool release_preserved = memcmp(&guarded, expected_bytes, sizeof(guarded)) == 0;
        printf("{\"result\":%d,\"statusFlags\":%d,\"descriptorFlags\":%d,"
            "\"directIo\":%u,\"keepCache\":%u,\"handleAssigned\":%s,"
            "\"fieldsPreserved\":%s,\"releasePreserved\":%s}\n",
            result, status_flags, descriptor_flags, direct_io, keep_cache,
            handle_assigned ? "true" : "false", fields_preserved ? "true" : "false",
            release_preserved ? "true" : "false");
        goto complete;
    } else if (strcmp(argv[3], "disconnect") == 0 && argc == 6) {
        bool opening = strcmp(argv[5], "open") == 0;
        if (!opening && strcmp(argv[5], "read") != 0
            && strcmp(argv[5], "write") != 0 && strcmp(argv[5], "truncate") != 0) return 64;
        info.flags = opening ? O_RDONLY : O_RDWR;
        if (!opening && operations.open(argv[4], &info) != 0) return 65;
        /* Node's stdio pipes are Unix sockets. Shut down the live controller
         * receive side so policy checkpoints observe genuine kernel EOF. */
        if (shutdown(4, SHUT_RD) != 0) return 65;
        if (opening) {
            result = operations.open(argv[4], &info);
            if (result == 0 && operations.release(argv[4], &info) != 0) return 65;
        } else {
            if (strcmp(argv[5], "read") == 0) {
                result = operations.read(argv[4], read_value, sizeof(read_value) - 1, 0, &info);
            } else if (strcmp(argv[5], "write") == 0) {
                result = operations.write(argv[4], "X", 1, 0, &info);
            } else {
                result = operations.truncate(argv[4], 2, &info);
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
            result = operations.truncate(argv[4], 2, &info);
        } else return 64;
        if (strcmp(argv[7], "invalid") != 0 && strcmp(argv[7], "closed") != 0) {
            if (pread(retained_fd, retained_value, sizeof(retained_value) - 1, 0) < 0
                || operations.release(argv[4], &info) != 0) return 65;
        }
    } else if (strcmp(argv[3], "init") == 0 && argc == 5) {
        uint64_t forbidden = FUSE_CAP_DIRECT_IO_ALLOW_MMAP | FUSE_CAP_WRITEBACK_CACHE
            | FUSE_CAP_PASSTHROUGH | FUSE_CAP_ASYNC_DIO | FUSE_CAP_ATOMIC_O_TRUNC
            | FUSE_CAP_NO_OPEN_SUPPORT | FUSE_CAP_NO_OPENDIR_SUPPORT;
        uint64_t preserved = FUSE_CAP_ASYNC_READ | (UINT64_C(1) << 40);
        struct fuse_conn_info connection;
        memset(&connection, 0, sizeof(connection));
        connection.proto_major = 7;
        connection.proto_minor = 42;
        connection.max_write = 0x12345;
        connection.max_read = 0x23456;
        connection.max_readahead = 0x34567;
        connection.max_background = 0x45678;
        connection.congestion_threshold = 0x56789;
        connection.time_gran = 0x6789a;
        connection.reserved[0] = 0x789a;
        connection.capable_ext = strcmp(argv[4], "supported") == 0 ? forbidden | preserved : 0;
        connection.capable = (uint32_t) connection.capable_ext;
        connection.want_ext = forbidden | preserved;
        connection.want = (uint32_t) connection.want_ext;
        struct fuse_config configuration;
        memset(&configuration, 0, sizeof(configuration));
        configuration.set_gid = 1;
        configuration.gid = 0x1234;
        configuration.set_uid = 1;
        configuration.uid = 0x2345;
        configuration.entry_timeout = 1.25;
        configuration.negative_timeout = 2.5;
        configuration.attr_timeout = 3.75;
        configuration.ac_attr_timeout = 4.5;
        configuration.flags = 0x3456789a;
        configuration.reserved[0] = UINT64_C(0x456789abcdef0123);
        configuration.reserved[47] = UINT64_C(0x56789abcdef01234);
        configuration.parallel_direct_writes = 1;
        configuration.nullpath_ok = 1;
        configuration.direct_io = 1;
        configuration.kernel_cache = 1;
        configuration.auto_cache = 1;
        struct fuse_conn_info expected_connection;
        memcpy(&expected_connection, &connection, sizeof(connection));
        expected_connection.want &= ~(uint32_t) forbidden;
        expected_connection.want_ext &= ~forbidden;
        struct fuse_config expected_configuration;
        memcpy(&expected_configuration, &configuration, sizeof(configuration));
        expected_configuration.parallel_direct_writes = 0;
        expected_configuration.nullpath_ok = 0;
        expected_configuration.direct_io = 0;
        expected_configuration.kernel_cache = 0;
        expected_configuration.auto_cache = 0;
        void *initialized = operations.init(&connection, &configuration);
        printf("{\"result\":0,\"forbiddenWant\":%u,\"forbiddenWantExt\":%llu,"
            "\"preservedWant\":%s,\"preservedWantExt\":%s,\"capabilitiesUnchanged\":%s,"
            "\"parallelDirectWrites\":%d,\"nullpathOk\":%d,\"directIo\":%d,"
            "\"keepCache\":%d,\"autoCache\":%d,\"stateReturned\":%s,\"disableRequestsComplete\":%s,"
            "\"connectionFieldsPreserved\":%s,\"configurationFieldsPreserved\":%s}\n",
            connection.want & (uint32_t) forbidden,
            (unsigned long long) (connection.want_ext & forbidden),
            (connection.want & (uint32_t) preserved) == (uint32_t) preserved ? "true" : "false",
            (connection.want_ext & preserved) == preserved ? "true" : "false",
            connection.capable_ext == (strcmp(argv[4], "supported") == 0 ? forbidden | preserved : 0)
                && connection.capable == (uint32_t) connection.capable_ext ? "true" : "false",
            configuration.parallel_direct_writes, configuration.nullpath_ok,
            configuration.direct_io, configuration.kernel_cache, configuration.auto_cache,
            initialized == private_state ? "true" : "false",
            (unset_requested_flags & forbidden) == forbidden ? "true" : "false",
            memcmp(&connection, &expected_connection, sizeof(connection)) == 0 ? "true" : "false",
            memcmp(&configuration, &expected_configuration, sizeof(configuration)) == 0 ? "true" : "false");
        goto complete;
    } else if (strcmp(argv[3], "getattr") == 0 && argc == 6) {
        struct stat attributes;
        bool retained = strcmp(argv[5], "handle") == 0;
        info.flags = O_RDONLY;
        if (retained && operations.open(argv[4], &info) != 0) return 65;
        /* GETATTR_FH contains only fh, not the original open flags. */
        info.flags = 0;
        result = operations.getattr(argv[4], &attributes, retained ? &info : NULL);
        if (retained && operations.release(argv[4], &info) != 0) return 65;
        printf("{\"result\":%d,\"size\":%lld}\n", result,
            result == 0 ? (long long) attributes.st_size : -1LL);
        goto complete;
    } else if (strcmp(argv[3], "readdir") == 0 && argc == 5) {
        info.flags = O_RDONLY | O_DIRECTORY;
        if (operations.opendir(argv[4], &info) != 0) return 65;
        probe_directory_t directory = {.name_only = true};
        result = operations.readdir(argv[4], &directory, probe_fill_directory, 0, &info, FUSE_READDIR_PLUS);
        unsigned int first_entries = directory.entries;
        if (result == 0) {
            result = operations.readdir(argv[4], &directory, probe_fill_directory,
                directory.offset, &info, FUSE_READDIR_PLUS);
        }
        struct stat attributes;
        /* Linux directory GETATTR does not carry a file handle. */
        int attribute_result = operations.getattr(argv[4], &attributes, NULL);
        bool directory_attributes = attribute_result == 0 && S_ISDIR(attributes.st_mode);
        info.flags = 0;
        int pointer_result = operations.getattr(argv[4], &attributes, &info);
        if (operations.releasedir(argv[4], &info) != 0) return 65;
        printf("{\"result\":%d,\"firstEntries\":%u,\"entries\":%u,\"nameOnly\":%s,"
            "\"directoryAttributes\":%s,\"pointerHandleRejected\":%s}\n",
            result, first_entries, directory.entries, directory.name_only ? "true" : "false",
            directory_attributes ? "true" : "false", pointer_result == -EBADF ? "true" : "false");
        goto complete;
    } else if (strcmp(argv[3], "truncate") == 0 && argc == 5) {
        result = operations.truncate(argv[4], 2, NULL);
    } else if (strcmp(argv[3], "metadata") == 0 && argc == 7) {
        info.flags = O_RDONLY;
        if (operations.open(argv[4], &info) != 0 || rename(argv[4], argv[5]) != 0) return 65;
        int replacement = open(argv[4], O_CREAT | O_EXCL | O_WRONLY, 0600);
        if (replacement < 0 || write_exact(replacement, "replacement", 11) != 0
            || close(replacement) != 0) return 65;
        if (strcmp(argv[6], "chmod") == 0) {
            result = operations.chmod(argv[4], 0640, &info);
        } else if (strcmp(argv[6], "chown") == 0) {
            result = operations.chown(argv[4], getuid(), getgid(), &info);
        } else if (strcmp(argv[6], "utimens") == 0) {
            const struct timespec times[2] = {{.tv_sec = 123456789}, {.tv_sec = 123456789}};
            result = operations.utimens(argv[4], times, &info);
        } else return 64;
        if (operations.release(argv[4], &info) != 0) return 65;
    } else if (strcmp(argv[3], "rename") == 0 && argc == 7) {
        result = operations.rename(argv[4], argv[5], (unsigned int) strtoul(argv[6], NULL, 10));
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
    } else if (strcmp(argv[3], "base-replace") == 0 && argc == 7) {
        info.flags = O_RDONLY;
        if (rename(argv[5], argv[1]) != 0) return 65;
        result = operations.open(argv[4], &info);
        if (result == 0 && operations.release(argv[4], &info) != 0) return 65;
        if (rename(argv[6], argv[1]) != 0) return 65;
        info.fh = UINT64_MAX;
        int restored_result = operations.open(argv[4], &info);
        if (restored_result == 0 && operations.release(argv[4], &info) != 0) return 65;
        printf("{\"result\":%d,\"restoredResult\":%d,\"handleAssigned\":%s}\n", result,
            restored_result, info.fh == UINT64_MAX ? "false" : "true");
        goto complete;
    } else if (strcmp(argv[3], "mkdir") == 0 && argc == 5) {
        result = operations.mkdir(argv[4], 0750);
    } else if (strcmp(argv[3], "rmdir") == 0 && argc == 5) {
        result = operations.rmdir(argv[4]);
    } else if (strcmp(argv[3], "unlink") == 0 && argc == 5) {
        result = operations.unlink(argv[4]);
    } else if (strcmp(argv[3], "mknod") == 0 && argc == 6) {
        mode_t mode;
        if (strcmp(argv[5], "regular") == 0) mode = S_IFREG | 0600;
        else if (strcmp(argv[5], "fifo") == 0) mode = S_IFIFO | 0600;
        else if (strcmp(argv[5], "char") == 0) mode = S_IFCHR | 0600;
        else if (strcmp(argv[5], "block") == 0) mode = S_IFBLK | 0600;
        else return 64;
        result = operations.mknod(argv[4], mode, 0);
    } else if (strcmp(argv[3], "symlink") == 0 && argc == 6) {
        result = operations.symlink(argv[5], argv[4]);
    } else if (strcmp(argv[3], "readlink") == 0 && argc == 6) {
        size_t size = (size_t) strtoul(argv[5], NULL, 10);
        char value[64];
        if (size > sizeof(value)) return 64;
        memset(value, '?', sizeof(value));
        result = operations.readlink(argv[4], value, size);
        printf("{\"result\":%d,\"valueHex\":\"", result);
        probe_print_hex(value, sizeof(value));
        printf("\"}\n");
        goto complete;
    } else if (strcmp(argv[3], "access") == 0 && argc == 6) {
        result = operations.access(argv[4], atoi(argv[5]));
    } else if (strcmp(argv[3], "statfs") == 0 && argc == 5) {
        struct statvfs statistics = {0};
        result = operations.statfs(argv[4], &statistics);
        printf("{\"result\":%d,\"blockSize\":%lu,\"fragmentSize\":%lu,\"blocks\":%llu,\"nameMax\":%lu}\n",
            result, statistics.f_bsize, statistics.f_frsize,
            (unsigned long long) statistics.f_blocks, statistics.f_namemax);
        goto complete;
    } else if (strcmp(argv[3], "listxattr") == 0 && argc == 6) {
        char names[256] = {0};
        size_t size = (size_t) strtoul(argv[5], NULL, 10);
        if (size > sizeof(names)) return 64;
        result = operations.listxattr(argv[4], names, size);
        printf("{\"result\":%d,\"valueHex\":\"", result);
        if (result > 0 && size != 0) probe_print_hex(names, (size_t) result);
        printf("\"}\n");
        goto complete;
    } else if (strcmp(argv[3], "removexattr") == 0 && argc == 5) {
        result = operations.removexattr(argv[4], "user.pilot_callback_probe");
    } else if (strcmp(argv[3], "io") == 0 && argc == 10) {
        info.flags = atoi(argv[6]);
        int open_result = operations.open(argv[4], &info);
        char value[256] = {0};
        size_t size = (size_t) strtoul(argv[8], NULL, 10);
        off_t offset = (off_t) strtoll(argv[7], NULL, 10);
        if (size > sizeof(value)) return 64;
        result = open_result;
        off_t position = -1;
        bool reading = strcmp(argv[5], "read") == 0;
        if (!reading && strcmp(argv[5], "write") != 0) return 64;
        if (open_result == 0) {
            if (lseek((int) info.fh, 3, SEEK_SET) != 3) return 65;
            if (reading) result = operations.read(argv[4], value, size, offset, &info);
            else {
                if (size > strlen(argv[9])) return 64;
                result = operations.write(argv[4], argv[9], size, offset, &info);
            }
            position = lseek((int) info.fh, 0, SEEK_CUR);
            if (operations.release(argv[4], &info) != 0) return 65;
        }
        printf("{\"result\":%d,\"openResult\":%d,\"position\":%lld,\"valueHex\":\"",
            result, open_result, (long long) position);
        if (reading && result > 0) probe_print_hex(value, (size_t) result);
        printf("\"}\n");
        goto complete;
    } else if ((strcmp(argv[3], "sync-file") == 0 || strcmp(argv[3], "sync-directory") == 0)
        && argc == 7) {
        bool directory = strcmp(argv[3], "sync-directory") == 0;
        bool invalid = strcmp(argv[6], "invalid") == 0;
        const char *callback_path = strcmp(argv[5], "null") == 0 ? NULL : argv[5];
        info.flags = O_RDONLY;
        if (invalid) info.fh = directory ? 0 : UINT64_MAX;
        else if ((directory ? operations.opendir(argv[4], &info) : operations.open(argv[4], &info)) != 0) return 65;
        int flush_result = directory ? -1 : operations.flush(callback_path, &info);
        int full_result = directory ? operations.fsyncdir(callback_path, 0, &info)
            : operations.fsync(callback_path, 0, &info);
        int data_result = directory ? operations.fsyncdir(callback_path, 1, &info)
            : operations.fsync(callback_path, 1, &info);
        if (!invalid && (directory ? operations.releasedir(NULL, &info) : operations.release(NULL, &info)) != 0) return 65;
        printf("{\"result\":%d,\"flushResult\":%d,\"dataResult\":%d}\n",
            full_result, flush_result, data_result);
        goto complete;
    } else if (strcmp(argv[3], "names") == 0 && argc == 5) {
        probe_names_t directory = {.name_only = true};
        result = operations.opendir(argv[4], &info);
        if (result == 0) {
            result = operations.readdir(argv[4], &directory, probe_fill_names, 0, &info, FUSE_READDIR_PLUS);
            if (operations.releasedir(argv[4], &info) != 0) return 65;
        }
        printf("{\"result\":%d,\"nameOnly\":%s,\"names\":[", result, directory.name_only ? "true" : "false");
        /* Names in this fixture are deliberately simple ASCII. */
        for (unsigned int index = 0; index < directory.count; index++) {
            printf("%s\"%s\"", index == 0 ? "" : ",", directory.names[index]);
        }
        printf("]}\n");
        goto complete;
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
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "abi-operations") == 0) return probe_operations();
    if (argc < 5) return 64;
    struct pilot_fuse_state *state = pilot_fuse_probe_new(argv[1], argv[2], 3, 4);
    if (state == NULL) return 64;
    int result = probe_callbacks(argc, argv, state);
    pilot_fuse_probe_free(state);
    close(3);
    close(4);
    return result;
}
