# pi.lot FUSE Broker MVP Specification

## Status

pi.lot now overrides Pi's built-in `bash` and resolves root-wide FUSE events through tool-call, session, and persistent path policy. The worker receives the FUSE filesystem as `/`; Pi's cwd is only its starting directory, and no direct host-root bind remains reachable. The broker hides its own temporary mount subtree, Bubblewrap supplies a private PID namespace and `/proc`, and worker capabilities are dropped. Policy revisions and atomic live policy replacement remain broader MVP work.

## Transparency principle

With every policy decision set to allow, filesystem behavior should match normal host-user execution as closely as FUSE permits. The broker replaces the worker's root so every ordinary host path reaches the decision system, but it must not add unrelated visibility or permission restrictions. Isolation is an implementation route to mediation, not an additional containment policy.

## Question being tested

Can a single already-running sandbox worker access the ordinary host filesystem only through a root-backed FUSE broker whose TypeScript policy can change at any time, with each denied operation prevented before it changes the backing host path?

A passing MVP supports FUSE as the filesystem reference-monitor direction. It does not establish production completeness by itself.

## Required demonstration

Without restarting the worker, remounting the filesystem, or reconstructing its mount namespace:

1. A write is denied and the backing file does not exist.
2. TypeScript changes the active policy.
3. The same worker retries and the write succeeds.
4. TypeScript revokes the policy.
5. The same worker retries another write and it is denied.
6. A descendant process observes the same current policy.

## Architecture

```text
host filesystem root
        ^
        | host fs operations after approval
        |
TypeScript FUSE broker ---- mutable versioned PolicyStore
        ^                         ^
        | FUSE request            | live policy updates
        |
host-only FUSE mount
        ^
        | bind-mounted as worker /
        |
Bubblewrap worker and descendants
```

The worker mount namespace must:

- Expose the ordinary host filesystem only through the FUSE mount installed as `/`.
- Preserve absolute path identity and start the command in Pi's original cwd.
- Use only the namespace differences required to prevent a path around the broker. The current worker retains a private PID namespace and matching `/proc` because host `/proc/<pid>/root`, `/proc/<pid>/cwd`, and `/proc/<pid>/fd` can expose another process's mount namespace.
- Hide the host-only FUSE mount directory from the FUSE view so it cannot become a recursive or direct implementation path.
- Contain no alternate bind of the host root that bypasses policy.
- Overlay a private minimal `/dev` for standard shell devices without exposing host device nodes through FUSE.
- Preserve environment, networking, IPC, and UTS state as far as the root-backed FUSE implementation permits. Other pseudo-filesystems and pathname sockets require explicit compatibility work rather than silent bypass mounts.

## Language boundary

Policy state, policy evaluation, event logging, lifecycle, and worker orchestration belong in TypeScript.

The first MVP may use `fuse-native` for kernel bindings. A native helper is acceptable only if Node 24 cannot mount reliably; policy decisions must remain in TypeScript.

## Policy model

The broker owns a mutable `PolicyStore` with a monotonically increasing revision.

Each brokered request records:

- Policy revision.
- Access type.
- Absolute host path or paths.
- Decision.
- Matching rule or reason.

Initial access types:

- `READ`
- `WRITE`
- `DELETE`

Structural `access`, `statfs`, `getattr`, `fgetattr`, `opendir`, and `readlink` callbacks are required for VFS traversal but do not resolve through content policy. They must not prompt or create a reusable `READ` rule. Content-bearing opens, reads, and directory listings remain policy-sensitive, including operations performed after a symlink resolves.

Policy replacement and mutation must be atomic from the perspective of an individual FUSE request. Races between an in-flight decision and a concurrent update are outside the MVP; the event records which revision was used.

## Operations

The MVP should support enough passthrough behavior for a normal direct worker and shell descendant:

- `access`, `statfs`, `getattr`, and `fgetattr`
- `opendir`, `readdir`, `fsyncdir`, and `releasedir`
- `open`, `flush`, `fsync`, and `release`
- `read`
- `create`
- `write`
- `utimens`
- `chmod` and `chown`
- `truncate` and `ftruncate`
- `mkdir` and `rmdir`
- `mknod`
- `unlink`
- `rename`
- `link`
- `readlink` and `symlink`
- `getxattr`, `listxattr`, `setxattr`, and `removexattr`

Unsupported mutation operations must fail closed with `ENOSYS`, `EPERM`, or `EACCES`; they must never silently bypass policy.

