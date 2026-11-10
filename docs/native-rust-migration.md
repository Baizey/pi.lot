# Native helper architecture

Developer reference for the production helpers and their regression contracts. For setup and test commands, use [installation](installation.md); for user-visible guarantees, use [security](security.md). Migration chronology and past test results belong in Git history, not evidence for the current tree.

## Architecture

| Executable | Rust implementation | External boundary |
| --- | --- | --- |
| `pi-fuse-native` | `fuse.rs`, `fuse/{snapshot,control,path,callbacks,broker,abi,bindings}.rs` | High-level, pathname-based system libfuse. |
| `pi-network-queue-native` | `network_queue.rs`, `network_queue/queue.rs` | `libnetfilter_queue` FFI and packet/DNS/verdict parsing. |
| `pi-tcp-gateway-native` | `tcp_gateway.rs` | Linux socket, capability, signal, and fork syscalls. |
| `pi-exec-clean-native` | `exec_clean.rs` | Descriptor cleanup and byte-preserving `execvp`. |

`native/rust/src/fuse/abi.rs` owns callback translation, configuration, and file-info bitfields. `native/rust/build.rs` generates bindings from installed system headers using libclang; layouts are not copied from a particular SDK. Public libfuse capability helpers maintain negotiation bookkeeping. Policy matching, backing-file operations, and broker logic remain in the Rust modules.

Builds use the checked-in Cargo lockfile. The platform, Rust, SDK, linker, and libclang requirements are listed in [requirements](installation.md#requirements). libclang is a build-time dependency; system libfuse and libnetfilter_queue remain runtime C libraries. Test-only C fixtures independently check the ABI and callbacks. There are no production C helpers, implementation selector, or C fallback.

## Builds and artifact checks

The npm install hook builds Rust helpers into this package's `build/` directory. Successful compilation precedes staging, each executable is published by rename, and the SHA-256 receipt `build/native-rust.json` is published last. Preflight, compilation, and staging failures preserve installed artifacts. Publication is not transactional: a rename failure can leave binaries inconsistent with the old receipt until rebuilt. `npm run clean` is explicitly destructive.

`src/runtime/NativeExecutable.ts` resolves only package-local helpers and verifies their digests against the receipt. Missing/invalid receipts or missing/mismatched binaries fail with rebuild guidance. It does **not** check source freshness: an old binary with its matching receipt can pass after source changes. Rebuild and restart Pi after native changes; existing processes may retain old executable/library mappings.

The receipt is an artifact-consistency check, not a signed attestation or protection against hostile host/package modification. Validation and subsequent execution are not atomically bound to one inode.

## Regression entry points

`scripts/test-native.mjs` and `scripts/TestRunner.mjs` own suite selection. Use [development and tests](installation.md#development-and-tests) for commands and prerequisites.

| Contract | Main tests |
| --- | --- |
| Snapshot framing, authority, precedence, revisions, and path matching | `native-fuse-snapshot.test.ts`, `native-filesystem-policy-view.test.ts`, Rust units. |
| Control ordering, malformed frames, grants/denials, broker STOP and reaping | `native-fuse-protocol.test.ts`, `native-fuse-broker.test.ts`. |
| System-header ABI, INIT negotiation, real production callbacks and backing-file effects | `native-fuse-callbacks.test.ts`, `native-fuse-contract.test.ts`. |
| IPv4/IPv6/TCP/UDP/DNS bounds and exact verdict protocol | `native-network-queue.test.ts`, Rust units. |
| Relay data/backpressure, parent death, exec bytes, descriptor cleanup, signals and stdio | `native-process.test.ts`. |
| Build failures, safe staging, receipt validation, package-local selection and actual npm install hook | `native-build-flags.test.ts`, `native-executable.test.ts`, `native-rust-integration.test.ts`. |
| TypeScript broker ownership and actual native launch wiring | `native-fuse-broker-integration.test.ts`, `network-sandbox-lifecycle.test.ts`. |
| Retained frontend descriptor, idempotent mapped-write drain and helper failure | `native-fuse-mmap-drain.test.ts`. |
| Real mounted cache/mmap behavior, isolated calls, cleanup and network gate | `native-fuse-mmap.test.ts`, `native-fuse.test.ts`, `native-fuse-session-broker.test.ts`, `bash-sandbox.test.ts`, `network.test.ts`. |

Mount-free callback/INIT probes do not replace kernel-mounted tests. Optional libfuse custom-I/O support affects INIT-probe skips, not production mounts. Source-package tests build through the actual install hook with cached Cargo dependencies; they do not test offline npm dependency installation. Run host integration outside pi.lot or other restrictive sandboxes.

## Writable-mmap completion

`/sandboxing mmap on` selects cached write-through handles for new Bash calls, including subagents. Cached `O_RDWR` open/create requires READ plus WRITE before a destructive open. Existing calls retain their original mode; the default is writable mmap off.

`NativeFuseMappedWriteDrain` retains a frontend directory descriptor before worker startup. Both standalone and session-broker paths run `pi-fuse-native --syncfs 3` against it after the run settles and before normal policy-control closure/unmount. Repeated finish calls share one operation; its descriptor closes afterward. Helper failure/timeout propagates, combined with an existing run error. The 30-second budget pauses for originating policy approval; it is not an unconditional wall-clock deadline.

This is a helper-exit acknowledgement, not a new policy-control drain frame. It does not guarantee per-store authorization, revocation, rollback, stable-storage durability of every backing file, or lossless cancellation/shutdown. Backing writes use `pwrite`; frontend flush is a no-op, and explicit fsync/fdatasync callbacks remain separate. See [security](security.md) and [mmap research/status](transparent-mmap-feasibility.md).

## Security contracts worth preserving

- **Descriptor cleanup:** enumerate actual open descriptors when `close_range` needs fallback. A lowered `RLIMIT_NOFILE` does not prove higher descriptors are closed. Failure to enumerate must abort before exec.
- **Equal revisions:** retransmitted authority must match the parsed ordered contents. Different authority at the same base/ONCE revision fails closed rather than silently retaining an earlier allow.
- **Relay parent death:** capture the gateway PID before fork and compare it after registering the parent-death signal. Checking only for parent PID 1 misses adoption by a subreaper.
- **Rust startup:** preserve inherited SIGPIPE and initially closed stdio where the helper contract requires it; Rust runtime initialization can otherwise change them before `main`.
- **FFI failure:** contain callback unwinding and fail the mount closed after a panic. Generated bindings do not establish pointer, buffer, or lifetime safety.

These are independently specified expected behaviors, not merely agreement with a retired implementation. Passing tests or using Rust does not remove pathname races, cached-data revocation limits, alias problems, external C-library risks, or the [boundaries outside mediation](security.md#explicit-boundaries-outside-mediation). Writable shared mmap is available only through explicit `/sandboxing mmap on` cached write-through compatibility; FUSE writeback-cache, passthrough, direct-I/O shared mmap and backing-file lock forwarding remain disabled or unsupported. Host/cross-call SQLite WAL remains unsupported.
