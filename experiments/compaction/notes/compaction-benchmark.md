# Compaction strategy benchmark (experimental, uncommitted)

A reusable comparison of compaction **latency/cost** and **continuation-value retention**. This is separate from the
production subagent-checkpoint wrapper. It registers no extension, changes no installed checkout, and never rewrites
historical sessions. All benchmark code stays in this experimental worktree; do not commit private corpora or reports.

## What is compared

| CLI strategy | Algorithm |
| --- | --- |
| `stock` | Pi's exported native `compact()` helper, including sequential history/turn-prefix calls when split |
| `identity` | A/A control: the same implementation under ID `identity-control` |
| `parallel-split` | Overlap only the two independent native split-summary requests; unchanged single-request fallback |
| `chunks-sync` | Chronological native map summaries followed by a native merge, one map worker |
| `chunks-parallel` | **The same map/merge algorithm**, with bounded parallel map workers |

Every variant gets a fresh clone of the same preparation, physical model, requested thinking level, per-call output cap,
retained boundary, and original file operations. A strategy cannot change the selected model or thinking through the
budgeted stream. Native helper calls—not copied stock prompts—produce the summaries.

Chunking keeps an assistant's tool calls and all available corresponding results together. Calls with no result in the
compacted input remain unresolved; no result/completion is invented, and later unrelated history stays chunkable.
Previous summary context is supplied
only to the first map chunk. Empty map file operations avoid duplicate native file tags; final merge uses the original
boundary, token count and file operations. Oversized indivisible bundles can exceed the target. `--max-chunks` bounds fanout
before provider calls. Zero/one-chunk preparations use the stock path rather than pay for a redundant merge. Multi-chunk
map/merge rejects incomplete, tool-call, aborted and blank summary responses, aborts peers on failure, and joins started work.
Chunk fallbacks retain native request construction but use these same strict response checks; all variants’ trial meters
also invalidate incomplete responses even if native stitching would otherwise accept their text/file tags.

Chunking deliberately changes the algorithm/prompts and introduces an extra lossy merge. The two chunk variants isolate
**scheduling** from that algorithmic change. They are not expected to be semantically equivalent to stock.

## Private, pinned corpus

Discovery selects historical compaction points round-robin across sorted, deduplicated root-session files, rather than
exhausting a single long session first. It records rejected files/checkpoints. Child/fork sessions and duplicate native
session IDs/aliases are excluded. Use several projects/session families if broader coverage is needed.

Public SDK parsing/migration and in-memory branching replay the selected checkpoint's **parent**, then a local
`session_before_compact` capture cancels before generation. Only the local capture/cancel hook runs: no project/Pilot
extensions, tools, real credentials or model calls are used during capture. The evaluated checkpoint's saved summary, future entries and sibling branches are not evaluation inputs.

A manifest pins Pi version, source SHA-256, preparation/reference hashes, native session cluster, retained token count,
and history/prefix message counts. Preparation revalidates these before live trials. Full-file source hashes are strict:
appending to an active source file invalidates the pin even if the selected historical branch is unchanged. Prefer stable
historical files; recapture intentionally if sources or Pi change. Current replay uses Pi 1.4.0's 20,000-token recent tail
and 16,384-token reserve; it is not a replay of historical versions' private orchestration or Pilot extensions.

Reference material is exactly the native-visible previous summary/history/turn-prefix serialization. Thinking and images
are omitted and tool text is truncated as in native compaction. Therefore this measures loss **at the selected checkpoint**,
not information already absent from the previous summary or serializer. The unchanged recent tail is not part of the
retention rubric. Scores measure checked information in the compacted window, not end-to-end task success; a fact omitted
from a summary could still be available in the unchanged tail. Discovering more checkpoints does not by itself create more
independent sessions.

## Workflow

Run commands from this experimental worktree. `--output` must name a **new path outside the worktree**. Files are private
`0600`, atomically replaced during progress, and existing files/symlinks are refused. Reports, quotes, model outputs and
source paths are sensitive; don't upload or commit them.

### 1. Discover a larger corpus (local only)

```sh
npm run bench:compaction -- discover \
  --session-directory "$HOME/.pi/agent/sessions/--var-home-lsm-repos-pilot--" \
  --limit 24 \
  --output /tmp/pilot-compaction-corpus.json
```

Repeat `--session-directory` or `--session FILE` for explicitly selected additional sources. Directories are not searched
recursively. The limit is a maximum, not a guarantee that this many usable checkpoints exist. Inspect rejection counts and
case/session coverage before calling the sample representative.

### 2. Exercise strategies without a provider

