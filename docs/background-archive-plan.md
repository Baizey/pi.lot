# Background session archival: implementation plan

Status: **all six production slices implemented and independently reviewed**, following
the reviewed revision-3 design. Core correctness convergence and the combined local suite
have passed. Remaining work is the bounded removal of retired source APIs and the final
post-cleanup validation record—not additional features. This is not a claim of a passing
full host suite, production-WAL qualification, or physical durability.

The reviewed foundation checkpoint is `e220a58`. Subsequent work adds the bounded durable
inbox, detached Node/jiti worker and kernel election, transactional source obligations,
immutable operations and coverage, persisted retries, destination-pinned authorization,
lightweight lifecycle/manual queueing, byte/metadata reconciliation with preservation
dependencies, and canonical/preserved archive selectors. pi.server implements additive
`preserved_variants_v1` storage, receipts, quotas, migration, pagination, and restore fencing
while retaining stable 0.2.x canonical compatibility.

Foreground publication/draining and the ten-second session-end upload have been removed.
`SessionArchive` is now solely a list/fetch/cache service; the foreground-only source
capture factory is separate from the worker's serializable source model. Focused SQLite
fixtures explicitly use rollback journaling; production retains WAL. Real bootstrap,
election, and detached-lifetime tests are distinct from WAL/physical-durability evidence.

This plan covers `/var/home/lsm/repos/pilot` and `/var/home/lsm/repos/pi.server`.
Current behavior remains documented in [server.md](server.md). The goal is seamless,
primarily asynchronous outbound archival, not native-session portability.

## 1. Scope and chosen guarantees

- Graceful quit, new/resume/fork, and reload schedule the outgoing persisted family.
- Departure runs Pilot's existing local teardown, then commits a small durable enqueue.
  This is not certification that every native/SDK writer has settled: deferred capture
  independently requires a stable persisted read. Departure does not scan transcript
  directories, parse/hash/copy full transcripts, check versions, drain uploads, or wait
  for HTTP. Existing unrelated teardown is not made instantaneous.
- An independently owned worker captures files, reconciles, publishes, and retries
  after the Pi process exits. Ordinary Pi exit must not cancel it.
- Normal operation has no prompts, success notifications, conflict dialogs, or dashboard.
- Read-only archive browsing/fetching remains available. No native resume/import,
  workspace mapping, local transcript replacement, full remote catalog, content search,
  periodic all-history backfill, policy sync, or general daemon framework is included.
- Metadata and transcript bytes are untrusted archive data; no remote path, cwd, or
  extension configuration becomes executable authority.

### Deliberate capture tradeoff

The exit path enqueues **a capture obligation, not an immutable departing snapshot**.
The worker captures the latest stable persisted file it finds. Appends before capture
are welcome; ordinary process exit does not delete native session files.

If a file is deleted, rewritten, migrated, or replaced before capture, the exact older
bytes may no longer be available. A durable path descriptor cannot fix that. We do not
claim exact departure-image, forced-kill-before-hook, or source-file power-loss recovery.
Once the worker commits a captured candidate, its exact bytes survive source loss and
must not be discarded until remotely covered or preserved. Stronger departure-image
preservation would require an acknowledged local copy/reflink/ownership handoff before
exit, and is explicitly not hidden inside this lightweight design.

Likewise, detached lifetime covers ordinary Pi process exit, not machine shutdown,
user-session/cgroup termination, or guaranteed autonomous restart after worker failure.
Committed work resumes on the next startup/enqueue/login/manual-upload wakeup. While a
healthy worker has retryable work, it stays alive through backoff rather than writing a
future deadline and exiting with nobody to wake it.

## 2. Existing foundations and changes

Reuse:

