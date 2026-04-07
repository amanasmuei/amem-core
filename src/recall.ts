import type { AmemDatabase } from "./database.js";
import { recallMemories, type RecalledMemory, type ExplainedMemory, type MemoryTypeValue } from "./memory.js";
import { generateEmbedding, rerankWithCrossEncoder } from "./embeddings.js";
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
  /**
   * Apply cross-encoder reranking on the top-K candidates.
   * Default: true. Set to false for the fastest possible recall.
   *
   * When enabled, the recall over-fetches candidates from the
   * multi-strategy retriever, then reranks them with a cross-encoder
   * for higher precision. Typical lift: +10-20 points on R@1.
   */
  rerank?: boolean;
}

/**
 * How many candidates to over-fetch before reranking. Larger values
 * give the cross-encoder more material to choose from at the cost of
 * more scoring calls. 3x has been a sensible default in the literature.
 */
const RERANK_OVERFETCH = 3;
const RERANK_MIN_FETCH = 30;

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
  const {
    query, limit = 10, type, tag, minConfidence,
    compact = true, explain = false, scope, rerank = true,
  } = opts;

  const queryEmbedding = await generateEmbedding(query);

  // When reranking, over-fetch candidates so the cross-encoder has
  // a wider pool to choose from. Otherwise just fetch `limit`.
  const fetchLimit = rerank ? Math.max(limit * RERANK_OVERFETCH, RERANK_MIN_FETCH) : limit;

  const candidates = recallMemories(db, {
    query,
    queryEmbedding,
    limit: fetchLimit,
    type: type as MemoryTypeValue | undefined,
    tag,
    minConfidence,
    scope,
    explain,
  });

  // Rerank top-K with cross-encoder if enabled and we have enough candidates
  let results: RecalledMemory[];
  if (rerank && candidates.length > 1) {
    const rerankInput = candidates.map((c) => ({
      id: c.id,
      content: c.content,
      score: c.score,
    }));
    const reranked = await rerankWithCrossEncoder(query, rerankInput, limit);
    // Map reranked results back to RecalledMemory, preserving all original fields
    // but using the cross-encoder score
    const byId = new Map(candidates.map((c) => [c.id, c]));
    results = reranked
      .map((r) => {
        const orig = byId.get(r.id);
        if (!orig) return null;
        return { ...orig, score: r.score };
      })
      .filter((r): r is RecalledMemory => r !== null);
  } else {
    results = candidates.slice(0, limit);
  }

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
