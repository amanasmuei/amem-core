import type { AmemDatabase } from "./database.js";
import { recallMemories, type RecalledMemory, type ExplainedMemory, type MemoryTypeValue } from "./memory.js";
import { generateEmbedding } from "./embeddings.js";
import { shortId, formatAge } from "./helpers.js";

export interface RecallOptions {
  query: string;
  limit?: number;
  type?: string;
  tag?: string;
  minConfidence?: number;
  compact?: boolean;
  explain?: boolean;
  scope?: string;
}

export interface RecallResult {
  query: string;
  total: number;
  compact?: boolean;
  tokenEstimate?: number;
  memories: Array<Record<string, unknown>>;
  text: string;
}

export async function recall(
  db: AmemDatabase,
  opts: RecallOptions,
): Promise<RecallResult> {
  const { query, limit = 10, type, tag, minConfidence, compact = true, explain = false, scope } = opts;

  const queryEmbedding = await generateEmbedding(query);

  const results = recallMemories(db, {
    query,
    queryEmbedding,
    limit,
    type: type as MemoryTypeValue | undefined,
    tag,
    minConfidence,
    scope,
    explain,
  });

  for (const r of results) db.touchAccess(r.id);

  if (results.length < 3 || (results.length > 0 && results.reduce((s, r) => s + r.confidence, 0) / results.length < 0.5)) {
    const avgConf = results.length > 0 ? results.reduce((s, r) => s + r.confidence, 0) / results.length : 0;
    db.upsertKnowledgeGap(query.toLowerCase().trim(), avgConf, results.length);
  }

  if (results.length === 0) {
    return { query, total: 0, memories: [], text: `No memories found for: "${query}".` };
  }

  if (compact) {
    const compactLines = results.map((r) => {
      const preview = r.content.slice(0, 80) + (r.content.length > 80 ? "..." : "");
      return `${shortId(r.id)} [${r.type}] ${preview} (${(r.score * 100).toFixed(0)}%)`;
    });
    const tokenEstimate = compactLines.join("\n").split(/\s+/).length;

    return {
      query,
      total: results.length,
      compact: true,
      tokenEstimate,
      memories: results.map(r => ({
        id: r.id, type: r.type, preview: r.content.slice(0, 80),
        score: Number(r.score.toFixed(3)), confidence: r.confidence,
      })),
      text: `${results.length} memories (~${tokenEstimate} tokens):\n${compactLines.join("\n")}`,
    };
  }

  const memoriesData = results.map((r) => {
    const base: Record<string, unknown> = {
      id: r.id, content: r.content, type: r.type,
      score: Number(r.score.toFixed(3)), confidence: r.confidence,
      tags: r.tags, age: formatAge(r.createdAt),
    };
    if (explain && "explanation" in r) base.explanation = (r as ExplainedMemory).explanation;
    return base;
  });

  const lines = results.map((r, i) => {
    const age = formatAge(r.createdAt);
    const conf = (r.confidence * 100).toFixed(0);
    let line = `${i + 1}. [${r.type}] ${r.content}\n   Score: ${r.score.toFixed(3)} | Confidence: ${conf}% | Age: ${age} | Tags: [${r.tags.join(", ")}]`;
    if (explain && "explanation" in r) {
      const e = (r as ExplainedMemory).explanation;
      line += `\n   -- Breakdown: relevance=${e.relevance.toFixed(3)} (${e.relevanceSource}) * recency=${e.recency} (${e.hoursSinceAccess}h ago) * confidence=${e.confidence} * importance=${e.importance} (${e.importanceLabel})`;
    }
    return line;
  });

  return {
    query,
    total: results.length,
    memories: memoriesData,
    text: `Found ${results.length} memories for "${query}":\n\n${lines.join("\n\n")}`,
  };
}
