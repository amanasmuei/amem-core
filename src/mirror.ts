import type { Memory, MemoryTypeValue } from "./memory.js";

const MAX_SLUG_LEN = 80;

export function slugifyName(raw: string): string {
  const ascii = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = ascii.slice(0, MAX_SLUG_LEN).replace(/-+$/g, "");
  return truncated || "memory";
}

// Inverse of CLAUDE_TO_AMEM_TYPE in sync.ts.
// Memories whose type has no Claude counterpart (pattern, fact) use "reference"
// — the most neutral Claude vocab — so parseFrontmatter still accepts them.
const AMEM_TO_CLAUDE_TYPE: Record<MemoryTypeValue, string> = {
  correction: "feedback",
  decision: "project",
  preference: "user",
  topology: "reference",
  pattern: "reference",
  fact: "reference",
};

export interface SerializeOptions {
  description?: string;
}

export function serializeMemoryFile(memory: Memory, opts: SerializeOptions = {}): string {
  const claudeType = AMEM_TO_CLAUDE_TYPE[memory.type] ?? "reference";
  const description = opts.description ?? memory.content.split("\n")[0].slice(0, 120);
  const createdISO = new Date(memory.createdAt).toISOString();

  const fm: string[] = [
    `name: ${memory.id}`,
    `description: ${description.replace(/\n/g, " ")}`,
    `type: ${claudeType}`,
    `amem_id: ${memory.id}`,
    `amem_type: ${memory.type}`,
    `amem_confidence: ${memory.confidence}`,
    `amem_tier: ${memory.tier}`,
    `amem_tags: ${memory.tags.join(", ")}`,
    `amem_created: ${createdISO}`,
  ];

  return `---\n${fm.join("\n")}\n---\n${memory.content}\n`;
}
