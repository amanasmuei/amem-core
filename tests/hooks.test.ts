import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  isHookEnabled,
  runAutoExtract,
} from "../src/hooks.js";
import type { Extractor, ExtractedMemory } from "../src/extractor.js";
import { getDefaultConfig, resetConfigCache } from "../src/config.js";
import { createDatabase, type AmemDatabase } from "../src/database.js";

// isHookEnabled() uses loadConfig() when no config is passed explicitly.
// To avoid cross-test contamination we point AMEM_DIR at a tempdir for the
// few tests that don't pass an explicit config, then restore after.
let tmpDir: string | undefined;
let originalAmemDir: string | undefined;

function isolateConfig() {
  originalAmemDir = process.env.AMEM_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amem-hooks-"));
  process.env.AMEM_DIR = tmpDir;
  resetConfigCache();
}

function restoreConfig() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalAmemDir === undefined) delete process.env.AMEM_DIR;
  else process.env.AMEM_DIR = originalAmemDir;
  resetConfigCache();
}

describe("isHookEnabled", () => {
  it("returns false for every event when hooks.enabled is off", () => {
    const cfg = getDefaultConfig();
    cfg.hooks.enabled = false;
    expect(isHookEnabled("toolUse", cfg)).toBe(false);
    expect(isHookEnabled("sessionEnd", cfg)).toBe(false);
    expect(isHookEnabled("autoExtract", cfg)).toBe(false);
  });

  it("honors per-event flags when hooks.enabled is on", () => {
    const cfg = getDefaultConfig();
    cfg.hooks.enabled = true;
    cfg.hooks.captureToolUse = true;
    cfg.hooks.captureSessionEnd = false;
    cfg.hooks.autoExtractInterval = 0;
    expect(isHookEnabled("toolUse", cfg)).toBe(true);
    expect(isHookEnabled("sessionEnd", cfg)).toBe(false);
    // autoExtract requires a positive interval
    expect(isHookEnabled("autoExtract", cfg)).toBe(false);
  });

  it("autoExtract is enabled only when interval > 0", () => {
    const cfg = getDefaultConfig();
    cfg.hooks.enabled = true;
    cfg.hooks.autoExtractInterval = 60;
    expect(isHookEnabled("autoExtract", cfg)).toBe(true);
  });
});

