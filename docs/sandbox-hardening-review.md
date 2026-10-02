# Sandbox hardening: first committee pass

This is an internal review-confirm-research-improve pass, **not an independent audit or a claim of complete isolation**. Separate agents reviewed native callbacks, Bubblewrap boundaries, checkpoint/control protocols, and mmap compatibility. A separate confirmer reviewed the native findings and patches; implementation ownership was kept separate from review.

## Scoped changes applied

| Finding | Change | Evidence and remaining limits |
| --- | --- | --- |
| Hardlink creation could turn readable, write-denied contents into a writable alias. | `benchmark_link` requires source WRITE as well as its existing source READ and destination WRITE checks. | Mount-free callbacks test denied creation and allowed inode-preserving links. Existing/host-created aliases still require an inode-aware authority design. Read-only hardlink backup workflows now require source-write approval. |
| Read/write/ftruncate could authorize a replacement pathname while using the retained old inode. | Check retained descriptor device/inode against the exact authorized resolved path inside the policy mutex. Reject errors/mismatches; never reopen or substitute the handle. | Tests cover external rename/replacement, missing/invalid/closed handles, and ordinary same-inode content changes. The mutex does not serialize host namespace changes, and cached reads bypass callbacks. |
| Combined workers bind-mounted all host `/dev`, bypassing FUSE for shared memory, devices, PTYs, and sockets. | Use private Bubblewrap `--dev /dev`; overlay only deliberately configured resource imports afterward. | Mocked launch tests verify flags/order. The prepared-host regression checks an invisible host `/dev/shm` sentinel, private writes leaving it unchanged, basic devices, and an explicitly imported socket in the same host directory. That integration test has not been run from this sandboxed session. |
| Linux trailing-backslash filenames lost their identity during TypeScript normalization. | Strip only `/` as a trailing separator. | Three tests failed before the fix and pass afterward, including the real native snapshot matcher allowing a filename that TypeScript had denied. Existing/missing names, physical symlink targets, and a distinct allowed sibling are covered. Previously persisted incorrectly normalized rules cannot automatically be reconstructed; recreate affected rules. |
| Create ignored caller access/status flags and forced a host `O_RDWR` descriptor. | Honor caller flags with `O_CREAT|O_EXCL`; authorize READ before exposing a read-only created/cache-enabled handle. | Access-mode, append/nonblocking, exclusivity, denial, and cache-mode tests. Writable opens remain direct-I/O. |
| Read-only truncating open lacked callback-level write authorization. | Require WRITE when `O_RDONLY|O_TRUNC` reaches the open callback. | Defense in depth: default bundled FUSE dispatch strips `O_TRUNC` and invokes the already-write-authorized truncate callback. This is **not** a demonstrated exploit through the current mounted configuration. |
| Valid xattr CREATE/REPLACE requests were blocked. | Validate and forward native flags rather than rejecting all nonzero flags. | Actual callback tests preserve success, `EEXIST`, `ENODATA`, and invalid-flag behavior. |

The mount-free C probe includes the actual native implementation, supplies a mocked FUSE context, and uses real encoded snapshots and live control descriptors. It does not substitute a simplified authorization algorithm or add a production test API. It cannot replace kernel/FUSE/Bubblewrap integration coverage.

## Approval required before implementation

### 1. Writable mmap and database locking

**Confirmed contract:** read-only shared mappings work on read-only descriptors. Writable descriptors use `direct_io`, which blocks shared mmap, including read-only shared mappings through `O_RDWR`. SQLite WAL shared memory is distinct from database read-mmap. Current SQLite DELETE-journal fixtures do not establish WAL compatibility.

**Separate integrity issue:** `filesystem_operations()` supplies neither `lock` nor `flock`. Locks are local to each FUSE mount, not coordinated with host processes or other calls. A naive POSIX `fcntl` forwarding callback is not sufficient: the daemon is one process, sandbox owners differ, and closing another descriptor can release process-owned locks. Define lock owners, dup/fork/close/flush, blocking cancellation, and backing-inode aliases before implementation.

**Considered, but not the user's preferred direction:** explicit private per-call scratch storage, authorized input snapshots, and a policy-mediated output commit. The user clarified that the harness should remain a transparent gate over normal host access, not change workflows through copying/staging. Do not implement scratch storage as the default or silently substitute it for host files. It remains an optional design candidate, not approved. It is not a transparent fix for concurrently opened host databases.

Required contract:
- Share scratch among processes within a call, but not between calls/principals.
- Bound bytes/inodes and aggregate concurrent usage; tmpfs does not itself bound anonymous memory or process count.
- Reject import/commit symlink and pathname escapes; authorize each input and every output/deletion.
- Detect host/sibling changes before commit and define conflict handling, per-file atomicity, and multi-file partial failures.
- Clean up on cancellation and verify no late resource/file creation.

**Transparent-host-access direction to investigate, still requiring explicit acceptance:** enable host writable mappings using handle/call-lifetime authority, accepting that ordinary FUSE callbacks cannot synchronously recheck every mapped store or reliably revoke an already writable mapped page. Keep ordinary syscall I/O live-checked; define mapping-specific authority and failure semantics rather than silently extending all descriptor permissions. Do not simply remove `direct_io`, enable writeback cache, or add modern `FUSE_DIRECT_IO_ALLOW_MMAP`. FUSE3/kernel negotiation improves compatibility, not per-store policy enforcement, backing-lock forwarding, or cross-mount coherence. The bundled implementation is FUSE 2.9 with older protocol headers.

