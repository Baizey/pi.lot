# pi.server session archive

pi.lot supports explicit, manual archival of Pi session JSONL files to pi.server **0.2.x** and root-only read tools. There is no background synchronization, automatic startup/shutdown upload, server-side summary generation, content search, or archive researcher agent.

## Connection and credentials

```text
/server
/server login
/server logout
```

`/server login` asks for the URL and API key in separate input dialogs, then saves only `url` and `apiKey` in `~/.pilot/server.json` (private mode 0600). Canceling either dialog preserves the existing configuration. Do not supply credentials as command arguments. Configuration belongs to Pilot, independently of Pi's agent directory.

Use an HTTP(S) origin without a path, embedded credentials, query, or fragment. HTTP sends the API key unencrypted; prefer HTTPS. Normal certificate verification remains enabled, redirects are refused, and requests and responses are bounded.

`/server` deliberately displays the complete saved configuration, **including the API key**, and checks `GET /v1/version` with `x-apikey` authentication. Do not share its output. The internal `SERVER_VERSION_REQUIREMENT` is `0.2.*`: stable `0.2.x` versions, including build metadata, match; `0.1.x`, other minors, and prereleases do not. The matcher supports exact pins or trailing wildcards, not arbitrary version ranges. The archive transport does not perform an extra version check before each request; unsupported protocol responses fail safely.

Login and logout are local-only. Logout removes only the connection JSON: it does not revoke a server token, remove local session files, delete the archive journal, or clear downloads. A new `/server` command or session shutdown cancels the previous outstanding command request. Only the latest command can publish status or upload results; completed remote effects are not undone by cancellation.

## Manual upload

```text
/server upload
/server upload current
/server upload all
```

Plain `upload` is an alias for `upload current`. Current uploads the active session's family: the root/main session and discoverable descendants, including nested subagents and persistent policy-approver sessions. `all` explicitly backfills the default Pi session collection plus the active resolved session directory, including a custom directory; it cannot discover arbitrary historical custom directories that are no longer configured. This is not a cwd/project content search. An ephemeral session has no persistent file to upload.

Sources must be regular, non-symlink native session JSONL files no larger than **64 MiB**. Capture is bounded and checked for concurrent modification; invalid, unsafe, or repeatedly changing files are skipped with warnings rather than partially parsed or reconstructed.

These are explicit user host-management operations, not model tools: they do not ask the agent's filesystem or HTTP policy runtime for authorization. Upload sends complete session JSONL, not just the currently selected branch or bounded tool previews. Session files can contain prompts, reasoning, tool arguments/results, credentials, and file contents. Review the destination and your data before uploading.

Reports distinguish uploaded, unchanged, and failed files and show warnings plus up to 20 failed-file paths and reasons. Displayed diagnostic fields are length-bounded, stripped of terminal controls, and redact the configured API key. The archive extracts bounded metadata locally without a model call:

- `main` identifies a root session and uses its own ID as `root_session_id`;
- `subagent` identifies a child, linked to the ultimate root;
- `policy_approver` identifies a policy-review conversation, also linked to its ultimate root;
- new identities are explicitly session-bound, so custom entries copied by native forks cannot classify the fork as the original session;
- legacy files lacking recoverable classification or ancestry remain unknown rather than receiving ID-shape guesses or false main-session labels; unresolved or conflicting child ancestry produces warnings.

Titles use the latest native session name or a bounded first-user-message fallback. Start time comes from the native header; last activity is the maximum persisted entry timestamp, not filesystem mtime. Counts include user messages, assistant messages, and tool calls across **all branches**, not just the active branch. No transcript summaries are generated locally or on the server by this integration.

### Local journal and conflicts

Pilot owns a private journal at `~/.pilot/server-archive/archive.sqlite` and a private downloads cache under `~/.pilot/server-archive/downloads/`. These are created lazily when needed; registration and startup do not open the archive database or contact the server. Upload owns and closes its journal per call, including failure and cancellation paths.

