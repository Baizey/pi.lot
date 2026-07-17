# Pi Sandbox Demo Specification

## Status

Installable Pi extension MVP implemented for interactive bash I/O approval. This remains a review draft rather than a production security claim.

This document records the sandbox model and requirements. The repository has been reduced to the Pi extension path; the earlier standalone deterministic supervisor and demo worker have been removed.

## Goal

Demonstrate that agent-controlled work can run outside Pi's trusted process while a trusted supervisor makes synchronous policy decisions before selected filesystem or network effects occur.

The demo must show this sequence:

1. An untrusted worker attempts an operation.
2. The Linux kernel blocks the operation before executing it.
3. A trusted supervisor receives an event describing the operation.
4. The supervisor evaluates policy.
5. An allowed operation resumes.
6. A denied operation returns a normal OS permission error to the worker.

The extension covers shell commands and every descendant created within the same sandbox boundary.

## Security boundary

### Trusted

- The Pi process and the installable extension's approval callback.
- The extension's sandbox runner and approval callback.
- Bubblewrap while constructing the worker sandbox.
- The host kernel.
- Runtime files mounted read-only into the sandbox.

### Untrusted

- Direct agent I/O implementations executed as workers.
- Bash and other command interpreters.
- Every descendant created by an untrusted worker.
- Arguments, paths, and network destinations supplied by an agent.

## Required invariants

1. Untrusted work never runs in the trusted supervisor process.
2. The mediation mechanism is inherited by every worker descendant.
3. A denied mediated operation has no corresponding host effect.
4. The worker cannot remove an inherited seccomp filter.
5. The sandbox receives no unnecessary inherited file descriptors.
6. Host system paths are read-only in the worker mount namespace.
7. The supervisor remains responsive while a worker is blocked for a decision.
8. Cancelling the supervisor terminates the sandboxed process tree.
9. Policy decisions and the operation that caused them are logged.
10. The demo never presents itself as a complete production sandbox.

## Demo scope

### Filesystem events

The demo emits typed path accesses for common policy-relevant filesystem operations, including:

- Read-only and write-capable file opens.
- Executable loading.
- Common metadata queries such as stat, access, and readlink.
- Truncation and file or directory creation.
- Removal.
- Rename, with `DELETE` for the source and `WRITE` for the destination.
- Hard-link and symbolic-link creation.
- Permission changes.

Each path access is classified as `READ`, `WRITE`, `DELETE`, or `EXECUTE` and uses a normalized absolute path resolved relative to the worker's current directory or directory file descriptor when available. One syscall can carry multiple typed path accesses.

Filesystem policy for the deterministic demo:

- `READ` and `EXECUTE` are allowed but still emitted and logged so a mature policy system can replace this demo policy.
- `WRITE` and `DELETE` are allowed only underneath explicitly configured writable roots or in sandbox-private storage.
- Other host-path mutations are denied.
- Host system files remain read-only even if a policy bug accidentally allows a mutation syscall.

### Network events

The demo mediates common connection-producing operations:

- `connect` for TCP, UDP, and Unix sockets.
- Connectionless sends where practical for the prototype.

Network policy for the initial demo:

- Network access is denied unless a destination is explicitly allowed.
- Decisions identify the address family, destination address, and port when available.
- Unknown or undecodable destinations are denied.

The kernel does not provide HTTP URLs at this layer. URL-aware policy is outside this demo and belongs in an application-level proxy or a structured web tool.

### Decisions

The extension delegates every decoded event to trusted TypeScript for a decision. The intended policy capabilities include:

- Allow filesystem mutation below one or more configured roots.
- Allow network connections to explicitly configured destinations.
- Deny unmatched operations.

The installable Pi extension uses an interactive `ask` mode for `bash-bubblewrap`. Every mediated event is denied when interactive UI is unavailable; otherwise the pending kernel operation is mapped directly to a `ctx.ui.confirm` yes/no prompt.

This prompt is an MVP integration seam. The intended mature consumer resolves existing once/session/local/global policy before asking the user.

## Implementation language boundary

The public interface, policy evaluator, event log, and future Pi integration are implemented in TypeScript.

Node does not directly expose the seccomp notification ioctls or Unix descriptor transfer required by this prototype. A small native adapter may therefore:

- Launch Bubblewrap and the inner worker.
- Install the seccomp filter.
- Hold the kernel notification descriptor.
- Decode kernel operation data into a versioned event protocol.
- Block until TypeScript replies `ALLOW` or `DENY`.
- Forward that decision to the kernel.

The native adapter must contain no configurable policy logic. It reports typed resource accesses and blocks for TypeScript decisions. It may automatically continue a notified syscall only when that syscall introduces no new policy-relevant resource access, such as a destination-less send through an already connected socket.

## Demo architecture

