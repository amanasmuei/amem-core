import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { z } from "zod";

// ── Authoritative config schema ──────────────────────────
//
// This Zod schema is the single source of truth for AmemConfig.
// The TypeScript interface is derived via z.infer.
// Used by:
//   - loadConfig / saveConfig (runtime validation)
//   - amem's memory_config MCP tool (whitelist validation)
//
// When adding or changing fields: update this schema, the default below,
// and nothing else — all consumers pick up the change automatically.

/**
 * Keys that require an amem server restart to fully take effect.
 * memory_config surfaces these as a warning when changed.
 */
export const RESTART_REQUIRED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "embeddingModel",
  "embeddingCacheSize",
]);

/**
 * Keys that would corrupt existing data if changed.
 * memory_config blocks these unless force:true is passed.
 */
export const DANGEROUS_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "embeddingDimensions",
]);

export const AmemConfigSchema = z.object({
  // Embedding
  embeddingModel: z.string().min(1),
  embeddingDimensions: z.number().int().positive(),
  embeddingCacheSize: z.number().int().nonnegative(),

  // Retrieval
  retrieval: z.object({
    semanticWeight: z.number().min(0).max(1),
    ftsWeight: z.number().min(0).max(1),
    graphWeight: z.number().min(0).max(1),
    temporalWeight: z.number().min(0).max(1),
    maxCandidates: z.number().int().positive(),
    rerankerEnabled: z.boolean(),
    rerankerTopK: z.number().int().positive(),
  }).strict(),

  // Consolidation defaults
  consolidation: z.object({
    maxStaleDays: z.number().int().nonnegative(),
    minConfidence: z.number().min(0).max(1),
    minAccessCount: z.number().int().nonnegative(),
    enableDecay: z.boolean(),
    decayFactor: z.number().min(0).max(1),
  }).strict(),

  // Privacy
  privacy: z.object({
    enablePrivateTags: z.boolean(),
    redactPatterns: z.array(
      z.string().refine(
        (pat) => { try { new RegExp(pat); return true; } catch { return false; } },
        { message: "Invalid regex pattern" },
      ),
    ),
  }).strict(),

  // Hooks (automatic memory capture)
  hooks: z.object({
    enabled: z.boolean(),
    captureToolUse: z.boolean(),
    captureSessionEnd: z.boolean(),
    autoExtractInterval: z.number().int().nonnegative(),
  }).strict(),

  // Memory tiers
  tiers: z.object({
    coreMaxTokens: z.number().int().positive(),
    workingMaxTokens: z.number().int().positive(),
  }).strict(),

  // Team sync (future)
  team: z.object({
    enabled: z.boolean(),
    syncPath: z.string().nullable(),
    syncInterval: z.number().int().positive(),
    userId: z.string().nullable(),
  }).strict(),
}).strict();

export type AmemConfig = z.infer<typeof AmemConfigSchema>;

const DEFAULT_CONFIG: AmemConfig = {
  embeddingModel: "Xenova/bge-small-en-v1.5",
  embeddingDimensions: 384,
  embeddingCacheSize: 128,

  retrieval: {
    semanticWeight: 0.4,
    ftsWeight: 0.3,
    graphWeight: 0.15,
    temporalWeight: 0.15,
    maxCandidates: 50000,
    rerankerEnabled: false,
    rerankerTopK: 20,
  },

  consolidation: {
    maxStaleDays: 60,
    minConfidence: 0.3,
    minAccessCount: 2,
    enableDecay: false,
    decayFactor: 0.95,
  },

  privacy: {
    enablePrivateTags: true,
    redactPatterns: [
      "(?:api[_-]?key|secret|token|password|passwd|credential)\\s*[:=]\\s*['\"]?[A-Za-z0-9_\\-\\.]{8,}",
    ],
  },

  hooks: {
    enabled: true,
    captureToolUse: true,
    captureSessionEnd: true,
    autoExtractInterval: 0,
  },

  tiers: {
    coreMaxTokens: 500,
    workingMaxTokens: 2000,
  },

  team: {
    enabled: false,
    syncPath: null,
    syncInterval: 30,
    userId: null,
  },
};

let loadedConfig: AmemConfig | null = null;

export function getConfigPath(): string {
  const amemDir = process.env.AMEM_DIR || path.join(os.homedir(), ".amem");
  return path.join(amemDir, "config.json");
}

export function loadConfig(): AmemConfig {
  if (loadedConfig) return loadedConfig;

  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8").trim();
      if (raw) {
        const userConfig = JSON.parse(raw) as Partial<AmemConfig>;
        loadedConfig = deepMerge(DEFAULT_CONFIG, userConfig) as AmemConfig;
        return loadedConfig;
      }
    }
  } catch (error) {
    console.error("[amem] Failed to load config, using defaults:", error instanceof Error ? error.message : String(error));
  }

  loadedConfig = structuredClone(DEFAULT_CONFIG);
  return loadedConfig;
}

export function saveConfig(config: Partial<AmemConfig>): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  // Merge with existing config
  const existing = loadConfig();
  const merged = deepMerge(existing, config) as AmemConfig;
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
  loadedConfig = merged;
}

export function getDefaultConfig(): AmemConfig {
  // Deep clone so callers can safely mutate nested fields (e.g. privacy.redactPatterns)
  // without leaking into the shared DEFAULT_CONFIG.
  return structuredClone(DEFAULT_CONFIG);
}

export function resetConfigCache(): void {
  loadedConfig = null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (val !== undefined && val !== null) {
      if (typeof val === "object" && !Array.isArray(val) && typeof result[key] === "object" && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key], val);
      } else {
        result[key] = val;
      }
    }
  }
  return result;
}

// ── Privacy helpers ─────────────────────────────────────

/**
 * Strip <private>...</private> tags and redact patterns from content before storage.
 * Returns cleaned content, or null if the entire content is private.
 */
export function sanitizeContent(content: string, config?: AmemConfig): string | null {
  const cfg = config ?? loadConfig();

  if (!cfg.privacy.enablePrivateTags) return content;

  // Strip <private>...</private> blocks
  let cleaned = content.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");

  // If entire content was private, return null (don't store)
  if (cleaned.trim() === "[REDACTED]" || cleaned.trim() === "") return null;

  // Apply regex redaction patterns
  for (const pattern of cfg.privacy.redactPatterns) {
    try {
      const regex = new RegExp(pattern, "g");
      cleaned = cleaned.replace(regex, "[REDACTED]");
    } catch {
      // Invalid regex pattern — skip
    }
  }

  return cleaned;
}
