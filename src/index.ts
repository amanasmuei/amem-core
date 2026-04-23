// ── Database ──────────────────────────────────────────
export {
  createDatabase,
  type AmemDatabase,
  type MemoryInput,
  type SessionSummary,
  type MemoryStats,
  type LogEntry,
  type LogEntryInput,
  type MemoryVersion,
  type MemoryRelation,
  type PatchInput,
  type KnowledgeGap,
} from "./database.js";

// ── Memory ───────────────────────────────────────────
export {
  MemoryType,
  type MemoryTypeValue,
  IMPORTANCE_WEIGHTS,
  type Memory,
  type ScoreInput,
  computeScore,
  type ConflictAction,
  type ConflictResult,
  detectConflict,
  type RecallOptions as MemoryRecallOptions,
  type RecalledMemory,
  type ScoreExplanation,
  type ExplainedMemory,
  recallMemories,
  type ConsolidationOptions,
  type ConsolidationAction,
  type ConsolidationReport,
  consolidateMemories,
  buildVectorIndex,
  getVectorIndex,
  type MultiStrategyOptions,
  multiStrategyRecall,
  autoExpireContradictions,
} from "./memory.js";

// ── Embeddings ───────────────────────────────────────
export {
  cosineSimilarity,
  type EmbeddingCandidate,
  type SimilarityResult,
  findTopK,
  disableEmbeddings,
  preloadEmbeddings,
  generateEmbedding,
  isEmbeddingAvailable,
  type RerankCandidate,
  rerankWithCrossEncoder,
  isRerankerAvailable,
} from "./embeddings.js";

// ── ANN (Vector Index) ──────────────────────────────
export {
  VectorIndex,
  type VectorSearchResult,
} from "./ann.js";

// ── Config ───────────────────────────────────────────
export {
  type AmemConfig,
  AmemConfigSchema,
  RESTART_REQUIRED_CONFIG_KEYS,
  DANGEROUS_CONFIG_KEYS,
  getConfigPath,
  loadConfig,
  saveConfig,
  getDefaultConfig,
  resetConfigCache,
  sanitizeContent,
} from "./config.js";

// ── Recall (high-level) ─────────────────────────────
export {
  recall,
  type RecallOptions,
  type RecallResult,
  getProfileSamples,
  resetProfileSamples,
} from "./recall.js";

// ── Context (high-level) ────────────────────────────
export {
  buildContext,
  type ContextResult,
  type ContextGroup,
} from "./context.js";

// ── Store (high-level) ──────────────────────────────
export {
  storeMemory,
  type StoreOptions,
  type StoreResult,
} from "./store.js";

// ── Reflection ──────────────────────────────────────
export {
  reflect,
  isReflectionDue,
  type ClusterMember,
  type MemoryCluster,
  type ContradictionCandidate,
  type SynthesisCandidate,
  type ReflectionStats,
  type ReflectionReport,
  type ReflectionConfig,
} from "./reflection.js";

// ── Sync ────────────────────────────────────────────
export {
  discoverClaudeMemories,
  readClaudeMemoryDir,
  parseFrontmatter,
  syncFromClaude,
  exportForTeam,
  importFromTeam,
  syncToCopilot,
  generateCopilotInstructions,
  type SyncResult,
  type TeamExportOptions,
  type TeamImportOptions,
  type TeamImportResult,
  type CopilotSyncOptions,
  type CopilotSyncResult,
} from "./sync.js";

// ── Auto-Relate ─────────────────────────────────────
export {
  autoRelateMemory,
  type AutoRelateOptions,
  type AutoRelateResult,
} from "./auto-relate.js";

// ── Query Expansion ─────────────────────────────────
export { expandQuery } from "./query-expand.js";

// ── Repair ──────────────────────────────────────────
export {
  repairDatabase,
  type RepairResult,
} from "./repair.js";

// ── Doctor (Diagnostics) ────────────────────────────
export {
  runDiagnostics,
  type DiagnosticIssue,
  type DiagnosticReport,
} from "./doctor.js";

// ── Helpers ─────────────────────────────────────────
export {
  MEMORY_TYPES,
  CHARACTER_LIMIT,
  SHORT_ID_LENGTH,
  TYPE_ORDER,
  shortId,
  formatAge,
} from "./helpers.js";

// ── Schemas ─────────────────────────────────────────
export {
  StoreResultSchema,
  RecallResultSchema,
  ContextResultSchema,
  ForgetResultSchema,
  ExtractResultSchema,
  StatsResultSchema,
  ExportResultSchema,
  InjectResultSchema,
  ConsolidateResultSchema,
  PatchResultSchema,
  LogAppendResultSchema,
  LogRecallResultSchema,
  RelateResultSchema,
  VersionResultSchema,
  TemporalResultSchema,
  DetailResultSchema,
  ReminderSetResultSchema,
  ReminderListResultSchema,
  ReminderCheckResultSchema,
  ReminderCompleteResultSchema,
  LogCleanupResultSchema,
  ReflectResultSchema,
} from "./schemas.js";

// ── Extractor ───────────────────────────────────────
export {
  extractMemories,
  ruleBasedExtractor,
  type ConversationTurn,
  type ExtractedMemory,
  type Extractor,
} from "./extractor.js";

// ── Hooks ───────────────────────────────────────────
export {
  isHookEnabled,
  runAutoExtract,
  type HookEvent,
  type AutoExtractOptions,
  type AutoExtractResult,
} from "./hooks.js";

// ── Mirror ──────────────────────────────────────────
export {
  MirrorEngine,
  type MirrorOptions,
  type MirrorResult,
  type MirrorStatus,
  type TierValue,
} from "./mirror.js";
