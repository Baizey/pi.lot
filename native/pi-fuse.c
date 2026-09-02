#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#define FUSE_USE_VERSION 29

#include <fuse.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/un.h>
#include <sys/xattr.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define SNAPSHOT_MAGIC "PILOTNP2"
#define SNAPSHOT_MAGIC_BYTES 8
#define NATIVE_ACCESS_READ 1
#define NATIVE_ACCESS_WRITE 2
#define NATIVE_DECISION_ALLOW 1
#define NATIVE_DECISION_DENY 2
#define POLICY_LOOKUP_MISS -1
#define POLICY_LOOKUP_DENY 0
#define POLICY_LOOKUP_ALLOW 1
#define MAX_SNAPSHOT_BYTES (16 * 1024 * 1024)
#define MAX_POLICY_LAYERS 64
#define CONTROL_MESSAGE_ONCE_SNAPSHOT 1
#define CONTROL_MESSAGE_RESOLUTION 2
#define CONTROL_MESSAGE_MISS 1
#define CONTROL_MESSAGE_DENIAL 2
#define CONTROL_MESSAGE_READY 4
#define CONTROL_IO_TIMEOUT_MILLISECONDS 5000
#define CONTROL_PARTIAL_FRAME_TIMEOUT_MILLISECONDS 5000

typedef struct {
    uint32_t layer;
    uint8_t access;
    uint8_t decision;
    char *path;
} native_policy_rule_t;

typedef struct {
    DIR *directory;
    bool enumeration_started;
    pthread_mutex_t mutex;
} native_directory_handle_t;

typedef struct {
    uint64_t revision;
    native_policy_rule_t *rules;
    uint32_t rule_count;
    uint32_t maximum_layer;
} native_policy_snapshot_t;

typedef struct broker_worker {
    char token[129];
    pid_t pid;
    struct broker_worker *next;
} broker_worker_t;

static broker_worker_t *broker_workers = NULL;

typedef struct {
    char hidden_path[PATH_MAX];
    char snapshot_path[PATH_MAX];
    char stats_path[PATH_MAX];
    struct stat base_snapshot_file_status;
    bool base_snapshot_file_status_valid;
    native_policy_snapshot_t base_snapshot;
    native_policy_snapshot_t once_snapshot;
    pthread_mutex_t policy_mutex;
    uint64_t next_request_id;
    int request_fd;
    int response_fd;
    bool control_failed;
    bool framed_ready;
    int ready_fd;
    atomic_ulong policy_events;
    atomic_ulong open_events;
    atomic_ulong read_events;
    atomic_ulong readdir_events;
    atomic_ulong base_snapshot_checks;
    atomic_ulong base_snapshot_reloads;
    atomic_ulong once_snapshot_updates;
    atomic_ulong policy_misses;
} benchmark_filesystem_t;

static benchmark_filesystem_t *filesystem_state(void) {
    return fuse_get_context()->private_data;
}

static bool same_or_child_path(const char *candidate, const char *parent) {
    size_t parent_length = strlen(parent);
    if (strncmp(candidate, parent, parent_length) != 0) return false;
    return candidate[parent_length] == '\0'
        || parent[parent_length - 1] == '/'
        || candidate[parent_length] == '/';
}

static int visible_path(const char *path) {
    if (path == NULL || path[0] != '/') return -EPERM;
    size_t length = strlen(path);
    if (length == 0 || length >= PATH_MAX) return -ENAMETOOLONG;
    if (strcmp(path, "/") != 0) {
        const char *segment = path + 1;
        for (const char *cursor = segment; ; cursor++) {
            if (*cursor != '/' && *cursor != '\0') continue;
            size_t segment_length = (size_t) (cursor - segment);
            if (segment_length == 0
                || (segment_length == 1 && segment[0] == '.')
                || (segment_length == 2 && segment[0] == '.' && segment[1] == '.')) {
                return -EPERM;
            }
            if (*cursor == '\0') break;
            segment = cursor + 1;
        }
    }
    benchmark_filesystem_t *state = filesystem_state();
    return same_or_child_path(path, state->hidden_path) ? -ENOENT : 0;
}

static bool policy_scope_covers(const char *policy, const char *path) {
    return same_or_child_path(path, policy);
}

static int evaluate_policy(const native_policy_snapshot_t *snapshot, const char *path, uint8_t access) {
    for (uint32_t layer = 0; layer <= snapshot->maximum_layer; layer++) {
        const native_policy_rule_t *most_specific = NULL;
        size_t most_specific_length = 0;
        for (uint32_t index = 0; index < snapshot->rule_count; index++) {
            const native_policy_rule_t *rule = &snapshot->rules[index];
            if (rule->layer != layer || rule->access != access || !policy_scope_covers(rule->path, path)) continue;
            size_t length = strlen(rule->path);
            if (most_specific == NULL || length > most_specific_length) {
                most_specific = rule;
                most_specific_length = length;
            }
        }
        if (most_specific != NULL) {
            return most_specific->decision == NATIVE_DECISION_ALLOW
                ? POLICY_LOOKUP_ALLOW
                : POLICY_LOOKUP_DENY;
        }
    }
    return POLICY_LOOKUP_MISS;
}

static int authorize_path(const char *path, uint8_t access, atomic_ulong *operation_counter);
static int authorize_directory_path(const char *path, int *directory_fd);
static void write_u32(unsigned char *bytes, uint32_t value);
static void write_u64(unsigned char *bytes, uint64_t value);
static int write_exact(int descriptor, const void *buffer, size_t size);
static int write_control_exact(int descriptor, const void *buffer, size_t size);

static void *benchmark_init(struct fuse_conn_info *connection) {
    (void) connection;
    benchmark_filesystem_t *state = filesystem_state();
    if (state->framed_ready) {
        unsigned char ready[24] = {0};
        write_u32(ready, CONTROL_MESSAGE_READY);
        write_u32(ready + 4, 16);
        write_u64(ready + 8, state->base_snapshot.revision);
        write_u64(ready + 16, state->once_snapshot.revision);
        if (write_control_exact(state->request_fd, ready, sizeof(ready)) != 0) {
            perror("write framed ready notification");
        }
    } else if (state->ready_fd >= 0) {
        const char ready = '1';
        if (write(state->ready_fd, &ready, 1) < 0) {
            perror("write ready notification");
        }
        close(state->ready_fd);
        state->ready_fd = -1;
    }
    return state;
}

static int existing_path(const char *path, char resolved[PATH_MAX]) {
    int visible = visible_path(path);
    if (visible != 0) return visible;
    if (realpath(path, resolved) == NULL) return -errno;
    return same_or_child_path(resolved, filesystem_state()->hidden_path) ? -ENOENT : 0;
}

static int node_path(const char *path, char resolved[PATH_MAX]) {
    int visible = visible_path(path);
    if (visible != 0) return visible;
    if (strcmp(path, "/") == 0) {
        strcpy(resolved, "/");
    } else {
        char lexical[PATH_MAX];
        strcpy(lexical, path);
        char *separator = strrchr(lexical, '/');
        char name[PATH_MAX];
        strcpy(name, separator + 1);
        if (separator == lexical) strcpy(lexical, "/");
        else *separator = '\0';
        char parent[PATH_MAX];
        if (realpath(lexical, parent) == NULL) return -errno;
        int written = strcmp(parent, "/") == 0
            ? snprintf(resolved, PATH_MAX, "/%s", name)
            : snprintf(resolved, PATH_MAX, "%s/%s", parent, name);
        if (written < 0 || written >= PATH_MAX) return -ENAMETOOLONG;
    }
    if (same_or_child_path(resolved, filesystem_state()->hidden_path)) return -ENOENT;
    struct stat ignored;
    return lstat(resolved, &ignored) == 0 ? 0 : -errno;
}