```text
trusted TypeScript supervisor and policy engine
    |                         ^
    | versioned events        | ALLOW or DENY
    v                         |
minimal native adapter --------
    |
    | launches and monitors
    v
bubblewrap sandbox
    |
    | starts an inner launcher that installs an inherited filter
    v
untrusted worker and descendants

kernel seccomp notification
    |                         ^
    | pending operation       | continue or errno
    v                         |
minimal native adapter --------
```

Bubblewrap provides:

- User, mount, PID, IPC, and UTS namespaces.
- A read-only host root.
- A private `/proc` and minimal `/dev`.
- A private temporary directory.
- Explicit writable bind mounts only for configured demo workspaces.
- Parent-death and session isolation.

The inner launcher installs a seccomp filter using `SECCOMP_RET_USER_NOTIF`, transfers the notification descriptor to the trusted supervisor, closes its control descriptor, and executes the requested worker. The filter is inherited across `fork` and `exec`.

The supervisor receives pending syscall notifications and responds with either:

- `SECCOMP_USER_NOTIF_FLAG_CONTINUE` to allow the kernel to execute the syscall.
- A negative permission result such as `EPERM` to deny it.

## Pi extension MVP

The package manifest exposes `src/extension.ts` as a Pi extension. The extension registers `bash-bubblewrap` and delegates its commands to the native sandbox adapter.

For this MVP:

- Every Pi `bash` tool call runs in a fresh sandbox worker.
- The Pi working directory is the only writable host bind.
- Each mediated read, write, delete, execute, connection, or unknown operation blocks while Pi asks the user yes/no.
- No UI, cancellation, prompt failure, or malformed protocol input resolves to `DENY`.
- The decision and triggering operation are included in the bash tool output.
- The extension's yes/no callback is only a temporary resolver; matching scopes and once/session/local/global lifetimes belong to the mature TypeScript policy system consuming these events.
- Pi's direct file tools and user-entered `!` commands are not overridden.

This is deliberately a proof of the integration seam, not a persistent policy system or a complete replacement for Pi's tool suite.

## Acceptance scenarios

The focused extension tests must verify:

1. The package registers `bash-bubblewrap` through its Pi extension manifest.
2. Read, write, delete, and executable-load events reach the TypeScript decision callback.
3. An allowed workspace write changes the host file.
4. A denied write returns a normal command failure and has no host effect.
5. Protocol validation rejects malformed or unsupported event shapes.
6. The host root remains read-only and descendants inherit mediation.

## Explicit prototype limitations

The seccomp-notification demo is not the final filesystem design.

### Read access

The seccomp prototype now reports common path acquisition and metadata-read syscalls, but the host root remains visible inside the worker. The current interactive resolver asks about these accesses; a mature policy consumer is expected to apply its own scoped and lifetime-aware decisions. Syscall coverage is explicit rather than complete, and approved reads still expose host data directly. A production worker should receive a constructed runtime root and expose policy-controlled user data only through the filesystem broker.

### Path time-of-check/time-of-use

For a notification response using `CONTINUE`, a hostile multithreaded worker can change userspace path memory after inspection but before the kernel consumes it. Reading `/proc/<pid>` paths also does not provide a durable authorization identity.

The production filesystem broker must avoid authorizing a mutable pathname and then blindly continuing it. Preferred designs are:

- A custom FUSE filesystem that performs the host operation itself after policy approval.
- Safe syscall emulation using stable directory descriptors and `openat2` resolution constraints where applicable.

### Syscall completeness

Linux has multiple interfaces for equivalent effects. The demo covers an explicit syscall set and must deny or disable known bypass classes such as `io_uring`. Completeness requires adversarial review and architecture-specific syscall tables.

### Open file descriptors

Policy is primarily decided when obtaining a descriptor or resolving another path-based operation. Reads or writes through an already approved descriptor are treated as covered by that approval. The sandbox must not inherit unapproved host descriptors.

### Network completeness

A syscall notification can demonstrate connection mediation, but production networking should provide no unbrokered route at all. The final design should use a private network namespace connected only to a trusted userspace network broker. HTTP URL policy requires an HTTP-aware proxy.

### Kernel boundary

This is container-style isolation. It assumes the host kernel is not compromised. Hostile native code requiring kernel isolation belongs in a microVM.

## Production direction after the demo

If the demo validates the interaction model:

1. Keep Pi and policy/UI services trusted and outside the sandbox.
2. Move every agent-controlled direct tool operation into a worker or broker request.
3. Replace pathname `CONTINUE` mediation with a FUSE filesystem broker.
4. Give workers a network namespace with no route except through a network broker.
5. Preserve seccomp as defense in depth and to deny unsupported kernel interfaces.
6. Bind each policy decision to the worker, operation, and stable resource identity.
7. Add adversarial tests for symlinks, hard links, rename races, `/proc`, Unix sockets, inherited descriptors, process trees, and cancellation.

## Out of scope

- Approval integration for Pi tools other than `bash`.
- Persistent policy storage or remembered approval scopes.
- HTTP/TLS interception.
- Applying captured overlay changes transactionally.
- Protection against kernel vulnerabilities.
- Cross-platform support.
