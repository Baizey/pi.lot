# Private-Namespace Network Gate MVP Specification

## Status

Design draft and target contract. An initial standalone TCP vertical slice is implemented as `bash-network`, but the complete specification is not implemented yet.

The current slice demonstrates a private outer user/network namespace, a same-UID capability-free Bubblewrap worker, deny-before-host-effect IPv4 TCP interception through nftables and NFQUEUE, packet/conntrack-bound approval, descendant mediation, and userspace transport through `slirp4netns`. A pending conntrack mark suppresses retransmissions while the original SYN is held; source-port reuse creates a separate decision. The slice does not yet provide DNS, UDP, externally routed IPv6, active-flow revocation, or integration with the root-wide FUSE worker.

The completed design applies to the `bash-fuse` architecture: a root-wide FUSE filesystem inside a Bubblewrap worker.

## Transparency principle

With every policy decision set to allow, the worker should behave as though the gate were absent as closely as the mediation mechanism permits. The gate must preserve the host-user identity, filesystem visibility and permissions, environment, pathname Unix sockets, local IPC, and unrelated process behavior. Isolation exists only to route direct IP network effects through policy; it is not a general containment boundary.

## Question being tested

Can one already-running Bubblewrap worker use normal socket APIs while all direct IP network activity originating in its network namespace passes through a trusted, live-policy network broker that can deny an operation before any corresponding host connection or datagram is created?

A passing MVP establishes a network reference-monitor direction alongside the FUSE filesystem broker. It does not establish production completeness by itself.

## Required demonstration

Without restarting the worker or reconstructing its namespaces:

1. The worker starts in a private network namespace with no direct host network route.
2. An outbound TCP connection is denied and the host test server observes no connection.
3. TypeScript changes the active policy.
4. The same worker retries and the TCP connection succeeds through the broker.
5. TypeScript revokes the policy.
6. A new connection is denied, and an existing connection covered by the revoked rule is terminated before more worker payload is forwarded.
7. An approved DNS lookup and UDP flow succeed through the broker; denied ones have no corresponding host-side effect.
8. A descendant process observes the same current policy.
9. Killing or cancelling the broker leaves the worker with no fallback network path.

## Scope

The MVP covers:

- Outbound TCP connections from unmodified applications using normal sockets.
- Brokered DNS over UDP or TCP port 53.
- Outbound UDP flows with explicit flow lifetime semantics.
- IPv4 and IPv6, including canonical handling of IPv4-mapped IPv6 addresses.
- Live, versioned policy updates.
- Active-flow revocation.
- Descendants of the initial worker.
- Network namespace, broker, worker, and FUSE lifecycle as one failure domain.
- Preservation of normal host filesystem access, environment, pathname Unix sockets, and local IPC.

The MVP does not require applications to honor `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`. A proxy-only design is not sufficient for acceptance. Network effects delegated to an already-running host service through local IPC are outside the direct-IP gate.

## Security boundary

### Trusted

- The Pi process and extension.
- The TypeScript policy store, evaluator, event log, and lifecycle controller.
- The network broker control plane.
- The policy-aware userspace network data plane and any native helper required to operate it.
- Bubblewrap while constructing namespaces.
- The host kernel.
- Host resources exposed to the worker with their normal user-level permissions.

### Untrusted

- The shell command and every descendant it creates.
- Application network libraries and protocol implementations.
- Packets, DNS names, addresses, ports, and payloads supplied by the worker.
- Any broker request originating from the worker-facing side of the data plane.

The worker must not be able to configure the network namespace, alter broker routing, reach the broker control channel as a trusted peer, or acquire a host-network socket through an inherited descriptor.

## Required invariants

1. The worker has no direct IP route to the host network namespace.
2. Every direct outbound TCP connection, brokered DNS request, or UDP datagram from the worker namespace is produced by the trusted broker only after policy approval.
3. A denied direct-IP operation creates no corresponding host connection and sends no corresponding host datagram.
4. The worker and all descendants share the same mediated IP network boundary while retaining normal host filesystem and local IPC access.
5. The worker cannot add interfaces, routes, firewall rules, packet sockets, or another direct IP egress mechanism.
6. Broker startup completes before untrusted code begins executing.
7. Broker failure cannot restore direct IP connectivity.
8. No unapproved host AF_INET or AF_INET6 network descriptors are inherited by the worker.
9. Policy updates are atomic from the perspective of an individual flow decision.
10. Once a revoking policy update completes, no new worker payload is forwarded on a revoked flow.
11. Every policy decision is logged with the policy revision and normalized target identity used for that decision.
12. Cancellation terminates the worker and network helpers, closes brokered sockets, unmounts FUSE, and cleans temporary state.
13. Unsupported address families, protocols, and broker operations fail closed.
14. The design never presents hostname attribution, TLS identity, or URL visibility as stronger than it actually is.

