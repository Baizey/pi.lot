# MCP

pi.lot supports MCP servers over **stdio** and **Streamable HTTP**. It connects servers, discovers their tools, and registers only explicitly exposed tools with Pi.

> [!WARNING]
> MCP is an explicit host capability outside pi.lot's filesystem and network mediation. Expose only trusted servers and the minimum tools required.

## Configuration file

MCP configuration lives at:

```text
~/.pilot/mcp.json
```

Tools are unexposed by default. A server may connect and advertise tools without making them callable by the model.

Example:

```json
{
  "servers": {
    "local": {
      "transport": "stdio",
      "command": "my-mcp-server",
      "args": [],
      "env": {},
      "enabled": true,
      "autoConnect": true,
      "tools": {
        "expose": ["read_resource"],
        "hide": []
      }
    },
    "remote": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer replace-me"
      },
      "enabled": true,
      "autoConnect": true,
      "tools": {
        "expose": []
      }
    }
  }
}
```

Protect the file when it contains credentials:

```bash
chmod 600 ~/.pilot/mcp.json
```

## Server settings

Common settings:

| Field | Meaning | Default |
| --- | --- | --- |
| `enabled` | Whether the server can be used | `true` |
| `autoConnect` | Connect when a Pi session starts | `true` |
| `tools.expose` | Tool names to register; `*` means all | none |
| `tools.hide` | Tool names to block; `*` means all | none |
| `connectTimeoutMs` | Connection timeout | 15 seconds |
| `listToolsTimeoutMs` | Tool-discovery timeout | 15 seconds |
| `toolTimeoutMs` | Tool-call inactivity timeout | 60 seconds |
| `toolMaxTotalTimeoutMs` | Maximum total tool-call time | 5 minutes |

Stdio servers additionally accept:

- `command` — required executable;
- `args` — argument array;
- `cwd` — optional working directory; and
- `env` — additional environment values.

HTTP servers additionally accept:

- `url` — required HTTP(S) endpoint; and
- `headers` — request headers.

Invalid server entries are ignored by the sanitising loader. Use `/mcp show` after editing to verify what was accepted.

## Runtime commands

```text
/mcp
/mcp show [all|server]
/mcp connect [all|server]
/mcp disconnect [all|server]
/mcp refresh [all|server]
/mcp expose <server> <tool...|*>
/mcp hide <server> <tool...|*>
/mcp reset <server> [tool...|*]
```

`/mcp expose`, `/mcp hide`, and `/mcp reset` persist exposure changes to `~/.pilot/mcp.json`.

Exposed tools receive Pi-safe names derived from server and tool names, for example:

```text
mcp_local_read_resource
```

Name collisions are resolved deterministically.

## Exposure behaviour

- `hide` takes precedence over `expose`.
- `*` exposes or hides all discovered tools.
- Hiding an already registered tool blocks calls immediately.
- A hidden tool can remain visible in the current model's tool list until `/reload` or a new session.
- Exposing a newly discovered tool registers it dynamically in the active session.

## Subagents

A child receives currently exposed MCP definitions only when spawned with the hard `mcp` capability. Nested children cannot receive MCP unless their immediate parent already has it.

MCP access is independent of policy-area snapshots. An MCP server or tool does not become filesystem/network mediated merely because the caller also has `fs_*` or `web_*` capabilities.

See [Subagent capabilities](subagents.md#capability-model).

## Security boundary

- Stdio servers run as ordinary host processes.
- HTTP transports use the host network.
- MCP tools may read, write, execute, or access services outside Pilot's policy runtime.
- Tool annotations such as read-only or destructive hints are metadata, not enforcement.
- Secrets placed in `headers` or `env` are available to the configured server.

See [Security model and limitations](security.md).
