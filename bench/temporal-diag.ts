/**
 * Diagnostic: understand why the default amem-core recall pipeline
 * fails on LongMemEval's `temporal-reasoning` questions (currently
 * 89.4% R@5, the weakest question type).
 *
 * Hypotheses to test:
 *   H1  semantic recall fails — bi-encoder doesn't find the right
 *       session at all (then time can't help)
 *   H2  semantic recall finds MULTIPLE related turns but can't pick
 *       the temporally-correct one (then time signal would help)
 *   H3  benchmark is unfair — we insert with Date.now() instead of
 *       haystack_dates, starving any temporal signal we might add
 *
 * For each failing question, log:
 *   - query + question_date
 *   - gold turn(s) + their session dates
 *   - top-5 recall results + their session dates
 *   - whether the gold SESSION was in the top-5 (even if not the
 *     exact turn)
 *
 * Run: npx tsx bench/temporal-diag.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  generateEmbedding,
  recall,
  type AmemDatabase,
} from "../src/index.js";

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
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
}

interface RecallMemory {
  id: string;
  content: string;
  score: number;
  tags?: string[];
}

interface TrackedTurn {
  id: string;
  sessionIdx: number;
  sessionDate: string;
  turnIdx: number;
  content: string;
  isGold: boolean;
}

async function recallForQuestion(q: Question): Promise<{
  turnsById: Map<string, TrackedTurn>;
  goldIds: Set<string>;
  biResults: RecallMemory[];
  reResults: RecallMemory[];
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "temp-diag-"));
  const dbPath = path.join(tmpDir, "q.db");
  const db: AmemDatabase = createDatabase(dbPath);

  const turnsById = new Map<string, TrackedTurn>();
  const goldIds = new Set<string>();

  try {
    for (let sIdx = 0; sIdx < q.haystack_sessions.length; sIdx++) {
      const session = q.haystack_sessions[sIdx];
      const sessionDate = q.haystack_dates[sIdx] ?? "?";
      for (let tIdx = 0; tIdx < session.length; tIdx++) {
        const turn = session[tIdx];
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
        turnsById.set(id, {
          id,
          sessionIdx: sIdx,
          sessionDate,
          turnIdx: tIdx,
          content: turn.content,
          isGold: !!turn.has_answer,
        });
        if (turn.has_answer) goldIds.add(id);
      }
    }

    // Run both pipelines against the SAME DB (so memory IDs are stable
    // across the two recall calls)
    const biRecalled = await recall(db, {
      query: q.question,
      limit: 10,
      scope: "bench:lme",
      compact: false,
      rerank: false,
    });
    const reRecalled = await recall(db, {
      query: q.question,
      limit: 10,
      scope: "bench:lme",
      compact: false,
      rerank: true,
    });

    const toResults = (r: { memories: Array<Record<string, unknown>> }): RecallMemory[] =>
      r.memories.map((m) => ({
        id: m.id as string,
        content: (m.content as string) ?? turnsById.get(m.id as string)?.content ?? "",
        score: (m.score as number) ?? 0,
      }));

    return {
      turnsById,
      goldIds,
      biResults: toResults(biRecalled),
      reResults: toResults(reRecalled),
    };
  } finally {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const datasetPath = path.join(here, "longmemeval", "longmemeval_oracle.json");
  const dataset: Question[] = JSON.parse(fs.readFileSync(datasetPath, "utf8"));

  const temporalQs = dataset.filter(
    (q) => q.question_type === "temporal-reasoning",
  );
  console.log(`[diag] ${temporalQs.length} temporal-reasoning questions loaded`);
  console.log("[diag] warming embedding model...");
  await generateEmbedding("warmup");

  // Buckets (per pipeline)
  const biBuckets = { at1: 0, in3: 0, in5: 0, in10: 0 };
  const reBuckets = { at1: 0, in3: 0, in5: 0, in10: 0 };

  // Detect "ordering" keywords in queries
  const orderingKeywords = [
    /\bfirst\b/i,
    /\blast\b/i,
    /\brecent(ly)?\b/i,
    /\bbefore\b/i,
    /\bafter\b/i,
    /\bearliest\b/i,
    /\blatest\b/i,
    /\binitial(ly)?\b/i,
    /\bmost recent\b/i,
    /\bearlier\b/i,
    /\blater\b/i,
    /\bago\b/i,
    /\bwhen (did|was)\b/i,
  ];
  const isTemporalQuery = (q: string): boolean =>
    orderingKeywords.some((re) => re.test(q));

  let temporalQueries = 0;

  for (let i = 0; i < temporalQs.length; i++) {
    const q = temporalQs[i];
    if (isTemporalQuery(q.question)) temporalQueries++;

    const { goldIds, biResults, reResults } = await recallForQuestion(q);
    if (goldIds.size === 0) continue;

    // Find gold turn rank in each pipeline
    const rankIn = (results: RecallMemory[]): number => {
      for (let k = 0; k < results.length; k++) {
        if (goldIds.has(results[k].id)) return k + 1;
      }
      return 0;
    };
    const biRank = rankIn(biResults);
    const reRank = rankIn(reResults);

    const bump = (buckets: typeof biBuckets, rank: number) => {
      if (rank === 1) buckets.at1++;
      if (rank >= 1 && rank <= 3) buckets.in3++;
      if (rank >= 1 && rank <= 5) buckets.in5++;
      if (rank >= 1 && rank <= 10) buckets.in10++;
    };
    bump(biBuckets, biRank);
    bump(reBuckets, reRank);
  }

  const pct = (n: number): string =>
    `${((n / temporalQs.length) * 100).toFixed(1)}%`;

  console.log("");
  console.log("═".repeat(70));
  console.log("temporal-reasoning: bi-encoder vs cross-encoder reranker");
  console.log("═".repeat(70));
  console.log(
    `  n:  ${temporalQs.length} questions · ${temporalQueries} with temporal keywords`,
  );
  console.log("");
  console.log(
    `  Metric          Bi-encoder         Reranker          Δ`,
  );
  const row = (label: string, bi: number, re: number) => {
    const delta = re - bi;
    const sign = delta > 0 ? "+" : delta < 0 ? "" : " ";
    console.log(
      `  ${label.padEnd(12)}   ${pct(bi).padStart(6)} (${String(bi).padStart(3)})   ${pct(re).padStart(6)} (${String(re).padStart(3)})   ${sign}${delta}`,
    );
  };
  row("R@1", biBuckets.at1, reBuckets.at1);
  row("R@3", biBuckets.in3, reBuckets.in3);
  row("R@5", biBuckets.in5, reBuckets.in5);
  row("R@10", biBuckets.in10, reBuckets.in10);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[diag] fatal:", err);
    process.exit(1);
  });