## Architecture

```text
remote or host network service
            ^
            | host sockets created only after approval
            |
trusted network data plane <----> TypeScript PolicyStore / decision UI
            ^                              |
            | packets / virtual flows      | versioned decisions and logs
            |
private TAP or equivalent interface        |
            ^                              |
            |                              |
Bubblewrap private network namespace ------+
            |
            +-- untrusted worker and descendants
            +-- FUSE-mounted host root
```

The worker receives a normal IP network interface and uses ordinary socket APIs. The interface is connected only to the policy-aware data plane. There is no kernel route, host veth, slirp path, pasta path, proxy mapping, or inherited AF_INET/AF_INET6 socket that bypasses the broker. Filesystem access and local IPC remain host-visible and are not routed through this data plane.

An existing userspace networking implementation may provide packet transport or protocol machinery only if the integration can synchronously stop before creating each host-side connection or datagram and wait for the TypeScript decision. Unmodified `slirp4netns` or `pasta` provides connectivity but no per-flow approval hook, so either one alone is not the gate described by this specification.

## Namespace construction

The lifecycle controller must:

1. Create an outer user and network namespace that maps the host user to the same UID and GID.
2. Keep the worker blocked before its command executes.
3. Obtain stable handles for the worker user and network namespaces.
4. Install the network gate before any transport is attached.
5. Start and attach the network data plane.
6. Configure only the broker-facing interface, routes, and broker-controlled DNS endpoint.
7. Launch the worker with all capabilities dropped while preserving normal host filesystem, environment, local IPC, PID, IPC, and UTS visibility.
8. Verify broker readiness.
9. Release the worker only after the gate is complete.

There must be no startup interval in which the worker shares the host network or has unrestricted userspace networking.

The implementation should use Bubblewrap status and blocking file descriptors, namespace file descriptors, or an equivalent race-free handshake. Polling for a process and configuring it after untrusted execution begins is not acceptable.

## Filesystem and local IPC non-interference

The network gate does not mediate filesystem access or pathname Unix-domain sockets. The worker must retain the same host-user permissions and receive the original environment, writable filesystem view, `/tmp`, `/run`, device access, and pathname socket visibility.

At minimum:

- The worker UID and primary GID match the invoking host user rather than appearing as namespace root.
- Host paths are not made read-only, hidden, or replaced merely to implement the network gate.
- `SSH_AUTH_SOCK`, D-Bus addresses, display sockets, container-engine sockets, credential-agent sockets, and similar environment variables remain available.
- Existing pathname sockets in the workspace and elsewhere retain normal behavior.
- No unrelated PID, IPC, or UTS namespace is introduced.
- The worker must not receive pre-connected AF_INET or AF_INET6 descriptors that would bypass the gate.

Network effects requested indirectly from a host service through local IPC are not visible to this gate and are an explicit non-goal. Abstract Unix sockets are scoped by Linux network namespaces and may therefore differ despite the non-interference goal; this limitation must be documented rather than disguised as policy enforcement.

## Language and implementation boundary

Policy state, policy evaluation, user interaction, event logging, lifecycle, and cancellation belong in TypeScript.

A native or non-TypeScript data-plane helper is acceptable because implementing transparent TCP and UDP translation in TypeScript is not a goal. Such a helper must:

- Contain no user-configurable allow or deny policy.
- Report normalized flow requests through a versioned protocol.
- Block the relevant host-side operation until TypeScript returns `ALLOW` or `DENY`.
- Default to `DENY` on malformed input, protocol mismatch, control-channel failure, cancellation, or helper error.
- Never create a host socket before the corresponding approval.
- Expose enough lifecycle control to terminate active flows during revocation and shutdown.

A large third-party userspace network stack becomes part of the trusted computing base and must be version-pinned and covered by integration tests.

