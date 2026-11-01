# Condenser exploration protocol

Experimental working notes, not pi.lot operating documentation; uncommitted with no production integration. **Active work:** unified v3 demonstrated speed/size gains but failed clean heldout retention. A source-blind general improvement and independently authored new scenarios are now being implemented and evaluated by the current agent, not handed off as future work. Prior run artifacts remain unchanged.

The user clarified that these runs use a **Codex Pro x5 subscription, not pay-per-run billing**. SDK catalogue USD figures (including legacy `spentUsd` fields and unknown-usage reservations) are comparative estimates, not actual charges. Continue in explicit bounded batches with cumulative accounting; an artificial catalogue-dollar ceiling is not a financial stopping condition.

## V4 development provenance correction

The first new development batch completed eight trials with unchanged v4 prompts: 2.10× paired geometric speedup and 55.5% smaller median checkpoints. It used 21 SDK calls, bringing cumulative usage to 147 calls. No new unknown usage arose. These are exploratory measurements, not a quality pass.

Source inspection found that judges lacked the authoritative native `fileOps` metadata used to append deterministic `<read-files>` / `<modified-files>` sections. Both stock and semantic checkpoints were consequently flagged for legitimate native inventory. Correct this at the grading boundary only: preserve native model-visible inputs and their hashes, append separately labelled assembly metadata to grading context, save that context for review, and explicitly restart development with cumulative accounting. Original grades/artifacts stay immutable; no retrospective numeric repair. Candidate policy and independently audited conversations are not changed to fix this evaluator defect.

Blinded narrative review found no demonstrated critical failure in the eight v4 development checkpoints, but confirmed minor additional workflow restrictions/sequencing. The coordinator independently verified those against source and chose to remove unsupported dependencies before heldout rather than normalize them away. A source-blind author adds a general v5-only rule keeping gates attached to their exact source actions and independent next actions unordered. This is separate from the evaluator provenance repair. Measured v3/v4 policies remain available unchanged; v5 uses the same audited development conversations, and no outputs from the four new heldout conversations have yet been generated.

## Runtime contract: inherit the active agent, never require a preferred model

The user clarified that model selection is not a deployment variable controlled by this compaction strategy. Like native
compaction, every recipe must use the model, thinking level and provider stream supplied by the active agent for that
operation. Changes to the agent’s selection must take effect on the next compaction; the strategy must not cache a model,
select Sol/Luna, silently upgrade or downgrade, or force low thinking. The existing adapters already accept this per-run
context. Dedicated caller-context tests now enforce propagation for all implemented recipes, including all map/merge and
parallel lane requests, with changing arbitrary model IDs and reasoning capabilities. This is a mechanical contract test,
not fidelity evidence. Production integration remains unchanged.

The completed Sol-low development batch is only a controlled datapoint: 16 checkpoints across eight seen regression
cases, 1.849× paired geometric speedup and approximately 50% smaller median checkpoints; selected-fact judgments all
scored retained, but full-source review is outstanding. It does not establish model-independent safety or turn Sol into a
requirement. Confirmed Luna fidelity failures remain blockers; a stronger-model result is not a substitute for addressing
them under the inherited-model contract. Original reports, frozen sources, accounting and criteria remain immutable.

## Luna v5 heldout: failed; Sol-low controlled comparison (not runtime policy)

The four new heldout cases, two repetitions per strategy, produced 16 checkpoints and 48 follow-up answers. Unified v5 achieved 1.94× paired geometric speedup and 55.8% smaller median checkpoints, with all selected facts graded retained and no unscored checkpoint judgments. **That was not a quality pass.** Two independent label-blinded full-source audits found an omitted original-data preservation instruction and an invented prerequisite for reviewing already available data in a candidate checkpoint. Bounded service-availability, attribution and blanket-status defects also remained. A separate omitted follow-up exception was present in its checkpoint and is a solver coverage omission, not compaction loss. Raw grades remain unchanged.

The coordinator directly verified the material source/checkpoint mismatch. No long-historical v5/Luna calls were started after this failure. The inspected eight validation cases are now seen regression development, not heldout evidence.

