# Fluent FUSE Broker MVP Specification

## Status

Implementation target for the next pi-sandbox vertical slice. This document is the source of truth for the FUSE MVP.

## Question being tested

Can a single already-running sandbox worker access a host workspace only through a FUSE broker whose TypeScript policy can change at any time, with each denied operation prevented before it changes the backing workspace?

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
host backing workspace
        ^
        | host fs operations after approval
        |
TypeScript FUSE broker ---- mutable versioned PolicyStore
        ^                         ^
        | FUSE request            | live policy updates
        |
host FUSE mount
        ^
        | bind-mounted as workspace
        |
Bubblewrap worker and descendants
```

The worker mount namespace must:

- Mount the host root read-only.
- Hide the direct host backing path.
- Bind the FUSE mount at the worker's workspace path.
- Provide private `/tmp`, `/proc`, and minimal `/dev`.
- Contain no alternate writable path to the backing workspace.

## Language boundary

Policy state, policy evaluation, event logging, lifecycle, and worker orchestration belong in TypeScript.

The first MVP may use `fuse-native` for kernel bindings. A native helper is acceptable only if Node 24 cannot mount reliably; policy decisions must remain in TypeScript.

## Policy model

The broker owns a mutable `PolicyStore` with a monotonically increasing revision.

Each brokered request records:

- Policy revision.
- Access type.
- Workspace-relative path or paths.
- Decision.
- Matching rule or reason.

Initial access types:

- `READ`
- `WRITE`
- `DELETE`

Policy replacement and mutation must be atomic from the perspective of an individual FUSE request. Races between an in-flight decision and a concurrent update are outside the MVP; the event records which revision was used.

## Operations

The MVP should support enough passthrough behavior for a normal direct worker and shell descendant:

- `getattr`
- `readdir`
- `open` and `release`
- `read`
- `create`
- `write`
- `truncate` and `ftruncate`
- `mkdir` and `rmdir`
- `unlink`
- `rename`
- `readlink` and `symlink`

Unsupported mutation operations must fail closed with `ENOSYS`, `EPERM`, or `EACCES`; they must never silently bypass policy.

## Open descriptor semantics

For this MVP, policy is evaluated for every FUSE `write`, `truncate`, and other mutation callback, not only at `open` or `create`.

The acceptance demo must test revocation after a descriptor has already been opened. A write through that descriptor after revocation must be denied and must not change the backing file.

The mount must disable or constrain caching and writeback enough for this behavior to be synchronous and observable by the worker. If `fuse-native` cannot provide that guarantee, the MVP must report the limitation rather than weakening this requirement silently.

## Path safety

The broker maps FUSE paths underneath one fixed backing root.

The initial implementation must:

- Reject NUL-containing or malformed paths.
- Reject lexical escape outside the backing root.
- Prevent a symlink in the backing tree from turning a brokered operation into an operation outside the backing root.
- Require every source and destination of a multi-path mutation to pass policy.

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

### Isolation

- The worker can access the workspace through the FUSE mount.
- The direct backing path is hidden or inaccessible in the worker namespace.
- The host root is read-only.
- `..` and symlink escape attempts do not modify outside files.

### Logging

Every tested policy-sensitive operation logs its policy revision, access type, path, decision, and reason.

## Success criteria

The FUSE architecture is accepted as the filesystem direction when all acceptance tests pass on the current Bazzite host and repeated runs leave no mounted filesystem, worker, or temporary backing changes other than explicitly allowed files.

## Non-goals

- Network mediation.
- Connecting this future FUSE broker to Pi's approval UI (the seccomp bash-extension MVP is a separate integration seam).
- Persistent policies.
- High-performance filesystem operation.
- Complete POSIX behavior.
- Protection against host-kernel vulnerabilities.
- A production claim based solely on this MVP.
