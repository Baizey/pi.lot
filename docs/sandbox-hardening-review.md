# Sandbox hardening: engineering follow-ups

Developer reference restored from `b1a4d28` and updated for `cbe347c`, not an independent security audit. Current user-facing boundaries belong in [security](security.md) and [policy](policy.md); native architecture and regression entry points are in the [native helper reference](native-rust-migration.md), and coding conventions are in [development](development.md). See the [documentation index](README.md) and [installation guide](installation.md) for related material. Past test results do not establish the state of the current tree.

## Enforcement invariants

- **Hardlinks:** creation requires source READ+WRITE and destination WRITE. Existing or host-created aliases still share content across policy paths; authorization is not inode-wide.
- **Retained descriptors:** read/write/ftruncate compare device/inode with the exact authorized pathname and reject errors or mismatches rather than reopening by name. This catches deterministic replacement, not all concurrent host namespace races. Cached reads can bypass callbacks.
- **Devices:** workers use private Bubblewrap `--dev /dev`, with only explicit resource imports overlaid afterward. Do not restore a whole-host `/dev` bind as a compatibility shortcut.
- **Path identity:** Linux backslashes are filename characters; strip only `/` as a trailing separator. Incorrectly persisted old rules must be recreated, not guessed back into shape.
- **Open/create behavior:** preserve caller access/status flags, authorize READ before exposing read-only created handles, and require WRITE for truncation. Writable opens use direct I/O by default. Opt-in cached write-through requires READ+WRITE for `O_RDWR` open/create **before the backing open**, including destructive `O_TRUNC`. Valid xattr CREATE/REPLACE flags retain normal success/error behavior.
- **Session compatibility switches:** `/sandboxing network-inspection on|off` and `/sandboxing mmap on|off` are independent, session-only, and never saved. New sessions start inspection on/mmap off. Changes affect only new Bash calls, including subagent calls, not existing calls or mappings. Bare `/sandboxing` opens terminal TUI settings or reports values elsewhere; selections apply immediately and closing does not undo them.
- **Mmap capability boundary:** cached write-through, not `WRITEBACK_CACHE`, passthrough, or direct-I/O shared-mmap capabilities. Keep opens and backing READ/WRITE/handle-truncate checks live; do not claim that cached reads or memory stores are individually checked or revocable.
- **Mapped-write completion:** brokered and standalone mmap-enabled calls retain a frontend mount descriptor before worker startup, then frontend `syncfs` after worker-tree completion and before policy-bridge teardown. The separate 30-second approval-aware execution budget does not authorize writes or promise lossless shutdown. Propagate drain failures and aggregate them with run/cleanup failures where applicable.

Implementation owners include `native/rust/src/fuse/{callbacks,abi,broker}.rs`, `native/rust/src/fuse.rs`, `src/policy/path/validation.ts`, `src/policy/network/NetworkSandbox.ts`, and `src/policy/path/native/{native-fuse-runner,NativeFuseSessionBroker,NativeFuseMappedWriteDrain}.ts`. Callback/contract tests exercise production Rust code; launch tests do not replace mounted FUSE/Bubblewrap integration.

## Changes requiring an explicit authority model

### Writable mappings and database locks

Production supports read-only shared mappings through read-only descriptors. Writable descriptors use direct I/O and reject shared mmap **by default**. `/sandboxing mmap on` now enables cached write-through compatibility for new calls; this is an implemented route, not just the historical feasibility proposal. Cached reads broaden the default live-read boundary, and mapped stores remain unmediated per access. A store can appear successful before delayed backing writeback is denied or fails.

The normal-completion frontend drain now retains policy control until `syncfs` finishes or fails. It observes frontend writeback errors even after application descriptors close; it does not reopen backing paths or guarantee backing-storage durability. Revocation, cancellation, pathname replacement/unlink, control/daemon loss, drain timeout, and forced teardown can still lose dirty changes. Cancellation may have already aborted the policy bridge before the error-path drain runs; do not advertise lossless cancellation or shutdown.

Host/cross-call SQLite WAL remains unsupported. Independent frontend inode/page caches do not provide shared host `-shm` memory; enabling mmap or adding a periodic flush cannot repair that contract. Same-call mapping compatibility and DELETE-journal fixtures do not establish general WAL correctness.

Backing POSIX/flock locks do not coordinate with host processes or separate Bash mounts. A naive daemon-process `fcntl` callback does not preserve client lock ownership or close/dup/fork semantics. Define ownership, blocking cancellation, aliases, and final release before adding forwarding.

The [mmap reference](transparent-mmap-feasibility.md) separates current compatibility/drain behavior from historical proposals and remaining mapping authority, delayed-write, and host/cross-mount coherence questions. Enabling a capability flag is not a complete design. The intended workflow is transparent host-file access; scratch copies or writable host binds must not silently substitute for it. A writable bind is a policy bypass for its subtree.

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
| Cache/coherence | Existing handles/mappings can be stale after host changes; cached data survives revocation. Mmap opt-in broadens caching to writable descriptors without host/cross-mount coherence. Denied uncached mapping faults may produce `SIGBUS`. |
| Cancellation and drain lifetime | Normal-completion frontend draining is implemented, not an open missing feature. Error-path draining can encounter aborted policy control; forced broker/session cleanup has separate bounds. Retain those caveats and test failure propagation rather than treating the 30-second approval-aware budget as a lossless-shutdown promise. |
| Protocol channels | Recognized SSH/SMTP channels, WebSocket handshakes, and gRPC requests require distinct policy checks beyond transport admission. Outer-channel approval does not verify tunneled applications or opaque continuations. Inspection off retains opaque compatibility; namespace-local loopback has transport checks only. See [protocol admission](policy.md#application-protocol-admission). |

## Validation

Use disposable files/databases and no real credentials. Run mounted/network integration on a prepared host outside pi.lot or another restrictive sandbox; see [development](development.md). Current regression entry points include `test/native-fuse-callbacks.test.ts`, `test/native-fuse-mmap.test.ts`, `test/native-fuse-mmap-drain.test.ts`, and `test/sandboxing-command.test.ts`. They cover selected callback/open-authority, brokered/standalone mapping/drain, helper-error, and session-switch behavior; listing them is not a fresh test report.

The [mmap host matrix](transparent-mmap-feasibility.md#required-host-test-matrix) remains required evidence before claiming broader mapping, locking, shutdown, or WAL behavior. Current integration, minimum-toolchain execution, sanitizer/fuzzing work, and independent auditing are distinct evidence; none should be inferred from migration history.