| Existing component | Keep / change |
| --- | --- |
| `src/server/ArchiveClient.ts` | Keep bounded authenticated HTTP, redirect refusal, integrity and receipt checks; expose structured retry information. |
| `ArchiveJournal.ts` | Keep FULL SQLite durability, immutable captures/pending bodies/requests, and legacy recovery. `ArchiveWorkerState.ts` owns additive queue, scheduling, coverage, authorization, and dependency tables in the same database. |
| `ArchiveSessions.ts` | Keep stable reads, byte preservation, metadata extraction, and family interpretation. Worker construction takes only a serialized source scope; the foreground SDK factory lives separately in `ArchiveSourceScopeCapture.ts`. |
| `SessionArchive.ts` | Retain lazy list/fetch/cache only. `ArchiveWorkerEngine.ts` owns capture/reconciliation/publication orchestration, without a fake ExtensionContext. |
| `ServerSessionLifecycle.ts` | Replace the ten-second network drain/upload with durable enqueue plus best-effort worker launch. |
| `ServerService.ts` | Separate session-owned foreground requests from independently owned committed archive work. |
| `SdkSubagentSessionFactory` | Existing descendants/policy reviewers already persist in the root's resolved session directory. No new child lifecycle protocol is required initially. |
| pi.server publication/receipt/binding APIs | Preserve CAS, immutable retries, namespace isolation, generation fencing, and opaque byte storage. |

A narrow pi.server preservation capability is required for fully automatic divergence
handling. The worker/outbox can ship first against 0.2, retaining divergent captures
locally until the server capability is available.

## 3. Departure handoff and discovery

Introduce a concrete serializable `ArchiveSourceScope`, cached at session startup after
identity registration: active native ID, active file, resolved session directory, known
root ID if available, and scope `current` or explicit manual `all`. Do not recompute
`getSessionRootId()` by traversing manager entries at departure. Resolve paths using
trusted local context, never a fetched transcript's cwd or parent path.

After Pilot's existing local teardown has completed or reported failure:

1. Skip unconfigured requests. Automatic/current requests skip ephemeral roots; explicit
   manual `all` may discover recorded default-session roots without an active persisted file.
2. Read current configuration locally; pin the intended connection/origin.
3. Write one private, bounded family descriptor into an inbox using exclusive temp
   creation, file synchronization, atomic rename, and parent-directory synchronization.
4. Start/wake the worker without inheriting session cancellation. Observe only the local
   spawn/error outcome (one-second launcher deadline), not bootstrap readiness or drain.
5. A repeated shutdown hook reuses its enqueue identity; new departures have distinct
   immutable enqueue IDs. A completion cannot delete a newer departure's request.

Even if unrelated teardown failed, retain the source-only obligation when its cached
scope is usable; report teardown failure separately. This does not certify final bytes.

Use a manifest inbox separate from the SQLite worker journal, so an exiting Pi does
not contend with capture/network work for journal writes. No credentials in manifests.
A descriptor contains no transcript text and is capped at 16 KiB. A separate, short
inbox-admission kernel lock serializes producers and importer removal; its critical
section contains only bounded inbox inspection and local manifest publication, never
network/capture/SQLite BLOB work. Wait at most 250 ms for this lock. With it held, admit
at most 1,024 durable data descriptors; reserve a separate coalesced control-wakeup file
for configuration revalidation so a full data inbox cannot prevent logout/login wakeup.
Atomic replace of that control file is serialized by the same lock. Each replacement
has a fresh event token; after transactional import, remove the control file under that
lock only if its token still matches the imported event. Leave a newer replacement intact.

Reject newest enqueue on admission/I/O failure with one warning; preserve the native
source and all admitted work, and never report it as scheduled. A hard wall-clock bound
on an unresponsive fsync or OS process spawn is not promised. Late launcher completion
is still safe because the durable enqueue precedes it.

The worker imports a manifest transactionally before removing it. Re-import after a
crash is idempotent. It performs current-family discovery in the recorded directory;
explicit `all` also uses recorded default-session roots. Discovery is not broadened to
arbitrary custom directories, unrelated projects, or a remote inventory.

A failed/partial scan is not an empty completed family. Retain retryable file/directory
obligations, process healthy sources, and classify invalid/missing sources separately.
Do not chase arbitrary `parentSession` paths outside the owned candidate catalog.
Several eligible paths with one native ID become candidate sources, not a reason to
skip all of them. Keep classification evidence attached to each captured body.

## 4. Durable state and operation ordering

Additive transactional migration; preserve every existing `archive_uploads` request,
body, receipt, origin, and binding byte-for-byte. Enumerate legacy pending operations
before live discovery, including missing-source operations, but do not drain their
network work before permitting new captures. Startup examines manifests, imported
obligations, and frozen pending operations only: accepted-only rows do not schedule
source recapture or create an implicit all-history backfill.

