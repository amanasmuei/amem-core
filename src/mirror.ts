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
  /** Reserved for Task 1.3 (INDEX.md generation). Currently unused by onSave/onDelete. */
  includeIndex?: boolean;
  onError?: (err: Error, context: string) => void;
}

export interface MirrorStatus {
  dir: string;
  fileCount: number;
  lastWriteAt: number | null;
  healthy: boolean;
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
  // Stored but unused in Task 1.2 — Task 1.3 will consult it in fullMirror().
  private readonly includeIndex: boolean;
  private readonly onError: (err: Error, context: string) => void;
  private lastWriteAt: number | null = null;

  // db is retained for Task 1.3 (fullMirror / exportSnapshot will read from
  // it). onSave/onUpdate/onDelete do not touch it.
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
      this.writeMemoryFile(memory);
      this.lastWriteAt = Date.now();
    } catch (err) {
      this.onError(err as Error, `onSave(${memory.id})`);
    }
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
   * Atomic write: serialize to a sibling `.tmp` file, then rename into place.
   * On any failure the tmp is cleaned up so we never leak partial state.
   * Throws on unrecoverable I/O errors — callers (onSave) translate to onError.
   */
  private writeMemoryFile(memory: Memory): void {
    const target = this.fileFor(memory.id, memory.type);
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
}
