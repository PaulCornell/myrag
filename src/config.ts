import path from "node:path";

export const ROOT = process.cwd();
export const RAW_DIR = path.join(ROOT, "data", "raw");
export const UNSTRUCTURED_DIR = process.env.UNSTRUCTURED_DIR ?? path.join(ROOT, "data", "unstructured");
export const PARSED_DIR = path.join(ROOT, "data", "parsed");
export const RESULTS_DIR = path.join(ROOT, "eval", "results");
// Committed eval runs, so cloners see real scores without paying for (or waiting on) a run.
export const REFERENCE_DIR = path.join(ROOT, "eval", "reference");

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/myrag";

export const EMBED_MODEL = process.env.EMBED_MODEL ?? "Xenova/bge-small-en-v1.5";
// bge models expect this instruction on queries (not on passages).
export const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

export const RERANK_MODEL = process.env.RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2";
export const RERANK_CANDIDATES = Number(process.env.RERANK_CANDIDATES ?? 30);

// Which LLM answers questions and grades answers. "ollama" (default) runs a local open-weight model:
// free, no account or key. "anthropic" uses Claude (needs ANTHROPIC_API_KEY; costs money; best quality).
export type LlmProvider = "ollama" | "anthropic";
const provider = (name: string, fallback: LlmProvider): LlmProvider => {
  const v = (process.env[name] ?? fallback).toLowerCase();
  if (v !== "ollama" && v !== "anthropic") throw new Error(`${name} must be "ollama" or "anthropic", got "${v}"`);
  return v;
};
export const LLM_PROVIDER = provider("LLM_PROVIDER", "ollama");
export const JUDGE_PROVIDER = provider("JUDGE_PROVIDER", LLM_PROVIDER);

export const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:3b";
const DEFAULT_MODEL: Record<LlmProvider, string> = { ollama: OLLAMA_MODEL, anthropic: "claude-opus-5-5" };

export const ANSWER_MODEL = process.env.ANSWER_MODEL ?? DEFAULT_MODEL[LLM_PROVIDER];
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? DEFAULT_MODEL[JUDGE_PROVIDER];

export const CHUNK_TARGET_TOKENS = Number(process.env.CHUNK_TARGET_TOKENS ?? 250);
export const CHUNK_OVERLAP_TOKENS = Number(process.env.CHUNK_OVERLAP_TOKENS ?? 40);
