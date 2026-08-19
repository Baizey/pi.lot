# pi.lot

Linux Pi extension providing kernel-mediated policy for shell-command I/O.

[`POLICY_FUTURE_WORK.md`](./POLICY_FUTURE_WORK.md) records the remaining filesystem and network correctness, compatibility, and hardening work.

## Transparency principle

The sandbox should behave as though it is absent except when an operation reaches the approval policy. With every operation allowed, commands should retain normal visibility, filesystem access, environment, local IPC, and process behavior as closely as the mediation mechanism permits. Isolation exists to route effects through policy—not to hide unrelated host resources.

## Bash filesystem policy

pi.lot overrides Pi's built-in `bash` tool while retaining Pi's streaming, truncation, timeout, and cancellation behavior. Each call requires a `purpose`: a non-empty, one-line explanation of at most 160 characters describing what the command will achieve. Each worker receives a FUSE view backed by the host filesystem root at `/`; Pi's working directory is only the worker's starting directory. Every policy-sensitive `READ`, `WRITE`, or `DELETE` request is resolved against path policy before the trusted broker accesses the host path. Structural `access`, `statfs`, `getattr`, `fgetattr`, `opendir`, and `readlink` lookups remain transparent: they neither prompt nor create a READ rule that could pre-authorize a later content read or directory listing. Operations against the resolved symlink target remain mediated.

Unmatched requests run through the shared decision-flow manager for scope, allow or deny status, lifetime, and an optional denial reason. The Bash purpose is displayed with the tool call but is not yet included in each policy prompt. `ONCE` decisions last for one Bash tool call, `SESSION` decisions last for the current Pi session, and `LOCAL` decisions persist on this computer in `~/.pilot/pilot.sqlite`. `GLOBAL` is not offered by the filesystem prompt. It is offered by network prompts but currently uses the same local database as `LOCAL`; synchronized policy is not implemented.

One `PilotSessionRuntime` is created when Pi starts a session and closed on session shutdown. It owns validated runtime configuration, the policy database, session policy state, shared UI decision-flow manager, and tool-display state; the FUSE Bash adapter only consumes those services. The Bash override is installed before runtime startup and fails closed if the session runtime is unavailable.

The built-in `bash`, `read`, `edit`, and `write` tools share the session display modes. `Ctrl+O` toggles truncated and full arguments/output, while `Alt+O` toggles a minimal view that shows only each tool's primary and secondary title arguments and hides output, including error text. Read and Write retain Pi's native text and syntax highlighting, Read retains native image behavior, and Edit retains Pi's native diff preview in full mode and uses a compact replacement summary when truncated. Minimal mode retains Pi's success or error background color and restores the previously selected truncated or full view when toggled off. Pi's `multi_tool_use.parallel` orchestration tool is not overridden.

The worker has no direct bind of the host root. Bubblewrap installs the FUSE mount as `/`, drops capabilities, and starts the command in its original working directory. The temporary broker mount lies under `/var/tmp` in the trusted host namespace and is hidden from its own FUSE view to prevent self-reference. The standalone FUSE runner overlays a private minimal `/dev` and a private PID namespace with matching `/proc`.

The combined production runner also creates a private PID namespace with matching `/proc`, so process and namespace APIs do not pass through FUSE or expose unrelated host processes. It still overlays the host `/dev`; the remaining minimal-device work is tracked in [`POLICY_FUTURE_WORK.md`](./POLICY_FUTURE_WORK.md). Root-wide mediation covers ordinary host files, mount aliases, hard-link names, and symlink targets regardless of whether they are inside Pi's working directory, but pseudo-filesystem and pathname Unix-socket exceptions must not be mistaken for policy denials.

## Bash execution path

The production extension registers one built-in `bash` override. Every command receives both the root-wide FUSE view and the private network gate.

### Filesystem mediation

