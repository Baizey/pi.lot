# Transparent host-backed mmap: feasibility investigation

## Scope and verdict

The user wants a quiet gate over normal host-file access, not scratch copies, staging, automatic copy-out, or an unmediated writable bind. This round is **investigation only**: three specialist agents reviewed kernel/API feasibility, mapping authority, and locking/coherence/lifecycle; a fourth independently challenged the conclusions. No production enforcement changes or mmap-enabling patches were made.

**Conditionally feasible for writable-mmap compatibility; not established as a fully transparent solution for concurrent host-shared mappings.** Ordinary FUSE interfaces cannot authorize each actual mapping or memory store. Mapping permission would need to be acquired as potential authority at open, with explicit limits on revocation, object lifetime, and delayed writeback.

The most important distinction is between:

1. making a program's shared writable mmap work through a host-backed FUSE mount; and
2. providing the same shared memory to that program, a host process, and another independent FUSE mount.

The first has documented FUSE mechanisms. The second is not supplied merely by enabling mmap, forwarding locks, or flushing dirty pages.

## Evidence and execution limits

Locally inspected:

- `native/pi-fuse.c`: open/create cache choices, live read/write/ftruncate authorization, raw backing descriptors, missing locking callbacks, no-op flush, and capability negotiation.
- `src/policy/path/native/NativeFuseSessionBroker.ts`: cleanup closes policy control before unmounting; no mapped-write drain acknowledgement.
- `src/policy/path/native/native-fuse-runner.ts`: analogous policy-close-before-unmount ordering.
- Bundled `fuse_common.h`: FUSE 2.9 API, `writepage`, handle and lock-owner fields.
- Bundled `fuse_kernel.h`: protocol 7.19 and its version negotiation contract.
- Installed `/usr/include/linux/fuse.h`: protocol history places `FUSE_DIRECT_IO_ALLOW_MMAP` at 7.39; it is bit 36, transported through extended INIT `flags2`. The header explicitly describes `FUSE_WRITE_CACHE` as delayed page-cache writeback whose **file handle is guessed**.
- Bundled `fuse.h`: repeated/non-final flush, final release after descriptors and mappings disappear, ignored release errors, and local-only locking without callbacks.

Kernel documentation states that direct I/O bypasses ordinary read/write page-cache handling; modern `FUSE_DIRECT_IO_ALLOW_MMAP` permits shared mmap despite direct I/O; cached write-through sends each ordinary write as a WRITE request; writeback-cache changes that behavior.

**Do not overstate verification:** upstream source retrieval/search was intermittently unavailable, and browser source extraction timed out. Detailed kernel request routing, the selection algorithm for the documented guessed writeback handle, exact minimum kernel/libfuse releases, and behavior on the installed kernel still need pinned-source confirmation and prepared-host tests. Protocol 7.39 and the lack of precise writeback-handle attribution are established by the installed UAPI header. No mmap, compilation, database, or mount tests ran in this round.

The Bash tool currently cannot start a worker:

```text
enable worker loopback failed: exit code 2: RTNETLINK answers: Operation not permitted
```

`/proc/version` reports `7.2.7-ogc1.1.fc44.x86_64`; that is version information, not proof of enabled/negotiated capabilities. The failed worker command was a repository-status/kernel-version check, so current Git status was not obtained. Existing source changes were not touched.

## Candidate routes

| Route | What it offers | Cost / limitation |
| --- | --- | --- |
| Modern direct I/O plus shared mmap capability | Documented candidate for retaining ordinary syscall READ/WRITE requests while allowing shared mappings; no copied workspace. | Current bundled FUSE 2.9/protocol 7.19 cannot straightforwardly negotiate it. Needs a supported newer dependency/API and fail-closed negotiation. Ordinary-I/O versus mapped-writeback routing must be verified. |
| Cached write-through, without writeback-cache | Shared mmap and ordinary syscall-write callbacks are documented; a plausible route without the modern capability. | Ordinary reads can become cache hits and stop consulting live READ policy. This extends the existing read-only cache contract to writable descriptors and needs explicit acceptance. No automatic backing-page coherence. |
| Writeback-cache | Compatibility/performance through deferred writes. | Does not preserve the desired distinction between live-checked ordinary writes and lifetime-authorized mapped writes. Not recommended for that contract. |
| Standard FUSE passthrough or writable host bind | Can avoid portions of the FUSE I/O path. | Ordinary host I/O may bypass the gate. Not a substitute that can be silently enabled. Mmap-only backing-page relay requires a separately established API/design. |

