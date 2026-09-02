# pi.lot

**Policy-controlled tools, subagents, MCP, and web search for [Pi](https://pi.dev) on Linux.**

pi.lot lets Pi work across repositories and absolute paths while mediating the filesystem and network effects produced by its tools. When an operation is not covered by policy, pi.lot can allow it, deny it, ask the user, or ask a bounded policy-review model.

> [!WARNING]
> pi.lot is experimental, has not been security audited, and is not a hardened sandbox for hostile code. An allowed operation still runs with your normal user permissions. Read the [security model](docs/security.md) before using it with sensitive data or systems.

## Requirements

pi.lot currently supports **Linux x86-64 only** and targets Pi `0.84.2`.

The host needs:

- Node.js and npm;
- FUSE 2, including `/dev/fuse` and `fusermount`;
- Bubblewrap;
- nftables and iproute2;
- util-linux (`unshare` and `nsenter`);
- `slirp4netns` and `xdg-dbus-proxy`;
- unprivileged user and network namespaces; and
- a C compiler, `pkg-config`, and `libnetfilter_queue` development files.

See [Installation and setup](docs/installation.md) for distribution packages, host checks, and troubleshooting.

## Install and set up

Install and authenticate the compatible Pi release:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
pi
```

Use `/login` inside Pi to authenticate a subscription or API-key provider.

Build pi.lot from a local checkout:

```bash
git clone https://github.com/Baizey/pi-sandbox.git pilot
cd pilot
npm install
npm run build
```

Install it for your user:

```bash
pi install "$PWD"
```

Other loading options:

```bash
pi install -l "$PWD"  # Current project only
pi -e "$PWD"          # One temporary invocation
```

The checked-in `.pi/settings.json` also loads the repository root as a project-local package when Pi starts inside this checkout and the project is trusted.

Start Pi in the project where you want to work:

```bash
cd /path/to/project
pi
```

Verify the extension:

```text
/policy-defaults
/subagent-defaults
/mcp show
/network-inspection
```

For updating, development, and common failures, see [Installation and setup](docs/installation.md).

## Capabilities

### Policy system

pi.lot replaces Pi's `bash`, `read`, `edit`, and `write` tools with policy-aware versions. It also applies the same policy runtime to `web_search` and to child-agent principals.

- Direct file tools check read or write policy before acting.
- Bash sees the host filesystem through a native FUSE policy layer.
- Bash network activity passes through private namespaces and DNS/TCP/UDP mediation.
- Supported HTTP/HTTPS requests can be checked by method and path.
- Decisions can apply once, for the session, or persist locally.
- Policy misses can ask the user or a separate structured policy-review model.
- User and agent-reviewed approvals are written to local JSONL audit logs.

Built-in defaults allow filesystem and HTTP reads while asking before filesystem writes and other network access.

Show or change defaults:

```text
/policy-defaults
/policy-defaults ask_user fs_write
/policy-defaults ask_llm web_read
/policy-defaults save
/policy-defaults reset
```

Full HTTPS request inspection starts enabled. Disable it for incompatible private trust stores or certificate-pinned clients:

```text
/network-inspection off
```

DNS and TCP hostname/port policy remains active, but HTTPS method/path policy is unavailable while inspection is off.

Read [Policy system](docs/policy.md) for policy areas, scope and lifetime semantics, approval routing, network granularity, audit records, and host credential IPC.

### Subagents

pi.lot provides retained child-agent conversations through:

- `subagent_spawn`;
- `subagent_status`;
- `subagent_message`; and
- `subagent_stop`.

Subagents have separate model context and principal-specific policy state. They can remain idle for follow-up turns, receive steering while active, form nested trees, and report activity in the TUI.

Spawn capabilities have two forms:

- **Policy areas** such as `fs_read`, `fs_write`, and `web_read` snapshot the parent's matching policies into the child.
- **Hard mechanisms** — `mcp` and `delegate` — determine whether MCP tools or nested delegation exist for the child.

Policy-mediated built-ins remain available even when an area is omitted; missing policy can still be requested. Hard mechanisms cannot be requested later or widened beyond the parent.

A spawn requests abstract `min` to `max` reasoning skill and `low` to `high` reasoning amount. pi.lot resolves those against Pi's authenticated reasoning-model catalogue.

Configure model mappings:

```text
/subagent-defaults
/subagent-defaults auto all
/subagent-defaults <provider>/<model> high
/subagent-defaults save
/subagent-defaults reset
```

Read [Subagents](docs/subagents.md) for capability inheritance, child context, model selection, work-tree authority, policy requests, and lifecycle.

### MCP

pi.lot supports MCP servers over stdio and Streamable HTTP. Configuration is stored in:

```text
~/.pilot/mcp.json
```

Tools are unexposed by default. Expose only the server tools the model should be able to call:

```json
{
  "servers": {
    "example": {
      "transport": "stdio",
      "command": "example-mcp-server",
      "args": [],
      "tools": {
        "expose": ["read_resource"]
      }
    }
  }
}
```

Manage servers and exposure:

```text
/mcp show [all|server]
/mcp connect [all|server]
/mcp disconnect [all|server]
/mcp refresh [all|server]
/mcp expose <server> <tool...|*>
/mcp hide <server> <tool...|*>
/mcp reset <server> [tool...|*]
```

MCP is an explicit boundary outside filesystem and network mediation: stdio servers run as host processes, HTTP transports use the host network, and their tools may perform opaque effects.

Read [MCP](docs/mcp.md) for complete stdio/HTTP configuration, timeout settings, exposure behaviour, generated tool names, and subagent access.

### Web search

`web_search` is supplied by pi.lot; it is not a native Pi built-in tool. It returns normalised, citable results with freshness and domain filters.

Supported backends are:

- SearXNG;
- Brave Search;
- Tavily;
- Serper;
- provider-native search for supported authenticated Pi models; and
- keyless DuckDuckGo HTML search.

Provider choice and ordered fallback are internal; the agent cannot select a backend. No configuration is required for the DuckDuckGo fallback. Optional provider order, credentials, request timeouts, and response limits live in:

```text
~/.pilot/web-search.json
```

Provider requests and redirects receive HTTP policy checks before host-side HTTP is sent. A policy denial stops fallback. Search answers and snippets are marked as untrusted external content.

Read [Web search](docs/web-search.md) for configuration, provider availability, fallback semantics, native search, filtering, and policy boundaries.

### Tool display

pi.lot also provides compact, copy-friendly tool rendering:

- `Ctrl+O` toggles compact and expanded tool views;
- `/view-full-tool` toggles a full view for one selected call; and
- active subagent work appears above the editor and in the footer.

## Documentation

- [Installation and setup](docs/installation.md)
- [Policy system](docs/policy.md)
- [Subagents](docs/subagents.md)
- [MCP](docs/mcp.md)
- [Web search](docs/web-search.md)
- [Security model and limitations](docs/security.md)

The extension appends this topic map, using absolute package paths, to the root agent's system prompt. The model is instructed to read only the relevant local documentation when helping with pi.lot.

## Configuration reference

| Path | Purpose |
| --- | --- |
| `~/.pilot/pilot.sqlite` | Locally persisted policy rules |
| `~/.pilot/policy-defaults.json` | Saved policy-area fallbacks |
| `~/.pilot/subagent-defaults.json` | Saved reasoning-skill model mappings |
| `~/.pilot/mcp.json` | MCP servers and tool exposure |
| `~/.pilot/web-search.json` | Web-search providers and credentials |
| `~/.pilot/credential-ipc.json` | Host D-Bus and Unix-socket passthrough |
| `~/.pilot/logs/<session-id>.log` | Policy approval audit records |

## Development

```bash
npm run build
npm test
```

Run the sandbox integration suite directly on a prepared Linux host, not from inside pi.lot or another sandbox. See [Development and tests](docs/installation.md#development-and-tests).

## License

ISC
