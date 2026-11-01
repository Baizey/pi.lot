# Final compaction study — offline disposition

## Final product decision

**Keep Pi's native compaction strategy. No experimental strategy changes are shipped.**

After reviewing the results, the user declined even the conservative native-parallel optimization: a modest split-summary
speedup without a validated accuracy gain did not justify adding production implementation. All production changes from
this study were rolled back. The pre-existing stock-compaction/subagent-snapshot wrapper remains unchanged.

The benchmark framework, frozen candidates and evidence are retained for possible future research. No further live calls
or prompt-tuning cycle are authorized. The private cache's `final-disposition.json` records this final product decision.
Original receipts, `derived-summary.json` and `parent-audit-verdict.json` remain unchanged as historical evidence; their
`productionSelection: parallel-native` fields describe the earlier recommendation, not the current runtime decision.

## Benchmark recommendation and scope (historical)

**Earlier benchmark recommendation: native parallel split compaction. Semantic unified v6 was disqualified.**

The benchmark recommendation was fidelity-first, not a claim that the fastest checkpoint was acceptable. Under the frozen
rejection rule, a source-verified material omission, contradiction, or invented dependency in either caller condition
disqualifies v6; stock defects do not excuse candidate defects. Native parallelism was initially selected after that gate
failed, then declined by the user. Both new production strategy modules were removed after research copies were preserved.
This experiment is not a runtime model-selection requirement.

Two controlled caller conditions were measured: `openai/gpt-6-luna` / low thinking and `openai/gpt-6.1-sol` / high thinking.
Actual prepared production candidates were called through thin experiment adapters. Requests used caller model output
limits, `cacheRetention: none`, fresh routing IDs at the common provider boundary, and no hidden retries. These named
conditions are measurement controls; the selected runtime component still inherits model, thinking and stream per run.

Latency is **summary-strategy elapsed time including worker cleanup**, not the full compaction lifecycle. Strategies and
conditions were serially scheduled; only the native parallel strategy's two independent split summaries overlap.
There is one PRIMARY observation per strategy/case/condition. These are small descriptive comparisons, not a population
latency guarantee, a promise of universal speedup, or a production end-to-end benchmark.

## Rollback verification

After the user declined production changes, the main checkout was restored to its pre-study native implementation,
documentation and tests; both new strategy modules are absent. The pre-existing subagent snapshot wrapper and unrelated
staged native changes were preserved. No installed extension was changed. Verification after rollback: **144 relevant production tests passed**, production typecheck passed, and the retained offline benchmark suite passed **192 tests with one
environment-dependent skip**; benchmark typecheck passed. No live model calls were made during rollback. The framework is retained as research-only source on `main`; it does not change the production compaction strategy.

## Preservation and private artifacts

Private cache: `/var/home/lsm/.cache/compaction-final-amended-20261101/`.

- `report.json`, `luna-low.json`, `sol-high.json`, `plan.json` and `frozen-receipt.json` are immutable raw artifacts.
- `derived-summary.json` contains separate offline statistics, provenance, fidelity disposition and the post-benchmark delta.
- `unresolved-call.json` conservatively records the possibly started final call without inventing a provider receipt or cost.
- `parent-audit-verdict.json` is the parent's source-verified decision, audit coverage and limitations.
- Earlier 4096-output-cap results remain separately labelled exploratory; they are not PRIMARY amended measurements.

The measured source/test copies are in `experiments/compaction/frozen-final-20261101/`, with a preservation manifest.
All four copies were independently checked against the raw-byte hashes, JSON-string fingerprints, and exact embedded
source strings in both original receipts. The measured `report.json` raw-byte SHA-256 is
`bd10e5f9778ca981b2b7a93d80cb975fc47f562fcb4a4f25ff5766d38298b6cb`.

| Preserved file | Raw-byte SHA-256 |
| --- | --- |
| `src/compaction/ConversationCompaction.ts` | `2ded946f73d9ec04561e1fad5be91c049784b1ba9fc55acf39a2f3ee1a9d47dd` |
| `test/conversation-compaction.test.ts` | `a649366421c5b1df8aea7ce0a0bef86d14ead84c6758801cbcac4fcc2f85a680` |
| `src/compaction/ParallelCompaction.ts` | `8219e4f4ce675d14d24f0061eb79b1ad37440277cb0263560df61b5df865e47c` |
| `test/parallel-compaction.test.ts` | `ac7bdcef1c2b76b3f69ae79e4b20797ca87ea0d9cf65e865b8dc94143c5fde1f` |

