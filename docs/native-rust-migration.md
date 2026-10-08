# Native Rust migration and parity

The four native helpers now build from `native/rust/`. This is a language and ownership migration, not a new filesystem frontend or a broadened enforcement contract.

## Architecture

| Executable | Rust implementation | External boundary |
| --- | --- | --- |
| `pi-fuse-native` | `fuse.rs`, `fuse/{snapshot,control,path,callbacks,broker}.rs` | `native/pi-fuse-shim.c` translates the system high-level libfuse ABI. |
| `pi-network-queue-native` | `network_queue.rs`, `network_queue/queue.rs` | Narrow `libnetfilter_queue` FFI; safe packet/DNS/verdict parsing. |
| `pi-tcp-gateway-native` | `tcp_gateway.rs` | Linux socket, capability, signal and fork syscalls. |
| `pi-exec-clean-native` | `exec_clean.rs` | Descriptor cleanup and byte-preserving `execvp`. |

The FUSE shim retains libfuse's header-defined structures, bitfields, operation table and public capability helpers. It contains no policy matching, path resolution, snapshot parsing, backing-file operations or broker algorithm. Rust owns that logic. The frontend remains high-level, pathname-based system libfuse >= 3.17.3, not an inode-oriented replacement.

Rust dependencies are limited to the pinned `libc` crate. `native/rust/Cargo.lock` is checked in; npm builds use Cargo's `--locked` option. Linux x86-64 remains the supported platform. Rust >= 1.85, Cargo, a C compiler and the existing FUSE/NFQUEUE SDKs are required.

The normal build publishes Rust helpers under the existing `build/` executable names. SDK preflight and successful compilation precede replacement; artifacts are staged before publication and each replacement is by rename. Existing processes can retain their open executable inode. Restart Pi after rebuilding a live installation.

## Retained comparison implementation

The original `native/pi-{fuse,network-queue,tcp-gateway,exec-clean}.c` files remain as a regression reference. Confirmed legacy bugs are fixed there as well as in Rust. They are built separately:

```bash
npm run build:native:reference
```

Reference artifacts live in `build/native-c/`. `PILOT_NATIVE_IMPLEMENTATION=c` explicitly selects them; `rust` is the default. Invalid selections are rejected. A missing Rust helper does **not** trigger a C fallback.

Neither the C reference nor the Rust port should gain an untested behavior change merely to make their outputs agree. Independent expected results supplement differential comparison, so a shared bug does not count as success.

## Verification commands

```bash
npm run test:native       # Build both, Rust units, shared mount-free contracts, direct parity
npm run test:native:rust  # Rust unit tests only
npm run test:native:host  # Same contracts, plus mounted/network tests on BOTH implementations
npm test                 # Build/typecheck, mount-free parity, all discovered runtime test files
```

The parity suite also needs Python 3 and the C compiler for test-only launchers and probes; the normal Rust helpers do not depend on Python. The prepared-host command fails preflight if `/dev/fuse` is absent. Do not run nested FUSE/Bubblewrap/network integration inside pi.lot or another restrictive sandbox.

For individual existing tests:

```bash
PILOT_NATIVE_IMPLEMENTATION=c node --import jiti/register --test test/native-fuse-callbacks.test.ts
PILOT_NATIVE_IMPLEMENTATION=rust node --import jiti/register --test test/native-fuse-callbacks.test.ts
```

## Parity coverage

The shared runner executes the same assertions in separate C and Rust processes. The callback fixtures compile against either the actual C helper or the actual Rust static library through its ABI shim; they do not substitute a mock authorization algorithm. Both the original callback driver and real mount-free libfuse INIT negotiation driver are retained.

