/**
 * Probe the cross-encoder reranker output directly to understand what
 * `Xenova/ms-marco-MiniLM-L-6-v2` actually returns under different
 * pipeline option combinations. Bypasses the amem-core wrapper entirely.
 *
 * Run: npx tsx bench/rerank-probe.ts
 */

import { pipeline } from "@huggingface/transformers";

async function probe(): Promise<void> {
  console.log("Loading Xenova/ms-marco-MiniLM-L-6-v2...");
  const classifier = (await pipeline(
    "text-classification",
    "Xenova/ms-marco-MiniLM-L-6-v2",
  )) as unknown as (
    text: string,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;

  const query = "What was the first issue I had with my new car?";
  const relevant =
    "I just got my car serviced for the first time on March 15th, and the GPS system stopped working a week later — that was the first issue.";
  const irrelevant =
    "I really enjoy cooking pasta on Sunday afternoons with my family.";

  console.log("\n— RELEVANT pair —");
  console.log("query:    ", query);
  console.log("doc:      ", relevant);

  console.log("\n[1] default options (no function_to_apply):");
  let r = await classifier(query, { text_pair: relevant });
  console.log("    raw:", JSON.stringify(r));

  console.log("\n[2] function_to_apply=none:");
  r = await classifier(query, { text_pair: relevant, function_to_apply: "none" });
  console.log("    raw:", JSON.stringify(r));

  console.log("\n[3] function_to_apply=sigmoid:");
  r = await classifier(query, { text_pair: relevant, function_to_apply: "sigmoid" });
  console.log("    raw:", JSON.stringify(r));

  console.log("\n[4] top_k=null (all scores):");
  r = await classifier(query, { text_pair: relevant, top_k: null });
  console.log("    raw:", JSON.stringify(r));

  console.log("\n[5] topk=null (alt spelling):");
  r = await classifier(query, { text_pair: relevant, topk: null });
  console.log("    raw:", JSON.stringify(r));

  console.log("\n— IRRELEVANT pair (control) —");
  console.log("query:    ", query);
  console.log("doc:      ", irrelevant);

  console.log("\n[1] default:");
  r = await classifier(query, { text_pair: irrelevant });
  console.log("    raw:", JSON.stringify(r));

  console.log("\n[2] function_to_apply=none:");
  r = await classifier(query, { text_pair: irrelevant, function_to_apply: "none" });
  console.log("    raw:", JSON.stringify(r));

  console.log("\n[3] function_to_apply=sigmoid:");
  r = await classifier(query, { text_pair: irrelevant, function_to_apply: "sigmoid" });
  console.log("    raw:", JSON.stringify(r));

  console.log("\n[4] top_k=null:");
  r = await classifier(query, { text_pair: irrelevant, top_k: null });
  console.log("    raw:", JSON.stringify(r));
}

probe()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("probe failed:", err);
    process.exit(1);
  });