The user clarified subscription rather than pay-per-run billing, removing the original reason to restrict quality research to the cheapest model. The active controlled profile compares stock and the **unchanged v5 policy on the same physical `openai/gpt-6.1-sol`, low thinking**. It recalibrates judges, uses all eight seen cases for regression development, and requires four newly independently authored unseen cases plus the still-unseen historical outputs. Source-only regression criteria add the previously unselected preservation requirement before new outputs; prior criteria/artifacts are immutable. Model and suite choices are explicit and frozen across subsequent stages; all earlier calls/unknown usage remain in the cumulative ledger. The profile explicitly extends cumulative allowance from 256 calls / $5 catalogue guard to 384 calls / $10 catalogue guard, starting at 236 calls, $0.1487833 known catalogue usage and two inherited unknown calls with $0.00896025 reserved. Catalogue guards are resource estimates, not charges.

## Active validation gates (set before v4 outputs)

- A source-blind author revises only the general unified policy; a separate author creates four development and four unseen heldout conversations. An independent pre-output audit checks semantic entailment, currentness, material coverage and continuation mappings. Rubrics remain model-authored drafts.
- Development uses one repetition; heldout uses two. The quality gate requires no source-verified material omission, contradiction or unsupported claim in candidate heldout checkpoints or their checkpoint-only follow-ups. Exact cosmetic counts/timestamps are secondary unless the source makes them action-changing. Freeze that distinction in the fact statements before generation.
- Raw automatic grades are immutable diagnostics, not self-certification. Audit whole checkpoints and answers against full source; report false positives and unscored judgments separately, without retroactively replacing grades or weakening criteria.
- Performance targets are at least 1.5× paired geometric speedup and at least 25% median checkpoint-character reduction against stock on the controlled heldout set. Report per-case timings, output tokens and catalogue estimates; small samples do not establish universal guarantees.
- Two pinned long historical preparations receive independently authored pre-output draft criteria and checkpoint-only follow-ups through optional `--historical-criteria FILE`. Without that explicit file, historical mode remains speed-only. Historical material retention is independently source-reviewed, not inferred from synthetic results.
- Continue development on genuine audited defects; do not show source-specific answers to the prompt author. Once heldout outputs are inspected, any further prompt revision needs newly authored unseen cases. Production remains unchanged.

## Design intent

Find a general balance of fast generation, compact working memory, and safe continuation—not a benchmark-specific maximum. No old benchmark facts, identifiers, expected strings, or per-case routing appear in candidate prompts. Independent scenario authoring is separated from candidate implementation.

Compare native stock, parallel native split, a unified meaning-focused prompt, and two parallel semantic lanes with the same meaning-focused policy. The two lanes own intent/constraints/decisions and working state/evidence/open work/next actions. Assembly is deterministic; no model merge or runtime critic. Both see native-visible source in chronological groups and the prior checkpoint.

Initial output guidance is a soft size-dependent budget, not a claim that all inputs admit the same compression ratio. Preserve information if omitting it changes an action, violates a requirement, repeats meaningful work, or makes evidence ambiguous. No automatic global prompt self-editing. Improvements must be general loss-prevention rules, versioned and reviewed, rather than stored answers to evaluation cases.

## Implemented v3 family; selected experimental candidate: semantic-unified-v3

`experiments/compaction/SemanticCompaction.ts` exports `createSemanticCompaction({id, mode: "unified" | "dual"})`. The authorized study selected **unified** through `scripts/explore-compaction.ts --candidate unified`; the module's existing default export is still the dual-lane adapter, not the selected recommendation. The candidate source and prompts were unchanged throughout development, heldout and historical trials. Nothing is registered in production.

| Concurrent owner | Prompt responsibilities |
| --- | --- |
| Intent and decisions | Current objective; requirements/prohibitions with original scope, responsible actors and exceptions; active choices with only useful rationale |
| Working memory | State reached with evidence and verification limits; unresolved questions; established next actions with prerequisites and actionable references |

Both owners see the same native-visible prior summary, history and partial turn prefix, with explicit chronology. The selection rule is action impact, not a chronological catalogue of everything done. Source is quoted data, not executable instructions. Soft total output guidance is 400–1600 tokens depending on visible source size, divided 40/60; this is not a guaranteed size limit. Assembly is deterministic and model text remains verbatim. Native `compact()` performs final file-inventory/metadata assembly through a local replay; there is no model merge or critic in the latency path.

