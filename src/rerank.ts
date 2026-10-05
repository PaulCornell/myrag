// Cross-encoder reranking: scores (query, passage) jointly, which is far more precise than
// comparing independent embeddings, but too slow to run over the whole corpus — so it only
// reorders the hybrid retriever's top candidates.
import { AutoModelForSequenceClassification, AutoTokenizer, type PreTrainedModel, type PreTrainedTokenizer } from "@huggingface/transformers";
import { RERANK_MODEL } from "./config.js";

let loaded: Promise<{ tok: PreTrainedTokenizer; model: PreTrainedModel }> | undefined;

function load() {
  loaded ??= (async () => ({
    tok: await AutoTokenizer.from_pretrained(RERANK_MODEL),
    model: await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: "q8" }),
  }))();
  return loaded;
}

export async function rerankScores(query: string, passages: string[], batchSize = 16): Promise<number[]> {
  const { tok, model } = await load();
  const scores: number[] = [];
  for (let i = 0; i < passages.length; i += batchSize) {
    const batch = passages.slice(i, i + batchSize);
    const inputs = tok(new Array(batch.length).fill(query), { text_pair: batch, padding: true, truncation: true });
    const { logits } = await model(inputs);
    scores.push(...(Array.from(logits.data as Float32Array) as number[]));
  }
  return scores;
}
