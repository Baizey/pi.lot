# Subagents

pi.lot provides retained child-agent conversations with separate model context, explicit policy inheritance, optional MCP access, and bounded nested delegation.

## Tools

| Tool | Arguments and behaviour |
| --- | --- |
| `subagent_spawn` | Required: `task`, `role`, `reasoning_skill`, `reasoning_amount`. Optional: `capabilities` (default `[]`), `cwd`, `timeoutSeconds` (default 900; range 1–3,600), `systemPrompt`, `contextPaths`. Returns a job ID without waiting for completion. |
| `subagent_status` | Optional `jobIds` and `waitSeconds` (default 0; range 0–3,600). Omit IDs or pass `[]` for the invoking agent's descendant tree. Waiting ends when all selected jobs are idle/terminal or the wait budget expires; check their returned states. |
| `subagent_message` | Required `jobId`, `task`. Steers a running turn when possible; otherwise queues an ordered follow-up. An idle job starts a new turn in the retained conversation. |
| `subagent_stop` | Required `jobId`. Stops that job and its descendants, descendants first. |

`cwd` defaults to the invoking tool's working directory; relative values resolve from it. Relative `contextPaths` resolve from the child's `cwd`. Give a self-contained task and explicit file ownership when delegating concurrent edits: children share the host files, not isolated worktrees.

Jobs are `queued`, `running`, `idle`, `failed`, `cancelled`, or `timed_out`. Idle jobs retain their conversations; failed, cancelled, and timed-out jobs reject follow-ups. Spawn success does not guarantee model/session setup or task success. A parent's failure/timeout does not automatically stop its descendants; use `subagent_stop` to cancel the subtree.

Returned child answer text is capped at about 50,000 characters per job; status is not a complete transcript.

## Session history

With a persistent root, children save ordinary Pi JSONL sessions in the root's resolved session directory, including custom session-directory settings. Sessions are named `Subagent: <role>`, retain the child's working directory, and link to their immediate parent. Inspect them with Pi's normal session tools.

Files retain full conversation/tool history, including instructions and delivered steering—not just status previews. They survive child stops and root shutdown and can contain sensitive data. File creation starts with the first user or assistant message; storage failures fail the child rather than silently switching to memory-only history.

An ephemeral root (`--no-session`) keeps child histories in memory. In either mode, live jobs and child policy grants are not restored after root-session shutdown.

Saved server configuration enables current-family background archival on graceful root-session shutdown. After local teardown—even if teardown reports failure—the root queues its cached source descriptor; an independent worker later captures discoverable descendants and persistent policy reviewers. `/server upload current` and explicit `all` use the same queue and report queued, not uploaded. Complete JSONL is sent outside agent policy approval, potentially after Pi exits; `/server logout` pauses retained work. The descriptor is not an exact departure image, and uncaptured files can still be lost. See [Server archive](server.md) for lifetime limits, classification, variants, and recovery.

## Child context

