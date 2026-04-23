# Benchmarks

amem-core publishes two benchmarks. One is a cheap proof-of-life that runs on
every pull request; the other is a standard academic benchmark (LongMemEval)
that runs on demand or on a nightly schedule. Both are reproducible locally
with the npm scripts shown below — no private datasets, no auth tokens.

The goal is the same for both: make regressions in retrieval quality visible
before they ship, and keep the numbers in the README honest.

---

## Headline numbers

Versioned snapshot of the most recent published run. Updated when a release is
cut or a release-note-worthy result changes.

| Benchmark | Variant | R@1 | R@3 | R@5 | R@10 | Source |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| LongMemEval-S, session-level | mempalace-comparable | 95.0% | 97.0% | **97.8%** | 99.0% | v0.5.1 |
| LongMemEval Oracle, turn-level | strict paper metric | 66.2% | 90.8% | 94.6% | 97.5% | v0.5.1 |
| Recall latency (p50) | synthetic 60-query workload | — | — | — | — | **13.9 ms** (v0.5.1) |

Default pipeline: bi-encoder (`Xenova/bge-small-en-v1.5`, 384-dim) plus
int8-quantized cross-encoder reranker (`Xenova/ms-marco-MiniLM-L-6-v2`). All
500 questions scoreable. Zero API calls.

For the always-current number on master, see the latest
`LongMemEval Oracle` [workflow run](../../actions/workflows/bench-longmemeval.yml)
artifact; for every PR, the quick recall numbers are posted to the
**Benchmark** workflow's step summary.

---

## Quick recall — runs on every PR

A 20-memory / 10-query hand-crafted dataset. Intended to catch gross
regressions in the retrieval pipeline cheaply. Full run fits in ~5 seconds
once HuggingFace models are cached.

### What it exercises

- Embedding generation (`generateEmbedding`)
- Multi-strategy recall (semantic + FTS + graph + temporal)
- Cross-encoder reranking (non-advice path)
- SQLite persistence and the `storeMemory` hot path

### Reproduce locally

```bash
npm install
npm run bench:quick
```

### In CI

```yaml
env:
  BENCH_JSON: bench-report.json      # write a machine-readable report
  BENCH_MIN_R_AT_5: "0.80"           # fail the job if R@5 drops below
```

The CI gate is set to 0.80 R@5 — well below the expected ~100% with models
cached, so only a real regression trips it.

Data-loss risk: there is none. Every run uses a temp SQLite DB created in
`os.tmpdir()` and deleted after the run.

---

## LongMemEval — runs on demand and nightly

The standard retrieval benchmark for long-context LLM memory. We run the
**Oracle** variant (gold turns marked `has_answer: true`), 500 questions,
average ~22 turns per question.

### Two reported metrics

| Metric | Semantics | When to use |
| --- | --- | --- |
| `turn` | Did the recall return any gold-answer *turn* in top-K? | Strict paper metric. Apples-to-apples with the LongMemEval paper. |
| `session` | Did the recall return any turn from the gold *session* in top-K? | Apples-to-apples with mempalace and most published "memory" comparisons. |

Both are legitimate. `turn` is stricter. The session-level number is what
other systems in the space report; the turn-level number is what the paper
specifies. We publish both so nobody has to wonder which one a claimed
benchmark is actually measuring.

### Methodology

For each of the 500 questions:

1. Spin up a fresh in-memory SQLite DB (per-question isolation — no scope
   leakage, no contradiction-expiry across questions).
2. Embed and insert every turn of the haystack as a memory.
3. Track which inserted memory ids map to gold-answer turns (`has_answer: true`).
4. Run `recall(question, limit: 10)`.
5. Score R@K against the tracked gold ids (`turn` metric) or their session
   ids (`session` metric).

Aggregates are reported overall and per `question_type`.

### Reproduce locally

```bash
# Fetch the dataset once (15 MB). Same file the workflow caches.
curl -sL -o bench/longmemeval/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json

npm run bench:longmemeval                        # turn-level (paper)
LME_METRIC=session npm run bench:longmemeval     # session-level
LME_SAMPLE=20 npm run bench:longmemeval          # smoke test on 20 questions
```

Results land in `bench/longmemeval/results-oracle*.json` (gitignored).

### In CI

Triggered manually from the Actions tab (`Benchmark - LongMemEval` →
"Run workflow") or on the nightly schedule. Inputs:

- `sample` (empty = all 500)
- `metric` (`turn` or `session`, default `session`)

---

## Why two benchmarks, not one

Quick recall answers *"did we break the pipeline?"* in 5 seconds. Running
LongMemEval on every PR would add ~4 minutes of wall-clock and ~15s of model
download to every check, for a gate that rarely moves. Cheaper signal first;
the expensive signal where it's actually useful (release-quality review,
nightly trend on master).

## Adding a new benchmark

Two rules:

1. **Reproducible from an empty checkout.** No private datasets, no API keys,
   no machine-specific caches.
2. **Machine-readable output.** JSON, so workflows can parse it, diff it, and
   post comments without fragile regex on stdout.

Open a PR against `bench/` with the runner plus a short section in this file.