Simply disabling `direct_io` does not necessarily bypass ordinary **writes**: cached **write-through** forwards them. It does allow cached **reads** to bypass callbacks. Neither route provides per-memory-store authorization.

## What authority FUSE can actually observe

The inspected ordinary file API has OPEN, READ, WRITE, FLUSH, RELEASE, locking, and related operations, but no userspace MMAP/mprotect callback carrying a VMA's protections and lifetime. Modern DAX mapping/window requests are not such a general ordinary-file mapping authorization hook.

Therefore:

- An approved `O_RDWR` handle must be treated as capable of future shared writable mappings, including initially read-only mappings later upgraded with `mprotect`.
- The current writable-open WRITE check alone is insufficient for cached mapped reads. Mapping-capable `O_RDWR` opens need READ and WRITE authorization before the handle becomes usable.
- Closing the descriptor does not end a surviving mapping. Fork can inherit mappings; retained descriptors can create new mappings. Authority belongs to the call/principal and opened object, not one PID.
- Cache writeback is exposed as `fi->writepage` in the bundled interface. It identifies writepage activity, not a particular memory store, original policy revision, or reliable originating process.
- The installed UAPI explicitly labels `FUSE_WRITE_CACHE` as delayed page-cache writing with a guessed file handle, and makes lock-owner validity conditional on `FUSE_WRITE_LOCKOWNER`. Pinned-source review must confirm the selection algorithm and request-routing details. Do not assume the callback's `fh` identifies the handle/VMA that dirtied the page.

The defensible design candidate is consequently **inode/object-bound mapping authority within a Bash call**, not a precise, revocable per-VMA grant.

A potential request split would be:

```text
ordinary WRITE/TRUNCATE → current live policy checks
ordinary READ           → live checks on the modern direct-I/O candidate;
                          cache hits bypass them on the cached fallback
mapped cache writeback  → separately approved retained mapping authority
```

This is only a design candidate. It requires reliable request classification, disabled writeback-cache, retained backing-object bookkeeping, inode/alias accounting, and error/lifecycle semantics. A generic “this fd was once allowed” branch would also authorize ordinary writes and is not acceptable.

## Non-negotiable semantic tradeoffs

### Revocation and cached visibility

A memory store may already have changed a shared cached page before any WRITE callback occurs. Denying its eventual writeback cannot turn that store into a synchronous `EACCES` or erase bytes other processes in the mount have already observed. Rejecting page faults/writeback can instead produce faults or delayed I/O errors.

New opens can remain live-denied while old mapping-capable handles retain authority. Existing mapped/cached data is not isolated per descriptor. Direct-I/O syscall reads are a distinct question from reads performed through mapping faults and already-present mapped pages.

### Rename and unlink

Normal POSIX mappings retain the opened object after rename/unlink. Current native pathname/device-inode checkpoints deliberately reject deterministic replacement. A retained mapping lease must explicitly choose whether it follows the pinned object or fails when its authorized name changes. Object-following authority can continue affecting an inode reachable through a subsequently denied alias; name-conditioned writeback can lose accepted mapped changes. Never reopen by name to flush a mapping.

### Completion, cancellation, and control loss

Current cleanup closes/aborts policy control before unmount, and broker STOP terminates the mount worker without a mapped-write drain/error acknowledgement. That ordering is not a verified safe completion protocol for dirty mappings.

Before enabling them, define and test:

1. completion of the entire worker process tree and accounting for surviving references;
2. retained policy/mapping authority and backing descriptors while queued mapped writes drain;
3. in-flight/writeback completion and a visible error acknowledgement;
4. release of locks/resources, unmount, and only then daemon/control teardown.

A drain should not silently promise stable-storage durability: forcing fsync on every Bash completion changes normal behavior and latency. Visibility and durability are separate contracts. Release errors are ignored by libfuse, so release cannot be the sole error-reporting path.

On cancellation/controller loss, the user must choose between bounded admission/draining of previously authorized mapped writes and denial of newly admitted backing writes after a defined cutoff, with possible lost mapped updates. Already-admitted/in-flight writes may still complete, and previously forwarded writes cannot be rolled back.

## SQLite WAL and genuinely shared memory

