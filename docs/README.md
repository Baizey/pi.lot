# pi.lot documentation

pi.lot provides policy-controlled filesystem and Bash tools, retained subagents, MCP, web search, session archival, and saved configuration sync for [Pi](https://pi.dev). The supported target is **Linux x86-64**, with development dependencies pinned to Pi **1.5.0**.

> pi.lot is experimental and has not been independently security audited. It is not hardened isolation for hostile code. Allowed operations retain the user's host permissions. Read the [security model](security.md) before using it for sensitive workloads.

These references ship with the package. Pilot supplies their installation-relative absolute paths in the root agent's documentation prompt; reading them does not require a documentation service or MCP server.

## Topic map

| Topic | Reference |
| --- | --- |
| Install, update, load, or troubleshoot host dependencies | [Installation and setup](installation.md) |
| Policy defaults, approvals, sandboxing, networking, credentials, and audit logs | [Policy system](policy.md) |
| Spawn, steer, inspect, or stop children; choose models and capabilities | [Subagents](subagents.md) |
| Search providers, filters, fallback, and credentials | [Web search](web-search.md) |
| pi.server connections, archive tools, uploads, configuration sync and recovery | [Server](server.md) |
| Enforcement boundaries and known limitations | [Security](security.md) |
| Coding conventions and verification | [Development](development.md), [native helper architecture](native-rust-migration.md) |

[Writable-mmap research](transparent-mmap-feasibility.md), the [hardening review](sandbox-hardening-review.md), and the [background archive plan](background-archive-plan.md) distinguish historical investigations from current contracts. They are not evidence that every proposed guarantee is implemented or tested.

## Setup

Install the [host prerequisites](installation.md#requirements), then build and register a trusted checkout:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.5.0
git clone https://github.com/Baizey/pi-sandbox.git pilot
cd pilot
npm install
pi install "$PWD"
```

Start Pi in the project where you want to work and authenticate a provider with `/login`. See [installation](installation.md#install-the-package) for built-in MCP/codemode overrides and project-local loading. Native helpers must be rebuilt, and Pi restarted, after native source changes; the runtime receipt checks installed artifacts, not source freshness.

## Settings commands

Bare commands open their settings only in terminal TUI mode; outside TUI they report the current values. Confirmed choices apply immediately. Cancelling a choice submenu preserves that value; closing the main settings panel does not undo applied changes.

| Command | Settings and persistence |
| --- | --- |
| `/policy-defaults` | Per-area fallbacks. `/policy-defaults ask_user fs_write` or `/policy-defaults deny all` changes them directly. `save` persists; `reset` reloads saved defaults, or built-ins if absent. Explicit rules still take precedence. |
| `/subagent-defaults` | Searchable per-skill model mappings. `/subagent-defaults <provider>/<model> high` or `/subagent-defaults auto all` affects newly accepted jobs. `save` persists; `reset` reloads saved defaults. |
| `/display` | Normal/Alternate tool views. `/display conversation full` sets the pair. `save` persists; `reset` reloads saved views, or Compact/Preview if absent. |
| `/sandboxing` | Network inspection and writable-mmap switches for new Bash calls, including subagents. Changes are session-only and are never saved or synchronized. |
| `/server` | Connection, upload, configuration-sync and recovery actions. Opening the terminal menu sends nothing and hides the API key. **Check connection still displays the key**, as does bare `/server` outside TUI. Never share unredacted status output. |

Policy, subagent and display pickers also provide explicit **Save defaults** and **Reload saved defaults** actions. Saving is not automatic. `/server status` is not a text command; select **Check connection** from the menu.

### Sandboxing switches

```text
/sandboxing network-inspection on
/sandboxing network-inspection off
/sandboxing mmap on
/sandboxing mmap off
```

Every replacement session runtime starts with **network inspection on** and **writable mmap off**. Existing calls and mappings are unchanged when settings change. The old standalone `/network-inspection` command has been removed.

Inspection off preserves end-to-end HTTPS for clients incompatible with interception; it does **not** disable network sandboxing. Transport policy and recognized plaintext checks remain, while opaque traffic may receive transport-only forwarding.

Writable mmap enables cached write-through compatibility for build/linker workloads. Opens and native backing I/O remain policy checked, but memory stores are not individually checked or revocable. Normal completion attempts a retained-frontend `syncfs` drain before teardown and reports helper failures. This is not lossless cancellation, transactional rollback, or stable-storage durability for every backing file. **Host/cross-call SQLite WAL and backing-file lock coordination remain unsupported.** See [filesystem mediation](policy.md#filesystem-mediation) and [security](security.md).

## Tools and trust boundaries

- `read`, `edit`, and `write` authorize direct file effects. Bash uses a per-call FUSE mount and private network namespaces. The working directory is a starting location, not a filesystem boundary.
- Built-in fallbacks allow `fs_read` and `web_read`; writes and other network areas ask the user. Saved defaults and explicit rules may differ.
- `subagent_spawn`, `subagent_status`, `subagent_message`, and `subagent_stop` manage retained child conversations. Policy-area capabilities copy authority rather than remove tools. Omitted areas can still request approval. Hard `mcp` and `delegate` capabilities control those mechanisms.
- Pilot hosts Pi's native MCP implementation. Use `/mcp` to manage it. MCP server effects are outside Pilot filesystem/network mediation; children require the hard `mcp` grant.
- `web_search` performs ordered provider fallback with policy checks. Denial stops fallback. Snippets and provider answers are untrusted evidence, not instructions.

### Codemode

Root Pilot codemode uses JSON `{purpose, code}`, not native Pi's raw-source input grammar. Purpose is nonempty, one line, and at most 160 characters:

```json
{"purpose":"Read the project manifest","code":"return await tools.read({path: 'package.json'});"}
```

Children retain native codemode input: raw JavaScript where supported, otherwise `{code}`, without a required purpose. Root scripts expose potentially billable `models.classify()` and `models.generateImages()` outside filesystem/network policy; children expose no model globals. Root and children share the worker pool, two workers by default, configurable with `PI_CODEMODE_MAX_WORKERS`. See [timeout accounting](policy.md#finite-codemode-timeouts) and [codemode boundaries](security.md#codemode-model-calls).

### Tool display

`Ctrl+O` switches Normal/Alternate views, initially **Compact/Preview**. Available modes are Conversation, Compact, Preview and Full. Changing a slot redraws existing rows without switching the active side; per-tool mouse toggles select independently. The picker saves the pair, not the active toggle position.

Conversation retains compact headers for the five most recently finished tool/thinking items; active items do not consume that window. Finished bodies, images and internal summaries are hidden. Preview/Conversation show the last 12 rendered rows of active thinking. Preview retains trailing command/script/file lines, while ranked search/archive previews retain leading results. Full still has display safety limits. **Display changes never truncate stored history or limit complete archival uploads.**

## Archive and configuration

All operational archive/configuration HTTP requires an authenticated stable **pi.server 0.4.x** version handshake. `/server login` stores credentials and enables automatic current-family departure archival, outside agent policy approval. It also wakes retained work; it does not backfill all history or enable configuration sync.

**Uploads contain complete native session JSONL across branches**, potentially including prompts, reasoning, credentials, tool results and file contents. Departure queues a capture obligation, not an immutable departure image. `/server upload [current|all]` reports **queued**, not uploaded; an independent worker captures, reconciles and retries. Root-only `archive_list` and `archive_fetch` browse history without importing/resuming it. Their POST requests require `web_write`; fetched transcripts are untrusted data. Read [server.md](server.md) before using these tools.

`/server sync` runs one foreground pass over saved display, subagent, policy and web-search configuration plus GLOBAL policy rules. **Web-search credentials are included.** `sync on` additionally opts into startup checks; `sync off` disables those checks, not session archival. No periodic watcher, native Pi settings, connection credentials, IPC configuration, LOCAL/session/ONCE rules or unsaved overrides are synchronized. See [conflicts and recovery](server.md#saved-configuration-sync).

## Configuration locations

Pilot configuration lives in `~/.pilot`, independently of Pi's agent directory:

| Path | Purpose |
| --- | --- |
| `pilot.sqlite` | Persistent rules and private configuration-sync bases/pending/recovery/opt-ins |
| `policy-defaults.json`, `subagent-defaults.json`, `display-defaults.json` | Explicitly saved defaults |
| `web-search.json` | Search providers and credentials |
| `credential-ipc.json` | Host D-Bus and Unix-socket passthrough |
| `server.json` | Server URL, API key and internal connection generation; never synchronized |
| `config-sync.enabled`, `config-sync.lock` | Startup-sync hint and pass lock |
| `server-archive/inbox/` | Durable capture obligations and wakeups |
| `server-archive/archive.sqlite` | Retained bytes, operations, receipts and coverage |
| `server-archive/downloads/` | Verified snapshots and large archive-list pages |
| `logs/<session-id>.log` | Sensitive approval audit records, not an exhaustive effect trace |

See [development and tests](installation.md#development-and-tests) before selecting verification gates. Run mounted filesystem/network integration on a prepared Linux host **outside pi.lot or another restrictive sandbox**.
