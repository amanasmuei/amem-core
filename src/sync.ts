/**
 * Sync engine: imports Claude Code auto-memory files into amem.
 *
 * Claude Code stores auto-memory as markdown files with YAML frontmatter:
 *   ~/.claude/projects/<escaped-path>/memory/MEMORY.md   (index)
 *   ~/.claude/projects/<escaped-path>/memory/<name>.md    (individual memories)
 *
 * Frontmatter format:
 *   ---
 *   name: <title>
 *   description: <one-line summary>
 *   type: user | feedback | project | reference
 *   ---
 *   <markdown body>
 *
 * Type mapping (Claude auto-memory → amem):
 *   feedback   → correction  (user corrections, constraints)
 *   project    → decision    (project-level decisions, architecture)
 *   user       → preference  (user profile, preferences)
 *   reference  → topology    (pointers to external resources, codebase locations)
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { AmemDatabase } from "./database.js";
import type { MemoryTypeValue } from "./memory.js";
import { generateEmbedding } from "./embeddings.js";

// ── Type mapping ────────────────────────────────────────

const CLAUDE_TO_AMEM_TYPE: Record<string, MemoryTypeValue> = {
  feedback: "correction",
  project: "decision",
  user: "preference",
  reference: "topology",
};

const CLAUDE_TO_CONFIDENCE: Record<string, number> = {
  feedback: 1.0,    // Corrections are high-confidence
  project: 0.85,
  user: 0.8,
  reference: 0.7,
};

// ── Frontmatter parser ──────────────────────────────────

interface ClaudeMemoryFile {
  name: string;
  description: string;
  type: string;
  body: string;
  filePath: string;
}

function parseFrontmatter(content: string, filePath: string): ClaudeMemoryFile | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  // Simple YAML key-value parser (no dependency needed)
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }

  if (!fields.name || !fields.type) return null;

  return {
    name: fields.name,
    description: fields.description || "",
    type: fields.type,
    body,
    filePath,
  };
}

// ── Discovery ───────────────────────────────────────────

/**
 * Find all Claude auto-memory directories.
 * Returns map of project path → memory directory.
 */
export function discoverClaudeMemories(): Map<string, string> {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  const results = new Map<string, string>();

  if (!fs.existsSync(claudeDir)) return results;

  try {
    for (const entry of fs.readdirSync(claudeDir)) {
      const memDir = path.join(claudeDir, entry, "memory");
      if (fs.existsSync(memDir) && fs.statSync(memDir).isDirectory()) {
        // Decode project path from directory name
        const projectPath = entry.replace(/^-/, "/").replace(/-/g, "/");
        results.set(projectPath, memDir);
      }
    }
  } catch {
    // Permission errors etc.
  }

  return results;
}

/**
 * Read all memory files from a Claude auto-memory directory.
 */
export function readClaudeMemoryDir(memDir: string): ClaudeMemoryFile[] {
  const files: ClaudeMemoryFile[] = [];

  try {
    for (const name of fs.readdirSync(memDir)) {
      if (name === "MEMORY.md") continue; // Skip index file
      if (!name.endsWith(".md")) continue;

      const filePath = path.join(memDir, name);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseFrontmatter(content, filePath);
      if (parsed) files.push(parsed);
    }
  } catch {
    // Read errors
  }

  return files;
}

// ── Sync engine ─────────────────────────────────────────

export interface SyncResult {
  imported: number;
  skipped: number;
  updated: number;
  details: Array<{
    action: "imported" | "skipped" | "updated";
    name: string;
    type: string;
    reason?: string;
  }>;
  projectsScanned: number;
}

/**
 * Sync Claude auto-memory into amem.
 *
 * @param db - amem database
 * @param projectFilter - only sync this project path (optional, syncs all if omitted)
 * @param dryRun - preview without writing (default: false)
 */
