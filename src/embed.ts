// Local sentence embeddings via transformers.js (ONNX, CPU). No API key, deterministic.
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { EMBED_MODEL, QUERY_INSTRUCTION } from "./config.js";

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" }) as Promise<FeatureExtractionPipeline>;
  return extractor;
}

export async function embedPassages(texts: string[], batchSize = 16, onProgress?: (done: number) => void): Promise<Float32Array[]> {
  const fe = await getExtractor();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const t = await fe(texts.slice(i, i + batchSize), { pooling: "cls", normalize: true });
    const [n, dim] = t.dims;
    const data = t.data as Float32Array;
    for (let j = 0; j < n; j++) out.push(data.slice(j * dim, (j + 1) * dim));
    onProgress?.(out.length);
  }
  return out;
}

export async function embedQuery(q: string): Promise<Float32Array> {
  const [v] = await embedPassages([QUERY_INSTRUCTION + q]);
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
