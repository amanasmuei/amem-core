<div align="center">

# amem-core

### Long-term memory for AI agents that actually retrieves the right thing.

**94.6% R@5 on LongMemEval** &nbsp;·&nbsp; Local-first &nbsp;·&nbsp; Zero API keys &nbsp;·&nbsp; TypeScript

<br/>

[![npm version](https://img.shields.io/npm/v/@aman_asmuei/amem-core?style=for-the-badge&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/@aman_asmuei/amem-core)
&nbsp;
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](./LICENSE)
&nbsp;
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen?style=for-the-badge&logo=node.js&logoColor=white)
&nbsp;
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=for-the-badge&logo=typescript&logoColor=white)
&nbsp;
![Tests](https://img.shields.io/badge/tests-97%20passing-brightgreen?style=for-the-badge)

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

| **R@1** | **R@3** | **R@5** | **R@10** |
|:---:|:---:|:---:|:---:|
| **64.9%** | **91.0%** | **🏆 94.6%** | **97.7%** |

*LongMemEval Oracle, 500 questions, default pipeline (bi-encoder + cross-encoder reranker), ~7 min on CPU*

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

**Setup:** default `amem-core` recall pipeline — local `bge-small-en-v1.5` bi-encoder embeddings + `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder reranking the top-30 candidates. All in-process. All CPU. No API keys.

<div align="center">

| Metric | Score |
|:---:|:---:|
| **R@1**  | **64.9%** |
| **R@3**  | **91.0%** |
| **R@5**  | **🏆 94.6%** |
| **R@10** | **97.7%** |

**479** scoreable questions · **420s** runtime · **CPU only** · **Node 22**

</div>

#### The reranker effect (before vs after)

| Metric | Bi-encoder only | + Cross-encoder reranker | Δ |
|:---|---:|---:|---:|
| **R@1**  | 46.6% | **64.9%** | **+18.3** 🏆 |
| **R@3**  | 78.5% | **91.0%** | **+12.5** |
| **R@5**  | 91.0% | **94.6%** | **+3.6** |
| **R@10** | 97.7% | 97.7% | ±0.0 |

The reranker shuffles within the top-K candidate set, so R@10 stays saturated while R@1 / R@3 climb dramatically. To opt out (faster recall, weaker R@1), pass `rerank: false` to `recall()`.

#### Per question type

| Type | n | R@1 | R@3 | R@5 | R@10 |
|:---|---:|---:|---:|---:|---:|
| `single-session-user` | 64 | **84.4%** 🏆 | 95.3% | 98.4% | 98.4% |
| `multi-session` | 125 | 71.2% | 93.6% | 98.4% | 99.2% |
| `knowledge-update` | 72 | 59.7% | 95.8% | **100.0%** 🏆 | 100.0% |
| `single-session-assistant` | 56 | 58.9% | 85.7% | 87.5% | 94.6% |
| `temporal-reasoning` | 132 | 58.3% | 86.4% | 89.4% | 96.2% |
| `single-session-preference` | 30 | 50.0% | 90.0% | 93.3% | 96.7% |

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

#### Honest notes

- **The cross-encoder reranker is the headline win.** It lifted R@1 from 46.6% → 64.9% (+18.3 points) and R@3 from 78.5% → 91.0% (+12.5 points) across the full 500-question set. Default-on as of this version; opt out with `recall(db, { query, rerank: false })` for faster but weaker recall.
- **`single-session-preference` regressed slightly** (R@5 100% → 93.3%). The cross-encoder picks up the wrong signal on opinion / preference questions where multiple candidates can all be semantically valid. This is a known limitation of MS-MARCO-trained rerankers on subjective text. A future ticket is to detect preference-style queries and skip rerank for them.
- **Temporal reasoning is still the weakest type** (89.4% R@5). amem-core stores `valid_from` / `valid_until` per memory but the default scorer doesn't yet use them as ranking signals.
- **HNSW ANN index** in this codebase is not yet wired into the default recall path — currently exposed only via `buildVectorIndex` for explicit batched search at scale. On the roadmap.
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
| **LongMemEval R@5** | **94.6%** *(default pipeline + reranker)* | 96.6% *(full pipeline + reranker)* |
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
- [ ] **Skip rerank for preference-style queries** — recover the lost ground on `single-session-preference` (regressed 100% → 93.3% R@5 with reranker on)
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