Dual mode trades duplicated input reading and possible cross-lane overlap for a shorter generation critical path. Unified mode uses the same policy in one request when cost/coherence matters more than concurrency. There is not enough evidence to choose a universal automatic routing threshold or to claim the final v3 is better than stock.

## Before looking at outputs

1. Develop on four independently authored mixed-domain synthetic conversations. The strategy implementation must not inspect their facts. Freeze candidate code/prompt snapshots in every run artifact.
2. Compare generation latency, usage/cost, final checkpoint size, source-grounded retention and critical failures separately. A faster but unsafe result is not satisfactory; a longer result does not win merely by keeping more facts. No equivalence claims from cheap-model scoring.
3. Revise only for general shortcomings. If revising after looking at a held-out case, that case becomes development data; require new held-out examples.
4. Check the selected design on two unseen conversations with two repetitions and natural follow-up questions. Follow-up solvers receive only the checkpoint, not source or rubric; expected answers stay hidden. Fact grading and follow-up grading occur outside timed generation.
5. If promising, perform a small frozen-prompt speed/size spot-check on two historical conversations selected without consulting past candidate scores. This is not a broad real-workload quality proof.

A satisfactory *experimental candidate* must preserve critical continuation information with no material contradictions in the reviewed held-out trials, retain useful source-grounded information comparably to stock, actually condense the source, and offer a useful observed latency/size trade-off. Small timing samples and model judgments are fallible; no universal performance threshold, production shipment, or losslessness claim follows. Stop rather than expand into a large paid sweep without approval.

## Development refinement (recorded after v1 outputs)

The first development run used 40 SDK calls and $0.0193678 estimated, including calibration and judging. All generation metadata and cleanup checks passed. Automatic quality comparison is incomplete: three malformed judgments remain unscored, not zero. Its case-level timings are exploratory, not a population guarantee.

Initial automated feedback alleged strengthened restrictions, a lost handling qualifier, and broad implementation-status inferences. These were hypotheses to verify, not established defects; the later source audit below found false positives and an incorrect criterion. Version 2 adds scope/modality fidelity and binds consequential qualifiers to their action/object; it reports specific verification evidence rather than guessing a general status. No scenario-specific values are added. The four development criteria and both unseen cases remain unchanged.

An explicit refinement stage carries the entire prior bill forward. Only candidate prompts, the orchestration entry point needed to run the refinement, and this development log may change. Source scenarios/criteria, grading prompts, core timer/scheduler/statistics, budget owner and native replay machinery remain pinned. The refinement retests stock alongside the selected candidate. Native parallel-split is omitted on wholly unsplit scenarios because it is the identical single-call path, not independent parallelism. All code is frozen again before held-out evaluation.

## Source audit and reliability correction (after v2 interruption)

At the original v2 interruption, paid SDK work was PAUSED, not successfully completed: 52 calls started, $0.023345 reported, $0.0048555 retained as an unknown-usage reservation. One completed response failed JSON parsing; aborting its healthy peer produced unknown usage. The guard blocked later calls. No held-out or historical candidate run or live v3 result existed at that handoff. Do not reset the ledger or equate reserved cost with known billing.

A direct source audit also found weaknesses in the new synthetic harness, despite prior model reviews: references were raw message JSON rather than `referenceInputs(preparation)`; prior checkpoints were ordinary assistant messages rather than `previousSummary`; all cases were unsplit; and one compound handling criterion invented a storage-location requirement. Thus the original quality results are not decisive evidence. Some alleged unsupported constraints were actually entailed by the source. The timing measurements used matched preparations but only demonstrate exploratory whole-window performance on those old controlled inputs, not iterative/split real-workload performance.

The corrected factory uses native-visible references, actual prior-summary and mixed split boundaries, exact preparation counts, and source-faithful criteria. Its complex model-authored rubrics remain **draft**, even after model review; live scoring requires explicit `--allow-draft-rubrics` and is exploratory until human semantic audit. Old artifacts and criteria are preserved unchanged and must not be retroactively regraded as though these fixes predated the outputs.

At that handoff, offline validation passed typecheck and 100 tests, with one artifact-symlink fixture skipped by the environment. A synthetic-response replay over all 12 pinned historical preparations passes 36/36 trials across stock, parallel-native, and v3. Its 72 calls are synthetic, not provider calls; all speedups and quality means are null. All 12 historical source hashes are unchanged. No host/native sandbox integration was attempted.