static int destination_path(const char *path, char resolved[PATH_MAX]) {
    int visible = visible_path(path);
    if (visible != 0) return visible;
    if (strcmp(path, "/") == 0) return -EPERM;

    char lexical[PATH_MAX];
    strcpy(lexical, path);
    char *separator = strrchr(lexical, '/');
    char name[PATH_MAX];
    strcpy(name, separator + 1);
    if (separator == lexical) strcpy(lexical, "/");
    else *separator = '\0';
    char parent[PATH_MAX];
    if (realpath(lexical, parent) == NULL) return -errno;
    int written = strcmp(parent, "/") == 0
        ? snprintf(resolved, PATH_MAX, "/%s", name)
        : snprintf(resolved, PATH_MAX, "%s/%s", parent, name);
    if (written < 0 || written >= PATH_MAX) return -ENAMETOOLONG;
    return same_or_child_path(resolved, filesystem_state()->hidden_path) ? -ENOENT : 0;
}

static int resolved_policy_path(const char *path, char resolved[PATH_MAX]) {
    int visible = visible_path(path);
    if (visible != 0) return visible;
    if (strcmp(path, "/") == 0) {
        strcpy(resolved, "/");
        return 0;
    }
    if (realpath(path, resolved) != NULL) {
        return same_or_child_path(resolved, filesystem_state()->hidden_path) ? -ENOENT : 0;
    }
    return destination_path(path, resolved);
}

static int mutable_node_path(const char *path, char resolved[PATH_MAX]) {
    int result = node_path(path, resolved);
    if (result != 0) return result;
    return strcmp(resolved, "/") == 0 ? -EPERM : 0;
}

static int normalize_absolute_path(const char *input, char output[PATH_MAX]) {
    if (input[0] != '/' || strlen(input) >= PATH_MAX) return -EPERM;
    size_t output_length = 1;
    output[0] = '/';
    output[1] = '\0';
    const char *cursor = input + 1;
    while (*cursor != '\0') {
        while (*cursor == '/') cursor++;
        if (*cursor == '\0') break;
        const char *end = cursor;
        while (*end != '\0' && *end != '/') end++;
        size_t length = (size_t) (end - cursor);
        if (length == 1 && cursor[0] == '.') {
            cursor = end;
            continue;
        }
        if (length == 2 && cursor[0] == '.' && cursor[1] == '.') {
            if (output_length > 1) {
                while (output_length > 1 && output[output_length - 1] != '/') output_length--;
                if (output_length > 1) output_length--;
                output[output_length] = '\0';
            }
            cursor = end;
            continue;
        }
        if (output_length > 1) output[output_length++] = '/';
        if (output_length + length >= PATH_MAX) return -ENAMETOOLONG;
        memcpy(output + output_length, cursor, length);
        output_length += length;
        output[output_length] = '\0';
        cursor = end;
    }
    return 0;
}

static int benchmark_access(const char *path, int mode) {
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;
    return access(resolved, mode) == 0 ? 0 : -errno;
}

static int benchmark_getattr(const char *path, struct stat *attributes) {
    char resolved[PATH_MAX];
    int result = node_path(path, resolved);
    if (result != 0) return result;
    return lstat(resolved, attributes) == 0 ? 0 : -errno;
}

static int benchmark_fgetattr(const char *path, struct stat *attributes, struct fuse_file_info *info) {
    (void) path;
    if ((info->flags & O_DIRECTORY) == 0) {
        int descriptor = (int) info->fh;
        return descriptor >= 0 && fstat(descriptor, attributes) == 0 ? 0 : -errno;
    }
    native_directory_handle_t *handle = (native_directory_handle_t *) (uintptr_t) info->fh;
    if (handle == NULL || pthread_mutex_lock(&handle->mutex) != 0) return -EBADF;
    int descriptor = handle->directory == NULL ? -1 : dirfd(handle->directory);
    int result = descriptor < 0 ? -EBADF : (fstat(descriptor, attributes) == 0 ? 0 : -errno);
    pthread_mutex_unlock(&handle->mutex);
    return result;
}

static int benchmark_readlink(const char *path, char *buffer, size_t size) {
    if (size == 0) return -EINVAL;
    char resolved[PATH_MAX];
    int result = node_path(path, resolved);
    if (result != 0) return result;
    ssize_t length = readlink(resolved, buffer, size - 1);
    if (length < 0) return -errno;
    buffer[length] = '\0';
    return 0;
}

static int benchmark_statfs(const char *path, struct statvfs *statistics) {
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;
    return statvfs(resolved, statistics) == 0 ? 0 : -errno;
}

static int benchmark_opendir(const char *path, struct fuse_file_info *info) {
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;
    DIR *directory = opendir(resolved);
    if (directory == NULL) return -errno;
    native_directory_handle_t *handle = calloc(1, sizeof(*handle));
    if (handle == NULL) {
        closedir(directory);
        return -ENOMEM;
    }
    handle->directory = directory;
    if (pthread_mutex_init(&handle->mutex, NULL) != 0) {
        closedir(directory);
        free(handle);
        return -EIO;
    }
    info->fh = (uint64_t) (uintptr_t) handle;
    return 0;
}

static int benchmark_readdir(
    const char *path,
    void *buffer,
    fuse_fill_dir_t filler,
    off_t offset,
    struct fuse_file_info *info
) {
    native_directory_handle_t *handle = (native_directory_handle_t *) (uintptr_t) info->fh;
    if (handle == NULL || pthread_mutex_lock(&handle->mutex) != 0) return -EBADF;
    int result = -EACCES;
    int authorized_fd = -1;
    int authorized = authorize_directory_path(path, &authorized_fd);
    if (authorized != 0) {
        result = authorized;
        goto complete;
    }

    struct stat retained_status;
    struct stat authorized_status;
    int retained_fd = handle->directory == NULL ? -1 : dirfd(handle->directory);
    if (retained_fd < 0
        || fstat(retained_fd, &retained_status) != 0
        || fstat(authorized_fd, &authorized_status) != 0) {
        result = retained_fd < 0 ? -EBADF : -errno;
        close(authorized_fd);
        goto complete;
    }
    bool same_directory = retained_status.st_dev == authorized_status.st_dev
        && retained_status.st_ino == authorized_status.st_ino;
    if (!handle->enumeration_started || (offset == 0 && !same_directory)) {
        DIR *replacement = fdopendir(authorized_fd);
        if (replacement == NULL) {
            result = -errno;
            close(authorized_fd);
            goto complete;
        }
        authorized_fd = -1;
        if (closedir(handle->directory) != 0) {
            result = -errno;
            handle->directory = NULL;
            closedir(replacement);
            goto complete;
        }
        handle->directory = replacement;
        handle->enumeration_started = true;
    } else {
        close(authorized_fd);
        if (!same_directory) goto complete;
    }

    DIR *directory = handle->directory;
    if (offset == 0) rewinddir(directory);
    else seekdir(directory, offset);
    result = 0;
    while (true) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (entry == NULL) {
            if (errno != 0) result = -errno;
            break;
        }
        char child[PATH_MAX];
        int written = strcmp(path, "/") == 0
            ? snprintf(child, sizeof(child), "/%s", entry->d_name)
            : snprintf(child, sizeof(child), "%s/%s", path, entry->d_name);
        if (written < 0 || (size_t) written >= sizeof(child)) {
            result = -ENAMETOOLONG;
            break;
        }
        if (same_or_child_path(child, filesystem_state()->hidden_path)) continue;

        off_t next_offset = telldir(directory);
        if (filler(buffer, entry->d_name, NULL, next_offset) != 0) break;
    }