Legacy rows acquire authorization only after current credentials verify their origin
and stored server/namespace; an exact binding permits replay, while a new history
generation fences the operation and retains its body for fresh reconciliation. Do not
reset the journal or manufacture replacement operation IDs during migration. Restart old
Pilot processes before switching the local journal writer; mixed old/new local uploader
versions are not a migration guarantee. Existing remote canonical clients remain compatible.

Separate these concepts instead of overloading a pathname as upload authority:

- **Inbox request**: immutable enqueue ID, intended local connection, source scope.
- **Source observation**: path/native ID and scan/capture obligations; several paths
  may describe one native identity.
- **Captured candidate**: immutable bytes, digest, exact extracted metadata, provenance.
- **Executable operation**: immutable publication/preservation request and frozen body
  or exact preserve-current revision, with binding, fingerprint, attempts, next due time.
- **Coverage evidence**: verified equality/prefix coverage or accepted preservation;
  never a fictional publication receipt and never certification that a live file is clean.
- **Destination state**: current binding, configuration authorization, and retry blocks.

State progression:

```text
inbox -> scan/capture due -> captured candidate
      -> recover existing operation -> compare / prepare operation
      -> executable operation -> accepted / covered / preserved
                              -> retry due / authorization blocked / invalid
```

Operations have durable `ready/uncertain`, `accepted`, `rejected`, `fenced`, or locally
`invalid/blocked` state. Only `ready/uncertain` in the currently authorized binding can
execute. Persist write-ahead dispatch provenance separately from readiness: receipt
`unknown`, replay, ancestry changes, or a malformed response cannot turn a potentially
dispatched request into never-dispatched work. Stale ancestry or protocol faults can
restrict it to bounded receipt-only recovery. Corrupt owned evidence retains a blocked
unresolved slot; a genuinely never-dispatched invalid request may be terminal locally.
Validate stored request/candidate relationships before dispatch and receipt-driven coverage.

A definitive CAS rejection atomically retires that operation while retaining its candidate.
Generation change fences old operations and invalidates their preservation dependencies.
Body-bearing operations can yield new-generation candidates; preserve-current operations
contain no body and require fresh comparison against the new canonical version. Restart
enumeration cannot resurrect retired legacy work; obsolete receipts record historical
outcomes only.

One unresolved operation per `(complete binding, native session ID)` locally, including
blocked unresolved work and destinations reached through different verified origins.
This exclusion does not transfer origin-pinned credentials, execution authority, accepted
bases, or bodies. A URL migration may therefore pause new-origin work until the original
operation settles through its authorized origin or is legitimately fenced.
Capturing a successor never replaces the predecessor or drops either body's unique
history. Coalesce only after equality or proper-prefix coverage has been verified.
`ArchiveJournal.prepare()` returning an old pending operation is not preservation of
the newer supplied body; the new candidate needs its own durable record first.

No SQLite metadata transaction spans network I/O. A late reply matches its exact
operation/binding and cannot erase a successor, a new enqueue, or a new source capture.
Persist verified outcomes before eligible candidate cleanup. Partial/unreferenced
staging is reconciled after a crash before deleting potentially unique complete bytes.

## 5. Worker lifetime, packaging, wakeups, and limits

Use one on-demand detached Node worker per private Pilot archive root. It loads only
archive components, not a Pi agent, policy runtime, MCP, model credentials, or project
extensions. Launch shell-free with an absolute executable/module path, ignored stdio,
controlled environment, detached process lifetime, and an unreferenced child handle.
Do not use a session-owned managed-process wrapper or a parent-death signal.

Packaging choice: a small `.mjs` bootstrap loading the trusted worker TypeScript through
an explicit **production** `jiti` dependency. Require external Node >=22.19, resolving and
validating its absolute path plus `better-sqlite3` compatibility at startup/configuration,
not departure. Do not assume Pi's `process.execPath` is Node: compiled Pi may be Bun.
Do not inherit `process.execArgv`, accidental `NODE_OPTIONS`, Pi's loader, cwd resolution,
or a globally installed TypeScript runtime. Spawn success is not bootstrap success;
exercise the actual production bootstrap in a subprocess smoke test.

