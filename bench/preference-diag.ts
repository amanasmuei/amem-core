/**
 * Diagnostic: inspect WHY the cross-encoder reranker hurts
 * single-session-preference questions on LongMemEval.
 *
 * For each failing preference question, show:
 *   - the query
 *   - the gold-answer turn(s)
 *   - bi-encoder top-5 with scores + ranks of gold
 *   - cross-encoder top-5 with scores + ranks of gold
 *
 * Run: npx tsx bench/preference-diag.ts
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
  haystack_sessions: Turn[][];
}

interface RecallMemory {
  id: string;
  content: string;
  score: number;
}

async function recallOnce(
  q: Question,
  rerank: boolean,
): Promise<{
  goldIds: Set<string>;
  results: RecallMemory[];
  goldRank: number;
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pref-diag-"));
  const dbPath = path.join(tmpDir, "q.db");
  const db: AmemDatabase = createDatabase(dbPath);

  const goldIds = new Set<string>();
  const idToContent = new Map<string, string>();

  try {
    for (const session of q.haystack_sessions) {
      for (const turn of session) {
        if (!turn.content || turn.content.trim().length === 0) continue;
        const embedding = await generateEmbedding(turn.content);
        const id = db.insertMemory({
          content: turn.content,
          type: "fact",
          tags: [turn.role],
          confidence: 0.8,
          source: "pref-diag",
          scope: "bench:lme",
          embedding,
        });
        idToContent.set(id, turn.content);
        if (turn.has_answer) goldIds.add(id);
      }
    }

    const recalled = await recall(db, {
      query: q.question,
      limit: 10,
      scope: "bench:lme",
      compact: false,
      rerank,
    });

    const results: RecallMemory[] = recalled.memories.map((m) => ({
      id: m.id as string,
      content: (m.content as string) ?? idToContent.get(m.id as string) ?? "",
      score: (m.score as number) ?? 0,
    }));

    let goldRank = 0;
    for (let i = 0; i < results.length; i++) {
      if (goldIds.has(results[i].id)) {
        goldRank = i + 1;
        break;
      }
    }

    return { goldIds, results, goldRank };
  } finally {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
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

  const prefQuestions = dataset.filter(
    (q) => q.question_type === "single-session-preference",
  );
  console.log(`[diag] ${prefQuestions.length} preference questions loaded`);
  console.log("[diag] warming embedding model...");
  await generateEmbedding("warmup");

  let regressed = 0;
  let improved = 0;
  let same = 0;
  let reportedCases = 0;
  const MAX_REPORT = 8;

  for (let i = 0; i < prefQuestions.length; i++) {
    const q = prefQuestions[i];

    const bi = await recallOnce(q, /*rerank=*/ false);
    const re = await recallOnce(q, /*rerank=*/ true);

    if (bi.goldIds.size === 0) continue;

    const biRank = bi.goldRank;
    const reRank = re.goldRank;

    if (biRank === reRank) {
      same++;
    } else if (reRank === 0 || (biRank > 0 && reRank > biRank)) {
      regressed++;
      if (reportedCases < MAX_REPORT) {
        reportedCases++;
        console.log("");
        console.log("═".repeat(80));
        console.log(
          `REGRESSION #${reportedCases}   (${i + 1}/${prefQuestions.length}, ${q.question_id})`,
        );
        console.log("═".repeat(80));
        console.log(`query:   ${truncate(q.question, 140)}`);
        console.log(`answer:  ${truncate(q.answer, 140)}`);
        console.log(
          `gold→bi: rank ${biRank}   gold→rerank: rank ${reRank === 0 ? "MISS" : reRank}`,
        );
        console.log("");
        console.log("-- BI-ENCODER top 5 --");
        for (let k = 0; k < Math.min(5, bi.results.length); k++) {
          const m = bi.results[k];
          const gold = bi.goldIds.has(m.id) ? " ⭐ GOLD" : "";
          console.log(
            `  ${k + 1}. ${m.score.toFixed(3)}  ${truncate(m.content, 90)}${gold}`,
          );
        }
        console.log("");
        console.log("-- CROSS-ENCODER top 5 --");
        for (let k = 0; k < Math.min(5, re.results.length); k++) {
          const m = re.results[k];
          const gold = bi.goldIds.has(m.id) ? " ⭐ GOLD" : "";
          console.log(
            `  ${k + 1}. ${m.score.toFixed(3)}  ${truncate(m.content, 90)}${gold}`,
          );
        }
      }
    } else {
      improved++;
    }
  }

  console.log("");
  console.log("═".repeat(80));
  console.log("SUMMARY (single-session-preference)");
  console.log("═".repeat(80));
  console.log(`  improved by rerank: ${improved}`);
  console.log(`  unchanged:          ${same}`);
  console.log(`  regressed by rerank: ${regressed}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[diag] fatal:", err);
    process.exit(1);
  });
