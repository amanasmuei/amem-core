/**
 * Quick recall benchmark for amem-core.
 *
 * Stores ~20 hand-crafted memories across distinct topics, then runs ~10
 * queries where the gold-truth memory ID is known. Reports R@1, R@3, R@5,
 * R@10 and a per-question breakdown.
 *
 * This is a *proof-of-life* benchmark — it proves the vector recall path
 * works end-to-end on a known answer set. It is NOT a substitute for a
 * proper LongMemEval run (see bench/longmemeval/ when that lands).
 *
 * Run:  npm run bench:quick
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDatabase, storeMemory, recall } from "../src/index.js";

interface MemorySpec {
  key: string;
  content: string;
  type: "fact" | "decision" | "preference" | "correction" | "pattern";
  tags: string[];
}

interface QuerySpec {
  query: string;
  goldKey: string;
}

// ── Hand-crafted dataset ────────────────────────────────────────────────────

const MEMORIES: MemorySpec[] = [
  {
    key: "ts-strict",
    content: "Always use strict TypeScript with noImplicitAny and strictNullChecks enabled.",
    type: "preference",
    tags: ["typescript", "config"],
  },
  {
    key: "react-hooks",
    content: "Prefer React hooks over class components for new UI code.",
    type: "preference",
    tags: ["react", "frontend"],
  },
  {
    key: "postgres-default",
    content: "PostgreSQL is the default database for all backend services in the company.",
    type: "decision",
    tags: ["database", "infrastructure"],
  },
  {
    key: "redis-cache",
    content: "Redis is used as the session cache layer in front of Postgres.",
    type: "fact",
    tags: ["cache", "infrastructure"],
  },
  {
    key: "deploy-friday",
    content: "Never deploy to production on Friday afternoons or before public holidays.",
    type: "decision",
    tags: ["deployment", "policy"],
  },
  {
    key: "node-version",
    content: "All Node.js services must run on Node 20 LTS or newer.",
    type: "decision",
    tags: ["node", "runtime"],
  },
  {
    key: "auth-jwt",
    content: "Authentication uses JWT tokens signed with RS256 and a 15-minute expiry.",
    type: "fact",
    tags: ["auth", "security"],
  },
  {
    key: "rate-limit",
    content: "Public API endpoints are rate-limited to 100 requests per minute per IP.",
    type: "fact",
    tags: ["api", "security"],
  },
  {
    key: "test-coverage",
    content: "Minimum unit test coverage for new code is 80 percent.",
    type: "decision",
    tags: ["testing", "policy"],
  },
  {
    key: "monorepo-pnpm",
    content: "The monorepo is managed with pnpm workspaces, not npm or yarn.",
    type: "fact",
    tags: ["monorepo", "tooling"],
  },
  {
    key: "logging-pino",
    content: "All services emit structured JSON logs using the pino library.",
    type: "fact",
    tags: ["logging", "observability"],
  },
  {
    key: "metrics-prometheus",
    content: "Application metrics are scraped by Prometheus and visualized in Grafana.",
    type: "fact",
    tags: ["metrics", "observability"],
  },
  {
    key: "git-squash",
    content: "Pull requests must be squash-merged into main with a conventional commit message.",
    type: "pattern",
    tags: ["git", "workflow"],
  },
  {
    key: "secrets-vault",
    content: "All production secrets live in HashiCorp Vault and are never committed to git.",
    type: "decision",
    tags: ["secrets", "security"],
  },
  {
    key: "k8s-helm",
    content: "Kubernetes deployments are templated with Helm charts checked into the infra repo.",
    type: "fact",
    tags: ["kubernetes", "infrastructure"],
  },
  {
    key: "mobile-react-native",
    content: "Mobile apps are built with React Native, not Flutter or native code.",
    type: "decision",
    tags: ["mobile", "frontend"],
  },
  {
    key: "api-rest",
    content: "Public APIs follow REST conventions, with GraphQL reserved for internal admin tools.",
    type: "decision",
    tags: ["api", "architecture"],
  },
  {
    key: "queue-rabbitmq",
    content: "Background jobs are dispatched through RabbitMQ with at-least-once delivery.",
    type: "fact",
    tags: ["queue", "infrastructure"],
  },
  {
    key: "browser-support",
    content: "Frontend supports the last two major versions of Chrome, Firefox, Safari, and Edge.",
    type: "decision",
    tags: ["frontend", "policy"],
  },
  {
    key: "i18n-icu",
    content: "Internationalization uses the ICU MessageFormat syntax via formatjs.",
    type: "pattern",
    tags: ["i18n", "frontend"],
  },
];

const QUERIES: QuerySpec[] = [
  { query: "what database do we use", goldKey: "postgres-default" },
  { query: "when can we deploy to prod", goldKey: "deploy-friday" },
  { query: "how is authentication implemented", goldKey: "auth-jwt" },
  { query: "what is the test coverage requirement", goldKey: "test-coverage" },
  { query: "how do we manage secrets", goldKey: "secrets-vault" },
  { query: "what package manager for the monorepo", goldKey: "monorepo-pnpm" },
  { query: "how are background jobs processed", goldKey: "queue-rabbitmq" },
  { query: "which mobile framework do we use", goldKey: "mobile-react-native" },
  { query: "how do we ship logs", goldKey: "logging-pino" },
  { query: "what node version is required", goldKey: "node-version" },
];

// ── Benchmark runner ────────────────────────────────────────────────────────

interface QueryResult {
  query: string;
  goldKey: string;
  goldRank: number; // 1-indexed; 0 if not found
  topIds: string[];
}

interface ScoreReport {
  total: number;
  rAt1: number;
  rAt3: number;
  rAt5: number;
  rAt10: number;
  results: QueryResult[];
}

async function run(): Promise<ScoreReport> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amem-bench-"));
  const dbPath = path.join(tmpDir, "bench.db");
  const db = createDatabase(dbPath);

  console.log(`[bench] using temp db: ${dbPath}`);
  console.log(`[bench] storing ${MEMORIES.length} memories...`);

  // Map gold keys to actual stored ids
  const keyToId = new Map<string, string>();
  for (const spec of MEMORIES) {
    const result = await storeMemory(db, {
      content: spec.content,
      type: spec.type,
      tags: spec.tags,
      scope: "bench",
    });
    if (result.action === "private") {
      throw new Error(`memory '${spec.key}' was sanitized as private — fix the dataset`);
    }
    keyToId.set(spec.key, result.id);
  }

  console.log(`[bench] running ${QUERIES.length} queries...`);

  const results: QueryResult[] = [];
  for (const q of QUERIES) {
    const recalled = await recall(db, {
      query: q.query,
      limit: 10,
      scope: "bench",
      compact: false,
    });
    const topIds = recalled.memories.map((m) => m.id as string);
    const goldId = keyToId.get(q.goldKey);
    if (!goldId) throw new Error(`unknown goldKey: ${q.goldKey}`);
    const goldRank = topIds.indexOf(goldId) + 1;
    results.push({ query: q.query, goldKey: q.goldKey, goldRank, topIds });
  }

  const total = results.length;
  const rAt = (k: number) =>
    results.filter((r) => r.goldRank > 0 && r.goldRank <= k).length / total;

  const report: ScoreReport = {
    total,
    rAt1: rAt(1),
    rAt3: rAt(3),
    rAt5: rAt(5),
    rAt10: rAt(10),
    results,
  };

  // Cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  return report;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function printReport(r: ScoreReport): void {
  console.log("");
  console.log("─".repeat(60));
  console.log("amem-core quick recall benchmark");
  console.log("─".repeat(60));
  console.log(`dataset:    ${MEMORIES.length} memories, ${r.total} queries`);
  console.log("");
  console.log(`R@1:  ${pct(r.rAt1)}   ${"█".repeat(Math.round(r.rAt1 * 30))}`);
  console.log(`R@3:  ${pct(r.rAt3)}   ${"█".repeat(Math.round(r.rAt3 * 30))}`);
  console.log(`R@5:  ${pct(r.rAt5)}   ${"█".repeat(Math.round(r.rAt5 * 30))}`);
  console.log(`R@10: ${pct(r.rAt10)}   ${"█".repeat(Math.round(r.rAt10 * 30))}`);
  console.log("");
  console.log("per-query breakdown:");
  for (const result of r.results) {
    const status = result.goldRank === 0 ? "MISS" : `#${result.goldRank}`;
    const flag = result.goldRank === 1 ? "✓" : result.goldRank === 0 ? "✗" : "~";
    console.log(`  ${flag} [${status.padEnd(4)}] ${result.query}  →  ${result.goldKey}`);
  }
  console.log("─".repeat(60));
}

run()
  .then((report) => {
    printReport(report);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[bench] failed:", err);
    process.exit(1);
  });