Use a worker-owned descriptor and util-linux `flock` for crash-released kernel ownership.
Node opens the stable private lock inode, then spawns shell-free
`flock --exclusive --nonblock --conflict-exit-code 75 3`, passing its descriptor as
child fd 3. Await helper exit: 0 acquires, 75 means contention, other outcomes are failures.
Linux open-file-description ownership leaves the lock held by Node's still-open descriptor
after helper exit. Closing that descriptor releases it; a fresh open/helper reacquires it.
Never replace/unlink the inode, leak the descriptor to unrelated children, or close it
before the election helper has fully exited. On timeout/error, terminate and reap the
helper before releasing/rechecking; uncertainty is not permission to process work as winner. Use the same descriptor pattern with a
250 ms wait for the separate inbox-admission lock. No native addon or PID/mtime lease.

1. Every enqueuer commits its data/control inbox event before launching a contender.
2. Contender acquires worker lock nonblockingly; a loser exits.
3. Winner imports/drains work and watches inbox/config changes while retries wait.
4. It may exit only when no eligible unfinished work remains, including future retries.
5. Before exit, close the worker-lock descriptor, then reread durable data/control events,
   current configuration generation, and eligible unfinished state without a stale read
   snapshot/write transaction. All post-unlock inspection is read-only; reacquire before
   importing, acknowledging, or mutating anything. If new work appeared, reacquire or let
   a winning contender own it. A pre-unlock check alone loses enqueue/configuration wakeups.

`fs.watch` is only a latency hint. During backoff, scheduler sleeps are capped at five
seconds before checking new work/configuration. An in-progress capture, directory replay,
or HTTP attempt can delay the next check; authorization is reloaded before every request.
Startup, enqueue, configuration replacement/login/logout, and manual upload use this
shared durable-wakeup path. A worker retains a live timer for future retryable
work; if all work is done, invalid, source-lost, or authorization-blocked, it exits.
Future wakeup recovers a crashed worker. No systemd service, auto-installed supervisor,
socket protocol, or boot persistence is required for this first implementation.

Initial limits: one materialization/HTTP attempt at a time; existing 64 MiB source cap;
1,024 inbox descriptors, 1,024 unfinished imported scopes, and 10,000 unfinished source
obligations. The single importer leaves manifests unimported if scope admission is full
and keeps a scan continuation instead of expanding past source admission. Completed scopes
release admission; receipt/base evidence remains separately retained. Counts are checked
transactionally by the single worker, not by racing producer estimates.

Default retained candidate/pending-body backlog limit: **512 MiB**, plus a separate
**128 MiB working-byte allowance** for bounded capture, reconciliation downloads, and
transport. Legacy bodies count toward backlog but are grandfathered above the limit;
new capture waits until backlog admission is available. Grandfathered backlog never
disables recovery's separate working allowance. Reserve working bytes before materializing
and backlog bytes before committing a new candidate, without double-counting shared stored
bodies. These are logical byte limits, not hard SQLite/WAL, filesystem, or RSS caps.

Each scheduling cycle admits a bounded discovery/capture opportunity independently of
predecessor network success, then at most one due network attempt before rescheduling.
Do not retain a whole family's transcript bodies in RAM. On capacity exhaustion retain
old unique captures and new source obligations; fair scheduling cannot promise capture
progress while all retained-history capacity is occupied. Never evict unsent history.
Retry a missing source at 5 s, 30 s, and 5 min; then retain terminal source-loss evidence,
not an archived result. A future explicit enqueue of the scope may retry it. Repeatedly
changing files remain retryable; permanently invalid files retain bounded diagnostics.
Measure a representative large file before claiming memory/latency targets; no full
benchmark framework is required.

## 6. Authorization, destination pinning, and retries

Queued work is not permission to send history to whichever server is configured later.
Version configuration with a local connection generation; descriptors pin origin and
generation, and bind server/namespace as soon as known. Initialize/migrate that generation
once under a short configuration kernel lock before any enqueue; atomic replacement must
compare the current config and never overwrite a concurrent login/logout. Login/logout
use the same lock and durably publish a revalidation wake event before launching. Legacy
config gains a stable generation without changing upload scope; no generation is inferred
independently by competing processes. A token is a credential, not archive identity.

Before each HTTP request, reload current authorization and use current credentials only
for matching intended destinations. Logout pauses retained work and prevents subsequent
requests; already dispatched effects cannot be recalled. Login/new-session/reload does
not cancel committed operations. No API keys in argv, manifests, diagnostics, or worker
logs. Normal upload remains trusted host-management work, not agent policy approval.

