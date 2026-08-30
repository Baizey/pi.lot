# pi.lot

**Policy-controlled tools, subagents, MCP, and web search for [Pi](https://pi.dev) on Linux.**

pi.lot lets Pi work across repositories and absolute paths while mediating the filesystem and network effects produced by its tools. When an operation is not covered by an existing policy, pi.lot can ask the user, ask a bounded policy-review model, allow it, or deny it.

> [!WARNING]
> pi.lot is experimental, has not been security audited, and is not a hardened sandbox for hostile code. An allowed operation still runs with your normal user permissions. Review the [security boundaries](#security-boundaries) before using it with sensitive data or systems.

## What pi.lot adds

- **Policy-controlled built-ins** — replacements for Pi's `bash`, `read`, `edit`, and `write` tools.
- **Filesystem mediation** — Bash commands see the host filesystem through a FUSE policy layer rather than a fixed workspace boundary.
- **Network mediation** — DNS, TCP, UDP, and supported HTTP/HTTPS requests are evaluated from the effects a command actually produces.
- **Subagents** — retained child-agent conversations with explicit reasoning levels, policy snapshots, MCP access, and nested-delegation controls.
- **MCP** — stdio and Streamable HTTP servers with per-tool exposure.
- **Web search** — a Pilot-provided `web_search` tool with automatic provider fallback and policy-checked requests.
- **Approval audit logs** — structured records for user, ancestor-agent, and model-reviewed policy decisions.

## Requirements

pi.lot currently supports **Linux x86-64 only**. This checkout targets Pi `0.84.2`.

Required software and host features:

- Node.js and npm;
- [Pi](https://pi.dev);
- FUSE 2, including `/dev/fuse` and `fusermount`;
- Bubblewrap;
- nftables and iproute2;
- `unshare` and `nsenter` from util-linux;
- `slirp4netns`;
- `xdg-dbus-proxy`;
- unprivileged user and network namespaces;
- a C compiler and `pkg-config`; and
- `libnetfilter_queue` development files.

Typical Fedora/Bazzite packages:

```bash
sudo dnf install \
  gcc make pkgconf-pkg-config \
  fuse fuse-devel bubblewrap nftables iproute util-linux \
  slirp4netns xdg-dbus-proxy libnetfilter_queue-devel
```

Typical Debian/Ubuntu packages:

```bash
sudo apt install \
  build-essential pkg-config \
  fuse libfuse-dev bubblewrap nftables iproute2 util-linux \
  slirp4netns xdg-dbus-proxy libnetfilter-queue-dev
```

Package names vary by distribution. Before building, these checks should succeed:

```bash
command -v cc pkg-config bwrap fusermount nft ip unshare nsenter slirp4netns xdg-dbus-proxy
pkg-config --exists libnetfilter_queue
test -r /dev/fuse && test -w /dev/fuse
```

## Install and set up

### 1. Install and authenticate Pi

If Pi is not already installed:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
```

Start Pi and use `/login` to authenticate a subscription or API-key provider:

```bash
pi
```

Subagents require at least one authenticated model with normal reasoning support. The `native` web-search backend also uses Pi's authenticated model catalogue when the active model supports provider-native search.

### 2. Build pi.lot

From a local checkout:

```bash
git clone https://github.com/Baizey/pi-sandbox.git pilot
cd pilot
npm install
npm run build
```

The build compiles four small native helpers and type-checks the TypeScript extension.

### 3. Install the Pi package

Install it for your user:

```bash
pi install "$PWD"
```

To install it only for the current project, use:

```bash
pi install -l "$PWD"
```

To try the checkout for one invocation without installing it:

```bash
pi -e "$PWD"
```

The checked-in `.pi/settings.json` also loads the repository root as a project-local package when Pi is started inside this checkout and the project is trusted.

### 4. Start Pi and verify the extension

Start Pi in the project where you want to work:

```bash
cd /path/to/project
pi
```

These commands should now be available:

```text
/policy-defaults
/subagent-defaults
/mcp
/network-inspection
/view-full-tool
```

A useful first-run check is:

```text
/policy-defaults
/subagent-defaults
/mcp show
/network-inspection
```

### Updating a local installation

A local Pi package points at the checkout rather than copying it. Update and rebuild it, then restart Pi:

```bash
cd /path/to/pilot
git pull
npm install
npm run build
```

### Development and tests

Load the working tree directly with `pi -e "$PWD"`, or start Pi inside the checkout and use its project-local package setting.

Run the test suite only on a suitable host environment:

```bash
npm test
```

Do **not** run the sandbox integration suite from inside pi.lot or another restrictive sandbox. The tests create FUSE mounts, Bubblewrap workers, network namespaces, and nftables/NFQUEUE state; nesting those mechanisms produces misleading failures.

## Policy system

### What is mediated

All policy-aware tools share one session-owned policy runtime:

| Surface         | Enforcement                                                                     |
|-----------------|---------------------------------------------------------------------------------|
| `read`          | Checks filesystem-read policy before reading a path.                            |
| `edit`, `write` | Check filesystem-write policy before changing a path.                           |
| `bash`          | Runs with a FUSE-backed view of the host filesystem and a private network gate. |
| `web_search`    | Uses trusted extension-side HTTP with method/URL policy checks.                  |
| Subagents       | Use principal-specific policy state and the same mediated built-ins.            |

Every Bash call must include a short purpose. Filesystem operations are evaluated as reads or mutations; deletes are governed by filesystem-write policy. Multi-path operations such as rename can require approval for more than one path.

Network policy is based on actual activity rather than command-name matching. A command and its descendants are mediated across:

- DNS resolution;
- IPv4 and IPv6 TCP/UDP flows;
- literal IP and hostname targets;
- HTTP methods and canonical paths for supported HTTP/1 traffic; and
- HTTPS methods and paths when full network inspection is enabled.

The current per-command network projector deliberately reuses an approved hostname decision across DNS, TCP, UDP, IPv4, IPv6, and destination ports for the remainder of that Bash call. Literal-IP decisions begin at an exact address and port. For request-level policy, pi.lot observes the canonical URL but currently normalises policy identity without the scheme, query string, or fragment.

Bash commands start in Pi's current working directory, but the working directory is not a security boundary. Access elsewhere on the host is handled by the same policy runtime.

### Policy areas and defaults

Unmatched operations first use the active default for their policy area:

| Policy area     | Covers                                      | Built-in default |
|-----------------|---------------------------------------------|------------------|
| `fs_read`       | Filesystem reads                            | `allow`          |
| `fs_write`      | Filesystem writes and deletes               | `ask_user`       |
| `web_read`      | HTTP access and GET                         | `allow`          |
| `web_write`     | POST, PUT, PATCH, DELETE, HEAD, and OPTIONS | `ask_user`       |
| `web_dns`       | DNS                                         | `ask_user`       |
| `web_tcp`       | Generic TCP                                 | `ask_user`       |
| `web_udp`       | Generic UDP                                 | `ask_user`       |
| `web_ssh`       | Reserved SSH-specific policy                | `ask_user`       |
| `web_websocket` | Reserved WebSocket-specific policy          | `ask_user`       |
| `web_grpc`      | Reserved gRPC-specific policy               | `ask_user`       |
| `web_smtp`      | Reserved SMTP-specific policy               | `ask_user`       |

These reserved areas exist in the policy and delegation model but are not currently emitted by the Bash mediator. SSH and SMTP are opaque generic TCP. Request-aware WebSocket upgrades and HTTP/2-based gRPC are not currently supported.

Each area can use one of four fallback responses:

- `allow` — permit unmatched operations in that area;
- `deny` — reject them;
- `ask_user` — open the interactive policy flow; or
- `ask_llm` — ask a separate, ephemeral policy-review model.

The `ask_llm` reviewer receives bounded operation and task context and has only one structured decision tool. It can create `ONCE` or `SESSION` decisions, never durable policy. Missing, malformed, cancelled, stale, or timed-out reviews fail closed.

### Configure policy defaults

Show the current session defaults:

```text
/policy-defaults
```

Change one area or all areas:

```text
/policy-defaults allow fs_read
/policy-defaults ask_user fs_write
/policy-defaults ask_llm web_read
/policy-defaults deny web_tcp
/policy-defaults ask_user all
```

Pi provides argument completion for valid responses and policy areas.

Persist the active defaults or reload the persisted values:

```text
/policy-defaults save
/policy-defaults reset
```

Saved defaults are stored in `~/.pilot/policy-defaults.json`. Without that file, reset restores the built-in defaults shown above.

### Interactive approvals

When `ask_user` is selected, the policy flow asks for:

1. the path or network scope;
2. allow or deny;
3. the lifetime; and
4. an optional reason when denying.

Available lifetimes are:

- **Once** — only the current tool call;
- **This session** — the active Pi session; and
- **Always on this computer** — persisted locally.

Network prompts currently also offer **Always synchronised**, but synchronised policy is not implemented; `GLOBAL` currently uses the same local database as `LOCAL`.

More-specific scopes take precedence over broader scopes. Persisted policy is stored in:

```text
~/.pilot/pilot.sqlite
```

### Agent and subagent approvals

Each agent is a separate policy principal. When a subagent requests an operation it does not already hold:

- a matching explicit denial is terminal;
- a covering allow held by an ancestor can authorize a bounded policy-review agent;
- otherwise the root policy fallback selects user review, model review, allow, or deny.

An approval derived from ancestor authority cannot exceed the ancestor's scope or lifetime. Session grants are installed only along the requesting ancestry, not on sibling agents.

Approval outcomes are appended as JSON lines under:

```text
~/.pilot/logs/<session-id>.log
```

The directory and files are created with user-only permissions.

### HTTPS inspection

Every session starts with full network inspection enabled. For supported clients, pi.lot creates a per-run CA, makes read-only trust artifacts available to the worker, terminates client TLS in the trusted gateway, verifies the upstream certificate, and evaluates each supported HTTP request before opening the upstream connection.

Show or change the session setting:

```text
/network-inspection
/network-inspection off
/network-inspection on
```

With inspection off, HTTPS remains end-to-end. DNS and TCP hostname/port policy still applies, but method/path policy is unavailable. This compatibility mode is useful for certificate-pinned clients, private trust stores, and unsupported TLS stacks.

### Host credential IPC

The Bash worker inherits the Pi environment and sees ordinary credential files through filesystem policy. pi.lot additionally preserves selected live host credential protocols that cannot pass through FUSE by pathname alone.

The defaults are:

- filtered session D-Bus access to `org.freedesktop.secrets`; and
- a read-only import of the socket named by `SSH_AUTH_SOCK`, when present.

Replace the defaults with an explicit configuration in `~/.pilot/credential-ipc.json`. Repeat the default entries if you want to keep them while adding another protocol:

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

Path templates support only explicit `${VARIABLE}` expansion. A read-only socket import describes how the socket inode is mounted; clients can still ask the imported SSH agent or other service to exercise its normal protocol authority, such as signing.

## Subagents

pi.lot exposes four tools to the root agent:

| Tool               | Purpose                                                                |
|--------------------|------------------------------------------------------------------------|
| `subagent_spawn`   | Start a retained child conversation and return its job ID immediately. |
| `subagent_status`  | Inspect jobs or wait for selected active turns.                        |
| `subagent_message` | Steer active work or queue a follow-up turn.                           |
| `subagent_stop`    | Stop a job and all of its descendants.                                 |

Subagents have separate model context and conversation state. Jobs can remain idle between turns, receive follow-up work, form nested trees, and appear in the TUI activity widget and footer.

Ambient `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `SYSTEM.md`, skills, prompt templates, and other extensions are not injected into child sessions. Children receive Pilot's owned prompt plus the delegated task and optional additional prompt. `contextPaths` are suggestions in that prompt, not automatically loaded file contents; children must read them through policy-mediated tools.

### Capability model

Spawn capabilities have two different meanings:

1. **Policy-area capabilities** — `fs_read`, `fs_write`, and every `web_*` area. Selecting one snapshots the parent's effective allows and denials for that complete area into the child at spawn time.
2. **Hard mechanism capabilities** — `mcp` and `delegate`. These determine whether MCP tools or nested-subagent tools exist for the child.

Important behavior:

- Policy snapshots are fixed at spawn; later parent changes do not update the child.
- Omitting a policy area leaves that area blank. It is not a permanent denial: the child can still request policy when needed.
- Policy-mediated `bash`, `read`, `edit`, `write`, and `web_search` remain available to every child.
- A nested child cannot receive `mcp` or `delegate` unless its parent already has that hard capability.
- MCP effects remain outside filesystem and network policy even when MCP is granted to a child.

### Reasoning and model selection

A spawn requests two abstract settings instead of naming a model:

- `reasoning_skill`: `min`, `low`, `mid`, `high`, or `max`;
- `reasoning_amount`: `low`, `mid`, or `high`.

Skill selects a model from Pi's authenticated reasoning-model catalogue. Amount selects the thinking level after the model has been chosen. In automatic mode, `min` favors estimated cost, `max` favors estimated performance, and the intermediate skills move across the estimated cost/performance frontier.

Show the current mappings:

```text
/subagent-defaults
```

Use automatic selection for one skill or all skills:

```text
/subagent-defaults auto mid
/subagent-defaults auto all
```

Pin an authenticated canonical model:

```text
/subagent-defaults <provider>/<model> high
```

Persist or reload the mappings:

```text
/subagent-defaults save
/subagent-defaults reset
```

Saved mappings live in `~/.pilot/subagent-defaults.json`. Exact model mappings are validated against Pi's currently authenticated catalogue.

### Current process boundary

Subagents are independent in-memory Pi sessions, not separate operating-system processes. They share the trusted root Pi process and policy runtime while retaining principal-specific policy state and model context. Jobs are not persisted across root-session shutdown.

## MCP

pi.lot supports MCP servers over **stdio** and **Streamable HTTP**. Configuration lives in:

```text
~/.pilot/mcp.json
```

Tools are unexposed by default. A server can connect and advertise tools without making those tools callable by the model.

### Configuration

Example with one stdio server and one HTTP server:

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

Optional server settings include:

- `cwd` and `env` for stdio servers;
- `headers` for HTTP servers;
- `connectTimeoutMs`;
- `listToolsTimeoutMs`;
- `toolTimeoutMs`; and
- `toolMaxTotalTimeoutMs`.

Because this file can contain credentials, protect it:

```bash
chmod 600 ~/.pilot/mcp.json
```

### Manage MCP at runtime

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

Exposed tools are registered in Pi with names derived from their server and tool, such as `mcp_local_read_resource`.

Hiding a previously registered tool blocks calls immediately. The tool can remain visible in the current model tool list until `/reload` or a new session.

### MCP security boundary

MCP is an explicit capability boundary, not part of pi.lot's filesystem or network mediation:

- stdio servers run as normal host processes;
- HTTP transports use the host network; and
- an MCP tool can perform effects that pi.lot cannot observe or authorize.

Expose only trusted servers and the minimum tools required. A subagent receives MCP tools only when spawned with the hard `mcp` capability.

## Web search

`web_search` is provided by pi.lot; it is not one of Pi's native built-in tools. It returns normalized, citable results and supports:

- one to twenty results;
- day, week, month, or year freshness filters;
- domain inclusion and exclusion filters; and
- ordered provider fallback selected internally rather than by the agent.

Fallback continues when a backend is unavailable, empty, or fails normally. A policy-denied request stops the search rather than trying another provider.

Supported backends are:

- SearXNG;
- Brave Search;
- Tavily;
- Serper;
- provider-native search for supported authenticated Pi models; and
- keyless DuckDuckGo HTML search.

No configuration is required for the DuckDuckGo fallback. Configure provider order, limits, and credentials in `~/.pilot/web-search.json`:

```json
{
  "version": 1,
  "providers": ["searxng", "brave", "tavily", "serper", "native", "duckduckgo"],
  "requestTimeoutMs": 30000,
  "maxResponseBytes": 2097152,
  "searxng": {
    "baseUrl": "https://search.example.com"
  },
  "brave": {
    "apiKey": "replace-me"
  },
  "tavily": {
    "apiKey": "replace-me"
  },
  "serper": {
    "apiKey": "replace-me"
  }
}
```

Unconfigured providers are skipped. The `native` backend never silently switches to another logged-in model. It is available only when the active model supports native search and is present in Pi's authenticated model registry.

Provider HTTP requests and redirects are checked through the shared policy runtime before they are sent. `web_search` is a trusted extension operation using host-side HTTP; it does not traverse Bash's FUSE/network worker or its DNS/TCP/UDP gate. Search snippets and provider answers are marked as untrusted external content.

Protect API keys in the configuration file:

```bash
chmod 600 ~/.pilot/web-search.json
```

## Tool display

pi.lot uses Pi's tool-expansion state as a global output-density control:

- `Ctrl+O` toggles compact and expanded tool views;
- compact rows show a minimal title;
- expanded rows show bounded arguments and results; and
- `/view-full-tool` toggles a full view for one selected tool call.

Active subagent work is shown above the editor and summarized in the footer.

## Configuration reference

| Path                              | Purpose                                    |
|-----------------------------------|--------------------------------------------|
| `~/.pilot/pilot.sqlite`           | Locally persisted policy rules.            |
| `~/.pilot/policy-defaults.json`   | Saved policy-area fallbacks.               |
| `~/.pilot/subagent-defaults.json` | Saved reasoning-skill model mappings.      |
| `~/.pilot/mcp.json`               | MCP servers and tool exposure.             |
| `~/.pilot/web-search.json`        | Web-search provider order and credentials. |
| `~/.pilot/credential-ipc.json`    | Host D-Bus and Unix-socket passthrough.    |
| `~/.pilot/logs/<session-id>.log`  | Structured policy approval audit records.  |

## Security boundaries

Keep these limitations in mind:

- pi.lot is experimental and unaudited.
- An allowed operation retains the invoking user's ordinary host permissions.
- Host-side FUSE path resolution still has pathname race windows.
- Versioned live policy replacement and active filesystem/network revocation are not implemented.
- The combined worker's `/dev`, pseudo-filesystem, pathname-socket, and supplementary-group compatibility is incomplete.
- Some DNS, UDP lifecycle, IPv6, HTTP/2, HTTP/3/QUIC, WebSocket, `CONNECT`, private-trust-store, and certificate-pinning behavior is unsupported or fails closed.
- Preserved local credential IPC can ask host services to perform effects outside direct filesystem and network mediation.
- MCP transports and tools are intentionally outside filesystem and network mediation.
- Subagents share the trusted Pi process.
- `GLOBAL` network-policy lifetime is not synchronised and currently persists only in the local policy database.
- The keyless DuckDuckGo backend depends on a public HTML format that may change.

Unsupported, malformed, cancelled, or incomplete mediated operations are intended to fail closed, but that is not a substitute for a security audit or independent threat-model review.

## License

ISC
