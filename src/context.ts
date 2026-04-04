import type { AmemDatabase } from "./database.js";
import type { RecalledMemory } from "./memory.js";
import { recallMemories } from "./memory.js";
import { generateEmbedding } from "./embeddings.js";
import { TYPE_ORDER, formatAge } from "./helpers.js";

export interface ContextGroup {
  type: string;
  memories: Array<{ content: string; confidence: number }>;
}

export interface ContextResult {
  text: string;
  topic: string;
  groups: ContextGroup[];
  memoriesUsed: number;
}

export async function buildContext(
  db: AmemDatabase,
  topic: string,
  opts: { maxTokens?: number; scope?: string } = {},
): Promise<ContextResult> {
  const { maxTokens = 2000, scope } = opts;
  const queryEmbedding = await generateEmbedding(topic);

  const results = recallMemories(db, {
    query: topic,
    queryEmbedding,
    limit: 50,
    scope,
  });

  if (results.length === 0) {
    return {
      text: `No context found for: "${topic}".`,
      topic,
      groups: [],
      memoriesUsed: 0,
    };
  }

  const grouped: Record<string, RecalledMemory[]> = {};
  for (const r of results) {
    if (!grouped[r.type]) grouped[r.type] = [];
    grouped[r.type].push(r);
  }

  let output = `## Context for: ${topic}\n\n`;
  let approxTokens = 0;
  const CHARS_PER_TOKEN = 4;

  for (const t of TYPE_ORDER) {
    const memories = grouped[t];
    if (!memories || memories.length === 0) continue;

    const header = `### ${t.charAt(0).toUpperCase() + t.slice(1)}s\n`;
    output += header;
    approxTokens += header.length / CHARS_PER_TOKEN;

    for (const m of memories) {
      const line = `- ${m.content} (${(m.confidence * 100).toFixed(0)}% confidence)\n`;
      approxTokens += line.length / CHARS_PER_TOKEN;
      if (approxTokens > maxTokens) break;
      output += line;
    }
    output += "\n";
    if (approxTokens > maxTokens) break;
  }

  for (const r of results) db.touchAccess(r.id);

  const groups = TYPE_ORDER
    .filter(t => grouped[t] && grouped[t].length > 0)
    .map(t => ({
      type: t,
      memories: grouped[t].map(m => ({
        content: m.content,
        confidence: m.confidence,
      })),
    }));

  return { text: output.trim(), topic, groups, memoriesUsed: results.length };
}
