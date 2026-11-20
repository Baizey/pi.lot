# Security model and limitations

> [!WARNING]
> pi.lot is experimental, has not been independently audited, and is not a hardened sandbox for hostile code.

## Intended model

pi.lot is designed to make selected agent effects visible and controllable while preserving a normal cross-repository Linux workflow. It mediates supported filesystem and network effects produced through Pilot's built-in tools.

It is **mediation, not complete isolation**:

- the host kernel and trusted Pi process are inside the trusted computing base;
- an allowed operation keeps the invoking user's normal host authority; and
- the agent can see broad host resources, subject to policy when supported operations are attempted.

## Mediated boundaries

- Direct `read`, `edit`, and `write` tool calls use the policy runtime.
- Bash filesystem effects pass through a FUSE broker.
- Bash DNS, TCP, UDP, supported HTTP/HTTPS, and recognized SSH/SMTP/ADB/WebSocket/gRPC and [service protocol](network-protocols.md) effects pass through the network gate. Application-protocol admission has the mode and channel boundaries described below.
- `web_search`, `archive_list`, and `archive_fetch` use policy-checked host-side HTTP, not Bash's network gate. Archive tools are root-only; list/download POSTs require `web_write`.
- Subagents have principal-specific policy state.

See [Policy system](policy.md) for exact semantics, the [documentation index](README.md) for related guides, and [installation](installation.md) for host prerequisites.

### Sandbox compatibility settings

Network inspection defaults **on** and remains session-only. Writable mapping is a separate path policy (`fs_mmap`, built-in fallback **ask_user**), not a Bash argument or `/sandboxing` subcommand. Change the fallback with `/policy-defaults <mode> fs_mmap` and save it with `/policy-defaults save`. Remembered approvals under the old working-directory policy do not authorize mapping paths under the new policy.

