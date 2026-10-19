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

One native FUSE broker lives for the Pi session. Each policy principal has one immutable, revisioned base checkpoint shared by that principal's active Bash calls; each Bash call has a separate mount and a private revisioned `ONCE` overlay. Native callbacks perform a fresh lookup against the base and overlay. Misses return to the JavaScript policy runtime, and malformed, stale, disconnected, or unresolved control state fails closed at those checkpoints.

Opens are authorized before returning a usable handle. Read-only opens then enable cached reads and read-only shared `mmap`; cache misses still pass through native read-policy checks, but cache hits and already-faulted mappings do not. Changing policy does not revoke data already cached or mapped during that Bash call. Each call has its own FUSE page cache, shared by that call's processes, not by other calls or agents. Read-only opens request cache invalidation rather than preserving data from previous opens; this does not continuously refresh existing handles when the host file changes. Writable opens retain direct I/O so reads and writes through those descriptors reach native policy callbacks; shared mappings through writable descriptors remain unsupported, even when the mapping itself is read-only. SQLite WAL normally requires a writable shared-memory mapping; disabling database read-mmap with `PRAGMA mmap_size=0` does not remove that requirement.

Read, write, and descriptor-truncate callbacks reject a retained descriptor whose device/inode no longer matches the authorized pathname. Replaced or unlinked handles can therefore fail closed instead of preserving normal POSIX descriptor behavior. Creating hardlinks requires source read/write and destination write approval; pre-existing aliases and concurrent pathname races remain limitations.

Backing-file locks are not forwarded to host processes or other Bash-call mounts. Concurrently sharing host databases through these mounts is unsafe, including with rollback journaling. Prefer isolated disposable copies with a single writer until backing-lock coordination is implemented.

A denied page-cache fill can surface to the caller as `EIO` rather than the native callback's `EACCES`. Native policy-denial reports still identify the rejected read; new-open denials retain `EACCES`.

## Network mediation

The Bash worker has a private network namespace. pi.lot evaluates effects produced by the command and its descendants across:

- DNS resolution;
- IPv4 and IPv6 TCP/UDP flows;
- hostname and literal-IP targets;
- supported HTTP/1 methods and canonical paths; and
- supported HTTPS methods and paths when full inspection is enabled.

The current per-command projector deliberately reuses an approved hostname decision across DNS, TCP, UDP, IPv4, IPv6, and destination ports for the remainder of that Bash call. Literal-IP decisions begin at an exact address and port.

The HTTP gateway observes canonical URLs, including queries, but current policy identity removes the scheme, query string, and fragment. Policy therefore cannot distinguish HTTP from HTTPS or distinguish requests only by query string.

The policy model defines SSH-, WebSocket-, gRPC-, and SMTP-specific areas, but the Bash mediator does not currently emit them. SSH and SMTP are opaque generic TCP. With full inspection enabled, the request-aware gateway rejects opaque non-HTTP protocols even when TCP policy allows them. Such workflows currently require inspection off; importing an SSH-agent socket alone does not enable Git-over-SSH. Request-aware WebSocket upgrades and HTTP/2-based gRPC are not currently supported.

`web_search` is different: it is a trusted extension operation using host-side HTTP. Its requests and redirects receive HTTP method/URL policy checks but do not traverse Bash's DNS/TCP/UDP gate.

### Archive tools versus manual commands

`archive_list` and `archive_fetch` begin one policy tool-call scope using the invoking root session principal. Each request checks its actual URL and method before HTTP starts; the API key is only host-client authentication metadata, not policy context. Authorization completes before the request timeout starts. The protocol's GET binding uses `web_read`, while POST list/download use **`web_write`** despite read-only archive semantics. No silent semantic-read bypass or Bash DNS/TCP traversal applies. Download/list-page cache writes are private trusted-extension bookkeeping, not arbitrary model-selected filesystem writes; subsequent `read` calls use normal filesystem policy.

