# Subagent system

## Purpose

This file is the normative specification for subagent creation, communication, resource authority, policy delegation, and lifecycle.

## Core model

Every agent is an independent policy principal in one recursive work and authority tree:

```text
User
└── Root agent
    └── Subagent
        └── Sub-subagent
```

The user is the authority apex and may mint any permission. This does not make unknown operations automatically allowed. The root agent receives the permissions represented by the active user policies, and anything outside those permissions must ultimately be decided by the user.

A positive grant held by an agent is inherently delegatable to its descendants. A derived grant may narrow access type, scope, and lifetime, but may never broaden any of them. No agent may grant authority it does not hold.

Resource ceilings and policy grants answer different questions:

- the spawn resource ceiling determines what a child may ever access or request; and
- the policy grant chain determines whether the child currently holds authority for a concrete operation.

An operation is allowed only when both permit it. A policy grant can never override a resource-ceiling denial.

## Execution model

- Every subagent is an independent in-memory Pi session with separate model context and conversation state.
- Jobs form one recursive tree. Any agent with delegated subagent authority may organize descendants within its ceiling.
- `sync` waits for completion unless work must return to the parent for a policy decision.
- `async` returns a job ID immediately.
- `conversation` retains one child session between messages until stopped.
- Children inherit the invoking model, provider and authentication context, thinking level, and working directory unless explicitly overridden.
- Jobs, conversations, and ephemeral grants are not persisted across root-session shutdown.

## Spawn contract

A spawn controls the child's instructions, initial task, execution settings, and resource authority.

### System prompt

A child's system prompt has ordered, explicit ownership:

1. an immutable platform-owned base prompt;
2. a generated description of the child's role, resource ceiling, and available mechanisms; and
3. an optional parent-provided system prompt.

The parent-provided prompt may specialize the child's behavior but cannot replace the platform prompt or grant authority. Policy enforcement must never depend on the model following a prompt.

### Initial task and context

The delegated task is delivered as the child's initial user message. Relevant context may be supplied as:

- bounded copied text;
- summaries or results from earlier work; and
- normalized path references with a description of their relevance.

Copied context is information the parent has deliberately passed to the child. A referenced path is only a hint and grants no filesystem authority. Reading it remains subject to the child's resource ceiling and policy grants.

### Execution settings

The spawn may select:

- run mode;
- model and thinking level;
- working directory;
- per-turn timeout; and
- bounded additional instructions and context.

A working directory or context path does not itself grant access to that path.

### Resource ceiling

The parent must define a finite child resource ceiling covering:

- filesystem read;
- filesystem write;
- web read;
- web write and other mutating network access;
- subagent delegation; and
- explicitly selected MCP tools.

Each enabled resource must have a normalized scope. Anything not enabled or outside the declared scope is denied without escalation. Convenience profiles such as `none`, `read-only`, and `read-write` may be exposed, but they must compile into explicit resource rules.

A child ceiling must be a subset of every applicable parent ceiling. An invalid spawn is rejected rather than silently widened or narrowed. Filesystem read authority does not imply write authority, web read does not imply web write, and access to a mechanism such as Bash does not imply authority over resources reachable through it.

MCP calls are a separate explicit capability. The runtime may mediate invocation by server and tool name, but it must not claim that opaque MCP effects obey filesystem or web policy unless those effects are independently mediated.

### Initial delegated grants

At spawn, a parent may derive initial child grants from authority the parent already holds. The requested access type, scope, and lifetime must fit both the parent's grants and the child's resource ceiling.

Initial grants avoid unnecessary policy interruptions for expected work. Resource access that is inside the ceiling but was not initially granted may be requested later. Resource access outside the ceiling is denied and cannot be escalated.

## Work-tree authority and communication

- A caller outside a subagent job may inspect and manage the whole tree.
- A subagent may inspect, message, or stop only its descendants.
- A subagent may not manage itself, ancestors, siblings, or unrelated jobs.
- Parentage is immutable.
- Stopping a job stops descendants before the job itself.
- Results flow upward through spawn results, status, and conversation replies.

Work communication and policy communication are separate planes.

### Work plane

- The parent sends the initial task and conversation follow-ups.
- The child returns bounded progress, output, and errors.
- Only conversation jobs retain a model session while idle.
- A child cannot send unsolicited work messages outside its ancestry.