export async function syncFromClaude(
  db: AmemDatabase,
  projectFilter?: string,
  dryRun = false,
): Promise<SyncResult> {
  const discovered = discoverClaudeMemories();
  const result: SyncResult = {
    imported: 0,
    skipped: 0,
    updated: 0,
    details: [],
    projectsScanned: 0,
  };

  for (const [projectPath, memDir] of discovered) {
    if (projectFilter && !projectPath.includes(projectFilter)) continue;
    result.projectsScanned++;

    const files = readClaudeMemoryDir(memDir);
    const scope = `project:${projectPath}`;

    for (const file of files) {
      const amemType = CLAUDE_TO_AMEM_TYPE[file.type];
      if (!amemType) {
        result.skipped++;
        result.details.push({
          action: "skipped",
          name: file.name,
          type: file.type,
          reason: `Unknown Claude memory type: ${file.type}`,
        });
        continue;
      }

      // Build the memory content: combine name + body for richness
      const content = file.body.length > 0
        ? `${file.name}: ${file.body}`
        : file.name;

      // Truncate very long memories (Claude project overviews can be huge)
      const truncated = content.length > 5000
        ? content.slice(0, 5000) + "\n\n[truncated from Claude auto-memory]"
        : content;

      // Check for existing duplicate by content hash
      const existing = db.findByContentHash(truncated);
      if (existing) {
        result.skipped++;
        result.details.push({
          action: "skipped",
          name: file.name,
          type: amemType,
          reason: "Already exists in amem (content hash match)",
        });
        continue;
      }

      // Check for semantic near-duplicate by name
      const nameMatch = db.fullTextSearch(file.name, 1);
      if (nameMatch.length > 0 && nameMatch[0].content.includes(file.name.split(":")[0])) {
        result.skipped++;
        result.details.push({
          action: "skipped",
          name: file.name,
          type: amemType,
          reason: `Similar memory already exists: "${nameMatch[0].content.slice(0, 60)}..."`,
        });
        continue;
      }

      if (dryRun) {
        result.imported++;
        result.details.push({
          action: "imported",
          name: file.name,
          type: amemType,
          reason: "(dry run)",
        });
        continue;
      }

      // Generate embedding and store
      const embedding = await generateEmbedding(truncated);
      const confidence = CLAUDE_TO_CONFIDENCE[file.type] ?? 0.7;

      // Use global scope for user/feedback, project scope for project/reference
      const memScope = (file.type === "user" || file.type === "feedback") ? "global" : scope;

      const tags = ["claude-sync", file.type];
      if (file.description) {
        // Extract potential tags from description
        const words = file.description.toLowerCase().split(/[\s,\-]+/);
        for (const w of words) {
          if (w.length > 3 && w.length < 20 && !tags.includes(w)) {
            tags.push(w);
            if (tags.length >= 8) break;
          }
        }
      }

      db.insertMemory({
        content: truncated,
        type: amemType,
        tags,
        confidence,
        source: "claude-auto-memory",
        embedding,
        scope: memScope,
      });

      result.imported++;
      result.details.push({
        action: "imported",
        name: file.name,
        type: amemType,
      });
    }
  }

  return result;
}

// ── Team sync ──────────────────────────────────────────

export interface TeamExportOptions {
  userId: string;
  includeTypes?: string[];
  minConfidence?: number;
}

export interface TeamImportOptions {
  dryRun?: boolean;
}

export interface TeamImportResult {
  imported: number;
  skipped: number;
  from: string;
}

interface TeamExportEntry {
  content: string;
  type: MemoryTypeValue;
  tags: string[];
  confidence: number;
  source: string;
  scope: string;
  createdAt: number;
}

interface TeamExportFile {
  version: 1;
  userId: string;
  exportedAt: number;
  memories: TeamExportEntry[];
}

/**
 * Export shareable memories as a JSON file for team sync.
 * Filters out private/personal memories (type=preference with non-global scope).
 */
