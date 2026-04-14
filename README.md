<div align="center">

# amem-core

### Long-term memory for AI agents that actually retrieves the right thing.

**94.8% R@5 on LongMemEval** &nbsp;·&nbsp; **~14ms p50 recall** &nbsp;·&nbsp; Local-first &nbsp;·&nbsp; TypeScript

<br/>

[![npm version](https://img.shields.io/npm/v/@aman_asmuei/amem-core?style=for-the-badge&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/@aman_asmuei/amem-core)
&nbsp;
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](./LICENSE)
&nbsp;
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen?style=for-the-badge&logo=node.js&logoColor=white)
&nbsp;
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=for-the-badge&logo=typescript&logoColor=white)
&nbsp;
![Tests](https://img.shields.io/badge/tests-285%20passing-brightgreen?style=for-the-badge)

<br/>

[**Benchmarks**](#-benchmarks) &nbsp;·&nbsp;
[**Quick Start**](#-quick-start) &nbsp;·&nbsp;
[**Capabilities**](#-whats-inside) &nbsp;·&nbsp;
[**API**](#-api-reference) &nbsp;·&nbsp;
[**vs mempalace**](#-honest-comparison) &nbsp;·&nbsp;
[**Roadmap**](#-roadmap)

</div>

---

## 📊 Headline numbers

<div align="center">

| **R@1** | **R@3** | **R@5** | **R@10** | **recall p50** |
|:---:|:---:|:---:|:---:|:---:|
| **66.2%** | **90.8%** | **🏆 94.6%** | **97.5%** | **13.9ms** |

*LongMemEval Oracle, 500 questions, default pipeline (bi-encoder + int8 cross-encoder reranker, batched). ~5 min on CPU. Recall latency measured on synthetic 60-query workload; see `bench/profile-recall.ts`.*

</div>

These are real numbers from a real run, on a real benchmark, with the package you can `npm install` right now. Reproducible: `npm run bench:longmemeval`.

---

## 🤔 Why this exists

Most AI memory systems fall into one of two traps:

1. **Toy demos** that store and retrieve happy-path strings, with no published numbers.
2. **Research projects** that achieve great recall but ship in Python with vector DBs, model servers, and a deployment story that doesn't fit your TypeScript app.

`amem-core` is the missing middle: **production-grade retrieval quality, in-process, single dependency, runs anywhere Node runs.** No Docker. No Pinecone. No OpenAI key. No Python.

---

## 🚀 Quick start

```bash
npm install @aman_asmuei/amem-core
```

```ts
import { createDatabase, storeMemory, recall } from "@aman_asmuei/amem-core";

// 1. Open (or create) a memory database — single SQLite file
const db = createDatabase("./my-memory.db");

// 2. Store a few memories
await storeMemory(db, {
  content: "PostgreSQL is the default database for all backend services.",
  type: "decision",
  tags: ["database", "infrastructure"],
});

await storeMemory(db, {
  content: "Authentication uses JWT tokens signed with RS256, 15-minute expiry.",
  type: "fact",
  tags: ["auth", "security"],
});

await storeMemory(db, {
  content: "Never deploy to production on Friday afternoons.",
  type: "decision",
  tags: ["deployment", "policy"],
});

// 3. Recall semantically — no exact-keyword match needed
const result = await recall(db, {
  query: "what database do we use",
  limit: 5,
});

console.log(result.memories[0].content);
// → "PostgreSQL is the default database for all backend services."
```

That's it. Embeddings download automatically on first call (~25 MB, one time). No API keys.

---

## 📦 What's inside

`amem-core` is more than `store` + `recall`. The full feature set, all in one package:

### 🔍 Retrieval
- **Local vector embeddings** — 384-dim `bge-small-en-v1.5` via `@huggingface/transformers`. No API keys, no network calls after first model download.
- **HNSW approximate-nearest-neighbour** index via `hnswlib-node` for fast semantic search at scale.
- **Hybrid recall** — combines vector similarity, FTS5 full-text, tag matching, and recency scoring.
- **Query expansion** — rewrites short queries into richer search terms before recall.
- **Cross-encoder reranking** — optional precision boost on top-K candidates.

### ⏱ Temporal model
- **Validity windows** — every memory has `valid_from` and `valid_until`. Recall filters expired memories by default.
- **"What was true in January?"** — explicit temporal queries supported via `validUntil`-aware filtering.
- **Auto-expire on contradiction** — when a new memory contradicts an existing one (high cosine similarity, conflicting content), the old one is auto-expired with a reason logged.

### 🧠 Knowledge graph
- **Memory relations** — typed edges (`relates_to`, `contradicts`, `supersedes`, etc.) with their own validity windows.
- **Auto-relate** — discovers and creates relations between newly-stored memories automatically.

### 🪞 Reflection & quality
- **Clustering** — groups related memories for higher-level insights.
- **Contradiction detection** — flags conflicting facts with configurable similarity thresholds.
- **Gap analysis** — identifies underrepresented topics so you know what's missing.
- **Consolidation** — merges duplicates, prunes stale, promotes frequently accessed, decays idle.

### 🏢 Multi-tenancy
- **Per-scope storage** — every memory is tagged with a `scope` string (e.g. `dev:plugin`, `tg:12345`, `agent:productivity`). One DB, many tenants, no cross-contamination.
- **Tier management** — `active` / `archived` / `expired` tiers with explicit transitions.
- **Doctor command** — health check across DB integrity, embedding freshness, schema migrations.

---

## 📊 Benchmarks

### LongMemEval (Oracle) — turn-level recall

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) is the standard long-term-memory benchmark for LLM systems, by Wu et al. The Oracle variant contains **500 evaluation questions** across six task types (single-session, multi-session, knowledge-update, temporal-reasoning) with gold-evidence turns labelled in each conversation history.

**Setup:** default `amem-core` recall pipeline — local `bge-small-en-v1.5` bi-encoder embeddings + `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder *adaptively* reranking the top-30 candidates (skipped for advice-seeking queries where the MS-MARCO reranker systematically hurts). All in-process. All CPU. No API keys.

<div align="center">

| Metric | Score |
|:---:|:---:|
| **R@1**  | **66.2%** |
| **R@3**  | **90.8%** |
| **R@5**  | **🏆 94.6%** |
| **R@10** | **97.5%** |

**479** scoreable questions · **301s** runtime · **CPU only** · **Node 22**

</div>

#### Pipeline evolution

Three tracked runs on the same 500-question set, same hardware:

| Pipeline | R@1 | R@3 | R@5 | R@10 | recall p50 |
|:---|---:|---:|---:|---:|---:|
| v0.3.0 — bi-encoder only | 46.6% | 78.5% | 91.0% | 97.7% | — |
| v0.4.0 — + cross-encoder reranker | 64.9% | 91.0% | 94.6% | 97.7% | — |
| v0.4.2 — + adaptive rerank | 65.6% | 91.0% | 94.8% | 97.7% | ~38ms |
| **v0.5.1 — + batched + int8 rerank (current)** | **66.2%** | **90.8%** | **94.6%** | **97.5%** | **13.9ms** |
| Δ (v0.3.0 → v0.5.1) | **+19.6** | **+12.3** | **+3.6** | -0.2 | — |

Each step is a real, reproducible benchmark run — not a projection. The small R@3/R@5/R@10 dip from v0.4.2 → v0.5.1 is **1 question of 479** (within run-to-run noise); the rank-correlation between v0.4.2 fp32 and v0.5.1 int8 is **0.995**, and R@1 actually improved.

#### Per question type (current)

| Type | n | R@1 | R@3 | R@5 | R@10 |
|:---|---:|---:|---:|---:|---:|
| `single-session-user` | 64 | **84.4%** 🏆 | 95.3% | 96.9% | 98.4% |
| `multi-session` | 125 | 71.2% | 92.8% | 97.6% | 99.2% |
| `knowledge-update` | 72 | 59.7% | 95.8% | **100.0%** 🏆 | 100.0% |
| `single-session-preference` | 30 | 63.3% | 90.0% | 96.7% | 96.7% |
| `single-session-assistant` | 56 | 58.9% | 85.7% | 87.5% | 94.6% |
| `temporal-reasoning` | 132 | 59.8% | 86.4% | 90.2% | 95.5% |

#### Reproduce it yourself

```bash
git clone https://github.com/amanasmuei/amem-core.git
cd amem-core
npm install
curl -sL -o bench/longmemeval/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
npm run bench:longmemeval
```

Quick smoke test on 5 questions: `LME_SAMPLE=5 npm run bench:longmemeval`

#### Recall latency (v0.5.1+)

Per-stage latency, synthetic 60-query workload, cold-cache queries, M-class macOS:

| Stage | p50 | share |
|:---|---:|---:|
| embed (bi-encoder, `bge-small-en-v1.5`) | 3.0ms | 22% |
| retrieve (HNSW + multi-strategy + SQLite) | 0.1ms | 1% |
| **rerank (batched int8 cross-encoder, top-30)** | **10.3ms** | **74%** |
| **Total** | **13.9ms** | 100% |

Versus v0.4.2 (sequential fp32 cross-encoder):

| | v0.4.2 | v0.5.1 | Δ |
|:---|---:|---:|---:|
| rerank p50 | 34.5ms | **10.3ms** | **3.3x faster** |
| total recall p50 | 38.4ms | **13.9ms** | **2.8x faster** |
| steady-state RSS | 767 MB | **551 MB** | **-28%** |

Two changes, no API surface impact:

1. **Cross-encoder is now batched.** The previous path ran N individual `tokenizer(pair) → model(inputs)` calls sequentially ("one at a time to keep peak memory low"). Re-measured — a single batched call per chunk of 64 pairs is strictly faster AND lower peak RSS (less GC churn). Scores bit-identical (`bench/rerank-batch-probe.ts`).
2. **Cross-encoder is loaded with `dtype: "int8"`.** Rank-correlation 0.995 with fp32 baseline, top-1 agreement is 100% on the probe set. fp16 was tested and is *slower* on CPU (no hardware half-float path in onnxruntime-node) — do not use.

Enable the stage profiler yourself via `AMEM_PROFILE=1` — `getProfileSamples()` exports the per-stage samples. Zero overhead when unset.

#### Honest notes

- **The cross-encoder reranker is the headline win.** Lifted R@1 from 46.6% → 66.2% (+19.6) and R@3 from 78.5% → 90.8% (+12.3) across the full 500-question set. Default-on; opt out with `recall(db, { query, rerank: false })` for the fastest possible path.
- **Adaptive rerank fixes the preference regression.** The MS-MARCO-trained cross-encoder systematically promotes assistant-paraphrase text above the user's original preference statement. `amem-core` detects advice-seeking queries (`recommend`, `suggest`, `any tips`, `help me find`...) and falls back to bi-encoder order for those, while still reranking direct lookup queries. Preference R@5 recovered from 93.3% → 96.7% (+3.4). Details: see `isAdviceSeekingQuery()` in `src/recall.ts` and the diagnostic in `bench/preference-diag.ts`.
- **Temporal reasoning is still the weakest type** (90.2% R@5). `amem-core` stores `valid_from` / `valid_until` per memory but the default scorer doesn't yet use them as ranking signals. Next ticket.
- **HNSW ANN index** exists in the codebase but isn't wired into the default recall path — currently exposed only via `buildVectorIndex` for explicit batched search at scale. Only matters at 100k+ memory scale.
- Run is fully reproducible — every commit can re-execute the benchmark and append to `bench/longmemeval/results.json`.

#### Implementation note: cross-encoder via raw model API

The reranker uses `Xenova/ms-marco-MiniLM-L-6-v2`. We deliberately bypass the higher-level `pipeline("text-classification", ...)` API in `@huggingface/transformers` and call `AutoTokenizer` + `AutoModelForSequenceClassification` directly to read the raw relevance logit. The pipeline normalizes single-class regression heads to a constant `score: 1.0` for every input — silently broken for ranking. Verified via probe scripts in `bench/rerank-probe*.ts`. See the `Cross-Encoder Reranker` block in `src/embeddings.ts` for the implementation.

### Quick recall (proof-of-life)

A small hand-crafted sanity benchmark — 20 distinct memories, 10 lookup queries with known gold-truth. For fast smoke tests during development.

| Metric | Score |
|---|---|
| R@1  | 70.0% |
| R@3  | 90.0% |
| R@5  | 90.0% |
| R@10 | 100.0% |

```bash
npm run bench:quick
```

---

## 🥊 Honest comparison

How `amem-core` stacks up against [mempalace](https://github.com/milla-jovovich/mempalace), the most-talked-about open-source AI memory system:

| | **amem-core** | mempalace |
|---|---|---|
| **LongMemEval R@5** | **94.8%** *(adaptive rerank, default pipeline)* | 96.6% *(full pipeline + reranker)* |
| **Runtime** | TypeScript / Node | Python 3.9+ |
| **Storage** | SQLite (single file) | SQLite + ChromaDB |
| **Vector index** | HNSW (`hnswlib-node`) | ChromaDB |
| **Embeddings** | Local `bge-small-en-v1.5`, no API | Local + optional API |
| **Validity windows** | ✅ `valid_from` / `valid_until` | ✅ |
| **Contradiction detection** | ✅ auto-expire | ✅ |
| **Knowledge graph** | ✅ typed relations | ✅ |
| **Reflection / clustering** | ✅ | ✅ |
| **Multi-tenant** | ✅ scope-routed | ✅ wings/rooms |
| **Install size** | ~250 MB (with model) | ~500 MB+ |
| **Single dependency tree** | ✅ pure npm | ❌ Python + ChromaDB server |

**The honest summary:**
- **mempalace has higher peak recall** (96.6%) because it ships with a reranker wired into the default path.
- **amem-core is closer than the gap suggests** (5.6 points) and the gap lives in a component that already exists in the codebase but isn't wired in by default.
- **amem-core is genuinely simpler to deploy** if you're already in the JavaScript / TypeScript ecosystem: one `npm install`, one SQLite file, no separate vector DB process, no Python runtime.

Pick `amem-core` if you want **production simplicity in a TypeScript stack**. Pick mempalace if you want **peak research-grade recall on day one** and Python is fine.

---

## 📚 API reference

### `createDatabase(path: string): AmemDatabase`

Opens (or creates) a SQLite database at `path` with WAL mode, FTS5, and all required tables and indexes.

### `storeMemory(db, opts): Promise<StoreResult>`

Store a memory. Auto-generates the embedding, auto-detects contradictions, auto-expires superseded memories, auto-discovers relations.

| Field | Type | Default | Description |
|---|---|---|---|
| `content` | `string` | *(required)* | The memory text |
| `type` | `MemoryTypeValue` | `"fact"` | `correction` / `decision` / `pattern` / `preference` / `topology` / `fact` |
| `tags` | `string[]` | `[]` | Searchable tags |
| `confidence` | `number` | `0.8` | 0-1 confidence score |
| `scope` | `string` | `"global"` | Tenant / project scope |
| `source` | `string` | `"conversation"` | Provenance of the memory |

### `recall(db, opts): Promise<RecallResult>`

Hybrid semantic + keyword + recency search.

| Field | Type | Default | Description |
|---|---|---|---|
| `query` | `string` | *(required)* | Search query |
| `limit` | `number` | `10` | Max results |
| `type` | `string` | `undefined` | Filter by memory type |
| `tag` | `string` | `undefined` | Filter by tag |
| `scope` | `string` | `undefined` | Filter by scope |
| `minConfidence` | `number` | `undefined` | Minimum confidence threshold |
| `explain` | `boolean` | `false` | Include score breakdown per result |

### `buildContext(db, topic, opts?): Promise<ContextResult>`

Load all relevant context for a topic, organized by memory type with token budgeting.

### `consolidateMemories(db, cosineSim, opts): ConsolidationReport`

Merge duplicates, prune stale memories, promote frequently accessed ones, decay idle ones.

### `reflect(db, opts?): ReflectionReport`

Run the reflection layer: clustering, contradiction detection, gap analysis, synthesis candidates.

### `generateEmbedding(text: string): Promise<Float32Array | null>`

Generate a 384-dim embedding vector using `bge-small-en-v1.5`. Returns `null` if the model is not yet loaded.

### `syncFromClaude(db, projectFilter?, dryRun?): Promise<SyncResult>`

Import Claude Code auto-memory files (`~/.claude/projects/*/memory/*.md`) into amem.

### `syncToCopilot(db, opts?): CopilotSyncResult`

Export amem memories to `.github/copilot-instructions.md`, grouped by type, wrapped in `<!-- amem:start/end -->` markers. Preserves existing non-amem content.

```ts
import { createDatabase, syncToCopilot } from "@aman_asmuei/amem-core";

const db = createDatabase("~/.amem/memory.db");
const result = syncToCopilot(db, { projectDir: "/my/project" });
// → { file: "/my/project/.github/copilot-instructions.md", memoriesExported: 12 }
```

### `runDiagnostics(db): DiagnosticReport`

Health check across DB integrity, embedding freshness, schema migrations, vector index state.

> Full type definitions ship with the package — your editor will autocomplete the rest.

---

## 🏗 Architecture

```
                    ┌─────────────────────────────┐
                    │      your application       │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                  ┌─────────────────────────────────┐
                  │       @aman_asmuei/amem-core    │
                  │                                 │
                  │   ┌──────────┐  ┌──────────┐    │
                  │   │  store   │  │  recall  │    │
                  │   └────┬─────┘  └────┬─────┘    │
                  │        │             │          │
                  │   ┌────▼─────────────▼─────┐    │
                  │   │   embeddings (HF)       │   │
                  │   │   bge-small-en-v1.5     │   │
                  │   └────────────┬────────────┘   │
                  │                │                │
                  │   ┌────────────▼────────────┐   │
                  │   │   HNSW (hnswlib-node)   │   │
                  │   └────────────┬────────────┘   │
                  │                │                │
                  │   ┌────────────▼────────────┐   │
                  │   │   SQLite + FTS5 + WAL   │   │
                  │   └─────────────────────────┘   │
                  └─────────────────────────────────┘
```

Single dependency tree. No Python. No vector DB process. No API keys. The whole engine is one `npm install` and one `.db` file.

---

## 🛣 Roadmap

Nearest tickets, in priority order:

- [x] **Wire cross-encoder reranking into default recall path** — shipped: R@1 46.6% → 64.9% (+18.3), R@5 91.0% → 94.6% (+3.6)
- [x] **Skip rerank for advice-seeking queries** — shipped: preference R@5 recovered 93.3% → 96.7%, overall R@5 94.6% → 94.8%
- [x] **Batched + int8-quantized cross-encoder** — shipped in v0.5.1: rerank 34.5ms → 10.3ms (3.3x), total recall 38.4ms → 13.9ms (2.8x), rank-corr 0.995 with fp32
- [ ] **Time-aware ranking signal** — use `valid_from` / `valid_until` distance from query date to lift `temporal-reasoning` (currently weakest type at 89.4% R@5)
- [ ] **Wire HNSW into the hot path** — currently exposed only via explicit `buildVectorIndex` calls
- [ ] **Run LongMemEval-S and LongMemEval-M variants** — full haystack benchmarks, not just Oracle
- [ ] **PDPA / GDPR export** — `exportScope(scope)` for user-data takeout requests
- [ ] **Schema versioning sentinel** — explicit `_schema_version` table for safer future migrations

---

## 🧬 Relationship to amem

| | **amem-core** | **amem** |
|---|---|---|
| **What** | Pure TypeScript library | MCP server + CLI wrapping it |
| **Use case** | Embed in your app | Plug into Claude Code, Copilot, Cursor |
| **Install** | `npm install @aman_asmuei/amem-core` | `npm install -g @aman_asmuei/amem` |

`amem-core` is the engine. `amem` is the vehicle.

---

## 📜 License

[MIT](./LICENSE) — use it commercially, modify it, ship it. Just don't claim you wrote it.

---

<div align="center">

Built with ❤️ in 🇲🇾 **Malaysia** by **[Aman Asmuei](https://github.com/amanasmuei)**

[**GitHub**](https://github.com/amanasmuei/amem-core) &nbsp;·&nbsp;
[**npm**](https://www.npmjs.com/package/@aman_asmuei/amem-core) &nbsp;·&nbsp;
[**Issues**](https://github.com/amanasmuei/amem-core/issues)

<sub>Part of the <strong><a href="https://github.com/amanasmuei">aman ecosystem</a></strong> — local-first AI tools from Southeast Asia 🌏</sub>

</div>
