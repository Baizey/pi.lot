# pi.lot

Linux Pi extension providing kernel-mediated policy for shell-command I/O.

- [`FUSE-MVP.md`](./FUSE-MVP.md) documents the FUSE filesystem-broker model.
- [`NETWORK-MVP.md`](./NETWORK-MVP.md) specifies the private-namespace network gate planned for the FUSE worker.

## Transparency principle

The sandbox should behave as though it is absent except when an operation reaches the approval policy. With every operation allowed, commands should retain normal visibility, filesystem access, environment, local IPC, and process behavior as closely as the mediation mechanism permits. Isolation exists to route effects through policy—not to hide unrelated host resources.

## Bash filesystem policy

pi.lot overrides Pi's built-in `bash` tool while retaining Pi's streaming, truncation, timeout, and cancellation behavior. Each call requires a `purpose`: a non-empty, one-line explanation of at most 160 characters describing what the command will achieve. Each worker receives a FUSE view backed by the host filesystem root at `/`; Pi's working directory is only the worker's starting directory. Every policy-sensitive `READ`, `WRITE`, or `DELETE` request is resolved against path policy before the trusted broker accesses the host path. Structural `access`, `statfs`, `getattr`, `fgetattr`, `opendir`, and `readlink` lookups remain transparent: they neither prompt nor create a READ rule that could pre-authorize a later content read or directory listing. Operations against the resolved symlink target remain mediated.

Unmatched requests run through the shared decision-flow manager for scope, allow or deny status, lifetime, and an optional denial reason. The Bash purpose is shown throughout that flow alongside the command and FUSE operation. `ONCE` decisions last for one Bash tool call, `SESSION` decisions last for the current Pi session, and `LOCAL` decisions persist on this computer in `~/.pi/agent/pilot.sqlite`. Existing installations continue using a legacy `tau.sqlite` when it is present and no `pilot.sqlite` database exists. `GLOBAL` remains reserved for future synchronization and is not offered by the filesystem prompt.

One `PilotSessionRuntime` is created when Pi starts a session and closed on session shutdown. It owns the policy database, session policy state, shared UI decision-flow manager, and tool-display state; the FUSE Bash adapter only consumes those services. The Bash override is installed before runtime startup and fails closed if the session runtime is unavailable.

The built-in `bash`, `read`, `edit`, and `write` tools share the session display modes. `Ctrl+O` toggles truncated and full arguments/output, while `Alt+O` toggles a minimal view that shows only each tool's primary and secondary title arguments and hides output, including error text. Read and Write retain Pi's native text and syntax highlighting, Read retains native image behavior, and Edit retains Pi's native diff preview in full mode and uses a compact replacement summary when truncated. Minimal mode retains Pi's success or error background color and restores the previously selected truncated or full view when toggled off. Pi's `multi_tool_use.parallel` orchestration tool is not overridden.

The worker has no direct bind of the host root. Bubblewrap installs the FUSE mount as `/`, drops capabilities, and starts the command in its original working directory. The temporary broker mount lies under `/var/tmp` in the trusted host namespace and is hidden from its own FUSE view to prevent self-reference. A private minimal `/dev` and a private PID namespace with matching `/proc` are deliberate pseudo-filesystem exceptions. Private `/proc` prevents another same-UID process's mount namespace from being exposed through `/proc/<pid>/root`, while private `/dev` preserves standard shell devices such as `/dev/null` without exposing host device nodes through an unsuitable FUSE passthrough.

Root-wide mediation now covers ordinary host files, mount aliases, hard-link names, and symlink targets regardless of whether they are inside Pi's working directory. The current Node FUSE passthrough does not yet reproduce every other pseudo-filesystem or pathname Unix-socket behavior; these compatibility gaps must not be mistaken for policy denials.

## Experiments

The production extension does not register the two explicitly named experimental tools. They remain available through `registerExperiments(pi)` in `src/experiment/registerExperiments.ts` for focused development and testing.

### `bash-fuse`

Each command receives the complete host filesystem through a TypeScript FUSE passthrough broker mounted as the Bubblewrap worker's `/`. The command still starts in Pi's working directory, but paths elsewhere on the host pass through the same broker.

The broker asks before policy-sensitive `READ`, `WRITE`, or `DELETE` operations. Policy is checked for every write callback—not merely when a descriptor is opened—so revocation applies to an already-open descriptor. Multi-path mutations such as rename require approval for both paths. Timestamp, mode, and ownership updates are mediated as `WRITE`, allowing ordinary `touch`, `chmod`, and `chown` usage. Hard-link creation atomically requires `READ` on its source and `WRITE` on its destination. Extended-attribute values and names require `READ`; setting or removing an attribute requires `WRITE`. Special-node creation is mediated as `WRITE`; ordinary users can create FIFOs, while device nodes retain the host's privilege requirements. Unsupported mutation operations fail closed.

`fuse-native@2.2.6` currently forwards the requested access time in both timestamp callback slots. pi.lot therefore supports ordinary `touch`, where both times are updated together, but cannot preserve distinct requested atime and mtime values until the dependency fixes that binding defect. The `fs-xattr` bridge supports whole-value xattr writes; nonzero macOS positions and atomic `XATTR_CREATE`/`XATTR_REPLACE` flags fail explicitly rather than being ignored.