Credential replacement can resume old **bound** work after the worker verifies the same
server/namespace. A different origin, server ID, or namespace never inherits that work.
An unbound job from a superseded credential generation stays paused rather than guessing
that a new token targets the same namespace. A history-generation change within the same
server/namespace triggers fresh content reconciliation, never old-base reuse.

Expose machine-readable error code, retryability, uncertainty, and validated Retry-After
from `ArchiveClient`, not text parsed from presentation strings.

- Lost reply/disconnect/unknown receipt: recover/replay the same immutable operation.
- Definitive stale-base/already-exists rejection: retain candidate, transactionally retire
  that executable attempt, fetch current bytes, compare, and prepare a new operation.
- Network/overload/rate limit: persistent exponential backoff with jitter; honor Retry-After.
- Authentication failure: block that credential generation instead of repeatedly causing
  the server's IP ban. Configuration replacement wakes revalidation.
- Capacity: slow retry without deleting work or starving unrelated healthy candidates.
- Invalid source/protocol, integrity mismatch, or corruption: retain evidence, bounded
  local diagnostic, no permissive fallback or infinite hot loop.

Fair scheduling prevents a hot/conflicted ID or unreadable source from blocking the rest.
Normal success is silent. This plan requires internal state, not a user-facing status UI.

## 7. Automatic content reconciliation

The common case uses known accepted fingerprints and prefix checks, without redownloading
an unchanged remote archive. First contact, duplicate sources, stale CAS, missing evidence,
and generation changes use a verified coherent canonical download. Its returned revision,
not a previously listed revision, is the comparison/CAS base.

| Captured local L versus remote R | Body action |
| --- | --- |
| Identical bytes | Record byte coverage; apply the separate metadata rule below. |
| L is a proven proper byte prefix of R | Remote contains L; never truncate it. |
| R is a proven proper byte prefix of L | Publish L conditionally against R's verified revision. |
| Divergent or uncertain | Preserve the nonselected candidate, then prefer deterministically. |

Equality/prefix are exact byte evidence, not title, native validity, selected branch,
entry-ID overlap, clock order, or LLM judgment. No reserialization, repair, trimming, or
native rewriting. Prefix coverage means byte containment only, not semantic completeness.
For different divergent bodies prefer greater byte length, then lexicographically greater
lowercase SHA-256. This is deterministic, monotone under proper extension, and requires
no version-sensitive native scoring. Preferred is not objective truth; every noncovered
body remains retrievable.

Metadata disposition is separate and must use metadata coherent with the downloaded
revision (the new snapshot header described below):

- Equal bytes/equivalent normalized metadata: fully covered.
- Equal bytes/different metadata: keep canonical metadata (first accepted), preserve the
  incoming metadata-bearing candidate; body preference does not pretend to order truth.
- Proper prefix: ordinary descriptive changes (counts, activity, derived title/summary)
  follow the longer snapshot without retaining every earlier description. Preserve a
  shorter version's explicit kind/root assertion if the longer version contradicts **or
  omits** it; absence is unknown, not proof the known assertion is redundant. If L is
  shorter, archive that assertion before completing it; if R is shorter, preserve R
  before replacing it. Never union classification across bodies.
- Unknown/incoherent remote metadata: byte coverage may be known, but metadata completion
  or replacement waits for coherent evidence/preservation; do not infer equivalence.

On legacy 0.2 servers without `preserved_variants_v1`, matching `/list` and download
revisions can establish coherent metadata when available; a raced row requires retry.
Unsupported metadata-preservation obligations remain captured locally. Accepted-prefix fast paths retain normal snapshot-description
replacement semantics; this is not a historical metadata ledger.

For divergent bodies, preserve the nonselected version before completing the candidate
or replacing canonical: if remote wins, preserve local; if local wins, preserve the exact
remote revision server-side, then CAS-publish local against that revision. For equal/prefix
bodies, preserve only when the metadata rules require it. Any required preservation must
be durably accepted before dependent publication or candidate cleanup. A stale CAS repeats
comparison with the new current version; it never merely swaps the base revision into an
old request. Bound attempts and defer contention with jitter.

## 8. Minimal pi.server preservation extension

Legacy 0.2 servers without `preserved_variants_v1` keep only one body per native ID;
publication receipts do not preserve overwritten bodies.
Invented `session_id~conflict` aliases are not an acceptable substitute: they falsify
native identity, break main/root validation, and collide with unrestricted native IDs.