| Contract | Evidence |
| --- | --- |
| Snapshot magic, framing, lengths, layers, access/decision fields, path bytes, precedence, ties, revisions | `native-fuse-parity.test.ts`, `native-filesystem-policy-view.test.ts`, Rust snapshot/path units. Includes independent binary encoding, every truncation, deterministic byte mutations and full-width u64 revisions. |
| Live control ordering, grants/denials, EOF, malformed/truncated frames, rollback and resolution fields | `native-fuse-protocol.test.ts`, existing callback regressions, Rust control units. |
| FUSE broker framing, blocked controller handshakes, STOP/reaping and parent-death | `native-fuse-broker-parity.test.ts` drives both production brokers without mounting. |
| FUSE capability negotiation and internal libfuse bookkeeping | Both original C INIT probes, built for each implementation; real INIT wire replies as well as mocked public-helper calls. |
| Open/create flags, read-only cache versus writable direct I/O, retained-inode checks, path mutations, xattrs and directory enumeration | `native-fuse-callbacks.test.ts`, `native-fuse-contract.test.ts`; backing-file effects and denial events are asserted, not just exit codes. |
| IPv4/IPv6/TCP/UDP/DNS parsing and exact verdict protocol | `native-network-queue-parity.test.ts` and Rust units. Independent accepted/dropped expectations, packet bounds, options/fragments/flags, DNS labels/types/classes/compression, all truncations, verdict bytes/marks and deterministic mutation corpus. |
| TCP relay binary data, backpressure, EOF/half-close, privilege dropping, endpoint framing and process lifecycle | `native-process-parity.test.ts`; real socket relays, capacity/reaping and parent-death tests without transparent-routing privileges. |
| Exec argv/environment bytes, PATH and ENOEXEC, fd boundary, errno/status, signals and startup stdio | `native-process-parity.test.ts`, FUSE startup differential cases. Includes non-UTF8 arguments/environment and forced fallback syscalls. |
| Mounted cache/mmap behavior, isolated mount policy state, teardown and real network gate | Existing `native-fuse.test.ts`, `native-fuse-session-broker.test.ts`, `bash-sandbox.test.ts`, `network.test.ts`, run on BOTH implementations by `test:native:host`. The user reported successful prepared-host completion; see verification below. |
| Build/SDK errors, quoting, lockfile use, safe staging and helper selection | `native-build-flags.test.ts`, `native-executable.test.ts`. |

A differential mutation corpus is not a substitute for sustained coverage-guided fuzzing. A mount-free pass is not a proof of kernel/mount/network equivalence. Passing the prepared-host suite establishes parity for its covered contracts, not universal equivalence across all inputs, kernels or configurations.

## Local verification for this migration pass

- `npm run test:native`: **21 Rust unit tests**, **216 identical contracts on C**, **216 on Rust**, and **88 direct differential/build/selection tests** passed; no failures or skips.
- All available mount-free runtime files: **508 passed, 1 skipped, 0 failed**. The existing skip cannot create the absolute symlink needed by a policy-containment test in this sandbox.
- TypeScript typecheck, Rust formatting, clippy on all targets with warnings denied, and whitespace checks passed.
- Four prepared-host files were deliberately excluded from the general runtime run: `bash-sandbox.test.ts`, `native-fuse.test.ts`, `native-fuse-session-broker.test.ts`, `network.test.ts`.
- The agent could not run `test:native:host` in this sandbox because `/dev/fuse` is absent. Subsequent user-run prepared-host results are recorded separately below.
- An attempted ASan/UBSan packet-reference build could not link because the host's `libasan.so.8.0.0` and `libubsan.so.1.0.0` runtimes are missing. No sanitizer pass is claimed; the comparison artifact was restored.

These are overlapping suites, not counts to sum into unique test coverage. Local validation used Rust/Cargo 1.97.1, libfuse 3.18.2 and libnetfilter_queue 1.0.5.

## Prepared-host verification (user-reported)

The user confirmed successful completion of `npm run test:native:host` on a prepared, unsandboxed host and supplied these summaries:

- Shared contract suite: **274 passed, 0 failed, 0 skipped**.
- Final direct differential/build/selection suite: **88 passed, 0 failed, 0 skipped**.