complete:
    pthread_mutex_unlock(&handle->mutex);
    return result;
}

static int benchmark_fsyncdir(
    const char *path,
    int data_only,
    struct fuse_file_info *info
) {
    (void) path;
    native_directory_handle_t *handle = (native_directory_handle_t *) (uintptr_t) info->fh;
    if (handle == NULL || pthread_mutex_lock(&handle->mutex) != 0) return -EBADF;
    int descriptor = handle->directory == NULL ? -1 : dirfd(handle->directory);
    int result = descriptor < 0
        ? (handle->directory == NULL ? -EBADF : -errno)
        : ((data_only ? fdatasync(descriptor) : fsync(descriptor)) == 0 ? 0 : -errno);
    pthread_mutex_unlock(&handle->mutex);
    return result;
}

static int benchmark_releasedir(const char *path, struct fuse_file_info *info) {
    (void) path;
    native_directory_handle_t *handle = (native_directory_handle_t *) (uintptr_t) info->fh;
    if (handle == NULL) return -EBADF;
    int result = handle->directory == NULL || closedir(handle->directory) == 0 ? 0 : -errno;
    pthread_mutex_destroy(&handle->mutex);
    free(handle);
    return result;
}

static int benchmark_open(const char *path, struct fuse_file_info *info) {
    uint8_t access = (info->flags & O_ACCMODE) == O_RDONLY
        ? NATIVE_ACCESS_READ
        : NATIVE_ACCESS_WRITE;
    int authorized = authorize_path(path, access, &filesystem_state()->open_events);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;

    int descriptor = open(resolved, info->flags);
    if (descriptor < 0) return -errno;
    info->fh = (uint64_t) descriptor;
    info->direct_io = 1;
    return 0;
}

static int benchmark_create(const char *path, mode_t mode, struct fuse_file_info *info) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = destination_path(path, resolved);
    if (result != 0) return result;
    int descriptor = open(resolved, O_CREAT | O_EXCL | O_RDWR, mode);
    if (descriptor < 0) return -errno;
    info->fh = (uint64_t) descriptor;
    info->direct_io = 1;
    return 0;
}

static int benchmark_utimens(const char *path, const struct timespec times[2]) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = node_path(path, resolved);
    if (result != 0) return result;
    return utimensat(AT_FDCWD, resolved, times, AT_SYMLINK_NOFOLLOW) == 0 ? 0 : -errno;
}

static int benchmark_chmod(const char *path, mode_t mode) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;
    return chmod(resolved, mode) == 0 ? 0 : -errno;
}

static int benchmark_chown(const char *path, uid_t uid, gid_t gid) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = node_path(path, resolved);
    if (result != 0) return result;
    return lchown(resolved, uid, gid) == 0 ? 0 : -errno;
}

static int benchmark_getxattr(const char *path, const char *name, char *value, size_t size) {
    int authorized = authorize_path(path, NATIVE_ACCESS_READ, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;
    ssize_t length = getxattr(resolved, name, value, size);
    return length < 0 ? -errno : (int) length;
}

static int benchmark_listxattr(const char *path, char *list, size_t size) {
    int authorized = authorize_path(path, NATIVE_ACCESS_READ, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;
    ssize_t length = listxattr(resolved, list, size);
    return length < 0 ? -errno : (int) length;
}

static int benchmark_setxattr(
    const char *path,
    const char *name,
    const char *value,
    size_t size,
    int flags
) {
    if (flags != 0) return -EINVAL;
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;
    return setxattr(resolved, name, value, size, 0) == 0 ? 0 : -errno;
}

static int benchmark_removexattr(const char *path, const char *name) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;
    return removexattr(resolved, name) == 0 ? 0 : -errno;
}

static int benchmark_mknod(const char *path, mode_t mode, dev_t device) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = destination_path(path, resolved);
    if (result != 0) return result;
    return mknod(resolved, mode, device) == 0 ? 0 : -errno;
}

static int benchmark_read(
    const char *path,
    char *buffer,
    size_t size,
    off_t offset,
    struct fuse_file_info *info
) {
    int authorized = authorize_path(path, NATIVE_ACCESS_READ, &filesystem_state()->read_events);
    if (authorized != 0) return authorized;
    ssize_t length = pread((int) info->fh, buffer, size, offset);
    return length < 0 ? -errno : (int) length;
}

static int benchmark_write(
    const char *path,
    const char *buffer,
    size_t size,
    off_t offset,
    struct fuse_file_info *info
) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    ssize_t length = pwrite((int) info->fh, buffer, size, offset);
    return length < 0 ? -errno : (int) length;
}

static int benchmark_truncate(const char *path, off_t size) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = existing_path(path, resolved);
    if (result != 0) return result;
    return truncate(resolved, size) == 0 ? 0 : -errno;
}

static int benchmark_ftruncate(const char *path, off_t size, struct fuse_file_info *info) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    return ftruncate((int) info->fh, size) == 0 ? 0 : -errno;
}

static int benchmark_flush(const char *path, struct fuse_file_info *info) {
    (void) path;
    (void) info;
    return 0;
}

static int benchmark_fsync(const char *path, int data_only, struct fuse_file_info *info) {
    (void) path;
    return (data_only ? fdatasync((int) info->fh) : fsync((int) info->fh)) == 0 ? 0 : -errno;
}

static int benchmark_release(const char *path, struct fuse_file_info *info) {
    (void) path;
    return close((int) info->fh) == 0 ? 0 : -errno;
}

static int benchmark_mkdir(const char *path, mode_t mode) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = destination_path(path, resolved);
    if (result != 0) return result;
    return mkdir(resolved, mode) == 0 ? 0 : -errno;
}

static int benchmark_rmdir(const char *path) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = mutable_node_path(path, resolved);
    if (result != 0) return result;
    return rmdir(resolved) == 0 ? 0 : -errno;
}

static int benchmark_unlink(const char *path) {
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved[PATH_MAX];
    int result = mutable_node_path(path, resolved);
    if (result != 0) return result;
    return unlink(resolved) == 0 ? 0 : -errno;
}