Version 3 removes unnecessary JSON/prose parsing: lane ownership provides structure, prompts request readable subsections, and deterministic containers preserve complete text even if harmless heading style varies. Successful provider calls settle before local content validation, so a local formatting defect cannot abort a healthy sibling merely to save a few tokens. Transport failure/cancellation still aborts and joins peers. These are offline-tested changes, not demonstrated live quality/performance gains.

A learning loop must verify criticisms against source before promoting them into prompt rules. Keep general lessons about scope, modality, ownership, and evidence; never encode case-specific answers or blindly train on a fallible judge. The next paid step needs explicit authorization/reconciliation for the unknown reservation and a newly frozen evaluation; it is not an automatic continuation of this stopped run.

## Authorized fresh validation after the pause

The user authorized continuing the experiment in root session `01a1939e-26e4-75ca-83bb-3c3080add985`, after the prior handoff in `01a18ecd-4c13-77ae-8226-17703d51e0da` was recovered. This authorizes a new bounded validation, not retroactive settlement of unknown billing or production installation. Experiments remain uncommitted.

A development restart requires `--restart-from PRIOR_REPORT --reserve-unknown-usage`, plus the original overall call/cost caps. The runner verifies the available receipt chain and records its hashes. All 52 prior started calls, $0.023345 known usage, and $0.0048555 unresolved reservation remain charged against the original 128-call/$0.25 ceiling, leaving at most 76 calls/$0.2217995. Known spend and unknown reservations stay separate; the old artifact is not rewritten. Ordinary `--previous` progression still rejects newly unknown or incomplete current-stage work. Starting an unrelated fresh ledger is not a safe resume.

The first authorized attempt stopped during calibration before any summary trial: a DNS approval was cancelled when the worker exited before scope selection. The audit records a SYSTEM fail-closed result, not an explicit user denial. The same mediated Bash path subsequently obtained a normal session DNS allow and an unauthenticated HTTPS OPTIONS response; no model invocation was used for readiness. The stopped receipt remains private and unchanged. Conservatively count its started SDK call and $0.00410475 reservation too: cumulative accounting is now 53 calls, $0.023345 known spend and $0.00896025 unresolved reservations, leaving at most 75 calls/$0.21769475. An explicitly authorized pre-report restart requires an explicit completed-cleanup receipt; it cannot waive an in-flight reservation or incomplete cleanup.

Before new outputs, a source audit corrected remaining draft-criterion scope/negation ambiguities, clarified internally inconsistent development source wording, and added consequential clock/coverage criteria already established by the source. Scenario factory version 3 identifies these corrected fixtures. Earlier outputs are not retrospectively rescored against them. Rubrics remain model-authored drafts. The existing semantic v3 prompt is unchanged; any later prompt refinement after this coordinator has seen heldout wording must be implemented by a separate source-blind author using only general, source-verified development findings.

Fresh development compares stock, unified v3, and dual v3. Native split concurrency is a separate `--native-parallel` opt-in, frozen across phases, rather than mandatory duplicate grading on every exploration. Candidate selection considers source-checked critical failures, continuation value, latency, checkpoint size and cost together. A promising frozen candidate proceeds to two heldout conversations with two repetitions and checkpoint-only follow-ups. Historical spot-checks run only if the remaining call/cost budget permits. No satisfactory result is assumed in advance; stop honestly if evaluation fails or the budget is exhausted.

## Authorized live results (2026-10-31)

The selected v3 prompt was evaluated with `openai/gpt-6-luna`, low thinking, unchanged source/prompt snapshots and no hidden retries. Development used four synthetic conversations with one repetition; heldout used two independently authored conversations with two repetitions and eight checkpoint-only continuation trials. Historical measurement used the first two distinct-session cases from the pinned corpus, selected without candidate-output scoring, with one repetition and **no quality grading**.

| Unified v3 versus stock | Paired geometric speedup | Median final checkpoint characters (stock → unified) | Summary-generation SDK cost change |
| --- | ---: | ---: | ---: |
| Development: 4 controlled cases, 1 repetition | 1.89× | 3,897.5 → 2,209.5 (43% smaller) | 34% lower |
| Heldout: 2 controlled cases, 2 repetitions | 2.09× | 5,022.5 → 2,410 (52% smaller) | 40% lower |
| Historical: 2 pinned long preparations, 1 repetition | 2.38× | 7,191.5 → 4,749 (34% smaller) | 8% **higher** |

