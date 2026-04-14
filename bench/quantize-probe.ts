/**
 * Probe: does transformers.js support dtype quantization for the
 * ms-marco cross-encoder, and does it preserve ranking?
 *
 * Tests fp32 baseline vs fp16 vs q8. For each:
 *   - load model with dtype option
 *   - run rerank on 20 pairs
 *   - compare scores & ranking against fp32
 *   - measure wall-clock time
 */

const MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";

interface Candidate { id: string; content: string; }

const QUERY = "what database do we use for backend services";
const DOCS: Candidate[] = [
  { id: "postgres", content: "PostgreSQL is the default database for all backend services in the company." },
  { id: "redis", content: "Redis is used as the session cache layer in front of Postgres." },
  { id: "deploy", content: "Never deploy to production on Friday afternoons or before public holidays." },
  { id: "node", content: "All Node.js services must run on Node 20 LTS or newer." },
  { id: "auth", content: "Authentication uses JWT tokens signed with RS256 and a 15-minute expiry." },
  { id: "rate", content: "Public API endpoints are rate-limited to 100 requests per minute per IP." },
  { id: "coverage", content: "Minimum unit test coverage for new code is 80 percent." },
  { id: "pnpm", content: "The monorepo is managed with pnpm workspaces, not npm or yarn." },
  { id: "logging", content: "All services emit structured JSON logs using the pino library." },
  { id: "prom", content: "Application metrics are scraped by Prometheus and visualized in Grafana." },
  { id: "git", content: "Pull requests must be squash-merged into main with a conventional commit message." },
  { id: "vault", content: "All production secrets live in HashiCorp Vault and are never committed to git." },
  { id: "k8s", content: "Kubernetes deployments are templated with Helm charts checked into the infra repo." },
  { id: "rn", content: "Mobile apps are built with React Native, not Flutter or native code." },
  { id: "rest", content: "Public APIs follow REST conventions, with GraphQL reserved for internal admin tools." },
  { id: "rabbit", content: "Background jobs are dispatched through RabbitMQ with at-least-once delivery." },
  { id: "browser", content: "Frontend supports the last two major versions of Chrome, Firefox, Safari, and Edge." },
  { id: "i18n", content: "Internationalization uses the ICU MessageFormat syntax via formatjs." },
  { id: "strict", content: "Always use strict TypeScript with noImplicitAny and strictNullChecks enabled." },
  { id: "react", content: "Prefer React hooks over class components for new UI code." },
];

async function scoreWithDtype(mod: typeof import("@huggingface/transformers"), dtype: string | null): Promise<{ scores: number[]; ms: number; loadMs: number }> {
  const loadStart = performance.now();
  const tokenizer = (await (
    mod.AutoTokenizer as unknown as { from_pretrained: (id: string) => Promise<(q: string | string[], o: unknown) => unknown> }
  ).from_pretrained(MODEL_ID));

  const opts: Record<string, unknown> = {};
  if (dtype) opts.dtype = dtype;
  const model = (await (
    mod.AutoModelForSequenceClassification as unknown as {
      from_pretrained: (id: string, o?: Record<string, unknown>) => Promise<(inputs: unknown) => Promise<{ logits: { data: Float32Array | number[] } }>>;
    }
  ).from_pretrained(MODEL_ID, opts));
  const loadMs = performance.now() - loadStart;

  const queries = DOCS.map(() => QUERY);
  const docs = DOCS.map((d) => d.content);

  // Warm-up pass (JIT + any first-call overhead)
  const warmup = tokenizer(queries.slice(0, 2), { text_pair: docs.slice(0, 2), padding: true, truncation: true });
  await model(warmup);

  const t0 = performance.now();
  const inputs = tokenizer(queries, { text_pair: docs, padding: true, truncation: true });
  const out = await model(inputs);
  const ms = performance.now() - t0;
  const data = out.logits.data;
  const scores = Array.from({ length: DOCS.length }, (_, i) => Number(data[i] ?? 0));
  return { scores, ms, loadMs };
}

function rank(scores: number[]): string[] {
  return DOCS.map((d, i) => ({ id: d.id, s: scores[i] }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.id);
}

function spearman(a: string[], b: string[]): number {
  const posA = new Map(a.map((id, i) => [id, i]));
  const posB = new Map(b.map((id, i) => [id, i]));
  const n = a.length;
  let sumSqDiff = 0;
  for (const id of a) {
    const d = (posA.get(id) ?? 0) - (posB.get(id) ?? 0);
    sumSqDiff += d * d;
  }
  return 1 - (6 * sumSqDiff) / (n * (n * n - 1));
}

async function main() {
  const mod = await import("@huggingface/transformers");

  const variants: Array<{ name: string; dtype: string | null }> = [
    { name: "fp32 (baseline)", dtype: null },
    { name: "fp16           ", dtype: "fp16" },
    { name: "q8             ", dtype: "q8" },
    { name: "int8           ", dtype: "int8" },
    { name: "uint8          ", dtype: "uint8" },
    { name: "q4             ", dtype: "q4" },
  ];

  let baseline: { scores: number[]; ms: number; loadMs: number } | null = null;

  console.log("");
  console.log(`${"variant".padEnd(18)} ${"load".padStart(8)} ${"rerank".padStart(8)}  top-1  rank-corr   score-MAE`);
  console.log("─".repeat(78));

  for (const v of variants) {
    try {
      const r = await scoreWithDtype(mod, v.dtype);
      const r_rank = rank(r.scores);
      const top1 = r_rank[0];
      if (!baseline) baseline = r;
      const baseRank = rank(baseline.scores);
      const corr = spearman(baseRank, r_rank);
      const mae = r.scores.reduce((s, x, i) => s + Math.abs(x - baseline!.scores[i]), 0) / r.scores.length;
      console.log(
        `${v.name.padEnd(18)} ${r.loadMs.toFixed(0).padStart(6)}ms ${r.ms.toFixed(1).padStart(6)}ms   ${top1.padEnd(8)}  ${corr.toFixed(3).padStart(6)}     ${mae.toFixed(3)}`,
      );
    } catch (err) {
      console.log(`${v.name.padEnd(18)} FAILED: ${(err as Error).message.slice(0, 60)}`);
    }
  }
  console.log("─".repeat(78));
  console.log("(higher rank-corr = closer to fp32 ranking; score-MAE is mean abs diff)");
}

main().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
