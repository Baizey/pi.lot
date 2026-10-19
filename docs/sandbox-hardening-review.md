# Sandbox hardening: engineering follow-ups

Developer reference for enforcement invariants and unresolved design issues, not an independent security audit. Current user-facing boundaries belong in [security](security.md); native architecture and regression entry points are in the [native helper reference](native-rust-migration.md). Past test results do not establish the state of the current tree.

## Enforcement invariants

- **Hardlinks:** creation requires source READ+WRITE and destination WRITE. Existing or host-created aliases still share content across policy paths; authorization is not inode-wide.
- **Retained descriptors:** read/write/ftruncate compare device/inode with the exact authorized pathname and reject errors or mismatches rather than reopening by name. This catches deterministic replacement, not all concurrent host namespace races. Cached reads can bypass callbacks.
- **Devices:** workers use private Bubblewrap `--dev /dev`, with only explicit resource imports overlaid afterward. Do not restore a whole-host `/dev` bind as a compatibility shortcut.
- **Path identity:** Linux backslashes are filename characters; strip only `/` as a trailing separator. Incorrectly persisted old rules must be recreated, not guessed back into shape.
- **Open/create behavior:** preserve caller access/status flags, authorize READ before exposing read-only created handles, and require WRITE for truncation. Writable opens remain direct-I/O. Valid xattr CREATE/REPLACE flags retain normal success/error behavior.

Implementation owners are `native/rust/src/fuse/{callbacks,abi}.rs`, `native/rust/src/fuse.rs`, `src/policy/path/validation.ts`, `src/policy/network/NetworkSandbox.ts`, and `src/policy/path/native/native-fuse-runner.ts`. Callback/contract tests exercise the production Rust static library; launch tests do not replace mounted FUSE/Bubblewrap integration.

## Changes requiring an explicit authority model

### Writable mappings and database locks

Production supports read-only shared mappings through read-only descriptors. Writable descriptors use direct I/O and reject shared mmap, including SQLite WAL shared memory. DELETE-journal fixtures do not establish WAL compatibility.

Backing POSIX/flock locks do not coordinate with host processes or separate Bash mounts. A naive daemon-process `fcntl` callback does not preserve client lock ownership or close/dup/fork semantics. Define ownership, blocking cancellation, aliases, and final release before adding forwarding.

The [mmap investigation](transparent-mmap-feasibility.md) covers mapping authority, delayed writes, draining, and host/cross-mount coherence. Enabling a capability flag is not a complete design. The intended workflow is transparent host-file access; scratch copies or writable host binds must not silently substitute for it. A writable bind is a policy bypass for its subtree.

### Namespace and device authority

System V shared memory, queues, and semaphores remain host-visible where normal permissions allow. Adding `--unshare-ipc` changes compatibility and needs an explicit decision. GPU, hardware-token, serial, host-PTY, and shared-memory exceptions should be narrow resource grants. Imported credential sockets delegate host-service authority even when mounted read-only.

### Race-resistant filesystem authority

Descriptor-anchored operations and a model for inode aliases are needed beyond current replacement checks. Decide whether authority follows names, opened objects, or both, including rename, unlink, revocation, and host-created hardlinks. Do not present the current device/inode check as full TOCTOU protection.

## Open operational issues

| Issue | Current behavior and constraint |
| --- | --- |
| Startup cancellation | `NetworkSandbox.run()` installs cancellation/timeouts after `prepareRuntimeFiles()`. The credential D-Bus proxy readiness wait has no startup abort/deadline. Make preparation abortable at its owner and drain late resource creation before cleanup; merely racing the whole promise creates cleanup races. |
| Broker backpressure | `NativeFuseSessionBroker` awaits START/STOP writes before timeout-protected response waits. Blocked writes need their own bounds and broker failure must reach all active calls. |
| Metadata visibility | Readlink text, getattr and access probes are not comprehensively read-policy gated. Define metadata/traversal authority before changing symlink behavior. |
| Cache/coherence | Existing handles/mappings can be stale after host changes; cached data survives revocation. Denied uncached mapping faults may produce `SIGBUS`. |
| Opaque TCP | Full inspection rejects SSH/SMTP-style opaque traffic even with TCP approval. Inspection-off is the current compatibility mode; selective opaque forwarding needs an agreed enforcement contract. |

## Validation

Use disposable files/databases and no real credentials. Run mounted/network integration on a prepared host outside pi.lot or another restrictive sandbox. The [mmap host matrix](transparent-mmap-feasibility.md#required-host-test-matrix) is required before claiming new mapping, locking, or WAL behavior. Current integration, minimum-toolchain execution, sanitizer/fuzzing work, and independent auditing are distinct evidence; none should be inferred from migration history.