### Policy control plane

- A held operation creates a structured policy request rather than an ordinary work message.
- Policy requests move only through the authority ancestry.
- Policy decisions use a structured decision operation and cannot be encoded as unvalidated conversation text.
- A synchronous parent waiting for a child must be released to consider a pending request; the system must not perform re-entrant parent model execution.

## Policy state

Policy evaluation has three distinct outcomes:

- a matching positive grant;
- a matching explicit denial; or
- no matching policy.

These outcomes must remain distinct:

- a positive grant is authority that may be exercised or delegated;
- an explicit denial is terminal for the matching operation and does not bubble upward; and
- a policy miss may be escalated.

The root agent's initial authority is the current user policy state:

- default or stored `allow` policies are grants held by the root agent;
- default or stored `deny` policies are explicit denials; and
- `ask_user` or an unmatched scope represents a policy miss.

Policy state is principal-specific. Grants, denials, tool-call state, and agent-session state are never implicitly shared between siblings or copied to descendants.

## Policy request resolution

When an agent lacks a local grant for an otherwise ceiling-permitted operation, the operation is suspended and a request is routed to its immediate parent.

A parent decision is one of:

- `deny`: reject the pending operation;
- `allow`: derive authority from a covering grant held by the parent; or
- `escalate`: forward the unchanged request to the parent's parent.

`escalate` is the policy term for leaving the decision to a higher authority.

The available decisions depend on the parent's policy state:

| Parent state | Valid decisions |
| --- | --- |
| Matching positive grant | `deny`, `allow`, `escalate` |
| No matching policy | `deny`, `escalate` |
| Matching explicit denial | `deny` only |

A parent may escalate even when it holds sufficient authority. This lets an agent defer an unusually sensitive or uncertain decision to a higher authority.

An agent-issued `allow` must be rejected unless the runtime can construct a valid grant lineage from authority held by that agent. The derived grant must remain within the pending operation, requested scope, child resource ceiling, source grant, and permitted lifetime.

When an ancestor allows an escalated request, the runtime derives the narrowed authority down the recorded escalation path. Earlier escalations authorize forwarding that exact request, so the decision need not be presented to the same agents again while returning downward. Every edge remains represented in the grant lineage and audit record.

Only a request that reaches the root agent without a covering allow or deny policy is presented to the user. A user allow creates or updates root-agent authority according to the chosen scope and lifetime, then derives the narrower grant required by the pending descendant operation. Known in-policy descendant work can therefore be resolved by an authorized ancestor without repeatedly prompting the user.

Denial, expiry, cancellation, malformed input, unavailable required decision owner, job stop, or root-session shutdown releases the held operation with a denial. A required parent must not be silently skipped. A standing grant created at spawn may resolve work after its issuing parent's model turn has ended, but it must still have a valid authority lineage.

## Policy requests and audit data

A pending request is bounded and contains at least:

- stable request ID;
- requesting principal and ancestry;
- current routing owner;
- originating tool-call ID;
- resource and access type;
- normalized concrete target;
- command and purpose when produced by Bash;
- requested and proposed scopes;
- requested lifetime;
- deadline; and
- accumulated escalation rationales.

No agent may widen the operation or proposed scope while escalating it. Human prompts must identify the requesting job, role, ancestry, concrete operation, scope, lifetime, command purpose, and collected rationales.

Audit records include the grant lineage, requester, ancestry, each decision authority, normalized operation and scope, lifetime, reasons, and terminal outcome.

## Grant lifetimes

Lifetimes apply to the principal holding the grant and must remain bounded by the source grant.

### `ONCE`

- Applies to one policy-mediated tool call, including all matching operations performed by that call.
- Behaves as a single consumable authorization when delegated.
- May be transferred down the chain for the exact pending descendant tool call.
- Must not be copied, reused by the issuer, or delegated to multiple calls.

### `SESSION`

- Applies only to the named principal within the active root orchestration session.
- May derive child-session or `ONCE` grants whose validity does not exceed the source session.
- A retained principal and its grant metadata may remain while admitted descendants require their already-issued authority, even if its model turn has completed.

### `LOCAL` and `GLOBAL`

- Represent durable user policy available to the root-agent policy domain locally or globally.
- Permit the root agent to issue repeated narrower descendant grants while the durable policy remains valid.
- Do not make anonymous ephemeral subagents durable policy identities.

