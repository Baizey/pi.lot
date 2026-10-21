# pi.server session archive

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
