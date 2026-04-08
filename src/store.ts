import type { AmemDatabase, MemoryInput } from "./database.js";
import type { MemoryTypeValue } from "./memory.js";
import { detectConflict, autoExpireContradictions } from "./memory.js";
import { generateEmbedding, cosineSimilarity } from "./embeddings.js";
import { sanitizeContent, loadConfig } from "./config.js";
import { autoRelateMemory } from "./auto-relate.js";

export interface StoreOptions {
  content: string;
  type: MemoryTypeValue;
  tags?: string[];
  confidence?: number;
  source?: string;
  scope?: string;
}

export interface StoreResult {
  action: "stored" | "reinforced" | "private";
  id: string;
  type: MemoryTypeValue;
  confidence: number;
  tags: string[];
  total: number;
  reinforced: number;
}

export async function storeMemory(
  db: AmemDatabase,
  opts: StoreOptions,
): Promise<StoreResult> {
  const { type, tags = [], confidence = 0.8, source = "conversation", scope } = opts;

  // Privacy: sanitizeContent returns null when the entire input is private
  // (e.g. wrapped in <private>...</private>). In that case, do NOT store —
  // return a "private" action so the caller knows the memory was dropped.
  const sanitized = sanitizeContent(opts.content);
  if (sanitized === null) {
    return {
      action: "private",
      id: "",
      type,
      confidence,
      tags,
      total: db.getStats().total,
      reinforced: 0,
    };
  }
  const content = sanitized;

  const embedding = await generateEmbedding(content);

  autoExpireContradictions(db, content, embedding, type);

  let reinforced = 0;

  if (embedding) {
    const existing = db.getRecentWithEmbeddings(loadConfig().retrieval.maxCandidates);

    for (const mem of existing) {
      if (!mem.embedding) continue;
      const sim = cosineSimilarity(embedding, mem.embedding);

      if (sim > 0.85) {
        const conflict = detectConflict(content, mem.content, sim);
        if (conflict.isConflict) {
          const isSuperseding = type === "correction" || confidence > mem.confidence;
          if (isSuperseding) {
            db.expireMemory(mem.id);
            db.snapshotVersion(mem.id, `superseded by new ${type} memory`);
            break;
          }
          return {
            action: "reinforced", id: mem.id, type, confidence: mem.confidence,
            tags: mem.tags, total: db.getStats().total, reinforced: 0,
          };
        }

        db.touchAccess(mem.id);
        reinforced++;
      }
    }
  }

  const input: MemoryInput = {
    content,
    type,
    tags,
    confidence,
    source,
    scope: scope ?? "global",
    embedding,
  };

  const id = db.insertMemory(input);

  if (embedding) {
    try { autoRelateMemory(db, id); } catch {}
  }

  return {
    action: "stored",
    id,
    type,
    confidence,
    tags,
    total: db.getStats().total,
    reinforced,
  };
}
