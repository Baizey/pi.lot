# Policy system

pi.lot uses one session-owned policy runtime for the root agent and its subagents. Policies apply to concrete filesystem or network effects, not to command names or the model's stated intent.

## Mediated surfaces

| Surface | Enforcement |
| --- | --- |
| `read` | Checks filesystem-read policy before reading a path. |
| `edit`, `write` | Check filesystem-write policy before changing a path. |
| `bash` | Runs with a FUSE-backed host filesystem and private network gate. |
| `web_search` | Uses trusted extension-side HTTP with method/URL policy checks. |
| `archive_list`, `archive_fetch` | Root-only archive reads; each host HTTP method/URL is policy-checked. List/download POSTs require `web_write`. |
| Subagents | Use principal-specific policy state and the same mediated built-ins. |

Every Bash call includes a short purpose. Bash commands start in Pi's current working directory, but that directory is not a security boundary: access elsewhere on the host is handled by the same policy runtime.

## Filesystem mediation

The Bash worker sees the host filesystem through a FUSE policy mount. Operations are evaluated as:

- filesystem read;
- filesystem write; or
- delete, which is governed by filesystem-write policy.

Multi-path operations such as rename can require approval for both paths. Direct `read`, `edit`, and `write` tool calls use the same policy runtime without launching the Bash worker.

Each Bash call has its own mount and once-only grants. Opens and native I/O callbacks check live policy and fail closed when policy control state is invalid or unavailable. Read-only opens support cached reads and read-only shared `mmap`; policy changes do **not** revoke already-cached or mapped data. Writable descriptors use direct I/O and do not support shared mappings, including those needed by SQLite WAL.

