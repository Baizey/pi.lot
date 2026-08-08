#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef IP_TRANSPARENT
#define IP_TRANSPARENT 19
#endif
#ifndef IPV6_TRANSPARENT
#define IPV6_TRANSPARENT 75
#endif

#define PROTOCOL_PREFIX "PI_TCP_GATEWAY\t1"
#define LISTEN_BACKLOG 128
#define MAX_ACTIVE_RELAYS 128
#define RELAY_BUFFER_SIZE (64U * 1024U)

static volatile sig_atomic_t active_relays = 0;

typedef struct {
    unsigned char bytes[RELAY_BUFFER_SIZE];
    size_t offset;
    size_t length;
} relay_buffer;

static void report_error(const char *message) {
    fprintf(stderr, "pi-tcp-gateway: %s: %s\n", message, strerror(errno));
}

static int parse_port(const char *value, uint16_t *port) {
    if (!value || !*value) return -1;
    char *end = NULL;
    errno = 0;
    unsigned long parsed = strtoul(value, &end, 10);
    if (errno != 0 || !end || *end != '\0' || parsed == 0 || parsed > UINT16_MAX) return -1;
    *port = (uint16_t) parsed;
    return 0;
}

static int set_close_on_exec(int descriptor) {
    int flags = fcntl(descriptor, F_GETFD);
    if (flags < 0 || fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) < 0) return -1;
    return 0;
}

static int drop_process_privileges(void) {
    struct __user_cap_header_struct header = {
        .version = _LINUX_CAPABILITY_VERSION_3,
        .pid = 0,
    };
    struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
    if (prctl(PR_SET_DUMPABLE, 0) < 0
        || prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) < 0
        || syscall(SYS_capset, &header, capabilities) < 0
        || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
        return -1;
    }
    return 0;
}

static int create_listener(int family, uint16_t port, uint16_t *bound_port) {
    int descriptor = socket(family, SOCK_STREAM, 0);
    if (descriptor < 0) return -1;
    if (set_close_on_exec(descriptor) < 0) {
        close(descriptor);
        return -1;
    }

    int enabled = 1;
    if (setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled)) < 0) {
        close(descriptor);
        return -1;
    }
    if (family == AF_INET) {
        if (setsockopt(descriptor, SOL_IP, IP_TRANSPARENT, &enabled, sizeof(enabled)) < 0) {
            close(descriptor);
            return -1;
        }
        struct sockaddr_in address = {
            .sin_family = AF_INET,
            .sin_port = htons(port),
            .sin_addr = {.s_addr = htonl(INADDR_ANY)},
        };
        if (bind(descriptor, (struct sockaddr *) &address, sizeof(address)) < 0) {
            close(descriptor);
            return -1;
        }
        socklen_t length = sizeof(address);
        if (getsockname(descriptor, (struct sockaddr *) &address, &length) < 0) {
            close(descriptor);
            return -1;
        }
        *bound_port = ntohs(address.sin_port);
    } else {
        if (setsockopt(descriptor, SOL_IPV6, IPV6_V6ONLY, &enabled, sizeof(enabled)) < 0
            || setsockopt(descriptor, SOL_IPV6, IPV6_TRANSPARENT, &enabled, sizeof(enabled)) < 0) {
            close(descriptor);
            return -1;
        }
        struct sockaddr_in6 address = {
            .sin6_family = AF_INET6,
            .sin6_port = htons(port),
            .sin6_addr = IN6ADDR_ANY_INIT,
        };
        if (bind(descriptor, (struct sockaddr *) &address, sizeof(address)) < 0) {
            close(descriptor);
            return -1;
        }
        *bound_port = port;
    }

    if (listen(descriptor, LISTEN_BACKLOG) < 0) {
        close(descriptor);
        return -1;
    }
    return descriptor;
}

static int connect_broker(const struct in_addr *address, uint16_t port) {
    int descriptor = socket(AF_INET, SOCK_STREAM, 0);
    if (descriptor < 0) return -1;
    if (set_close_on_exec(descriptor) < 0) {
        close(descriptor);
        return -1;
    }
    struct sockaddr_in destination = {
        .sin_family = AF_INET,
        .sin_port = htons(port),
        .sin_addr = *address,
    };
    if (connect(descriptor, (struct sockaddr *) &destination, sizeof(destination)) < 0) {
        close(descriptor);
        return -1;
    }
    return descriptor;
}

static int endpoint_text(
    const struct sockaddr_storage *address,
    socklen_t length,
    char *host,
    size_t host_size,
    char *service,
    size_t service_size
) {
    return getnameinfo(
        (const struct sockaddr *) address,
        length,
        host,
        (socklen_t) host_size,
        service,
        (socklen_t) service_size,
        NI_NUMERICHOST | NI_NUMERICSERV
    );
}

static int write_all(int descriptor, const void *data, size_t length) {
    const unsigned char *bytes = data;
    size_t written = 0;
    while (written < length) {
        ssize_t result = send(descriptor, bytes + written, length - written, MSG_NOSIGNAL);
        if (result > 0) {
            written += (size_t) result;
            continue;
        }
        if (result < 0 && errno == EINTR) continue;
        return -1;
    }
    return 0;
}

