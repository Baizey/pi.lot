# pi.lot documentation

pi.lot provides policy-controlled filesystem and Bash tools, retained subagents, MCP, web search, session archival, and saved configuration sync for [Pi](https://pi.dev). The supported target is **Linux x86-64**, with development dependencies pinned to Pi **1.6.0**.

> pi.lot is experimental and has not been independently security audited. It is not hardened isolation for hostile code. Allowed operations retain the user's host permissions. Read the [security model](security.md) before using it for sensitive workloads.

These references ship with the package. Pilot supplies their installation-relative absolute paths in root and child agents' documentation prompts; reading them does not require a documentation service or MCP server.

## Topic map

| Topic | Reference |
| --- | --- |
| Install, update, load, or troubleshoot host dependencies | [Installation and setup](installation.md) |
| Bash execution environment, localhost versus host services, Android/ADB, and connection troubleshooting | [Working inside the harness](harness.md) |
| Policy defaults, approvals, sandboxing, networking, credentials, and audit logs | [Policy system](policy.md) |
| Database, messaging, file/directory, and mail protocol versions and channel limits | [Service protocol admission](network-protocols.md) |
| Spawn, steer, inspect, or stop children; choose models and capabilities | [Subagents](subagents.md) |
| Search providers, filters, fallback, and credentials | [Web search](web-search.md) |
| pi.server connections, archive tools, uploads, configuration sync and recovery | [Server](server.md) |
| Enforcement boundaries and known limitations | [Security](security.md) |
| Coding conventions and verification | [Development](development.md), [native helper architecture](native-rust-migration.md) |

[Writable-mmap research](transparent-mmap-feasibility.md), the [hardening review](sandbox-hardening-review.md), and the [background archive plan](background-archive-plan.md) distinguish historical investigations from current contracts. They are not evidence that every proposed guarantee is implemented or tested.

## Setup

Install the [host prerequisites](installation.md#requirements), then build and register a trusted checkout:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.6.0
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
| `/role` | Select a saved working role for the current conversation, or `none` to clear it. Fresh conversations start with no role. |
| `/persona` | Select a saved communication style for this conversation. `off` clears it; `save` saves the selection as this device’s default; `reset` reapplies that default. |
| `/sandboxing` | Session network inspection. Writable mapping defaults are configured separately via `/policy-defaults <mode> fs_mmap_paths`. |
| `/server` | Connection, upload, configuration-sync and recovery actions. Opening the terminal menu sends nothing. **Check connection**, or bare `/server` outside TUI, reports the server URL and status without displaying the API key. |

Policy, subagent, display and persona pickers also provide explicit **Save defaults** and **Reload saved defaults** actions. Saving is not automatic. `/server status` is not a text command; select **Check connection** from the menu.

### Personas

Use `/persona <name>` or the picker to select a persona. Outside the terminal UI, bare `/persona` lists the current selection and available names. Ask the agent to create, edit, or delete a persona; the root-only `persona_manage` tool previews each change for approval and saves it immediately. Managing the library never switches the current selection.

Pilot adds a single style note at the start of a fresh conversation with a saved default, or when you select a persona, turn it off, or reset it. Active choices are part of the current branch; resuming doesn’t reapply the saved default. The style note is part of model context and session history, not a recurring system prompt. Context compaction may summarize or drop it; reselect if needed. Library edits and sync affect future selections, not notes already in a conversation. Subagents and policy reviewers do not inherit personas.

### Saved roles

Roles are reusable instructions for how to approach a task and what to deliver; personas only shape the voice. Use `/role <title>` or the picker to select a role for the root conversation, or `/role none` to clear it. The selection survives compaction and resume on its branch. Only the root’s `role_manage` tool can change the library, with interactive approval. The root and delegates can use `role_lookup` to inspect the library. See [Subagents](subagents.md#saved-roles) for selecting a role at spawn.

### Sandboxing switches

```text
/sandboxing network-inspection on
/sandboxing network-inspection off
```

Network inspection defaults **on** and resets with the session.

Inspection off preserves end-to-end HTTPS for clients incompatible with interception; it does **not** disable network sandboxing. Transport policy and recognized plaintext checks remain, while opaque traffic may receive transport-only forwarding.

`fs_mmap_paths` is a path policy for writing dirty shared mappings back to the host. It defaults to **ask_user**. Ordinary opens and writes do not prompt for mmap. Pilot checks `fs_mmap_paths` alongside read and write permissions when the kernel sends dirty pages, not at the `mmap()` syscall. Denials may surface during sync or Bash completion. Configure it with `/policy-defaults <mode> fs_mmap_paths`. **Host/cross-call SQLite WAL and backing-file lock coordination remain unsupported.** See [filesystem mediation](policy.md#filesystem-mediation) and [security](security.md).

## Tools and trust boundaries

- `read`, `edit`, and `write` authorize direct file effects. Bash uses a per-call FUSE mount and private network namespaces. The working directory is a starting location, not a filesystem boundary.
- Built-in fallbacks allow `fs_read` and `web_read`; writes, writable mappings, and other network areas ask the user. Saved defaults and explicit rules may differ.
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

All operational archive/configuration HTTP requires an authenticated stable **pi.server 0.5.x** version handshake. `/server login` stores credentials and enables automatic current-family departure archival, outside agent policy approval. It also wakes retained work; it does not backfill all history or enable configuration sync.

**Uploads contain complete native session JSONL across branches**, potentially including prompts, reasoning, credentials, tool results and file contents. Departure queues a capture obligation, not an immutable departure image. `/server upload [current|all]` reports **queued**, not uploaded; an independent worker captures, reconciles and retries. Root-only `archive_list` and `archive_fetch` browse history without importing/resuming it. Their POST requests require `web_write`; fetched transcripts are untrusted data. Read [server.md](server.md) before using these tools.

`/server sync` runs one foreground pass over saved display, subagent, policy and web-search configuration, the persona and role libraries, and GLOBAL policy rules. **Web-search credentials are included.** `sync on` additionally opts into startup checks; `sync off` disables those checks, not session archival. No periodic watcher, native Pi settings, connection credentials, IPC configuration, LOCAL/session/ONCE rules or unsaved overrides are synchronized. See [conflicts and recovery](server.md#saved-configuration-sync).

## Configuration locations

Pilot configuration lives in `~/.pilot`, independently of Pi's agent directory:

| Path | Purpose |
| --- | --- |
| `pilot.sqlite` | Persistent rules, saved roles, and private configuration-sync bases/pending/recovery/opt-ins |
| `policy-defaults.json`, `subagent-defaults.json`, `display-defaults.json` | Explicitly saved defaults |
| `personas.json`, `persona-default.json` | Saved persona library (synced) and local default ID (not synced) |
| `web-search.json` | Search providers and credentials |
| `credential-ipc.json` | Host D-Bus and Unix-socket passthrough |
| `server.json` | Server URL, API key and internal connection generation; never synchronized |
| `config-sync.enabled`, `config-sync.lock` | Startup-sync hint and pass lock |
| `server-archive/inbox/` | Durable capture obligations and wakeups |
| `server-archive/archive.sqlite` | Retained bytes, operations, receipts and coverage |
| `server-archive/downloads/` | Verified snapshots and large archive-list pages |
| `logs/<session-id>.log` | Sensitive approval audit records, not an exhaustive effect trace |

See [development and tests](installation.md#development-and-tests) before selecting verification gates. Run mounted filesystem/network integration on a prepared Linux host **outside pi.lot or another restrictive sandbox**.
