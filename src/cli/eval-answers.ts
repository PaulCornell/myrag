// End-to-end generation eval: retrieve -> answer with citations -> judge.
//   npm run eval:answers [-- --limit 5 --k 6 --concurrency 4]
// Metrics:
//   faithfulness        mean share of answer claims supported by the retrieved context (LLM judge)
//   correctness         share of answers judged correct vs. the human reference (partial = 0.5)
//   citation_coverage   share of answers to answerable questions that carry ≥1 citation
//   citation_precision  share of citations that point at a chunk containing gold evidence
//   abstention          unanswerable questions correctly declined / answerable questions wrongly declined
//   citation_support    local models only: share of [n] markers whose claim the cited passage contains
//
// Uses LLM_PROVIDER / JUDGE_PROVIDER (default: free local Ollama). A local judge is a rough grader;
// for trustworthy scores run once with JUDGE_PROVIDER=anthropic and save with --reference, which
// writes to eval/reference/ (committed) so others see the results without paying for a run.
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { answerQuestion, type Answer } from "../answer.js";
import { ANSWER_MODEL, JUDGE_MODEL, JUDGE_PROVIDER, LLM_PROVIDER, REFERENCE_DIR, RESULTS_DIR } from "../config.js";
import { loadGolden, type GoldenItem } from "../eval/golden.js";
import { judgeCorrectness, judgeFaithfulness, type CorrectnessResult, type FaithfulnessResult } from "../eval/judge.js";
import { isRelevant, mean, recallAtK } from "../eval/metrics.js";
import { UsageMeter } from "../llm.js";
import { OllamaUnavailableError } from "../ollama.js";
import { Retriever, type RetrievalMode } from "../retrieve.js";
import { PgStore } from "../store.js";
import type { RetrievedChunk } from "../types.js";

const { values } = parseArgs({
  options: {
    limit: { type: "string" },
    k: { type: "string", default: "6" },
    mode: { type: "string", default: "hybrid+rerank" },
    // Local models run one request at a time on a laptop; parallel requests just queue in Ollama.
    concurrency: { type: "string", default: LLM_PROVIDER === "ollama" || JUDGE_PROVIDER === "ollama" ? "1" : "4" },
    reference: { type: "boolean", default: false },
  },
});
const k = Number(values.k);
let golden = await loadGolden();
if (values.limit) golden = golden.slice(0, Number(values.limit));

const store = await PgStore.connect();
const retriever = new Retriever(store);
const answerMeter = new UsageMeter();
const judgeMeter = new UsageMeter();

interface Row {
  id: string;
  type: GoldenItem["type"];
  question: string;
  answer: Answer;
  contextRecall: number;
  faithfulness: FaithfulnessResult;
  correctness: CorrectnessResult;
  citationPrecision: number;
}

// Retrieval runs sequentially (local ONNX models), LLM calls run concurrently.
const retrieved: RetrievedChunk[][] = [];
for (const g of golden) retrieved.push(await retriever.search(g.question, k, values.mode as RetrievalMode));
await store.close();

const rows: Row[] = new Array(golden.length);
const failures: { id: string; error: string }[] = [];
let next = 0;
let done = 0;
async function worker() {
  while (next < golden.length) {
    const i = next++;
    try {
      await evaluateOne(i);
    } catch (err) {
      // One bad model call shouldn't throw away a 25-minute run: record it and keep going.
      // Setup problems (Ollama not running) still stop the run immediately.
      if (err instanceof OllamaUnavailableError) throw err;
      failures.push({ id: golden[i].id, error: err instanceof Error ? err.message : String(err) });
    }
    done++;
    process.stdout.write(`\r  ${done}/${golden.length} answered and judged`);
  }
}

