# Compaction experiments

Research tooling, isolated from production compaction. These notes belong to the experiment, not to pi.lot's operating documentation in `docs/`.

## Current disposition

**Keep Pi's native compaction strategy.** The user declined production changes: the modest split-summary speedup did not justify additional implementation without a validated accuracy improvement. The production experiment was rolled back; the pre-existing native-compaction/subagent-snapshot wrapper is unchanged. All alternative strategies remain research-only.

The framework, frozen candidates and evidence are retained on `main` for possible future research, not continued rollout. No new live study is authorized by this disposition. Worktree paths in older notes are historical; run the retained scripts from the repository root.

- [Final benchmark, limitations and product decision](notes/final-benchmark.md)
- [Strategy benchmark and historical corpus](notes/compaction-benchmark.md)
- [Small-fixture evaluation controls](notes/compaction-evaluation.md)
- [Condenser exploration history](notes/condenser-exploration.md)

## Runtime model contract

Strategies inherit the active agent’s model, thinking level and provider stream on every compaction. They do not choose a
preferred model, require Sol/Luna, cache a previous selection, silently switch providers, or force a thinking level. Every
lane, chunk and merge follows that same caller-supplied context; credentials and any model routing remain the host’s
responsibility. Off/non-reasoning behavior matches native compaction.

Named models and fixed thinking levels in benchmark commands are controlled measurement conditions, not runtime
requirements. A favorable result on Sol cannot excuse a confirmed fidelity defect on another agent-selected model.
Caller-context regression tests cover model changes between runs, reasoning and non-reasoning models, and off/low/high
thinking across stock, parallel-split, chunked and semantic recipes. These offline tests prove propagation, not semantic
quality on every model.

Run scripts from the repository root. Offline plans/tests do not contact models. Live batches require explicit resource
guards and preserve the cumulative usage ledger, including incomplete usage records. SDK catalogue-price estimates
are not actual charges for the user's Codex Pro x5 subscription. No experimental strategy is enabled in production.
