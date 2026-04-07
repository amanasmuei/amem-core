<h1 align="center">amem-core</h1>

<p align="center">
  <strong>The pure memory engine behind amem.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@aman_asmuei/amem-core"><img src="https://img.shields.io/npm/v/@aman_asmuei/amem-core?style=for-the-badge&logo=npm&logoColor=white&color=cb3837" alt="npm version" /></a>
  &nbsp;
  <a href="https://github.com/amanasmuei/amem/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License" /></a>
  &nbsp;
  <img src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18+" />
</p>

---

## What is amem-core?

`amem-core` is the pure library extracted from [amem](https://github.com/amanasmuei/amem). It contains all the memory logic — database, embeddings, semantic search, scoring, consolidation — with **zero MCP dependencies**.

Use it directly in your app, or let `amem` wrap it as an MCP server for Claude Code, Copilot, Cursor, and friends.

---

## What's actually inside

amem-core is more than `store` + `recall`. The full feature set:

### Retrieval
- **Vector embeddings** — local 384-dim `bge-small-en-v1.5` via `@huggingface/transformers`. No API keys.
- **HNSW approximate-nearest-neighbour** index via `hnswlib-node` for fast semantic search at scale
- **Hybrid recall** — combines vector similarity, FTS5 full-text, tag matching, and recency scoring
- **Query expansion** — rewrites short queries into richer search terms before recall

### Temporal model
- **Validity windows** — every memory has `valid_from` and `valid_until`. Recall filters out expired memories by default.
- **"What was true in January?"** — explicit temporal queries supported via `validUntil`-aware filtering
- **Auto-expire on contradiction** — when a new memory contradicts an existing one (high cosine similarity, conflicting content), the old one is auto-expired with a reason

### Knowledge graph
- **Memory relations** — typed edges between memories (`relates_to`, `contradicts`, `supersedes`, etc.) with their own validity windows
- **Auto-relate** — discovers and creates relations between newly stored memories

### Reflection & quality
- **Clustering** — groups related memories for higher-level insights
- **Contradiction detection** — flags conflicting facts with configurable similarity thresholds
- **Gap analysis** — identifies underrepresented topics
- **Consolidation** — merges duplicates, prunes stale, promotes frequently-accessed, decays idle

### Multi-tenancy
- **Per-scope storage** — every memory is tagged with a `scope` string (e.g. `dev:plugin`, `tg:12345`, `agent:productivity`)
- **Tier management** — `active` / `archived` / `expired` tiers with explicit transitions
- **Doctor command** — health check across DB integrity, embedding freshness, schema migrations

---

## Install

```bash
npm install @aman_asmuei/amem-core
```

---

## Quick Start

```ts
import { createDatabase, storeMemory, recall } from "@aman_asmuei/amem-core";

// 1. Open (or create) a database
const db = createDatabase("./my-memory.db");

// 2. Store a memory
await storeMemory(db, {
  content: "Always use strict TypeScript — never use the any type",
  type: "correction",
  tags: ["typescript"],
});

// 3. Recall it later
const result = await recall(db, { query: "typescript rules", limit: 5 });
console.log(result.memories);
// -> [{ id: "a1b2c3d4", content: "Always use strict TypeScript...", score: 0.94, ... }]
```

---

## API Reference

### `createDatabase(path: string): AmemDatabase`

Opens (or creates) a SQLite database at `path` with WAL mode, FTS5, and all required tables.

### `storeMemory(db, opts): Promise<StoreResult>`

Store a memory. Options:

| Field | Type | Default | Description |
|---|---|---|---|
| `content` | `string` | *(required)* | The memory text |
| `type` | `MemoryTypeValue` | `"fact"` | `correction`, `decision`, `pattern`, `preference`, `topology`, `fact` |
| `tags` | `string[]` | `[]` | Searchable tags |
| `confidence` | `number` | `0.8` | 0-1 confidence score |
| `scope` | `string` | `undefined` | Project scope |

Auto-generates embeddings, auto-detects contradictions, auto-redacts private content.

### `recall(db, opts): Promise<RecallResult>`

Semantic search over memories.

| Field | Type | Default | Description |
|---|---|---|---|
| `query` | `string` | *(required)* | Search query |
| `limit` | `number` | `10` | Max results |
| `scope` | `string` | `undefined` | Filter by project scope |
| `explain` | `boolean` | `false` | Include score breakdown |

### `buildContext(db, topic, opts?): Promise<ContextResult>`

Load all relevant context for a topic, organized by memory type with token budgeting.

| Field | Type | Default | Description |
|---|---|---|---|
| `topic` | `string` | *(required)* | Topic to build context for |
| `maxTokens` | `number` | `2000` | Token budget |
| `scope` | `string` | `undefined` | Project scope |

### `consolidateMemories(db, cosineSim, opts): ConsolidationReport`

Merge duplicates, prune stale memories, promote frequently accessed ones, decay idle ones.

### `generateEmbedding(text: string): Promise<Float32Array | null>`

Generate a 384-dim embedding vector using bge-small-en-v1.5 (local, no API keys). Returns `null` if the model is not yet available.

### `syncFromClaude(db, projectFilter?, dryRun?): Promise<SyncResult>`

Import Claude Code auto-memory files (`~/.claude/projects/*/memory/*.md`) into amem. Auto-maps Claude types to amem types, deduplicates by content hash.

### `syncToCopilot(db, opts?): CopilotSyncResult`

Export amem memories to `.github/copilot-instructions.md`. Generates structured markdown grouped by type (corrections, decisions, preferences, patterns), wrapped in `<!-- amem:start/end -->` markers. Preserves existing non-amem content.

```ts
import { createDatabase, syncToCopilot } from "@aman_asmuei/amem-core";

const db = createDatabase("~/.amem/memory.db");
const result = syncToCopilot(db, { projectDir: "/my/project" });
// -> { file: "/my/project/.github/copilot-instructions.md", memoriesExported: 12 }
```

### `generateCopilotInstructions(db, opts?): { markdown, counts }`

Generate the markdown content for Copilot instructions without writing to disk. Useful for previewing or embedding in custom workflows.

---

## Relationship to amem

| | amem-core | amem |
|---|---|---|
| **What** | Pure TypeScript library | MCP server + CLI |
| **Dependencies** | SQLite, Zod | amem-core + MCP SDK |
| **Use case** | Embed in your app | Plug into AI tools |
| **Install** | `npm install @aman_asmuei/amem-core` | `npm install -g @aman_asmuei/amem` |

`amem-core` is the engine. `amem` is the vehicle.

---

## License

MIT

<p align="center">
  Built by <a href="https://github.com/amanasmuei"><strong>Aman Asmuei</strong></a>
</p>

<p align="center">
  <a href="https://github.com/amanasmuei/amem">GitHub</a> &middot;
  <a href="https://www.npmjs.com/package/@aman_asmuei/amem-core">npm</a>
</p>
