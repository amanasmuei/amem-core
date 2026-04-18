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

// Collapse any CR/LF in a frontmatter value so a user-authored tag or
// description cannot inject a fake YAML line that parseFrontmatter's
// line-by-line loop would mis-classify (e.g. hijacking the `type` field).
const safeFm = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

export function serializeMemoryFile(memory: Memory, opts: SerializeOptions = {}): string {
  const claudeType = AMEM_TO_CLAUDE_TYPE[memory.type];
  const description = opts.description ?? memory.content.split("\n")[0].slice(0, 120);
  const createdISO = new Date(memory.createdAt).toISOString();

  const fm: string[] = [
    `name: ${safeFm(memory.id)}`,
    `description: ${safeFm(description)}`,
    `type: ${claudeType}`,
    `amem_id: ${safeFm(memory.id)}`,
    `amem_type: ${memory.type}`,
    `amem_confidence: ${memory.confidence}`,
    `amem_tier: ${safeFm(memory.tier)}`,
    `amem_tags: ${memory.tags.map(safeFm).join(", ")}`,
    `amem_created: ${createdISO}`,
  ];

  return `---\n${fm.join("\n")}\n---\n${memory.content}\n`;
}
