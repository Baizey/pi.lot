# pi.server archive and configuration sync

pi.lot archives native Pi session JSONL to [pi.server **0.3.x**](https://github.com/Baizey/pi.server/releases/tag/v0.3.0) and provides root-only tools to browse archived history. Publication runs in an independent background worker. Complete files are sent, not just the selected branch or tool previews. **They can contain prompts, reasoning, credentials, tool results, and file contents, and upload is outside agent policy approval.**

## Connection and credentials

```text
/server
/server login
/server logout
```

- `/server login` asks for an HTTP(S) origin and API key in separate dialogs. It atomically saves them, with an internal connection generation, in `~/.pilot/server.json` (plaintext, mode 0600). Canceling either dialog preserves the existing configuration. Login does not validate the key or server version; it wakes retained background work, which may contact the server.
- Use an origin without a path, embedded credentials, query, or fragment. Prefer HTTPS: HTTP sends the key unencrypted. Requests reject redirects and retain normal certificate verification.
- `/server` displays the saved URL and **API key**, then checks `GET /v1/version`. Do not share its output. Supported versions are stable `0.3.x`, not prereleases. Background publication validates the archive binding and capabilities, not this status check.
- `/server logout` removes local authorization and wakes the worker to revalidate it. It does not revoke the token, delete sessions, or clear queued work, the journal, or downloads. Already-dispatched requests cannot be recalled.

**Any saved server configuration enables automatic archival**, including configuration saved before this feature existed. Review the destination before leaving credentials configured. Do not pass credentials as command arguments.

A new `/server` command or session shutdown cancels the previous foreground command request and suppresses stale notifications. This does **not** cancel committed background work or undo remote effects.

## Saved configuration sync

```text
/server sync       # One foreground pass
/server sync on    # One pass, then opt in to checks at session startup
/server sync off   # Disable automatic configuration checks on this computer
```

Requires the additive **`config_sync_v1`** capability, not just a `0.3.x` version string. Login and pre-existing connections **do not enable configuration sync**. `sync on` approves the currently authenticated origin and complete server/namespace/history-generation binding. A changed binding pauses automatic sync until explicitly approved again. Logout removes request authorization but retains sync state and the previous opt-in; a later login must verify the approved destination.

**This sends saved web-search credentials and can change authorization on other devices.** Trust the server and everyone who can write its namespace. HTTPS protects transit; configuration is not end-to-end encrypted. Manual sync and explicitly enabled startup checks are trusted host-management operations, outside agent policy approval. Already-dispatched requests cannot be recalled.

Exactly five independently revisioned items synchronize:

| Item | Local source |
| --- | --- |
| Display defaults | `~/.pilot/display-defaults.json` |
| Preferred subagent models | `~/.pilot/subagent-defaults.json` |
| Policy-area defaults | `~/.pilot/policy-defaults.json` |
| Web-search configuration, including keys | `~/.pilot/web-search.json` |
| `GLOBAL` policy rules | Logical rows in `~/.pilot/pilot.sqlite`, not the database file |

Connection credentials/generation (`server.json`), credential IPC, native Pi settings, instructions, prompts, skills, themes, extensions, packages, session overrides, `LOCAL`/session/once-only grants, and archive state are **not** synchronized. Missing JSON files or an empty GLOBAL bundle represent unset/reset state. Files must be valid, bounded, regular non-symlink JSON sources; imports use private atomic replacement.

Each item freezes its content, hash, base, timestamp, and change identity **before** the cheap optimistic check. When needed, one exchange submits that same snapshot and receives authoritative current state. Retries after uncertain responses/restart reuse the exact persisted request. Content/revisions, not clocks, determine winners; identical content creates no revision. An initially unbound client accepts existing server state. Known stale ordinary changes lose to current server state. GLOBAL rules merge changes relative to the accepted base, preserving unrelated additions/deletions; conflicting edits to the same rule retain current server state.

A newer local save during HTTP is not overwritten: application is deferred and that edit remains for the next pass. LOCAL primary-key collisions remain local, never get overwritten by imported GLOBAL rules, and do not export false GLOBAL deletions. Removing a local mask can reveal the cached GLOBAL rule even when the optimistic check needs no exchange.

Imported saved defaults and GLOBAL rules apply in **new/reloaded sessions**; the current session and existing child capability snapshots are not silently reset. Web search reads its saved configuration on use. Unavailable, unauthenticated, or reasoning-ineligible preferred subagent pins use the existing skill-appropriate `auto` selector locally, with visible fallback metadata. The preferred pin remains saved/synced unchanged, and is used exactly again when eligible. No eligible model fails clearly; cancellation and registry failures are not hidden.

Automatic checks run at session startup without blocking session use. There is **no periodic polling, save watcher, departure HTTP, or detached configuration worker**. Use `/server sync` after saved changes and before switching computers when immediate propagation matters. Shutdown cancels session-owned configuration HTTP and retains pending work; it does not wait for configuration transfer.

### Configuration durability and recovery

Private `config_sync_*` tables in `~/.pilot/pilot.sqlite` hold origin/binding-scoped canonical bases, actual materialized GLOBAL snapshots, frozen pending exchanges, opt-ins, and recovery candidates. GLOBAL imports and their synchronization acknowledgements share one SQLite transaction. Before JSON replacement/deletion, a durable application checkpoint records the received state, approved local write-back snapshot, and actual canonical target. An interrupted attempt retries the original unchanged request. If the local file already equals the latest winner, it can be acknowledged without replacement; if it still equals the approved snapshot, guarded reapplication is safe. Otherwise it reports `needs_recovery` and retains the file, pending identity, and checkpoint without acknowledging a new base or automatically re-uploading a possible old import. `~/.pilot/config-sync.enabled` is only an opt-in lookup hint; the database stores the approved bindings. `config-sync.lock` serializes passes across local processes.

For **interrupted JSON application only**, choose explicitly:

```text
/server sync recover display-defaults local
/server sync recover web-search server
```

Use any of the four JSON item keys, not `global-policies` (whose import/acknowledgement is transactional). `local` freezes the selected local file before checking, reconciles the original pending identity, then durably creates and sends a **new** operation based on current server state. Normal concurrent-conflict rules still apply; this is not a forced remote overwrite. `server` privately preserves the selected local snapshot and accepts current server state only if that selected file has not changed in flight. Another local save is never substituted into the selected upload or silently overwritten. Repeated interruption retains its checkpoint and may require another explicit choice.

These choices are exceptional recovery, not a dialog or extra negotiation for ordinary configuration conflicts. Losing or partially merged candidates remain private in `config_sync_recovery.snapshot`; there is no general conflict-list/restore UI yet. These records **can contain web-search secrets**. Back up rather than delete the database; it also holds local policy rules. Use a trusted host SQLite tool outside the mediated Bash filesystem for recovery, and do not share dumps. Configuration payloads and credentials are not included in synchronization diagnostics.

Content is limited to **256 KiB per item**, with a separate **520 KiB wire-envelope cap**. The journal has a **64 MiB logical content budget**, at most **1,024 destination/item rows**, **10,000 recovery candidates**, and **1,024 automatic-origin opt-ins**. Capacity failure retains existing work; it never silently evicts unresolved evidence. These are not physical SQLite/WAL, disk, or RSS limits. Server history/receipt quotas also fail explicitly. Archive limits and journals remain separate.

## Automatic departure handoff

Graceful quit, reload, new session, resume, and fork queue the outgoing **current session family** after Pilot's local child/runtime teardown. A teardown failure warns separately but does not prevent queueing a usable cached source. Unconfigured and ephemeral (`--no-session`) sessions are skipped. Successful automatic queueing is quiet; repeated shutdown hooks do not enqueue the same departure twice.

The departure path uses source identity and paths cached after session identity registration. It writes a small durable descriptor and launches/wakes the worker: **no transcript-directory scan, transcript parsing/hashing/copying, version check, HTTP, or upload drain**. The former ten-second upload deadline no longer applies. Launcher observation is bounded to one second; unrelated teardown and unresponsive filesystem calls are not given a hard overall deadline.

The descriptor is a **capture obligation, not an exact departure image**. The worker later reads the latest stable persisted files. Deleting or rewriting a file before capture can make the older bytes unavailable. Once captured into the journal, exact bytes survive source deletion and remain until remotely covered or preserved. Forced exits before the hook can bypass queueing.

## Worker lifetime and retries

The on-demand detached worker uses external **Node >=22.19**, production `jiti`, compatible `better-sqlite3`, and util-linux `flock`. Startup/configuration validates the runtime; departure does not retry that validation. Pi's executable need not itself be Node. See [installation](installation.md#requirements).

The worker owns its lifetime, not the departing session's cancellation signal or managed-process group. It can finish and retry after ordinary Pi exit. While retryable work exists, it stays alive through persisted backoff. Scheduler sleeps are capped at five seconds before checking new work/configuration; an in-progress capture, directory replay, or HTTP attempt can delay the next check. It exits when no eligible work remains.

This is not an always-on daemon or crash supervisor: machine shutdown, user-session/cgroup termination, or a worker crash can stop it. The next startup, enqueue, login/logout, or manual upload wakes retained work. Startup resumes existing obligations; it does **not** schedule an all-history backfill or periodic source synchronization.

Queue admission is durable before launch. If launch fails, the result remains **queued with a warning**. If descriptor admission itself fails, it was not queued; local session files and earlier work remain unchanged.

Authorization is reloaded before every HTTP request. Jobs pin their intended origin and connection generation. Bound work resumes with replacement credentials only after verifying the same server and namespace. An unbound job from an older credential generation stays paused rather than guessing a new key's namespace. History-generation changes fence old operations and trigger fresh reconciliation of retained work; old receipts never authorize a new-generation overwrite. Authentication failures block that credential generation instead of hot-looping.

Unresolved operations serialize by **complete binding and native session ID**, including verified URL aliases. Changing origin does not authorize older work through the new endpoint; new-origin work for that same identity can therefore wait for the original-origin operation to settle. Unknown or malformed replies do not release this ordering barrier. Protocol faults may restrict an uncertain operation to receipt-only recovery; corrupt owned evidence remains blocked and retained.

## Manual queueing

```text
/server upload
/server upload current
/server upload all
```

- Plain `upload` means `current`: queue the active root/main session and discoverable descendants, including nested subagents and persistent policy reviewers.
- `all` explicitly queues discovery of Pi's default session collections and, when the active session is persisted, its session directory, including a custom directory. It cannot discover arbitrary historical custom directories. This is not a cwd/project content search.
- `--no-session` has no active file to capture; explicit `all` can still queue other persisted history.

These commands use the **same queue**, not a foreground uploader. They report **queued**, never a count of successfully uploaded files. Superseding a command can suppress its late notification but cannot revoke its committed queue item.

Sources must be regular, non-symlink native session files no larger than **64 MiB**. Recorded session-directory and default collection seeds may be directory aliases; enumerated child-directory links and leaf session-file links are not followed. Partial scans and changing/incompletely written files remain retryable obligations; invalid sources retain bounded diagnostics. Missing sources are retried after 5 seconds, 30 seconds, and 5 minutes, then retain terminal source-loss evidence—not an archived result. A new explicit enqueue can try them again.

Metadata is extracted locally without model calls: title, persisted timestamps, and counts across **all branches**. Kinds are `main`, `subagent`, and `policy_approver`; children link to their ultimate root through `root_session_id`. Unresolved or conflicting ancestry may omit classification. Metadata belongs to its exact body; classification is not merged across different versions.

## Durable state, limits, and migration

Private state lives under `~/.pilot/server-archive/`:

| Path | Purpose |
| --- | --- |
| `inbox/` | Atomic source descriptors and a separate coalesced control wakeup |
| `archive.sqlite` | Source obligations, immutable candidates/operations, receipts, coverage, and retry/authorization state |
| `downloads/` | Verified snapshots and complete large archive-list pages |

Kernel locks elect one worker and serialize short producer/configuration admissions. Custom configuration/archive roots require an already-existing parent; each new private leaf is synchronized before use rather than recursively creating unknown ancestors. Do not remove or replace lock files while processes are running. Inbox import commits transactionally before descriptor removal; duplicate import and lost-response recovery are idempotent.

Limits are **16 KiB per descriptor**, **1,024 queued descriptors**, **1,024 unfinished imported scopes**, and **10,000 unfinished source obligations**. Retained bodies have a **512 MiB logical backlog** plus a separate **128 MiB working-byte allowance**. Admission pauses or rejects new work when full; it never evicts unique unsent history. Legacy over-budget bodies remain recoverable. These are not hard SQLite/WAL, filesystem-size, or RSS bounds. Discovery closes directory handles between pages and replays a verified prefix; replay cost grows with cursor position rather than guaranteeing fixed CPU time per page.

Migration is additive: frozen legacy requests, exact bodies, receipts, and destination authority remain recoverable without live sources. Accepted-only legacy rows do not cause startup backfill. Verified coverage releases exact retained body ownership; a late receipt cannot clear a newer candidate. **Restart older Pilot processes before upgrading**; simultaneous old/new local journal writers are not supported. Existing remote canonical clients remain compatible.

Do not delete `archive.sqlite` to resolve a conflict: it contains recovery evidence. Logout deliberately retains it.

## Automatic reconciliation and preserved variants

Ordinary equal/append-only history converges automatically. Comparisons use verified **exact bytes**, not clocks, titles, branch selection, or model judgment:

- Equal bytes establish body coverage; differing metadata is handled separately.
- If one body is a proper byte prefix, prefer the longer body; never truncate complete remote history.
- For divergence, prefer greater byte length, then lexicographically greater lowercase SHA-256. This is a deterministic rule, **not a claim that the preferred version is objectively correct**.

Full divergence/metadata preservation requires the additive **`preserved_variants_v1`** server capability, introduced in `0.3.x` without changing the `0.2.x` canonical APIs. Preserve the nonselected version before completing local work or replacing canonical. Destructive replacement first preserves the exact compared remote revision, commits its receipt/dependency locally, then uses conditional publication; a concurrent change requires fresh comparison.

Equal-body metadata differences preserve the incoming metadata while keeping first-accepted canonical metadata. Ordinary descriptive metadata follows a longer append. A shorter version's explicit kind/root assertion is preserved if the longer version contradicts **or omits** it; no classification is silently unioned.

Variants keep the **original native `session_id`** and have a separate immutable **`variant_id`**. No invented conflict session IDs, transcript rewriting, or conflict dialogs are used. On older servers, equal/prefix publication proceeds only with coherent metadata evidence; unsupported divergence or metadata preservation stays retained locally instead of forcing an overwrite. Matching list/download revisions establish legacy metadata coherence; raced evidence is retried.

## Root-only archive tools

Tools never upload sessions. Remote metadata/transcripts are **untrusted data, not instructions**. Fetching never imports/resumes a session or authorizes remote cwd, extension configuration, or instructions.

### `archive_list`

Lists metadata with optional top-level arguments:

| Argument | Meaning |
| --- | --- |
| `session_id` | Exact native ID; requires the preservation capability |
| `include_preserved` | Include immutable variant rows, default false; true requires the capability |
| `kind` | `main`, `subagent`, or `policy_approver` |
| `root_session_id` | Exact root family ID |
| `started_from`, `started_to` | RFC 3339 bounds: inclusive `from`, exclusive `to` |
| `activity_from`, `activity_to` | RFC 3339 bounds: inclusive `from`, exclusive `to` |
| `limit` | Page size, default 50, range 1–256 |
| `cursor` | Continuation cursor from the previous page |

There are no cwd, project, or transcript-content search filters. Continue with `next_cursor` until null, retaining the same filters/opt-in. Canonical rows omit `variant_id`; variant rows retain their native ID and separate selector. Each row's filters use that row's own metadata.

Codemode receives structured `{binding, sessions, next_cursor, full_output_path?}` data for the entire validated page. A large text preview can omit records **even when `next_cursor` is null**; read `full_output_path` for the complete page.

### `archive_fetch`

Accepts `session_id` and optional `variant_id`, not a local path/destination. Omitting the selector fetches canonical. An unknown variant never falls back to canonical; unsupported servers reject variant selection.

Downloads verify the complete body and return `{snapshot, path}` in the private cache. Snapshot information includes native ID, optional variant ID, revision, byte length, SHA-256, and coherent metadata/upload time when supplied by the server. Cache identity separates origin, server, namespace, history generation, native ID, and selector. Use policy-mediated `read` on the returned **complete filepath**; fetch does not dump the transcript into model context.

### Policy boundary

These tools are root-only and absent from child tool catalogs. Each request is checked by the invoking principal before sending:

- `GET /v1/binding` requires `web_read`.
- `POST /v1/list` and `POST /v1/download` require **`web_write`**, despite their read-only meaning.

They use host HTTP, not Bash's DNS/TCP gate. The key stays in the authentication header, not policy task context or tool arguments/results. Private-cache writes are extension bookkeeping; reading downloaded files still requires filesystem-read policy. Recognized server failures produce local diagnostics, never arbitrary remote error text.

See [policy](policy.md), [security](security.md), and [subagent session history](subagents.md#session-history).