This design does not use seccomp user notification as its network data plane.

## Policy model

The network broker uses a mutable `NetworkPolicyStore` with a monotonically increasing revision.

A rule may match:

- Operation: `DNS_QUERY`, `TCP_CONNECT`, or `UDP_FLOW`.
- Direction: outbound for this MVP.
- DNS query name and type.
- Target kind: DNS-derived hostname or literal IP address.
- Canonical hostname or hostname suffix.
- Selected real IPv4 or IPv6 address or CIDR.
- Transport protocol.
- Exact port or port range.

A DNS-derived flow is evaluated against both its normalized hostname and the one real address selected for that connection. A hostname match must not silently override an address rule that denies loopback, link-local, private, metadata-service, or otherwise sensitive ranges. CNAME resolution does not weaken this requirement.

Every rule has a stable identifier and human-readable reason. Unmatched operations are denied.

Policy replacement or mutation must be atomic for each new decision. The event records the revision used. A policy update must also re-evaluate active flows before the update operation reports completion.

The initial Pi integration may resolve each event with `ctx.ui.confirm`, but the broker contract must not depend on interactive UI. Missing UI, prompt failure, cancellation, or an invalid response resolves to `DENY`.

Filesystem and network prompts must use one shared decision queue so concurrent FUSE and network requests cannot present overlapping confirmation dialogs. Non-interactive policy matches need not wait behind that UI queue.

## Event model

The control protocol is versioned. The data plane submits a request without a policy revision. After validation and normalization, the trusted TypeScript control plane assigns the sequence and current policy revision used for evaluation.

A policy event contains at least:

```ts
type NetworkTarget =
  | {
      kind: "hostname";
      hostname: string;
      address: string;
      port: number;
    }
  | {
      kind: "ip";
      address: string;
      port: number;
    };

type NetworkPolicyEvent = {
  version: 1;
  sequence: number;
  workerId: string;
  policyRevision: number;
} & (
  | {
      operation: "DNS_QUERY";
      transport: "tcp" | "udp";
      requestId: string;
      dns: {
        name: string;
        type: string;
      };
    }
  | ({
      flowId: string;
      source: {
        address: string;
        port: number;
      };
      target: NetworkTarget;
    } & (
      | {
          operation: "TCP_CONNECT";
          transport: "tcp";
        }
      | {
          operation: "UDP_FLOW";
          transport: "udp";
        }
    ))
);
```

The exact wire schema may differ, but it must preserve these semantics. Every field supplied by the worker-facing data plane is untrusted protocol input and requires bounds checking and normalization. Sequence and policy revision are trusted control-plane metadata rather than claims accepted from that input.

Events and lifecycle logs must distinguish:

- Policy decision.
- Host resolution result.
- Host connect success or failure.
- Flow closure and closure reason.
- Revocation.
- Resource-limit rejection.

Payload contents are not logged by default.

## Target normalization

Before policy evaluation:

- IP addresses are parsed as binary values and rendered canonically.
- IPv4-mapped IPv6 addresses are normalized to one policy identity.
- IPv6 scope identifiers are rejected unless explicitly supported.
- Ports must be integers from 1 through 65535.
- DNS names are converted to lower-case ASCII using IDNA, stripped of one terminal root dot, and length-checked.
- Empty labels, malformed IDNA, embedded NUL, and ambiguous numeric address forms are rejected.
- Hostname suffix rules operate on DNS label boundaries; `example.com` must not match `notexample.com`.

The textual form supplied by the worker is never used directly as a policy key.

## DNS and hostname identity

DNS is a policy-sensitive network operation and a possible data-exfiltration channel. The worker must use a broker-controlled resolver endpoint. Direct UDP or TCP DNS traffic that bypasses that endpoint is denied.

For every query:

1. Normalize the query name and type.
2. Request policy approval before sending a host DNS request.
3. Resolve through the trusted broker only after approval.
4. Record the answer and TTL used for later target attribution.
5. Return either a valid response or an explicit DNS failure without exposing an unrestricted resolver.

To make hostname policy authoritative for normal DNS-derived connections, the broker must return addresses from broker-owned synthetic IPv4 and IPv6 ranges and retain a lease mapping from each synthetic address to the normalized hostname and trusted resolution result. A connection to a leased synthetic address is evaluated as a hostname target; a connection to any literal address is evaluated as an IP target.