static int set_nonblocking(int descriptor) {
    int flags = fcntl(descriptor, F_GETFL);
    if (flags < 0 || fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) < 0) return -1;
    return 0;
}

static void compact_buffer(relay_buffer *buffer) {
    if (buffer->length == 0) {
        buffer->offset = 0;
        return;
    }
    if (buffer->offset > 0) {
        memmove(buffer->bytes, buffer->bytes + buffer->offset, buffer->length);
        buffer->offset = 0;
    }
}

static int receive_into(int descriptor, relay_buffer *buffer, int *ended) {
    compact_buffer(buffer);
    size_t available = RELAY_BUFFER_SIZE - buffer->length;
    if (available == 0 || *ended) return 0;
    ssize_t received = recv(descriptor, buffer->bytes + buffer->length, available, 0);
    if (received > 0) {
        buffer->length += (size_t) received;
        return 0;
    }
    if (received == 0) {
        *ended = 1;
        return 0;
    }
    if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) return 0;
    return -1;
}

static int send_from(int descriptor, relay_buffer *buffer) {
    if (buffer->length == 0) return 0;
    ssize_t sent = send(descriptor, buffer->bytes + buffer->offset, buffer->length, MSG_NOSIGNAL);
    if (sent > 0) {
        buffer->offset += (size_t) sent;
        buffer->length -= (size_t) sent;
        if (buffer->length == 0) buffer->offset = 0;
        return 0;
    }
    if (sent < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    return -1;
}

static int relay_streams(int client, int broker) {
    if (set_nonblocking(client) < 0 || set_nonblocking(broker) < 0) return -1;
    relay_buffer client_to_broker = {0};
    relay_buffer broker_to_client = {0};
    int client_ended = 0;
    int broker_ended = 0;
    int client_write_closed = 0;
    int broker_write_closed = 0;

    while (1) {
        if (client_ended && client_to_broker.length == 0 && !broker_write_closed) {
            if (shutdown(broker, SHUT_WR) < 0 && errno != ENOTCONN) return -1;
            broker_write_closed = 1;
        }
        if (broker_ended && broker_to_client.length == 0 && !client_write_closed) {
            if (shutdown(client, SHUT_WR) < 0 && errno != ENOTCONN) return -1;
            client_write_closed = 1;
        }
        if (client_ended && broker_ended
            && client_to_broker.length == 0 && broker_to_client.length == 0) {
            return 0;
        }

        struct pollfd descriptors[2] = {
            {.fd = client, .events = 0, .revents = 0},
            {.fd = broker, .events = 0, .revents = 0},
        };
        if (!client_ended && client_to_broker.length < RELAY_BUFFER_SIZE) descriptors[0].events |= POLLIN;
        if (broker_to_client.length > 0) descriptors[0].events |= POLLOUT;
        if (!broker_ended && broker_to_client.length < RELAY_BUFFER_SIZE) descriptors[1].events |= POLLIN;
        if (client_to_broker.length > 0) descriptors[1].events |= POLLOUT;

        int result = poll(descriptors, 2, -1);
        if (result < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if ((descriptors[0].revents & (POLLIN | POLLHUP)) != 0
            && receive_into(client, &client_to_broker, &client_ended) < 0) return -1;
        if ((descriptors[1].revents & (POLLIN | POLLHUP)) != 0
            && receive_into(broker, &broker_to_client, &broker_ended) < 0) return -1;
        if ((descriptors[0].revents & POLLOUT) != 0
            && send_from(client, &broker_to_client) < 0) return -1;
        if ((descriptors[1].revents & POLLOUT) != 0
            && send_from(broker, &client_to_broker) < 0) return -1;
        if ((descriptors[0].revents & (POLLERR | POLLNVAL)) != 0
            || (descriptors[1].revents & (POLLERR | POLLNVAL)) != 0) return -1;
    }
}

static int handle_client(int client, const struct in_addr *broker_address, uint16_t broker_port) {
    struct sockaddr_storage source = {0};
    struct sockaddr_storage destination = {0};
    socklen_t source_length = sizeof(source);
    socklen_t destination_length = sizeof(destination);
    if (getpeername(client, (struct sockaddr *) &source, &source_length) < 0
        || getsockname(client, (struct sockaddr *) &destination, &destination_length) < 0
        || source.ss_family != destination.ss_family
        || (source.ss_family != AF_INET && source.ss_family != AF_INET6)) {
        return -1;
    }

    char source_host[NI_MAXHOST];
    char source_service[NI_MAXSERV];
    char destination_host[NI_MAXHOST];
    char destination_service[NI_MAXSERV];
    if (endpoint_text(
            &source,
            source_length,
            source_host,
            sizeof(source_host),
            source_service,
            sizeof(source_service)
        ) != 0
        || endpoint_text(
            &destination,
            destination_length,
            destination_host,
            sizeof(destination_host),
            destination_service,
            sizeof(destination_service)
        ) != 0) {
        return -1;
    }

    int broker = connect_broker(broker_address, broker_port);
    if (broker < 0) return -1;
    char header[1024];
    int header_length = snprintf(
        header,
        sizeof(header),
        PROTOCOL_PREFIX "\tFLOW\t%s\t%s\t%s\t%s\t%s\n",
        source.ss_family == AF_INET ? "IPV4" : "IPV6",
        source_host,
        source_service,
        destination_host,
        destination_service
    );
    if (header_length < 0 || (size_t) header_length >= sizeof(header)
        || write_all(broker, header, (size_t) header_length) < 0) {
        close(broker);
        return -1;
    }

    int result = relay_streams(client, broker);
    close(broker);
    return result;
}

static void reap_children(int signal_number) {
    (void) signal_number;
    int saved_errno = errno;
    while (waitpid(-1, NULL, WNOHANG) > 0) {
        if (active_relays > 0) active_relays--;
    }
    errno = saved_errno;
}

static int install_signal_handlers(void) {
    struct sigaction action = {0};
    action.sa_handler = reap_children;
    action.sa_flags = SA_RESTART | SA_NOCLDSTOP;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL) < 0) return -1;
    signal(SIGPIPE, SIG_IGN);
    return 0;
}

