/* Only libfuse ABI marshalling belongs here. Policy, paths, backing I/O,
 * control protocol, lifecycle and broker logic are implemented in Rust. */
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#define FUSE_USE_VERSION 317
#include <fuse.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

struct pilot_fuse_state;
extern struct pilot_fuse_state *pilot_fuse_probe_new(const char *, const char *, int, int);
extern void pilot_fuse_probe_free(struct pilot_fuse_state *);
extern int pilot_fuse_ready(struct pilot_fuse_state *);
extern void pilot_fuse_statistics(struct pilot_fuse_state *);

/* Keep this private ABI in sync with fuse/callbacks.rs. */
struct pilot_fuse_call {
    const char *path;
    const char *second;
    void *buffer;
    size_t size;
    off_t offset;
    uint64_t fh;
    int flags;
    mode_t mode;
    uid_t uid;
    gid_t gid;
    dev_t device;
    fuse_fill_dir_t filler;
    int has_info;
    int direct_io;
    int keep_cache;
};
extern int pilot_fuse_call(struct pilot_fuse_state *, unsigned int, struct pilot_fuse_call *);

static void *filesystem_state(void) { return fuse_get_context()->private_data; }
static int dispatch(unsigned int operation, struct pilot_fuse_call *call, struct fuse_file_info *info) {
    if (info != NULL) {
        call->has_info = 1;
        call->fh = info->fh;
        call->direct_io = info->direct_io;
        call->keep_cache = info->keep_cache;
    }
    int result = pilot_fuse_call(filesystem_state(), operation, call);
    if (info != NULL) {
        info->fh = call->fh;
        info->direct_io = call->direct_io != 0;
        info->keep_cache = call->keep_cache != 0;
    }
    return result;
}
static void *benchmark_init(struct fuse_conn_info *connection, struct fuse_config *configuration) {
    fuse_unset_feature_flag(connection, FUSE_CAP_DIRECT_IO_ALLOW_MMAP);
    fuse_unset_feature_flag(connection, FUSE_CAP_WRITEBACK_CACHE);
    fuse_unset_feature_flag(connection, FUSE_CAP_PASSTHROUGH);
    fuse_unset_feature_flag(connection, FUSE_CAP_ASYNC_DIO);
    fuse_unset_feature_flag(connection, FUSE_CAP_ATOMIC_O_TRUNC);
    fuse_unset_feature_flag(connection, FUSE_CAP_NO_OPEN_SUPPORT);
    fuse_unset_feature_flag(connection, FUSE_CAP_NO_OPENDIR_SUPPORT);
    configuration->parallel_direct_writes = 0;
    configuration->nullpath_ok = 0;
    configuration->direct_io = 0;
    configuration->kernel_cache = 0;
    configuration->auto_cache = 0;
    void *state = filesystem_state();
    (void) pilot_fuse_ready(state);
    return state;
}
static void benchmark_destroy(void *state) { pilot_fuse_statistics(state); }
static int benchmark_access(const char *path, int mode) {
    struct pilot_fuse_call c = {.path = path, .flags = mode}; return dispatch(1, &c, NULL);
}
static int benchmark_getattr(const char *path, struct stat *attributes, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .buffer = attributes}; return dispatch(2, &c, info);
}
static int benchmark_readlink(const char *path, char *buffer, size_t size) {
    struct pilot_fuse_call c = {.path = path, .buffer = buffer, .size = size}; return dispatch(3, &c, NULL);
}
static int benchmark_statfs(const char *path, struct statvfs *statistics) {
    struct pilot_fuse_call c = {.path = path, .buffer = statistics}; return dispatch(4, &c, NULL);
}
static int benchmark_opendir(const char *path, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path}; return dispatch(5, &c, info);
}
static int benchmark_readdir(const char *path, void *buffer, fuse_fill_dir_t filler, off_t offset,
    struct fuse_file_info *info, enum fuse_readdir_flags flags) {
    struct pilot_fuse_call c = {.path = path, .buffer = buffer, .filler = filler, .offset = offset, .flags = flags};
    return dispatch(6, &c, info);
}
static int benchmark_fsyncdir(const char *path, int data_only, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .flags = data_only}; return dispatch(7, &c, info);
}
static int benchmark_releasedir(const char *path, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path}; return dispatch(8, &c, info);
}
static int benchmark_open(const char *path, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .flags = info->flags}; return dispatch(9, &c, info);
}
static int benchmark_create(const char *path, mode_t mode, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .mode = mode, .flags = info->flags}; return dispatch(10, &c, info);
}
static int benchmark_utimens(const char *path, const struct timespec times[2], struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .buffer = (void *) times}; return dispatch(11, &c, info);
}
static int benchmark_chmod(const char *path, mode_t mode, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .mode = mode}; return dispatch(12, &c, info);
}
static int benchmark_chown(const char *path, uid_t uid, gid_t gid, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .uid = uid, .gid = gid}; return dispatch(13, &c, info);
}
static int benchmark_getxattr(const char *path, const char *name, char *value, size_t size) {
    struct pilot_fuse_call c = {.path = path, .second = name, .buffer = value, .size = size}; return dispatch(14, &c, NULL);
}
static int benchmark_listxattr(const char *path, char *list, size_t size) {
    struct pilot_fuse_call c = {.path = path, .buffer = list, .size = size}; return dispatch(15, &c, NULL);
}
static int benchmark_setxattr(const char *path, const char *name, const char *value, size_t size, int flags) {
    struct pilot_fuse_call c = {.path = path, .second = name, .buffer = (void *) value, .size = size, .flags = flags}; return dispatch(16, &c, NULL);
}
static int benchmark_removexattr(const char *path, const char *name) {
    struct pilot_fuse_call c = {.path = path, .second = name}; return dispatch(17, &c, NULL);
}
static int benchmark_mknod(const char *path, mode_t mode, dev_t device) {
    struct pilot_fuse_call c = {.path = path, .mode = mode, .device = device}; return dispatch(18, &c, NULL);
}
static int benchmark_read(const char *path, char *buffer, size_t size, off_t offset, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .buffer = buffer, .size = size, .offset = offset}; return dispatch(19, &c, info);
}
static int benchmark_write(const char *path, const char *buffer, size_t size, off_t offset, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .buffer = (void *) buffer, .size = size, .offset = offset}; return dispatch(20, &c, info);
}
static int benchmark_truncate(const char *path, off_t size, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .offset = size}; return dispatch(21, &c, info);
}
static int benchmark_flush(const char *path, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path}; return dispatch(22, &c, info);
}
static int benchmark_fsync(const char *path, int data_only, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path, .flags = data_only}; return dispatch(23, &c, info);
}
static int benchmark_release(const char *path, struct fuse_file_info *info) {
    struct pilot_fuse_call c = {.path = path}; return dispatch(24, &c, info);
}
static int benchmark_mkdir(const char *path, mode_t mode) {
    struct pilot_fuse_call c = {.path = path, .mode = mode}; return dispatch(25, &c, NULL);
}
static int benchmark_rmdir(const char *path) {
    struct pilot_fuse_call c = {.path = path}; return dispatch(26, &c, NULL);
}
static int benchmark_unlink(const char *path) {
    struct pilot_fuse_call c = {.path = path}; return dispatch(27, &c, NULL);
}
static int benchmark_rename(const char *source, const char *destination, unsigned int flags) {
    struct pilot_fuse_call c = {.path = source, .second = destination, .flags = (int) flags}; return dispatch(28, &c, NULL);
}
static int benchmark_link(const char *source, const char *destination) {
    struct pilot_fuse_call c = {.path = source, .second = destination}; return dispatch(29, &c, NULL);
}
static int benchmark_symlink(const char *target, const char *path) {
    struct pilot_fuse_call c = {.path = path, .second = target}; return dispatch(30, &c, NULL);
}
static struct fuse_operations filesystem_operations(void) {
    struct fuse_operations operations = {0};
    operations.init = benchmark_init;
    operations.destroy = benchmark_destroy;
    operations.access = benchmark_access;
    operations.getattr = benchmark_getattr;
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
int pilot_fuse_main(int argc, char **argv, struct pilot_fuse_state *state) {
    struct fuse_operations operations = filesystem_operations();
    return fuse_main(argc, argv, &operations, state);
}
