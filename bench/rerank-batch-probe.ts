/**
 * Probe: does transformers.js AutoTokenizer + AutoModelForSequenceClassification
 * accept batched inputs for cross-encoder reranking?
 *
 * Verifies:
 *   1. tokenizer([qs...], { text_pair: [docs...], padding: true, truncation: true }) works
 *   2. model(batched_inputs).logits.data has N logits for N pairs
 *   3. scores match the sequential per-pair scores (within fp tolerance)
 *   4. batched wall-time < sequential wall-time
 */

async function main() {
  const mod = await import("@huggingface/transformers");
  const modelId = "Xenova/ms-marco-MiniLM-L-6-v2";

  console.log("[probe] loading tokenizer + model...");
  const tokenizer = (await (
    mod.AutoTokenizer as unknown as { from_pretrained: (id: string) => Promise<(...args: unknown[]) => unknown> }
  ).from_pretrained(modelId));

  const model = (await (
    mod.AutoModelForSequenceClassification as unknown as {
      from_pretrained: (id: string) => Promise<(inputs: unknown) => Promise<{ logits: { data: Float32Array | number[] } }>>;
    }
  ).from_pretrained(modelId));

  const query = "what database do we use";
  const docs = [
    "PostgreSQL is the default database for all backend services in the company.",
    "Redis is used as the session cache layer in front of Postgres.",
    "All Node.js services must run on Node 20 LTS or newer.",
    "Authentication uses JWT tokens signed with RS256 and a 15-minute expiry.",
    "Public API endpoints are rate-limited to 100 requests per minute per IP.",
    "Minimum unit test coverage for new code is 80 percent.",
    "All services emit structured JSON logs using the pino library.",
    "Kubernetes deployments are templated with Helm charts checked into the infra repo.",
  ];

  // ── Sequential ──
  console.log("[probe] sequential (one pair at a time)...");
  const t0Seq = performance.now();
  const seqScores: number[] = [];
  for (const d of docs) {
    const inputs = (tokenizer as unknown as (q: string, o: unknown) => unknown)(query, {
      text_pair: d,
      padding: true,
      truncation: true,
    });
    const out = await model(inputs);
    seqScores.push(Number(out.logits.data[0] ?? 0));
  }
  const seqMs = performance.now() - t0Seq;
  console.log(`  sequential: ${seqMs.toFixed(1)}ms  scores=[${seqScores.map((s) => s.toFixed(2)).join(", ")}]`);

  // ── Batched ──
  console.log("[probe] batched (one call for all pairs)...");
  const queries = docs.map(() => query);
  const t0Batch = performance.now();
  let batchScores: number[] = [];
  let batchOk = false;
  try {
    const inputs = (tokenizer as unknown as (q: string[], o: unknown) => unknown)(queries, {
      text_pair: docs,
      padding: true,
      truncation: true,
    });
    const out = await model(inputs);
    // For batched input, logits.data is a flat Float32Array of length N*1
    // (N pairs x 1 logit per pair for this regression head).
    const data = out.logits.data;
    batchScores = Array.from({ length: docs.length }, (_, i) => Number(data[i] ?? 0));
    batchOk = true;
  } catch (err) {
    console.log(`  batched call FAILED: ${(err as Error).message}`);
  }
  const batchMs = performance.now() - t0Batch;

  if (batchOk) {
    console.log(`  batched:    ${batchMs.toFixed(1)}ms  scores=[${batchScores.map((s) => s.toFixed(2)).join(", ")}]`);

    // Compare
    const maxDiff = Math.max(...seqScores.map((s, i) => Math.abs(s - batchScores[i])));
    console.log(`  max |seq-batch| score diff: ${maxDiff.toFixed(4)}`);
    const speedup = seqMs / batchMs;
    console.log(`  speedup: ${speedup.toFixed(2)}x`);

    if (maxDiff < 0.01) {
      console.log("  ✓ scores match — batching is safe");
    } else {
      console.log("  ✗ scores DIFFER — investigate before shipping");
    }
  }

  // ── RSS ──
  const rss = process.memoryUsage().rss;
  console.log(`[probe] RSS: ${(rss / 1024 / 1024).toFixed(0)} MB`);
}

main().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