static void accept_client(
    int listener,
    const int *listeners,
    size_t listener_count,
    const struct in_addr *broker_address,
    uint16_t broker_port
) {
    int client = accept(listener, NULL, NULL);
    if (client < 0) {
        if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) report_error("accept flow");
        return;
    }
    if (set_close_on_exec(client) < 0 || active_relays >= MAX_ACTIVE_RELAYS) {
        close(client);
        return;
    }

    sigset_t blocked;
    sigset_t previous;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGCHLD);
    if (sigprocmask(SIG_BLOCK, &blocked, &previous) < 0) {
        close(client);
        return;
    }
    pid_t child = fork();
    if (child == 0) {
        sigprocmask(SIG_SETMASK, &previous, NULL);
        signal(SIGCHLD, SIG_DFL);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() == 1) _exit(EXIT_FAILURE);
        for (size_t index = 0; index < listener_count; index++) close(listeners[index]);
        int result = handle_client(client, broker_address, broker_port);
        close(client);
        _exit(result == 0 ? EXIT_SUCCESS : EXIT_FAILURE);
    }
    if (child > 0) active_relays++;
    else report_error("fork relay");
    sigprocmask(SIG_SETMASK, &previous, NULL);
    close(client);
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: pi-tcp-gateway BROKER_IPV4 BROKER_PORT\n");
        return EXIT_FAILURE;
    }
    struct in_addr broker_address;
    uint16_t broker_port = 0;
    if (inet_pton(AF_INET, argv[1], &broker_address) != 1 || parse_port(argv[2], &broker_port) < 0) {
        fprintf(stderr, "pi-tcp-gateway: invalid broker endpoint\n");
        return EXIT_FAILURE;
    }
    if (install_signal_handlers() < 0) {
        report_error("install signal handlers");
        return EXIT_FAILURE;
    }

    uint16_t ingress_port = 0;
    int ipv4_listener = create_listener(AF_INET, 0, &ingress_port);
    if (ipv4_listener < 0) {
        report_error("create IPv4 transparent listener");
        return EXIT_FAILURE;
    }
    uint16_t ipv6_port = ingress_port;
    int ipv6_listener = create_listener(AF_INET6, ingress_port, &ipv6_port);
    if (ipv6_listener < 0) {
        report_error("create IPv6 transparent listener");
        close(ipv4_listener);
        return EXIT_FAILURE;
    }
    if (drop_process_privileges() < 0) {
        report_error("drop gateway privileges");
        close(ipv4_listener);
        close(ipv6_listener);
        return EXIT_FAILURE;
    }

    if (printf(PROTOCOL_PREFIX "\tREADY\t%u\n", (unsigned int) ingress_port) < 0
        || fflush(stdout) != 0) {
        report_error("send readiness record");
        close(ipv4_listener);
        close(ipv6_listener);
        return EXIT_FAILURE;
    }

    int listeners[2] = {ipv4_listener, ipv6_listener};
    while (1) {
        struct pollfd descriptors[2] = {
            {.fd = ipv4_listener, .events = POLLIN, .revents = 0},
            {.fd = ipv6_listener, .events = POLLIN, .revents = 0},
        };
        int result = poll(descriptors, 2, -1);
        if (result < 0) {
            if (errno == EINTR) continue;
            report_error("poll listeners");
            break;
        }
        for (size_t index = 0; index < 2; index++) {
            if ((descriptors[index].revents & POLLIN) != 0) {
                accept_client(
                    descriptors[index].fd,
                    listeners,
                    2,
                    &broker_address,
                    broker_port
                );
            }
            if ((descriptors[index].revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
                fprintf(stderr, "pi-tcp-gateway: transparent listener failed\n");
                close(ipv4_listener);
                close(ipv6_listener);
                return EXIT_FAILURE;
            }
        }
    }

    close(ipv4_listener);
    close(ipv6_listener);
    return EXIT_FAILURE;
}
