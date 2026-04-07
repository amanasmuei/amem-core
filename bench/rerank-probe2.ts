/**
 * Probe #2: bypass the text-classification pipeline entirely and use
 * AutoTokenizer + AutoModelForSequenceClassification to read the raw
 * relevance logit from Xenova/ms-marco-MiniLM-L-6-v2.
 */

import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
} from "@huggingface/transformers";

async function probe(): Promise<void> {
  const modelId = "Xenova/ms-marco-MiniLM-L-6-v2";
  console.log(`Loading ${modelId}...`);

  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId);
  console.log("Loaded.");

  const query = "What was the first issue I had with my new car?";
  const docs = [
    "I just got my car serviced and the GPS stopped working — that was the first issue.",
    "The interior detailing made the leather seats look brand new again.",
    "I really enjoy cooking pasta on Sunday afternoons with my family.",
    "My new Tesla Model 3 had a software glitch the day after I picked it up.",
    "Yesterday I baked sourdough bread for the first time and it turned out great.",
  ];

  console.log(`\nquery: ${query}\n`);
  console.log("Scoring each doc:\n");

  for (const doc of docs) {
    // Tokenize the (query, doc) pair
    const inputs = tokenizer(query, {
      text_pair: doc,
      padding: true,
      truncation: true,
    });

    // Forward pass
    const outputs: { logits: { data: Float32Array | number[] } } =
      (await model(inputs)) as { logits: { data: Float32Array | number[] } };

    // Read raw logit (single-class regression head outputs 1 number per pair)
    const logit = outputs.logits.data[0];
    console.log(`  ${logit.toFixed(4)}  ${doc.slice(0, 70)}`);
  }
}

probe()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("probe2 failed:", err);
    process.exit(1);
  });
