import type { Retriever, RetrievalMode } from "../retrieve.js";
import type { GoldenItem } from "./golden.js";
import { mean, ndcgAtK, recallAtK, reciprocalRank } from "./metrics.js";

export const KS = [1, 3, 5, 10];

export interface PerQuestion {
  id: string;
  type: GoldenItem["type"];
  recall: Record<number, number>;
  mrr: number;
  ndcg10: number;
  top: string[];
}

export interface ModeResult {
  mode: RetrievalMode;
  recall: Record<number, number>;
  mrr: number;
  ndcg10: number;
  byType: Record<string, Record<number, number>>;
  perQuestion: PerQuestion[];
}

export async function evaluateRetrieval(retriever: Retriever, golden: GoldenItem[], mode: RetrievalMode): Promise<ModeResult> {
  const answerable = golden.filter((g) => g.evidence.length);
  const perQuestion: PerQuestion[] = [];
  for (const g of answerable) {
    const hits = await retriever.search(g.question, Math.max(...KS), mode);
    const ranked = hits.map((h) => h.chunk);
    perQuestion.push({
      id: g.id,
      type: g.type,
      recall: Object.fromEntries(KS.map((k) => [k, recallAtK(ranked, g.evidence, k)])),
      mrr: reciprocalRank(ranked, g.evidence),
      ndcg10: ndcgAtK(ranked, g.evidence, 10),
      top: ranked.slice(0, 5).map((c) => c.id),
    });
  }
  const byType: ModeResult["byType"] = {};
  for (const t of new Set(perQuestion.map((p) => p.type))) {
    const rows = perQuestion.filter((p) => p.type === t);
    byType[t] = Object.fromEntries(KS.map((k) => [k, mean(rows.map((r) => r.recall[k]))]));
  }
  return {
    mode,
    recall: Object.fromEntries(KS.map((k) => [k, mean(perQuestion.map((p) => p.recall[k]))])),
    mrr: mean(perQuestion.map((p) => p.mrr)),
    ndcg10: mean(perQuestion.map((p) => p.ndcg10)),
    byType,
    perQuestion,
  };
}

export function formatTable(rows: { label: string; r: ModeResult }[]): string {
  const head = `| config | ${KS.map((k) => `R@${k}`).join(" | ")} | MRR@10 | nDCG@10 |`;
  const sep = `|---|${KS.map(() => "---").join("|")}|---|---|`;
  const body = rows.map(
    ({ label, r }) => `| ${label} | ${KS.map((k) => r.recall[k].toFixed(3)).join(" | ")} | ${r.mrr.toFixed(3)} | ${r.ndcg10.toFixed(3)} |`,
  );
  return [head, sep, ...body].join("\n");
}
