import fs from "node:fs";
import path from "node:path";
import type { Memory, MemoryTypeValue } from "./memory.js";
import type { AmemDatabase } from "./database.js";

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

// ── MirrorEngine ────────────────────────────────────────────────────────────

export type TierValue = "core" | "working" | "archival";

const DEFAULT_TIERS: TierValue[] = ["core", "working", "archival"];

export interface MirrorOptions {
  dir: string;
  tiers?: TierValue[];
  /**
   * Whether `fullMirror()` should regenerate `INDEX.md`. Defaults to true.
   * `exportSnapshot()` always writes INDEX.md regardless of this flag — a
   * snapshot is a self-contained artifact.
   */
  includeIndex?: boolean;
  onError?: (err: Error, context: string) => void;
}

export interface MirrorStatus {
  dir: string;
  fileCount: number;
  lastWriteAt: number | null;
  healthy: boolean;
}

export interface MirrorResult {
  written: number;
  skipped: number;
  errors: string[];
}

/**
 * Writes per-memory markdown files into a mirror directory. Intended to be
 * driven by memory lifecycle hooks (save/update/delete) in the calling host.
 *
 * Filename is `<dir>/<memory.type>/<memory.id>.md`. Writes are atomic
 * (write-to-tmp + rename). All I/O is best-effort: failures are reported via
 * the `onError` callback and never propagate up to the caller.
 */
export class MirrorEngine {
  private readonly dir: string;
  private readonly tiers: TierValue[];
  private readonly includeIndex: boolean;
  private readonly onError: (err: Error, context: string) => void;
  private lastWriteAt: number | null = null;

  // db is read-only from the engine's perspective — only the bulk paths
  // (`fullMirror` / `exportSnapshot`) consult it. Per-memory event hooks
  // (`onSave` / `onUpdate` / `onDelete`) are driven by the caller and do
  // not touch the DB.
  constructor(
    protected readonly db: AmemDatabase,
    opts: MirrorOptions,
  ) {
    this.dir = opts.dir;
    this.tiers = opts.tiers ?? DEFAULT_TIERS;
    this.includeIndex = opts.includeIndex ?? true;
    this.onError =
      opts.onError ??
      ((err, ctx) => {
        // eslint-disable-next-line no-console
        console.warn(`[amem-mirror] ${ctx}: ${err.message}`);
      });
  }

  async onSave(memory: Memory): Promise<void> {
    if (!this.tiers.includes(memory.tier)) return;
    try {
      this.writeMemoryFileTo(this.dir, memory);
      this.lastWriteAt = Date.now();
    } catch (err) {
      this.onError(err as Error, `onSave(${memory.id})`);
    }
  }

  /**
   * Rebuild the mirror from the DB. Used for first-run bootstrap, recovery
   * after external deletes, or explicit `/memory mirror rebuild` user actions.
   * Honors the tier filter. Regenerates INDEX.md iff `includeIndex` is true.
   * Best-effort: per-memory errors are collected into the result and never
   * thrown.
   */
  async fullMirror(): Promise<MirrorResult> {
    return this.writeAllTo(this.dir, this.includeIndex);
  }

  /**
   * One-shot dump to an arbitrary directory — for snapshots, git archives,
   * scp targets, encrypted backups. The engine's live mirror dir is NEVER
   * touched by this call. Always writes INDEX.md so the snapshot is a
   * self-contained artifact.
   */
  async exportSnapshot(toDir: string): Promise<MirrorResult> {
    return this.writeAllTo(toDir, true);
  }

  async onUpdate(memory: Memory): Promise<void> {
    // Updates use the same write path — filename is stable (memory.id).
    return this.onSave(memory);
  }

