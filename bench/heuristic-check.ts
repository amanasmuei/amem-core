/**
 * Sanity check: does the advice-seeking heuristic correctly classify
 * LongMemEval question types?
 *
 * Goal:
 *   - preference queries: most should match (we want to skip rerank)
 *   - user/assistant/temporal/multi/knowledge queries: most should NOT match
 *     (we want to keep reranking them)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isAdviceSeekingQuery } from "../src/recall.js";

interface Question {
  question_id: string;
  question_type: string;
  question: string;
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dataset: Question[] = JSON.parse(
    fs.readFileSync(path.join(here, "longmemeval", "longmemeval_oracle.json"), "utf8"),
  );

  const byType = new Map<string, Question[]>();
  for (const q of dataset) {
    if (!byType.has(q.question_type)) byType.set(q.question_type, []);
    byType.get(q.question_type)!.push(q);
  }

  console.log("Heuristic classification vs ground-truth type\n");
  console.log("Type                          n     matched     %");
  console.log("─".repeat(60));

  const sorted = Array.from(byType.keys()).sort();
  for (const type of sorted) {
    const qs = byType.get(type)!;
    const matched = qs.filter((q) => isAdviceSeekingQuery(q.question)).length;
    const pct = ((matched / qs.length) * 100).toFixed(1);
    console.log(
      `${type.padEnd(30)}${String(qs.length).padStart(4)}${String(matched).padStart(10)}    ${pct}%`,
    );
  }

  // Print example matches / misses for preference
  const pref = byType.get("single-session-preference") ?? [];
  console.log("\n── single-session-preference: MATCHED ──");
  for (const q of pref.filter((q) => isAdviceSeekingQuery(q.question)).slice(0, 5)) {
    console.log(`  ✓ ${q.question.slice(0, 90)}`);
  }
  console.log("\n── single-session-preference: MISSED ──");
  for (const q of pref.filter((q) => !isAdviceSeekingQuery(q.question))) {
    console.log(`  ✗ ${q.question.slice(0, 90)}`);
  }

  // Print examples of false positives in types that benefit from rerank
  const user = byType.get("single-session-user") ?? [];
  const userFalsePositives = user.filter((q) => isAdviceSeekingQuery(q.question));
  if (userFalsePositives.length > 0) {
    console.log("\n── single-session-user: FALSE POSITIVES (we want 0) ──");
    for (const q of userFalsePositives.slice(0, 10)) {
      console.log(`  ⚠ ${q.question.slice(0, 90)}`);
    }
  }

  const asst = byType.get("single-session-assistant") ?? [];
  const asstFalsePositives = asst.filter((q) => isAdviceSeekingQuery(q.question));
  if (asstFalsePositives.length > 0) {
    console.log(`\n── single-session-assistant: matched (${asstFalsePositives.length}) ──`);
    for (const q of asstFalsePositives) {
      console.log(`  ⚠ ${q.question.slice(0, 100)}`);
    }
  }
}

main();
