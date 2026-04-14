/**
 * Latency profile for amem-core recall pipeline.
 *
 * Drives the quick-recall dataset, collects per-stage timings via the
 * opt-in AMEM_PROFILE hook, and reports p50 / p95 / mean / total.
 *
 * Run:  AMEM_PROFILE=1 npx tsx bench/profile-recall.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDatabase,
  storeMemory,
  recall,
  getProfileSamples,
  resetProfileSamples,
} from "../src/index.js";

if (process.env.AMEM_PROFILE !== "1") {
  console.error("ERROR: AMEM_PROFILE=1 must be set (the timing hook is opt-in).");
  process.exit(1);
}

// ── Dataset (mirrors quick-recall, intentionally same shape) ────────────────

const MEMORIES = [
  ["ts-strict", "Always use strict TypeScript with noImplicitAny and strictNullChecks enabled.", "preference", ["typescript", "config"]],
  ["react-hooks", "Prefer React hooks over class components for new UI code.", "preference", ["react", "frontend"]],
  ["postgres-default", "PostgreSQL is the default database for all backend services in the company.", "decision", ["database", "infrastructure"]],
  ["redis-cache", "Redis is used as the session cache layer in front of Postgres.", "fact", ["cache", "infrastructure"]],
  ["deploy-friday", "Never deploy to production on Friday afternoons or before public holidays.", "decision", ["deployment", "policy"]],
  ["node-version", "All Node.js services must run on Node 20 LTS or newer.", "decision", ["node", "runtime"]],
  ["auth-jwt", "Authentication uses JWT tokens signed with RS256 and a 15-minute expiry.", "fact", ["auth", "security"]],
  ["rate-limit", "Public API endpoints are rate-limited to 100 requests per minute per IP.", "fact", ["api", "security"]],
  ["test-coverage", "Minimum unit test coverage for new code is 80 percent.", "decision", ["testing", "policy"]],
  ["monorepo-pnpm", "The monorepo is managed with pnpm workspaces, not npm or yarn.", "fact", ["monorepo", "tooling"]],
  ["logging-pino", "All services emit structured JSON logs using the pino library.", "fact", ["logging", "observability"]],
  ["metrics-prometheus", "Application metrics are scraped by Prometheus and visualized in Grafana.", "fact", ["metrics", "observability"]],
  ["git-squash", "Pull requests must be squash-merged into main with a conventional commit message.", "pattern", ["git", "workflow"]],
  ["secrets-vault", "All production secrets live in HashiCorp Vault and are never committed to git.", "decision", ["secrets", "security"]],
  ["k8s-helm", "Kubernetes deployments are templated with Helm charts checked into the infra repo.", "fact", ["kubernetes", "infrastructure"]],
  ["mobile-react-native", "Mobile apps are built with React Native, not Flutter or native code.", "decision", ["mobile", "frontend"]],
  ["api-rest", "Public APIs follow REST conventions, with GraphQL reserved for internal admin tools.", "decision", ["api", "architecture"]],
  ["queue-rabbitmq", "Background jobs are dispatched through RabbitMQ with at-least-once delivery.", "fact", ["queue", "infrastructure"]],
  ["browser-support", "Frontend supports the last two major versions of Chrome, Firefox, Safari, and Edge.", "decision", ["frontend", "policy"]],
  ["i18n-icu", "Internationalization uses the ICU MessageFormat syntax via formatjs.", "pattern", ["i18n", "frontend"]],
] as const;

// 20 queries — each asked with 2 paraphrases for 40 unique strings
// (to defeat the embedding cache and get honest per-call numbers).
const QUERIES: string[] = [
  "what database do we use", "which database powers our services",
  "when can we deploy to prod", "is friday deploy allowed",
  "how is authentication implemented", "what is the jwt config",
  "what is the test coverage requirement", "minimum unit test coverage policy",
  "how do we manage secrets", "where are prod secrets stored",
  "what package manager for the monorepo", "pnpm vs npm for our monorepo",
  "how are background jobs processed", "what queue system do we run",
  "which mobile framework do we use", "do we build mobile apps with flutter",
  "how do we ship logs", "what logging library is standard",
  "what node version is required", "minimum node runtime version",
];

const ITERATIONS = Number(process.env.AMEM_ITERS ?? 3);

// ── Stats helpers ───────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(samples: number[]): { p50: number; p95: number; p99: number; mean: number; n: number; sum: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    mean: sum / (sorted.length || 1),
    sum,
  };
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(1).padStart(7)}ms`;
}

function bar(frac: number, width = 30): string {
  const n = Math.round(frac * width);
  return "█".repeat(n) + "░".repeat(Math.max(0, width - n));
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amem-profile-"));
  const dbPath = path.join(tmpDir, "profile.db");
  const db = createDatabase(dbPath);

  console.log(`[profile] temp db: ${dbPath}`);
  console.log(`[profile] storing ${MEMORIES.length} memories...`);

  for (const [, content, type, tags] of MEMORIES) {
    await storeMemory(db, { content, type: type as "fact", tags: tags as unknown as string[], scope: "bench" });
  }

  console.log(`[profile] warmup: one recall to load models + JIT...`);
  const rssBefore = process.memoryUsage().rss;
  await recall(db, { query: "warmup query", limit: 10, scope: "bench", compact: false });
  resetProfileSamples();
  const rssAfterWarmup = process.memoryUsage().rss;
  console.log(`[profile] RSS after warmup: ${(rssAfterWarmup / 1024 / 1024).toFixed(0)} MB (delta +${((rssAfterWarmup - rssBefore) / 1024 / 1024).toFixed(0)} MB)`);

  console.log(`[profile] running ${QUERIES.length} queries x ${ITERATIONS} iterations = ${QUERIES.length * ITERATIONS} total...`);
  const totalStart = performance.now();
  const perQueryTotals: number[] = [];

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (const q of QUERIES) {
      // Append iteration suffix to defeat cache on repeated runs
      const querified = iter === 0 ? q : `${q} (variant ${iter})`;
      const t0 = performance.now();
      await recall(db, { query: querified, limit: 10, scope: "bench", compact: false });
      perQueryTotals.push(performance.now() - t0);
    }
  }

  const wallTotal = performance.now() - totalStart;
  const rssAfter = process.memoryUsage().rss;

  // Aggregate per-stage
  const byStage = new Map<string, number[]>();
  for (const s of getProfileSamples()) {
    const arr = byStage.get(s.stage) ?? [];
    arr.push(s.ms);
    byStage.set(s.stage, arr);
  }

  const totalStats = summarize(perQueryTotals);

  console.log("");
  console.log("─".repeat(72));
  console.log(`amem-core recall latency profile — ${perQueryTotals.length} queries`);
  console.log("─".repeat(72));
  console.log(`${"stage".padEnd(12)} ${"n".padStart(4)}  ${"p50".padStart(9)} ${"p95".padStart(9)} ${"p99".padStart(9)} ${"mean".padStart(9)}   share`);

  const stages = ["embed", "retrieve", "rerank"];
  for (const stage of stages) {
    const samples = byStage.get(stage);
    if (!samples || samples.length === 0) {
      console.log(`${stage.padEnd(12)} ${"0".padStart(4)}  (no samples)`);
      continue;
    }
    const s = summarize(samples);
    const share = s.sum / totalStats.sum;
    console.log(
      `${stage.padEnd(12)} ${String(s.n).padStart(4)}  ${fmtMs(s.p50)} ${fmtMs(s.p95)} ${fmtMs(s.p99)} ${fmtMs(s.mean)}   ${(share * 100).toFixed(1).padStart(5)}%  ${bar(share)}`,
    );
  }
  console.log("─".repeat(72));
  console.log(`${"TOTAL".padEnd(12)} ${String(totalStats.n).padStart(4)}  ${fmtMs(totalStats.p50)} ${fmtMs(totalStats.p95)} ${fmtMs(totalStats.p99)} ${fmtMs(totalStats.mean)}`);
  console.log("");
  console.log(`wall clock:  ${(wallTotal / 1000).toFixed(2)}s`);
  console.log(`RSS after:   ${(rssAfter / 1024 / 1024).toFixed(0)} MB`);
  console.log("─".repeat(72));

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

main().catch((err) => {
  console.error("[profile] failed:", err);
  process.exit(1);
});
