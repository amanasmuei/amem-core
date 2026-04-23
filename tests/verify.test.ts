import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractPaths, verifyTopology } from "../src/verify.js";
import { createDatabase, type AmemDatabase } from "../src/database.js";

describe("extractPaths", () => {
  it("extracts well-known source directory paths", () => {
    const paths = extractPaths("Auth module lives in src/auth/login.ts");
    expect(paths).toContain("src/auth/login.ts");
  });

  it("extracts paths by known source extensions", () => {
    const paths = extractPaths("The config is at app.config.json");
    expect(paths).toContain("app.config.json");
  });

  it("deduplicates repeated paths", () => {
    const paths = extractPaths("src/a.ts and src/a.ts again");
    expect(paths).toEqual(["src/a.ts"]);
  });

  it("splits on commas to handle lists", () => {
    const paths = extractPaths("Handlers live in src/h/one.ts, src/h/two.ts");
    expect(paths).toContain("src/h/one.ts");
    expect(paths).toContain("src/h/two.ts");
  });

  it("strips trailing sentence punctuation", () => {
    const paths = extractPaths("Find it in src/auth/.");
    expect(paths).toContain("src/auth/");
  });

  it("ignores URLs", () => {
    const paths = extractPaths("See https://example.com/docs/index.html for more");
    // Nothing matched — https://... is filtered before pattern checks
    expect(paths).toEqual([]);
  });

  it("ignores numeric ratios", () => {
    const paths = extractPaths("Coverage is 100/200 currently");
    expect(paths).toEqual([]);
  });

  it("ignores prose without path-like tokens", () => {
    const paths = extractPaths("Auth and config are handled separately");
    expect(paths).toEqual([]);
  });

  it("strips surrounding backticks and quotes", () => {
    const paths = extractPaths("The entrypoint is `src/index.ts` in the repo");
    expect(paths).toContain("src/index.ts");
  });
});

describe("verifyTopology", () => {
  let db: AmemDatabase;
  let tmpRoot: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amem-verify-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function insertTopology(content: string) {
    return db.insertMemory({
      content,
      type: "topology",
      tags: [],
      confidence: 0.8,
      source: "test",
      embedding: null,
      scope: "global",
    });
  }

  function touchFile(rel: string) {
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "");
  }

  function touchDir(rel: string) {
    fs.mkdirSync(path.join(tmpRoot, rel), { recursive: true });
  }

  it("marks memories whose referenced paths exist as verified", () => {
    touchFile("src/auth/login.ts");
    const id = insertTopology("Auth lives at src/auth/login.ts");

    const result = verifyTopology(db, { root: tmpRoot });
    expect(result.checked).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.stale).toBe(0);
    expect(result.items[0]).toMatchObject({
      memoryId: id,
      status: "verified",
      missingPaths: [],
    });
  });

  it("marks memories whose referenced paths are missing as stale", () => {
    // No file created — the referenced path does not exist under root
    insertTopology("Auth lives at src/auth/login.ts");

    const result = verifyTopology(db, { root: tmpRoot });
    expect(result.stale).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.items[0].status).toBe("stale");
    expect(result.items[0].missingPaths).toContain("src/auth/login.ts");
  });

  it("marks memories with no extractable paths as no-paths", () => {
    insertTopology("auth module exists somewhere in this codebase");

    const result = verifyTopology(db, { root: tmpRoot });
    expect(result.noPaths).toBe(1);
    expect(result.items[0].status).toBe("no-paths");
    expect(result.items[0].paths).toEqual([]);
  });

  it("does not mutate memories in read-only mode (default)", () => {
    insertTopology("Auth lives at src/missing/file.ts");

    const before = db.searchByType("topology")[0];
    expect(before.validUntil).toBeNull();

    const result = verifyTopology(db, { root: tmpRoot });
    expect(result.expired).toBe(0);

    const after = db.searchByType("topology")[0];
    expect(after.validUntil).toBeNull();
  });

  it("expires stale memories when expireStale is true", () => {
    const id = insertTopology("Auth lives at src/missing/file.ts");

    const result = verifyTopology(db, { root: tmpRoot, expireStale: true });
    expect(result.stale).toBe(1);
    expect(result.expired).toBe(1);

    const after = db.getById(id);
    expect(after).not.toBeNull();
    expect(after!.validUntil).not.toBeNull();
  });

  it("never expires already-expired memories a second time", () => {
    const id = insertTopology("Auth lives at src/missing/file.ts");
    db.expireMemory(id, 12345); // pre-expire with a sentinel timestamp

    const result = verifyTopology(db, { root: tmpRoot, expireStale: true });
    expect(result.expired).toBe(0);

    const after = db.getById(id);
    // Timestamp should not have changed — we skip rows whose validUntil is non-null.
    expect(after!.validUntil).toBe(12345);
  });

  it("handles a mix of verified, stale, and no-paths memories", () => {
    touchFile("src/keep.ts");
    insertTopology("Keep lives at src/keep.ts");
    insertTopology("Gone lives at src/gone.ts");
    insertTopology("Something something nothing specific here");

    const result = verifyTopology(db, { root: tmpRoot });
    expect(result.checked).toBe(3);
    expect(result.verified).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.noPaths).toBe(1);
  });

  it("only considers topology memories — other types are ignored", () => {
    touchFile("src/keep.ts");

    db.insertMemory({
      content: "src/does-not-exist.ts matters here",
      type: "fact",
      tags: [],
      confidence: 0.8,
      source: "t",
      embedding: null,
      scope: "global",
    });
    insertTopology("Keep lives at src/keep.ts");

    const result = verifyTopology(db, { root: tmpRoot });
    // Only the topology row is inspected even though the fact mentions a path
    expect(result.checked).toBe(1);
    expect(result.verified).toBe(1);
  });

  it("verifies against directories, not just files", () => {
    touchDir("src/auth");
    insertTopology("Auth module sits in src/auth/");

    const result = verifyTopology(db, { root: tmpRoot });
    expect(result.verified).toBe(1);
  });

  it("respects the limit option", () => {
    for (let i = 0; i < 5; i++) {
      insertTopology(`file ${i} lives at src/f${i}.ts`);
    }
    const result = verifyTopology(db, { root: tmpRoot, limit: 2 });
    expect(result.checked).toBe(2);
  });

  it("returns zero-filled result when no topology memories exist", () => {
    const result = verifyTopology(db, { root: tmpRoot });
    expect(result).toEqual({
      checked: 0,
      verified: 0,
      stale: 0,
      noPaths: 0,
      expired: 0,
      items: [],
    });
  });
});