export async function exportForTeam(
  db: AmemDatabase,
  outputDir: string,
  options: TeamExportOptions,
): Promise<{ file: string; count: number }> {
  const { userId, includeTypes, minConfidence } = options;
  const allowedTypes = includeTypes ?? ["correction", "decision", "pattern", "topology", "fact"];

  const all = db.getAll();

  const filtered = all.filter((m) => {
    // Filter out private/personal preferences (non-global scope)
    if (m.type === "preference" && m.scope !== "global") return false;

    // Only include allowed types
    if (!allowedTypes.includes(m.type)) return false;

    // Min confidence filter
    if (minConfidence !== undefined && m.confidence < minConfidence) return false;

    return true;
  });

  const memories: TeamExportEntry[] = filtered.map((m) => ({
    content: m.content,
    type: m.type,
    tags: m.tags,
    confidence: m.confidence,
    source: m.source,
    scope: m.scope,
    createdAt: m.createdAt,
  }));

  const exportData: TeamExportFile = {
    version: 1,
    userId,
    exportedAt: Date.now(),
    memories,
  };

  const timestamp = Date.now();
  const fileName = `amem-team-${userId}-${timestamp}.json`;
  const filePath = path.join(outputDir, fileName);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2) + "\n");

  return { file: filePath, count: memories.length };
}

/**
 * Import a teammate's exported memory file.
 * Deduplicates by content hash and lowers confidence by 0.1 for second-hand memories.
 */
export async function importFromTeam(
  db: AmemDatabase,
  filePath: string,
  options?: TeamImportOptions,
): Promise<TeamImportResult> {
  const dryRun = options?.dryRun ?? false;

  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as TeamExportFile;

  const fromUser = data.userId;
  let imported = 0;
  let skipped = 0;

  for (const entry of data.memories) {
    // Dedup: skip if content already exists
    const existing = db.findByContentHash(entry.content);
    if (existing) {
      skipped++;
      continue;
    }

    if (dryRun) {
      imported++;
      continue;
    }

    // Lower confidence by 0.1 for second-hand memories, floor at 0.1
    const confidence = Math.max(0.1, entry.confidence - 0.1);

    // Tag with team-sync and the original userId
    const tags = [...entry.tags, "team-sync", `from:${fromUser}`];

    const embedding = await generateEmbedding(entry.content);

    db.insertMemory({
      content: entry.content,
      type: entry.type,
      tags,
      confidence,
      source: `team-sync:${fromUser}`,
      embedding,
      scope: entry.scope,
    });

    imported++;
  }

  return { imported, skipped, from: fromUser };
}

// ── Copilot sync ─────────────────────────────────────

const AMEM_SECTION_START = "<!-- amem:start -->";
const AMEM_SECTION_END = "<!-- amem:end -->";

export interface CopilotSyncOptions {
  /** Target project directory (default: cwd) */
  projectDir?: string;
  /** Only include memories with confidence >= this value (default: 0.5) */
  minConfidence?: number;
  /** Only include specific memory types */
  includeTypes?: MemoryTypeValue[];
  /** Scope filter — only memories matching this scope or "global" */
  scope?: string;
  /** Preview without writing (default: false) */
  dryRun?: boolean;
}

export interface CopilotSyncResult {
  file: string;
  memoriesExported: number;
  sections: {
    corrections: number;
    decisions: number;
    preferences: number;
    patterns: number;
    other: number;
  };
  dryRun: boolean;
}

/**
 * Generate the amem section content for copilot-instructions.md.
 * Exports core memories as structured markdown that Copilot reads as context.
 */
