# LongMemEval (Oracle) recall benchmark

Measures amem-core's turn-level recall on the [LongMemEval](https://github.com/xiaowu0162/LongMemEval) Oracle variant — 500 questions covering single/multi-session retrieval, knowledge updates, and temporal reasoning.

## Setup

The dataset is not committed (15 MB). Download it once:

```bash
curl -sL -o bench/longmemeval/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
```

## Run

```bash
npm run bench:longmemeval
```

Quick smoke test on 5 questions:

```bash
LME_SAMPLE=5 npm run bench:longmemeval
```

## Methodology

For each question:

1. Spin up a fresh in-memory SQLite DB (per-question isolation — no scope leakage, no contradiction-expiry across questions).
2. Embed and insert every turn from the question's haystack as a memory.
3. Track which inserted memory ids correspond to gold-answer turns (`has_answer: true`).
4. Run `amem.recall(question, limit: 10)`.
5. Score turn-level R@K: did the recall return any gold-answer memory in the top-K?

The metric is **turn-level recall**, the same metric used by mempalace and other retrieval systems on this benchmark.

Aggregates are reported overall and broken down by `question_type`.

## Latest result

See `results.json` (gitignored) after a run, or the README's "Benchmarks" section for the published number.
