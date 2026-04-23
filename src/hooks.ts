import type { AmemDatabase } from "./database.js";
import { loadConfig, type AmemConfig } from "./config.js";
import {
  ruleBasedExtractor,
  type ConversationTurn,
  type Extractor,
} from "./extractor.js";
import { storeMemory } from "./store.js";

/**
 * Hook events consumers (e.g. the amem MCP server) can gate on.
 *
 * - `toolUse`     — fired after a tool call in the host agent. Typically
 *                   used to append raw turns to the conversation log.
 * - `sessionEnd`  — fired when the host agent closes a session. Typically
 *                   used to trigger a session summary and flush to disk.
 * - `autoExtract` — fired on a timer (see `hooks.autoExtractInterval` in
 *                   config) to run the rule-based extractor over recent
 *                   conversation log entries and persist high-confidence
 *                   memories without an explicit `memory_store` call.
 *
 * `amem-core` itself does not run these hooks — the MCP server wrapper
 * owns the event loop. This module only exposes the config-aware guards
 * and the work functions the wrapper calls.
 */
export type HookEvent = "toolUse" | "sessionEnd" | "autoExtract";

/**
 * Check whether a given hook event should fire, based on the persisted
 * `hooks.*` config. Returns `false` when `hooks.enabled` is off, regardless
 * of the per-event flag. For `autoExtract`, an interval of 0 means disabled.
 */
export function isHookEnabled(event: HookEvent, config?: AmemConfig): boolean {
  const cfg = config ?? loadConfig();
  if (!cfg.hooks.enabled) return false;
  switch (event) {
    case "toolUse":
      return cfg.hooks.captureToolUse;
    case "sessionEnd":
      return cfg.hooks.captureSessionEnd;
    case "autoExtract":
      return cfg.hooks.autoExtractInterval > 0;
  }
}

export interface AutoExtractOptions {
  /** Restrict extraction to a single session's log entries. */
  sessionId?: string;
  /** Scope to attach to any stored memories. Defaults to "global". */
  scope?: string;
  /** Max log entries to scan. Defaults to 100. */
  limit?: number;
  /** Minimum confidence for extracted memories to be stored. Defaults to 0.6. */
  minConfidence?: number;
  /**
   * Pluggable extractor. Defaults to the built-in rule-based extractor.
   * Supply an LLM-backed or domain-specific implementation to upgrade
   * extraction quality without adding dependencies to amem-core.
   */
  extractor?: Extractor;
}

export interface AutoExtractResult {
  /** Name of the extractor that produced these candidates. */
  extractor: string;
  /** Total candidates emitted by the extractor. */
  extracted: number;
  /** Candidates that resulted in a new stored memory. */
  stored: number;
  /** Candidates that collapsed into an existing memory (reinforce/flag). */
  reinforced: number;
  /** Candidates dropped by privacy rules. */
  skipped: number;
  /** True when the extractor threw — in that case the other counts are zero. */
  extractorError?: string;
}

/**
 * Pull recent conversation log entries, run the rule-based extractor,
 * and persist qualifying memories via `storeMemory`. Respects the
 * configured `hooks.enabled` flag — returns zeroes when hooks are off.
 *
 * Intended to be called by the amem MCP server on the cadence set by
 * `hooks.autoExtractInterval`. Safe to call repeatedly: `storeMemory`
 * dedupes via the tiered conflict detector.
 */
export async function runAutoExtract(
  db: AmemDatabase,
  opts: AutoExtractOptions = {},
): Promise<AutoExtractResult> {
  const extractor = opts.extractor ?? ruleBasedExtractor;

  const cfg = loadConfig();
  if (!cfg.hooks.enabled) {
    return { extractor: extractor.name, extracted: 0, stored: 0, reinforced: 0, skipped: 0 };
  }

  const limit = opts.limit ?? 100;
  const minConfidence = opts.minConfidence ?? 0.6;

  const logs = opts.sessionId
    ? db.getLogBySession(opts.sessionId).slice(-limit)
    : db.getRecentLog(limit);

  if (logs.length === 0) {
    return { extractor: extractor.name, extracted: 0, stored: 0, reinforced: 0, skipped: 0 };
  }

  const turns: ConversationTurn[] = logs.map((l) => ({
    role: l.role,
    content: l.content,
  }));

  // Isolate extractor failures so a buggy custom extractor cannot
  // poison the store or crash the hook loop. The rule-based default
  // is sync and non-throwing, so this costs nothing in the common path.
  let candidates;
  try {
    candidates = (await extractor.extract(turns)).filter(
      (m) => m.confidence >= minConfidence,
    );
  } catch (err) {
    return {
      extractor: extractor.name,
      extracted: 0,
      stored: 0,
      reinforced: 0,
      skipped: 0,
      extractorError: err instanceof Error ? err.message : String(err),
    };
  }

  let stored = 0;
  let reinforced = 0;
  let skipped = 0;

  for (const mem of candidates) {
    const result = await storeMemory(db, {
      content: mem.content,
      type: mem.type,
      tags: mem.tags,
      confidence: mem.confidence,
      source: "auto-extract",
      scope: opts.scope,
    });
    if (result.action === "stored") stored++;
    else if (result.action === "reinforced") reinforced++;
    else skipped++;
  }

  return {
    extractor: extractor.name,
    extracted: candidates.length,
    stored,
    reinforced,
    skipped,
  };
}
