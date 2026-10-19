# Transparent host-backed mmap: design investigation

Developer design reference, **not an approved feature or installation guide**. Production writable shared mmap remains disabled. The goal is transparent host-file access, not scratch copies, automatic copy-out, or an unmediated writable bind.

**Writable-mmap compatibility is conditionally feasible; transparent concurrent host-shared mappings are not established.** FUSE cannot authorize each mapping or memory store. A design would need potential mapping authority at open, object-bound lifetime rules, and explicit limits on revocation and delayed writeback.

## Current implementation

- `native/rust/src/fuse/callbacks.rs`: read-only handles use cached I/O; writable handles use direct I/O. READ/WRITE and handle truncate consult live policy and retained-object checks. Flush is a no-op.
- `native/rust/src/fuse/abi.rs`: INIT disables direct-I/O shared mmap, writeback cache, and passthrough. The operation table has no backing `lock`/`flock` callbacks.
- `src/policy/path/native/NativeFuseSessionBroker.ts` and `native-fuse-runner.ts`: teardown ends policy control before unmounting, without a mapped-write drain/error acknowledgement.

Current system libfuse support and Rust bindings do not establish writable-mmap routing, draining, locking, or WAL coherence. See [security](security.md#known-limitations) for the supported boundary.

## Pinned-source findings

These findings come from Linux **v6.13**, commit `ffd294d346d185b70e28b1a28abe367bbfe53c04`, and libfuse **3.18.2**, commit `033844748010a3b8265bf1c90b9ae8ffe4cd9ca7`. They are research baselines, not guarantees about a user's running kernel or proof of a working prototype.

- The direct-I/O mmap capability appeared in Linux 6.6 and was renamed in 6.7. The inspected 6.6–6.8 paths differ materially from 6.9/v6.13 writable-mapping machinery; capability presence alone is not a sufficient baseline.
- In v6.13, ordinary direct READ/WRITE iterators still issue requests. A syscall may first flush previously dirtied mapped pages: denying that syscall does not prove earlier mapped changes were not forwarded.
- Mapping faults use cached filemap/FUSE reads; present pages need no callback. `fuse_page_mkwrite()` is not a userspace mapping/store authorization hook.
- Mapped writeback sets `FUSE_WRITE_CACHE`, exposed as `fi.writepage`, even without writeback-cache. The selected writable handle and request credentials do not reliably identify the mapper that dirtied a page.
- `fuse_splice_read()` uses cached `filemap_splice_read()` even for direct handles. Splice/sendfile-style reads therefore block a universal live-READ claim. Libfuse transport splice switches do not disable this application-facing path.
- In libfuse 3.18.2, `fuse_get_feature_flag()` reports capable flags, not requested flags; inspect `want_ext` when verifying intent. Public set/unset helpers also update private session state, so fabricated standalone connection structs are not valid helper fixtures. Mocked callback intent does not prove wire negotiation.

## Candidate routes

| Route | Benefit | Constraint |
| --- | --- | --- |
| Direct I/O plus shared mmap capability | Candidate for ordinary live syscall checks while permitting shared mappings. | Needs mapping authority, alternate-read analysis, host routing, and drain/error tests. Currently disabled. |
| Cached write-through without writeback-cache | Supports shared mmap and forwards ordinary writes. | Cached reads bypass live READ callbacks; writable-descriptor caching broadens the current contract. Does not provide host-shared pages. |
| Writeback-cache | Deferred writes may improve compatibility/performance. | Does not preserve the desired separation of live-checked ordinary writes and lifetime-authorized mapped writes. |
| FUSE passthrough or writable host bind | Avoids portions of the FUSE path. | Ordinary host I/O may bypass the gate; not a silent compatibility fix. |

Disabling `direct_io` does not necessarily bypass ordinary writes: cached write-through forwards them. It does permit cached reads. Neither route provides per-memory-store authorization.

## Authority and lifecycle decisions

FUSE's ordinary file API has no userspace MMAP/mprotect callback carrying a mapping's protections and lifetime. The defensible candidate is **opened-object authority within one Bash call**, not precise, revocable per-VMA authority:

- Mapping-capable `O_RDWR` opens need READ and WRITE authorization before use, including when a mapping starts read-only and later gains write access through `mprotect`.
- Closing a descriptor does not end a surviving mapping; fork and descriptor transfer complicate ownership. A prior fd approval must not become a blanket bypass for ordinary writes.
- Shared cached bytes can become visible before writeback. Denial cannot retroactively turn a memory store into synchronous `EACCES`, erase observed bytes, or revoke already-faulted pages. Faults and delayed I/O errors are possible instead.
- Rename/unlink semantics must choose whether authority follows the opened object or its authorized name. Following an inode can affect denied aliases; rejecting later writeback can lose accepted mapped changes. Never reopen by name to flush.

Before accepting dirty mappings, define completion of the worker tree, surviving references, retained descriptors/authority during draining, visible writeback errors, and resource release before daemon/control teardown. Release errors alone are not a usable completion acknowledgement. Forced fsync also changes durability and latency; visibility is not stable-storage durability.

Cancellation/control loss needs an explicit cutoff: bounded draining of previously authorized writes versus denial with possible lost updates. Already-admitted writes can still complete and cannot be rolled back.

## SQLite WAL and locking

Independent Bash mounts have independent frontend inode/page caches, distinct from the host inode's mapped pages. Eventual WRITE callbacks, polling, inotify, or cache invalidation do not provide SQLite WAL's communicating `-shm` memory. Enabling mmap or forwarding locks does not establish that contract.

Same-call clients sharing one FUSE inode are a test candidate, not a proven guarantee. Host clients and separate Bash mounts remain an architectural blocker until genuinely common mapped pages or an equivalent mechanism are demonstrated.

Backing locks are independently useful but need a separate design. Linux OFD locks are a candidate for preserving distinct client owners, with differences in GETLK PID reporting, deadlock detection, access modes, and fork/close semantics. `flock` also needs explicit description ownership, dup/fork lifetime, blocking cancellation, and final release. A naive daemon-process `F_SETLK` callback or periodic flush is insufficient.

## Required host test matrix

Keep experiments test-only, on disposable real host files, outside pi.lot or another restrictive sandbox. Pin the actual host kernel/libfuse pair and verify the source findings before changing production behavior.

- Direct syscall READ/WRITE with shared mappings active; cached/uncached faults and alternate splice/sendfile reads.
- Shared/private mappings, initial protections, `mprotect`, close-with-mapping, dup, fork/exec, and descriptor transfer.
- Multiple handles/names/hardlinks to one inode; writeback-handle selection and mapper attribution.
- READ/WRITE denial and revocation, control loss, rename/unlink/replacement, and delayed errors.
- Mixed syscall/mapped I/O; worker-to-host, host-to-worker, and cross-call visibility.
- `msync`/fsync, ENOSPC/EIO, descendants, cancellation, daemon death, draining, and repeated cleanup.
- Backing POSIX/flock conflicts, owner lifetime, and same-call versus host/cross-call WAL with integrity checks.

Do not advertise host-shared WAL or enable a production flag based only on capability negotiation, callback mocks, or read-only mmap smoke tests.

## References

- [Linux FUSE I/O modes](https://www.kernel.org/doc/html/next/filesystems/fuse/fuse-io.html).
- [Kernel v6.13 FUSE implementation](https://github.com/torvalds/linux/blob/v6.13/fs/fuse/file.c) and [UAPI](https://github.com/torvalds/linux/blob/v6.13/include/uapi/linux/fuse.h).
- [Cached filemap splice reads](https://github.com/torvalds/linux/blob/v6.13/mm/filemap.c#L2882).
- [libfuse 3.18.2 operations](https://github.com/libfuse/libfuse/blob/fuse-3.18.2/include/fuse.h), [file-info contract](https://github.com/libfuse/libfuse/blob/fuse-3.18.2/include/fuse_common.h), and [capability helpers](https://github.com/libfuse/libfuse/blob/fuse-3.18.2/lib/fuse_lowlevel.c).
- [SQLite WAL format](https://sqlite.org/walformat.html).
- [Linux POSIX/OFD locks](https://man7.org/linux/man-pages/man2/fcntl_locking.2.html).
- [Kernel FUSE passthrough](https://docs.kernel.org/next/filesystems/fuse-passthrough.html).