Each command receives the complete host filesystem through a TypeScript FUSE passthrough broker mounted as the Bubblewrap worker's `/`. The command still starts in Pi's working directory, but paths elsewhere on the host pass through the same broker.

The broker asks before policy-sensitive `READ`, `WRITE`, or `DELETE` operations. Policy is checked for every write callback—not merely when a descriptor is opened—so the data plane can deny a later write on an already-open descriptor. The production policy runtime does not yet expose live policy revocation. Multi-path mutations such as rename require approval for both paths. Timestamp, mode, and ownership updates are mediated as `WRITE`, allowing ordinary `touch`, `chmod`, and `chown` usage. Hard-link creation atomically requires `READ` on its source and `WRITE` on its destination. Extended-attribute values and names require `READ`; setting or removing an attribute requires `WRITE`. Special-node creation is mediated as `WRITE`; ordinary users can create FIFOs, while device nodes retain the host's privilege requirements. Unsupported mutation operations fail closed.

`fuse-native@2.2.6` currently forwards the requested access time in both timestamp callback slots. pi.lot therefore supports ordinary `touch`, where both times are updated together, but cannot preserve distinct requested atime and mtime values until the dependency fixes that binding defect. The `fs-xattr` bridge supports whole-value xattr writes; nonzero macOS positions and atomic `XATTR_CREATE`/`XATTR_REPLACE` flags fail explicitly rather than being ignored.

Attribute and entry caches are constrained and writeback caching is not enabled. Correct mediation currently takes priority over performance.

### Network mediation

Each command runs with normal host-user identity, writable mediated host filesystem access, and its environment in a capability-free Bubblewrap workload network namespace. The standalone network runner preserves pathname Unix-socket access; the combined FUSE worker still has pathname-socket compatibility gaps. A separate trusted gateway namespace owns the only `slirp4netns` uplink; the workload has only a veth route to that gateway. Both namespaces and all helpers are configured while Bubblewrap holds the worker on a blocking descriptor.

The workload nftables gate sends the first outbound IPv4 or IPv6 TCP SYN and the first datagram of each ordinary UDP flow to a small `libnetfilter_queue` helper. The helper holds that exact packet while TypeScript requests a decision. UDP approved by the worker gate may be forwarded through the gateway. TCP is never forwarded: gateway TPROXY terminates every approved non-loopback TCP flow at a native ingress, which sends validated original-flow metadata and bytes to a trusted host TypeScript broker. Only that broker creates the separate upstream socket. The ingress drops all capabilities and disables ptrace access after binding its transparent listeners. `DENY`, malformed metadata, helper failure, or broker failure creates no target-side connection and cannot fall back to direct TCP.

Worker-only resolver and NSS files force ordinary hostname clients away from host systemd-resolved IPC and onto a gated DNS proxy. Every outbound UDP DNS query is held and validated before the trusted proxy sends it to the host resolver. The proxy validates the response, follows answer-section CNAME attribution, and replaces approved A and AAAA answers with worker-scoped synthetic addresses. TCP retains that synthetic destination through TPROXY, while the broker separately receives the lease-selected real upstream address; shared real endpoints therefore cannot collapse distinct hostname identities. UDP leases use namespace DNAT because UDP still follows the forwarding path. Unknown or expired synthetic destinations fail closed instead of becoming literal-IP targets. If the host broker has no global IPv6 address and default route, global AAAA-only responses become DNS NODATA before lease allocation so dual-stack clients use IPv4 instead of committing to an unusable transparently accepted IPv6 flow; local and ULA IPv6 answers are preserved. Direct DNS to other resolvers and TCP DNS fallback currently fail closed.