static int benchmark_rename(const char *source, const char *destination) {
    int authorized = authorize_path(source, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    authorized = authorize_path(destination, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved_source[PATH_MAX];
    char resolved_destination[PATH_MAX];
    int result = mutable_node_path(source, resolved_source);
    if (result != 0) return result;
    result = destination_path(destination, resolved_destination);
    if (result != 0) return result;
    return rename(resolved_source, resolved_destination) == 0 ? 0 : -errno;
}

static int benchmark_link(const char *source, const char *destination) {
    int authorized = authorize_path(source, NATIVE_ACCESS_READ, NULL);
    if (authorized != 0) return authorized;
    authorized = authorize_path(destination, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char resolved_source[PATH_MAX];
    char resolved_destination[PATH_MAX];
    int result = node_path(source, resolved_source);
    if (result != 0) return result;
    result = destination_path(destination, resolved_destination);
    if (result != 0) return result;
    return link(resolved_source, resolved_destination) == 0 ? 0 : -errno;
}

static int benchmark_symlink(const char *target, const char *path) {
    if (target == NULL || target[0] == '/') return -EPERM;
    int authorized = authorize_path(path, NATIVE_ACCESS_WRITE, NULL);
    if (authorized != 0) return authorized;
    char destination[PATH_MAX];
    int result = destination_path(path, destination);
    if (result != 0) return result;

    char parent[PATH_MAX];
    strcpy(parent, destination);
    char *separator = strrchr(parent, '/');
    if (separator == parent) separator[1] = '\0';
    else *separator = '\0';
    char combined[PATH_MAX];
    int written = strcmp(parent, "/") == 0
        ? snprintf(combined, sizeof(combined), "/%s", target)
        : snprintf(combined, sizeof(combined), "%s/%s", parent, target);
    if (written < 0 || (size_t) written >= sizeof(combined)) return -ENAMETOOLONG;
    char normalized_target[PATH_MAX];
    result = normalize_absolute_path(combined, normalized_target);
    if (result != 0) return result;
    if (same_or_child_path(normalized_target, filesystem_state()->hidden_path)) return -ENOENT;
    return symlink(target, destination) == 0 ? 0 : -errno;
}

static void write_statistics(benchmark_filesystem_t *state) {
    FILE *output = fopen(state->stats_path, "w");
    if (output == NULL) {
        perror("open native FUSE statistics");
        return;
    }
    fprintf(
        output,
        "{\"policyEvents\":%lu,\"open\":%lu,\"read\":%lu,\"readdir\":%lu,"
        "\"baseSnapshotChecks\":%lu,\"baseSnapshotReloads\":%lu,"
        "\"onceSnapshotUpdates\":%lu,\"policyMisses\":%lu}\n",
        atomic_load_explicit(&state->policy_events, memory_order_relaxed),
        atomic_load_explicit(&state->open_events, memory_order_relaxed),
        atomic_load_explicit(&state->read_events, memory_order_relaxed),
        atomic_load_explicit(&state->readdir_events, memory_order_relaxed),
        atomic_load_explicit(&state->base_snapshot_checks, memory_order_relaxed),
        atomic_load_explicit(&state->base_snapshot_reloads, memory_order_relaxed),
        atomic_load_explicit(&state->once_snapshot_updates, memory_order_relaxed),
        atomic_load_explicit(&state->policy_misses, memory_order_relaxed)
    );
    if (fclose(output) != 0) perror("close native FUSE statistics");
}

static void benchmark_destroy(void *private_data) {
    write_statistics(private_data);
}

static uint32_t read_u32(const unsigned char *bytes) {
    return (uint32_t) bytes[0]
        | (uint32_t) bytes[1] << 8
        | (uint32_t) bytes[2] << 16
        | (uint32_t) bytes[3] << 24;
}

static uint64_t read_u64(const unsigned char *bytes) {
    return (uint64_t) read_u32(bytes) | (uint64_t) read_u32(bytes + 4) << 32;
}

static void write_u32(unsigned char *bytes, uint32_t value) {
    bytes[0] = (unsigned char) value;
    bytes[1] = (unsigned char) (value >> 8);
    bytes[2] = (unsigned char) (value >> 16);
    bytes[3] = (unsigned char) (value >> 24);
}

static void write_u64(unsigned char *bytes, uint64_t value) {
    write_u32(bytes, (uint32_t) value);
    write_u32(bytes + 4, (uint32_t) (value >> 32));
}

static int read_exact(int descriptor, void *buffer, size_t size) {
    unsigned char *bytes = buffer;
    size_t offset = 0;
    while (offset < size) {
        ssize_t result = read(descriptor, bytes + offset, size - offset);
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0) return -1;
        offset += (size_t) result;
    }
    return 0;
}

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

static int64_t monotonic_milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (int64_t) now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int remaining_milliseconds(int64_t deadline) {
    int64_t now = monotonic_milliseconds();
    if (now < 0) return -1;
    if (now >= deadline) {
        errno = ETIMEDOUT;
        return -1;
    }
    int64_t remaining = deadline - now;
    return remaining > INT_MAX ? INT_MAX : (int) remaining;
}

static int wait_for_descriptor(int descriptor, short events, int timeout_milliseconds) {
    struct pollfd pending = {.fd = descriptor, .events = events};
    int64_t now = monotonic_milliseconds();
    if (now < 0) return -1;
    int64_t deadline = timeout_milliseconds < 0 ? -1 : now + timeout_milliseconds;
    while (true) {
        int timeout = deadline < 0 ? -1 : remaining_milliseconds(deadline);
        if (deadline >= 0 && timeout < 0) return -1;
        int result = poll(&pending, 1, timeout);
        if (result < 0 && errno == EINTR) continue;
        if (result == 0) errno = ETIMEDOUT;
        if (result <= 0) return -1;
        if ((pending.revents & events) != 0) return 0;
        errno = EPIPE;
        return -1;
    }
}

static int read_control_exact(
    int descriptor,
    void *buffer,
    size_t size,
    int initial_timeout_milliseconds,
    int64_t *frame_deadline
) {
    unsigned char *bytes = buffer;
    size_t offset = 0;
    while (offset < size) {
        int timeout = initial_timeout_milliseconds;
        if (*frame_deadline >= 0) {
            timeout = remaining_milliseconds(*frame_deadline);
            if (timeout < 0) return -1;
        }
        if (wait_for_descriptor(descriptor, POLLIN, timeout) != 0) return -1;
        ssize_t result = read(descriptor, bytes + offset, size - offset);
        if (result < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (result <= 0) return -1;
        offset += (size_t) result;
        if (*frame_deadline < 0) {
            int64_t now = monotonic_milliseconds();
            if (now < 0) return -1;
            *frame_deadline = now + CONTROL_PARTIAL_FRAME_TIMEOUT_MILLISECONDS;
        }
    }
    return 0;
}

static int write_control_exact(int descriptor, const void *buffer, size_t size) {
    const unsigned char *bytes = buffer;
    size_t offset = 0;
    int64_t now = monotonic_milliseconds();
    if (now < 0) return -1;
    int64_t deadline = now + CONTROL_IO_TIMEOUT_MILLISECONDS;
    while (offset < size) {
        int timeout = remaining_milliseconds(deadline);
        if (timeout < 0 || wait_for_descriptor(descriptor, POLLOUT, timeout) != 0) return -1;
        ssize_t result = write(descriptor, bytes + offset, size - offset);
        if (result < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (result <= 0) return -1;
        offset += (size_t) result;
    }
    return 0;
}

static int make_nonblocking(int descriptor) {
    int flags = fcntl(descriptor, F_GETFL);
    return flags < 0 || fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) != 0 ? -1 : 0;
}

static void destroy_policy_snapshot(native_policy_snapshot_t *snapshot) {
    for (uint32_t index = 0; index < snapshot->rule_count; index++) free(snapshot->rules[index].path);
    free(snapshot->rules);
    memset(snapshot, 0, sizeof(*snapshot));
}

static int parse_policy_snapshot(
    const unsigned char *bytes,
    size_t byte_count,
    native_policy_snapshot_t *snapshot
) {
    native_policy_snapshot_t parsed = {0};
    size_t offset = 0;
    if (byte_count < SNAPSHOT_MAGIC_BYTES + 12 || byte_count > MAX_SNAPSHOT_BYTES) goto invalid;
    if (memcmp(bytes, SNAPSHOT_MAGIC, SNAPSHOT_MAGIC_BYTES) != 0) goto invalid;
    offset += SNAPSHOT_MAGIC_BYTES;
    parsed.revision = read_u64(bytes + offset);
    offset += 8;
    parsed.rule_count = read_u32(bytes + offset);
    offset += 4;
    if (parsed.rule_count > (byte_count - offset) / 12) goto invalid;
    parsed.rules = calloc(parsed.rule_count, sizeof(*parsed.rules));
    if (parsed.rule_count > 0 && parsed.rules == NULL) return -1;

    for (uint32_t index = 0; index < parsed.rule_count; index++) {
        if (byte_count - offset < 12) goto invalid_parsed;
        native_policy_rule_t *rule = &parsed.rules[index];
        rule->layer = read_u32(bytes + offset);
        offset += 4;
        rule->access = bytes[offset++];
        rule->decision = bytes[offset++];
        offset += 2;
        uint32_t path_length = read_u32(bytes + offset);
        offset += 4;
        if (path_length == 0 || path_length >= PATH_MAX || byte_count - offset < path_length) {
            goto invalid_parsed;
        }
        if (rule->layer >= MAX_POLICY_LAYERS
            || bytes[offset] != '/'
            || memchr(bytes + offset, '\0', path_length) != NULL) {
            goto invalid_parsed;
        }
        if ((rule->access != NATIVE_ACCESS_READ && rule->access != NATIVE_ACCESS_WRITE)
            || (rule->decision != NATIVE_DECISION_ALLOW && rule->decision != NATIVE_DECISION_DENY)) {
            goto invalid_parsed;
        }
        rule->path = malloc((size_t) path_length + 1);
        if (rule->path == NULL) goto invalid_parsed;
        memcpy(rule->path, bytes + offset, path_length);
        rule->path[path_length] = '\0';
        offset += path_length;
        if (rule->layer > parsed.maximum_layer) parsed.maximum_layer = rule->layer;
    }
    if (offset != byte_count) goto invalid_parsed;
    *snapshot = parsed;
    return 0;

invalid_parsed:
    destroy_policy_snapshot(&parsed);
invalid:
    errno = EINVAL;
    return -1;
}

static int load_policy_snapshot(
    const char *path,
    native_policy_snapshot_t *snapshot,
    struct stat *loaded_status
) {
    FILE *input = fopen(path, "rb");
    if (input == NULL) return -1;
    if (loaded_status != NULL && fstat(fileno(input), loaded_status) != 0) goto fail;
    if (fseek(input, 0, SEEK_END) != 0) goto fail;
    long file_size = ftell(input);
    if (file_size < 0 || file_size > MAX_SNAPSHOT_BYTES) {
        errno = EINVAL;
        goto fail;
    }
    if (fseek(input, 0, SEEK_SET) != 0) goto fail;

    unsigned char *bytes = malloc((size_t) file_size);
    if (bytes == NULL) goto fail;
    if (fread(bytes, 1, (size_t) file_size, input) != (size_t) file_size) {
        free(bytes);
        goto fail;
    }
    if (fclose(input) != 0) {
        free(bytes);
        return -1;
    }
    input = NULL;
    int result = parse_policy_snapshot(bytes, (size_t) file_size, snapshot);
    free(bytes);
    return result;

fail:
    fclose(input);
    return -1;
}

static bool same_snapshot_file(
    const struct stat *left,
    const struct stat *right
) {
    return left->st_dev == right->st_dev
        && left->st_ino == right->st_ino
        && left->st_size == right->st_size
        && left->st_mtim.tv_sec == right->st_mtim.tv_sec
        && left->st_mtim.tv_nsec == right->st_mtim.tv_nsec
        && left->st_ctim.tv_sec == right->st_ctim.tv_sec
        && left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
}

static int refresh_base_policy_snapshot_file(benchmark_filesystem_t *state) {
    atomic_fetch_add_explicit(&state->base_snapshot_checks, 1, memory_order_relaxed);
    struct stat status;
    if (stat(state->snapshot_path, &status) != 0) return -1;
    if (state->base_snapshot_file_status_valid
        && same_snapshot_file(&status, &state->base_snapshot_file_status)) {
        return 0;
    }

    native_policy_snapshot_t replacement = {0};
    struct stat loaded_status;
    if (load_policy_snapshot(state->snapshot_path, &replacement, &loaded_status) != 0) return -1;
    if (replacement.revision < state->base_snapshot.revision) {
        destroy_policy_snapshot(&replacement);
        errno = EPROTO;
        return -1;
    }
    if (replacement.revision > state->base_snapshot.revision) {
        atomic_fetch_add_explicit(&state->base_snapshot_reloads, 1, memory_order_relaxed);
        native_policy_snapshot_t previous = state->base_snapshot;
        state->base_snapshot = replacement;
        destroy_policy_snapshot(&previous);
    } else {
        destroy_policy_snapshot(&replacement);
    }
    state->base_snapshot_file_status = loaded_status;
    state->base_snapshot_file_status_valid = true;
    return 0;
}

static int read_control_message(
    benchmark_filesystem_t *state,
    uint32_t *message_type,
    unsigned char **payload,
    uint32_t *payload_size
) {
    unsigned char header[8];
    int64_t frame_deadline = -1;
    if (read_control_exact(
        state->response_fd,
        header,
        sizeof(header),
        -1,
        &frame_deadline
    ) != 0) return -1;
    *message_type = read_u32(header);
    *payload_size = read_u32(header + 4);
    if (*payload_size > MAX_SNAPSHOT_BYTES) return -1;
    *payload = malloc(*payload_size);
    if (*payload_size > 0 && *payload == NULL) return -1;
    if (read_control_exact(
        state->response_fd,
        *payload,
        *payload_size,
        CONTROL_PARTIAL_FRAME_TIMEOUT_MILLISECONDS,
        &frame_deadline
    ) != 0) {
        free(*payload);
        *payload = NULL;
        return -1;
    }
    return 0;
}

static int apply_once_snapshot_update(
    benchmark_filesystem_t *state,
    const unsigned char *payload,
    uint32_t payload_size
) {
    native_policy_snapshot_t replacement = {0};
    if (parse_policy_snapshot(payload, payload_size, &replacement) != 0) return -1;
    if (replacement.revision < state->once_snapshot.revision) {
        destroy_policy_snapshot(&replacement);
        errno = EPROTO;
        return -1;
    }
    if (replacement.revision == state->once_snapshot.revision) {
        destroy_policy_snapshot(&replacement);
        return 0;
    }
    atomic_fetch_add_explicit(&state->once_snapshot_updates, 1, memory_order_relaxed);
    native_policy_snapshot_t previous = state->once_snapshot;
    state->once_snapshot = replacement;
    destroy_policy_snapshot(&previous);
    return 0;
}

static int drain_once_snapshot_updates(benchmark_filesystem_t *state) {
    while (true) {
        struct pollfd descriptor = {
            .fd = state->response_fd,
            .events = POLLIN,
        };
        int result;
        do {
            result = poll(&descriptor, 1, 0);
        } while (result < 0 && errno == EINTR);
        if (result < 0) return -1;
        if (result == 0) return 0;
        if ((descriptor.revents & POLLIN) == 0) return -1;

        uint32_t message_type;
        uint32_t payload_size;
        unsigned char *payload = NULL;
        if (read_control_message(state, &message_type, &payload, &payload_size) != 0) return -1;
        int update_result = message_type == CONTROL_MESSAGE_ONCE_SNAPSHOT
            ? apply_once_snapshot_update(state, payload, payload_size)
            : -1;
        free(payload);
        if (update_result != 0) return -1;
    }
}

static int receive_initial_once_snapshot(benchmark_filesystem_t *state) {
    uint32_t message_type;
    uint32_t payload_size;
    unsigned char *payload = NULL;
    if (read_control_message(state, &message_type, &payload, &payload_size) != 0) return -1;
    int result = message_type == CONTROL_MESSAGE_ONCE_SNAPSHOT
        ? apply_once_snapshot_update(state, payload, payload_size)
        : -1;
    free(payload);
    return result;
}

static int evaluate_policy_state(
    const benchmark_filesystem_t *state,
    const char *path,
    uint8_t access
) {
    int base = evaluate_policy(&state->base_snapshot, path, access);
    return base == POLICY_LOOKUP_MISS
        ? evaluate_policy(&state->once_snapshot, path, access)
        : base;
}

static int send_policy_event(
    benchmark_filesystem_t *state,
    uint32_t message_type,
    uint64_t request_id,
    uint64_t base_revision,
    uint64_t once_revision,
    uint8_t access,
    const char *path
) {
    size_t path_length = strlen(path);
    if (path_length == 0 || path_length >= PATH_MAX) return -1;
    uint32_t payload_size = (uint32_t) (32 + path_length);
    unsigned char *message = malloc(8 + payload_size);
    if (message == NULL) return -1;
    write_u32(message, message_type);
    write_u32(message + 4, payload_size);
    write_u64(message + 8, request_id);
    write_u64(message + 16, base_revision);
    write_u64(message + 24, once_revision);
    message[32] = access;
    memset(message + 33, 0, 3);
    write_u32(message + 36, (uint32_t) path_length);
    memcpy(message + 40, path, path_length);
    int result = write_control_exact(state->request_fd, message, 8 + payload_size);
    free(message);
    return result;
}

static int wait_for_policy_resolution(
    benchmark_filesystem_t *state,
    uint64_t request_id,
    uint64_t observed_base_revision,
    uint64_t observed_once_revision,
    uint8_t *resolution_decision
) {
    while (true) {
        uint32_t message_type;
        uint32_t payload_size;
        unsigned char *payload = NULL;
        if (read_control_message(state, &message_type, &payload, &payload_size) != 0) return -1;
        if (message_type == CONTROL_MESSAGE_ONCE_SNAPSHOT) {
            int result = apply_once_snapshot_update(state, payload, payload_size);
            free(payload);
            if (result != 0) return -1;
            continue;
        }
        if (message_type != CONTROL_MESSAGE_RESOLUTION || payload_size != 25) {
            free(payload);
            return -1;
        }
        uint64_t resolved_request_id = read_u64(payload);
        uint64_t resolved_base_revision = read_u64(payload + 8);
        uint64_t resolved_once_revision = read_u64(payload + 16);
        uint8_t decision = payload[24];
        free(payload);
        if (refresh_base_policy_snapshot_file(state) != 0
            || resolved_request_id != request_id
            || resolved_base_revision < observed_base_revision
            || resolved_base_revision > state->base_snapshot.revision
            || resolved_once_revision < observed_once_revision
            || resolved_once_revision > state->once_snapshot.revision
            || (decision != NATIVE_DECISION_ALLOW && decision != NATIVE_DECISION_DENY)) {
            return -1;
        }
        *resolution_decision = decision;
        return 0;
    }
}

static int authorize_path_internal(
    const char *path,
    uint8_t access,
    atomic_ulong *operation_counter,
    int *directory_fd
) {
    benchmark_filesystem_t *state = filesystem_state();
    atomic_fetch_add_explicit(&state->policy_events, 1, memory_order_relaxed);
    if (operation_counter != NULL) {
        atomic_fetch_add_explicit(operation_counter, 1, memory_order_relaxed);
    }
    if (pthread_mutex_lock(&state->policy_mutex) != 0) return -EACCES;

    int result = -EACCES;
    char evaluated_path[PATH_MAX];
    if (state->control_failed
        || refresh_base_policy_snapshot_file(state) != 0
        || drain_once_snapshot_updates(state) != 0) {
        state->control_failed = true;
        goto complete;
    }
    result = resolved_policy_path(path, evaluated_path);
    if (result != 0) goto complete;
    result = -EACCES;
    int lookup = evaluate_policy_state(state, evaluated_path, access);
    if (lookup == POLICY_LOOKUP_ALLOW) {
        result = 0;
        goto authorized;
    }
    if (lookup == POLICY_LOOKUP_DENY) {
        if (send_policy_event(
            state,
            CONTROL_MESSAGE_DENIAL,
            0,
            state->base_snapshot.revision,
            state->once_snapshot.revision,
            access,
            evaluated_path
        ) != 0) {
            state->control_failed = true;
        }
        goto complete;
    }

    atomic_fetch_add_explicit(&state->policy_misses, 1, memory_order_relaxed);
    uint64_t observed_base_revision = state->base_snapshot.revision;
    uint64_t observed_once_revision = state->once_snapshot.revision;
    uint64_t request_id = ++state->next_request_id;
    uint8_t resolution_decision = NATIVE_DECISION_DENY;
    if (send_policy_event(
        state,
        CONTROL_MESSAGE_MISS,
        request_id,
        observed_base_revision,
        observed_once_revision,
        access,
        evaluated_path
    ) != 0
        || wait_for_policy_resolution(
            state,
            request_id,
            observed_base_revision,
            observed_once_revision,
            &resolution_decision
        ) != 0) {
        state->control_failed = true;
        goto complete;
    }
    char refreshed_path[PATH_MAX];
    if (resolved_policy_path(path, refreshed_path) != 0
        || strcmp(evaluated_path, refreshed_path) != 0) {
        goto complete;
    }
    lookup = evaluate_policy_state(state, evaluated_path, access);
    if (resolution_decision != NATIVE_DECISION_ALLOW || lookup != POLICY_LOOKUP_ALLOW) goto complete;
    result = 0;

authorized:
    if (directory_fd != NULL) {
        int descriptor = open(evaluated_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (descriptor < 0) {
            result = -errno;
            goto complete;
        }
        char descriptor_link[64];
        char descriptor_path[PATH_MAX];
        int written = snprintf(descriptor_link, sizeof(descriptor_link), "/proc/self/fd/%d", descriptor);
        ssize_t length = written > 0 && (size_t) written < sizeof(descriptor_link)
            ? readlink(descriptor_link, descriptor_path, sizeof(descriptor_path) - 1)
            : -1;
        if (length < 0) {
            result = -errno;
            close(descriptor);
            goto complete;
        }
        descriptor_path[length] = '\0';
        if (strcmp(descriptor_path, evaluated_path) != 0) {
            result = -EACCES;
            close(descriptor);
            goto complete;
        }
        *directory_fd = descriptor;
    }

complete:
    pthread_mutex_unlock(&state->policy_mutex);
    return result;
}

static int authorize_path(const char *path, uint8_t access, atomic_ulong *operation_counter) {
    return authorize_path_internal(path, access, operation_counter, NULL);
}

static int authorize_directory_path(const char *path, int *directory_fd) {
    return authorize_path_internal(
        path,
        NATIVE_ACCESS_READ,
        &filesystem_state()->readdir_events,
        directory_fd
    );
}

static int check_policy_protocol(int argc, char **argv) {
    if (argc != 6) {
        fprintf(stderr, "usage: pi-fuse-native --check-policy-protocol SNAPSHOT REQUEST_FD RESPONSE_FD PATH\n");
        return 64;
    }
    benchmark_filesystem_t state = {0};
    state.request_fd = atoi(argv[3]);
    state.response_fd = atoi(argv[4]);
    if (make_nonblocking(state.request_fd) != 0
        || (state.response_fd != state.request_fd && make_nonblocking(state.response_fd) != 0)) {
        perror("configure native policy protocol descriptors");
        return 64;
    }
    if (strlen(argv[2]) >= sizeof(state.snapshot_path)) return 64;
    strcpy(state.snapshot_path, argv[2]);
    if (load_policy_snapshot(
        state.snapshot_path,
        &state.base_snapshot,
        &state.base_snapshot_file_status
    ) != 0) {
        perror("load native FUSE policy base snapshot");
        return 64;
    }
    state.base_snapshot_file_status_valid = true;
    int lookup = evaluate_policy_state(&state, argv[5], NATIVE_ACCESS_READ);
    if (lookup == POLICY_LOOKUP_MISS) {
        uint64_t observed_base_revision = state.base_snapshot.revision;
        uint64_t observed_once_revision = state.once_snapshot.revision;
        uint64_t request_id = ++state.next_request_id;
        uint8_t resolution_decision = NATIVE_DECISION_DENY;
        if (send_policy_event(
            &state,
            CONTROL_MESSAGE_MISS,
            request_id,
            observed_base_revision,
            observed_once_revision,
            NATIVE_ACCESS_READ,
            argv[5]
        ) != 0
            || wait_for_policy_resolution(
                &state,
                request_id,
                observed_base_revision,
                observed_once_revision,
                &resolution_decision
            ) != 0) {
            lookup = POLICY_LOOKUP_DENY;
        } else {
            lookup = resolution_decision == NATIVE_DECISION_ALLOW
                ? evaluate_policy_state(&state, argv[5], NATIVE_ACCESS_READ)
                : POLICY_LOOKUP_DENY;
        }
    }
    printf(
        "{\"baseRevision\":%lu,\"onceRevision\":%lu,\"decision\":\"%s\"}\n",
        (unsigned long) state.base_snapshot.revision,
        (unsigned long) state.once_snapshot.revision,
        lookup == POLICY_LOOKUP_ALLOW ? "allow" : "deny"
    );
    destroy_policy_snapshot(&state.base_snapshot);
    destroy_policy_snapshot(&state.once_snapshot);
    return lookup == POLICY_LOOKUP_ALLOW ? 0 : 2;
}

static struct fuse_operations filesystem_operations(void) {
    struct fuse_operations operations = {0};
    operations.init = benchmark_init;
    operations.destroy = benchmark_destroy;
    operations.access = benchmark_access;
    operations.getattr = benchmark_getattr;
    operations.fgetattr = benchmark_fgetattr;
    operations.readlink = benchmark_readlink;
    operations.statfs = benchmark_statfs;
    operations.opendir = benchmark_opendir;
    operations.readdir = benchmark_readdir;
    operations.fsyncdir = benchmark_fsyncdir;
    operations.releasedir = benchmark_releasedir;
    operations.open = benchmark_open;
    operations.create = benchmark_create;
    operations.utimens = benchmark_utimens;
    operations.chmod = benchmark_chmod;
    operations.chown = benchmark_chown;
    operations.getxattr = benchmark_getxattr;
    operations.listxattr = benchmark_listxattr;
    operations.setxattr = benchmark_setxattr;
    operations.removexattr = benchmark_removexattr;
    operations.mknod = benchmark_mknod;
    operations.read = benchmark_read;
    operations.write = benchmark_write;
    operations.truncate = benchmark_truncate;
    operations.ftruncate = benchmark_ftruncate;
    operations.flush = benchmark_flush;
    operations.fsync = benchmark_fsync;
    operations.release = benchmark_release;
    operations.mkdir = benchmark_mkdir;
    operations.rmdir = benchmark_rmdir;
    operations.unlink = benchmark_unlink;
    operations.rename = benchmark_rename;
    operations.link = benchmark_link;
    operations.symlink = benchmark_symlink;
    return operations;
}

static int run_filesystem(
    const char *program,
    const char *mountpoint,
    const char *hidden_path,
    const char *snapshot_path,
    const char *stats_path,
    int ready_fd,
    int request_fd,
    int response_fd,
    bool framed_ready
) {
    benchmark_filesystem_t state = {0};
    state.ready_fd = ready_fd;
    state.request_fd = request_fd;
    state.response_fd = response_fd;
    state.framed_ready = framed_ready;
    signal(SIGPIPE, SIG_IGN);
    if (make_nonblocking(state.request_fd) != 0
        || (state.response_fd != state.request_fd && make_nonblocking(state.response_fd) != 0)) {
        perror("configure native policy control descriptors");
        return 64;
    }
    if (realpath(hidden_path, state.hidden_path) == NULL) {
        perror("resolve hidden path");
        return 64;
    }
    if (strlen(snapshot_path) >= sizeof(state.snapshot_path)) {
        fprintf(stderr, "policy snapshot path is too long\n");
        return 64;
    }
    strcpy(state.snapshot_path, snapshot_path);
    if (load_policy_snapshot(
        state.snapshot_path,
        &state.base_snapshot,
        &state.base_snapshot_file_status
    ) != 0) {
        perror("load native FUSE policy base snapshot");
        return 64;
    }
    state.base_snapshot_file_status_valid = true;
    if (receive_initial_once_snapshot(&state) != 0
        || refresh_base_policy_snapshot_file(&state) != 0) {
        perror("synchronize native FUSE policy snapshots");
        destroy_policy_snapshot(&state.base_snapshot);
        destroy_policy_snapshot(&state.once_snapshot);
        return 64;
    }
    if (strlen(stats_path) >= sizeof(state.stats_path)) {
        fprintf(stderr, "statistics path is too long\n");
        destroy_policy_snapshot(&state.base_snapshot);
        destroy_policy_snapshot(&state.once_snapshot);
        return 64;
    }
    strcpy(state.stats_path, stats_path);
    if (pthread_mutex_init(&state.policy_mutex, NULL) != 0) {
        fprintf(stderr, "initialize native policy mutex failed\n");
        destroy_policy_snapshot(&state.base_snapshot);
        destroy_policy_snapshot(&state.once_snapshot);
        return 1;
    }

    struct fuse_operations operations = filesystem_operations();
    char options[] = "fsname=pilot-fuse-native,subtype=pilot-fuse-native,auto_unmount,entry_timeout=0.001,attr_timeout=0.001,ac_attr_timeout=0.001";
    char *fuse_arguments[] = {(char *) program, "-f", "-o", options, (char *) mountpoint, NULL};
    int result = fuse_main(5, fuse_arguments, &operations, &state);
    destroy_policy_snapshot(&state.base_snapshot);
    destroy_policy_snapshot(&state.once_snapshot);
    pthread_mutex_destroy(&state.policy_mutex);
    return result;
}

static int connect_policy_controller(const char *socket_path, const char *token) {
    if (strlen(socket_path) >= sizeof(((struct sockaddr_un *) 0)->sun_path)) {
        errno = ENAMETOOLONG;
        return -1;
    }
    int descriptor = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (descriptor < 0) return -1;
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    strcpy(address.sun_path, socket_path);
    if (connect(descriptor, (struct sockaddr *) &address, sizeof(address)) != 0) {
        close(descriptor);
        return -1;
    }
    size_t token_length = strlen(token);
    if (token_length == 0 || token_length > 128
        || write_exact(descriptor, token, token_length) != 0
        || write_exact(descriptor, "\n", 1) != 0) {
        close(descriptor);
        errno = EPROTO;
        return -1;
    }
    unsigned char acknowledgement;
    if (read_exact(descriptor, &acknowledgement, 1) != 0 || acknowledgement != 1) {
        close(descriptor);
        errno = EPROTO;
        return -1;
    }
    return descriptor;
}

static broker_worker_t **find_broker_worker(const char *token) {
    broker_worker_t **candidate = &broker_workers;
    while (*candidate != NULL && strcmp((*candidate)->token, token) != 0) {
        candidate = &(*candidate)->next;
    }
    return candidate;
}

static int wait_for_broker_worker(pid_t pid, long timeout_milliseconds) {
    const struct timespec pause = {.tv_sec = 0, .tv_nsec = 10 * 1000 * 1000};
    long waited = 0;
    while (true) {
        int status;
        pid_t result = waitpid(pid, &status, WNOHANG);
        if (result == pid || (result < 0 && errno == ECHILD)) return 0;
        if (result < 0 && errno != EINTR) return -1;
        if (waited >= timeout_milliseconds) return 1;
        nanosleep(&pause, NULL);
        waited += 10;
    }
}

static int stop_broker_mount(const char *token, bool report) {
    broker_worker_t **slot = find_broker_worker(token);
    broker_worker_t *worker = *slot;
    if (worker != NULL) {
        int stopped = wait_for_broker_worker(worker->pid, 0);
        if (stopped > 0) {
            if (kill(worker->pid, SIGTERM) != 0 && errno != ESRCH) return -1;
            stopped = wait_for_broker_worker(worker->pid, 500);
        }
        if (stopped > 0) {
            if (kill(worker->pid, SIGKILL) != 0 && errno != ESRCH) return -1;
            do {
                stopped = waitpid(worker->pid, NULL, 0) < 0 ? -1 : 0;
            } while (stopped < 0 && errno == EINTR);
            if (stopped < 0 && errno != ECHILD) return -1;
        } else if (stopped < 0) {
            return -1;
        }
        *slot = worker->next;
        free(worker);
    }
    if (report) {
        fprintf(stdout, "STOPPED\t%s\n", token);
        fflush(stdout);
    }
    return 0;
}

static void stop_all_broker_mounts(void) {
    while (broker_workers != NULL) {
        char token[sizeof(broker_workers->token)];
        strcpy(token, broker_workers->token);
        if (stop_broker_mount(token, false) != 0) {
            perror("stop native FUSE broker mount");
            break;
        }
    }
}

static int spawn_broker_mount(char *line, const char *program) {
    char *save = NULL;
    char *fields[8];
    size_t count = 0;
    for (char *field = strtok_r(line, "\t\r\n", &save);
         field != NULL && count < 8;
         field = strtok_r(NULL, "\t\r\n", &save)) {
        fields[count++] = field;
    }
    if (count != 7 || strcmp(fields[0], "START") != 0) {
        errno = EPROTO;
        return -1;
    }
    for (size_t index = 1; index < 7; index++) {
        if (fields[index][0] == '\0' || strlen(fields[index]) >= PATH_MAX) {
            errno = EINVAL;
            return -1;
        }
    }
    if (strlen(fields[1]) > 128 || *find_broker_worker(fields[1]) != NULL) {
        errno = EINVAL;
        return -1;
    }
    broker_worker_t *worker = calloc(1, sizeof(*worker));
    if (worker == NULL) return -1;
    strcpy(worker->token, fields[1]);

    pid_t parent = getpid();
    pid_t child = fork();
    if (child < 0) {
        free(worker);
        return -1;
    }
    if (child > 0) {
        worker->pid = child;
        worker->next = broker_workers;
        broker_workers = worker;
        fprintf(stdout, "STARTED\t%s\t%d\n", fields[1], child);
        fflush(stdout);
        return 0;
    }

    signal(SIGCHLD, SIG_DFL);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent) _exit(1);
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    int control = connect_policy_controller(fields[6], fields[1]);
    if (control < 0) {
        perror("connect native FUSE policy controller");
        _exit(1);
    }
    int result = run_filesystem(
        program,
        fields[2],
        fields[3],
        fields[4],
        fields[5],
        -1,
        control,
        control,
        true
    );
    close(control);
    _exit(result);
}

static int run_broker(const char *program) {
    signal(SIGPIPE, SIG_IGN);
    char *line = NULL;
    size_t capacity = 0;
    int result = 0;
    while (getline(&line, &capacity, stdin) >= 0) {
        if (strcmp(line, "SHUTDOWN\n") == 0 || strcmp(line, "SHUTDOWN\r\n") == 0) break;
        if (strncmp(line, "STOP\t", 5) == 0) {
            char *token = line + 5;
            token[strcspn(token, "\r\n")] = '\0';
            if (token[0] == '\0' || strlen(token) > 128 || strchr(token, '\t') != NULL
                || stop_broker_mount(token, true) != 0) {
                perror("stop native FUSE broker mount");
            }
            continue;
        }
        if (strlen(line) > PATH_MAX * 5U || spawn_broker_mount(line, program) != 0) {
            perror("start native FUSE broker mount");
        }
    }
    if (ferror(stdin)) result = 1;
    stop_all_broker_mounts();
    free(line);
    return result;
}

int main(int argc, char **argv) {
    pid_t parent = getppid();
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent) {
        perror("configure native FUSE parent-death signal");
        return 1;
    }
    if (argc > 1 && strcmp(argv[1], "--check-policy-protocol") == 0) {
        return check_policy_protocol(argc, argv);
    }
    if (argc == 2 && strcmp(argv[1], "--broker") == 0) return run_broker(argv[0]);
    if (argc != 8) {
        fprintf(
            stderr,
            "usage: pi-fuse-native MOUNTPOINT HIDDEN_PATH SNAPSHOT_PATH STATS_PATH READY_FD REQUEST_FD RESPONSE_FD\n"
            "       pi-fuse-native --broker\n"
        );
        return 64;
    }
    return run_filesystem(
        argv[0],
        argv[1],
        argv[2],
        argv[3],
        argv[4],
        atoi(argv[5]),
        atoi(argv[6]),
        atoi(argv[7]),
        false
    );
}
