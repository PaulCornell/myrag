// Maps unstructured's partitioned elements (data/unstructured/, written by `npm run partition`)
// to structured blocks in data/parsed/<id>.json, and prints per-document diagnostics.
import fs from "node:fs/promises";
import path from "node:path";
import { PARSED_DIR, UNSTRUCTURED_DIR } from "../config.js";
import { loadCorpus } from "../corpus.js";
import { elementsToBlocks, type UnstructuredElement } from "../ingest/unstructured.js";
import type { ParsedDoc } from "../types.js";

await fs.mkdir(PARSED_DIR, { recursive: true });
const report: Record<string, Record<string, number | string>> = {};

for (const entry of await loadCorpus()) {
  const file = path.join(UNSTRUCTURED_DIR, `${entry.id}.json`);
  let partitioned: { strategy: string; elements: UnstructuredElement[] };
  try {
    partitioned = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    console.error(`✗ ${entry.id}: no partitioned output at ${path.relative(process.cwd(), file)}; run \`npm run partition\``);
    process.exitCode = 1;
    continue;
  }
  const { blocks, stats } = elementsToBlocks(partitioned.elements);
  stats.chars = blocks.reduce((n, b) => n + b.text.length, 0);
  const doc: ParsedDoc = { id: entry.id, title: entry.title, format: entry.format, sourceUrl: entry.url, blocks, stats };
  await fs.writeFile(path.join(PARSED_DIR, `${entry.id}.json`), JSON.stringify(doc, null, 2));
  report[entry.id] = { strategy: partitioned.strategy, ...stats };
}
console.table(report);
