// Downloads the corpus listed in corpus.json into data/raw/.
import fs from "node:fs/promises";
import path from "node:path";
import { RAW_DIR } from "../config.js";
import { loadCorpus } from "../corpus.js";

const corpus = await loadCorpus();
await fs.mkdir(RAW_DIR, { recursive: true });

for (const doc of corpus) {
  const dest = path.join(RAW_DIR, `${doc.id}.${doc.format}`);
  try {
    await fs.access(dest);
    console.log(`✓ ${doc.id} (cached)`);
    continue;
  } catch {}
  const res = await fetch(doc.url, { headers: { "User-Agent": "Mozilla/5.0 (myrag corpus fetcher)" } });
  if (!res.ok) {
    console.error(`✗ ${doc.id}: HTTP ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  console.log(`↓ ${doc.id} (${(buf.length / 1024).toFixed(0)} KB)`);
}
