import { describe, it, expect } from "vitest";
import { slugifyName, serializeMemoryFile } from "../src/mirror.js";
import { MemoryType } from "../src/memory.js";
import { parseFrontmatter } from "../src/sync.js";
import type { Memory } from "../src/memory.js";

function fakeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.parse("2026-04-12T08:30:00Z");
  return {
    id: "mem_01HQX8ABC",
    type: MemoryType.CORRECTION,
    content: "User prefers terse responses.\n\nNo trailing summaries.",
    tags: ["communication", "style"],
    confidence: 0.95,
    accessCount: 0,
    createdAt: now,
    lastAccessed: now,
    source: "conversation",
    embedding: null,
    scope: "global",
    validFrom: now,
    validUntil: null,
    tier: "core",
    utilityScore: 0,
    ...overrides,
  };
}

describe("slugifyName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyName("Prefer Terse Responses")).toBe("prefer-terse-responses");
  });
  it("strips punctuation and collapses whitespace", () => {
    expect(slugifyName("  User's *role* (senior)  ")).toBe("users-role-senior");
  });
  it("handles already-slugged input", () => {
    expect(slugifyName("kebab-already-ok")).toBe("kebab-already-ok");
  });
  it("falls back to 'memory' for empty/non-ascii input", () => {
    expect(slugifyName("")).toBe("memory");
    expect(slugifyName("日本語のみ")).toBe("memory");
  });
  it("truncates to 80 chars to avoid filesystem limits", () => {
    const long = "a".repeat(200);
    const slug = slugifyName(long);
    expect(slug.length).toBeLessThanOrEqual(80);
  });
});

describe("serializeMemoryFile", () => {
  it("writes name/description/type that sync.ts parseFrontmatter can read back", () => {
    const mem = fakeMemory();
    const serialized = serializeMemoryFile(mem, { description: "Terse replies" });
    const parsed = parseFrontmatter(serialized, "/fake/path.md");
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("mem_01HQX8ABC");
    expect(parsed!.type).toBe("feedback"); // correction → feedback (Claude type vocab)
    expect(parsed!.body.trim()).toBe(mem.content);
  });

  it("includes amem_* metadata without breaking the parser", () => {
    const mem = fakeMemory();
    const serialized = serializeMemoryFile(mem);
    expect(serialized).toContain("amem_id: mem_01HQX8ABC");
    expect(serialized).toContain("amem_confidence: 0.95");
    expect(serialized).toContain("amem_tier: core");
    expect(serialized).toContain("amem_tags: communication, style");
  });
});
