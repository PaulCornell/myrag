// Debug retrieval from the command line: npm run search -- "query" [--mode bm25|dense|hybrid] [--k 5]
import { parseArgs } from "node:util";
import { Retriever, type RetrievalMode } from "../retrieve.js";
import { PgStore } from "../store.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { mode: { type: "string", default: "hybrid+rerank" }, k: { type: "string", default: "5" } },
});
const store = await PgStore.connect();
const retriever = new Retriever(store);
const hits = await retriever.search(positionals.join(" "), Number(values.k), values.mode as RetrievalMode);
for (const h of hits) {
  const pages = h.chunk.pageStart ? ` p.${h.chunk.pageStart}${h.chunk.pageEnd !== h.chunk.pageStart ? `-${h.chunk.pageEnd}` : ""}` : "";
  console.log(`\n#${h.rank} [${h.score.toFixed(4)}] ${h.chunk.id}${pages} — ${h.chunk.section.join(" > ")}`);
  console.log("   " + h.chunk.text.slice(0, 280).replace(/\n/g, " ") + "…");
}
await store.close();