With full network inspection enabled, the TCP broker recognizes plaintext HTTP/1.0 and HTTP/1.1 independently of the originating command. Its request authorizer receives the actual scheme, method, canonical URL and path, hostname, source, synthetic destination, and selected upstream address before the upstream connection is created. The production Bash worker evaluates the method and normalized host, port, and path through the shared policy runtime; current policy normalization removes the URL scheme, query, and fragment even though the request event retains the canonical query. HTTPS is terminated with an in-memory per-run CA exposed through read-only PEM and Java PKCS12 artifacts, declarative client adapters, and recognized Linux system-bundle overlays; the broker independently verifies the real upstream certificate. Keep-alive requests are evaluated separately. Tests exercise curl, canonical paths, denied methods, CNAMEs, and the smart-HTTP GET emitted by a real `git fetch`. Direct runner users that omit the optional authorizer, and sessions switched with `/network-inspection off`, retain end-to-end TLS under coarse DNS/TCP policy and relay HTTP/TLS bytes without request reconstruction.

The enforcement core emits a verdict event for every DNS query and TCP or UDP flow, including flows on the worker network namespace's loopback interface. A per-command policy projector independently controls approval granularity. Operation and address-family distinctions are fixed off: approving a hostname DNS request authorizes that exact hostname across DNS, TCP, UDP, IPv4, IPv6, and destination ports for the remainder of that invocation. The generic policy prompt does not yet explain that expansion. Literal-IP flows begin at an exact address and port; literal 127/8 and `::1` flows normalize to the `localhost` policy identity. There is no runtime configuration surface for changing this granularity. Resolver transport family is diagnostic only. `localhost` still names the private worker namespace, not the host namespace, so this does not restore transparent access to host-loopback-only services.

Versioned live policy replacement, IPv4-mapped IPv6 policy normalization, active-flow revocation, explicit UDP idle expiry, TCP DNS proxying, HTTP/2, HTTP/3/QUIC, and WebSocket/CONNECT handling remain unimplemented. Request-aware mode fails closed on an unrecognized cleartext TCP preface. Certificate-pinned clients and private trust implementations may fail under HTTPS interception rather than bypassing the gateway. Pathname local IPC remains outside network mediation. Because unprivileged network namespaces require a user namespace, the worker retains the host UID and primary GID but cannot necessarily retain every supplementary group; abstract Unix sockets are also network-namespace scoped.

## Requirements

- Linux x86-64
- Node.js and npm
- A C compiler
- `pkg-config` and `libnetfilter_queue` development files (`libnetfilter_queue-devel` on Fedora/Bazzite; `libnetfilter-queue-dev` on Debian/Ubuntu)
- Bubblewrap (`bwrap`)
- FUSE (`/dev/fuse` and `fusermount`) for pi.lot's Bash override and `bash-fuse`
- User namespaces, nftables (`nft`), iproute2 (`ip`), `unshare`, `nsenter`, and `slirp4netns`

## Install

```bash
npm install
pi install /absolute/path/to/pilot
```

To try it without installing:

```bash
pi -e /absolute/path/to/pilot
```

This repository also contains `.pi/settings.json`, which auto-loads the package while working in the repository.

## Test

```bash
npm test
```

For focused network development:

```bash
npm run test:network
```

The tests verify production session-runtime ownership and decision-flow cancellation, and cover the combined FUSE/network sandbox, protocol validation, root-wide FUSE mediation inside and outside the command cwd, hidden broker paths, hard-link and symlink aliases, IPv4/IPv6 TCP and UDP deny/allow transitions, gated DNS, synthetic IPv4/IPv6 hostname leases, CNAME attribution and forwarding, loopback mediation, the policy-granularity matrix, unknown synthetic-address denial, denied host effects, delayed decisions, TCP retransmissions, source-port reuse, descendant mediation, and FUSE policy revocation on an open descriptor.

## Project layout