The historical preparations had approximately 392,000 and 334,000 native-visible source characters. Unified took 10.44s versus 24.64s, and 9.24s versus 22.09s. Input dominates cost there: unified consumed more input tokens despite generating less output. These are small-sample strategy timings including worker cleanup, not full compaction lifecycle or universal speed guarantees. The two-session phases cannot support a cluster-bootstrap interval. No cache reads/writes were reported in these comparisons. All 12 corpus source hashes across five distinct files remain unchanged.

Dual v3 achieved 2.05× development speedup, but had larger, more expensive checkpoints than unified and promoted planned test coverage to completed coverage in a source-audited output. It was not advanced to heldout. Stock also showed genuine unsupported scope/status/cohort assertions; it is not a lossless oracle.

**Quality remains unresolved, with demonstrated defects.** Two development judgments, two heldout checkpoint judgments and two continuation judgments were malformed/unscored. Official comparative quality means remain null; no retries, numeric replacement grades, or retrospective rubric edits repaired them. Several automated criticisms were false positives or considered only one passage of a longer summary. Separate blinded model review checked full source/checkpoint/answer text, not timing or strategy labels; this is qualitative evidence, not human curation.

The heldout unified outputs retained many core operational and causal safeguards, but one dropped an actionable web reference, another lost the purpose/beneficiaries attached to a help contact, and one made a blanket absence-of-verification claim despite an established item-specific verification result. Checkpoint-only follow-ups exposed the lost route/purpose. A secondary attribution qualifier was also lost. Therefore neither a satisfactory-quality outcome nor production equivalence is established. The historical phase supplies **no retention evidence** and does not repair these failures.

Artifacts are new private 0600 files outside the worktree:

- `/tmp/pilot-condenser-v3-authorized-development-r2-20261031.json`
- `/tmp/pilot-condenser-v3-selection-20261031.json`
- `/tmp/pilot-condenser-v3-authorized-holdout-20261031.json`
- `/tmp/pilot-condenser-v3-authorized-historical-20261031.json`
- `/tmp/pilot-condenser-authorized-results-manifest-20261031.json`

Final cumulative accounting: **126/128 started SDK calls, $0.0909822 known usage, plus $0.00896025 unresolved reservation**. This includes all prior stages and the DNS-blocked calibration attempt; no previous ledger was reset. Coding/reviewer conversation costs are excluded. At that study boundary, two calls remained under the original call cap. The user subsequently instructed the current agent to continue until the outcome is satisfactory and clarified subscription billing. The next explicitly bounded batch extends resource guards while carrying forward all calls, known usage and unresolved reservations; it does not reset the ledger or create per-run charges.

The active follow-through strengthens general action–purpose–reference bindings and item-specific verification evidence without making every identifier mandatory. A source-blind author owns the new prompt and a separate independent author owns new development/heldout conversations. Do not encode inspected cases or weaken criteria to obtain a pass. Continue source-reviewed paired trials and checkpoint-only follow-ups until quality looks satisfactory, preserving reproducible bounds and actual subscription-capacity limits. Keep production unchanged until quality improvements are demonstrated.

These notes moved from `docs/` to `experiments/compaction/notes/` after the v3 study. Immutable artifacts retain their original source path names and snapshots; only future plans reference the new location.

Validation after the harness/fixture changes: `npm run typecheck` passes; `node --import jiti/register --test test/compaction-*.test.ts` reports **109 passed, 0 failed, 1 environment-related symlink skip**. No privileged native/host integration ran. Documentation was updated after all measured stages; immutable run artifacts retain their original frozen source snapshots.

## Budget and reproducibility

All live exploration uses openai/gpt-6-luna with low thinking. Overall ceiling: 128 SDK calls and $0.25 SDK-estimated cost across stages. Subsequent stage caps subtract prior settled usage/calls; unknown billing or unfinished cleanup blocks continuation. These are conservative SDK estimates, not an invoice guarantee. Agent/coder/reviewer conversation overhead is excluded. No hidden retries. Artifacts are new private 0600 files outside the worktree. No original session writes or commits.
