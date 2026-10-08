# pi.lot

**Policy-controlled tools, subagents, MCP, and web search for [Pi](https://pi.dev) on Linux.**

pi.lot lets Pi work across repositories and absolute paths while mediating the filesystem and network effects produced by its tools. When an operation is not covered by policy, pi.lot can allow it, deny it, ask the user, or ask a bounded policy-review model.

> [!WARNING]
> pi.lot is experimental, has not been security audited, and is not a hardened sandbox for hostile code. An allowed operation still runs with your normal user permissions. Read the [security model](docs/security.md) before using it with sensitive data or systems.

## Requirements

pi.lot currently supports **Linux x86-64 only** and targets Pi `1.0.0`.

The host needs:

- Node.js 22.19.0 or newer and npm;
- system libfuse 3.17.3 or newer, including `/dev/fuse` and `/usr/bin/fusermount3`;
- Bubblewrap;
- nftables and iproute2;
- util-linux (`unshare` and `nsenter`);
- `slirp4netns` and `xdg-dbus-proxy`;
- unprivileged user and network namespaces; and
- Rust 1.85 or newer with Cargo;
- a C compiler, `pkg-config`, and libfuse3/`libnetfilter_queue` development files (the libfuse ABI shim still needs C).

See [Installation and setup](docs/installation.md) for distribution packages, host checks, and troubleshooting.

## Install and set up

For scripted setup on a supported host:

```bash
git clone https://github.com/Baizey/pi-sandbox.git pilot
cd pilot
./scripts/install-deps.sh --dry-run  # Review package-manager commands
./scripts/install-deps.sh           # Uses sudo for host packages only
# On Bazzite/Fedora Atomic, reboot if packages were layered.
./scripts/setup.sh                  # Run as your normal user, not with sudo
pi                                 # Use /login to authenticate
```

`setup.sh` checks prerequisites, installs the compatible Pi release, builds pi.lot, and registers the checkout for your user. Use `--dry-run` to preview it, `--skip-pi` to retain a compatible Pi installation, or `--project /path/to/project` for project-local registration. `./scripts/check-host.sh` runs only the preflight checks; `./scripts/setup.sh update` fast-forwards a clean checkout and rebuilds. Run these scripts on the host, not inside pi.lot or toolbox. They leave authentication, loader settings, and host security policy to you; see [Scripted setup](docs/installation.md#scripted-setup).

For manual setup, install and authenticate the compatible Pi release:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.0
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
/mcp
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

Subagents have separate model context and principal-specific policy state. They can remain idle for follow-up turns, receive steering while active, form nested trees, and report activity in the TUI. With a persistent root, their complete histories are saved as ordinary Pi sessions alongside the root, named `Subagent: <role>` and linked to their immediate parent. `--no-session` keeps children ephemeral too; live jobs and policy grants are not restored from history.

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

Pilot runs Pi's built-in MCP implementation via `createMcpExtension()`. The [loader setting](docs/installation.md#install-the-package) `"-builtin:mcp"` suppresses Pi's separate automatic instance and override warning—not MCP functionality. Without it, Pi omits the duplicate instance and warns. Use [Pi's MCP documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) for configuration and server management.

MCP effects are [outside filesystem and network mediation](docs/security.md#mcp). OAuth credentials now belong to a server name plus URL; differently named servers sharing a URL may need separate `/mcp login <server>` calls after Pi's native legacy migration. Children require the hard `mcp` grant; see [subagent capability semantics](docs/subagents.md#hard-mechanism-capabilities).

Pi's native discovery behavior is preserved: default MCP servers connect without delaying the first prompt, appear in the `mcp_servers` prompt section, and are discovered with `searchTools()` and `describeNamespace()`. Scripts, tool search, and resource tools wait for the servers they need; direct tools still participate in the first-prompt startup wait. Native namespace normalization, collision-safe tool names, `description`, `oauth.clientName`, and provider-token authentication remain owned by Pi. Pilot's documentation is a separate structured prompt section, so it does not force a replacement prompt or defeat MCP's transcript deltas.

MCP tools retain Pilot's `Ctrl+O` and `/view-full-tool` display. MCP previews and codemode script/output previews limit wrapped visual rows. Codemode's nested calls reuse normal tool-call layouts with a small indent: compact views show titles such as `bash | purpose` and `read | path:range`, while expanded and full views reveal arguments with the usual preview limits. Nested calls wrap within their indent without adding completion icons, and running calls share the parent row's Pi loader animation. Pilot keeps its compact view and tail-oriented output previews. Routine connection notices are quiet; configuration errors, discovery warnings, load failures, command diagnostics, and tool errors still surface. Check `/mcp` for connection state.

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

Pi `1.0.0` defaults to fullscreen mode. Set `"tuiMode": "regular"` in Pi settings, or use `pi --tui-mode regular`, for the regular terminal UI.

pi.lot also provides compact, copy-friendly tool rendering:

- `Ctrl+O` toggles compact and expanded tool views;
- `/view-full-tool` toggles a full view for one selected call;
- Pilot's `codemode` requires a concise, one-line `purpose`, shown beside the tool name even in minimal mode; nested calls use the same titles, argument layouts, colors, and compact/expanded/full modes as normal calls, indented to show they belong to the script, with Pi's animated braille loader while running and a blank icon column afterward; expanded and per-call full views also reveal the script, output, full errors, and output-file hints;
- active subagent work appears above the editor and in the footer;
- the chat editor border stays at the theme's `thinkingXhigh` color (Bash mode keeps its own color); and
- a structured footer groups model and usage into two rows, with the session name right-aligned beside the context/usage row:

  ```text
  provider/model                                            Thinking ■■■■□ high
  Context 42.0% / 272k (auto) · ↑12k ↓3k · $0.120    agents ●2 ○1 · session name
  ```

The thinking indicator uses colored cubes: `□□□□□ off`, `■■■□□ medium`, or `■■■■■ xhigh`. Pi's `max` level adds a sixth filled cube. The footer reserves that sixth column and right-pads each level name to the longest label, keeping the indicator aligned when levels change. The bundled `pilot-dark` theme keeps `off` grey and uses a blue-to-purple gradient for active thinking levels: a lighter blue for `minimal`, progressing through blue, periwinkle, and violet to purple at `max`. Select `pilot-dark` in `/settings` to use this palette; other themes retain their own colors. It updates with the model, thinking level, and theme. Context usage follows the thinking palette: `thinkingMinimal` below 20%, `thinkingLow` from 20%, `thinkingMedium` from 40%, `thinkingHigh` from 60%, `thinkingXhigh` from 80%, and `thinkingMax` at 90% and above—including usage over 100%. Unknown usage uses `thinkingOff`; displayed percentages are never capped. Agent activity retains its own colors; labels and separators stay subdued.

Pilot wraps Pi's native codemode registration through the public `createCodemodeExtension()` factory without changing script execution, tool exposure, storage, or `codemode` settings. Calls remain JSON objects `{purpose, code}` rather than the native raw-source grammar so the required purpose can be validated and displayed before execution. [Pi's codemode documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md) describes the `code` body and script API, not Pilot's wrapper envelope. Probe unknown tools with `'name' in tools`, not `typeof tools.name`. Purpose must be non-empty, one line, and at most 160 characters. It remains inactive by default; enable it with `defaultTools: ["+codemode"]`, `--tools`, or MCP's automatic activation. Add `"-builtin:codemode"` alongside `"-builtin:mcp"` in your `extensions` settings to suppress the duplicate built-in override warning, not the functionality. See [installation](docs/installation.md#install-the-package).

Complete nested-tool arguments are retained only in memory for live rendering, subject to the normal argument visibility and display limits. Pi's bounded persisted call previews and model-facing output are unchanged; restored calls with truncated JSON keep a readable inline preview rather than guessing missing arguments. Model-call rows keep Pi's model identifier rather than exposing prompts or image data.

Root codemode's `models.classify()` and `models.generateImages()` make authenticated, potentially billable host-side calls [outside filesystem/network mediation](docs/security.md#codemode-model-calls). Child codemode uses `models: false`, exposing no model globals.

The footer omits the cwd and Git branch. It adapts to terminal width, shortening long session names and collapsing cache details before model/context information. At very narrow widths, the session name is omitted to preserve context usage and agent counts. Wide terminals also show cache read/write totals and the latest assistant cache-hit rate. Usage totals include all session entries, including nested-tool, compaction, and branch-summary usage. Other extensions' statuses appear on a separate row when present.

pi.lot uses Pi's custom-footer slot, so another custom-footer extension can replace it (or be replaced by it, depending on load order). A small adapter preserves the live auto-compaction indicator through the native footer's public methods; if no native footer is available when pi.lot starts, that indicator is omitted rather than guessed.

## Documentation

- [Installation and setup](docs/installation.md)
- [Policy system](docs/policy.md)
- [Subagents](docs/subagents.md)
- [Web search](docs/web-search.md)
- [Security model and limitations](docs/security.md)

The extension appends this topic map, using absolute package paths, to the root agent's system prompt. The model is instructed to read only the relevant local documentation when helping with pi.lot.

## Configuration reference

| Path | Purpose |
| --- | --- |
| `~/.pilot/pilot.sqlite` | Locally persisted policy rules |
| `~/.pilot/policy-defaults.json` | Saved policy-area fallbacks |
| `~/.pilot/subagent-defaults.json` | Saved reasoning-skill model mappings |
| `~/.pilot/web-search.json` | Web-search providers and credentials |
| `~/.pilot/credential-ipc.json` | [Host D-Bus and Unix-socket passthrough; common integrations and when to enable them](docs/policy.md#host-credential-ipc) |
| `~/.pilot/logs/<session-id>.log` | Policy approval audit records |

## Development

```bash
npm run build
npm test
```

The four native helpers are implemented in Rust, retaining the system high-level libfuse frontend through a small C ABI shim. The original C helpers remain as an explicit test reference; they are not an automatic runtime fallback.

```bash
npm run test:native       # Shared C/Rust contracts and differential tests, without mounts
npm run test:native:host  # Also run the same mounted/network contracts on both implementations
```

Run the sandbox integration suite directly on a prepared Linux host, not from inside pi.lot or another sandbox. See [Development and tests](docs/installation.md#development-and-tests) and [Native Rust migration and parity](docs/native-rust-migration.md).

## License

ISC