```sh
npm run bench:compaction -- run \
  --corpus /tmp/pilot-compaction-corpus.json \
  --strategies stock,identity,parallel-split,chunks-sync,chunks-parallel \
  --repetitions 1 --workers 4 --chunk-tokens 12000 --max-chunks 16 \
  --output /tmp/pilot-compaction-smoke.json
```

Without `--live`, replies and usage counters are synthetic. This checks replay, scheduling, fanout, metadata and reporting;
**all speedups, confidence intervals and quality means are null**. It does not test real summarization quality, provider
latency or pricing. Grading is not fabricated in smoke mode. A trusted custom adapter can have arbitrary side effects;
the no-provider guarantee applies to the built-ins and supplied stream, not a sandbox around executable modules.

### 3. Draft source-grounded retention criteria, then audit them

```sh
npm run bench:compaction -- draft \
  --corpus /tmp/pilot-compaction-corpus.json \
  --case 'SESSION_ID:checkpoint-0' \
  --live --model openai/gpt-6-luna --thinking low \
  --max-output-tokens 4096 --max-cost-usd 0.05 --max-calls 1 \
  --output /tmp/pilot-compaction-drafts.json
```

Drafting sees only the actual source—not generated strategy outputs. Facts include a category, importance weight 1–5,
critical flag and exact source evidence. Validate quotation grounding and **manually check semantic entailment**, chronology,
coverage, weights, negations, and whether old decisions are superseded. Exact quote matching does not prove that a statement
is correct. Generated rubrics remain `draft`; the model cannot certify them as curated. Edit only audited rubrics to
`"status": "curated"`. Every selected scored case needs a rubric. Repeat drafting against the new manifest/output for more
cases, or omit `--case` to draft the selected corpus within an explicitly adequate budget.

For early exploration, `--allow-draft-rubrics` explicitly permits draft scoring, labelled **exploratory**. Do not describe
these numbers as an independently curated quality benchmark. Without `--live`, `draft` produces a plan, not invented facts.
Rubric/corpus hashes are frozen before strategy generation and retained with the report.

### 4. Check the judge and run a budgeted live comparison

Standalone cheap judge check:

```sh
npm run bench:compaction -- calibrate --live \
  --model openai/gpt-6-luna --thinking low \
  --max-cost-usd 0.02 --max-calls 4 \
  --output /tmp/pilot-compaction-judge-controls.json
```

A value-scored `run` also performs these four synthetic controls **before any timed strategy** and stops if they fail.
They test faithful retention, critical omission, negation reversal, and superseded state. Passing is necessary for this run,
not evidence that the judge reliably understands arbitrary real tasks.

Start with a small curated subset, e.g. two explicitly selected cases, rather than launching a large paid sweep blindly:

```sh
npm run bench:compaction -- run \
  --corpus /tmp/pilot-compaction-curated.json \
  --case 'SESSION_A:checkpoint-0' --case 'SESSION_B:checkpoint-0' \
  --strategies stock,identity,parallel-split,chunks-sync,chunks-parallel \
  --repetitions 3 --judge-repetitions 2 --seed 1729 \
  --workers 4 --chunk-tokens 12000 --max-chunks 16 \
  --live --model openai/gpt-6-luna --thinking low \
  --max-output-tokens 4096 --max-cost-usd 1 --max-calls 300 \
  --output /tmp/pilot-compaction-live.json
```

These are **caps**, not a prediction or guarantee of completion at that cost. Four calibration calls, all map/merge calls,
and every judge repetition consume the same budget. Adjust the selected corpus/strategies only after the offline fanout
check. `--speed-only` skips rubrics, calibration and grading, but must not be interpreted as retention evidence.

No large paid sweep should run without an explicit user-approved call/cost budget. Luna is the default cheap pilot model;
other models require explicit selection and their own suitable budget. Runtime availability is checked without printing
credential material. Private source text is sent to the selected provider only with `--live` (trusted adapters aside).

## Value retention and hard gates

Each source-backed fact belongs to one of: goals, constraints, decisions, current state, next actions, or identifiers.
A blinded judge receives source, frozen rubric and **one summary**, with no strategy name, timing, cost, repetition or
peer outputs. Candidate text can still reveal stylistic/algorithmic hints; this is identifier blinding, not proof of perfect
anonymity. All source/summary text is treated as untrusted data; prompt-injection resistance is not a security guarantee.

Per fact: retained = 1, partial = 0.5, missing = 0, contradicted = −1. Material contradiction takes priority over partial.

`raw value = 100 × Σ(weight × verdict) / Σ(weight)`

The displayed score clamps this to 0–100; the raw score and per-category scores remain available. A high average cannot
wash out a critical mistake:

- Any critical fact not fully retained, or any contradiction: **fail**.
- Otherwise an unsupported assertion: **review**.
- Otherwise: **pass** for the checked rubric, not semantic equivalence.

