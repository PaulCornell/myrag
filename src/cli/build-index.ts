// Chunks parsed documents, embeds them locally, and writes them to Postgres/pgvector.
import fs from "node:fs/promises";
import path from "node:path";
import { chunkDocument, contextualText, estimateTokens } from "../chunk.js";
import { CHUNK_OVERLAP_TOKENS, CHUNK_TARGET_TOKENS, DATABASE_URL, EMBED_MODEL, PARSED_DIR } from "../config.js";
import { loadCorpus } from "../corpus.js";
import { embedPassages } from "../embed.js";
import { PgStore } from "../store.js";
import type { Chunk, ParsedDoc } from "../types.js";

const chunking = { targetTokens: CHUNK_TARGET_TOKENS, overlapTokens: CHUNK_OVERLAP_TOKENS };
const docs: ParsedDoc[] = [];
const chunks: Chunk[] = [];
for (const entry of await loadCorpus()) {
  const doc: ParsedDoc = JSON.parse(await fs.readFile(path.join(PARSED_DIR, `${entry.id}.json`), "utf8"));
  const docChunks = chunkDocument(doc, chunking);
  const sizes = docChunks.map((c) => estimateTokens(c.text)).sort((a, b) => a - b);
  console.log(
    `${entry.id.padEnd(24)} ${String(docChunks.length).padStart(4)} chunks, ` +
      `median ${sizes[Math.floor(sizes.length / 2)]} tok, max ${sizes[sizes.length - 1]} tok`,
  );
  docs.push(doc);
  chunks.push(...docChunks);
}

console.log(`Embedding ${chunks.length} chunks with ${EMBED_MODEL}…`);
const t0 = Date.now();
const vectors = await embedPassages(chunks.map(contextualText), 16, (n) => process.stdout.write(`\r  ${n}/${chunks.length}`));
console.log(`\n  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const store = await PgStore.connect();
await store.reset(vectors[0].length);
await store.write(docs, chunks, vectors, chunking);
await store.close();
console.log(`Wrote ${chunks.length} chunks to ${DATABASE_URL.replace(/\/\/[^@]*@/, "//")}`);
