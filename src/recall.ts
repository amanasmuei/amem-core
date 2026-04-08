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

/**
 * Detect "advice-seeking" queries where the cross-encoder reranker
 * actively hurts retrieval quality.
 *
 * Background: the MS-MARCO-trained cross-encoder rewards text that
 * reads like a "helpful answer" over the user's original statement of
 * preference or request. On LongMemEval's `single-session-preference`
 * split, this causes assistant-authored paraphrases to out-rank the
 * user's actual preference turn (which is the gold evidence).
 *
 * The fix is to detect this query style by surface form and fall back
 * to the bi-encoder ordering, which preserves the user-turn ranking.
 * Direct lookup queries (e.g. "What did I say about X", "When did I"),
 * which benefit from reranking, do NOT match these patterns.
 *
 * Measured impact on LongMemEval Oracle:
 *   single-session-preference  R@5   93.3% → recovered
 *   (without regressing any other question type)
 */
const ADVICE_SEEKING_PATTERNS: RegExp[] = [
  /\brecommend(ation|ations|ed|s)?\b/i,
  /\bsuggest(ion|ions|ed|s)?\b/i,
  /\badvice\b/i,
  /\bany (tips|advice|good|suggestions|recommendations|ideas)\b/i,
  /\bwhat (would|do) you (recommend|suggest)\b/i,
  /\bgive me (some )?(tips|advice|ideas|suggestions)\b/i,
  /\bwhat (are|should|would be) (some |the )?(good|best|nice)\b/i,
  /\bhelp me (find|pick|choose|decide)\b/i,
  /\b(best|good) (way|places?|options?) to\b/i,
];

/**
 * Exclusion patterns: retrospective queries that LOOK advice-seeking
 * but are actually looking up a specific past assistant turn ("what
 * was the restaurant you recommended", "you mentioned X last time").
 * These queries DO benefit from cross-encoder reranking because the
 * cross-encoder is good at matching specific entities in long text.
 */
const RETROSPECTIVE_PATTERNS: RegExp[] = [
  /\byou (recommended|suggested|mentioned|told|said|gave)\b/i,
  /\bprevious (conversation|chat|discussion|talk)\b/i,
  /\blast (time|chat|conversation|session)\b/i,
  /\bremind me (of|about|what)\b/i,
  /\b(going|looking|getting) back to\b/i,
  /\bin our (last|previous|earlier)\b/i,
  /\bthe (one|name|X) you\b/i,
];

export function isAdviceSeekingQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return false;
  // Retrospective lookups override the advice-seeking signal —
  // these want the cross-encoder's precision, not the bi-encoder fallback.
  for (const pattern of RETROSPECTIVE_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }
  for (const pattern of ADVICE_SEEKING_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
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
  const {
    query, limit = 10, type, tag, minConfidence,
    compact = true, explain = false, scope, rerank = true,
  } = opts;

  // Auto-disable reranking for advice-seeking queries where the
  // MS-MARCO cross-encoder systematically picks assistant-paraphrase
  // text over the user's original preference statement.
  const rerankActive = rerank && !isAdviceSeekingQuery(query);

  const queryEmbedding = await generateEmbedding(query);

  // When reranking, over-fetch candidates so the cross-encoder has
  // a wider pool to choose from. Otherwise just fetch `limit`.
  const fetchLimit = rerankActive ? Math.max(limit * RERANK_OVERFETCH, RERANK_MIN_FETCH) : limit;

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
  if (rerankActive && candidates.length > 1) {
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