The runner executes the same shared contracts first against C and then against Rust, including the four mounted/network files excluded locally, and stops immediately if either process fails. Reaching and passing the final differential block therefore confirms both implementations passed the prepared-host contracts. The supplied 274-test summary is a contract-suite block, not the total for the whole command.

This closes the previously environment-blocked validation gap for the existing mounted FUSE, Bash and network contracts. These results were reported by the user, not independently rerun by the agent; host/kernel/toolchain versions were not supplied. Sustained coverage-guided fuzzing, sanitizer validation and independent security auditing remain outstanding.

## Proven legacy defects fixed on both sides

The pre-port C baseline was revision `899ff3f`; its initial selected mount-free suite passed 108 tests without failures or skips. The following new regressions were run before modifying the relevant C behavior and failed on **both** the original C implementation and the faithful Rust translation:

### Descriptor cleanup above a lowered limit

The launcher opens fd 512, lowers `RLIMIT_NOFILE` to 64, and uses seccomp to make `close_range` return `ENOSYS`. The original fallback loops only to `_SC_OPEN_MAX`, leaving fd 512 inherited into the target. Both helpers printed `open` where the regression expected `closed`.

Both implementations now enumerate actual open descriptors via `/proc/self/fd`, without relying on the lowered limit. The owned enumeration descriptor is not leaked or prematurely closed. Failure to enumerate aborts before exec with status 126. Tests also cover explicitly preserving the high fd, `EINVAL` fallback, non-fallback errors, and failures to open/read the descriptor directory.

This proves a conditional descriptor-cleanup defect; it is not a demonstrated production sandbox escape.

### Conflicting snapshot contents at an equal revision

The controller sends ONCE revision 1 allowing the target, then different contents at revision 1 denying it, then an ALLOW resolution. Both pre-fix implementations discard the conflicting update and return ALLOW/status 0; the regression expects DENY/status 2.

Both implementations now accept an equal revision only if all parsed authority contents match: ordered rules, paths, access types, decisions and layers. Conflicts in base files or ONCE frames fail closed with protocol failure. Identical retransmissions remain valid. Reserved wire bytes are not policy authority and retain their existing parsing behavior.

This proves a control-integrity defect. No worker-controlled exploit has been established.

### TCP relay adoption before parent-death registration

A test-only preload wrapper pauses the real fork child immediately after fork, before the production relay installs `PDEATHSIG`. A launcher becomes a non-PID-1 child subreaper, kills the gateway, confirms the paused relay was adopted, then resumes it. The original `getppid() == 1` check misses this adoption. Both pre-fix implementations connected to the broker (`broker-connected`) instead of exiting (`relay-rejected`).

Both implementations now capture the gateway's PID before fork and compare it to `getppid()` after installing the parent-death signal. The child exits before any broker connection if the parent changed. The deterministic regression exercises production `accept_client`; only fork scheduling is controlled. The existing capacity, reaping and normal parent-death tests remain.

## Rust-specific compatibility traps

Rust runtime startup ignores SIGPIPE and may reopen initially closed standard descriptors. Those are not legacy C bugs. A shared pre-runtime initializer records the inherited state, and each helper restores closed standard descriptors before opening resources. Early exec, TCP and FUSE diagnostics preserve inherited SIGPIPE, as does FUSE protocol-check mode; modes that explicitly ignored SIGPIPE in C continue to do so. Regression tests cover these behaviors rather than assuming `main` starts from the same process state in both languages.

Every Rust callback returning through C contains unwinding; a callback panic permanently fails that mount closed. FFI still needs audited pointer, buffer and lifetime contracts. Rust does not make libfuse or libnetfilter_queue memory-safe, run destructors after SIGKILL, or eliminate filesystem races.

## Unchanged security limits

This migration does not enable writable shared mmap, writeback cache, passthrough, backing-file locks or inode-wide policy. Pathname TOCTOU, existing aliases, metadata visibility, cached-data revocation/coherence and the external mediation boundaries remain as documented in [Security](security.md). Normal syscall authorization ordering and the existing transparent-host workflow are preserved.
