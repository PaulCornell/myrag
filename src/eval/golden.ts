import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../config.js";

export interface Evidence {
  docId: string;
  text: string;
}

export interface GoldenItem {
  id: string;
  type: "factoid" | "list" | "identifier" | "paraphrase" | "multi_hop" | "unanswerable";
  question: string;
  evidence: Evidence[];
  reference_answer: string;
}

export async function loadGolden(file = path.join(ROOT, "eval", "golden.jsonl")): Promise<GoldenItem[]> {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
