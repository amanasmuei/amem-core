import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { slugifyName, serializeMemoryFile, MirrorEngine } from "../src/mirror.js";
import { MemoryType } from "../src/memory.js";
import { parseFrontmatter } from "../src/sync.js";
import { createDatabase, type AmemDatabase } from "../src/database.js";
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

  it("neutralizes newline injection in tags and description (YAML safety)", () => {
    const mem = fakeMemory({
      tags: ["ok", "evil\ntype: pattern"],
    });
    const serialized = serializeMemoryFile(mem, {
      description: "first line\r\nmalicious: second line",
    });
    const parsed = parseFrontmatter(serialized, "/fake.md");
    expect(parsed).not.toBeNull();
    // type must NOT be hijacked to "pattern" — it should remain the expected Claude vocab
    expect(parsed!.type).toBe("feedback");
  });

  it("serializes memories with empty tags without breaking the parser", () => {
    const mem = fakeMemory({ tags: [] });
    const serialized = serializeMemoryFile(mem);
    const parsed = parseFrontmatter(serialized, "/fake.md");
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("feedback");
    expect(serialized).toContain("amem_tags: ");
  });
});

// ── MirrorEngine: filesystem-backed tests ──────────────────────────────────

let tempDir: string;
let db: AmemDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-"));
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("MirrorEngine.onSave", () => {
  it("writes a per-memory .md file under <dir>/<type>/<id>.md", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, { dir: mirrorDir, includeIndex: false });

    const mem = fakeMemory({ id: "mem_A", type: MemoryType.CORRECTION });
    await engine.onSave(mem);

    const expected = path.join(mirrorDir, "correction", `${mem.id}.md`);
    expect(fs.existsSync(expected)).toBe(true);
    const content = fs.readFileSync(expected, "utf-8");
    expect(content).toContain("name: mem_A");
    expect(content).toContain("type: feedback");
  });

  it("skips memories whose tier is not in the configured tiers list", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, {
      dir: mirrorDir,
      tiers: ["core"],
      includeIndex: false,
    });

    const archival = fakeMemory({ id: "mem_E", tier: "archival" });
    await engine.onSave(archival);

    const typeDir = path.join(mirrorDir, "correction");
    const files = fs.existsSync(typeDir) ? fs.readdirSync(typeDir) : [];
    expect(files).toEqual([]);
  });

  it("writes archival-tier memory by default (all tiers mirrored)", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, { dir: mirrorDir, includeIndex: false });
    const archival = fakeMemory({ id: "mem_AR", tier: "archival" });
    await engine.onSave(archival);
    expect(fs.existsSync(path.join(mirrorDir, "correction", "mem_AR.md"))).toBe(true);
  });

  it("writes working-tier memory by default (all tiers mirrored)", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, { dir: mirrorDir, includeIndex: false });
    const working = fakeMemory({ id: "mem_W", tier: "working" });
    await engine.onSave(working);
    expect(fs.existsSync(path.join(mirrorDir, "correction", "mem_W.md"))).toBe(true);
  });

  it("leaves no .tmp file behind after successful write (atomic rename)", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, { dir: mirrorDir, includeIndex: false });
    await engine.onSave(fakeMemory({ id: "mem_A" }));
    const files = fs.readdirSync(path.join(mirrorDir, "correction"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("never throws on I/O failure — invokes onError instead", async () => {
    const errors: Array<{ err: Error; ctx: string }> = [];
    const engine = new MirrorEngine(db, {
      dir: "/this/path/does/not/exist/and/cannot/be/created\0",
      includeIndex: false,
      onError: (err, ctx) => {
        errors.push({ err, ctx });
      },
    });
    await expect(engine.onSave(fakeMemory())).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
    expect(errors[0].ctx).toContain("onSave");
  });

  it("cleans up the .tmp file when the write/rename step fails", async () => {
    // Pre-create the target path as a DIRECTORY to force renameSync to fail.
    const mirrorDir = path.join(tempDir, "mirror");
    const typeDir = path.join(mirrorDir, "correction");
    fs.mkdirSync(typeDir, { recursive: true });
    const targetAsDir = path.join(typeDir, "mem_BLOCK.md");
    fs.mkdirSync(targetAsDir);
    // Put a file inside so rename-over-directory fails on macOS/Linux.
    fs.writeFileSync(path.join(targetAsDir, "sentinel"), "x");

    const errors: Array<{ err: Error; ctx: string }> = [];
    const engine = new MirrorEngine(db, {
      dir: mirrorDir,
      includeIndex: false,
      onError: (err, ctx) => errors.push({ err, ctx }),
    });

    await engine.onSave(fakeMemory({ id: "mem_BLOCK" }));
    // Even after failure, no leaked .tmp file remains in the type dir.
    const leftovers = fs.readdirSync(typeDir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(errors.length).toBe(1);
  });
});

describe("MirrorEngine.onUpdate", () => {
  it("uses the same file path as onSave (filename stable via memory.id)", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, { dir: mirrorDir, includeIndex: false });

    const mem = fakeMemory({ id: "mem_U", content: "original" });
    await engine.onSave(mem);

    const updated = fakeMemory({ id: "mem_U", content: "updated body" });
    await engine.onUpdate(updated);

    const filePath = path.join(mirrorDir, "correction", "mem_U.md");
    const files = fs.readdirSync(path.join(mirrorDir, "correction"));
    expect(files).toEqual(["mem_U.md"]);
    expect(fs.readFileSync(filePath, "utf-8")).toContain("updated body");
  });
});

describe("MirrorEngine.onDelete", () => {
  it("removes the corresponding .md file", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, { dir: mirrorDir, includeIndex: false });
    const mem = fakeMemory({ id: "mem_A" });
    await engine.onSave(mem);
    await engine.onDelete(mem.id, mem.type);
    const typeDir = path.join(mirrorDir, "correction");
    const remaining = fs.existsSync(typeDir) ? fs.readdirSync(typeDir) : [];
    expect(remaining).toEqual([]);
  });

  it("is a no-op if the file does not exist", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, { dir: mirrorDir, includeIndex: false });
    await expect(
      engine.onDelete("nonexistent", MemoryType.CORRECTION),
    ).resolves.toBeUndefined();
  });
});

describe("MirrorEngine.status", () => {
  it("returns zero fileCount and null lastWriteAt before any writes", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, { dir: mirrorDir, includeIndex: false });
    const s = engine.status();
    expect(s.dir).toBe(mirrorDir);
    expect(s.fileCount).toBe(0);
    expect(s.lastWriteAt).toBeNull();
    expect(s.healthy).toBe(true);
  });

  it("reports fileCount and a numeric lastWriteAt after a save", async () => {
    const mirrorDir = path.join(tempDir, "mirror");
    const engine = new MirrorEngine(db, { dir: mirrorDir, includeIndex: false });
    const before = Date.now();
    await engine.onSave(fakeMemory({ id: "mem_1" }));
    await engine.onSave(fakeMemory({ id: "mem_2", type: MemoryType.DECISION }));
    const s = engine.status();
    expect(s.fileCount).toBe(2);
    expect(typeof s.lastWriteAt).toBe("number");
    expect(s.lastWriteAt!).toBeGreaterThanOrEqual(before);
    expect(s.healthy).toBe(true);
  });
});