Synthetic leases are scoped to one worker, expire no later than the bounded DNS TTL, and cannot be used as routes to real host addresses. Lease expiry prevents new flows but does not silently reclassify an already-authorized active flow. CNAME chains and all candidate real endpoints are logged.

Before requesting flow approval, the broker selects one real endpoint from the lease and includes that canonical address in the hostname target. Approval applies only to that hostname, address, port, and transport tuple. Falling back to another resolved address requires another decision, preventing DNS rebinding or a CNAME from silently widening an approval.

If the implementation instead exposes real DNS answers, hostname information on a later flow is advisory only and hostname rules cannot be claimed as authoritative. That weaker behavior does not satisfy hostname-rule acceptance tests.

Rewriting address answers means transparent DNSSEC validation is outside the MVP. Encrypted DNS appears as ordinary TCP or UDP to its resolver; allowing such a flow intentionally gives the worker a resolution path outside broker hostname policy and must be made clear in the decision UI.

## TCP semantics

A TCP flow is identified by an opaque connection generation plus its worker, address family, source endpoint, and normalized target. The endpoint tuple alone is never an authorization key.

- Retransmitted SYN packets for one pending connection produce one policy request.
- A replacement socket reusing the same endpoint tuple is a distinct flow and requires a distinct decision.
- No host `connect` occurs before `ALLOW`.
- While a decision is pending, packets are coalesced and bounded rather than generating repeated prompts.
- On `DENY`, the broker creates no host socket and returns a deterministic guest-visible failure such as a reset or administrative rejection.
- On `ALLOW`, the broker creates the host socket and proxies the stream with bounded buffering and backpressure.
- Host connect failure is returned to the guest and logged; approval does not imply connection success.
- Listening, inbound forwarding, and unsolicited inbound connections are denied for the MVP.

Policy is checked at flow creation rather than for every TCP segment. Active-flow revocation provides the live-policy boundary after connection establishment.

## UDP semantics

UDP is connectionless, so the broker defines a flow as the tuple of worker, address family, source endpoint, normalized target, and destination port.

- The first outbound datagram creates one pending `UDP_FLOW` decision.
- A bounded number of datagrams and bytes may wait behind that decision.
- No host UDP socket or datagram is created before `ALLOW`.
- On `DENY`, queued datagrams are discarded and the broker may return an ICMP administrative rejection when valid.
- A denied UDP `send` may already have returned success inside the guest kernel; the guaranteed property is absence of host effect, not a synchronous `EPERM` from the worker syscall.
- An allowed flow uses one broker-owned host socket and accepts replies only from the approved peer unless a rule explicitly permits broader semantics.
- UDP flows expire after a bounded idle interval.
- A later datagram after expiry creates a new policy decision.

Broadcast, multicast, source routing, fragmentation patterns the broker cannot safely reassemble, and unsupported ancillary-data behavior fail closed.

## Revocation semantics

A policy update evaluates both pending and active flows.

- Pending requests denied by the new policy resolve to `DENY`.
- Active TCP flows no longer allowed are closed on both sides.
- Active UDP flows no longer allowed are closed and their queued datagrams are dropped.
- Synthetic DNS leases no longer permitted are invalidated.
- The update operation completes only after the broker has installed the new revision and stopped accepting new worker payload for revoked flows.

Bytes already forwarded to a host socket before revocation cannot be recalled. The event log records the revision boundary and byte counters so this limitation is observable.

## Resource limits and denial of service

The broker must bound at least:

- Pending policy requests per worker.
- Active TCP flows.
- Active UDP flows.
- Synthetic DNS leases.
- Buffered bytes per flow and per worker.
- DNS query size, answer size, and outstanding query count.
- Control-protocol message size.

Limit exhaustion fails closed and is logged without opening a host connection. Backpressure must propagate instead of permitting unbounded memory growth while the user considers a decision.

## Host and local-network destinations

The host loopback interface, link-local ranges, private networks, container bridges, metadata-service ranges, and the public internet all pass through the same broker policy. No host-gateway convenience mapping is implicitly allowed.

The default policy denies every destination. Prompts must identify non-public destinations clearly. Address normalization must prevent alternate IPv4, IPv6, or mapped forms from bypassing CIDR rules.

## Caching requirements

