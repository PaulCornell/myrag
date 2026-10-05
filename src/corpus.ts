import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./config.js";

export interface CorpusEntry {
  id: string;
  title: string;
  url: string;
  format: "pdf" | "docx";
}

export async function loadCorpus(): Promise<CorpusEntry[]> {
  return JSON.parse(await fs.readFile(path.join(ROOT, "corpus.json"), "utf8"));
}
