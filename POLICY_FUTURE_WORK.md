# Policy future work

## Status

This is the single backlog for pi.lot's filesystem and network policy boundary. It replaces the former FUSE and network MVP specifications.

The old specifications were compared with the current implementation in `src/policy/`, `src/tools/builtin-bash/`, `native/`, and the integration tests. Requirements that are already implemented are summarized below; only incomplete, partial, or newly exposed work is carried forward.

pi.lot remains experimental and unaudited. This file is a roadmap, not a claim that the current worker is a hardened sandbox.

## Implemented baseline

The following architecture is established and is not future work:

- Bash commands receive a root-backed FUSE view rather than a direct bind of the host root.
- FUSE policy covers `READ`, `WRITE`, and `DELETE`, including common file, directory, metadata, link, special-node, and extended-attribute operations.
- Writes and truncation are re-evaluated after open, so the FUSE data plane can deny a later write on an existing descriptor.
- The broker mount is hidden from its own view, FUSE caching is constrained, and command exit, cancellation, and timeout drive unmount cleanup.
- Filesystem and network decisions use one policy runtime with tool-call, session, and locally persisted lifetimes and one serialized UI decision queue.
- The network worker and gateway have separate network namespaces. The capability-free worker has no direct uplink, while helper failure terminates the worker instead of restoring connectivity.
- Initial IPv4 and IPv6 TCP and UDP effects are held in NFQUEUE. Approved non-loopback TCP is always terminated at the trusted gateway and relayed through the host TypeScript broker; it is never directly forwarded by the gateway.
- Ordinary UDP DNS is gated and proxied. A/AAAA answers receive bounded synthetic leases, including answer-section CNAME attribution, and unknown or expired synthetic destinations fail closed.
- HTTP/1.0 and HTTP/1.1 requests are authorized before an upstream connection. HTTPS uses a per-run interception CA and independently validates the upstream certificate. Keep-alive requests are re-authorized individually.
- Integration coverage includes root-wide paths, descriptor write re-evaluation, descendants, denied host effects, TCP retransmission and tuple reuse, IPv4/IPv6 TCP and UDP, synthetic DNS identity, CNAMEs, HTTP/HTTPS, and Git smart HTTP.

## Boundary correctness and hardening

### Race-free filesystem operations

The FUSE broker currently authorizes and accesses host paths through Node pathname APIs. Replace this with a directory-descriptor data plane using `openat2`-style constrained resolution, or an equivalent design, so the object authorized is the object operated on even while another host process changes path components.

That work must also make operation semantics explicit:

- distinguish policy for a symlink node from policy for its resolved target according to the operation actually performed;
- authorize replacement of an existing rename destination as a deletion as well as a destination write;
- keep all source and destination checks and the mutation in one stable resolution context;
- support absolute symlink targets when they remain inside the worker's mediated root instead of rejecting them for implementation convenience; and
- add adversarial tests for symlink swaps, rename races, mount aliases, hard links, `/proc` aliases, and broker-path recursion.

### Production pseudo-filesystems and devices

The standalone FUSE runner and combined production runner create a private PID namespace with matching `/proc`. The standalone runner also creates a minimal `/dev`, while the combined network runner still overlays the host `/dev` with `--dev-bind`.

Complete the production mount contract:

- replace the broad host `/dev` bind with a minimal device view or an explicit, separately governed device policy;
- preserve required `/tmp`, `/run`, and pathname Unix-socket behavior without creating an unmediated host-root path; and
- test process tools, standard devices, pathname sockets, supplementary-group behavior, and every deliberate pseudo-filesystem exception in the combined worker.

### Network destination policy

Hostname approval currently carries the selected real address as event data, but the unified policy authorizer evaluates only the projected hostname scope. Add address policy that cannot be bypassed by a hostname or CNAME:

- canonical IP and CIDR rules;
- mandatory intersection with rules for loopback, link-local, private, container, and metadata-service ranges;
- canonical IPv4-mapped IPv6 handling and an explicit policy for IPv6 scope identifiers;
- explicit denial of broadcast, multicast, unsupported raw protocols, unsafe fragmentation, and source-routing forms; and
- decision UI warnings for non-public destinations.

The production projector is fixed to collapsed operation and address-family granularity. A DNS approval therefore reuses one hostname decision across DNS, TCP, UDP, both families, and all ports during that Bash call. Either narrow that default or make the expanded grant explicit before approval. Align projected in-memory reuse with persisted `DNS`, `TCP`, and `UDP` access types so a rule has the same meaning within a call and in a later session.

## Live, versioned policy

The runtime does not currently expose a revisioned mutable policy store. Policies are loaded when the session starts, and a running command has no production API for atomic replacement or revocation. Add:

- a monotonically increasing policy revision and immutable snapshot per decision;
- atomic add, replace, and remove operations shared by filesystem, flow, DNS, and HTTP authorization;
- policy-management UI and non-interactive APIs that can update a running command;
- persistent-store change propagation instead of session-start-only loading; and
- stable rule identifiers, normalized match identity, decision reason, resolution source, and revision on every decision record.

FUSE already checks content operations per callback; connect it to the live store and add production tests that revoke writes on an open descriptor. Network policy needs an active-flow registry and a revision barrier that:

- resolves or rejects pending decisions under the new revision;
- closes revoked TCP flows on both sides;
- expires revoked UDP flow state and drops queued datagrams;
- invalidates affected synthetic DNS leases; and
- returns from the update only after no new worker payload can cross a revoked flow.

Bytes and datagrams forwarded before the revision barrier cannot be recalled and must be reported as such.

## Audit events and decision UX

Current events are sufficient for enforcement correlation but not for a complete audit trail. Denials and errors are printed, while successful decisions and most lifecycle outcomes are not recorded structurally.

Add a bounded structured event sink containing:

- worker, tool-call, request, and flow identifiers;
- trusted sequence and policy revision;
- raw operation plus normalized path, hostname, selected address, port, transport, and HTTP method/URL identity;
- matching rule, lifetime, decision, and reason;
- host DNS, connect, forward, close, revocation, cleanup, and resource-limit outcomes; and
- byte/datagram counters at close and revocation without payload logging by default.

Prompts should include the Bash command and purpose, the actual FUSE or network operation, the precise reusable scope, and any scope widening. Missing UI, prompt failure, cancellation, malformed responses, and audit-sink failure must have an explicit fail-closed policy that cannot strand a kernel request.

## Policy model and persistence

- Implement a policy listing, editing, deletion, import, and export surface. Database deletion support exists but is not exposed as a complete runtime workflow.
- Define precedence across path, hostname suffix, exact host, URL path, exact address, CIDR, sensitive-range, operation, family, and port rules. Deny precedence for sensitive addresses must not depend only on pattern-string length.
- Decide whether HTTP and HTTPS, query strings, and fragments are policy identities. The HTTP broker emits a canonical URL including the query, but `ParsedUri` currently removes scheme, query, and fragment before matching.
- Define explicit policy for opaque TCP, SSH, WebSocket, gRPC, and encrypted DNS rather than relying only on request-aware HTTP parser failure.
- `GLOBAL` is currently offered for network decisions but is stored in the same local SQLite database as `LOCAL`; no synchronization exists. Implement a real synchronized backend and conflict model, or stop offering and persisting `GLOBAL` as though it were distinct.
- `ask_llm` is declared but unsupported. Either specify and implement a safe contract or remove it from accepted configuration.

## Network transport and protocol completeness

### TCP and UDP lifecycle

- Give every TCP connection a stable generation/flow ID across NFQUEUE, transparent ingress, TypeScript approval, upstream connection, and closure.
- Add explicit bounded UDP idle expiry instead of relying on implicit conntrack lifetime, with re-authorization after expiry and strict reply-peer validation.
- Bound pending decisions, active TCP and UDP flows, per-flow and per-worker buffering, helper children, and aggregate host sockets. Propagate backpressure while a decision is pending.
- Verify that a worker socket closed while its SYN is pending cannot cause a later unnecessary upstream connection, including all tuple-reuse races.