- Policy decisions are not inferred from kernel connection tracking or DNS cache state.
- Every new TCP flow and every new or expired UDP flow uses the current policy revision.
- DNS lease TTLs are bounded by both the trusted answer and a configured maximum.
- Negative DNS results have bounded caching.
- A policy update invalidates affected cached decisions and leases before it completes.

Performance is secondary to deterministic mediation for the MVP.

## Lifecycle and failure behavior

- FUSE mount and network broker startup complete before the worker starts.
- Worker exit terminates the network data plane and closes all host sockets.
- Supervisor cancellation kills the worker process tree, networking helpers, and pending decisions.
- Broker or control-channel failure removes connectivity and terminates the worker rather than falling back to direct networking.
- A failed namespace, helper, socket, or FUSE cleanup is reported clearly.
- Temporary namespace handles, sockets, mount directories, and generated resolver files are removed when possible.
- Cleanup is idempotent and covers partial startup failures.

The implementation must not impose a short default command timeout merely because a human policy decision is pending. Explicit caller timeout and cancellation still apply.

## Pi integration

`bash-fuse` remains one tool. Its execution output includes normalized network decision records alongside FUSE records.

A network prompt includes at least:

- Original shell command, truncated for display.
- Operation and transport.
- Canonical hostname or IP address.
- Port.
- DNS query type when applicable.
- Policy revision and matching rule or reason when available.
- A warning for loopback, link-local, private, or metadata destinations.

The tool must continue streaming ordinary stdout and stderr while policy events are pending. UI failure denies the event without stranding a packet, flow, worker, or FUSE request.

## Acceptance tests

### Namespace isolation

- Before the broker attaches, the blocked worker cannot execute untrusted code.
- With the broker absent or dead, the worker cannot directly reach a host test server, host loopback service, LAN address, or public address through AF_INET or AF_INET6.
- The worker cannot add a route or network interface.
- No direct `pasta`, `slirp4netns`, host veth, or inherited AF_INET/AF_INET6 socket bypass exists.

### Allowed and denied TCP

- A denied connection returns a deterministic connection failure.
- The host server observes no accepted connection for the denied attempt.
- After a live policy update, the same worker connects and exchanges data successfully.
- A descendant process receives the same behavior.
- Concurrent SYN retransmissions produce one decision event.
- Closing a pending socket and reusing its source tuple cannot transfer its decision to the replacement socket.

### Active TCP revocation

- The worker keeps an approved connection open.
- Policy is revoked without restarting the worker.
- The update closes the flow.
- Data attempted after the revision barrier is not delivered to the host peer.
- A new connection is denied.

### DNS

- An approved A or AAAA query returns a worker-scoped synthetic lease.
- A subsequent connection through that lease is identified by the normalized hostname.
- A denied query sends no upstream DNS request.
- Direct DNS to an arbitrary resolver is denied.
- Malformed names, unsupported classes, and oversized messages fail closed.
- Lease expiry and policy revocation prevent stale hostname authorization.

### UDP

- A denied first datagram produces no host datagram.
- An allowed flow exchanges datagrams only with its approved peer.
- Flow expiry causes the next datagram to be re-evaluated.
- Revocation drops queued traffic and prevents later host datagrams.
- Broadcast and multicast fail closed.

### Filesystem and local IPC compatibility

- The worker retains the invoking user's UID, primary GID, environment, writable host filesystem access, `/dev`, `/tmp`, and `/run` behavior.
- Any supplementary-group difference forced by unprivileged user-namespace mapping is documented and tested rather than presented as policy isolation.
- Host pathname Unix sockets under `/run`, `/var/run`, the host home, workspace, and inherited environment paths remain accessible.
- No pre-connected host AF_INET or AF_INET6 descriptor is inherited.
- The worker cannot use packet, raw, or unsupported IP protocols to bypass the direct-IP gate.
- The documented abstract-Unix-socket namespace difference is tested where practical.

### Policy, logging, and UI

- Every decision records revision, operation, normalized target, decision, and reason.
- Connect success/failure, revocation, and close reason are correlated by flow ID.
- Concurrent FUSE and network requests present one UI confirmation at a time.
- Missing UI, cancelled prompts, invalid decisions, malformed protocol, and control disconnect all deny.

### Lifecycle

