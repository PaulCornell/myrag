import { contextualText } from "./chunk.js";
import { RERANK_CANDIDATES } from "./config.js";
import { embedQuery } from "./embed.js";
import { identifierTerms } from "./lexical.js";
import { rerankScores } from "./rerank.js";
import type { PgStore, Scored } from "./store.js";
import type { RetrievedChunk } from "./types.js";

export type RetrievalMode = "lexical" | "dense" | "hybrid" | "hybrid+rerank";
export const RETRIEVAL_MODES: RetrievalMode[] = ["lexical", "dense", "hybrid", "hybrid+rerank"];

export class Retriever {
  constructor(readonly store: PgStore) {}

  async search(query: string, k: number, mode: RetrievalMode = "hybrid+rerank"): Promise<RetrievedChunk[]> {
    let scored: Scored[];
    if (mode === "lexical") scored = await this.store.lexical(query, k);
    else if (mode === "dense") scored = await this.store.dense(await embedQuery(query), k);
    else if (mode === "hybrid") scored = await this.store.hybrid(query, await embedQuery(query), k);
    else {
      const candidates = await this.store.hybrid(query, await embedQuery(query), Math.max(k, RERANK_CANDIDATES));
      scored = await rerank(query, candidates);
    }
    return scored.slice(0, k).map((s, r) => ({ ...s, rank: r + 1 }));
  }
}

export interface RankTrace {
  chunkId: string;
  lexical: number | null;
  dense: number | null;
  hybrid: number | null;
  rerank: number;
  rerankScore: number;
}

/**
 * hybrid+rerank retrieval that also reports where each returned chunk ranked under every other
 * method, so a UI can show *why* a source was chosen (e.g. "lexical #14, dense #2 -> rerank #1").
 */
export async function searchWithTrace(store: PgStore, query: string, k: number): Promise<{ results: RetrievedChunk[]; trace: RankTrace[] }> {
  const qvec = await embedQuery(query);
  const depth = Math.max(k, RERANK_CANDIDATES);
  const [lexical, dense, hybrid] = await Promise.all([
    store.lexical(query, 100),
    store.dense(qvec, 100),
    store.hybrid(query, qvec, depth),
  ]);
  const reranked = (await rerank(query, hybrid)).slice(0, k);
  const rankIn = (list: Scored[], id: string) => {
    const i = list.findIndex((s) => s.chunk.id === id);
    return i === -1 ? null : i + 1;
  };
  const results = reranked.map((s, r) => ({ ...s, rank: r + 1 }));
  const trace = results.map((r) => ({
    chunkId: r.chunk.id,
    lexical: rankIn(lexical, r.chunk.id),
    dense: rankIn(dense, r.chunk.id),
    hybrid: rankIn(hybrid, r.chunk.id),
    rerank: r.rank,
    rerankScore: r.score,
  }));
  return { results, trace };
}

/**
 * Cross-encoder rerank with an exact-identifier guard. The MS MARCO reranker was trained on web
 * prose and scores a table row of control IDs below fluent paragraphs, even when the question asks
 * for exactly that ID ("What does GV-1.6-001 recommend?"). Candidates containing every full
 * identifier in the question therefore stay ahead of those that don't; questions without
 * identifiers are reranked purely by the cross-encoder.
 */
async function rerank(query: string, candidates: Scored[]): Promise<Scored[]> {
  const scores = await rerankScores(query, candidates.map((c) => contextualText(c.chunk)));
  // Full identifiers only (e.g. "gv16001"), not the prefixes identifierTerms also emits ("gv16").
  const queryIds = identifierTerms(query).filter((t) => !identifierTerms(query).some((o) => o !== t && o.startsWith(t)));
  const hasAllIds = (c: Scored) => {
    if (!queryIds.length) return false;
    const ids = new Set(identifierTerms(contextualText(c.chunk)));
    return queryIds.every((t) => ids.has(t));
  };
  return candidates
    .map((c, j) => ({ chunk: c.chunk, score: scores[j], pinned: hasAllIds(c) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score)
    .map(({ chunk, score }) => ({ chunk, score }));
}