Those paths are relative to the frozen snapshot directory, not current production files. Future final-runner imports use
these preserved copies, including ConversationCompaction, and do not require the deleted main candidate. No frozen
prompt, scenario, criterion, measured snapshot, raw receipt or live result was edited during offline reporting.

## Completion, indexing correction and accounting

The benchmark owner timed out after **30/30 PRIMARY checkpoints plus 5/6 timing-only checkpoints** were persisted:
35/36 overall. Both conditions' heldout and historical PRIMARY trials completed. The missing checkpoint is Sol's timing-only
v6 repeat; v6 was already disqualified. Raw `status: running` and saved cleanup flags describe the last checkpoint, not
proof that a potentially subsequent provider call was joined or cancelled. Nothing was rerun to fill that gap.

The measured runner incorrectly changed the completed Luna repeat block's three `trial.result.repetition` values to 2,
although the independent report has `repetitions: 1` and thus requires index 0. The group name already identifies the
separately scheduled timing repeat. Only a **derived copy** normalizes those three indices to 0. The unfinished Sol repeat
already has valid zero-based indices. Corrections are listed individually in the derived summary; original reports,
plan and frozen receipt remain unchanged. The future runner no longer performs the mutation, and its obsolete group-level
repetition numbers were removed after freeze. This is a reporting/indexing correction, not a new measured trial.

| Ledger scope | Settled SDK calls | Catalogue-rate estimate (USD) |
| --- | ---: | ---: |
| Amended model-limit study | 113 | 1.92276082 |
| Prior 4096-cap exploratory run | 28 | 0.01445770 |
| Settled cumulative NEW-study total | **141** | **1.93721852** |

There is **one additional potentially started unresolved call**, outside the settled total: conservatively up to 142 calls
including that possibility. No per-call reservation or later provider receipt was found for it. The saved ledger's
`reservedUsd: 0` is not evidence that this subsequent call was free or never dispatched. Its catalogue cost, actual cost,
reservation amount and final cleanup status remain unknown. The unresolved record deliberately uses null amounts,
not invented zero cost or a fabricated provider receipt. No live reconciliation is authorized.

These are SDK catalogue-rate estimates, **not actual subscription charges**. Agent/reviewer activity is outside this ledger.
The independently authorized NEW-study guard was 192 calls / $10 catalogue estimate. Historical reports of 275 calls,
$0.5596833 estimated spend and two unknown calls with $0.00896025 reservation remain explicitly **unverified archival
accounting** because original temporary receipts were unavailable after reboot. They are not added to the 141 settled calls.

## Native parallel timing results

Speedup is stock elapsed / parallel elapsed; greater than 1 means faster. PRIMARY split aggregates are geometric means
across exactly three cases: the heldout split case plus two historical split cases. Timing-only repeats are not pooled
into those means. The no-reported-cache-read subset includes a pair only when both strategies report zero cache reads;
it does **not** establish physically cold provider execution.

| PRIMARY split case | Luna stock ms | Luna parallel ms | Luna speedup | Sol stock ms | Sol parallel ms | Sol speedup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Heldout split (`regression-held-02`) | 18,545.76 | 14,553.37 | 1.27433× | 34,778.53 | 28,331.03 | 1.22758× |
| Historical case 1 (`01a03f2f…`) | 21,051.42 | 17,778.55 | 1.18409× | 65,040.15 | 67,751.03 | **0.95999×** |
| Historical case 2 (`01a044d3…`) | 20,455.71 | 14,528.01 | 1.40802× | 93,957.79 | 65,959.97 | 1.42447× |
| Equal-case geometric mean | | | **1.28556×** | | | **1.18847×** |

**Sol historical case 1 regressed slightly:** parallel took about 4.17% longer than stock in this observation. The exact
raw-time ratio is 0.95998758× (approximately 0.96×), rather than a speedup on every case.

Luna's heldout stock trial reported **1,152 cache-read tokens despite `cacheRetention: none`**. Excluding that pair gives
a two-historical-case no-reported-cache-read geometric mean of **1.29121×**. Sol's three PRIMARY split pairs all reported
zero cache reads, so its corresponding subset mean is unchanged at **1.18847×**. Cache-inclusive figures above are
retained rather than silently replacing the measured baseline.