describe("runAutoExtract", () => {
  let db: AmemDatabase;

  beforeEach(() => {
    isolateConfig();
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
    restoreConfig();
  });

  it("returns all-zero result when hooks.enabled is false", async () => {
    // Default config ships with hooks.enabled=true, so override on disk.
    const configPath = path.join(tmpDir!, "config.json");
    const cfg = getDefaultConfig();
    cfg.hooks.enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    resetConfigCache();

    db.appendLog({
      sessionId: "s1",
      role: "user",
      content: "I prefer tabs over spaces in this codebase",
      project: "global",
    });

    const result = await runAutoExtract(db);
    expect(result).toEqual({
      extractor: "rule-based",
      extracted: 0,
      stored: 0,
      reinforced: 0,
      skipped: 0,
    });
  });

  it("extracts and stores memories from recent log entries", async () => {
    // Default config has hooks.enabled=true so no override needed.
    db.appendLog({
      sessionId: "s1",
      role: "user",
      content: "I prefer tabs over spaces in this codebase",
      project: "global",
    });
    db.appendLog({
      sessionId: "s1",
      role: "user",
      content: "We decided to go with PostgreSQL for the main database",
      project: "global",
    });
    db.appendLog({
      sessionId: "s1",
      role: "user",
      content: "unrelated chat",
      project: "global",
    });

    const result = await runAutoExtract(db, { minConfidence: 0.5 });
    // Extractor should fire on the preference + the decision
    expect(result.extracted).toBeGreaterThanOrEqual(2);
    expect(result.stored + result.reinforced).toBe(result.extracted);
  });

  it("returns zeroes when there are no log entries", async () => {
    const result = await runAutoExtract(db);
    expect(result).toEqual({
      extractor: "rule-based",
      extracted: 0,
      stored: 0,
      reinforced: 0,
      skipped: 0,
    });
  });

  it("scopes extraction to a single session when sessionId is passed", async () => {
    db.appendLog({
      sessionId: "s1",
      role: "user",
      content: "I prefer tabs over spaces in this codebase",
      project: "global",
    });
    db.appendLog({
      sessionId: "s2",
      role: "user",
      content: "We decided to go with PostgreSQL for the main database",
      project: "global",
    });

    const only1 = await runAutoExtract(db, { sessionId: "s1", minConfidence: 0.5 });
    expect(only1.extracted).toBeGreaterThanOrEqual(1);
    // Only the preference from s1 should be seen — not the decision in s2.
    const stats = db.getStats();
    expect(stats.total).toBe(only1.stored);
  });

  it("respects minConfidence threshold", async () => {
    db.appendLog({
      sessionId: "s1",
      role: "user",
      // preference pattern has confidence 0.8
      content: "I prefer tabs over spaces in this codebase",
      project: "global",
    });

    const highBar = await runAutoExtract(db, { minConfidence: 0.99 });
    expect(highBar.extracted).toBe(0);

    const lowBar = await runAutoExtract(db, { minConfidence: 0.5 });
    expect(lowBar.extracted).toBeGreaterThanOrEqual(1);
  });

  it("uses a custom Extractor when provided", async () => {
    db.appendLog({
      sessionId: "s1",
      role: "user",
      content: "totally benign message that triggers nothing",
      project: "global",
    });

    const calls: number[] = [];
    const custom: Extractor = {
      name: "test-custom",
      async extract(turns) {
        calls.push(turns.length);
        const out: ExtractedMemory[] = [{
          content: "synthesized-by-custom-extractor",
          type: "fact",
          confidence: 0.9,
          tags: ["custom"],
          source: "test",
        }];
        return out;
      },
    };

    const result = await runAutoExtract(db, { extractor: custom, minConfidence: 0.5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(0);
    expect(result.extractor).toBe("test-custom");
    expect(result.extracted).toBe(1);
    expect(result.stored).toBe(1);
  });

  it("defaults to ruleBasedExtractor when none supplied", async () => {
    db.appendLog({
      sessionId: "s1",
      role: "user",
      content: "I prefer tabs over spaces in this codebase",
      project: "global",
    });

    const result = await runAutoExtract(db, { minConfidence: 0.5 });
    expect(result.extractor).toBe("rule-based");
    expect(result.extracted).toBeGreaterThanOrEqual(1);
  });

  it("isolates extractor failures without crashing or storing", async () => {
    db.appendLog({
      sessionId: "s1",
      role: "user",
      content: "I prefer tabs over spaces in this codebase",
      project: "global",
    });

    const broken: Extractor = {
      name: "broken",
      extract() {
        throw new Error("intentional test failure");
      },
    };

    const before = db.getStats().total;
    const result = await runAutoExtract(db, { extractor: broken, minConfidence: 0.5 });
    expect(result.extractor).toBe("broken");
    expect(result.extracted).toBe(0);
    expect(result.stored).toBe(0);
    expect(result.extractorError).toBe("intentional test failure");
    expect(db.getStats().total).toBe(before);
  });

  it("supports a synchronous Extractor (returns array, not Promise)", async () => {
    db.appendLog({
      sessionId: "s1",
      role: "user",
      content: "some log line",
      project: "global",
    });

    const sync: Extractor = {
      name: "sync-custom",
      extract() {
        return [{
          content: "sync-extractor-output",
          type: "pattern",
          confidence: 0.75,
          tags: [],
          source: "sync",
        }];
      },
    };

    const result = await runAutoExtract(db, { extractor: sync, minConfidence: 0.5 });
    expect(result.extractor).toBe("sync-custom");
    expect(result.extracted).toBe(1);
  });
});