Add immutable **preserved variants** in a separate selector space under the original
native session ID. Keep current canonical publication/CAS and default list/download
behavior. Preserve server opacity: it stores exact bytes and client metadata, not Pi
parsing, model logic, or local filesystem paths.

Choose these additive wire operations; exact bounded JSON/header schemas are specified
and tested in the server protocol slice before storage implementation:

1. `POST /v1/preserve`, mode `uploaded`: stream exact candidate bytes; control header
   fingerprints binding, native ID, operation ID, byte length/digest, and optional metadata.
2. `POST /v1/preserve`, mode `current`: JSON control request fingerprints binding, native
   ID, operation ID, and expected canonical revision. Atomically preserve that version's
   body, metadata, and original upload information or return stale; no caller body.
3. `POST /v1/preserve-receipt`: original immutable preservation request; return accepted
   original outcome or unknown. Matching receipts are recognized before reevaluating CAS.
4. `/v1/list` gains exact `filters.session_id` and `include_preserved` (default false).
   Preserved rows retain native `session_id` plus separate opaque `variant_id`. Cursors
   bind opt-in mode/filters and order by activity key, native ID, canonical/variant
   discriminator, and variant ID. Opt-in decoders use that complete selector for uniqueness.
5. `/v1/download` gains optional `variant_id` alongside native ID. Verify both in snapshot
   metadata; unknown/mismatched selectors are `not_found`, never canonical fallback.
   Preservation-capable canonical downloads also include coherent archive `metadata` and
   `uploaded_at` in `X-Pi-Snapshot`. Old canonical consumers ignore additive fields.

Each new immutable variant receives a namespace publication sequence atomically with its
visibility, namespace head, and preservation receipt. Opt-in listing uses the existing
captured-head boundary for canonical and variant rows. Deduplicated preservation does
not change an existing variant's sequence or sort fields. Generation rotation reindexes
both kinds of rows before serving the new generation. The protocol slice fixes whether
deduplicated operations allocate a separate acceptance sequence; it must not mutate the
reused variant's listing identity. Maximal metadata/selector headers and one-row pages
must fit validated transport/page budgets; adjust new-version minima if necessary.

An accepted preservation receipt contains the exact request, immutable variant selector,
length/digest/metadata, and source revision/upload time when preserving canonical. Input
fingerprinting does not invent metadata in a preserve-current request: copied metadata
is a durable **result**. Operation IDs share one collision/mismatch domain across operation
kinds. An immutable variant's stored identity/dedup fingerprint distinguishes native ID,
body, and normalized metadata (including null versus empty), not just body digest; the
opaque selector need not itself encode that tuple. Repeat preservation of identical
content may reuse the variant, while retaining each original operation's durable outcome,
including that operation's source revision/upload time; do not overwrite shared variant
provenance with a later preservation. A main variant retains its original native root;
child variants retain theirs. Kind/root
and date filters apply to each row's own metadata. Default canonical list/download and
existing publication/receipt contracts remain unchanged.

Two-step preservation then conditional publication is enough; no combined remote job API:

```text
preserve-current(expected revision r) -> durable accepted receipt
publish(candidate, exact_base r)      -> accepted or fresh comparison
```

Persist an explicit dependency: publishing candidate against revision r requires an
accepted preserve-current result for the same binding/native ID/exact r whenever R
needs preservation. Validate original request fingerprint, binding/native ID, returned
source revision against expected r, and preserved digest/length against the compared download.
A stale preserve retires without permission to publish; a stale publish after successful
preservation triggers new comparison/dependency. Old-generation or uncertain receipts
cannot satisfy a current dependency. Crash between steps produces an extra safe copy,
not data loss. Immutable variant bodies cannot reference a
BLOB subsequently mutated by the existing in-place replacement code. Deduplicate content
where practical; charge retained bodies, metadata, and receipts to explicit quotas. No
automatic eviction of unique variants. Include them in migration, backup/restore, and
generation rotation. `/v1/discover` remains latest-canonical discovery, not a history feed.

Negotiate capability/version before relying on this extension. On legacy 0.2 servers
without `preserved_variants_v1`, verified byte coverage/extension can proceed when
metadata disposition is also established; divergence
and unsupported metadata preservation remain durably deferred, never forced or aliased.
A changed history generation fences old operations; retained candidates may be freshly
reconciled under the new generation for the same authorized server/namespace. An
undeclared rollback or two authorities sharing one binding remains unsupported.

