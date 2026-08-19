# Subagent system

## Purpose

This file is the normative specification for subagent behavior, authority, policy mediation, and lifecycle.

## Execution model

- Every subagent is an independent in-memory Pi session with separate model context and conversation state.
- Jobs form one recursive work tree. The top-level agent is its root, but any agent with `delegate` may organize its own descendants.
- `sync` waits for completion unless a policy request must be returned to the parent. `async` returns a job ID immediately. `conversation` retains one child session between messages until stopped.
- Children inherit the invoking model, provider/authentication context, thinking level, and working directory unless explicitly overridden.
- Jobs and conversations are not persisted across root-session shutdown.

## Tree authority

- A caller outside a subagent job may inspect and manage the whole tree.
- A subagent may inspect, message, or stop only its descendants. It may not manage itself, ancestors, siblings, or unrelated jobs.
- `subagent_status` without IDs lists only jobs visible to the caller.
- Stopping a job stops all descendants before the job itself.
- Parentage is immutable. Results flow upward through spawn results, status, and conversation replies.

These rules apply recursively; no special organizer role is required.

## Toolkits and scheduling

Children default to no tools. Toolkits are explicit:

- `bash` exposes pi.lot's policy-mediated Bash implementation;
- `mcp` exposes MCP tools enabled by the root session and is outside filesystem/network policy mediation; and
- `delegate` exposes subagent orchestration.

A nested child cannot receive a toolkit outside its parent's toolkit ceiling. Toolkits expose mechanisms; they do not themselves grant filesystem or network authority.

Concurrency, depth, retained jobs, pending policy requests, and retained output must have configurable finite limits. A synchronous parent waiting for a child must not consume the capacity required for that child or its admitted descendants to run. Policy-waiting jobs do not consume model-turn concurrency, but their held workers and requests remain separately bounded.

## Policy principals and delegation

The root agent and every subagent job are distinct policy principals.

- Tool-call, agent-session, and persistent policy state is never implicitly shared between principals.
- Every policy decision names its subject principal. A longer lifetime never broadens that subject to siblings or descendants.
- A parent may delegate scoped filesystem or network grants to a child only from authority marked delegatable to that parent.
- A delegated grant records access type, normalized scope, and whether the child may delegate a subset further.
- Model-issued policy approval is never delegatable.
- An actor's `ONCE` policy lasts for one policy-mediated tool call, including all matching operations performed by that call.

Anonymous jobs have no durable identity. Persistent grants for subagents require an explicitly named policy profile; they must not be approximated by sharing one session policy across jobs.

## Policy routing

An unmatched operation uses the requesting principal's configured default:

- `allow` allows according to that principal's policy configuration;
- `deny` denies immediately;
- `ask_user` enters hierarchical human escalation; and
- `ask_llm` asks a configured policy authority.

### `ask_user`

A child request is offered to its immediate live work parent first. Agent parents may:

- `deny`, resolving the operation as denied; or
- `escalate`, forwarding the unchanged request to the next live ancestor with optional rationale.

Agents cannot allow an `ask_user` request. At the top of the live work tree, escalation opens the human policy UI. If a parent has ended, routing skips to the nearest live ancestor. Missing UI, cancellation, malformed input, timeout, or shutdown denies the request.

Human decisions retain the policy lifetimes valid for the selected subject. Human prompts must identify the requesting job and role, ancestry, Bash command and purpose, actual normalized operation, proposed scope, and any scope widening.

### `ask_llm`

`ask_llm` delegates policy-issuing authority to a user-configured policy adjudicator, not implicitly to the requester's work parent. The adjudicator may be implemented as a dedicated subagent, but it is part of the policy authority plane rather than the work tree.

- It is configured by the user and cannot be spawned, messaged, or replaced through normal subagent tools.
- It receives a bounded structured request and has no Bash, MCP, or delegation tools.
- It may return `allow`, `deny`, or `escalate` with a scope and reason.
- It may mint authority not held by the requester or its work ancestors.
- Every agent-issued allow is forcibly `ONCE`, bound to the requesting principal and current tool call, non-delegatable, and never written to agent-session or persistent policy state.
- The model does not choose a lifetime. The policy runtime stamps `ONCE` after validating the response.
- Enabling `ask_llm` without a valid adjudicator is a startup error. Provider failure, malformed output, cancellation, or timeout fails closed.

A work parent may deny or add rationale before forwarding an `ask_llm` request, but it gains no approval authority unless separately configured as the adjudicator.

## Pending decisions

A policy miss creates a bounded request containing a stable request ID, requester principal, ancestry, tool-call ID, access type, normalized target, command purpose, proposed scope, and deadline.

- The original filesystem or network operation remains held while the request is pending.
- The requesting job enters `waiting_policy`; this state is active but not terminal.
- If a synchronous parent is blocked waiting for that job, the spawn/status call returns an interim pending-policy result so the parent can decide or escalate without re-entrant model execution.
- Parent decisions use a dedicated subagent policy-decision tool and are accepted only from the request's current routing owner.
- An allow is installed in the original tool call's isolated `ONCE` policy state before the held operation resumes.
- Denial, expiry, cancellation, job stop, or session shutdown releases the held operation with a deny result.
- Human prompts remain serialized through the root UI decision queue.

## Lifecycle and failure behavior

- Root-session shutdown first denies pending policy requests and stops the subagent tree, then closes MCP and policy resources.
- Timeouts apply per child turn; policy waiting has an explicit bounded deadline.
- Unsupported capabilities, invalid ancestry, unknown jobs, scope escalation, and toolkit escalation fail closed.
- Job output and status rendering are bounded. Subagents run in the trusted Pi process rather than separate operating-system processes.
- Audit records include requester, ancestry, decision authority, normalized operation and scope, lifetime, reason, and terminal outcome.

## Required verification

Tests must prove that:

- siblings cannot inspect, message, stop, or exercise one another's jobs or policies;
- nested synchronous delegation makes progress at the configured concurrency limit;
- a policy granted to one principal is unavailable to siblings and undelegated descendants;
- delegated grants cannot exceed the parent's delegatable authority;
- `ask_user` permits only deny/escalate before the human decision;
- every `ask_llm` allow is actor-local `ONCE`, including under malformed adjudicator output;
- pending operations resume only after a valid decision and deny on every cancellation path;
- async parent disappearance routes safely to a live ancestor; and
- repeated nested implementation and review workflows leave no sessions, workers, or policy requests after shutdown.
