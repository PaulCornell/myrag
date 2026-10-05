// npm run ask -- "What are the CSF 2.0 Tiers?" [--k 6] [--mode hybrid+rerank]
import { parseArgs } from "node:util";
import { answerQuestion } from "../answer.js";
import { UsageMeter } from "../llm.js";
import { OllamaUnavailableError } from "../ollama.js";
import { Retriever, type RetrievalMode } from "../retrieve.js";
import { PgStore } from "../store.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { k: { type: "string", default: "6" }, mode: { type: "string", default: "hybrid+rerank" } },
});
const question = positionals.join(" ");
if (!question) {
  console.error('Usage: npm run ask -- "your question"');
  process.exit(1);
}

const store = await PgStore.connect();
const retriever = new Retriever(store);
const retrieved = await retriever.search(question, Number(values.k), values.mode as RetrievalMode);
await store.close();
const meter = new UsageMeter();
console.log();
let answer;
try {
  answer = await answerQuestion(question, retrieved, meter, (e) => {
    if (e.type === "text") process.stdout.write(e.text);
  });
} catch (err) {
  // Setup problems (Ollama not running, model not pulled) get a one-line fix, not a stack trace.
  if (err instanceof OllamaUnavailableError) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
  throw err;
}
console.log("\n");
if (answer.citations.length) {
  console.log("Sources:");
  for (const c of answer.citations) {
    const loc = [c.section.at(-1), c.pages && `p. ${c.pages}`].filter(Boolean).join(", ");
    console.log(`  [${c.n}] ${c.docTitle}${loc ? ` (${loc})` : ""}`);
    console.log(`      "${c.citedText.length > 220 ? c.citedText.slice(0, 220) + "…" : c.citedText}"`);
  }
}
console.log(`\n(${answer.model}; ${meter})`);