- `src/pilot-extension.ts` — pi.lot's production Pi extension entry point and session lifecycle composition.
- `src/runtime/PilotSessionRuntime.ts` — session-owned policy database, policy runtimes, and decision-flow manager.
- `src/tools/` — one folder per Pi tool, including the Bash/Read/Edit/Write overrides and each subagent tool.
- `src/mcp/` — MCP configuration, stdio/HTTP clients, dynamic tools, commands, and session lifecycle.
- `src/subagents/` — in-process child sessions, bounded orchestration, and toolkit ceilings; no Pi tool definitions.
- `src/tools/builtin-bash/BashTool.ts` — built-in Bash override and combined FUSE/network lifecycle adapter.
- `src/policy/path/fuse/FusePathPolicyAuthorizer.ts` — FUSE event-to-path-policy mapping and user decisions.
- `src/policy/PolicyRuntime.ts` — tool-call, session, and persisted path-policy ownership.
- `src/tui/UiDecisionFlowManager.ts` — reusable multi-step policy decision UI and TUI shortcuts.
- `src/tui/tool/` — declarative tool presentation, bounded head/tail rendering, and session display controls.
- `src/policy/network/NetworkPolicyAuthorizer.ts` — network event and HTTP request mapping into the unified policy runtime.
- `src/policy/path/fuse/fuse-runner.ts` — FUSE mount and Bubblewrap worker lifecycle.
- `src/policy/path/fuse/FuseFilesystem.ts` — policy-mediating passthrough filesystem.
- `src/policy/network/NetworkSandbox.ts` — split workload/gateway namespaces, nftables/TPROXY setup, and helper lifecycle.
- `src/policy/network/TcpGatewayBroker.ts` — approved-flow correlation, protocol classification, transparent relay, and TLS termination.
- `src/policy/network/HttpRequestBroker.ts` — canonical HTTP/1 request events, request authorization, and verified upstream HTTP(S).
- `src/policy/network/TlsCertificateAuthority.ts` — in-memory per-run interception CA and leaf issuance.
- `src/policy/network/trust/ClientTrust.ts` — per-run trust artifact lifecycle and Linux system-bundle overlays.
- `src/policy/network/trust/ClientTrustAdapters.ts` — machine-readable supported client environments and trust injection.
- `src/policy/network/trust/JavaTrustStore.ts` — Java-compatible PKCS12 trusted-certificate encoding.
- `src/policy/network/SyntheticDnsProxy.ts` — trusted DNS forwarding, response validation, synthetic lease allocation, and answer rewriting.
- `src/policy/network/NetworkPolicy.ts` — attributed target types, configurable policy projection, and per-command decision reuse.
- `src/policy/network/network-queue-protocol.ts` — validated TypeScript side of the NFQUEUE helper protocol.
- `src/policy/network/tcp-gateway-protocol.ts` — validated native-ingress flow metadata protocol.
- `native/pi-network-queue.c` — thin `libnetfilter_queue` packet hold/verdict adapter.
- `native/pi-tcp-gateway.c` — capability-dropped transparent TCP ingress and bounded relay.
- `scripts/build-native.mjs` — native adapter build.
- `test/` — focused unit and real-system integration tests.

## Important warning

This is an experimental, unaudited implementation, not a hardened production sandbox.

The FUSE broker performs host-side path resolution through Node APIs; a malicious host process racing those paths may exploit pathname time-of-check/time-of-use windows. The complete host root is governed, so filesystem aliases remain inside the mediated tree, but the broker's own temporary mount must remain hidden to avoid recursive access. Filesystem effects delegated to an existing host service are outside the direct worker reference-monitor boundary. Production should use stable directory descriptors with constrained `openat2`-style resolution or an equivalent native data plane.

The network path holds the original TCP SYN or initial UDP datagram in NFQUEUE and binds approval to that packet's conntrack generation rather than a timed tuple. If an initiating TCP socket closes while approval is pending, approving still releases the original queued SYN; a replacement socket reusing the tuple receives a separate decision. IPv6 packets with extension headers currently fail closed. Active revocation, complete resource controls, revisioned audit events, and a hardened durable policy model remain in [`POLICY_FUTURE_WORK.md`](./POLICY_FUTURE_WORK.md). Network effects delegated to an existing host service through local IPC are intentionally outside this tool's policy boundary.