## 9. Incremental implementation slices

1. **Transport/state seam**: explicit source scope, structured retries, additive journal
   migration, immutable successor candidates, legacy pending enumeration. Preserve behavior.
2. **Background runner**: inbox, transactional import, production bootstrap, kernel lock,
   wakeup/exit handshake, persistent backoff and authorization checks. Test independently.
3. **Lifecycle cutover**: shutdown becomes enqueue/wake only after existing teardown;
   startup/login wake existing work. Manual `upload [current|all]` schedules through the
   same queue and reports queued, not uploaded; root archive tools stay foreground reads.
4. **Automatic 0.2 reconciliation**: equal/prefix duplicates and generation revalidation;
   distinct coverage evidence, contention fairness, deferred divergence.
5. **Server preservation capability**: additive storage/protocol/receipt/quota/variant
   listing+fetch changes; keep canonical API compatibility and restore fencing.
6. **Complete automatic divergence**: preservation dependencies, deterministic preference,
   metadata variants, duplicate ancestry handling, updated lazy archive tool selectors.

Slices 1–4 deliver background capture/retry and limited reconciliation, not the complete
automatic-version-selection requirement. Slices 5–6 are a separately reviewable protocol/
storage change, not hidden lifecycle work. Each slice has focused tests before the next.
No giant cross-repo E2E/benchmark/CI project is a prerequisite. A small real subprocess smoke test is necessary to establish that the
worker actually survives the parent; fake timers cannot prove process lifetime.

Update current references only when implemented: Pilot README, docs/server.md,
security.md, subagents.md; pi.server protocol/operations and verification addendum.
Explicitly supersede old prohibitions on automatic outbound conflict/base revalidation
without claiming full native-session synchronization or editing historical review records.

## 10. Focused acceptance checks

- Departure has no HTTP, full transcript scan/hash/copy, or upload drain; enqueue survives
  parent exit and worker launch failure. Ordinary parent exit does not kill its worker.
- Inbox import crashes, duplicate launchers, empty-exit enqueue race, worker crash/restart,
  persisted backoff, no-wakeup-after-timer bug, and paused work do not lose queued items.
  Include enqueue during long backoff and config replacement/control-token replacement
  during worker retirement; acknowledging an old event cannot remove the new event.
- Current/custom directories include nested children/reviewers; partial scans retry;
  ephemeral/no-file roots skip; deferred-source deletion is reported, never called archived.
- Old pending operations recover without sources; newer candidates survive unresolved
  predecessors; late receipts cannot clear newer candidates or queue generations.
- Offline work retries after Pi exits; 401 does not hot-loop; logout/token/namespace/origin
  changes do not redirect queued history or leak credentials.
- Equal/prefix sources in any order converge in preferred body and retention obligations;
  equal-body canonical metadata is intentionally first-accepted. Divergence preserves all
  unique bytes/metadata under native IDs; concurrent preserve/publish races and lost replies
  are safe.
- Restore/new generation uses new operations and verified bytes, not old revisions;
  old servers defer unsupported divergence; full local/server capacity never evicts unique
  work. Grandfathered over-budget legacy bodies can still use recovery transport headroom
  while new source captures wait.

## 11. Review log

- Initial independent reviews: lifecycle/SDK integration, reconciliation/protocol, and
  simplicity/failure handling. Incorporated deferred-capture limits, separate variant
  identity, destination pinning, legacy recovery, packaging, and real wakeup semantics.
- Draft 1: three independent reviews requested changes. Resolved concrete Linux descriptor
  locking (reviewer subprocess probe passed), config-wakeup races, cached source scope,
  teardown semantics, Node/Bun packaging, explicit admission/fairness, durable operation
  retirement/fencing, byte-only preference, coherent metadata, and preservation API selectors.
- Draft 2: all three reviewers returned **ready to implement in slices**, with small
  clarifications. Revision 3 incorporates those: conditional control-event acknowledgment,
  manual-all ephemeral behavior, helper cleanup, read-only handover inspection, explicit
  backlog/working budgets, metadata omission preservation, divergence-only preservation,
  variant visibility/generation boundaries, and precise receipt/dependency checks.
- Revision 3 final delta checks: protocol and simplicity reviewers confirmed the fixes and
  repeated **ready to implement in slices**, with no new blockers.