  async onDelete(memoryId: string, memoryType: MemoryTypeValue): Promise<void> {
    try {
      const filePath = this.fileFor(memoryId, memoryType);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.lastWriteAt = Date.now();
      }
    } catch (err) {
      this.onError(err as Error, `onDelete(${memoryId})`);
    }
  }

  status(): MirrorStatus {
    let fileCount = 0;
    let healthy = true;
    try {
      if (fs.existsSync(this.dir)) {
        for (const sub of fs.readdirSync(this.dir)) {
          const subPath = path.join(this.dir, sub);
          if (fs.statSync(subPath).isDirectory()) {
            fileCount += fs
              .readdirSync(subPath)
              .filter((f) => f.endsWith(".md")).length;
          }
        }
      }
    } catch {
      healthy = false;
    }
    return { dir: this.dir, fileCount, lastWriteAt: this.lastWriteAt, healthy };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private fileFor(memoryId: string, memoryType: MemoryTypeValue): string {
    return path.join(this.dir, memoryType, `${memoryId}.md`);
  }

  /**
   * Atomic write to an arbitrary target dir. Single implementation of the
   * tmp-then-rename pattern, shared by `onSave` (writes to `this.dir`) and by
   * the bulk paths (`fullMirror` writes to `this.dir`, `exportSnapshot`
   * writes to a caller-supplied dir). On any failure the tmp is cleaned up
   * so we never leak partial state. Throws on unrecoverable I/O errors —
   * callers translate to onError or collect into `MirrorResult.errors`.
   */
  private writeMemoryFileTo(targetDir: string, memory: Memory): void {
    const target = path.join(targetDir, memory.type, `${memory.id}.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    const content = serializeMemoryFile(memory);
    try {
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, target);
    } catch (err) {
      // Best-effort tmp cleanup; don't mask the real error.
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // swallow — the original error is what matters
      }
      throw err;
    }
  }

  /**
   * Shared bulk-write loop for `fullMirror` / `exportSnapshot`. Iterates the
   * full DB, skips tier-filtered memories, aggregates per-memory errors into
   * the result, and optionally regenerates INDEX.md from the *kept* set.
   */
  private async writeAllTo(
    targetDir: string,
    writeIndex: boolean,
  ): Promise<MirrorResult> {
    const result: MirrorResult = { written: 0, skipped: 0, errors: [] };
    const memories = this.db.getAll();
    const kept: Memory[] = [];
    for (const mem of memories) {
      if (!this.tiers.includes(mem.tier as TierValue)) {
        result.skipped++;
        continue;
      }
      try {
        this.writeMemoryFileTo(targetDir, mem);
        kept.push(mem);
        result.written++;
      } catch (err) {
        result.errors.push(`${mem.id}: ${(err as Error).message}`);
      }
    }
    if (writeIndex) {
      try {
        this.writeIndexFile(targetDir, kept);
      } catch (err) {
        result.errors.push(`INDEX.md: ${(err as Error).message}`);
      }
    }
    this.lastWriteAt = Date.now();
    return result;
  }

  /**
   * Write the human-facing index. Grouped by memory type; entries within a
   * group sorted by `createdAt` desc, breaking ties by `id` so output is
   * deterministic across runs. Header carries a "do not edit" comment —
   * INDEX.md is derived from the per-memory files, which are the source of
   * truth.
   */
  private writeIndexFile(targetDir: string, memories: Memory[]): void {
    fs.mkdirSync(targetDir, { recursive: true });
    const byType = new Map<string, Memory[]>();
    for (const m of memories) {
      const bucket = byType.get(m.type);
      if (bucket) bucket.push(m);
      else byType.set(m.type, [m]);
    }

    const lines: string[] = [
      "<!-- Auto-generated by amem-core/mirror.ts — do not edit -->",
      "# Memory Index",
      "",
      `_Last generated: ${new Date().toISOString()} — ${memories.length} memories_`,
      "",
    ];

    for (const [type, mems] of [...byType.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`## ${type}`);
      lines.push("");
      const sorted = [...mems].sort((a, b) => {
        if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
        return a.id.localeCompare(b.id);
      });
      for (const m of sorted) {
        const firstLine = m.content.split("\n")[0] ?? "";
        const slug = slugifyName(firstLine).slice(0, 60);
        const label = slug && slug !== "memory" ? slug : m.id;
        const preview = firstLine.slice(0, 100);
        lines.push(`- [${label}](${type}/${m.id}.md) — ${preview}`);
      }
      lines.push("");
    }

    const tmp = path.join(targetDir, "INDEX.md.tmp");
    const final = path.join(targetDir, "INDEX.md");
    try {
      fs.writeFileSync(tmp, lines.join("\n"), "utf-8");
      fs.renameSync(tmp, final);
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // swallow
      }
      throw err;
    }
  }
}
