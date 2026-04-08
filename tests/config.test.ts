import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  type AmemConfig,
  AmemConfigSchema,
  RESTART_REQUIRED_CONFIG_KEYS,
  DANGEROUS_CONFIG_KEYS,
  loadConfig,
  saveConfig,
  getDefaultConfig,
  getConfigPath,
  resetConfigCache,
  sanitizeContent,
} from "../src/config.js";

// Each test runs in an isolated AMEM_DIR so on-disk state is deterministic
// and the module-level cache in config.ts is reset before every assertion.

function withIsolatedAmemDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amem-config-test-"));
  process.env.AMEM_DIR = dir;
  resetConfigCache();
  return dir;
}

function cleanup(dir: string): void {
  delete process.env.AMEM_DIR;
  resetConfigCache();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe("getConfigPath", () => {
  let dir: string;
  beforeEach(() => { dir = withIsolatedAmemDir(); });
  afterEach(() => cleanup(dir));

  it("uses AMEM_DIR env when set", () => {
    expect(getConfigPath()).toBe(path.join(dir, "config.json"));
  });

  it("falls back to ~/.amem/config.json when AMEM_DIR is unset", () => {
    delete process.env.AMEM_DIR;
    const p = getConfigPath();
    expect(p.endsWith(path.join(".amem", "config.json"))).toBe(true);
  });
});

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => { dir = withIsolatedAmemDir(); });
  afterEach(() => cleanup(dir));

  it("returns defaults when no config.json exists", () => {
    const config = loadConfig();
    expect(config.embeddingDimensions).toBe(384);
    expect(config.retrieval.rerankerEnabled).toBe(false);
    expect(config.privacy.enablePrivateTags).toBe(true);
    expect(config.hooks.enabled).toBe(true);
  });

  it("caches the loaded config across calls (same reference)", () => {
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });

  it("reloads after resetConfigCache", () => {
    const a = loadConfig();
    resetConfigCache();
    const b = loadConfig();
    expect(a).not.toBe(b);
    expect(a).toEqual(b); // same content, different object
  });

  it("merges a partial user config with defaults", () => {
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ retrieval: { rerankerEnabled: true } }),
    );
    resetConfigCache();
    const config = loadConfig();
    expect(config.retrieval.rerankerEnabled).toBe(true);
    // Other retrieval fields should still come from defaults
    expect(config.retrieval.semanticWeight).toBe(0.4);
    expect(config.retrieval.maxCandidates).toBe(50000);
  });

  it("falls back to defaults when config.json is malformed JSON", () => {
    fs.writeFileSync(path.join(dir, "config.json"), "{not valid json");
    resetConfigCache();
    const config = loadConfig();
    expect(config.embeddingDimensions).toBe(384);
  });

  it("treats an empty config.json as no config", () => {
    fs.writeFileSync(path.join(dir, "config.json"), "");
    resetConfigCache();
    const config = loadConfig();
    expect(config.retrieval.rerankerEnabled).toBe(false);
  });
});

describe("saveConfig", () => {
  let dir: string;
  beforeEach(() => { dir = withIsolatedAmemDir(); });
  afterEach(() => cleanup(dir));

  it("writes config.json and updates the cache", () => {
    saveConfig({ retrieval: { rerankerEnabled: true } } as Partial<AmemConfig>);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8"));
    expect(onDisk.retrieval.rerankerEnabled).toBe(true);
    expect(onDisk.retrieval.semanticWeight).toBe(0.4); // default preserved
    expect(loadConfig().retrieval.rerankerEnabled).toBe(true);
  });

  it("merges successive saves instead of overwriting", () => {
    saveConfig({ retrieval: { rerankerEnabled: true } } as Partial<AmemConfig>);
    saveConfig({ hooks: { enabled: false } } as Partial<AmemConfig>);
    const config = loadConfig();
    expect(config.retrieval.rerankerEnabled).toBe(true);
    expect(config.hooks.enabled).toBe(false);
  });

  it("creates the AMEM_DIR if it doesn't exist", () => {
    const newDir = path.join(dir, "nested", "amem");
    process.env.AMEM_DIR = newDir;
    resetConfigCache();
    saveConfig({ hooks: { captureToolUse: false } } as Partial<AmemConfig>);
    expect(fs.existsSync(path.join(newDir, "config.json"))).toBe(true);
  });
});

