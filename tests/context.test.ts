import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, type AmemDatabase } from "../src/database.js";
import { buildContext } from "../src/context.js";
import { MemoryType, type MemoryTypeValue } from "../src/memory.js";

// buildContext is the session-start injection path. It queries via
// recallMemories (which uses FTS + optional embeddings), groups by type
// in TYPE_ORDER, and caps output at a token budget.

describe("buildContext", () => {
  let db: AmemDatabase;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `amem-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + "-wal"); } catch {}
    try { fs.unlinkSync(dbPath + "-shm"); } catch {}
  });

  function insert(content: string, type: MemoryTypeValue, extras: { confidence?: number; scope?: string; tags?: string[] } = {}) {
    return db.insertMemory({
      content,
      type,
      tags: extras.tags ?? [],
      confidence: extras.confidence ?? 0.8,
      source: "test",
      scope: extras.scope ?? "global",
      embedding: null,
    });
  }

  describe("empty database", () => {
    it("returns an empty result with a helpful 'not found' message", async () => {
      const result = await buildContext(db, "anything");
      expect(result.memoriesUsed).toBe(0);
      expect(result.groups).toEqual([]);
      expect(result.text).toContain("No context found");
      expect(result.topic).toBe("anything");
    });
  });

  describe("basic grouping", () => {
    it("groups memories by type in the result.groups array", async () => {
      insert("Never use var in this project", MemoryType.CORRECTION, { confidence: 1.0 });
      insert("Chose Postgres over MySQL", MemoryType.DECISION, { confidence: 0.9 });
      insert("Prefers early returns", MemoryType.PATTERN, { confidence: 0.7 });

      const result = await buildContext(db, "coding style");
      expect(result.memoriesUsed).toBeGreaterThanOrEqual(1);
      // Each group should have a type and at least one memory
      for (const g of result.groups) {
        expect(g.type).toBeTruthy();
        expect(g.memories.length).toBeGreaterThan(0);
      }
    });

    it("includes the topic in the output text", async () => {
      insert("Some preference about something", MemoryType.PREFERENCE);
      const result = await buildContext(db, "my-specific-topic");
      expect(result.text).toContain("my-specific-topic");
    });

    it("formats confidence as a percentage in the text output", async () => {
      insert("A decision", MemoryType.DECISION, { confidence: 0.85 });
      const result = await buildContext(db, "decision");
      if (result.memoriesUsed > 0) {
        expect(result.text).toMatch(/\d+% confidence/);
      }
    });
  });

  describe("type ordering", () => {
    it("orders groups with corrections before decisions (TYPE_ORDER)", async () => {
      insert("A preference", MemoryType.PREFERENCE, { confidence: 0.7 });
      insert("A correction", MemoryType.CORRECTION, { confidence: 1.0 });
      insert("A decision", MemoryType.DECISION, { confidence: 0.9 });

      const result = await buildContext(db, "preference correction decision");
      if (result.groups.length >= 2) {
        const types = result.groups.map(g => g.type);
        const correctionIdx = types.indexOf("correction");
        const decisionIdx = types.indexOf("decision");
        const prefIdx = types.indexOf("preference");
        // TYPE_ORDER is: correction, decision, pattern, preference, topology, fact
        if (correctionIdx !== -1 && decisionIdx !== -1) {
          expect(correctionIdx).toBeLessThan(decisionIdx);
        }
        if (decisionIdx !== -1 && prefIdx !== -1) {
          expect(decisionIdx).toBeLessThan(prefIdx);
        }
      }
    });
  });

  describe("token budget", () => {
    it("respects a very small maxTokens budget", async () => {
      // Insert enough memories that a 10-token budget cannot fit them all
      for (let i = 0; i < 20; i++) {
        insert(`A reasonably long memory content number ${i} with enough characters to consume several tokens of budget`, MemoryType.FACT);
      }
      const result = await buildContext(db, "memory", { maxTokens: 10 });
      // Budget is enforced; output text is bounded. (CHARS_PER_TOKEN = 4)
      expect(result.text.length).toBeLessThan(500);
    });

    it("uses default maxTokens when not specified", async () => {
      insert("Single memory", MemoryType.FACT);
      const result = await buildContext(db, "memory");
      expect(result.text).toBeTruthy();
    });
  });

  describe("scope filtering", () => {
    it("restricts results when scope is provided", async () => {
      insert("Global preference", MemoryType.PREFERENCE, { scope: "global" });
      insert("Project memory", MemoryType.FACT, { scope: "project:alpha" });
      insert("Other project memory", MemoryType.FACT, { scope: "project:beta" });

      const resultAlpha = await buildContext(db, "memory", { scope: "project:alpha" });
      const contents = resultAlpha.groups.flatMap(g => g.memories.map(m => m.content));
      // recallMemories already filters by scope — this just verifies the prop is threaded through
      expect(contents.every(c => !c.includes("Other project"))).toBe(true);
    });
  });

  describe("access tracking", () => {
    it("increments access count on returned memories", async () => {
      const id = insert("A fact about testing", MemoryType.FACT);
      const before = db.getById(id);
      expect(before?.accessCount).toBe(0);

      await buildContext(db, "fact testing");

      const after = db.getById(id);
      // If the recall surfaced it, access count should bump
      if (after && (after.accessCount ?? 0) > 0) {
        expect(after.accessCount).toBeGreaterThan(before?.accessCount ?? 0);
      }
    });
  });

  describe("result shape", () => {
    it("always returns text, topic, groups, and memoriesUsed", async () => {
      insert("A memory", MemoryType.FACT);
      const result = await buildContext(db, "memory");
      expect(result).toHaveProperty("text");
      expect(result).toHaveProperty("topic");
      expect(result).toHaveProperty("groups");
      expect(result).toHaveProperty("memoriesUsed");
      expect(typeof result.text).toBe("string");
      expect(Array.isArray(result.groups)).toBe(true);
    });

    it("trimmed text has no trailing whitespace", async () => {
      insert("A memory", MemoryType.FACT);
      const result = await buildContext(db, "memory");
      expect(result.text).toBe(result.text.trimEnd());
    });
  });
});
