import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, type AmemDatabase } from "../src/database.js";
import { storeMemory } from "../src/store.js";
import { MemoryType } from "../src/memory.js";

// storeMemory is async + calls generateEmbedding, which may or may not be
// available depending on whether the transformers model has been warmed.
// The tests assert behavior that holds either way: the embedding path is
// best-effort — if it returns null, supersession/reinforcement logic is
// skipped but the memory still gets stored.

describe("storeMemory", () => {
  let db: AmemDatabase;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `amem-store-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + "-wal"); } catch {}
    try { fs.unlinkSync(dbPath + "-shm"); } catch {}
  });

  describe("basic storage", () => {
    it("stores a simple memory and returns a stored result", async () => {
      const result = await storeMemory(db, {
        content: "User prefers pnpm over npm",
        type: MemoryType.PREFERENCE,
      });

      expect(result.action).toBe("stored");
      expect(result.id).toBeTruthy();
      expect(result.type).toBe("preference");
      expect(result.total).toBe(1);
    });

    it("defaults confidence to 0.8 when not specified", async () => {
      const result = await storeMemory(db, {
        content: "Defaults to 0.8",
        type: MemoryType.FACT,
      });
      expect(result.confidence).toBe(0.8);
    });

    it("respects explicit confidence", async () => {
      const result = await storeMemory(db, {
        content: "Explicit confidence",
        type: MemoryType.FACT,
        confidence: 0.42,
      });
      expect(result.confidence).toBe(0.42);
    });

    it("defaults scope to 'global' when not specified", async () => {
      const result = await storeMemory(db, {
        content: "Scope defaults to global",
        type: MemoryType.CORRECTION,
      });
      const stored = db.getById(result.id);
      expect(stored?.scope).toBe("global");
    });

    it("respects explicit scope", async () => {
      const result = await storeMemory(db, {
        content: "Scoped to a project",
        type: MemoryType.DECISION,
        scope: "project:myapp",
      });
      const stored = db.getById(result.id);
      expect(stored?.scope).toBe("project:myapp");
    });

    it("persists tags verbatim", async () => {
      const result = await storeMemory(db, {
        content: "Tagged memory",
        type: MemoryType.PATTERN,
        tags: ["rust", "async"],
      });
      const stored = db.getById(result.id);
      expect(stored?.tags).toEqual(["rust", "async"]);
    });

    it("uses 'conversation' as the default source", async () => {
      const result = await storeMemory(db, {
        content: "Source defaults",
        type: MemoryType.FACT,
      });
      const stored = db.getById(result.id);
      expect(stored?.source).toBe("conversation");
    });

    it("respects an explicit source", async () => {
      const result = await storeMemory(db, {
        content: "Custom source",
        type: MemoryType.FACT,
        source: "cli-import",
      });
      const stored = db.getById(result.id);
      expect(stored?.source).toBe("cli-import");
    });
  });

  describe("privacy sanitization", () => {
    it("returns 'private' action and does not insert when entire content is wrapped in <private>", async () => {
      const result = await storeMemory(db, {
        content: "<private>API_KEY=secret123</private>",
        type: MemoryType.FACT,
      });
      expect(result.action).toBe("private");
      expect(result.id).toBe("");
      expect(db.getStats().total).toBe(0);
    });

    it("stores the non-private portion when content is mixed", async () => {
      const result = await storeMemory(db, {
        content: "Uses Postgres <private>with password abc123</private> for storage",
        type: MemoryType.TOPOLOGY,
      });
      expect(result.action).toBe("stored");
      const stored = db.getById(result.id);
      expect(stored?.content).not.toContain("password");
      expect(stored?.content).toContain("[REDACTED]");
    });
  });

  describe("all memory types", () => {
    const types = [
      MemoryType.CORRECTION,
      MemoryType.DECISION,
      MemoryType.PATTERN,
      MemoryType.PREFERENCE,
      MemoryType.TOPOLOGY,
      MemoryType.FACT,
    ];
    for (const type of types) {
      it(`accepts type "${type}"`, async () => {
        const result = await storeMemory(db, {
          content: `A memory of type ${type}`,
          type,
        });
        expect(result.action).toBe("stored");
        expect(result.type).toBe(type);
      });
    }
  });

  describe("multiple stores", () => {
    it("increments the total count on each successful store", async () => {
      const r1 = await storeMemory(db, { content: "First", type: MemoryType.FACT });
      expect(r1.total).toBe(1);
      const r2 = await storeMemory(db, { content: "Second", type: MemoryType.FACT });
      expect(r2.total).toBe(2);
      const r3 = await storeMemory(db, { content: "Third", type: MemoryType.FACT });
      expect(r3.total).toBe(3);
    });

    it("assigns unique IDs to distinct memories", async () => {
      const r1 = await storeMemory(db, { content: "A", type: MemoryType.FACT });
      const r2 = await storeMemory(db, { content: "B", type: MemoryType.FACT });
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe("return shape", () => {
    it("always includes reinforced count (>= 0)", async () => {
      const result = await storeMemory(db, {
        content: "Shape check",
        type: MemoryType.FACT,
      });
      expect(typeof result.reinforced).toBe("number");
      expect(result.reinforced).toBeGreaterThanOrEqual(0);
    });

    it("returns tags as an array even when none provided", async () => {
      const result = await storeMemory(db, {
        content: "No tags",
        type: MemoryType.FACT,
      });
      expect(Array.isArray(result.tags)).toBe(true);
      expect(result.tags).toEqual([]);
    });
  });
});