A child receives Pilot's subagent instructions plus its role, task, reasoning/capability summary, and any supplied `systemPrompt` or `contextPaths`—not the parent's conversation. Ambient `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `SYSTEM.md`, skills, prompt templates, themes, and other extensions are not loaded. Include necessary instructions explicitly. `contextPaths` are hints, not copied file contents; the child must read them through policy-mediated tools.

## Capability model

Spawn capabilities have two forms.

### Policy-area capabilities

These are `fs_read`, `fs_write`, and all `web_*` policy areas. Selecting one snapshots the parent's complete effective allows and denials for that area into the child when the spawn is accepted.

- Snapshots are fixed; later parent policy changes do not update an existing child.
- Durable parent rules become child-session rules.
- `ONCE` authority is not copied by a broad area snapshot.
- Omitting an area leaves that area blank rather than denied. The child can request policy later.
- A nested snapshot cannot copy authority its immediate parent does not hold.

Policy-mediated `bash`, `read`, `edit`, `write`, and `web_search` are always available, even with `capabilities: []`. Selecting a policy area changes initial policy state, not tool availability. `archive_list` and `archive_fetch` remain root-only regardless of capabilities; the parent must provide any needed archive evidence explicitly.

### Hard mechanism capabilities

- `mcp` snapshots the root's currently exposed native MCP tools when the child session starts, not when a queued spawn is accepted. No child MCP configuration is loaded. Servers still connecting may contribute no tools; later discovery does not widen an existing child. Spawn a new child after discovery if needed. Withdrawn/hidden tools and changed schemas fail at execution rather than using stale definitions.
- `delegate` exposes the four subagent tools and permits nested delegation.

A child cannot request these mechanisms later, and cannot grant a nested child a mechanism it lacks. An `mcp` grant is not a per-tool allowlist: a new nested session takes its own snapshot from the root's then-current catalog. Aggregate MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) remain root-only.

Indirect MCP tools are discoverable through codemode/tool search; use `describeNamespace()` for server instructions. Child codemode exposes no model globals. In scripts, probe unknown tool availability with `'name' in tools`, not `typeof tools.name`.

Root and child codemode share a limit of two live workers; a parent script waiting for a child still occupies a slot, and cancellation releases it only when the worker exits. Further scripts fail immediately at capacity. This is not a two-subagent limit. See [codemode budgets and worker limits](policy.md#finite-codemode-timeouts).

MCP effects are opaque and **outside filesystem/network mediation**; policy-area grants do not restrict them. See [MCP security boundary](security.md#mcp).

## Reasoning and model selection

A spawn requests:

- `reasoning_skill`: `min`, `low`, `mid`, `high`, or `max`; and
- `reasoning_amount`: `low`, `mid`, or `high`.

Skill chooses from Pi's authenticated reasoning models; amount maps to `low`, `medium`, or `high` thinking after selection. All skills default to `auto`: `min` favours cost, `max` estimated performance, and the intermediate skills trade off both using catalogue metadata. This is a heuristic, not a benchmark or a guarantee of distinct models for each skill.

| Command | Effect |
| --- | --- |
| `/subagent-defaults` | Show active mappings and resolve `auto` choices. |
| `/subagent-defaults auto mid` | Use automatic selection for `mid`; use `all` for every skill. |
| `/subagent-defaults <provider>/<model> high` | Pin an authenticated canonical model to `high` (or another skill/`all`). |
| `/subagent-defaults save` | Persist active mappings. |
| `/subagent-defaults reset` | Reload saved mappings. |

Changes affect the current session until `save`; `reset` reloads `~/.pilot/subagent-defaults.json`, or restores all skills to `auto` if no file exists. A spawn snapshots its skill's mapping; later default changes do not mutate accepted jobs or retained conversations.

An exact model must be authenticated, available, and support a normal reasoning amount when used; otherwise the job fails without substituting another model. Unsupported requested amounts clamp to a supported `low`, `medium`, or `high` thinking level without changing models. Inspect status for the resolved model and thinking level.

## Policy requests from children

Each child is a policy principal in one ancestry tree. See [Policy agent authority](policy.md#agent-authority-and-approvals) for the full flow.

An explicit denial is terminal. Otherwise, a covering ancestor allow can route the request to a bounded reviewer; without ancestor authority, the root fallback chooses user review, model review, allow, or deny. Derived scope/lifetime cannot exceed source authority, and session grants stay on the requesting branch, not siblings. Reviewers have only a structured decision tool; failure or stale authority denies the operation.

## Turn and wait budgets

`timeoutSeconds` is an execution budget for **each turn**, not a lifetime for the conversation; follow-ups get fresh budgets. User and model policy approval waits pause it without resetting the remainder. Each approval still has an independent [300-second deadline](policy.md#approval-waits-and-execution-budgets), including queued user prompts.

`subagent_status` pauses its wait budget while a selected active job awaits approval. If a parent is waiting in that call, its turn budget pauses too. Background descendants and unselected siblings do not automatically pause the parent. Cancellation still works during approval waits. Independent model, subprocess, application, and server deadlines are not extended.

## Work-tree visibility

The root agent can inspect and manage the whole tree. A child can inspect, message, and stop only its descendants; it cannot manage itself, ancestors, siblings, or unrelated jobs.

Root-session shutdown aborts all active children before policy and MCP resources close.

## Current boundary

Subagents are independent Pi SDK sessions, not separate operating-system processes. They share the trusted root Pi process and policy runtime while retaining separate model context and principal-specific policy state.

See [Security model and limitations](security.md).