If the user selects `LOCAL` or `GLOBAL` while resolving a descendant request, the durable grant belongs to the root-agent policy domain. The current child receives a derived `ONCE` or session-bound grant. Durable subagent grants require an explicitly named persistent principal, which is outside the anonymous job model.

An agent may always choose a narrower scope or shorter lifetime. It may never issue a broader scope or longer effective lifetime than its source authority.

## Resource realms

Filesystem policy distinguishes task resources from the execution substrate so useful computation does not require exceptions that weaken read-only behavior.

### Host and task resources

Repositories, project dependencies, user files, configuration, credentials, lockfiles, and persistent caches are host or task resources. They obey the child resource ceiling and grant chain.

A read-only child cannot modify project lockfiles, generated files, or caches inside the project. If a workflow genuinely requires those writes, the child must receive a broader explicit ceiling through a new spawn or an audited resource amendment.

### Trusted execution substrate

The platform may expose a narrow immutable runtime required to launch approved mechanisms, including interpreters, loaders, libraries, and essential certificates. This is platform-owned execution support, not a child grant over arbitrary host files.

Filesystem `none` therefore means no host or task filesystem access. It cannot mean no filesystem syscalls while still providing Bash, Node, Python, or similar runtimes. A mode requiring literally no filesystem access must expose no filesystem-dependent execution mechanism.

The execution substrate must be minimal and must not use a broad host path exception as a substitute for a controlled runtime image.

### Private ephemeral scratch

Each job may receive private disposable writable storage for temporary files and runtime caches. Common home, temporary, and cache environment variables should be redirected there where practical.

Scratch access does not permit host or project writes, is not shared implicitly between principals, and is destroyed with the owning job or root session. It allows calculations and interpreter startup without treating runtime cache writes as exceptions to read-only task authority.

## Delegation and mechanisms

A mechanism and the authority exercised through it are separate:

- Bash may be exposed while filesystem and network effects remain independently mediated.
- Subagent delegation requires both the mechanism and sufficient resource ceiling to create the requested child.
- A nested child cannot receive a ceiling or initial grant broader than its parent can delegate.
- MCP exposure is constrained by explicit server and tool selection and remains opaque unless separately mediated.

Concurrency, depth, retained jobs, pending requests, held workers, and retained output must have configurable finite limits. A synchronous parent waiting for a child must not consume the capacity required for that child or its admitted descendants to run. Policy-waiting jobs do not consume model-turn concurrency, but pending operations and retained resources remain separately bounded.

## Lifecycle and failure behavior

- `waiting_policy` is active but does not consume model-turn concurrency.
- Timeouts apply per child turn, and policy waits have independent bounded deadlines.
- Unsupported capabilities, invalid ancestry, unknown jobs, scope widening, lifetime widening, and resource escalation fail closed.
- Root-session shutdown first denies pending policy requests and stops the subagent tree, then closes MCP and policy resources.
- Child sessions, pending operations, listeners, workers, and ephemeral scratch are released on every terminal path.
- Subagents run in the trusted Pi process rather than separate operating-system processes.

## Required verification

Tests must prove that:

- siblings cannot inspect, message, stop, or exercise one another's grants;
- a child cannot grant authority it does not hold;
- every descendant grant has a valid, no-broader lineage to root-agent authority;
- a spawn resource denial cannot be overridden by an ancestor or user policy allow;
- read-only children cannot modify host or task resources while approved runtimes can use private scratch;
- known root-agent allows can resolve descendant requests without opening the user UI;
- known explicit denials do not bubble to the user;
- policy misses reach the user only after every required intermediate agent escalates them;
- agents without covering authority are not offered or accepted as `allow` decision authorities;
- an ancestor allow returns down the exact recorded escalation path without widening scope;
- `ONCE` grants cannot be duplicated, reused, or exercised by a sibling;
- session grants and derived grants expire at the correct principal and root-session boundaries;
- persistent `LOCAL` and `GLOBAL` policy remains rooted in a durable principal rather than anonymous jobs;
- nested synchronous delegation makes progress at the configured concurrency limit;
- pending operations resume only after a valid decision and deny on every cancellation path; and
- repeated nested implementation and review workflows leave no sessions, workers, scratch storage, or policy requests after shutdown.