`/server upload [current|all]`, login, logout, and status are explicit user host-management commands, not model tools, and do not ask the agent policy runtime. Saved server configuration also enables automatic current-family upload on graceful session shutdown, outside agent policy approval; `/server logout` disables future automatic uploads. There is no startup or periodic upload. Archive tools are not given to children and cannot upload or automatically import/resume sessions. See [Server archive](server.md).

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
- `ask_llm` — ask a separate ephemeral policy-review model.

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

Saved defaults live in `~/.pilot/policy-defaults.json`. Without that file, reset restores the built-in values.

## Interactive approvals

An interactive policy miss asks for:

1. a path or network scope;
2. allow or deny;
3. a lifetime; and
4. an optional reason when denying.

Terminal prompts separate the step heading, operation and target, selected scope/decision, and originating tool context. Long values wrap; the choice list stays bounded and follows the selection. **Tab** opens the full request, including the command, request/tool-call IDs, and ordered agent ancestry. Use **Up/Down** to scroll that view and **Tab** to return to the choices without changing the selection. The displayed hints follow configured keybindings.

On select steps, **Right** allows once and **Left** denies once for the **exact requested target**, even when a broader scope is highlighted or was selected earlier. These shortcuts finish the current approval, not all queued requests. **PageUp/PageDown** retain the deny-once/allow-once aliases; they do not scroll the full request. **Enter** selects the highlighted choice; **Escape** cancels with a once-only denial. RPC clients continue to receive ordinary select/input dialogs with the request context included as plain text.

Lifetimes are:

- **Once** — the current tool call;
- **This session** — the active root Pi session; and
- **Always on this computer** — persisted locally.

Network prompts also expose **Always synchronised**, but synchronised policy is not implemented. `GLOBAL` currently persists in the same local database as `LOCAL`.

More-specific path and network scopes take precedence over broader scopes. Persisted rules live in `~/.pilot/pilot.sqlite`.

For the literal hostname `localhost`, a scope without a port covers every port. An approval for `localhost:3000` therefore offers both `localhost:3000` (one port) and `localhost` (all ports). Explicit ports remain exact, path restrictions still apply, and more-specific port rules override a broader `localhost` rule. This meaning also applies to existing saved portless `localhost` policies.

This is only a policy-matching rule: it does not alias IP addresses to `localhost`. IPv4, IPv6, and other hostname scopes retain their existing exact-port matching; `127.0.0.1`, `0.0.0.0`, and `::1` do not gain all-port coverage. No `:*` syntax is supported. Access types and lifetimes are unchanged.

## Agent authority and approvals

Every agent is a separate policy principal. Policy-area capabilities selected at subagent spawn snapshot the parent's effective rules for those areas. See [Subagent capabilities](subagents.md#capability-model).

When a child requests an operation it does not hold:

- a matching explicit denial is terminal;
- a covering allow held by an ancestor can authorize a bounded policy-review agent; or
- without ancestor authority, the root fallback selects allow, deny, user review, or model review.

A derived approval cannot exceed the ancestor's scope or lifetime. Session grants are installed only along the requesting ancestry and do not leak to siblings.

## Approval waits and execution budgets

Actual user and model approval waits pause the originating operation's execution budget. This includes ancestor-authority reviews and the `ask_llm` fallback, not just interactive prompts. Covered budgets include Bash's configured timeout, subagent turn deadlines, finite codemode execution timeouts, and `subagent_status` waits for selected jobs. The budget resumes with the time it had left; approval does not reset it. Overlapping approvals keep the source paused until the last pending approval finishes. Ordinary policy lookups and already-authorized operations do not pause these clocks.

Approvals have their own independent deadlines:

- **User approval: 300 seconds per request**, starting when it enters the user approval route. Time queued behind other prompts and every scope, decision, lifetime, and reason step share this single budget. Opening a prompt or moving to another step does not restart it.
- **Model approval: 300 seconds per review**, including reviewer setup and prompting. Pausing the source does not pause this reviewer watchdog.

