/**
 * LongMemEval (Oracle variant) recall benchmark for amem-core.
 *
 * Dataset: xiaowu0162/longmemeval-cleaned, longmemeval_oracle.json (15 MB).
 * 500 questions, ~22 turns each, gold-answer turns marked has_answer:true.
 *
 * For each question:
 *   1. Spin up a fresh in-memory DB (per-question isolation, no scope leakage,
 *      no contradiction-expiry across questions).
 *   2. Embed and insert every turn as a memory.
 *   3. Track which inserted memory ids correspond to gold-answer turns.
 *   4. Run amem.recall(question, limit=10).
 *   5. Score turn-level R@K: did the recall return any gold-answer memory?
 *
 * Aggregate R@1/3/5/10 overall and per question type. Save JSON report.
 *
 * Run:  npm run bench:longmemeval
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  generateEmbedding,
  recall,
  isRerankerAvailable,
  type AmemDatabase,
} from "../../src/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface Turn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

interface Question {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

interface QuestionResult {
  question_id: string;
  question_type: string;
  total_turns: number;
  gold_turns: number;
  gold_rank: number; // best rank achieved by any gold turn; 0 = not found in top-10
  hit_at_1: boolean;
  hit_at_3: boolean;
  hit_at_5: boolean;
  hit_at_10: boolean;
}

interface Aggregate {
  count: number;
  rAt1: number;
  rAt3: number;
  rAt5: number;
  rAt10: number;
  meanGoldRank: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function aggregate(results: QuestionResult[]): Aggregate {
  const n = results.length;
  if (n === 0) {
    return { count: 0, rAt1: 0, rAt3: 0, rAt5: 0, rAt10: 0, meanGoldRank: 0 };
  }
  return {
    count: n,
    rAt1: results.filter((r) => r.hit_at_1).length / n,
    rAt3: results.filter((r) => r.hit_at_3).length / n,
    rAt5: results.filter((r) => r.hit_at_5).length / n,
    rAt10: results.filter((r) => r.hit_at_10).length / n,
    meanGoldRank:
      results.reduce((s, r) => s + (r.gold_rank > 0 ? r.gold_rank : 11), 0) / n,
  };
}

function progressBar(done: number, total: number): string {
  const width = 30;
  const filled = Math.round((done / total) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${done}/${total}`;
}

// ── Per-question scoring ─────────────────────────────────────────────────────

async function scoreQuestion(q: Question): Promise<QuestionResult> {
  // Fresh temp DB per question — guarantees no cross-question contamination
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lme-"));
  const dbPath = path.join(tmpDir, "q.db");
  const db: AmemDatabase = createDatabase(dbPath);

  const goldIds = new Set<string>();
  let totalTurns = 0;

  try {
    for (const session of q.haystack_sessions) {
      for (const turn of session) {
        totalTurns++;
        if (!turn.content || turn.content.trim().length === 0) continue;

        const embedding = await generateEmbedding(turn.content);
        const id = db.insertMemory({
          content: turn.content,
          type: "fact",
          tags: [turn.role],
          confidence: 0.8,
          source: "longmemeval",
          scope: "bench:lme",
          embedding,
        });

        if (turn.has_answer) {
          goldIds.add(id);
        }
      }
    }

    if (goldIds.size === 0) {
      // Some questions in oracle have no has_answer flag — treat as N/A
      return {
        question_id: q.question_id,
        question_type: q.question_type,
        total_turns: totalTurns,
        gold_turns: 0,
        gold_rank: 0,
        hit_at_1: false,
        hit_at_3: false,
        hit_at_5: false,
        hit_at_10: false,
      };
    }

    const recalled = await recall(db, {
      query: q.question,
      limit: 10,
      scope: "bench:lme",
      compact: false,
    });

    const topIds = recalled.memories.map((m) => m.id as string);
    let bestRank = 0;
    for (let i = 0; i < topIds.length; i++) {
      if (goldIds.has(topIds[i])) {
        bestRank = i + 1;
        break;
      }
    }

    return {
      question_id: q.question_id,
      question_type: q.question_type,
      total_turns: totalTurns,
      gold_turns: goldIds.size,
      gold_rank: bestRank,
      hit_at_1: bestRank > 0 && bestRank <= 1,
      hit_at_3: bestRank > 0 && bestRank <= 3,
      hit_at_5: bestRank > 0 && bestRank <= 5,
      hit_at_10: bestRank > 0 && bestRank <= 10,
    };
  } finally {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));

  // Pick variant via env var (default: oracle)
  //   LME_VARIANT=oracle  → longmemeval_oracle.json (15 MB, evidence only)
  //   LME_VARIANT=s       → longmemeval_s_cleaned.json (277 MB, full haystack ~40 sessions/q)
  //   LME_VARIANT=m       → longmemeval_m_cleaned.json (2.74 GB, full haystack ~500 sessions/q)
  const variant = process.env.LME_VARIANT ?? "oracle";
  const variantFile: Record<string, string> = {
    oracle: "longmemeval_oracle.json",
    s: "longmemeval_s_cleaned.json",
    m: "longmemeval_m_cleaned.json",
  };
  const datasetFilename = variantFile[variant];
  if (!datasetFilename) {
    console.error(`[lme] unknown LME_VARIANT: ${variant}. Use oracle | s | m`);
    process.exit(1);
  }
  const datasetPath = path.join(here, datasetFilename);

  if (!fs.existsSync(datasetPath)) {
    console.error(`[lme] dataset not found at ${datasetPath}`);
    console.error(
      `[lme] download with: curl -sL -o ${datasetPath} https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/${datasetFilename}`,
    );
    process.exit(1);
  }

  console.log(`[lme] variant: ${variant} (${datasetFilename})`);
  console.log("[lme] loading dataset...");
  const dataset: Question[] = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  console.log(`[lme] loaded ${dataset.length} questions`);

  // Sample size — env var override for quick smoke test
  const SAMPLE = process.env.LME_SAMPLE
    ? parseInt(process.env.LME_SAMPLE, 10)
    : dataset.length;
  const work = dataset.slice(0, SAMPLE);
  console.log(`[lme] running on ${work.length} questions`);

  // Warm up the embedding model so the timer is honest
  console.log("[lme] warming up embedding model...");
  await generateEmbedding("warmup query");

  // Verify the cross-encoder reranker is available — fail loud if not
  console.log("[lme] checking reranker availability...");
  const rerankerOk = await isRerankerAvailable();
  console.log(
    `[lme] reranker: ${rerankerOk ? "ENABLED (cross-encoder)" : "DISABLED (fallback to base scores)"}`,
  );

  const startedAt = Date.now();
  const results: QuestionResult[] = [];

  for (let i = 0; i < work.length; i++) {
    const q = work[i];
    try {
      const r = await scoreQuestion(q);
      results.push(r);
    } catch (err) {
      console.error(
        `[lme] question ${q.question_id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    if ((i + 1) % 10 === 0 || i === work.length - 1) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = (work.length - i - 1) / rate;
      const partial = aggregate(results);
      process.stdout.write(
        `\r${progressBar(i + 1, work.length)}  R@5=${pct(partial.rAt5)}  ${rate.toFixed(1)} q/s  ETA ${Math.round(eta)}s`,
      );
    }
  }
  process.stdout.write("\n\n");

  // Filter to scoreable (had at least one gold turn)
  const scoreable = results.filter((r) => r.gold_turns > 0);

  const overall = aggregate(scoreable);
  const byType: Record<string, Aggregate> = {};
  for (const r of scoreable) {
    if (!byType[r.question_type]) {
      byType[r.question_type] = aggregate(
        scoreable.filter((x) => x.question_type === r.question_type),
      );
    }
  }

  // ── Print report ─────────────────────────────────────────────────────────
  console.log("─".repeat(70));
  console.log("amem-core × LongMemEval (Oracle) — turn-level recall");
  console.log("─".repeat(70));
  console.log(
    `dataset:  ${datasetFilename} (${dataset.length} questions, ${scoreable.length} scoreable)`,
  );
  console.log(
    `runtime:  ${((Date.now() - startedAt) / 1000).toFixed(1)}s on ${work.length} questions`,
  );
  console.log("");
  console.log("Overall");
  console.log(
    `  R@1:  ${pct(overall.rAt1).padStart(7)}   ${"█".repeat(Math.round(overall.rAt1 * 30))}`,
  );
  console.log(
    `  R@3:  ${pct(overall.rAt3).padStart(7)}   ${"█".repeat(Math.round(overall.rAt3 * 30))}`,
  );
  console.log(
    `  R@5:  ${pct(overall.rAt5).padStart(7)}   ${"█".repeat(Math.round(overall.rAt5 * 30))}`,
  );
  console.log(
    `  R@10: ${pct(overall.rAt10).padStart(7)}   ${"█".repeat(Math.round(overall.rAt10 * 30))}`,
  );
  console.log("");
  console.log("By question type");
  console.log(
    `  ${"type".padEnd(28)} ${"n".padStart(4)}  ${"R@1".padStart(7)}  ${"R@3".padStart(7)}  ${"R@5".padStart(7)}  ${"R@10".padStart(7)}`,
  );
  for (const [type, agg] of Object.entries(byType).sort()) {
    console.log(
      `  ${type.padEnd(28)} ${String(agg.count).padStart(4)}  ${pct(agg.rAt1).padStart(7)}  ${pct(agg.rAt3).padStart(7)}  ${pct(agg.rAt5).padStart(7)}  ${pct(agg.rAt10).padStart(7)}`,
    );
  }
  console.log("─".repeat(70));

  // ── Save JSON report ─────────────────────────────────────────────────────
  const reportPath = path.join(here, `results-${variant}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        dataset: datasetFilename,
        variant,
        total_questions: dataset.length,
        scored_questions: scoreable.length,
        runtime_seconds: (Date.now() - startedAt) / 1000,
        overall,
        by_type: byType,
      },
      null,
      2,
    ),
  );
  console.log(`[lme] saved report to ${reportPath}`);
}

main().catch((err) => {
  console.error("[lme] fatal:", err);
  process.exit(1);
});
