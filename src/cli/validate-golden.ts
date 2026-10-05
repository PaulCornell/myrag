// Checks every gold evidence quote actually exists in the parsed corpus. Run after re-ingesting:
// a parser change that mangles the text a label points at should fail loudly, not silently lower scores.
import fs from "node:fs/promises";
import path from "node:path";
import { PARSED_DIR } from "../config.js";
import { loadGolden } from "../eval/golden.js";
import { coverage, normalizeForMatch, shingles } from "../eval/metrics.js";
import type { ParsedDoc } from "../types.js";

const docs = new Map<string, Set<string>>();
let failures = 0;
for (const item of await loadGolden()) {
  for (const e of item.evidence) {
    if (!docs.has(e.docId)) {
      const doc: ParsedDoc = JSON.parse(await fs.readFile(path.join(PARSED_DIR, `${e.docId}.json`), "utf8"));
      docs.set(e.docId, shingles(normalizeForMatch(doc.blocks.map((b) => b.text).join(" "))));
    }
    const cov = coverage(e.text, docs.get(e.docId)!);
    if (cov < 0.95) {
      failures++;
      console.log(`✗ ${item.id} [${e.docId}] coverage ${cov.toFixed(2)}: "${e.text.slice(0, 80)}…"`);
    }
  }
}
console.log(failures ? `${failures} evidence quote(s) not found in parsed corpus` : "✓ all evidence quotes found in parsed corpus");
process.exitCode = failures ? 1 : 0;