async function evaluateOne(i: number) {
  {
    const g = golden[i];
    const ctx = retrieved[i];
    const answer = await answerQuestion(g.question, ctx, answerMeter);
    const [faithfulness, correctness] = await Promise.all([
      judgeFaithfulness(answer.text, ctx, judgeMeter),
      judgeCorrectness(g.question, g.reference_answer, answer.text, judgeMeter),
    ]);
    const cited = answer.citations.map((c) => ctx.find((rc) => rc.chunk.id === c.chunkId)!.chunk);
    rows[i] = {
      id: g.id,
      type: g.type,
      question: g.question,
      answer,
      contextRecall: recallAtK(ctx.map((r) => r.chunk), g.evidence, k),
      faithfulness,
      correctness,
      citationPrecision: g.evidence.length && cited.length ? cited.filter((c) => isRelevant(c, g.evidence)).length / cited.length : NaN,
    };
  }
}
console.log(
  `Answering ${golden.length} questions with ${ANSWER_MODEL} (${LLM_PROVIDER}), judging with ${JUDGE_MODEL} (${JUDGE_PROVIDER}); k=${k}, ${values.mode}`,
);
if (JUDGE_PROVIDER === "ollama") console.log("Note: a small local judge is a rough grader; treat answer scores as indicative.");
try {
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
} catch (err) {
  if (err instanceof OllamaUnavailableError) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
  throw err;
}
console.log();
const completed = rows.filter(Boolean);
if (failures.length) {
  console.log(`\n⚠ ${failures.length} question(s) failed and are excluded from the scores:`);
  for (const f of failures) console.log(`  ${f.id}: ${f.error}`);
}

const answerable = completed.filter((r) => r.type !== "unanswerable");
const unanswerable = completed.filter((r) => r.type === "unanswerable");
const correctnessScore = (r: Row) => ({ correct: 1, partially_correct: 0.5, incorrect: 0 })[r.correctness.verdict];
const summary = {
  n: completed.length,
  failed: failures.length,
  context_recall_at_k: mean(answerable.map((r) => r.contextRecall)),
  faithfulness: mean(completed.filter((r) => !r.answer.abstained).map((r) => r.faithfulness.score)),
  fully_faithful_answers: mean(completed.filter((r) => !r.answer.abstained && r.faithfulness.claims.length).map((r) => (r.faithfulness.score === 1 ? 1 : 0))),
  correctness: mean(completed.map(correctnessScore)),
  correctness_answerable: mean(answerable.map(correctnessScore)),
  citation_coverage: mean(answerable.filter((r) => !r.answer.abstained).map((r) => (r.answer.citations.length ? 1 : 0))),
  citation_precision: mean(answerable.map((r) => r.citationPrecision)),
  abstention_on_unanswerable: mean(unanswerable.map((r) => (r.answer.abstained ? 1 : 0))),
  false_abstention_on_answerable: mean(answerable.map((r) => (r.answer.abstained ? 1 : 0))),
  citation_support: mean(completed.map((r) => r.answer.citationSupport ?? NaN)),
};

console.log("\n| metric | value |\n|---|---|");
for (const [key, v] of Object.entries(summary)) console.log(`| ${key} | ${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : v} |`);

const flagged = completed.filter((r) => r.faithfulness.score < 1 || r.correctness.verdict !== "correct");
if (flagged.length) {
  console.log(`\nFlagged for review:`);
  for (const r of flagged) {
    console.log(`  ${r.id} (${r.type}) faithfulness=${Number.isNaN(r.faithfulness.score) ? "n/a" : r.faithfulness.score.toFixed(2)} correctness=${r.correctness.verdict} — ${r.correctness.rationale}`);
    for (const c of r.faithfulness.claims.filter((c) => c.verdict !== "supported")) console.log(`      ${c.verdict}: ${c.claim}`);
  }
}
console.log(`\nCost — answering: ${answerMeter}; judging: ${judgeMeter}`);

const dir = values.reference ? REFERENCE_DIR : RESULTS_DIR;
await fs.mkdir(dir, { recursive: true });
const out = path.join(dir, `answers-${LLM_PROVIDER}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const config = {
  answerProvider: LLM_PROVIDER,
  answerModel: ANSWER_MODEL,
  judgeProvider: JUDGE_PROVIDER,
  judgeModel: JUDGE_MODEL,
  k,
  mode: values.mode,
  costUsd: answerMeter.costUsd + judgeMeter.costUsd,
};
await fs.writeFile(out, JSON.stringify({ config, summary, failures, rows: completed }, null, 2));
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