export function generateCopilotInstructions(
  db: AmemDatabase,
  options?: Pick<CopilotSyncOptions, "minConfidence" | "includeTypes" | "scope">,
): { markdown: string; counts: CopilotSyncResult["sections"] } {
  const minConfidence = options?.minConfidence ?? 0.5;
  const includeTypes = options?.includeTypes ?? [
    "correction", "decision", "preference", "pattern", "topology", "fact",
  ];
  const scopeFilter = options?.scope;

  const now = Date.now();
  const all = db.getAll();

  // Filter: valid, confident, matching types and scope
  const filtered = all.filter((m) => {
    if (!includeTypes.includes(m.type)) return false;
    if (m.confidence < minConfidence) return false;
    if (m.validUntil && m.validUntil < now) return false;
    if (scopeFilter && m.scope !== "global" && m.scope !== scopeFilter) return false;
    return true;
  });

  // Group by type, sorted by confidence descending
  const groups: Record<string, typeof filtered> = {};
  for (const m of filtered) {
    if (!groups[m.type]) groups[m.type] = [];
    groups[m.type].push(m);
  }
  for (const arr of Object.values(groups)) {
    arr.sort((a, b) => b.confidence - a.confidence);
  }

  const counts: CopilotSyncResult["sections"] = {
    corrections: 0, decisions: 0, preferences: 0, patterns: 0, other: 0,
  };

  const lines: string[] = [];
  lines.push("# Project Memory (amem)");
  lines.push("");
  lines.push(`> Auto-generated by amem on ${new Date().toISOString().slice(0, 10)}.`);
  lines.push("> These are persistent memories from past coding sessions.");
  lines.push("> Corrections are hard constraints — always follow them.");
  lines.push("");

  // Corrections first — highest priority
  if (groups.correction?.length) {
    counts.corrections = groups.correction.length;
    lines.push("## Corrections (MUST follow)");
    lines.push("");
    for (const m of groups.correction) {
      lines.push(`- **${m.content}**`);
    }
    lines.push("");
  }

  // Decisions
  if (groups.decision?.length) {
    counts.decisions = groups.decision.length;
    lines.push("## Decisions");
    lines.push("");
    for (const m of groups.decision) {
      lines.push(`- ${m.content}`);
    }
    lines.push("");
  }

  // Preferences
  if (groups.preference?.length) {
    counts.preferences = groups.preference.length;
    lines.push("## Preferences");
    lines.push("");
    for (const m of groups.preference) {
      lines.push(`- ${m.content}`);
    }
    lines.push("");
  }

  // Patterns
  if (groups.pattern?.length) {
    counts.patterns = groups.pattern.length;
    lines.push("## Patterns & Conventions");
    lines.push("");
    for (const m of groups.pattern) {
      lines.push(`- ${m.content}`);
    }
    lines.push("");
  }

  // Topology + facts → "Other Context"
  const otherTypes = ["topology", "fact"] as const;
  const otherMemories = otherTypes.flatMap((t) => groups[t] || []);
  if (otherMemories.length) {
    counts.other = otherMemories.length;
    lines.push("## Context");
    lines.push("");
    for (const m of otherMemories) {
      lines.push(`- ${m.content}`);
    }
    lines.push("");
  }

  return { markdown: lines.join("\n"), counts };
}

/**
 * Sync amem memories to .github/copilot-instructions.md.
 *
 * Writes an amem section wrapped in HTML comments (<!-- amem:start/end -->).
 * Preserves any existing non-amem content in the file.
 */
export function syncToCopilot(
  db: AmemDatabase,
  options?: CopilotSyncOptions,
): CopilotSyncResult {
  const projectDir = options?.projectDir ?? process.cwd();
  const dryRun = options?.dryRun ?? false;

  const { markdown, counts } = generateCopilotInstructions(db, {
    minConfidence: options?.minConfidence,
    includeTypes: options?.includeTypes,
    scope: options?.scope ?? `project:${projectDir}`,
  });

  const totalExported =
    counts.corrections + counts.decisions + counts.preferences +
    counts.patterns + counts.other;

  const githubDir = path.join(projectDir, ".github");
  const filePath = path.join(githubDir, "copilot-instructions.md");

  if (!dryRun) {
    fs.mkdirSync(githubDir, { recursive: true });

    const amemBlock = `${AMEM_SECTION_START}\n${markdown}\n${AMEM_SECTION_END}`;

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf-8");

      // Replace existing amem section or append
      const startIdx = existing.indexOf(AMEM_SECTION_START);
      const endIdx = existing.indexOf(AMEM_SECTION_END);

      if (startIdx !== -1 && endIdx !== -1) {
        // Replace existing section
        const before = existing.slice(0, startIdx);
        const after = existing.slice(endIdx + AMEM_SECTION_END.length);
        fs.writeFileSync(filePath, before + amemBlock + after);
      } else {
        // Append to existing file
        const separator = existing.endsWith("\n") ? "\n" : "\n\n";
        fs.writeFileSync(filePath, existing + separator + amemBlock + "\n");
      }
    } else {
      fs.writeFileSync(filePath, amemBlock + "\n");
    }
  }

  return {
    file: filePath,
    memoriesExported: totalExported,
    sections: counts,
    dryRun,
  };
}