Do not concurrently access shared host databases through Bash mounts: backing-file locks do not coordinate with host processes or other calls, even with rollback journaling. Use isolated disposable copies with a single writer. Replaced or unlinked file handles can fail closed rather than retain normal POSIX behavior. A denied page-cache fill may report `EIO`; consult the policy-denial output rather than assuming a disk failure. See [filesystem limitations](security.md#known-limitations) for cache, metadata, alias, and pathname-race boundaries.

## Network mediation

The Bash worker has a private network namespace. Its command and descendants are checked for DNS resolution and IPv4/IPv6 TCP/UDP flows to hostnames or literal IPs. With full inspection enabled, supported HTTP/1 requests over TCP also receive method and canonical-URL checks, including HTTPS. UDP payloads, including QUIC, receive flow checks, not HTTP method/path inspection.

Within one Bash call, a DNS hostname decision can cover later DNS, TCP, UDP, IPv4/IPv6, and all destination ports. Literal-IP flow decisions start at an exact address and port.

The HTTP gateway observes canonical URLs, including queries, but current policy identity removes the scheme, query string, and fragment. Policy therefore cannot distinguish HTTP from HTTPS or distinguish requests only by query string.

The policy model defines SSH-, WebSocket-, gRPC-, and SMTP-specific areas, but the Bash mediator does not currently emit them. SSH and SMTP are opaque generic TCP. With full inspection enabled, the request-aware gateway rejects opaque non-HTTP protocols even when TCP policy allows them. Such workflows currently require inspection off; importing an SSH-agent socket alone does not enable Git-over-SSH. Request-aware WebSocket upgrades and HTTP/2-based gRPC are not currently supported.

`web_search` is different: it is a trusted extension operation using host-side HTTP. Its requests and redirects receive HTTP method/URL policy checks but do not traverse Bash's DNS/TCP/UDP gate.

### Archive tools versus manual commands

Root-only `archive_list` and `archive_fetch` check each actual URL and method within one tool-call policy scope before starting the HTTP timeout. GET uses `web_read`; POST list/download use **`web_write`** despite their read-only archive semantics. The API key remains host-side authentication, not policy context. Cache writes are trusted-extension bookkeeping; inspecting cached files with `read` still requires filesystem-read policy. These tools cannot upload or import/resume sessions.

`/server` status, login, logout, and `upload [current|all]` are user host-management commands, outside agent policy approval. Saved server configuration also enables automatic current-family upload on graceful session shutdown; `/server logout` disables future automatic uploads. There is no startup or periodic upload. See [Server archive](server.md) for upload contents and recovery.

## Policy areas and built-in defaults

| Policy area | Covers | Default |
| --- | --- | --- |
| `fs_read` | Filesystem reads | `allow` |
| `fs_write` | Filesystem writes and deletes | `ask_user` |
| `web_read` | HTTP access and GET | `allow` |
| `web_write` | POST, PUT, PATCH, DELETE, HEAD, OPTIONS | `ask_user` |
| `web_dns` | DNS | `ask_user` |
| `web_tcp` | Generic TCP | `ask_user` |
| `web_udp` | Generic UDP | `ask_user` |
| `web_ssh` | Reserved SSH-specific policy | `ask_user` |
| `web_websocket` | Reserved WebSocket-specific policy | `ask_user` |
| `web_grpc` | Reserved gRPC-specific policy | `ask_user` |
| `web_smtp` | Reserved SMTP-specific policy | `ask_user` |

Each area accepts one fallback:

- `allow` — allow unmatched operations;
- `deny` — reject unmatched operations;
- `ask_user` — open the interactive policy flow; or
- `ask_llm` — ask a separate structured policy-review model.

The `ask_llm` reviewer receives bounded operation and task context and only a structured decision tool. It can create `ONCE` or `SESSION` decisions, never durable policy. Missing, malformed, stale, cancelled, or timed-out reviews fail closed.

## Configure defaults

Show current values:

```text
/policy-defaults
```

Change one area or every area:

```text
/policy-defaults allow fs_read
/policy-defaults ask_user fs_write
/policy-defaults ask_llm web_read
/policy-defaults deny web_tcp
/policy-defaults ask_user all
```

Persist the active values or reload the persisted values:

```text
/policy-defaults save
/policy-defaults reset
```

Changes affect this session until saved to `~/.pilot/policy-defaults.json`. `reset` reloads that file, or the built-in values if it is absent; it does not clear explicit rules. Defaults only govern unmatched operations, so changing a default does not override an existing denial.

## Interactive approvals

An interactive policy miss asks for:

1. a path or network scope;
2. allow or deny;
3. a lifetime; and
4. an optional reason when denying.

In the terminal, **Tab** opens the full command and request ancestry; **Up/Down** scroll that view and **Tab** returns. On select steps, **Right** allows once and **Left** denies once for the **exact requested target**, regardless of a broader highlighted scope. They finish only the current request. **PageDown/PageUp** are allow-once/deny-once aliases, not detail-view scrolling. **Enter** selects; **Escape** cancels with a once-only denial. Follow the displayed hints if keybindings are customized. RPC dialogs include request context as plain text.

Lifetimes are:

- **Once** — the current tool call;
- **This session** — the active root Pi session; and
- **Always on this computer** — persisted locally.

Network prompts also expose **Always synchronized**, but this is local persistence only: `GLOBAL` uses the same database as `LOCAL`, with no synchronization.

More-specific path and network scopes take precedence over broader scopes. Persisted rules live in `~/.pilot/pilot.sqlite`.

Only the literal hostname `localhost` has a portless all-port scope: `localhost:3000` covers one port, while `localhost` covers all ports. Explicit ports remain exact, path restrictions apply, and more-specific port rules take precedence. This does not alias `127.0.0.1`, `0.0.0.0`, or `::1` to `localhost`. Other hostname/IP scopes require matching ports; there is no `:*` syntax.

## Agent authority and approvals

Every agent is a separate policy principal. Policy-area capabilities selected at subagent spawn snapshot the parent's effective rules for those areas; omitting an area leaves it available for later policy requests, not permanently denied. MCP and delegation are separate hard grants that cannot be requested later. See [Subagent capabilities](subagents.md#capability-model).

When a child requests an operation it does not hold:

- a matching explicit denial is terminal;
- a covering allow held by an ancestor can authorize a bounded policy-review agent; or
- without ancestor authority, the root fallback selects allow, deny, user review, or model review.

A derived approval cannot exceed the ancestor's scope or lifetime. Session grants are installed only along the requesting ancestry and do not leak to siblings.

## Approval waits and execution budgets

User and model approval waits—including ancestor-authority review and `ask_llm`—pause Bash's configured timeout, subagent turn budgets, finite codemode timeouts, and `subagent_status` waits for selected jobs. Each resumes with its previous remainder after its last pending approval; approvals do not reset budgets. Ordinary policy lookups do not pause them.

Approvals have their own independent deadlines:

- **User approval: 300 seconds per request**, starting when it enters the user approval route. Time queued behind other prompts and every scope, decision, lifetime, and reason step share this single budget. Opening a prompt or moving to another step does not restart it.
- **Model approval: 300 seconds per review**, including reviewer setup and prompting. Pausing the source does not pause this reviewer watchdog.

Expiry fails the pending operation closed and installs no policy grant. Late replies cannot authorize an expired request. Explicit cancellation and shutdown still work while execution budgets are paused. A queued request rechecks policy before opening its prompt, so a covering decision from earlier queued work can resolve it without asking again.

This is execution-budget accounting, not suspension of the whole process. Other work can continue, and independent transport, application, subprocess, or server deadlines are not extended. In particular, a network request or a program's own timeout can still fail during an approval wait. Background descendants do not automatically pause their ancestors; see [Subagent turn and wait budgets](subagents.md#turn-and-wait-budgets).

### Finite codemode timeouts

A finite codemode `timeout_ms` is an approval-aware execution budget; output limits still apply. Omitting `timeout_ms` means no execution timeout.

The budget includes time queued for a worker and initialization; admission does not reset the remaining budget. Queueing itself is not a policy approval wait. Expiry requests worker interruption and cancels nested tools, but cancellation is cooperative: a worker or host operation may outlive the tool response, and completed effects are not undone.

Pi 1.4 defaults to two live codemode workers across all sessions in one Pi process, shared by root and child sessions. `PI_CODEMODE_MAX_WORKERS` accepts a positive integer to change the limit. A cancelled worker keeps its slot until it actually exits. At capacity, new scripts queue in arrival order instead of failing immediately.

Worker admission has an independent 60-second wait limit, including when `timeout_ms` is omitted or its execution budget is paused for an originating policy approval. A shorter finite execution budget or explicit cancellation can end the wait sooner. Expired or cancelled waiters do not start their scripts or nested tools.

A parent script waiting on a child still occupies a worker, so queuing does not eliminate dependency stalls when all workers are waiting on children that also need codemode. Prefer issuing subagent spawn/status tools outside a long-lived script when possible, or configure enough workers for the intended concurrent scripts. This is a worker limit, not a limit on the number of retained subagents.

## Audit logs

User, ancestor-authority, and `ask_llm` approval outcomes are appended as JSON lines under:

```text
~/.pilot/logs/<session-id>.log
```

Records include requester ancestry, operation, command/purpose, authority route, selected scope/lifetime, reason, and result. The directory and files use user-only permissions, but their contents may be sensitive. They are approval logs, not a record of every allowed filesystem or network effect.

For a denial, inspect its reason and resolution source. A `SYSTEM` block can mean a configured fallback or a fail-closed runtime safeguard, not an OS permission error or an expired user approval. Diagnose that reason rather than retrying through another tool or assuming new approval will fix it.

## HTTPS inspection

Every session starts with full network inspection enabled. For supported clients, pi.lot:

1. creates a per-run CA and read-only trust artifacts;
2. terminates client TLS in the trusted gateway;
3. independently verifies the upstream certificate; and
4. evaluates each supported HTTP request before opening the upstream connection.

Show or change the session setting:

```text
/network-inspection
/network-inspection off
/network-inspection on
```

With inspection off, HTTPS stays end-to-end. DNS and TCP hostname/port policy still applies, but method/path policy is unavailable. Use this compatibility mode for certificate-pinned clients, private trust stores, and unsupported TLS stacks.

## Host credential IPC

The worker inherits Pi's environment and sees ordinary credential files through filesystem policy. Selected host-service sockets are imported outside that gate. Configuration is loaded when the session runtime starts; restart or reload Pi after changing it.

Without `~/.pilot/credential-ipc.json`, the defaults are:

- filtered session D-Bus access to `org.freedesktop.secrets`, when Pi inherits `DBUS_SESSION_BUS_ADDRESS`; and
- a read-only mount of the socket named by `SSH_AUTH_SOCK`, when present.

### Common integrations — enable only when required

Keep only the integrations your workflow needs. Docker, GPG, Podman, and the system bus are **not enabled by default**.

| Integration | When needed | Configuration |
| --- | --- | --- |
| Secret Service (default) | Credential helpers that use a desktop keyring, such as GNOME Keyring or a compatible KWallet setup. | Keep `org.freedesktop.secrets` in `sessionBus.talk`. |
| SSH agent (default) | SSH or Git-over-SSH authentication using keys held by an existing agent. | Keep `"environment": "SSH_AUTH_SOCK"`. |
| GPG agent | GPG signing, including signed Git commits, using an existing host agent. | Add a socket with `"path"` set to the output of `gpgconf --list-dirs agent-socket` on the host. |
| Docker | Docker CLI, Compose, or tests that require a local Docker daemon. | Add `"path": "/var/run/docker.sock"`, or the Unix-socket path used by your Docker context. Rootless Docker commonly uses `${XDG_RUNTIME_DIR}/docker.sock`. |
| Rootless Podman API | Docker-compatible tools or remote clients using Podman's API; not needed merely to run the local Podman CLI. | Add `"path": "${XDG_RUNTIME_DIR}/podman/podman.sock"` when the host API socket is available. |
| System D-Bus | Tools that must talk to host system services, such as systemd or NetworkManager, over the system bus. | Add `"path": "/run/dbus/system_bus_socket"` only when that access is required. |

> [!WARNING]
> A read-only socket mount does **not** make its protocol read-only. Imported services can sign, access credentials, or perform host effects outside pi.lot policy. Container sockets can delegate broad host authority; raw system-bus access is not filtered by `sessionBus.talk`. See [Host credential IPC security](security.md#host-credential-ipc).

### Example: retain defaults and add Docker

`~/.pilot/credential-ipc.json` **replaces**, rather than merges with, the defaults. This example retains Secret Service and SSH-agent access and adds Docker; use it only when the workflow requires that authority.

```json
{
  "version": 1,
  "sessionBus": {
    "enabled": true,
    "talk": ["org.freedesktop.secrets"]
  },
  "unixSockets": [
    {
      "id": "ssh-agent",
      "environment": "SSH_AUTH_SOCK",
      "optional": true
    },
    {
      "id": "docker",
      "path": "/var/run/docker.sock",
      "optional": true
    }
  ]
}
```

### Configuration details

- Use `version: 1`, a `sessionBus` object, and a `unixSockets` array. Unknown fields are rejected.
- Each socket needs a unique `id` containing only letters, digits, `_`, or `-`, and exactly one of `environment` or `path`.
- `environment` names a variable inherited by Pi whose value is an absolute socket pathname, such as `SSH_AUTH_SOCK`. It is not a URI: do not use `DOCKER_HOST` when its value is `unix:///...`; configure that socket with `path` instead.
- `path` must resolve to an absolute pathname. Templates support only explicit `${VARIABLE}` expansion from Pi's environment, not `~`, `$VARIABLE`, or shell commands. An unset template variable is a configuration error even with `optional: true`.
- `optional` defaults to `true`: missing socket paths or an unset `environment` source are skipped. It does **not** make access conditional on a later approval; an available configured socket is imported. Permission errors and non-socket paths are still reported.
- A socket entry can use `enabled: false` to omit it, but it must still be valid, including any path-template expansion. Use `sessionBus.enabled: false` to disable the session-bus proxy. Prefer specific names in `sessionBus.talk` over broad wildcards.
- Passthrough does not start the host service or grant missing host permissions. For a non-default container socket, also point the client at it using its context or, for Docker-compatible clients, `DOCKER_HOST=unix:///absolute/socket/path`.

To disable all configured IPC passthrough explicitly:

```json
{
  "version": 1,
  "sessionBus": {"enabled": false, "talk": []},
  "unixSockets": []
}
```

Deleting the configuration file restores the defaults; it does not disable IPC.

## Boundaries

Policy mediation is not complete host isolation. MCP, imported host-service IPC, root codemode model calls, and server management/uploads have effects outside agent filesystem/network approval. Read [Security model and limitations](security.md) before relying on the boundary.
