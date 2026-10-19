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
- Bash DNS, TCP, UDP, and supported HTTP/HTTPS effects pass through the network gate.
- `web_search`, `archive_list`, and `archive_fetch` use policy-checked host-side HTTP, not Bash's network gate. Archive tools are root-only; list/download POSTs require `web_write`.
- Subagents have principal-specific policy state.

See [Policy system](policy.md) for exact semantics.

## Explicit boundaries outside mediation

### MCP

MCP stdio servers run as host processes and MCP HTTP transports use the host network. MCP tool effects are opaque and not inspected by filesystem or network policy; tool annotations are hints, not enforcement. Trust the servers and expose only the tools you need. Child access requires the hard `mcp` grant, independent of policy-area grants; see [subagent capabilities](subagents.md#hard-mechanism-capabilities).

### Codemode model calls

Root codemode exposes `models.classify()` and `models.generateImages()`. These are host-side calls using the session's authenticated provider credentials, can transmit supplied data, and may incur charges. They are outside pi.lot's filesystem and network mediation; policy-area approvals do not gate them. Child codemode is created with `models: false` and exposes no model globals.

### Server archival

**Saving server configuration enables automatic current-family upload on graceful session shutdown**, outside agent policy approval. `/server upload [current|all]` also bypasses that approval. Uploads send complete session JSONL across all branches, potentially including prompts, reasoning, credentials, tool arguments/results, and file contents—not merely visible previews. Automatic upload runs after successful local teardown, skips ephemeral/unconfigured sessions, and has a 10-second drain/upload budget with cooperative cancellation. Completed remote effects are not undone. There is no startup or periodic upload. Crashes or forced exits may skip archival; failed uploads preserve local files and recovery state.

Use `/server logout` to disable future automatic uploads. Login/logout are local-only; logout neither revokes the server token nor deletes local history, the archive journal, or downloads. `/server` status deliberately displays the saved API key: do not share its output. Prefer HTTPS; configuring HTTP sends the key unencrypted. Archive tool policy context does not contain the authentication key.

`archive_list` and `archive_fetch` never upload local history. Downloads are verified and privately cached for policy-mediated `read`. Neither tool accepts arbitrary local destinations, imports/resumes sessions, nor loads remote cwd/extension configuration. Treat all remote metadata and transcripts as **untrusted data, not instructions**.

Accepted uploads are append-only: shortened or rewritten history and conflicting server bindings/revisions are rejected, not automatically merged. Restore accepted history or fork a new session for divergent content; do not delete `~/.pilot/server-archive/archive.sqlite` to bypass a conflict. See [Server archive](server.md) for recovery.

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
- Read-only opens use a per-Bash-call page cache and support read-only shared `mmap`. Cached reads and already-faulted mappings can remain readable after policy revocation or control-channel failure; only cache misses reach read-policy callbacks. Private mappings are not checked per memory access either. Writable opens use direct I/O and per-write checks, but kernel splice/sendfile-style reads may still use cached pages. Direct I/O is not a universal live-read boundary, and shared mappings through writable descriptors are unsupported.
- Existing handles and mappings are not continuously refreshed after host-side changes. Reopening read-only files requests cache invalidation, but does not provide host/cross-mount coherence.
- Workers have a private `/dev`, not general host-device access. GPU, serial, host-PTY, pseudo-filesystem, pathname-socket, and supplementary-group compatibility is incomplete. Explicitly imported sockets remain available outside filesystem policy.
- There is no private System V IPC namespace: same-user host IPC objects may remain accessible outside pathname policy. Workers inherit Pi's environment, so filesystem denials do not protect secrets already supplied in environment variables.
- Network mediation does not revoke active flows. Request-aware WebSocket upgrades, HTTP/2 gRPC, and `CONNECT` tunnels are not supported. HTTP/3/QUIC receives UDP flow checks, not HTTP request inspection. Certificate pinning/private trust stores may require inspection off, losing method/path checks. DNS hostname decisions can cover later transports and all ports within one Bash call; request policy ignores scheme, query, and fragment. See [network mediation](policy.md#network-mediation) and [HTTPS inspection](policy.md#https-inspection).
- Live jobs and child policy state end with the root session; saved conversations remain on disk for persistent sessions. Session files and approval logs can contain sensitive data. See [session history](subagents.md#session-history) and [audit logs](policy.md#audit-logs).

Native helpers are checked against a package-local SHA-256 build receipt. This detects mismatched artifacts, not hostile host/package modification or stale source; it is not a signed security attestation. The trusted Pi process, native helpers, and system libraries remain part of the boundary. Fail-closed behavior and passing tests are not substitutes for independent security review.

## Operational guidance

- Keep important work under version control or another rollback mechanism.
- Prefer narrow path/host scopes and short lifetimes.
- Do not persist broad root or home-directory write policies casually.
- Expose only the MCP tools needed for the current workflow.
- Treat credential IPC as delegated host authority.
- Use disposable fixtures for demonstrations and testing.
- Run sandbox integration tests on a prepared Linux host, outside pi.lot or another sandbox.