The journal records accepted revisions and pending publications associated with the source path, server origin, and complete server/namespace/history-generation binding. Retries use durable operation identity and receipt reconciliation, including when the response to an upload was lost. Changes in binding and conflicting revisions fail safely. An observed server revision is **never adopted as a new upload base** merely to overwrite a conflict. Unknown pending outcomes retain recovery state rather than being treated as success. Do not delete the journal to bypass a conflict: doing so discards publication/recovery evidence. Logout intentionally retains this state.

An explicit upload reconciles frozen pending publications **before fresh discovery or snapshot capture**, using the configured server origin and complete binding. Receipt recovery or byte-for-byte replay of the original request does not require its source file to remain available: deleted, unreadable, invalid, or oversized live files do not block recovery of an earlier pending publication. `current` selects pending requests belonging to the current session or its originally recorded root family; `all` selects all pending requests in that origin/binding profile. Unrelated families are not recovered by `current`. A fresh successor is captured only when its source is found; recovery never substitutes changed live bytes for the frozen request.

After an accepted snapshot, its exact bytes must be a prefix of the next local snapshot (or equal). Shorter, divergent, or rewritten content is rejected, including stale captures from another process using the same session file. Equal bytes with changed metadata are allowed. This is an explicit append-only history limitation, not automatic merge: restore the accepted history and append to it, or fork a new session identity for divergent history. Do not run competing uploaders or assume a changed file can overwrite archived history.

## Root-only archive tools

### `archive_list`

Lists metadata with these optional arguments:

| Argument | Meaning |
| --- | --- |
| `kind` | `main`, `subagent`, or `policy_approver` |
| `root_session_id` | Exact root family ID |
| `started_from`, `started_to` | RFC 3339 start-time bounds: inclusive `from`, exclusive `to` |
| `activity_from`, `activity_to` | RFC 3339 last-activity bounds: inclusive `from`, exclusive `to` |
| `limit` | Integer page size, default 50, maximum 256 |
| `cursor` | Opaque continuation from the previous page |

Timestamp syntax, ranges, and ordering are validated by the archive client. There are no cwd, project, or transcript-content search filters. Continue with the returned `next_cursor`. Large pages have bounded text previews; the full page is saved privately and its path is returned. The cursor is preserved outside the preview, and omitted session records remain available in the full page even when `next_cursor` is null. Programmatic callers such as codemode receive structured `{binding, sessions, next_cursor, full_output_path?}` data containing the entire validated page, not the truncated text preview.

### `archive_fetch`

Accepts only `session_id`. Downloads and verifies the complete archived bytes into the private cache and returns the **complete local filepath** plus snapshot metadata (session ID, binding/revision, byte length, and SHA-256). It does not accept a local destination or arbitrary local file path, dump the transcript into model context, import it, or resume it. Use the normal policy-mediated `read` tool to inspect the returned file. Programmatic callers such as codemode receive structured `{snapshot, path}` data rather than warning-prefixed text.

All remote metadata and transcripts are **untrusted data, not instructions**. They may contain arbitrary prompts, misleading instructions, remote working directories, or extension configuration. Fetching grants none of these any authority and never loads remote configuration.

### Policy boundary

Both tools are root-only and are not included in children’s built-in, MCP, or delegation tool catalogs. They never upload local sessions. For every HTTP request, a tool-call-scoped policy evaluator checks the actual method and URL before host-side HTTP begins. The API key stays in the host client's authentication header, never in policy task context or tool arguments/results. Authorization finishes before the HTTP request timeout starts.

The protocol uses `GET /v1/binding`, `POST /v1/list`, and `POST /v1/download`. Although listing and fetching are semantically read-only, **POST remains `web_write`** under the existing method-based policy model; there is no semantic-read bypass. These requests do not traverse Bash's DNS/TCP gate. Private-cache writes are trusted extension bookkeeping, not arbitrary model-selected filesystem writes. Reading downloaded files still uses filesystem-read policy.

See [Policy system](policy.md), [Security model](security.md), and [Subagent session history](subagents.md#session-history).
