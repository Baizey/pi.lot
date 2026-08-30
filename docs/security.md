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
- `web_search` uses policy-checked extension-side HTTP.
- Subagents have principal-specific policy state.

See [Policy system](policy.md) for exact semantics.

## Explicit boundaries outside mediation

### MCP

MCP stdio servers run as host processes and MCP HTTP transports use the host network. MCP tool effects are not inspected by filesystem or network policy. See [MCP security boundary](mcp.md#security-boundary).

### Host credential IPC

Imported SSH-agent, Secret Service, and other configured IPC protocols can ask an existing host service to act with its normal authority. Effects performed by that service are outside the worker's direct filesystem/network gate.

### Subagents

Subagents have separate model sessions and policy principals but share the trusted root Pi process. They are not operating-system isolation boundaries. See [Subagents](subagents.md#current-boundary).

## Known limitations

- Linux x86-64 only.
- Host-side FUSE path resolution has pathname time-of-check/time-of-use race windows.
- Versioned live policy replacement and active filesystem/network-flow revocation are not implemented.
- The combined worker's `/dev`, pseudo-filesystem, pathname-socket, and supplementary-group compatibility is incomplete.
- Some DNS, UDP lifecycle, IPv6, HTTP/2, HTTP/3/QUIC, WebSocket, `CONNECT`, private-trust-store, and certificate-pinning behaviour is unsupported or fails closed.
- Request policy cannot currently distinguish HTTP from HTTPS, query strings, or fragments.
- A hostname approval is reused across DNS, TCP, UDP, address families, and ports for the remainder of one Bash call.
- `GLOBAL` network-policy lifetime is not synchronised and currently persists in the same local database as `LOCAL`.
- The keyless DuckDuckGo backend depends on a public HTML format that may change.
- Jobs and subagent conversations are not persisted across root-session shutdown.

Unsupported, malformed, cancelled, or incomplete mediated operations are intended to fail closed. That intent is not a substitute for a published threat model, parser fuzzing, independent review, or a security audit.

## Operational guidance

- Keep important work under version control or another rollback mechanism.
- Prefer narrow path/host scopes and short lifetimes.
- Do not persist broad root or home-directory write policies casually.
- Expose only the MCP tools needed for the current workflow.
- Treat credential IPC as delegated host authority.
- Use disposable fixtures for demonstrations and testing.
- Run sandbox integration tests directly on a prepared host, not inside another sandbox.