The installed `fuse-native@2.2.6` binding passes atime in both `utimens` callback slots. Ordinary `touch` works because it updates both timestamps together, but distinct atime/mtime preservation remains blocked on a corrected dependency binding.

Extended-attribute names and values resolve as `READ`; setting and removal resolve as `WRITE`. The `fs-xattr` bridge supports whole-value writes but not nonzero macOS positions or atomic `XATTR_CREATE`/`XATTR_REPLACE` flags. Those unsupported forms return an error instead of weakening their semantics.

## Open descriptor semantics

For this MVP, policy is evaluated for every FUSE `write`, `truncate`, and other mutation callback, not only at `open` or `create`.

The acceptance demo must test revocation after a descriptor has already been opened. A write through that descriptor after revocation must be denied and must not change the backing file.

The mount must disable or constrain caching and writeback enough for this behavior to be synchronous and observable by the worker. If `fuse-native` cannot provide that guarantee, the MVP must report the limitation rather than weakening this requirement silently.

## Path safety

The broker maps FUSE paths underneath the host root. Because `/` is the governed root, symlink targets, mount aliases, and hard-link names remain inside the same mediated tree rather than requiring a workspace-boundary audit.

The initial implementation must:

- Reject NUL-containing or malformed paths.
- Require every source and destination of a multi-path mutation to pass policy.
- Keep absolute path identity stable across the broker and worker.
- Hide and reject the broker's temporary mount subtree before touching its backing path.
- Ensure Bubblewrap exposes no direct host-root bind beneath the FUSE root.
- Drop all worker capabilities.

A Node path-based implementation still has host-side pathname race limitations. The MVP must document these and must not be presented as safe against a malicious process racing host path resolution. Production should use stable directory descriptors and `openat2`-style resolution or an equivalent native data-plane implementation.

## Caching requirements

For the demonstration mount:

- Attribute and entry cache lifetimes should be zero or minimal.
- Writeback caching must be disabled.
- Direct I/O should be used where needed to ensure mutation callbacks occur before success is returned to the worker.

Performance is not an MVP goal.

## Lifecycle and failure behavior

- Mount startup must complete before the worker starts.
- Worker exit must unmount the filesystem.
- Supervisor cancellation must kill the worker and unmount.
- Broker failure must not expose the backing path.
- A failed unmount must be reported clearly.
- Temporary mount directories must be cleaned when possible.

## Acceptance tests

### Live mutation

A single worker coordinates with the supervisor and proves:

1. Revision 1 denies `WRITE`; creating `denied-before.txt` returns a permission error.
2. Revision 2 allows `WRITE`; creating `allowed.txt` succeeds.
3. Revision 3 denies `WRITE`; creating `denied-after.txt` returns a permission error.
4. Only `allowed.txt` exists in the backing directory.

### Open descriptor revocation

1. Revision 4 allows opening and writing `open-handle.txt`.
2. The worker keeps the descriptor open.
3. Revision 5 denies `WRITE`.
4. Another write through the same descriptor returns a permission error.
5. The backing file contains only bytes written before revocation.

### Descendants

A shell descendant attempts one allowed and one denied mutation around policy updates and receives the same decisions as the initial worker.

### Mediation and non-interference

- The worker can access ordinary host paths through the FUSE root both inside and outside its cwd.
- The direct backing implementation and broker mount directory are unavailable to the worker.
- Absolute paths retain their host identity, permissions, and writability after policy approval.
- `..`, mount aliases, hard links, and symlink targets cannot leave the governed root or bypass policy.
- With an allow-all policy, ordinary files behave like direct host access apart from documented FUSE limitations.
- Pseudo-filesystem and pathname-socket compatibility gaps are explicit and do not become unmediated fallback paths; `/dev` and `/proc` are narrowly defined private overlays.

### Logging

Every tested policy-sensitive operation logs its policy revision, access type, path, decision, and reason.

## Success criteria

The FUSE architecture is accepted as the filesystem direction when all acceptance tests pass on the current Bazzite host and repeated runs leave no mounted filesystem, worker, or temporary backing changes other than explicitly allowed files.

## Non-goals

- Network mediation, which is specified separately in [`NETWORK-MVP.md`](./NETWORK-MVP.md).
- High-performance filesystem operation.
- Complete POSIX behavior.
- Protection against host-kernel vulnerabilities.
- A production claim based solely on this MVP.