Expiry fails the pending operation closed and installs no policy grant. Late replies cannot authorize an expired request. Explicit cancellation and shutdown still work while execution budgets are paused. A queued request rechecks policy before opening its prompt, so a covering decision from earlier queued work can resolve it without asking again.

This is execution-budget accounting, not suspension of the whole process. Other work can continue, and independent transport, application, subprocess, or server deadlines are not extended. In particular, a network request or a program's own timeout can still fail during an approval wait. Background descendants do not automatically pause their ancestors; see [Subagent turn and wait budgets](subagents.md#turn-and-wait-budgets).

### Finite codemode timeouts

When a codemode script specifies a finite native `timeout_ms` option, Pilot moves that timeout to an approval-aware outer execution budget and retains the other native options, including output limits. Omitting `timeout_ms` keeps native no-timeout behavior. The script API, discovery, tool exposure, and storage remain native-owned.

The public native execution API has no VM-start or finalization hooks: the outer budget includes initialization and can fire during work after the VM has already finalized. It requests interruption and termination of the native script's worker VM through the public abort signal, including for a script spinning without tool calls. The call can settle before the worker actually exits; on Bun, a built-in that does not poll QuickJS's interrupt handler can keep computing until it returns. Host-side tool effects remain cooperatively cancellable: non-cooperating work may continue, and effects already performed are not undone. A finalized success is not retroactively converted into a timeout. Ordinary inline native abort errors caused by this budget are labelled as timeouts; native-owned spilled output can still say `Script aborted` with the timeout reason. Parent cancellation is not relabelled as a script timeout.

Pi 1.3 permits at most two live codemode workers across all sessions in one Pi process, shared by root and child sessions. A cancelled worker keeps its slot until it exits. At capacity, another script fails immediately without starting; retry only after an existing worker exits. A parent script waiting on a child still occupies a worker, so delegation from scripts can exhaust this shared capacity. This is a worker limit, not a limit on the number of retained subagents.

## Audit logs

User, ancestor-authority, and `ask_llm` approval outcomes are appended as JSON lines under:

```text
~/.pilot/logs/<session-id>.log
```

Records contain the requester and ancestry, operation, originating tool context, authority route, selected scope and lifetime, reason, and terminal result. The directory and files are created with user-only permissions.

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

The worker inherits Pi's environment and sees ordinary credential files through filesystem policy. Some live credential sockets cannot pass through FUSE by pathname, so pi.lot preserves selected protocols explicitly.

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
> A read-only socket mount does **not** make the service protocol read-only. Clients can ask an SSH/GPG agent to sign or a container daemon to create containers and mount host files. A rootful Docker socket normally grants root-equivalent host authority; rootless container sockets still delegate the owning user's authority. The system-bus socket is raw passthrough, **not** filtered by `sessionBus.talk`; host D-Bus/service authorization still applies. Service-side effects bypass pi.lot's filesystem/network gate. See [Host credential IPC security](security.md#host-credential-ipc).

### Example: defaults plus Docker and system D-Bus

Create `~/.pilot/credential-ipc.json` to **replace**, not merge with, the defaults. This example retains Secret Service and SSH-agent access and adds Docker and system D-Bus. Remove either added socket unless your workflow requires it; this is not a recommended blanket configuration.

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
    },
    {
      "id": "system-bus",
      "path": "/run/dbus/system_bus_socket",
      "optional": true
    }
  ]
}
```

For GPG, add an entry like this to `unixSockets` **only if** the path matches `gpgconf --list-dirs agent-socket` on your host; otherwise use that command's absolute path:

```json
{
  "id": "gpg-agent",
  "path": "${XDG_RUNTIME_DIR}/gnupg/S.gpg-agent",
  "optional": true
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

Policy mediation is not complete host isolation. In particular, MCP and preserved host-service IPC can perform effects outside the Bash filesystem/network gate. Root codemode's `models.classify()` and `models.generateImages()` are authenticated, potentially billable host-side calls outside filesystem/network mediation, not policy-gated tool calls. Child codemode uses `models: false` and exposes no model globals. Read [Security model and limitations](security.md) before relying on the boundary.
