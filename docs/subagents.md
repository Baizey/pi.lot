# Subagents

pi.lot provides retained child-agent conversations with separate model context, explicit policy inheritance, optional MCP access, and bounded nested delegation.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start a retained conversation and return its job ID immediately. |
| `subagent_status` | Inspect the visible descendant tree or wait for selected active turns. |
| `subagent_message` | Steer a running turn or queue an ordered follow-up turn. |
| `subagent_stop` | Stop a job and all of its descendants. |

Jobs move through `queued`, `running`, `idle`, `failed`, `cancelled`, and `timed_out` states. An idle job retains its model conversation for follow-up work until it is stopped or the root session ends.

Active jobs appear above the TUI editor. Running, queued, idle, and attention counts appear in the footer.

## Session history

With a persistent root session, children save ordinary Pi JSONL sessions in the root's resolved session directory, including custom session-directory configuration. Each session keeps its child working directory and job ID, is named `Subagent: <role>`, and links to its immediate parent session. A `pilot.subagent` custom entry also records the parent agent ID.

Pi records the complete conversation, including system/tool declarations, user tasks and delivered steering/follow-ups, assistant messages, tool calls/results, usage, and compaction entries. The history is not limited to the bounded output shown by `subagent_status`, and remains on disk after the child is stopped or the root session ends. These files can be inspected with Pi's normal session tools. As with normal Pi sessions, setup alone does not create a file; writing begins with the first user or assistant message.

An ephemeral root (`--no-session`) keeps all child histories in memory too. Saving history does not persist live jobs or policy grants, and does not change shutdown or delegation authority.

## Child context

A child receives:

- Pilot's immutable subagent prompt;
- its role, task, requested reasoning, and capability summary;
- an optional parent-provided system prompt; and
- optional suggested `contextPaths`.

Ambient `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `SYSTEM.md`, skills, prompt templates, themes, and other extensions are not loaded into child sessions. `contextPaths` are prompt hints, not automatically copied file contents. A child must read them through policy-mediated tools.

## Capability model

Spawn capabilities have two forms.

### Policy-area capabilities

These are `fs_read`, `fs_write`, and all `web_*` policy areas. Selecting one snapshots the parent's complete effective allows and denials for that area into the child when the spawn is accepted.

- Snapshots are fixed; later parent policy changes do not update an existing child.
- Durable parent rules become child-session rules.
- `ONCE` authority is not copied by a broad area snapshot.
- Omitting an area leaves that area blank rather than denied. The child can request policy later.
- A nested snapshot cannot copy authority its immediate parent does not hold.

Policy-mediated `bash`, `read`, `edit`, `write`, and `web_search` are always available. Selecting a policy area changes initial policy state, not tool availability.

### Hard mechanism capabilities

- `mcp` supplies child-callable MCP tool definitions from the root session's current native MCP servers at child creation. No ambient MCP configuration is loaded into the child. With Pi's native background startup, servers still connecting at child creation may contribute no tools to that snapshot; later discovery does not widen the child. Indirect snapshots provide both codemode and tool search, with namespace hints derived only from their granted definitions and instructions available through `describeNamespace()`. Newly exposed tools do not automatically enter an existing child's conversation; calls still check the root's latest hidden state and tool schema at execution. Native aggregate resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) are root-only, not delegated because their server scope is not snapshotted per child.
- `delegate` exposes subagent tools and permits nested delegation.

A child cannot request these mechanisms later. A nested child cannot receive either mechanism unless its parent already has it.

Child codemode uses the public `createCodemodeExtension()` factory with `models: false`: no model globals are exposed, even with an `mcp` grant. Root codemode's authenticated, potentially billable `models.classify()` and `models.generateImages()` calls are [outside filesystem/network mediation](security.md#codemode-model-calls). In scripts, probe unknown tool availability with `'name' in tools`, not `typeof tools.name`.

MCP remains an opaque capability outside filesystem/network mediation. Granting `mcp` does not cause MCP effects to inherit Pilot's path or network policies. See [MCP security boundary](security.md#mcp).

## Reasoning and model selection

A spawn requests:

- `reasoning_skill`: `min`, `low`, `mid`, `high`, or `max`; and
- `reasoning_amount`: `low`, `mid`, or `high`.

Skill chooses a model from Pi's authenticated reasoning-model catalogue. Amount chooses its normal thinking level after model selection. Automatic selection uses catalogue cost and capability metadata:

- `min` favours estimated cost;
- `max` favours estimated performance; and
- `low`, `mid`, and `high` move across the estimated cost/performance frontier.

This initial ranker is a heuristic, not a benchmark claim.

Show active mappings:

```text
/subagent-defaults
```

Use automatic selection:

```text
/subagent-defaults auto mid
/subagent-defaults auto all
```

Pin one authenticated canonical model to a skill:

```text
/subagent-defaults <provider>/<model> high
```

Persist or reload mappings:

```text
/subagent-defaults save
/subagent-defaults reset
```

Mappings are stored in `~/.pilot/subagent-defaults.json`. A spawn snapshots the active mapping for its requested skill. Later default changes do not mutate accepted jobs.

An exact mapping must be authenticated and available when used, and the model must support a normal reasoning amount. Unsupported requested amounts clamp to a supported `low`, `medium`, or `high` thinking level without changing the selected model.

## Policy requests from children

Each child is a policy principal in one ancestry tree. See [Policy agent authority](policy.md#agent-authority-and-approvals) for the full flow.

In summary:

- an explicit denial is terminal;
- a covering ancestor allow can route the request to a bounded ephemeral reviewer;
- otherwise the root fallback chooses user review, model review, allow, or deny;
- derived scope and lifetime cannot exceed the source authority; and
- session grants apply only along the requesting branch, not to siblings.

Policy reviewers receive bounded task and operation context and have only a structured decision tool. Failure or stale authority denies the pending operation.

## Work-tree visibility

The root agent can inspect and manage the whole tree. A child can inspect, message, and stop only its descendants; it cannot manage itself, ancestors, siblings, or unrelated jobs.

Stopping a job stops descendants first. Root-session shutdown aborts all active children before policy and MCP resources close.

## Current boundary

Subagents are independent Pi SDK sessions, not separate operating-system processes. They share the trusted root Pi process and policy runtime while retaining separate model context and principal-specific policy state.

Live jobs and policy state are not persisted across root-session shutdown; conversation history follows the [session-storage rules](#session-history) above. See [Security model and limitations](security.md).
