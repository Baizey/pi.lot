# Security model and limitations

> [!WARNING]
> pi.lot is experimental, has not been independently audited, and is not a hardened sandbox for hostile code.

## Intended model

pi.lot is designed to make selected agent effects visible and controllable while preserving a normal cross-repository Linux workflow. It mediates supported filesystem and network effects produced through Pilot's built-in tools.

It is **mediation, not complete isolation**:

- the host kernel and trusted Pi process are inside the trusted computing base;
- an allowed operation keeps the invoking user's normal host authority; and
- the agent can see broad host resources, subject to policy when supported operations are attempted.

## Mediated boundaries

- Direct `read`, `edit`, and `write` tool calls use the policy runtime.
- Bash filesystem effects pass through a FUSE broker.
- Bash DNS, TCP, UDP, and supported HTTP/HTTPS effects pass through the network gate.
- `web_search` uses policy-checked extension-side HTTP.
- Subagents have principal-specific policy state.

See [Policy system](policy.md) for exact semantics.

## Explicit boundaries outside mediation

### MCP

MCP stdio servers run as host processes and MCP HTTP transports use the host network. MCP tool effects are opaque and not inspected by filesystem or network policy; tool annotations are hints, not enforcement. Trust the servers and expose only the tools you need. Child access requires the hard `mcp` grant, independent of policy-area grants; see [subagent capabilities](subagents.md#hard-mechanism-capabilities).

### Codemode model calls

Root codemode exposes `models.classify()` and `models.generateImages()`. These are host-side calls using the session's authenticated provider credentials, can transmit supplied data, and may incur charges. They are outside pi.lot's filesystem and network mediation; policy-area approvals do not gate them. Child codemode is created with `models: false` and exposes no model globals.

### Host credential IPC

Imported SSH-agent, Secret Service, and other configured IPC protocols can ask an existing host service to act with its normal authority. Effects performed by that service are outside the worker's direct filesystem/network gate. Read-only socket mounts do not restrict protocol operations.

Enable additional sockets only for workflows that require them. A rootful Docker socket normally grants root-equivalent host authority; rootless Docker or Podman sockets still delegate the owning user's authority. A raw system-bus socket is not covered by the session-bus `talk` filter, although host D-Bus/service authorization still applies. See [common IPC integrations and configuration](policy.md#common-integrations--enable-only-when-required).

### Subagents

Subagents have separate model sessions and policy principals but share the trusted root Pi process. They are not operating-system isolation boundaries. See [Subagents](subagents.md#current-boundary).

## Known limitations

- Linux x86-64 only.
- Host-side FUSE path resolution has pathname time-of-check/time-of-use race windows. Read, write, and descriptor-truncate callbacks compare the retained descriptor's device/inode with the authorized path, rejecting deterministic path replacement; this does not eliminate concurrent namespace races.
- Filesystem metadata is not comprehensively mediated: attributes, access probes, and symlink text can be exposed without filesystem-read approval. Content-read policy should not be treated as metadata confidentiality.
- Hardlink creation requires source read/write and destination write approval. Pre-existing or host-created aliases still share inode contents across different policy paths; policy is not inode-wide.
- The high-level FUSE frontend assigns its own inode numbers: hardlink names can report different inode identities despite sharing backing contents. Frontend metadata and alias caches are not equivalent to the backing host inode or a common mapped-page cache.
- Backing-file POSIX and `flock` locks are not forwarded. Locks do not coordinate with host processes or separate Bash-call mounts. Do not concurrently access shared host databases through these mounts; rollback journaling alone does not make this safe.
- The native helper uses system libfuse 3.17.3 or newer. Shared mmap through direct-I/O handles, writeback cache, and passthrough remain disabled; modernization does not widen mapping authority.
- Filesystem opens and native I/O callbacks check versioned live policy checkpoints. Authorized read-only opens use the per-Bash-call FUSE page cache and support read-only shared `mmap`; cached reads and already-faulted mappings can remain readable after policy revocation or control-channel failure. Cache misses still check policy. Writable opens retain `direct_io` and per-write checks; shared mappings through writable descriptors remain unsupported. Private mappings do not provide per-memory-access policy checks either. Kernel splice/sendfile-style reads may use cached pages even on direct-I/O descriptors; `direct_io` is not a universal live-READ boundary. Active network-flow revocation is not implemented.
- Cached file data can become stale when the backing file changes outside the mount. Read-only opens request cache invalidation, but existing handles and mappings are not continuously refreshed.
- Workers use a private `/dev`, including private shared-memory paths, rather than exposing all host devices. Explicitly configured socket imports remain available; implicit GPU, serial, host-PTY, and host-shared-memory access does not. Pseudo-filesystem, pathname-socket, and supplementary-group compatibility is incomplete.
- System V IPC is not placed in a private IPC namespace. Same-user host IPC objects may remain accessible outside pathname policy. Workers also inherit Pi's environment; filesystem denials do not protect secrets already supplied in environment variables.
- Some DNS, UDP lifecycle, IPv6, HTTP/2, HTTP/3/QUIC, WebSocket, `CONNECT`, private-trust-store, and certificate-pinning behaviour is unsupported or fails closed.
- Request policy cannot currently distinguish HTTP from HTTPS, query strings, or fragments.
- A hostname approval is reused across DNS, TCP, UDP, address families, and ports for the remainder of one Bash call.
- `GLOBAL` network-policy lifetime is not synchronised and currently persists in the same local database as `LOCAL`.
- The keyless DuckDuckGo backend depends on a public HTML format that may change.
- Live jobs and child policy state are not persisted across root-session shutdown. Subagent conversation histories are saved as ordinary Pi sessions when the root is persistent; ephemeral roots keep them in memory. Session files can contain sensitive prompts, reasoning, tool arguments, output, and file contents.

The [sandbox hardening review](sandbox-hardening-review.md) records the first committee pass, scoped fixes, subsequent local Linux integration results, and design decisions awaiting approval. It is not an independent security audit. The [native Rust migration](native-rust-migration.md) retains the high-level libfuse frontend and existing enforcement contract, records proven legacy fixes and corrected pre-retirement C/Rust comparison, and documents completed removal of the four old C implementations.

Independent expected-behavior Rust regressions and test-only C ABI/syscall probes remain. The production libfuse C shim has been replaced by `native/rust/src/fuse/abi.rs`, with installed-header bindings generated by `native/rust/build.rs` and included through `native/rust/src/fuse/bindings.rs`. This avoids handwritten header layouts, not unsafe pointer/buffer/lifetime contracts; fewer handwritten unsafe operations are not a security proof. System libfuse and libnetfilter_queue remain external C libraries.

The earlier user-reported real FUSE/network integration preceded the ABI replacement. After the replacement, the user separately reported that the requested local `npm run test:native:host` run passed, closing the new adapter’s mounted-contract validation gap. No numerical summary or platform versions were supplied; the agent did not independently rerun mounted verification without `/dev/fuse`. Passing integration establishes only its covered contracts, not universal security, writable shared mmap, host/cross-mount coherence, or live Pi session reload. Rust-owned logic reduces memory-management risk; FFI boundaries and the security limitations above remain.

Runtime validates package-local Rust helpers against a builder-generated SHA-256 receipt to detect stale or mismatched local artifacts. That receipt is not a signed security attestation, a source-freshness guarantee, or protection against hostile host/package modification. Minimum Rust-toolchain validation, sanitizer validation, sustained fuzzing, and independent auditing remain unverified; they are separate from the completed local extension integration.

Unsupported, malformed, cancelled, or incomplete mediated operations are intended to fail closed. That intent is not a substitute for a published threat model, parser fuzzing, independent review, or a security audit.

## Operational guidance

- Keep important work under version control or another rollback mechanism.
- Prefer narrow path/host scopes and short lifetimes.
- Do not persist broad root or home-directory write policies casually.
- Expose only the MCP tools needed for the current workflow.
- Treat credential IPC as delegated host authority.
- Use disposable fixtures for demonstrations and testing.
- Run integration tests directly in a terminal on your normal Linux machine with the listed prerequisites, outside pi.lot's Bash sandbox or another restrictive sandbox. This local Pi extension needs no separate server or deployment rollout.
