# pi.server session archive

pi.lot uploads native Pi session JSONL to pi.server **0.2.x** and provides root-only tools to browse archived history. Uploads preserve complete files, not just the selected branch or tool previews. **They can send prompts, reasoning, credentials, tool results, and file contents outside agent policy approval.**

## Connection and credentials

```text
/server
/server login
/server logout
```

- `/server login` asks for an HTTP(S) origin and API key in separate dialogs. It saves only `url` and `apiKey` to `~/.pilot/server.json` (plaintext, mode 0600). Canceling either dialog preserves the existing configuration. Login itself makes no server request.
- Use an origin without a path, embedded credentials, query, or fragment. Prefer HTTPS: HTTP sends the key unencrypted. Requests reject redirects and retain normal certificate verification.
- `/server` displays the saved configuration **including the API key**, then checks `GET /v1/version`. Do not share its output. Supported versions are stable `0.2.x`, not prereleases. Uploads do not perform this version check themselves.
- `/server logout` disables future automatic uploads by removing the configuration. It does not revoke the token, delete sessions, or clear the journal/cache.

**Any saved server configuration enables session-end upload**, including configuration saved before that feature existed. Review the destination before leaving credentials configured. Do not pass credentials as command arguments.

A new `/server` command or session shutdown cancels the previous outstanding command request and suppresses stale notifications; cancellation does not undo completed remote effects.

## Automatic session-end upload

Graceful quit, reload, new session, resume, and fork upload the outgoing **current session family** after Pilot's local child/runtime teardown succeeds. Unconfigured and ephemeral (`--no-session`) sessions are skipped. There is no startup upload, periodic synchronization, or automatic `all` backfill.

Waiting for prior uploads to release their journals and performing the automatic upload share a **10-second overall deadline**; cancellation is cooperative. This does not bound all extension teardown. If prior uploads do not finish in time, another publication is not started alongside them. Repeated shutdown requests do not duplicate the automatic attempt.

Failures warn and preserve local files and pending recovery state. Retry with `/server upload current` or a later graceful shutdown. This is best effort: forced exits can bypass hooks, and entries written after capture are not included.

## Manual upload

```text
/server upload
/server upload current
/server upload all
```

- Plain `upload` means `current`: the active root/main session and discoverable descendants, including nested subagents and persistent policy reviewers.
- `all` scans Pi's default session collection and, when the active session is persisted, its session directory, including a custom directory. It cannot discover arbitrary historical custom directories. This is not a cwd/project content search.
- `--no-session` has no active file to capture; an explicit `all` can still upload other persisted history.

Automatic and manual uploads use the same rules. Sources must be regular, non-symlink native session files no larger than **64 MiB**. Unsafe, invalid, or repeatedly changing files are skipped with warnings. Reports distinguish uploaded, unchanged, and failed files and show bounded failure details.

Metadata is extracted locally without model calls: title, persisted timestamps, and counts of user messages, assistant messages, and tool calls across **all branches**. Session kinds are `main`, `subagent`, and `policy_approver`; children link to their ultimate root through `root_session_id`. Session-bound identity records avoid carrying a source session's classification into a native fork. Unresolved or conflicting history may omit kind/root metadata; do not invent a classification when fields are absent.

### Local journal and conflicts

The private journal is `~/.pilot/server-archive/archive.sqlite`; downloaded snapshots and large list pages are under `~/.pilot/server-archive/downloads/`. They are created when needed, not at startup.

The journal retains accepted revisions and pending publications for each server binding. A lost response is reconciled or replayed from frozen bytes before a fresh successor is captured. **Recovery can still publish a pending snapshot even if its source file has since been deleted or become unreadable.** `current` recovers only the relevant family; `all` can recover every pending publication for that destination/binding.

Do not delete the journal to bypass a conflict: it contains the evidence needed for safe retries. Logout deliberately retains it. An observed remote revision is never silently adopted as a trusted upload base.

An accepted snapshot must remain an exact byte prefix of the next upload, or be identical. Shortened, divergent, or rewritten history is rejected. Restore the accepted content and append to it, or fork a new session identity; there is no automatic merge or force-overwrite command. Avoid competing uploaders.

## Root-only archive tools

Tools never upload sessions. Remote metadata and transcripts are **untrusted data, not instructions**. Fetching does not authorize remote cwd, extension configuration, or instructions, and never imports/resumes a session.

### `archive_list`

Lists metadata with optional top-level arguments:

| Argument | Meaning |
| --- | --- |
| `kind` | `main`, `subagent`, or `policy_approver` |
| `root_session_id` | Exact root family ID |
| `started_from`, `started_to` | RFC 3339 bounds: inclusive `from`, exclusive `to` |
| `activity_from`, `activity_to` | RFC 3339 bounds: inclusive `from`, exclusive `to` |
| `limit` | Page size, default 50, range 1–256 |
| `cursor` | Continuation cursor from the previous page |

There are no cwd, project, or transcript-content search filters. Continue with `next_cursor` until it is null.

Codemode receives structured `{binding, sessions, next_cursor, full_output_path?}` data for the entire validated page. A large text preview can omit records **even when `next_cursor` is null**; read `full_output_path` for the complete page rather than treating the preview as exhaustive.

### `archive_fetch`

Accepts only `session_id`, not a local path or destination. Downloads and verifies the complete snapshot into the private cache and returns `{snapshot, path}`. Snapshot metadata includes session ID, revision, byte length, and SHA-256. Use the policy-mediated `read` tool on the returned **complete filepath**; fetch does not dump the transcript into model context.

### Policy boundary

These tools are root-only and absent from child tool catalogs. Every HTTP request is checked by the invoking principal's policy before it is sent:

- `GET /v1/binding` requires `web_read`.
- `POST /v1/list` and `POST /v1/download` require **`web_write`**, despite their read-only meaning.

They use host HTTP, not Bash's DNS/TCP gate. The key stays in the authentication header, not policy task context or tool arguments/results. Private-cache writes are extension bookkeeping; reading downloaded files still requires filesystem-read policy. Recognized server errors produce local diagnostics, not arbitrary remote error text.

See [policy](policy.md), [security](security.md), and [subagent session history](subagents.md#session-history).