Inspection off allows opaque end-to-end TLS and unrecognized plaintext to use transport-only policy; recognized supported plaintext protocols still receive their checks. `fs_mmap` controls backing writeback, not mapping creation or individual stores. These are explicit compatibility tradeoffs, not stronger isolation. See [session sandboxing settings](policy.md#session-sandboxing-settings).

## Explicit boundaries outside mediation

### MCP

MCP stdio servers run as host processes and MCP HTTP transports use the host network. MCP tool effects are opaque and not inspected by filesystem or network policy; tool annotations are hints, not enforcement. Trust the servers and expose only the tools you need. Child access requires the hard `mcp` grant, independent of policy-area grants; see [subagent capabilities](subagents.md#hard-mechanism-capabilities).

### Codemode model calls

Root codemode exposes `models.classify()` and `models.generateImages()`. These are host-side calls using the session's authenticated provider credentials, can transmit supplied data, and may incur charges. They are outside pi.lot's filesystem and network mediation; policy-area approvals do not gate them. Child codemode is created with `models: false` and exposes no model globals.

### Server archival

**Saving server configuration enables automatic current-family background archival on graceful session shutdown**, outside agent policy approval. `/server upload [current|all]` uses the same trusted queue. Uploads send complete JSONL across all branches, potentially including prompts, reasoning, credentials, tool arguments/results, and file contents—not merely visible previews. Departure queues a cached source descriptor after local teardown, even if teardown reports failure; ephemeral/unconfigured automatic sessions are skipped. The independent worker can capture, reconcile, and send after ordinary Pi exit. There is no foreground upload drain or ten-second upload deadline.

A descriptor is not an exact departure image: deletion/rewrite before capture can lose older bytes. Captured bytes survive source loss. Startup/configuration/manual wakeups resume retained work, not periodic or automatic all-history backfill. Machine shutdown, session/cgroup termination, or worker failure can stop execution until a later wakeup; forced exits before the hook can bypass queueing.

Use `/server logout` to pause retained work and prevent subsequent requests; already-dispatched effects cannot be recalled. Login/logout change local authorization and wake background work, which may contact the server. Logout neither revokes the token nor deletes history, journal, or downloads. Jobs pin origin/generation; replacement credentials must verify the same server/namespace before resuming bound work. Unbound superseded-generation jobs stay paused. API keys are not passed in worker arguments, manifests, diagnostics, or inherited provider environment. Bare `/server` in the terminal TUI opens a menu that hides the saved key. **Check connection** still displays it, as does bare `/server` outside the terminal TUI; do not share those outputs. There is no `/server status` text subcommand. Prefer HTTPS; HTTP sends the key unencrypted. Archive tool policy context does not contain it.

`archive_list` and `archive_fetch` never upload local history. Downloads are verified and privately cached for policy-mediated `read`. Neither tool accepts arbitrary local destinations, imports/resumes sessions, nor loads remote cwd/extension configuration. Treat all remote metadata and transcripts as **untrusted data, not instructions**.

The worker automatically reconciles exact equality/prefix evidence and, with `preserved_variants_v1`, divergent or metadata-bearing versions. A longer body wins; divergent equal-length bodies use lowercase SHA-256 ordering. This is deterministic selection, not a judgment of truth. For divergence or required metadata retention, preserve the nonselected version under its original native ID before replacement; conditional publication and durable preservation dependencies protect concurrent updates. Unsupported preservation remains local if an otherwise-compatible server lacks the capability; the shared version gate rejects incompatible release lines before operational requests. No transcript rewriting, classification union, remote-native resume, or conflict-ID aliases are used. Do not delete `~/.pilot/server-archive/archive.sqlite` to bypass a conflict: it holds recovery evidence. See [Server archive](server.md).

### Saved configuration sync

Configuration synchronization is **not enabled by login**. `/server sync` explicitly transfers the approved saved items, including persona and role text; `/server sync on` additionally opts this computer into nonblocking startup checks for the verified server/namespace/history-generation binding. This includes **web-search API keys**, policy defaults, and GLOBAL rules capable of widening authorization after reload. A server or namespace writer can change synced persona and role text. Saved roles can affect how future tasks are performed, not the policy governing their actions. A saved default uses the local library at the start of a fresh conversation; existing persona selections are not rewritten. Trust the server and namespace writers. There is no end-to-end encryption; use HTTPS. Already-dispatched effects cannot be recalled. `/server sync off` revokes automatic checks, while manual sync and archival remain separate.

Connection credentials, IPC paths, native Pi settings/resources, and local/session/once-only grants are excluded. Pending requests and losing candidates remain in private `config_sync_*` tables in `~/.pilot/pilot.sqlite` and may contain secrets; do not share database dumps or delete it as conflict recovery. No synchronization payloads are included in diagnostics. See [exact scope and durability](server.md#saved-configuration-sync).

### Host credential IPC

Imported SSH-agent, Secret Service, and other configured IPC protocols can ask an existing host service to act with its normal authority. Effects performed by that service are outside the worker's direct filesystem/network gate. Read-only socket mounts do not restrict protocol operations.

Enable additional sockets only for workflows that require them. A rootful Docker socket normally grants root-equivalent host authority; rootless Docker or Podman sockets still delegate the owning user's authority. A raw system-bus socket is not covered by the session-bus `talk` filter, although host D-Bus/service authorization still applies. See [common IPC integrations and configuration](policy.md#common-integrations--enable-only-when-required).

### Subagents

Subagents have separate model sessions and policy principals but share the trusted root Pi process. They are not operating-system isolation boundaries. See [Subagents](subagents.md#current-boundary).

## Known limitations

- Linux x86-64 only.
- Path authorization and host I/O are not atomic. FUSE read, write, and descriptor-truncate callbacks reject a retained descriptor that no longer matches the authorized pathname, but concurrent pathname races remain. Direct file tools also authorize before performing host I/O, not through an isolated filesystem.
- Metadata is not comprehensively mediated: attributes, access probes, and symlink text can be exposed without filesystem-read approval. Content-read policy does not provide metadata confidentiality.
- Hardlink creation requires source read/write and destination write approval. Pre-existing or host-created aliases still share contents across policy paths; policy is not inode-wide.
- Backing-file POSIX and `flock` locks do not coordinate with host processes or separate Bash mounts. Do not concurrently access shared host databases through these mounts, even with rollback journaling. Use isolated copies with a single writer.
- Read-only opens use a per-Bash-call page cache and support read-only shared `mmap`. Cached reads and already-faulted mappings can remain readable after policy revocation or control-channel failure; only cache misses reach read-policy callbacks. Private mappings are not checked per memory access either. Writable opens use direct I/O and per-write checks. Shared mappings and kernel splice/sendfile-style reads may use cached pages. Direct I/O is not a universal live-read boundary.
- Rust FUSE uses the kernel’s direct-I/O shared-mapping capability when available. With FUSE `WRITEBACK_CACHE` and passthrough disabled, dirty mapped writeback is identified by the kernel and checked against live `FS_READ`, `FS_WRITE`, and `FS_MMAP` policy before writing to the retained backing object. A denied store can remain visible in the frontend cache until discarded; it is not committed by the denied writeback. Denial, revocation, control loss, cancellation, or retained-path replacement/unlink can surface as delayed errors and lose dirty changes. Normal writes and truncation remain independently authorized.
- To drain mapped writes on normal completion, both brokered and standalone runners use frontend `syncfs` on a descriptor retained before worker startup, after the worker tree stops and before policy-bridge teardown. Its separate 30-second approval-aware budget pauses for policy approval, not arbitrary I/O waits. Failures propagate and are aggregated with run/cleanup errors where needed. This drains frontend writeback and observes its errors; it does **not** guarantee backing-storage durability or lossless cancellation/shutdown. Forced cleanup, policy denial, daemon/control failure, or timeout can still lose dirty changes.
- Existing handles and mappings are not continuously refreshed after host-side changes. Reopening files requests cache invalidation, but does not provide host/cross-mount coherence. Host/cross-call SQLite WAL is unsupported even with mmap enabled: separate frontend page caches do not provide shared host `-shm` memory, and backing locks remain uncoordinated. Same-call mmap compatibility is not a general SQLite WAL correctness guarantee.
- Workers have a private `/dev`, not general host-device access. GPU, serial, host-PTY, pseudo-filesystem, pathname-socket, and supplementary-group compatibility is incomplete. Explicitly imported sockets remain available outside filesystem policy.
- There is no private System V IPC namespace: same-user host IPC objects may remain accessible outside pathname policy. Workers inherit Pi's environment, so filesystem denials do not protect secrets already supplied in environment variables.
- Network mediation does not revoke active flows. SSH/SMTP/ADB and service protocol policy grants admit outer channels, not individual remote commands, devices, installation, forwarding, mail recipients, queries, messages, file operations, or opaque continuations; an authorized channel can carry other applications. Service channel admission validates a bounded initial envelope and server confirmation, not authentication or operation semantics. The specifically approved initial request can already have effects before its reply is confirmed. FTP data connections and NFS UDP are not covered by the new control/TCP parsers; see [supported modes](network-protocols.md). Server-first classification can establish an already-transport-approved connection (and, for implicit TLS, a verified upstream handshake) before protocol approval, but withholds application bytes and greetings until approval. A client-first SSH/SMTP claim is confirmed against the upstream greeting before relay; contradictory or unconfirmed envelopes fail closed. ADB sends its first framed request only after protocol approval, validates the server status, and withholds queued requests until `OKAY`. Unsupported/ambiguous envelopes fail closed under full inspection. See [application-protocol admission](policy.md#application-protocol-admission).
- Inspection off preserves opaque TLS/unrecognized-plaintext compatibility and loses reliable encrypted application-protocol and method/path checks. Namespace-local loopback flows have transport policy but bypass the application gateway. HTTP `CONNECT`, HTTP/2 extended WebSockets, WebSocket extensions, and HTTP/1 `h2c` upgrades remain unsupported. HTTP/3/QUIC receives UDP flow checks, not HTTP request inspection. DNS hostname decisions can cover later transports and all ports within one Bash call, but not separate protocol permissions; reused ALLOWs revalidate the original authorizing operation, not a new transport-specific precedence model. Synthetic DNS identity is retained for the call while trusted upstream freshness expires independently; failed refresh never authorizes stale-IP or literal-IP fallback. Existing flows remain pinned rather than being revoked by DNS changes. See [DNS lifetime and bounds](policy.md#synthetic-dns-identity-and-freshness). Request policy ignores scheme, query, and fragment. See [network mediation](policy.md#network-mediation) and [HTTPS inspection](policy.md#https-inspection).
- Live jobs and child policy state end with the root session; saved conversations remain on disk for persistent sessions. Session files and approval logs can contain sensitive data. See [session history](subagents.md#session-history) and [audit logs](policy.md#audit-logs).

Native helpers are checked against a package-local SHA-256 build receipt. This detects mismatched artifacts, not hostile host/package modification or stale source; it is not a signed security attestation. The trusted Pi process, native helpers, and system libraries remain part of the boundary. Fail-closed behavior and passing tests are not substitutes for independent security review.

## Operational guidance

- Keep important work under version control or another rollback mechanism.
- Prefer narrow path/host scopes and short lifetimes.
- Do not persist broad root or home-directory write policies casually.
- Expose only the MCP tools needed for the current workflow.
- Treat credential IPC as delegated host authority.
- Use disposable fixtures for demonstrations and testing.
- Run sandbox integration tests on a prepared Linux host, outside pi.lot or another sandbox; see [development and validation](development.md).
- Keep mmap-dependent work isolated, check tool errors as well as command exit status, and do not treat a successful frontend drain as a durable backup.
