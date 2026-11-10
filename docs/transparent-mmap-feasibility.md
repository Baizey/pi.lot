# Transparent host-backed mmap: compatibility and design investigation

Developer reference restored from the `b1a4d28` investigation and updated for implementation `cbe347c`. **Opt-in writable shared mmap compatibility and a frontend completion drain are now implemented. Transparent concurrent host-shared mappings are not established.** The historical research and alternative proposals below are not the current runtime contract or claims that every proposed test has passed.

The goal remains transparent host-file access, not scratch copies, automatic copy-out, or an unmediated writable bind. FUSE cannot authorize each mapping or memory store. See [policy](policy.md#filesystem-mediation) and [security](security.md#known-limitations) for supported behavior, [installation](installation.md) for prerequisites, and the [documentation index](README.md) for related guides.

## Current implementation

### Session switch and I/O route

- Each session starts with writable mmap **off** and network inspection **on**. Bare `/sandboxing` opens terminal TUI settings; other modes report values. `/sandboxing mmap on|off` changes mmap compatibility and `/sandboxing network-inspection on|off` independently changes inspection. Selections apply immediately to **new Bash calls**, including subagent calls, never to existing calls/mappings. Closing settings does not roll them back. Both switches are session-only and never saved.
- `native/rust/src/fuse/callbacks.rs`: read-only handles use cached I/O. Writable handles use direct I/O by default; mmap-enabled calls instead use **cached write-through**. Mapping-capable `O_RDWR` open/create requires READ+WRITE authorization **before the backing open**, including destructive `O_TRUNC` opens. This also covers initially read-only mappings later made writable with `mprotect` without pretending to authorize that transition individually.
- Backing READ/WRITE and handle-truncate callbacks still consult live policy and verify the retained descriptor against the authorized pathname/device/inode. Cached reads and memory stores bypass per-access callbacks: mapped stores are not individually checked or revocable. Denied writeback can lose previously dirtied changes and errors may be delayed. Flush remains a no-op; application fsync/fdatasync callbacks operate on retained backing handles.
- `native/rust/src/fuse/abi.rs`: INIT still disables `FUSE_CAP_DIRECT_IO_ALLOW_MMAP`, `FUSE_CAP_WRITEBACK_CACHE`, and `FUSE_CAP_PASSTHROUGH`. Writable mmap uses the cached route, not those capabilities. The operation table still has no backing `lock`/`flock` callbacks.

### Implemented normal-completion drain

Both `src/policy/path/native/NativeFuseSessionBroker.ts` and `native-fuse-runner.ts` use `NativeFuseMappedWriteDrain.ts` for mmap-enabled calls. They retain a **frontend mount descriptor before worker startup**, then run `pi-fuse-native --syncfs` with that descriptor after the worker tree stops and **before policy-bridge teardown**. Retention lets frontend `syncfs` observe this mount's writeback errors even after application descriptors close; it does not reopen backing files by pathname. The Rust helper is in `native/rust/src/fuse/broker.rs`.

The drain has its own **30-second approval-aware execution budget**, separate from the command timeout. Policy approval waits pause that budget; arbitrary I/O waits do not. Normal completion retains policy control during the drain. Drain failures/timeouts propagate, and run/drain/cleanup errors are aggregated where applicable rather than silently returning success. A drain is also attempted on the run-error path, but already-cancelled policy control or concurrent shutdown can prevent it from preserving changes.

This is a **frontend writeback drain/error acknowledgement**, not a guarantee of backing-storage durability, common host-mapped pages, or lossless shutdown. Revocation, cancellation, retained-path replacement/unlink, daemon/control failure, drain timeout, and forced cleanup can still reject writes or lose dirty data. Already-admitted effects cannot be rolled back. Host/cross-call SQLite WAL and host backing-lock coordination remain unsupported.

### Regression entry points (not a fresh test report)

- `test/native-fuse-callbacks.test.ts`: cached write-through flags, READ authorization for `O_RDWR` before destructive opens/creates, and callback failure after controller EOF.
- `test/native-fuse-mmap.test.ts`: per-call on/off behavior, unflushed closed-fd/forked mappings reaching the host on completion, and Go linker output, for brokered and standalone routes.
- `test/native-fuse-mmap-drain.test.ts`: retained frontend descriptor/helper invocation, descriptor closure, repeated finish, and helper failure propagation.
- `test/fixtures/native-fuse-init-probe.c`: capability intent/wire checks against system headers.

See [development and validation](development.md). These entry points do not prove crash durability, all cancellation/revocation cases, or WAL/locking coherence.

## Historical pinned-source findings

The original investigation predates the implemented cached compatibility route and completion drain above. These findings come from Linux **v6.13**, commit `ffd294d346d185b70e28b1a28abe367bbfe53c04`, and libfuse **3.18.2**, commit `033844748010a3b8265bf1c90b9ae8ffe4cd9ca7`. They are research baselines, not guarantees about a user's running kernel or proof of a working prototype.

- The direct-I/O mmap capability appeared in Linux 6.6 and was renamed in 6.7. The inspected 6.6–6.8 paths differ materially from 6.9/v6.13 writable-mapping machinery; capability presence alone is not a sufficient baseline.
- In v6.13, ordinary direct READ/WRITE iterators still issue requests. A syscall may first flush previously dirtied mapped pages: denying that syscall does not prove earlier mapped changes were not forwarded.
- Mapping faults use cached filemap/FUSE reads; present pages need no callback. `fuse_page_mkwrite()` is not a userspace mapping/store authorization hook.
- Mapped writeback sets `FUSE_WRITE_CACHE`, exposed as `fi.writepage`, even without writeback-cache. The selected writable handle and request credentials do not reliably identify the mapper that dirtied a page.
- `fuse_splice_read()` uses cached `filemap_splice_read()` even for direct handles. Splice/sendfile-style reads therefore block a universal live-READ claim. Libfuse transport splice switches do not disable this application-facing path.
- In libfuse 3.18.2, `fuse_get_feature_flag()` reports capable flags, not requested flags; inspect `want_ext` when verifying intent. Public set/unset helpers also update private session state, so fabricated standalone connection structs are not valid helper fixtures. Mocked callback intent does not prove wire negotiation.

## Historical candidate routes

This comparison records the alternatives considered. Only cached write-through is implemented for opt-in writable mmap; the direct-I/O mmap, writeback-cache, passthrough, and writable-bind alternatives are not enabled.

| Route | Benefit | Constraint |
| --- | --- | --- |
| Direct I/O plus shared mmap capability | Candidate for ordinary live syscall checks while permitting shared mappings. | Needs mapping authority, alternate-read analysis, host routing, and drain/error tests. Currently disabled. |
| Cached write-through without writeback-cache | Now implemented for opt-in shared mmap; forwards ordinary writes through callbacks. | Cached reads bypass live READ callbacks; writable-descriptor caching broadens the default direct-I/O contract. Does not provide host-shared pages. |
| Writeback-cache | Deferred writes may improve compatibility/performance. | Does not preserve the desired separation of live-checked ordinary writes and lifetime-authorized mapped writes. |
| FUSE passthrough or writable host bind | Avoids portions of the FUSE path. | Ordinary host I/O may bypass the gate; not a silent compatibility fix. |

Disabling `direct_io` does not necessarily bypass ordinary writes: cached write-through forwards them. It does permit cached reads. Neither route provides per-memory-store authorization.

## Authority and lifecycle: implemented choices and remaining limits

FUSE's ordinary file API has no userspace MMAP/mprotect callback carrying a mapping's protections and lifetime. The historical proposal considered opened-object authority within one Bash call. The implementation does **not** provide precise, revocable per-VMA authority or a persistent object-lifetime write grant: it authorizes mapping-capable opens and still checks live policy and retained pathname identity on backing callbacks.

- Mapping-capable `O_RDWR` opens/creates require READ and WRITE authorization before backing open, including `O_TRUNC`; the requirement applies even when a mapping starts read-only and later gains write access through `mprotect`.
- Closing a descriptor does not end a surviving mapping; fork and descriptor transfer complicate ownership. A prior fd approval must not become a blanket bypass for ordinary writes.
- Shared cached bytes can become visible before writeback. Denial cannot retroactively turn a memory store into synchronous `EACCES`, erase observed bytes, or revoke already-faulted pages. Faults and delayed I/O errors are possible instead.
- Rename/unlink/replacement can cause retained-path checks to fail closed rather than follow the opened object through normal POSIX lifetime semantics. Following an inode could affect denied aliases; rejecting later writeback can lose accepted mapped changes. Never reopen by name to flush.

The implemented frontend drain now provides a bounded normal-completion writeback/error acknowledgement while policy control remains live. It is not a blanket authorization for previously dirtied bytes, a replacement for live callback checks, or a backing-storage durability guarantee. Flush/release errors alone are still not a usable completion acknowledgement.

Cancellation/control loss is explicitly lossy: the error path attempts the same drain, but control may already be aborted, and forced broker/session teardown has independent cleanup bounds. The 30-second approval-aware drain budget is not a promise that all shutdown paths will retain the mount for that long. Already-admitted writes can still complete and cannot be rolled back.

## SQLite WAL and locking

Independent Bash mounts have independent frontend inode/page caches, distinct from the host inode's mapped pages. Eventual WRITE callbacks, polling, inotify, or cache invalidation do not provide SQLite WAL's communicating `-shm` memory. Enabling mmap or forwarding locks does not establish that contract.

Same-call clients sharing one FUSE inode are a test candidate, not a proven guarantee. Host clients and separate Bash mounts remain an architectural blocker until genuinely common mapped pages or an equivalent mechanism are demonstrated.

Backing locks are independently useful but need a separate design. Linux OFD locks are a candidate for preserving distinct client owners, with differences in GETLK PID reporting, deadlock detection, access modes, and fork/close semantics. `flock` also needs explicit description ownership, dup/fork lifetime, blocking cancellation, and final release. A naive daemon-process `F_SETLK` callback or periodic flush is insufficient.

## Required host test matrix

The original research matrix remains a validation checklist for broader claims and future changes, not a claim that current compatibility covers every case. Keep experiments test-only, on disposable real host files, outside pi.lot or another restrictive sandbox. Pin the actual host kernel/libfuse pair and verify the source findings before changing production behavior.

- Direct syscall READ/WRITE with shared mappings active; cached/uncached faults and alternate splice/sendfile reads.
- Shared/private mappings, initial protections, `mprotect`, close-with-mapping, dup, fork/exec, and descriptor transfer.
- Multiple handles/names/hardlinks to one inode; writeback-handle selection and mapper attribution.
- READ/WRITE denial and revocation, control loss, rename/unlink/replacement, and delayed errors.
- Mixed syscall/mapped I/O; worker-to-host, host-to-worker, and cross-call visibility.
- `msync`/fsync, ENOSPC/EIO, descendants, cancellation, daemon death, draining, and repeated cleanup.
- Backing POSIX/flock conflicts, owner lifetime, and same-call versus host/cross-call WAL with integrity checks.

Do not advertise host-shared WAL, backing-lock coordination, lossless shutdown, or broader mmap guarantees based only on capability negotiation, callback mocks, or read-only mmap smoke tests. The implemented opt-in compatibility route and drain do not establish those properties.

## References

- [Linux FUSE I/O modes](https://www.kernel.org/doc/html/next/filesystems/fuse/fuse-io.html).
- [Kernel v6.13 FUSE implementation](https://github.com/torvalds/linux/blob/v6.13/fs/fuse/file.c) and [UAPI](https://github.com/torvalds/linux/blob/v6.13/include/uapi/linux/fuse.h).
- [Cached filemap splice reads](https://github.com/torvalds/linux/blob/v6.13/mm/filemap.c#L2882).
- [libfuse 3.18.2 operations](https://github.com/libfuse/libfuse/blob/fuse-3.18.2/include/fuse.h), [file-info contract](https://github.com/libfuse/libfuse/blob/fuse-3.18.2/include/fuse_common.h), and [capability helpers](https://github.com/libfuse/libfuse/blob/fuse-3.18.2/lib/fuse_lowlevel.c).
- [SQLite WAL format](https://sqlite.org/walformat.html).
- [Linux POSIX/OFD locks](https://man7.org/linux/man-pages/man2/fcntl_locking.2.html).
- [Kernel FUSE passthrough](https://docs.kernel.org/next/filesystems/fuse-passthrough.html).
