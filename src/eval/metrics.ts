// Retrieval metrics with chunk-independent relevance labels.
//
// Gold labels are evidence *quotes*, not chunk IDs, so the same golden set scores any chunking
// strategy. A chunk is relevant if it covers most of an evidence quote's word trigrams; recall
// uses the union of the top-k chunks so a quote split across a chunk boundary still counts.
import type { Chunk } from "../types.js";
import type { Evidence } from "./golden.js";

export const COVERAGE_THRESHOLD = 0.6;

export function normalizeForMatch(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

export function shingles(words: string[], n = 3): Set<string> {
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i <= words.length - n; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/** Fraction of the evidence's trigrams present in the given text shingles. */
export function coverage(evidence: string, textShingles: Set<string>): number {
  const ev = shingles(normalizeForMatch(evidence));
  if (!ev.size) return 0;
  let hit = 0;
  for (const s of ev) if (textShingles.has(s)) hit++;
  return hit / ev.size;
}

export function chunkShingles(c: Chunk): Set<string> {
  return shingles(normalizeForMatch(c.text));
}

export function isRelevant(c: Chunk, evidence: Evidence[], cache?: Map<string, Set<string>>): boolean {
  const sh = cache?.get(c.id) ?? chunkShingles(c);
  cache?.set(c.id, sh);
  return evidence.some((e) => e.docId === c.docId && coverage(e.text, sh) >= COVERAGE_THRESHOLD);
}

/** Fraction of evidence quotes covered by the union of the top-k chunks. */
export function recallAtK(ranked: Chunk[], evidence: Evidence[], k: number): number {
  if (!evidence.length) return NaN;
  let found = 0;
  for (const e of evidence) {
    const union = new Set<string>();
    for (const c of ranked.slice(0, k)) if (c.docId === e.docId) for (const s of chunkShingles(c)) union.add(s);
    if (coverage(e.text, union) >= COVERAGE_THRESHOLD) found++;
  }
  return found / evidence.length;
}

export function reciprocalRank(ranked: Chunk[], evidence: Evidence[], k = 10): number {
  if (!evidence.length) return NaN;
  const i = ranked.slice(0, k).findIndex((c) => isRelevant(c, evidence));
  return i === -1 ? 0 : 1 / (i + 1);
}

/** Binary-relevance nDCG@k; the ideal ranking puts one relevant chunk per evidence quote first. */
export function ndcgAtK(ranked: Chunk[], evidence: Evidence[], k: number): number {
  if (!evidence.length) return NaN;
  let dcg = 0;
  ranked.slice(0, k).forEach((c, i) => {
    if (isRelevant(c, evidence)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(evidence.length, k); i++) idcg += 1 / Math.log2(i + 2);
  return Math.min(1, dcg / idcg);
}

export function mean(xs: number[]): number {
  const v = xs.filter((x) => !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}
