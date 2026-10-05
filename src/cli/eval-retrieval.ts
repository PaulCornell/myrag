// Retrieval eval: recall@k / MRR / nDCG for lexical vs dense vs hybrid vs hybrid+rerank.
//   npm run eval:retrieval                  # main index (public schema)
//   npm run eval:retrieval -- --sweep       # also build throwaway indexes at several chunk sizes
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chunkDocument, contextualText } from "../chunk.js";
import { EMBED_MODEL, PARSED_DIR, REFERENCE_DIR, RESULTS_DIR } from "../config.js";
import { loadCorpus } from "../corpus.js";
import { embedPassages } from "../embed.js";
import { loadGolden } from "../eval/golden.js";
import { evaluateRetrieval, formatTable, KS, type ModeResult } from "../eval/retrieval.js";
import { Retriever, RETRIEVAL_MODES } from "../retrieve.js";
import { PgStore } from "../store.js";
import type { ParsedDoc } from "../types.js";

const { values } = parseArgs({ options: { sweep: { type: "boolean", default: false }, reference: { type: "boolean", default: false } } });
const golden = await loadGolden();
const store = await PgStore.connect();
const meta = await store.meta();
const retriever = new Retriever(store);
console.log(`Golden set: ${golden.length} questions (${golden.filter((g) => g.evidence.length).length} answerable)`);
console.log(`Index: ${meta.count} chunks, ${meta.chunking.targetTokens}-token target, ${EMBED_MODEL}, pgvector\n`);

const results: { label: string; r: ModeResult }[] = [];
for (const mode of RETRIEVAL_MODES) results.push({ label: mode, r: await evaluateRetrieval(retriever, golden, mode) });
await store.close();
console.log(formatTable(results));

const best = results.find((x) => x.label === "hybrid+rerank")!.r;
console.log(`\nhybrid+rerank recall by question type:`);
console.log(`| type | n | ${KS.map((k) => `R@${k}`).join(" | ")} |\n|---|---|${KS.map(() => "---").join("|")}|`);
for (const [t, rec] of Object.entries(best.byType)) {
  const n = best.perQuestion.filter((p) => p.type === t).length;
  console.log(`| ${t} | ${n} | ${KS.map((k) => rec[k].toFixed(3)).join(" | ")} |`);
}
const misses = best.perQuestion.filter((p) => p.recall[5] < 1);
if (misses.length) {
  console.log(`\nhybrid+rerank misses at k=5 (debug with: npm run search -- "<question>"):`);
  for (const m of misses) console.log(`  ${m.id} (${m.type}) R@5=${m.recall[5].toFixed(2)} R@10=${m.recall[10].toFixed(2)} top: ${m.top.slice(0, 3).join(", ")}`);
}

const sweep: { label: string; r: ModeResult }[] = [];
if (values.sweep) {
  console.log(`\nChunk-size sweep (hybrid+rerank; each size indexed into its own throwaway schema):`);
  const docs: ParsedDoc[] = [];
  for (const e of await loadCorpus()) docs.push(JSON.parse(await fs.readFile(path.join(PARSED_DIR, `${e.id}.json`), "utf8")));
  for (const targetTokens of [150, 250, 350, 500, 800]) {
    const chunking = { targetTokens, overlapTokens: Math.round(targetTokens * 0.15) };
    const chunks = docs.flatMap((d) => chunkDocument(d, chunking));
    const vectors = await embedPassages(chunks.map(contextualText));
    const sweepStore = await PgStore.connect(`sweep_${targetTokens}`);
    let r: ModeResult;
    try {
      await sweepStore.reset(vectors[0].length);
      await sweepStore.write(docs, chunks, vectors, chunking);
      r = await evaluateRetrieval(new Retriever(sweepStore), golden, "hybrid+rerank");
    } finally {
      await sweepStore.dropSchema();
      await sweepStore.close();
    }
    sweep.push({ label: `${targetTokens} tok (${chunks.length} chunks)`, r });
    console.log(`  ${targetTokens} tok: R@5=${r.recall[5].toFixed(3)} MRR=${r.mrr.toFixed(3)}`);
  }
  console.log("\n" + formatTable(sweep));
}

const dir = values.reference ? REFERENCE_DIR : RESULTS_DIR;
await fs.mkdir(dir, { recursive: true });
const out = path.join(dir, `retrieval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await fs.writeFile(out, JSON.stringify({ meta, results, sweep }, null, 2));
console.log(`\nWrote ${path.relative(process.cwd(), out)}`);
