import path from "node:path";
import fs from "node:fs";
import type { AmemDatabase } from "./database.js";

/**
 * Topology memories ("Auth module is in src/auth/", "Config lives at
 * config/app.ts") go stale silently when code moves. `verifyTopology`
 * extracts path references from each topology memory's content and
 * checks whether they still exist on disk.
 *
 * The default mode is read-only: stale memories are reported but not
 * mutated. Pass `expireStale: true` to set `valid_until = now` on stale
 * rows, which removes them from default recall results without deleting
 * history (a version snapshot is written at the same time).
 *
 * Deliberately scope-limited:
 *   - Only `type === "topology"` memories are inspected.
 *   - No network access — filesystem existence checks only.
 *   - Path extraction is conservative: well-known source dirs or tokens
 *     with known source-file extensions. False negatives beat false
 *     positives here (we'd rather leave a memory alone than expire it
 *     because of an ambiguous path reference).
 */
export interface VerifyOptions {
  /** Root to resolve relative paths against. Default: `process.cwd()`. */
  root?: string;
  /** Max topology memories to check per run. Default: 1000. */
  limit?: number;
  /** When true, `db.expireMemory()` is called on stale rows. Default: false. */
  expireStale?: boolean;
}

export type VerifyStatus = "verified" | "stale" | "no-paths";

export interface VerifyItem {
  memoryId: string;
  content: string;
  paths: string[];
  missingPaths: string[];
  status: VerifyStatus;
}

export interface VerifyResult {
  /** Total topology memories inspected this run. */
  checked: number;
  /** All referenced paths resolved on disk. */
  verified: number;
  /** At least one referenced path is missing. */
  stale: number;
  /** No path-like token could be extracted from the content. */
  noPaths: number;
  /** Stale memories that were expired (0 unless `expireStale: true`). */
  expired: number;
  items: VerifyItem[];
}

// Well-known top-level source directories. A token starting with one of
// these is almost always a real path reference. Extend with care — every
// addition here risks false positives on prose.
const SOURCE_DIR_PREFIXES = [
  "src/", "lib/", "app/", "pkg/", "packages/", "tests/", "test/",
  "spec/", "scripts/", "bin/", "config/", "docs/", "internal/",
  "cmd/", "pages/", "components/", "services/", "utils/", "modules/",
];

// File extensions that imply the token is a source/config file path,
// even without a well-known directory prefix.
const SOURCE_FILE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "rb", "java", "kt", "swift", "cpp", "c", "h", "hpp",
  "json", "yml", "yaml", "toml", "xml", "ini", "env",
  "md", "mdx", "rst",
  "sql", "sh", "bash", "zsh",
  "css", "scss", "less", "html", "vue", "svelte",
];

// Strip trailing punctuation that commonly appears in prose next to paths.
function trimPunctuation(token: string): string {
  return token.replace(/^[`'"()\[\]<>]+/, "").replace(/[`'"()\[\]<>,.;:!?]+$/, "");
}

function looksLikeUrl(token: string): boolean {
  return /^(?:https?:|ftp:|git@|ssh:|mailto:)/i.test(token);
}

function looksLikePath(token: string): boolean {
  if (token.length < 3) return false;
  if (looksLikeUrl(token)) return false;
  // Reject pure numeric ratios like "100/200" or "1/2".
  if (/^[\d./]+$/.test(token)) return false;

  const lower = token.toLowerCase();
  if (SOURCE_DIR_PREFIXES.some(prefix => lower.startsWith(prefix))) return true;

  const dotIdx = token.lastIndexOf(".");
  if (dotIdx > 0 && dotIdx < token.length - 1) {
    const ext = token.slice(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]+$/, "");
    if (SOURCE_FILE_EXTENSIONS.includes(ext)) return true;
  }

  return false;
}

/**
 * Extract path-like tokens from a topology memory's content. Returns a
 * deduplicated, trimmed list. Never includes URLs or numeric fractions.
 */
export function extractPaths(content: string): string[] {
  // Tokenize on whitespace and sentence-ending punctuation. We do NOT
  // split on `/` — paths contain slashes. We do split on commas so
  // "X is in src/a, src/b" yields two paths, not one.
  const rawTokens = content.split(/[\s,]+/);
  const out = new Set<string>();
  for (const raw of rawTokens) {
    const trimmed = trimPunctuation(raw);
    if (looksLikePath(trimmed)) {
      out.add(trimmed);
    }
  }
  return [...out];
}

/**
 * Verify topology memories against the filesystem.
 *
 * Read-only by default. With `expireStale: true`, stale memories are
 * expired (their `valid_until` is set to now) so they stop surfacing in
 * recall. A version snapshot is written before expiration so the
 * original content is never lost.
 */
export function verifyTopology(
  db: AmemDatabase,
  opts: VerifyOptions = {},
): VerifyResult {
  const root = opts.root ?? process.cwd();
  const limit = opts.limit ?? 1000;
  const expireStale = opts.expireStale ?? false;

  const topologies = db.searchByType("topology").slice(0, limit);

  const items: VerifyItem[] = [];
  let verified = 0;
  let stale = 0;
  let noPaths = 0;
  let expired = 0;

  for (const mem of topologies) {
    const paths = extractPaths(mem.content);

    if (paths.length === 0) {
      items.push({
        memoryId: mem.id,
        content: mem.content,
        paths: [],
        missingPaths: [],
        status: "no-paths",
      });
      noPaths++;
      continue;
    }

    const missingPaths = paths.filter(p => {
      const resolved = path.isAbsolute(p) ? p : path.join(root, p);
      try {
        return !fs.existsSync(resolved);
      } catch {
        // Treat unreachable paths (e.g. permission denied) as missing
        // so they surface for review rather than silently passing.
        return true;
      }
    });

    if (missingPaths.length > 0) {
      stale++;
      items.push({
        memoryId: mem.id,
        content: mem.content,
        paths,
        missingPaths,
        status: "stale",
      });
      if (expireStale && mem.validUntil === null) {
        db.snapshotVersion(
          mem.id,
          `topology stale: missing ${missingPaths.join(", ")}`,
        );
        db.expireMemory(mem.id);
        expired++;
      }
    } else {
      verified++;
      items.push({
        memoryId: mem.id,
        content: mem.content,
        paths,
        missingPaths: [],
        status: "verified",
      });
    }
  }

  return {
    checked: topologies.length,
    verified,
    stale,
    noPaths,
    expired,
    items,
  };
}
