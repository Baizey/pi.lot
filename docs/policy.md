# Policy system

pi.lot uses one session-owned policy runtime for the root agent and its subagents. Policies apply to concrete filesystem or network effects, not to command names or the model's stated intent.

## Mediated surfaces

| Surface | Enforcement |
| --- | --- |
| `read` | Checks filesystem-read policy before reading a path. |
| `edit`, `write` | Check filesystem-write policy before changing a path. |
| `bash` | Runs with a FUSE-backed host filesystem and private network gate. |
| `web_search` | Uses trusted extension-side HTTP with method/URL policy checks. |
| Subagents | Use principal-specific policy state and the same mediated built-ins. |

Every Bash call includes a short purpose. Bash commands start in Pi's current working directory, but that directory is not a security boundary: access elsewhere on the host is handled by the same policy runtime.

## Filesystem mediation

The Bash worker sees the host filesystem through a FUSE policy mount. Operations are evaluated as:

- filesystem read;
- filesystem write; or
- delete, which is governed by filesystem-write policy.

Multi-path operations such as rename can require approval for both paths. Direct `read`, `edit`, and `write` tool calls use the same policy runtime without launching the Bash worker.

One native FUSE broker lives for the Pi session. Each policy principal has one immutable, revisioned base checkpoint shared by that principal's active Bash calls; each Bash call has a separate mount and a private revisioned `ONCE` overlay. Native callbacks perform a fresh lookup against the base and overlay. Misses return to the JavaScript policy runtime, and malformed, stale, disconnected, or unresolved control state fails closed.

## Network mediation

The Bash worker has a private network namespace. pi.lot evaluates effects produced by the command and its descendants across:

- DNS resolution;
- IPv4 and IPv6 TCP/UDP flows;
- hostname and literal-IP targets;
- supported HTTP/1 methods and canonical paths; and
- supported HTTPS methods and paths when full inspection is enabled.

The current per-command projector deliberately reuses an approved hostname decision across DNS, TCP, UDP, IPv4, IPv6, and destination ports for the remainder of that Bash call. Literal-IP decisions begin at an exact address and port.

The HTTP gateway observes canonical URLs, including queries, but current policy identity removes the scheme, query string, and fragment. Policy therefore cannot distinguish HTTP from HTTPS or distinguish requests only by query string.

The policy model defines SSH-, WebSocket-, gRPC-, and SMTP-specific areas, but the Bash mediator does not currently emit them. SSH and SMTP are opaque generic TCP. Request-aware WebSocket upgrades and HTTP/2-based gRPC are not currently supported.

`web_search` is different: it is a trusted extension operation using host-side HTTP. Its requests and redirects receive HTTP method/URL policy checks but do not traverse Bash's DNS/TCP/UDP gate.

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

Lifetimes are:

- **Once** — the current tool call;
- **This session** — the active root Pi session; and
- **Always on this computer** — persisted locally.

Network prompts also expose **Always synchronised**, but synchronised policy is not implemented. `GLOBAL` currently persists in the same local database as `LOCAL`.

More-specific path and network scopes take precedence over broader scopes. Persisted rules live in `~/.pilot/pilot.sqlite`.

## Agent authority and approvals

Every agent is a separate policy principal. Policy-area capabilities selected at subagent spawn snapshot the parent's effective rules for those areas. See [Subagent capabilities](subagents.md#capability-model).

When a child requests an operation it does not hold:

- a matching explicit denial is terminal;
- a covering allow held by an ancestor can authorize a bounded policy-review agent; or
- without ancestor authority, the root fallback selects allow, deny, user review, or model review.

A derived approval cannot exceed the ancestor's scope or lifetime. Session grants are installed only along the requesting ancestry and do not leak to siblings.

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

Defaults:

- filtered session D-Bus access to `org.freedesktop.secrets`; and
- a read-only mount of the socket named by `SSH_AUTH_SOCK`, when present.

Create `~/.pilot/credential-ipc.json` to replace those defaults. Repeat the defaults if you want to keep them while adding another socket:

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
      "id": "gpg-agent",
      "path": "${XDG_RUNTIME_DIR}/gnupg/S.gpg-agent",
      "optional": true
    }
  ]
}
```

Path templates support only explicit `${VARIABLE}` expansion. A read-only socket mount does not make the service protocol read-only: a client can still ask an imported SSH agent to sign, or ask another service to exercise its normal authority.

## Boundaries

Policy mediation is not complete host isolation. In particular, MCP and preserved host-service IPC can perform effects outside the Bash filesystem/network gate. Read [Security model and limitations](security.md) before relying on the boundary.