describe("getDefaultConfig", () => {
  it("returns a fresh object each call (no shared reference)", () => {
    const a = getDefaultConfig();
    const b = getDefaultConfig();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("matches AmemConfigSchema validation", () => {
    const defaults = getDefaultConfig();
    const parsed = AmemConfigSchema.safeParse(defaults);
    expect(parsed.success).toBe(true);
  });
});

describe("AmemConfigSchema validation", () => {
  it("accepts a valid full config", () => {
    const defaults = getDefaultConfig();
    expect(AmemConfigSchema.safeParse(defaults).success).toBe(true);
  });

  it("rejects negative embedding dimensions", () => {
    const bad = { ...getDefaultConfig(), embeddingDimensions: -1 };
    expect(AmemConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects retrieval weights outside [0, 1]", () => {
    const bad = getDefaultConfig();
    bad.retrieval.semanticWeight = 1.5;
    expect(AmemConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects negative retrieval weights", () => {
    const bad = getDefaultConfig();
    bad.retrieval.ftsWeight = -0.1;
    expect(AmemConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown top-level keys (strict mode)", () => {
    const bad = { ...getDefaultConfig(), someUnknownKey: true };
    expect(AmemConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown nested keys (strict mode)", () => {
    const bad = getDefaultConfig();
    (bad.retrieval as unknown as Record<string, unknown>).bogus = 1;
    expect(AmemConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects wrong types", () => {
    const bad = getDefaultConfig();
    (bad.hooks as unknown as Record<string, unknown>).enabled = "yes";
    expect(AmemConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-positive maxCandidates", () => {
    const bad = getDefaultConfig();
    bad.retrieval.maxCandidates = 0;
    expect(AmemConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects invalid regex in privacy.redactPatterns", () => {
    const bad = getDefaultConfig();
    bad.privacy.redactPatterns = ["[unclosed"];
    const result = AmemConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts valid regex in privacy.redactPatterns", () => {
    const good = getDefaultConfig();
    good.privacy.redactPatterns = ["secret", "\\b[A-Z0-9]{32}\\b"];
    expect(AmemConfigSchema.safeParse(good).success).toBe(true);
  });

  it("accepts null team.syncPath and team.userId", () => {
    const good = getDefaultConfig();
    expect(good.team.syncPath).toBeNull();
    expect(good.team.userId).toBeNull();
    expect(AmemConfigSchema.safeParse(good).success).toBe(true);
  });

  it("rejects empty embeddingModel string", () => {
    const bad = { ...getDefaultConfig(), embeddingModel: "" };
    expect(AmemConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe("admin key sets", () => {
  it("RESTART_REQUIRED_CONFIG_KEYS contains expected keys", () => {
    expect(RESTART_REQUIRED_CONFIG_KEYS.has("embeddingModel")).toBe(true);
    expect(RESTART_REQUIRED_CONFIG_KEYS.has("embeddingCacheSize")).toBe(true);
  });

  it("DANGEROUS_CONFIG_KEYS contains embeddingDimensions", () => {
    expect(DANGEROUS_CONFIG_KEYS.has("embeddingDimensions")).toBe(true);
  });

  it("admin key sets do not overlap with each other", () => {
    for (const k of RESTART_REQUIRED_CONFIG_KEYS) {
      expect(DANGEROUS_CONFIG_KEYS.has(k)).toBe(false);
    }
  });
});

describe("sanitizeContent", () => {
  it("returns content unchanged when privacy is disabled", () => {
    const cfg = getDefaultConfig();
    cfg.privacy.enablePrivateTags = false;
    const result = sanitizeContent("<private>secret</private>", cfg);
    expect(result).toBe("<private>secret</private>");
  });

  it("strips <private>...</private> blocks and replaces with [REDACTED]", () => {
    const cfg = getDefaultConfig();
    const result = sanitizeContent("before <private>secret</private> after", cfg);
    expect(result).toBe("before [REDACTED] after");
  });

  it("returns null when content is entirely inside a <private> block", () => {
    const cfg = getDefaultConfig();
    const result = sanitizeContent("<private>API_KEY=abc123</private>", cfg);
    expect(result).toBeNull();
  });

  it("returns null when content is empty after stripping", () => {
    const cfg = getDefaultConfig();
    const result = sanitizeContent("", cfg);
    expect(result).toBeNull();
  });

  it("applies redaction patterns from config", () => {
    const cfg = getDefaultConfig();
    const result = sanitizeContent("api_key: supersecretvalue12345", cfg);
    expect(result).not.toContain("supersecretvalue12345");
    expect(result).toContain("[REDACTED]");
  });

  it("handles multiple <private> blocks", () => {
    const cfg = getDefaultConfig();
    const result = sanitizeContent("a <private>x</private> b <private>y</private> c", cfg);
    expect(result).toBe("a [REDACTED] b [REDACTED] c");
  });

  it("is case-insensitive for <private> tags", () => {
    const cfg = getDefaultConfig();
    const result = sanitizeContent("text <PRIVATE>hidden</PRIVATE> more", cfg);
    expect(result).toContain("[REDACTED]");
  });

  it("handles multiline <private> blocks", () => {
    const cfg = getDefaultConfig();
    const result = sanitizeContent("before\n<private>\nline1\nline2\n</private>\nafter", cfg);
    expect(result).toContain("before");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("after");
    expect(result).not.toContain("line1");
  });

  it("silently skips invalid regex patterns instead of throwing", () => {
    const cfg = getDefaultConfig();
    cfg.privacy.redactPatterns = ["[unclosed", "valid\\d+"];
    expect(() => sanitizeContent("test 123", cfg)).not.toThrow();
  });
});