Every fact must be judged exactly once; retained/partial/contradicted and unsupported claims must quote actual candidate
text. Invalid JSON, incomplete fact coverage, invented quotes, provider failure, truncated/aborted judging or missing
judgments are **unscored**, never numeric zero. Judge repetitions are averaged within a summary, not counted as independent
cases. A malformed answer is not silently retried, repaired, or converted into a successful score.

All timed strategy trials finish before real-source judging starts, so judging does not contend with measured generation.
Raw summaries and judgments are retained for human inspection. The same-model cheap judge can be biased or wrong, and
source-generated rubrics can omit important facts. Use human review and continuation-task tests before production decisions.

## Timing, usage and statistics

- Seeded case ordering and rotating strategy positions control some temporal/order noise. Strategies run serially against
  one another; only a strategy's own workers run concurrently. Full position balance needs a repetition count divisible
  by the number of strategies.
- Timing scope is **summary strategy including worker cleanup**, not total compaction/session persistence/UI latency.
  Snapshot rendering, corpus preparation, authentication setup, calibration, grading and artifact writes are outside it.
  Parallel-split local planning/native replay costs are inside it; those phases add no provider calls.
- Pair only identical preparation hashes with successful generation, valid native metadata and complete cleanup. Missing
  or failed expected pairs make the aggregate speedup null; successful fragments cannot be cherry-picked into a win.
- Aggregate paired log latency ratios by case, then equally by native-session cluster. The reported speedup is a geometric
  paired estimate, not a ratio of overall medians. A seeded 95% cluster bootstrap interval requires at least three clusters.
  Session clusters are a sampling assumption, not proof of independence; related tasks/projects may remain correlated.
- No-reported-cache sensitivity uses only known-usage matched pairs with no reported cache reads. It requires a complete
  primary comparison and at least one such pair in **every case**. The subset/counts are disclosed; absence of reported hits
  is not proof that provider-side caching had no effect.
- Calls, known/incomplete usage, cache reads/writes, cost, completion/failure counts and final summary lengths are reported
  separately. Cache hits and varying output length can affect both cost and latency. A per-call output cap is **not** a
  fixed total generation budget or a fixed final checkpoint size: native split output joins two summaries, while chunking
  adds map/merge calls. Interpret results as a speed/cost/retention/size trade-off, not an isolated quality victory.
- Unknown usage does not mean free work. Shared conservative reservations happen before concurrent provider calls. Unknown
  or failed usage retains the reservation and blocks further calls. A deadline joins cancellation cleanup; work that will
  not settle stops later measurements rather than contaminating them.
- The output flag caps the SDK request. Some reasoning providers expand that cap for thinking; the budget reserves and
  records the SDK expansion (unknown APIs conservatively use the model maximum), not merely the visible answer allowance.
  The cheap OpenAI/Luna path keeps thinking inside its requested response ceiling. SDK client retries are forced to zero;
  higher-level retry attempts re-enter the meter.
- SDK catalogue rates, conservative input/output reservations and reported usage are **estimates, not an invoice guarantee**.
  Provider-side retries, cache behavior, rate changes and billing can differ. Agent/coding/reviewer conversation overhead
  is not included in this benchmark's model-call ledger.

An incomplete quality matrix has null comparative quality results, not an average of whichever judges happened to return.
The CLI exits nonzero for interrupted/invalid trials, unscored judgments, or retention gates needing attention; that can be
an honest poor-quality result rather than a harness crash. Inspect the private report and its phase/status.

## Adding a strategy

Use `--adapter /absolute/path/strategy.ts` to add a **trusted executable** module alongside the built-ins:

```ts
import {compact} from "@earendil-works/pi-coding-agent";
import type {CompactionExperiment} from "/absolute/path/experiments/compaction/CompactionEvaluation.js";

const strategy: CompactionExperiment = {
    id: "my-strategy",
    async run({preparation, model, thinkingLevel, signal, stream}) {
        return compact(preparation, model, undefined, undefined, undefined, signal, thinkingLevel, stream);
    },
};
export default strategy;
```

Use the supplied metered stream for **every** model call, propagate aborts, join workers, return original boundary/file
metadata, and account for all generated usage. Adapters receive no rubric/answers. Module entry hashes and benchmark code
hashes are recorded; this is not a complete transitive dependency/source archive or an adversarial plugin sandbox.

Validation (no privileged native/host integration):

```sh
npm run typecheck
node --import jiti/register --test test/compaction-*.test.ts
```

A sandbox that cannot create a symlink fixture explicitly skips that artifact-symlink test. Other private-file overwrite,
mode, atomic replacement, replay integrity, cancellation, and scoring tests still run. Do not claim a passing full native
suite or semantic equivalence from these offline checks.