Historical-only PRIMARY means: **Luna 1.29121×**, **Sol 1.16939×** (two cases each).
The separate timing-only heldout repeat showed **Luna 1.55483×** and **Sol 1.24240×** for native parallelism. Both stock
and parallel checkpoints are present in those repeat pairs; only Sol's v6 repeat is missing. The repeats have no new
fidelity audit and are not extra independent clusters. Parallel delegates unsplit work directly to native compaction;
no separate parallel provider trial or unsplit speedup is claimed.

Parallel retains two native summary calls for a split turn. It does not promise token or cost savings. Different sampled
responses changed output counts and catalogue estimates; for example, the heldout parallel trial cost more than stock
in each condition. The benefit measured here is overlap, not a cheaper model or a rewritten summary policy.

## Fidelity outcome and limits

The decisive parent-verified failure was in Luna heldout case 02. The source required: “Review that function before
changing the parser.” V6's checkpoint instead required review “before changing anything.” A parser-specific gate became
a gate on all changes in the workstream. An independent blinded reviewer identified the expansion, and the parent
confirmed it against the complete visible source, checkpoint and continuation. It violates the frozen rejection rule;
a separate documentation permission does not restore the original gate's scope. Faster or shorter output cannot rescue it.

For completeness, v6 PRIMARY split geometric speedups were Luna **1.78430×** and Sol **1.18641×**, but v6 is **not accepted**.
On Sol historical case 1 it was slower than stock (0.91939×). Its missing timing-only repeat is not treated as a failure,
a success, zero cost, or a reason to obtain another sample. Automated grades do not overturn the source-verified defect;
Luna's decisive v6 checkpoint grade was unscored, while some other automated checks passed.

Audit coverage from `parent-audit-verdict.json`:

- Independent: all four Luna heldout sources, nine checkpoints and nine continuation sets; historical case 2's full source
  and three Luna checkpoints.
- Parent supplemental review: three Sol heldout sources, six checkpoints and two available continuation sets.
- Not completed: historical case 1 full-source audit, full independent Sol audit, and timing-repeat fidelity audit. The
  decisive first-condition failure sufficed to stop further v6 acceptance review under the predeclared rule.

Native summarization is **not perfect**. The audit reported a stock-only invented prerequisite in one heldout case and a
lower-confidence possible dispatch-gate expansion in another. Independent historical case 2 review also found **all three
strategies** omitted the active distinction between policy-area snapshots and hard mechanism capabilities. The relevant
file remains discoverable in native file inventory, but that distinction was absent from working memory. This shared
omission is recorded, not used to excuse v6 or claim that native parallelism fixes fidelity. Native parallel selection
preserves native policy, prompts and assembly; it does not certify every summary's semantic correctness.

## Post-benchmark candidate delta (withdrawn)

The measured Parallel hash was
`8219e4f4ce675d14d24f0061eb79b1ad37440277cb0263560df61b5df865e47c`.
The withdrawn post-benchmark error-path-fixed candidate hash is
`1b0a17f8b050da2cc5e723a306c344a2550bae878cbc574e7b72584974d0197f`.

Exactly one per-attempt `signal.throwIfAborted()` inside `produce` was removed. It had thrown before the provider's
returned aborted completion could reach native retry handling when `onRetryAttemptStart` cancelled, skipping native
`onRetryFinished`. Parent's new regression fails against the measured source and passes against the selected source.
Read-only comparison independently confirmed that this exact one-line removal produces the new hash; restoring it
reproduces the frozen measured hash. Successful prompts, options, routing, usage and assembly did not change. Genuine
transport throws retain native behavior. This error-path-only fix was not semantically rebenchmarked; timings above
belong to the frozen measured implementation, and no additional provider calls were made.

Parent reports **188 main regression tests passed, zero failed/skipped**, plus typecheck and `git diff --check`. The earlier
69-test target run is a subset, **not 69 additional tests**. The parent preserved the unrelated staged native AD checksum
`7fcc24ce4c07892bd001b7e46d5684d8f54cf844ad575b9dced4284ed92fb2f1`.
The full native host suite was intentionally not run inside pi.lot.

Offline benchmark validation during postprocessing: **192 passed, zero failed, one skipped** (symlink fixture creation
unavailable in this environment), and worktree typecheck passed. No full production/native suite was run from this
reporting worktree. The requested new indexing-regression test edit was denied by the scoped tool policy; it was not
retried or moved elsewhere. **No new unit regression was added.** The derived-summary generation exercised the new
reporting helper successfully against the preserved receipts. The 192 passing tests are the existing offline benchmark
tests, not coverage from a newly added indexing regression. Any further code/test changes await parent scope review.