The existing per-call FUSE-page-cache contract means independent calls do not share one frontend inode/cache; those frontend pages are also not the backing host inode's mapped pages. The precise kernel path still needs pinned-source review, but there is no established mechanism here providing common mapped memory across these boundaries.

SQLite WAL clients use mapped `-shm` as communicating memory. Memory barriers do not flush dirty pages from one FUSE mount into another. Eventual WRITE callbacks, attribute TTLs, polling, inotify, and cache invalidation are not equivalent to that shared-memory contract.

Consequences:

- Same-call clients using the same FUSE inode may be a viable test target, not a proven guarantee.
- Host clients and clients in separate Bash-call mounts remain a separate architectural blocker.
- Lock forwarding alone is not sufficient for shared-host WAL.
- General host-shared WAL should not be advertised until genuinely common mapped pages or an equivalent proven mechanism are established.

## Lock forwarding feasibility

Correct backing locks are independently useful, even before mmap changes.

A Linux OFD-lock adapter for POSIX locks is plausible: independent backing open-file descriptions keyed by mount, lock-owner token, and backing inode; conflict with real host POSIX/OFD locks; close-any-descriptor/flush owner semantics; explicit cancellation and unlock after denial. It is not a naive daemon-process `F_SETLK` callback.

Material differences remain: OFD GETLK PID reporting, deadlock detection, inherited descriptions versus POSIX fork semantics, access-mode requirements, aliases, and cancellation races. A distinct description per FUSE open for `flock` is narrower, but dup/fork/mapping lifetime and blocking acquisition still require tests. Do not treat periodic flush as final release.

## Recommended next step: test-only prototype, not production enablement

Subject to approval and a working prepared-host test environment:

1. Pin a modern libfuse/kernel source pair and establish capability/version requirements and actual ordinary/mapped request routing.
2. Prototype direct-I/O-plus-mmap with callback tracing on disposable real host files, outside the production default.
3. Prove ordinary syscall writes still consult live policy while previously approved mapped writeback uses only its scoped authority. Test READ denial before `O_RDWR` open, not merely on cache misses.
4. Add handle/inode lifecycle and drain/error tests before enabling the feature in production.
5. Investigate backing locks independently; keep host/cross-call WAL unsupported until common-memory coherence is proven.

No scratch, copying, staging, implicit binder bypass, or kernel-level access changes are approved by this investigation.

## Required host test matrix

- Direct syscall READ/WRITE callbacks with shared mappings active; cached and uncached mapped faults.
- `MAP_SHARED`/`MAP_PRIVATE`, initial protections, `mprotect` upgrades, close-with-VMA, dup, fork/exec, and allowed descriptor transfer boundaries.
- Multiple writable handles to one inode; different names/hardlinks; selected writeback handle and process/context fields.
- READ/WRITE denial and revocation; control disconnect; rename/unlink/path replacement.
- Mixed mmap/syscall I/O, host-to-worker and worker-to-host mapped visibility, and two-call visibility.
- `msync`/fsync, delayed writeback, ENOSPC/EIO, descendants, timeouts/cancel, daemon death, and repeated cleanup.
- Backing POSIX/flock conflicts and owner lifetimes; same-call versus host/cross-call WAL with disposable DBs and integrity checks.

## References

- [Linux FUSE I/O modes](https://www.kernel.org/doc/html/next/filesystems/fuse/fuse-io.html), including [6.7 documentation](https://docs.kernel.org/6.7/filesystems/fuse/fuse-io.html).
- [Versioned libfuse 2.9 operations](https://github.com/libfuse/libfuse/blob/fuse-2.9.9/include/fuse.h) and [file-info contract](https://github.com/libfuse/libfuse/blob/fuse-2.9.9/include/fuse_common.h); corresponding bundled files were read locally.
- [Kernel FUSE file implementation](https://github.com/torvalds/linux/blob/v6.13/fs/fuse/file.c) and [UAPI](https://github.com/torvalds/linux/blob/v6.13/include/uapi/linux/fuse.h): pinned-source verification targets, not bodies retrieved in this round.
- [SQLite WAL format](https://sqlite.org/walformat.html).
- [Linux POSIX/OFD locks](https://man7.org/linux/man-pages/man2/fcntl_locking.2.html).
- [Kernel FUSE passthrough](https://docs.kernel.org/next/filesystems/fuse-passthrough.html).