The follow-up [transparent mmap feasibility investigation](transparent-mmap-feasibility.md) compares modern direct-I/O mmap and cached write-through, records mapping-authority and shared-host WAL limits, and recommends a test-only prototype pending approval. No mmap enforcement change was implemented.

Host writable bind mounts are an explicit policy bypass for their subtree, not an invisible compatibility fix.

### 2. Namespace and device authority

Approve private IPC namespaces before adding `--unshare-ipc`: System V shared memory, queues, and semaphores currently remain host-visible where normal permissions allow. Any GPU, hardware-token, serial, host-PTY, or host-shared-memory exception should be explicit and narrowly scoped, never a restored whole-host `/dev` bind. Credential sockets retain delegated host-service authority regardless of read-only mount flags.

### 3. Race-resistant filesystem authority

Descriptor-anchored resolution/operations and an explicit policy model for inode aliases are needed to go beyond deterministic replacement checks. Decide whether authority follows names, opened objects, or both; specify renames, unlink-open handles, revocation, and host-created hardlinks. Do not represent the current device/inode check as full TOCTOU protection.

## Bounded follow-up issues still open

- **Startup cancellation:** network cancellation/timeouts are installed after runtime preparation. A D-Bus proxy that never signals readiness can strand preparation. Make startup abortable at the proxy owner, transfer ownership deliberately, and drain concurrently started preparation before removal. Racing the entire preparation promise against abort would create late-resource cleanup races.
- **Broker command backpressure:** START/STOP writes can stall before their timeout-protected waits. Bound writes and propagate broker failure to all active calls.
- **Same-revision integrity:** conflicting base/ONCE snapshot contents at equal revisions are ignored. Accept only identical duplicate revisions and fail closed on conflicts. Normal publication increments revisions; no worker-controlled exploit was established.
- **Metadata boundary:** `benchmark_readlink` returns symlink text without read authorization/control checks; getattr/access metadata is also not comprehensively gated. A dangling symlink can expose text under a read-denied scope. Approve a consistent metadata/traversal contract before changing symlink-resolution behavior, rather than assuming content policy already protects all metadata.
- **Cache/coherence:** externally changed backing files can leave existing handles/mappings stale. Already-cached/faulted data survives policy revocation. Uncached denied mapping faults may signal `SIGBUS`; characterize this explicitly.
- **Opaque TCP compatibility:** full inspection rejects SSH/SMTP-style opaque protocols despite generic TCP approval. The policy docs now say inspection must be off for those workflows. Selective opaque forwarding requires an approved enforcement contract.
- **Conditional FD fallback:** the old-kernel `pi-exec-clean` fallback uses `_SC_OPEN_MAX`; survival of a descriptor above a lowered limit is a conditional hardening concern, not an established production escape.

## Verification completed in this session

- Native helpers build; TypeScript typecheck passes.
- Main-agent runs of 43 non-mount test files: **312 passed, 1 skipped, 0 failed** (313 total), including a rebuild/rerun after the final xattr correction. The existing skip requires absolute symlink creation, unavailable in this sandbox.
- An independent reviewer reproduced a timing-only failure twice in `native FUSE bounds waits for a truncated control frame`: total test duration was about 13.7s and 9.5s versus a 7s assertion. Both retained deny exit status; neither showed a fail-open decision. Those runs used the existing binary and included mediated fixture setup/cleanup; the main rebuilt runs pass. This discrepancy needs prepared-host verification, not a silently widened deadline.
- Native callback regressions: **27 passed, zero skipped**, including already-allowing opens/read/write/ftruncate failing closed after controller EOF. The implementer ran the original source against the initial 23 callback tests: 13 failed before the fixes.
- Three corrected filename regressions failed before normalization was fixed and pass afterward; six mocked launch/lifecycle cases pass.
- Four real mount/network integration files were deliberately excluded: `bash-sandbox.test.ts`, `native-fuse.test.ts`, `native-fuse-session-broker.test.ts`, and `network.test.ts`. This is **not** a passing full `npm test`.

## Host verification still required

Run only directly on a prepared host, not inside pi.lot or another sandbox:

```bash
npm test
```

Priority disposable tests: private `/dev` plus explicit socket imports; host-versus-worker and two-mount `flock`/byte-range conflicts; fresh SQLite WAL; writable-descriptor private/shared mmap; denied uncached page faults; basic C compiler/linker smoke tests; external backing-file coherence. Do not probe corruption on real databases or use real credentials.

## Upstream references

- [Linux FUSE I/O modes](https://www.kernel.org/doc/html/next/filesystems/fuse/fuse-io.html): direct I/O, shared mmap negotiation, cached/writeback behavior.
- [libfuse operation contracts](https://libfuse.github.io/doxygen/structfuse__operations.html): lock ownership, local-only locks without callbacks, and flush semantics.
- [SQLite WAL](https://sqlite.org/wal.html): shared-memory requirements and exclusive-locking exception, which does not fix uncoordinated host locks.
- [LLVM output buffer](https://github.com/llvm/llvm-project/blob/main/llvm/lib/Support/FileOutputBuffer.cpp): mmap-output failure can fall back to buffered output; compiler failures should not be generalized without versioned smoke tests.
- [Bubblewrap security guidance](https://github.com/containers/bubblewrap): the caller's mount/namespace policy determines the boundary.
