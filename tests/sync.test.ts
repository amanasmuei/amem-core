import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, type AmemDatabase } from "../src/database.js";
import {
  discoverClaudeMemories,
  readClaudeMemoryDir,
  syncFromClaude,
  exportForTeam,
  importFromTeam,
  generateCopilotInstructions,
  syncToCopilot,
} from "../src/sync.js";
import { MemoryType } from "../src/memory.js";

// Each test gets its own temp HOME so ~/.claude/projects is fully isolated
// and we can write fake Claude auto-memory files without touching real state.

let origHome: string | undefined;
let tempHome: string;
let db: AmemDatabase;
let dbPath: string;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `amem-sync-${prefix}-`));
}

function writeClaudeMemoryFile(
  projectDirName: string,
  fileName: string,
  frontmatter: Record<string, string>,
  body: string,
): string {
  const memDir = path.join(tempHome, ".claude", "projects", projectDirName, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n");
  const content = `---\n${fm}\n---\n${body}`;
  const filePath = path.join(memDir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

beforeEach(() => {
  tempHome = makeTempDir("home");
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dbPath = path.join(os.tmpdir(), `amem-sync-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = createDatabase(dbPath);
});

afterEach(() => {
  try { db.close(); } catch {}
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
});

describe("discoverClaudeMemories", () => {
  it("returns an empty map when ~/.claude/projects does not exist", () => {
    const result = discoverClaudeMemories();
    expect(result.size).toBe(0);
  });

  it("discovers a project with a memory/ subdirectory", () => {
    const memDir = path.join(tempHome, ".claude", "projects", "-Users-aman-myapp", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const result = discoverClaudeMemories();
    expect(result.size).toBe(1);
    // Leading "-" stripped, remaining "-" replaced with "/"
    expect([...result.keys()][0]).toContain("Users/aman/myapp");
  });

  it("skips project directories without a memory/ subdirectory", () => {
    fs.mkdirSync(path.join(tempHome, ".claude", "projects", "-tmp-empty"), { recursive: true });
    const result = discoverClaudeMemories();
    expect(result.size).toBe(0);
  });

  it("discovers multiple projects", () => {
    fs.mkdirSync(path.join(tempHome, ".claude", "projects", "-a-b", "memory"), { recursive: true });
    fs.mkdirSync(path.join(tempHome, ".claude", "projects", "-c-d", "memory"), { recursive: true });
    const result = discoverClaudeMemories();
    expect(result.size).toBe(2);
  });
});

describe("readClaudeMemoryDir", () => {
  it("returns empty array for a nonexistent directory", () => {
    const result = readClaudeMemoryDir(path.join(tempHome, "does-not-exist"));
    expect(result).toEqual([]);
  });

  it("parses a well-formed memory file", () => {
    writeClaudeMemoryFile(
      "-tmp-proj",
      "user_role.md",
      { name: "user role", description: "what the user does", type: "user" },
      "The user is a senior Go developer.",
    );
    const memDir = path.join(tempHome, ".claude", "projects", "-tmp-proj", "memory");
    const result = readClaudeMemoryDir(memDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("user role");
    expect(result[0].type).toBe("user");
    expect(result[0].body).toBe("The user is a senior Go developer.");
    expect(result[0].description).toBe("what the user does");
  });

  it("skips MEMORY.md index file", () => {
    const memDir = path.join(tempHome, ".claude", "projects", "-p", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), "# index");
    fs.writeFileSync(path.join(memDir, "note.md"), "---\nname: n\ntype: user\n---\nbody");
    const result = readClaudeMemoryDir(memDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("n");
  });

  it("skips non-markdown files", () => {
    const memDir = path.join(tempHome, ".claude", "projects", "-p", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "data.json"), "{}");
    fs.writeFileSync(path.join(memDir, "note.md"), "---\nname: n\ntype: user\n---\nbody");
    const result = readClaudeMemoryDir(memDir);
    expect(result).toHaveLength(1);
  });

  it("skips files without valid frontmatter", () => {
    const memDir = path.join(tempHome, ".claude", "projects", "-p", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "bad.md"), "no frontmatter here");
    fs.writeFileSync(path.join(memDir, "good.md"), "---\nname: good\ntype: user\n---\nbody");
    const result = readClaudeMemoryDir(memDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("good");
  });

  it("skips files missing required frontmatter fields", () => {
    const memDir = path.join(tempHome, ".claude", "projects", "-p", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    // missing 'type'
    fs.writeFileSync(path.join(memDir, "bad.md"), "---\nname: x\n---\nbody");
    // missing 'name'
    fs.writeFileSync(path.join(memDir, "bad2.md"), "---\ntype: user\n---\nbody");
    const result = readClaudeMemoryDir(memDir);
    expect(result).toHaveLength(0);
  });
});

describe("syncFromClaude", () => {
  it("returns zero counts when ~/.claude/projects is empty", async () => {
    const result = await syncFromClaude(db);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.projectsScanned).toBe(0);
  });

  it("imports memories with the correct type mapping", async () => {
    writeClaudeMemoryFile("-proj-a", "fb.md", { name: "correction", type: "feedback" }, "never use var");
    writeClaudeMemoryFile("-proj-a", "pj.md", { name: "decision", type: "project" }, "chose Postgres");
    writeClaudeMemoryFile("-proj-a", "usr.md", { name: "pref", type: "user" }, "prefers pnpm");
    writeClaudeMemoryFile("-proj-a", "ref.md", { name: "topo", type: "reference" }, "see Linear ENG project");

    const result = await syncFromClaude(db);
    expect(result.imported).toBe(4);
    const all = db.getAll();
    const types = new Set(all.map(m => m.type));
    expect(types.has("correction")).toBe(true);
    expect(types.has("decision")).toBe(true);
    expect(types.has("preference")).toBe(true);
    expect(types.has("topology")).toBe(true);
  });

  it("skips memories with unknown Claude type", async () => {
    writeClaudeMemoryFile("-proj", "weird.md", { name: "x", type: "totally-unknown" }, "body");
    const result = await syncFromClaude(db);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.details[0].reason).toContain("Unknown");
  });

  it("is idempotent: running twice imports nothing the second time", async () => {
    writeClaudeMemoryFile("-proj", "m.md", { name: "pref", type: "user" }, "prefers pnpm");
    const first = await syncFromClaude(db);
    expect(first.imported).toBe(1);
    const second = await syncFromClaude(db);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });

  it("dryRun does not insert into the database", async () => {
    writeClaudeMemoryFile("-proj", "m.md", { name: "pref", type: "user" }, "prefers pnpm");
    const result = await syncFromClaude(db, undefined, true);
    expect(result.imported).toBe(1);
    expect(db.getStats().total).toBe(0);
  });

  it("projectFilter restricts which projects are scanned", async () => {
    writeClaudeMemoryFile("-alpha", "m.md", { name: "a", type: "user" }, "body a");
    writeClaudeMemoryFile("-beta", "m.md", { name: "b", type: "user" }, "body b");
    const result = await syncFromClaude(db, "alpha");
    expect(result.projectsScanned).toBe(1);
  });

  it("tags imported memories with claude-sync and the source type", async () => {
    writeClaudeMemoryFile("-proj", "m.md", { name: "thing", type: "feedback" }, "never do X");
    await syncFromClaude(db);
    const all = db.getAll();
    expect(all[0].tags).toContain("claude-sync");
    expect(all[0].tags).toContain("feedback");
  });

  it("uses global scope for user and feedback types", async () => {
    writeClaudeMemoryFile("-proj", "u.md", { name: "u", type: "user" }, "user pref");
    writeClaudeMemoryFile("-proj", "f.md", { name: "f", type: "feedback" }, "correction");
    await syncFromClaude(db);
    const all = db.getAll();
    for (const m of all) {
      expect(m.scope).toBe("global");
    }
  });

  it("uses project scope for project and reference types", async () => {
    writeClaudeMemoryFile("-some-proj", "p.md", { name: "p", type: "project" }, "decision");
    writeClaudeMemoryFile("-some-proj", "r.md", { name: "r", type: "reference" }, "topology");
    await syncFromClaude(db);
    const all = db.getAll();
    for (const m of all) {
      expect(m.scope).toContain("project:");
    }
  });

  it("assigns correction confidence of 1.0 for feedback type", async () => {
    writeClaudeMemoryFile("-proj", "m.md", { name: "x", type: "feedback" }, "never");
    await syncFromClaude(db);
    const all = db.getAll();
    expect(all[0].confidence).toBe(1.0);
  });
});

describe("exportForTeam", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = makeTempDir("export");
  });
  afterEach(() => {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  });

  function seed() {
    db.insertMemory({ content: "correction 1", type: MemoryType.CORRECTION, tags: [], confidence: 1.0, source: "test", scope: "global", embedding: null });
    db.insertMemory({ content: "decision 1", type: MemoryType.DECISION, tags: [], confidence: 0.9, source: "test", scope: "global", embedding: null });
    db.insertMemory({ content: "low confidence fact", type: MemoryType.FACT, tags: [], confidence: 0.3, source: "test", scope: "global", embedding: null });
    db.insertMemory({ content: "global preference", type: MemoryType.PREFERENCE, tags: [], confidence: 0.8, source: "test", scope: "global", embedding: null });
    db.insertMemory({ content: "private pref", type: MemoryType.PREFERENCE, tags: [], confidence: 0.8, source: "test", scope: "project:mine", embedding: null });
  }

  it("writes a JSON file to the output directory", async () => {
    seed();
    const { file, count } = await exportForTeam(db, outDir, { userId: "aman" });
    expect(fs.existsSync(file)).toBe(true);
    expect(count).toBeGreaterThan(0);
  });

  it("excludes non-global preferences (personal)", async () => {
    seed();
    const { file } = await exportForTeam(db, outDir, { userId: "aman" });
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const contents = data.memories.map((m: { content: string }) => m.content);
    expect(contents).not.toContain("private pref");
  });

  it("respects minConfidence", async () => {
    seed();
    const { file } = await exportForTeam(db, outDir, { userId: "aman", minConfidence: 0.85 });
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const m of data.memories) {
      expect(m.confidence).toBeGreaterThanOrEqual(0.85);
    }
  });

  it("respects includeTypes", async () => {
    seed();
    const { file } = await exportForTeam(db, outDir, {
      userId: "aman",
      includeTypes: ["correction"],
    });
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const m of data.memories) {
      expect(m.type).toBe("correction");
    }
  });

  it("records userId and version in the export", async () => {
    seed();
    const { file } = await exportForTeam(db, outDir, { userId: "aman" });
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(data.userId).toBe("aman");
    expect(data.version).toBe(1);
    expect(typeof data.exportedAt).toBe("number");
  });
});

describe("importFromTeam", () => {
  let outDir: string;

  beforeEach(() => { outDir = makeTempDir("import"); });
  afterEach(() => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {} });

  async function makeExport(): Promise<string> {
    db.insertMemory({ content: "a shared decision", type: MemoryType.DECISION, tags: ["arch"], confidence: 0.9, source: "test", scope: "global", embedding: null });
    const { file } = await exportForTeam(db, outDir, { userId: "alice" });
    // Wipe the local DB so we're importing into an empty one
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + "-wal"); } catch {}
    try { fs.unlinkSync(dbPath + "-shm"); } catch {}
    db = createDatabase(dbPath);
    return file;
  }

  it("imports memories from a valid export file", async () => {
    const file = await makeExport();
    const result = await importFromTeam(db, file);
    expect(result.imported).toBe(1);
    expect(result.from).toBe("alice");
  });

  it("lowers confidence by 0.1 for imported memories (second-hand)", async () => {
    const file = await makeExport();
    await importFromTeam(db, file);
    const all = db.getAll();
    expect(all[0].confidence).toBeCloseTo(0.8, 5); // 0.9 - 0.1
  });

  it("floors lowered confidence at 0.1", async () => {
    db.insertMemory({ content: "very unsure", type: MemoryType.FACT, tags: [], confidence: 0.15, source: "test", scope: "global", embedding: null });
    const { file } = await exportForTeam(db, outDir, { userId: "bob", minConfidence: 0 });
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + "-wal"); } catch {}
    try { fs.unlinkSync(dbPath + "-shm"); } catch {}
    db = createDatabase(dbPath);
    await importFromTeam(db, file);
    const all = db.getAll();
    expect(all[0].confidence).toBeGreaterThanOrEqual(0.1);
  });

  it("tags imported memories with team-sync and from:userId", async () => {
    const file = await makeExport();
    await importFromTeam(db, file);
    const all = db.getAll();
    expect(all[0].tags).toContain("team-sync");
    expect(all[0].tags).toContain("from:alice");
  });

  it("is idempotent via content hash", async () => {
    const file = await makeExport();
    const first = await importFromTeam(db, file);
    expect(first.imported).toBe(1);
    const second = await importFromTeam(db, file);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("dryRun does not insert", async () => {
    const file = await makeExport();
    const result = await importFromTeam(db, file, { dryRun: true });
    expect(result.imported).toBe(1);
    expect(db.getStats().total).toBe(0);
  });
});

describe("generateCopilotInstructions", () => {
  it("returns markdown with all zeros for an empty DB", () => {
    const { markdown, counts } = generateCopilotInstructions(db);
    expect(markdown).toContain("# Project Memory");
    expect(counts.corrections).toBe(0);
    expect(counts.decisions).toBe(0);
  });

  it("includes a 'Corrections (MUST follow)' section when corrections exist", () => {
    db.insertMemory({ content: "never commit secrets", type: MemoryType.CORRECTION, tags: [], confidence: 1.0, source: "test", scope: "global", embedding: null });
    const { markdown, counts } = generateCopilotInstructions(db);
    expect(markdown).toContain("## Corrections");
    expect(markdown).toContain("never commit secrets");
    expect(counts.corrections).toBe(1);
  });

  it("filters out memories below minConfidence", () => {
    db.insertMemory({ content: "unsure", type: MemoryType.FACT, tags: [], confidence: 0.3, source: "test", scope: "global", embedding: null });
    const { markdown } = generateCopilotInstructions(db, { minConfidence: 0.5 });
    expect(markdown).not.toContain("unsure");
  });

  it("respects includeTypes filter", () => {
    db.insertMemory({ content: "a correction", type: MemoryType.CORRECTION, tags: [], confidence: 1.0, source: "test", scope: "global", embedding: null });
    db.insertMemory({ content: "a decision", type: MemoryType.DECISION, tags: [], confidence: 0.9, source: "test", scope: "global", embedding: null });
    const { markdown } = generateCopilotInstructions(db, { includeTypes: ["correction"] });
    expect(markdown).toContain("a correction");
    expect(markdown).not.toContain("a decision");
  });

  it("sorts corrections by confidence descending", () => {
    db.insertMemory({ content: "lowest correction", type: MemoryType.CORRECTION, tags: [], confidence: 0.6, source: "test", scope: "global", embedding: null });
    db.insertMemory({ content: "highest correction", type: MemoryType.CORRECTION, tags: [], confidence: 1.0, source: "test", scope: "global", embedding: null });
    db.insertMemory({ content: "middle correction", type: MemoryType.CORRECTION, tags: [], confidence: 0.8, source: "test", scope: "global", embedding: null });
    const { markdown } = generateCopilotInstructions(db);
    const hi = markdown.indexOf("highest");
    const mid = markdown.indexOf("middle");
    const lo = markdown.indexOf("lowest");
    expect(hi).toBeLessThan(mid);
    expect(mid).toBeLessThan(lo);
  });

  it("excludes expired memories (validUntil in the past)", () => {
    db.insertMemory({ content: "old fact", type: MemoryType.FACT, tags: [], confidence: 0.9, source: "test", scope: "global", embedding: null, validUntil: Date.now() - 1000 });
    const { markdown } = generateCopilotInstructions(db);
    expect(markdown).not.toContain("old fact");
  });
});

describe("syncToCopilot", () => {
  let projDir: string;

  beforeEach(() => { projDir = makeTempDir("proj"); });
  afterEach(() => { try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {} });

  it("writes .github/copilot-instructions.md when none exists", () => {
    db.insertMemory({ content: "a rule", type: MemoryType.CORRECTION, tags: [], confidence: 1.0, source: "test", scope: "global", embedding: null });
    const result = syncToCopilot(db, { projectDir: projDir });
    expect(result.dryRun).toBe(false);
    expect(fs.existsSync(result.file)).toBe(true);
    const content = fs.readFileSync(result.file, "utf-8");
    expect(content).toContain("amem:start");
    expect(content).toContain("amem:end");
    expect(content).toContain("a rule");
  });

  it("dryRun does not create the file", () => {
    const result = syncToCopilot(db, { projectDir: projDir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(result.file)).toBe(false);
  });

  it("replaces an existing amem section while preserving other content", () => {
    const githubDir = path.join(projDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    const filePath = path.join(githubDir, "copilot-instructions.md");
    const existing = "# Custom Instructions\n\nUse TypeScript.\n\n<!-- amem:start -->\nOLD AMEM CONTENT\n<!-- amem:end -->\n\nMore instructions.\n";
    fs.writeFileSync(filePath, existing);

    db.insertMemory({ content: "new amem rule", type: MemoryType.CORRECTION, tags: [], confidence: 1.0, source: "test", scope: "global", embedding: null });
    syncToCopilot(db, { projectDir: projDir });

    const after = fs.readFileSync(filePath, "utf-8");
    expect(after).toContain("Custom Instructions");
    expect(after).toContain("Use TypeScript");
    expect(after).toContain("More instructions");
    expect(after).toContain("new amem rule");
    expect(after).not.toContain("OLD AMEM CONTENT");
  });

  it("appends an amem section to an existing file that has no amem markers", () => {
    const githubDir = path.join(projDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    const filePath = path.join(githubDir, "copilot-instructions.md");
    fs.writeFileSync(filePath, "# Existing content only\n");

    db.insertMemory({ content: "appended rule", type: MemoryType.CORRECTION, tags: [], confidence: 1.0, source: "test", scope: "global", embedding: null });
    syncToCopilot(db, { projectDir: projDir });

    const after = fs.readFileSync(filePath, "utf-8");
    expect(after).toContain("Existing content only");
    expect(after).toContain("appended rule");
    expect(after).toContain("<!-- amem:start -->");
  });

  it("creates .github/ directory if it doesn't exist", () => {
    db.insertMemory({ content: "x", type: MemoryType.CORRECTION, tags: [], confidence: 1.0, source: "test", scope: "global", embedding: null });
    syncToCopilot(db, { projectDir: projDir });
    expect(fs.existsSync(path.join(projDir, ".github"))).toBe(true);
  });

  it("returns counts matching what was written", () => {
    db.insertMemory({ content: "c1", type: MemoryType.CORRECTION, tags: [], confidence: 1.0, source: "test", scope: "global", embedding: null });
    db.insertMemory({ content: "d1", type: MemoryType.DECISION, tags: [], confidence: 0.9, source: "test", scope: "global", embedding: null });
    const result = syncToCopilot(db, { projectDir: projDir });
    expect(result.sections.corrections).toBe(1);
    expect(result.sections.decisions).toBe(1);
    expect(result.memoriesExported).toBe(2);
  });
});