- Review evidence is design/source inspection plus the lifecycle reviewer's temporary-file
  Linux descriptor-lock subprocess probe. It is not a passing implementation, native-host
  suite, performance benchmark, or power-loss qualification. At planning sign-off,
  production code was unchanged.
- Slice 1 implementation review: transport/source changes and focused tests completed;
  independent journal review identified capture/promotion and active-iterator races plus
  duplicate-integrity and mutable-budget gaps. Fixes and regression tests were reviewed
  and approved. Final sandbox-safe regressions: 212 passed, one symlink fixture skipped;
  typecheck and diff whitespace checks passed. Broader existing SQLite-backed suites
  still hit journal initialization/WAL shared-memory and symlink restrictions in the
  sandbox; this is not a passing host-suite verdict. No host execution was performed.
  Worker/lifecycle cutover and production WAL/parent-exit qualification remain deferred
  to the next slices.
- Full slice-1 convergence review: three fresh independent reviewers inspected all
  foundation files and integration boundaries. The first round identified inconsistent
  local/transport error provenance; fixes normalize failures at their origins and require
  the protocol JSON media type for server-error classification. Added direct quota-lock
  contention and real-discovery/outgoing-identity regressions. All three reviewers returned
  clean/ready after the second round; 52 focused client/capture tests passed. At that
  foundation checkpoint the manager constructor remained a compatibility API; the full
  worker cutover subsequently removed it in favor of serialized scopes.
- Full implementation convergence: independent runner/configuration, lifecycle/manual,
  read-service/tool, source/discovery, state/durability, reconciliation, and server reviews
  completed. Confirmed findings were fixed with regressions, including working-body
  reservations and fingerprints; incremental ancestry, cached missing-root evidence,
  incomplete-versus-invalid JSON and trusted seed aliases; uncertainty through replay and
  malformed replies; persisted request relationships; binding-wide and disputed-key
  exclusion; and exact preservation dependencies at execution and acceptance. Final frozen
  state/reconciliation delta reviews returned ready with no remaining concrete blocker.
  Dead source API removal is a separate behavior-preserving cleanup, not another feature.

## 12. Local implementation validation

At the full-worker checkpoint, the parent ran:

```bash
mapfile -t tests < <(find test -maxdepth 1 -name 'server-*.test.ts' | sort)
node --import jiti/register --test --test-concurrency=1 \
  "${tests[@]}" test/session-identity.test.ts \
  test/extension.test.ts test/managed-child-process.test.ts
npm run typecheck
```

Result: **525 tests, 519 passed, six sandbox symlink-fixture skips, zero failures**.
Global typechecking and scoped diff whitespace checks passed. Runtime/election tests run
serially rather than increasing production lock/launch deadlines. A packaging dry run
with lifecycle scripts disabled confirmed the bootstrap and worker/source modules ship.

The server implementation checkpoint is `254db4f`; `240339f` adds the reviewed publication-
base documentation clarification. Ordinary-sandbox server validation was:

```bash
cargo test --offline --lib preservation -- --test-threads=1
cargo test --offline --test archive_protocol --test config
cargo clippy --offline --all-targets -- -D warnings
cargo fmt --all --check
```

Result: **23 preservation + 12 protocol + 12 configuration tests passed**; clippy,
formatting, and whitespace checks passed. These focused tests are not a full server suite.

Qualification boundaries:

- SQLite fixtures explicitly use **DELETE journaling**. Production WAL is unchanged;
  transactional rollback/reopen tests do not qualify WAL/shared-memory or power loss.
- Production bootstrap/election tests exercise actual installation-relative loading and
  kernel contention. A separate delayed-fake-worker smoke proves its own lifetime only.
- The actual-worker integration uses the real worker/engine/state/source/client after
  ordinary launcher exit, fake HTTP, source deletion after capture, lost-response receipt
  recovery, same-worker SQLite connection close/reopen, and verified body release/exit.
  It does not prove worker crash/restart or real socket/pi.server transport.
- Trusted-alias behavior has controlled filesystem-boundary coverage; actual symlink
  fixture creation remains skipped where the sandbox returns `EPERM`/`EACCES`.
- No host/MCP fallback, native-sandbox integration suite, machine/cgroup lifetime, physical
  storage, or power-loss qualification is claimed. Exploratory nested-sandbox execution is
  excluded from this evidence. Logical quotas are not RSS or physical-disk caps.
