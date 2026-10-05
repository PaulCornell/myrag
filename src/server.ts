// HTTP API for the web UI. Reuses the pipeline modules directly; no logic lives here.
//   GET  /api/health
//   GET  /api/documents            corpus documents (title, source URL, ingest stats)
//   POST /api/ask                  { question, k? } -> server-sent events:
//                                  sources (retrieved chunks + rank trace), text, citation, done, error
//   GET  /api/evals                eval runs (local + committed reference), newest first
//   GET  /api/evals/:source/:file  one run; source is "local" or "reference"
//   GET  /api/golden               the golden question set
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { answerQuestion } from "./answer.js";
import { ANSWER_MODEL, LLM_PROVIDER, OLLAMA_URL, REFERENCE_DIR, RESULTS_DIR, ROOT } from "./config.js";
import { loadGolden } from "./eval/golden.js";
import { UsageMeter } from "./llm.js";
import { OllamaUnavailableError } from "./ollama.js";
import { searchWithTrace } from "./retrieve.js";
import { PgStore } from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
// The SDK can also authenticate via an `ant auth login` profile, so this is a hint, not a hard check.
const CREDENTIALS_HINT =
  LLM_PROVIDER !== "anthropic" || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ? null
    : "LLM_PROVIDER=anthropic but no Anthropic credentials found. Set ANTHROPIC_API_KEY, or unset LLM_PROVIDER to use the free local model.";
if (CREDENTIALS_HINT) console.warn(`⚠ ${CREDENTIALS_HINT}`);
if (LLM_PROVIDER === "ollama") {
  const up = await fetch(`${OLLAMA_URL}/api/version`).then((r) => r.ok, () => false);
  console.log(up ? `Answering with ${ANSWER_MODEL} via Ollama (free, local)` : `⚠ Ollama isn't running at ${OLLAMA_URL}: start it with \`brew services start ollama\`. Search still works.`);
}
const store = await PgStore.connect();
const meta = await store.meta();
const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, index: meta, llm: { provider: LLM_PROVIDER, model: ANSWER_MODEL } }));

app.get("/api/documents", async (c) => c.json(await store.documents()));

app.post("/api/ask", async (c) => {
  const body = await c.req.json<{ question?: string; k?: number }>();
  const question = body.question?.trim();
  if (!question) return c.json({ error: "question is required" }, 400);
  if (question.length > 1000) return c.json({ error: "question is too long" }, 400);
  const k = Math.min(Math.max(Number(body.k ?? 6), 1), 12);

  return streamSSE(c, async (sse) => {
    const send = (event: string, data: unknown) => sse.writeSSE({ event, data: JSON.stringify(data) });
    try {
      const started = Date.now();
      const { results, trace } = await searchWithTrace(store, question, k);
      await send("sources", {
        retrievalMs: Date.now() - started,
        sources: results.map((r, i) => ({ ...r, trace: trace[i] })),
      });
      const meter = new UsageMeter();
      const answer = await answerQuestion(question, results, meter, (e) => {
        void send(e.type, e.type === "text" ? { text: e.text } : e.citation);
      });
      await send("done", {
        abstained: answer.abstained,
        model: answer.model,
        provider: answer.provider,
        citations: answer.citations, // final state: local-model verification can firm up after streaming
        citationSupport: answer.citationSupport ?? null,
        stopReason: answer.stopReason,
        usage: { input: meter.input, output: meter.output, costUsd: meter.costUsd },
        totalMs: Date.now() - started,
      });
    } catch (err) {
      console.error(err);
      const message =
        err instanceof OllamaUnavailableError
          ? err.message
          : err instanceof Anthropic.AuthenticationError || (CREDENTIALS_HINT && !(err instanceof Anthropic.APIError))
            ? (CREDENTIALS_HINT ?? "Anthropic rejected the API key. Check ANTHROPIC_API_KEY.")
            : err instanceof Error
              ? err.message
              : String(err);
      await send("error", { message });
    }
  });
});

// Eval runs: your local runs (eval/results/, git-ignored) plus committed reference runs (eval/reference/).
const EVAL_DIRS = { local: RESULTS_DIR, reference: REFERENCE_DIR } as const;

app.get("/api/evals", async (c) => {
  const list = [];
  for (const [source, dir] of Object.entries(EVAL_DIRS)) {
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const raw = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
      list.push({
        file: f,
        source,
        kind: f.split("-")[0],
        mtime: (await fs.stat(path.join(dir, f))).mtime,
        // Answer runs record who answered and who graded; local judges are labelled indicative.
        judge: raw.config ? `${raw.config.judgeModel} (${raw.config.judgeProvider ?? "anthropic"})` : undefined,
        answerer: raw.config ? raw.config.answerModel : undefined,
      });
    }
  }
  return c.json(list.sort((a, b) => +b.mtime - +a.mtime));
});

app.get("/api/evals/:source/:file", async (c) => {
  const dir = EVAL_DIRS[c.req.param("source") as keyof typeof EVAL_DIRS];
  const file = path.basename(c.req.param("file"));
  if (!dir || !file.endsWith(".json")) return c.json({ error: "not found" }, 404);
  try {
    return c.json(JSON.parse(await fs.readFile(path.join(dir, file), "utf8")));
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

app.get("/api/golden", async (c) => c.json(await loadGolden()));

// Production: serve the built UI. In development, Vite serves it and proxies /api here.
const dist = path.join(ROOT, "web", "dist");
app.use("/*", serveStatic({ root: path.relative(process.cwd(), dist) }));
app.get("*", serveStatic({ path: path.relative(process.cwd(), path.join(dist, "index.html")) }));

serve({ fetch: app.fetch, port: PORT }, () => console.log(`API listening on http://localhost:${PORT}`));
