/* Exercise real libfuse INIT negotiation through custom I/O, without a mount. */
#include "native-fuse-probe.h"

#include <fuse_lowlevel.h>
#include <linux/fuse.h>

static bool init_called;
static bool requested_before_init;
static bool requested_after_init;
static bool capabilities_preserved;
static bool configuration_safe;
static bool state_returned;
static bool connection_fields_preserved;
static bool configuration_fields_preserved;

static uint64_t forbidden_capabilities(void) {
    return FUSE_CAP_DIRECT_IO_ALLOW_MMAP | FUSE_CAP_WRITEBACK_CACHE
        | FUSE_CAP_PASSTHROUGH | FUSE_CAP_ASYNC_DIO | FUSE_CAP_ATOMIC_O_TRUNC
        | FUSE_CAP_NO_OPEN_SUPPORT | FUSE_CAP_NO_OPENDIR_SUPPORT;
}

static void *probe_init(struct fuse_conn_info *connection, struct fuse_config *configuration) {
    /* This is a real libfuse-owned connection, so helpers may safely update
     * their enclosing session as well as the public connection fields. */
    const uint64_t capabilities[] = {
        FUSE_CAP_DIRECT_IO_ALLOW_MMAP, FUSE_CAP_WRITEBACK_CACHE, FUSE_CAP_PASSTHROUGH,
        FUSE_CAP_ASYNC_DIO, FUSE_CAP_ATOMIC_O_TRUNC, FUSE_CAP_NO_OPEN_SUPPORT,
        FUSE_CAP_NO_OPENDIR_SUPPORT,
    };
    for (size_t index = 0; index < sizeof(capabilities) / sizeof(capabilities[0]); index++) {
        fuse_set_feature_flag(connection, capabilities[index]);
    }
    requested_before_init = (connection->want_ext & forbidden_capabilities()) == forbidden_capabilities();
    uint64_t capable_ext = connection->capable_ext;
    uint32_t capable = connection->capable;
    configuration->parallel_direct_writes = 1;
    configuration->nullpath_ok = 1;
    configuration->direct_io = 1;
    configuration->kernel_cache = 1;
    configuration->auto_cache = 1;
    struct fuse_conn_info expected_connection;
    memcpy(&expected_connection, connection, sizeof(expected_connection));
    expected_connection.want &= ~(uint32_t) forbidden_capabilities();
    expected_connection.want_ext &= ~forbidden_capabilities();
    struct fuse_config expected_configuration;
    memcpy(&expected_configuration, configuration, sizeof(expected_configuration));
    expected_configuration.parallel_direct_writes = 0;
    expected_configuration.nullpath_ok = 0;
    expected_configuration.direct_io = 0;
    expected_configuration.kernel_cache = 0;
    expected_configuration.auto_cache = 0;
    void *state = fuse_get_context()->private_data;
    void *initialized = pilot_fuse_init(connection, configuration);
    /* Do not use fuse_get_feature_flag(): 3.18.2 checks capable_ext, not want_ext. */
    requested_after_init = (connection->want_ext & forbidden_capabilities()) != 0
        || (connection->want & (uint32_t) forbidden_capabilities()) != 0;
    capabilities_preserved = connection->capable_ext == capable_ext && connection->capable == capable;
    configuration_safe = configuration->parallel_direct_writes == 0 && configuration->nullpath_ok == 0
        && configuration->direct_io == 0 && configuration->kernel_cache == 0 && configuration->auto_cache == 0;
    state_returned = initialized == state;
    connection_fields_preserved = memcmp(connection, &expected_connection, sizeof(expected_connection)) == 0;
    configuration_fields_preserved = memcmp(configuration, &expected_configuration, sizeof(expected_configuration)) == 0;
    init_called = true;
    return initialized;
}

static ssize_t probe_writev(int descriptor, struct iovec *vectors, int count, void *userdata) {
    (void) userdata;
    return writev(descriptor, vectors, count);
}

static ssize_t probe_read(int descriptor, void *buffer, size_t size, void *userdata) {
    (void) userdata;
    return read(descriptor, buffer, size);
}

