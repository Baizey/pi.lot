#ifndef PILOT_NATIVE_FUSE_PROBE_H
#define PILOT_NATIVE_FUSE_PROBE_H

/* Keep the probes independent of the production adapter and its generated
 * bindings: the installed C header is the ABI authority for these callers. */
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
#include <sys/statvfs.h>
#include <sys/uio.h>
#include <unistd.h>

struct pilot_fuse_state;
extern struct pilot_fuse_state *pilot_fuse_probe_new(const char *, const char *, int, int);
extern void pilot_fuse_probe_free(struct pilot_fuse_state *);
extern int pilot_fuse_operations(struct fuse_operations *, size_t);
extern void *pilot_fuse_init(struct fuse_conn_info *, struct fuse_config *);
extern int pilot_fuse_main(int, char **, struct pilot_fuse_state *);

static struct fuse_operations filesystem_operations(void) {
    struct fuse_operations operations = {0};
    if (pilot_fuse_operations(&operations, sizeof(operations)) != 0) abort();
    return operations;
}

#endif