### DNS

- Add TCP DNS fallback without permitting direct resolver access.
- Broaden validated DNS behavior beyond the current single-question class-IN UDP path where compatibility requires it, while retaining strict bounds and synthetic identity.
- Add explicit limits for concurrent upstream queries, negative caching, response size, and lease churn.
- Remove expired per-lease DNAT rules, reclaim lease capacity correctly, and prevent nftables rule accumulation during long commands.
- Define behavior for DNSSEC, SVCB/HTTPS records, multiple aliases, multiple candidate addresses, and resolver failover. Synthetic answer rewriting cannot transparently preserve end-to-end DNSSEC.

### HTTP and TLS

- Add explicit policy and fail-closed behavior for HTTP/2, HTTP/3/QUIC, WebSocket upgrades, `CONNECT`, non-HTTP TLS, mutual TLS, certificate pinning, and clients with private trust stores.
- Bound request headers, bodies, response buffering, request counts, and authorization latency as aggregate worker resources.
- Expand trust-store integration only where it does not create a bypass; unsupported clients should fail clearly.

### IPv6 and packet parsing

IPv6 extension headers currently fail closed. Support only a deliberately parsed, bounded subset if compatibility requires it. Add tests for mapped addresses, extension chains, fragments, malformed lengths, alternate textual forms, and nftables/TypeScript normalization agreement.

## Filesystem compatibility

- Replace or patch the `fuse-native@2.2.6` `utimens` binding so distinct atime and mtime values are preserved.
- Support atomic xattr create/replace flags and platform position semantics where they can be represented safely.
- Add required POSIX operations such as locking, allocation, and ioctl behavior only with explicit policy mapping; unsupported mutations must continue to fail closed.
- Improve pathname Unix-socket and pseudo-filesystem compatibility under the final production mount contract.
- Measure and tune cache behavior only after descriptor revocation and mutation ordering remain provably correct.

## Lifecycle, testing, and assurance

Network cleanup currently favors best-effort `Promise.allSettled`; make failed helper, socket, namespace, nftables, temporary-file, and FUSE cleanup visible without masking the original worker error. Cleanup must remain idempotent across partial startup.

Add repeated and adversarial production-path tests for:

- policy replacement and filesystem/network revocation in one already-running worker;
- combined-worker descendants, `/proc`, `/dev`, pathname sockets, and supplementary groups;
- active TCP and UDP revocation with a measured revision barrier;
- malformed packets and protocols, queue saturation, prompt stalls, memory limits, and helper crashes;
- normal exit, nonzero exit, timeout, cancellation, partial startup, forced termination, and failed cleanup; and
- absence of leftover mounts, processes, namespaces, nftables state, sockets, and temporary files after repeated runs.

Before describing pi.lot as a hardened sandbox, publish a threat model, document the trusted computing base, fuzz the native and TypeScript protocol parsers, and obtain an independent security review.

## Deliberate boundaries

Unless the architecture is intentionally expanded, the following remain boundaries rather than backlog promises:

- The host kernel and the trusted Pi process are trusted.
- An allowed operation retains the invoking user's ordinary host permissions.
- A worker can delegate effects to a preserved host service over pathname IPC; those effects originate outside the worker's direct filesystem/network reference monitor.
- MCP transports and exposed MCP tools are explicit host capabilities outside the filesystem and network policy boundary.
- Subagents currently run as independent in-memory Pi sessions inside the root process; their always-available Bash, Read, Edit, Write, and web-search tools use the root session's shared policy runtime with principal-specific policy state.
- Revocation cannot undo effects already delivered before its revision barrier.
- Inbound service publishing, cross-platform support, and protection from host-kernel exploitation are not current policy goals.