static int probe_negotiation(char **argv, bool supported, struct pilot_fuse_state *state) {
    void *private_state = state;
    struct fuse_operations operations = filesystem_operations();
    operations.init = probe_init;
    /* No backing filesystem or statistics lifecycle is started by this test. */
    operations.destroy = NULL;
    char *arguments[] = {argv[0]};
    struct fuse_args args = FUSE_ARGS_INIT(1, arguments);
    struct fuse *filesystem = fuse_new(&args, &operations, sizeof(operations), private_state);
    fuse_opt_free_args(&args);
    if (filesystem == NULL) return 65;
    int descriptors[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, descriptors) != 0) {
        fuse_destroy(filesystem);
        return 65;
    }
    struct fuse_session *session = fuse_get_session(filesystem);
    const struct fuse_custom_io io = {.writev = probe_writev, .read = probe_read};
    if (fuse_session_custom_io(session, &io, sizeof(io), descriptors[0]) != 0) {
        close(descriptors[0]);
        close(descriptors[1]);
        fuse_destroy(filesystem);
        return 65;
    }

    uint64_t forbidden_flags = FUSE_DIRECT_IO_ALLOW_MMAP | FUSE_WRITEBACK_CACHE | FUSE_PASSTHROUGH
        | FUSE_ASYNC_DIO | FUSE_ATOMIC_O_TRUNC | FUSE_NO_OPEN_SUPPORT | FUSE_NO_OPENDIR_SUPPORT;
    uint64_t offered = FUSE_INIT_EXT | FUSE_ASYNC_READ | FUSE_MAX_PAGES;
    if (supported) offered |= forbidden_flags;
    struct {
        struct fuse_in_header header;
        struct fuse_init_in init;
    } request = {0};
    request.header.len = sizeof(request);
    request.header.opcode = FUSE_INIT;
    request.header.unique = 1;
    request.header.uid = getuid();
    request.header.gid = getgid();
    request.header.pid = getpid();
    request.init.major = FUSE_KERNEL_VERSION;
    request.init.minor = FUSE_KERNEL_MINOR_VERSION;
    request.init.max_readahead = 128 * 1024;
    request.init.flags = (uint32_t) offered;
    request.init.flags2 = (uint32_t) (offered >> 32);
    struct fuse_buf buffer = {.size = sizeof(request), .mem = &request};
    fuse_session_process_buf(session, &buffer);
    struct {
        struct fuse_out_header header;
        struct fuse_init_out init;
    } reply = {0};
    ssize_t received = recv(descriptors[1], &reply, sizeof(reply), MSG_DONTWAIT);
    uint64_t negotiated = reply.init.flags | ((uint64_t) reply.init.flags2 << 32);
    bool reply_valid = received == (ssize_t) sizeof(reply)
        && reply.header.len == (uint32_t) received && reply.header.unique == 1
        && reply.header.error == 0 && reply.init.major == FUSE_KERNEL_VERSION;
    printf("{\"replyValid\":%s,\"initCalled\":%s,\"requestedBeforeInit\":%s,"
        "\"requestedAfterInit\":%s,\"forbiddenNegotiated\":%s,\"asyncReadNegotiated\":%s,"
        "\"capabilitiesPreserved\":%s,\"configurationSafe\":%s,\"stateReturned\":%s,"
        "\"connectionFieldsPreserved\":%s,\"configurationFieldsPreserved\":%s}\n",
        reply_valid ? "true" : "false", init_called ? "true" : "false",
        requested_before_init ? "true" : "false", requested_after_init ? "true" : "false",
        (negotiated & forbidden_flags) != 0 ? "true" : "false",
        (negotiated & FUSE_ASYNC_READ) != 0 ? "true" : "false",
        capabilities_preserved ? "true" : "false", configuration_safe ? "true" : "false",
        state_returned ? "true" : "false", connection_fields_preserved ? "true" : "false",
        configuration_fields_preserved ? "true" : "false");
    close(descriptors[1]);
    fuse_destroy(filesystem);
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 3 && (strcmp(argv[1], "main-c") == 0 || strcmp(argv[1], "main-rust") == 0)) {
        if (strcmp(argv[2], "--help") != 0 && strcmp(argv[2], "--version") != 0
            && strcmp(argv[2], "--pilot-invalid-option") != 0) return 64;
        char program[] = "pilot-fuse-abi-probe";
        char *arguments[] = {program, argv[2], NULL};
        struct fuse_operations operations = filesystem_operations();
        /* These options return before mounting. Compare Rust with the actual
         * installed-header macro, not a second handwritten version record. */
        return strcmp(argv[1], "main-rust") == 0
            ? pilot_fuse_main(2, arguments, NULL) : fuse_main(2, arguments, &operations, NULL);
    }
    if (argc != 2 || (strcmp(argv[1], "supported") != 0 && strcmp(argv[1], "unsupported") != 0)) return 64;
    struct pilot_fuse_state *state = pilot_fuse_probe_new(NULL, NULL, -1, -1);
    if (state == NULL) return 65;
    int result = probe_negotiation(argv, strcmp(argv[1], "supported") == 0, state);
    pilot_fuse_probe_free(state);
    return result;
}
