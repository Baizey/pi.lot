# Compaction evaluation experiments

This is an opt-in evaluation harness, **not a production parallel compactor**. Pilot's normal compaction behaviour is
unchanged. The stock Pi 1.4 summarizer is the baseline; future experimental adapters can be compared without installing them
as extensions. `experiments/compaction/IdentityControl.ts` is an identical-algorithm A/A control, not an optimization.

## Safe default: offline smoke

```bash
npm run eval:compaction -- --output /tmp/compaction-smoke.json
npm run eval:compaction -- \
  --candidate experiments/compaction/IdentityControl.ts \
  --output /tmp/compaction-control-smoke.json
```

Smoke mode uses canned provider responses, does not load user credentials, and makes no network/model calls. It exercises
Pi's actual summary generation and input preparation. Its summaries, quality checks, and tiny timings **are not evidence of
real summarization quality or speed**; comparison speedups are deliberately null. The output is labelled `mode: "smoke"`.

The unit suite is mount-free and needs no native helper build:

```bash
npm run typecheck
node --import jiti/register --test test/compaction-evaluation.test.ts
```

## Explicit live runs

```bash
npm run eval:compaction -- \
  --live --model provider/model-id --thinking medium --repetitions 5 \
  --candidate experiments/compaction/IdentityControl.ts \
  --output /tmp/compaction-control-live.json
```

`--live` makes potentially billable calls using the Pi SDK's configured credentials. The model must be an authenticated
physical model, not a virtual route. All variants use the same selected model and requested thinking level. The provider may
clamp unsupported thinking levels; choose a model/level combination it supports before interpreting results.

Only committed **synthetic** fixtures are sent. The harness has no automatic session/archive import. Do not add real
transcripts without explicit review and permission: session history can contain secrets and private source. Candidate modules
are trusted executable code; never load an untrusted downloaded adapter. Its entry-file SHA-256 is recorded, but that is not
a hash of its entire transitive dependency graph.

Options are listed by `npm run eval:compaction -- --help`. `--fixture` selects `whole-history`, `split-request`,
`iterative-checkpoint`, or `tool-result-tail`; the default runs all four. Start with the A/A control to understand noise and
provider throttling before testing an actual optimization.

## What the harness measures

For each fixture and repetition, stock and candidate run sequentially, alternating their order across repetitions. Internal
worker concurrency belongs to the candidate; different variants do not contend with one another during a paired trial.

The runner owns the stopwatch and metered model stream. End-to-end trial time includes all summary/merge calls and worker
cleanup, not just the fastest worker. Setup/fixture preparation is outside that interval. This measures the complete summary
strategy, **not** the full `AgentSession.compact()` lifecycle: checkpoint persistence, Pilot's deterministic subagent snapshot,
and UI rendering are excluded. Reports identify this `timingScope` explicitly. Reported data includes:

- Raw end-to-end and individual-call durations, plus paired median speedup for live comparisons.
- Exact model, requested thinking level, Node/Pi versions, preparation/context/summary hashes, and summary text.
- Per-call token/cache/cost usage and measured aggregate usage; `usageComplete: false` means missing/incomplete usage,
  **not zero cost**. Error/abort responses with SDK placeholder counters never count as complete billing receipts.
- Token estimate, retained boundary validation, file-list validation, and the effective compaction settings.
- Per-fact retention results and questions for human semantic review.

No prompt-cache writes are requested. Actual cache reads remain visible in usage. Repeated trials, rate limits, provider load,
and model/backend updates still affect timings. A few trials do not provide a confidence interval or establish a production
speedup. Keep raw reports and use enough repetitions across multiple workloads.

The fixtures deliberately use a small **550-token retained tail** to exercise full-history, split, and iterative mechanics
cheaply. They are not representative production-length benchmarks. Large-context trials with the normal 20,000-token tail
and representative, reviewed workloads are required before deciding whether parallel compaction is worthwhile. These small
cases are useful for correctness and initial latency controls, not extrapolating long-context performance.

## Quality is a separate gate

Literal checks verify exact identifiers, paths, and selected facts. They are a regression screen, **not a semantic judge**.
A summary can repeat every expected word and still reverse a constraint, invent completion, or give the wrong next step.
Answers/rubrics are kept out of the experiment input, but the fixtures are public and are not a held-out benchmark.

A candidate must preserve the same retained boundary and cumulative file lists. It must pass all fixture checks and retain
all facts that stock passed, rather than being called equivalent merely because both variants lost something.

The `tool-result-tail` case intentionally exposes a stock limitation: Pi serializes only the first 2,000 characters of each
tool result. Its exact failure evidence is beyond that boundary. This is a useful baseline failure, not a reason to weaken
the check. It distinguishes information the summarizer never received from information it omitted.

A passing live comparison therefore ends at `requires-semantic-review`, **never "quality proven"**. For each report:

1. Review complete stock/candidate summaries against the fixture conversations and the report's review questions, preferably
   with variant identities hidden from the reviewer.
2. Check negations, superseded decisions, done versus pending work, and tested versus unverified claims.
3. Test continuation tasks from the checkpoint on representative cases: can an agent correctly identify the current next
   action, respect protected files/APIs, and avoid repeating a failed approach?
4. Require no material quality regression across repeated runs before accepting a latency improvement.

This original small-fixture harness does not automate semantic judging, downstream continuation tests, or statistical
significance. The newer [strategy benchmark](compaction-benchmark.md) and [condenser exploration](condenser-exploration.md)
add source-grounded draft grading, checkpoint-only follow-ups, and carefully scoped timing statistics. Their current live
results still contain unscored judgments and demonstrated information losses. No speed/quality result follows from unit
tests alone.

## Experimental adapter contract

Default-export an object implementing `CompactionExperiment` from `experiments/compaction/CompactionEvaluation.ts`:

```typescript
import {stockCompaction, type CompactionExperiment} from "./CompactionEvaluation.js";

const candidate: CompactionExperiment = {
    id: "my-experiment",
    async run(input) {
        // Replace this only in the experiment; input contains preparation/model/thinking/signal/metered stream.
        return stockCompaction.run(input);
    },
};
export default candidate;
```

Use `input.stream` for **every** model call. Pass the supplied cancellation signal, await all workers and merges, and return a
complete `CompactionResult`. The runner cannot meter model calls an adapter makes outside that boundary. Returning with
unfinished calls, empty summaries, changed retained boundaries, or inconsistent file lists invalidates the result. Failures
and deadlines abort owned calls; a provider that ignores cancellation is reported invalid after a bounded cleanup wait.
Do not use ordinary retained Pilot jobs for a measurement without also accounting for their startup, completion, cancellation,
and cleanup inside the timed operation. The adapter promise itself is also joined during cancellation. If either adapter or
provider fails to settle within the cleanup grace period, the report is marked `interrupted` and later trials are not started;
otherwise lingering cleanup could contaminate every subsequent timing.

No replacement summarizer is enabled in production. Experimental native history/prefix concurrency, bounded chronological
chunking, and unified/dual semantic condensers now exist in this worktree; see the newer benchmark and exploration references
above for measured results and limitations. The selected unified v3 is faster and smaller in the bounded study, but heldout
continuations exposed functional information losses. It is not a production or semantic-equivalence pass.