Attribute and entry caches are constrained and writeback caching is not enabled. Performance is intentionally not an MVP goal.

### `bash-network`

Each command runs with normal host-user identity, writable host filesystem access, environment, and pathname Unix-socket access while sharing a private IP network namespace owned by a trusted outer supervisor. Bubblewrap supplies only the capability boundary needed to prevent the worker from changing that namespace. The supervisor installs an nftables default-drop gate before attaching `slirp4netns` and before releasing the worker.

For the initial vertical slice, nftables sends the first outbound IPv4 TCP SYN to a small `libnetfilter_queue` helper. The helper holds that exact packet while TypeScript requests a decision. `ALLOW` repeats the packet with a trusted mark that nftables copies to its conntrack entry; only that connection is then forwarded by `slirp4netns`. `DENY` repeats it with a reject mark, producing a TCP reset without a host connection. A pending conntrack mark drops SYN retransmissions while the decision is open.

This is currently a standalone transparent IPv4 TCP-path prototype. DNS, UDP, externally routed IPv6, active-flow revocation, and integration with the root-wide FUSE worker remain unimplemented and fail closed on the TAP path. Filesystem operations and pathname local IPC are deliberately not mediated by this tool. Because unprivileged network namespaces require a user namespace, the worker retains the host UID and primary GID but cannot necessarily retain every supplementary group; abstract Unix sockets are also network-namespace scoped.

## Requirements

- Linux x86-64
- Node.js and npm
- A C compiler
- `pkg-config` and `libnetfilter_queue` development files for `bash-network` (`libnetfilter_queue-devel` on Fedora/Bazzite; `libnetfilter-queue-dev` on Debian/Ubuntu)
- Bubblewrap (`bwrap`)
- FUSE (`/dev/fuse` and `fusermount`) for pi.lot's Bash override and `bash-fuse`
- User namespaces, nftables (`nft`), `unshare`, `nsenter`, and `slirp4netns` for `bash-network`

## Install

```bash
npm install
pi install /absolute/path/to/pilot
```

To try it without installing:

```bash
pi -e /absolute/path/to/pilot
```

This repository also contains `.pi/settings.json`, which auto-loads the package while working in the repository.

## Test

```bash
npm test
```

The tests exercise the experimental Pi tool integrations, verify production session-runtime ownership and decision-flow cancellation, and cover protocol validation, root-wide FUSE mediation inside and outside the command cwd, hidden broker paths, hard-link and symlink aliases, network deny/allow transitions, denied host effects, delayed decisions, TCP retransmissions, source-port reuse, descendant mediation, and FUSE policy revocation on an open descriptor.

## Project layout

- `src/extension.ts` — pi.lot's production Pi extension entry point and session lifecycle composition.
- `src/runtime/PilotSessionRuntime.ts` — session-owned policy database, policy runtime, and decision-flow manager.
- `src/tools/` — one folder per overridden Pi tool (`bash`, `read`, `edit`, and `write`).
- `src/tools/bash/BashTool.ts` — built-in Bash override and FUSE worker lifecycle adapter.
- `src/fuse/FusePathPolicyAuthorizer.ts` — FUSE event-to-path-policy mapping and user decisions.
- `src/policy/path/PathPolicyRuntime.ts` — tool-call, session, and persisted path-policy ownership.
- `src/tui/UiDecisionFlowManager.ts` — reusable multi-step policy decision UI and TUI shortcuts.
- `src/tui/tool/` — declarative tool presentation, bounded head/tail rendering, and session display controls.
- `src/experiment/registerExperiments.ts` — opt-in registration and approval prompts for experimental bash tools.
- `src/fuse/fuse-runner.ts` — FUSE mount and Bubblewrap worker lifecycle.
- `src/fuse/FuseFilesystem.ts` — policy-mediating passthrough filesystem.
- `src/experiment/network/network-runner.ts` — private network namespace, nftables gate, and userspace transport lifecycle.
- `src/experiment/network/network-queue-protocol.ts` — validated TypeScript side of the NFQUEUE helper protocol.
- `native/pi-network-queue.c` — thin `libnetfilter_queue` packet hold/verdict adapter.
- `scripts/build-native.mjs` — native adapter build.
- `test/` — focused unit and real-system integration tests.

## Important warning

This is a proof of concept, not a production sandbox.

The FUSE broker performs host-side path resolution through Node APIs; a malicious host process racing those paths may exploit pathname time-of-check/time-of-use windows. The complete host root is governed, so filesystem aliases remain inside the mediated tree, but the broker's own temporary mount must remain hidden to avoid recursive access. Filesystem effects delegated to an existing host service are outside the direct worker reference-monitor boundary. Production should use stable directory descriptors with constrained `openat2`-style resolution or an equivalent native data plane.

The network path now holds the original IPv4 TCP SYN in NFQUEUE and binds approval to that packet's conntrack generation rather than a timed tuple. If the initiating socket closes while approval is pending, approving still releases that original queued packet; a replacement socket reusing the tuple receives a separate decision. The implementation remains an initial reference-monitor seam, not yet the complete protocol coverage, DNS identity, or revocation model required by [`NETWORK-MVP.md`](./NETWORK-MVP.md). Network effects delegated to an existing host service through local IPC are intentionally outside this tool's policy boundary.