- Normal exit, nonzero exit, timeout, cancellation, broker crash, partial startup failure, and forced worker termination leave no helper process, active host socket, namespace handle, temporary socket, resolver file, or FUSE mount behind.
- Repeated runs do not accumulate state or inherit policy from an earlier worker.

## Implementation stages

### Stage 1: transparent namespace scaffold

- Add race-free private-IP-network-namespace startup to the FUSE runner.
- Preserve host-user identity, filesystem access, environment, runtime paths, and pathname local IPC.
- Prove that the worker has no direct IP network without a broker while unrelated host access remains unchanged.
- Add lifecycle, non-interference, and cleanup tests.

### Stage 2: policy-aware TCP data path

- Select or build the userspace data plane.
- Add the versioned TypeScript control protocol and policy store.
- Support outbound IPv4 and IPv6 TCP with deny-before-host-connect behavior.
- Add shared FUSE/network decision serialization.

### Stage 3: brokered DNS identity

- Add the broker resolver and synthetic address leases.
- Add canonical hostname rules and DNS event logging.
- Bind TCP target identity to synthetic leases.

### Stage 4: UDP

- Add bounded UDP flow tracking, replies, expiry, and revocation.
- Keep unsupported datagram modes fail closed.

### Stage 5: adversarial hardening

- Exercise malformed packets, fragmentation, namespace escape attempts, alternate address encodings, helper crashes, prompt stalls, resource exhaustion, and cleanup races.
- Document the final trusted computing base and measured limitations.

## Success criteria

The network architecture is accepted when all acceptance tests pass repeatedly on the current Linux/Bazzite host and:

- The same worker demonstrates deny, allow, and revoke transitions.
- Denied operations have no corresponding host network effect.
- Ordinary unmodified TCP, DNS, and UDP clients work when approved.
- Descendants cannot bypass the direct-IP gate.
- Broker failure leaves the worker offline.
- Repeated runs leave no network helper, namespace, socket, or FUSE mount behind.

## Explicit limitations

### Pending socket lifetime

The current NFQUEUE slice holds the original immutable SYN. If its initiating guest socket closes while a decision is pending, `ALLOW` may still release that original queued packet; a replacement socket reusing the tuple receives a separate decision and cannot consume the approval. Detecting guest-socket cancellation before verdict would require an additional stable socket-liveness identity and is not claimed by the current slice.

### User-namespace identity

Unprivileged creation of the private network namespace requires a user namespace. The worker retains the host UID and primary GID, but Linux may not permit mapping all host supplementary groups. Group-only filesystem access can therefore differ unless a privileged namespace creator or a separate host-credential filesystem broker is introduced.

### Layer-7 identity

The gate authorizes network flows, not HTTP requests. It does not see HTTPS paths, methods, headers, or bodies. TLS interception is not part of the MVP. A structured web tool or explicit application proxy is required for URL-aware policy.

### Encrypted name resolution

DNS-over-HTTPS, DNS-over-TLS, and application-specific resolvers appear as ordinary allowed network flows. The gate cannot infer their queried names without protocol-specific interception. Default policy should deny unneeded resolver endpoints, but the MVP does not claim complete encrypted-DNS detection.

### Previously forwarded effects

Revocation prevents new forwarding after its revision barrier, but it cannot undo bytes or datagrams already delivered to the host kernel or remote peer.

### Delegated network effects

A worker can use an intentionally preserved pathname Unix socket or another local IPC service to ask a host process to perform network activity. That host process is outside the worker network namespace, so its traffic is not observed or controlled by this direct-IP gate.

### Protocol completeness

The MVP explicitly supports outbound TCP, brokered DNS, and bounded unicast UDP. ICMP, SCTP, QUIC-specific identity, multicast, broadcast, inbound forwarding, and unusual socket options are denied or unsupported unless later specified and tested.

### Kernel boundary

This is container-style isolation and trusts the host kernel. Workloads requiring protection from kernel exploitation belong in a microVM.

## Non-goals

- Requiring applications to opt into an HTTP or SOCKS proxy.
- Mediating network effects delegated to existing host services through local IPC.
- Inbound port publishing or service hosting.
- HTTP/TLS interception or URL-path policy.
- Packet payload inspection, malware scanning, or data-loss-prevention classification.
- Bandwidth shaping, traffic accounting for billing, or quality-of-service policy.
- Cross-platform support.
- A production security claim based solely on this MVP.
