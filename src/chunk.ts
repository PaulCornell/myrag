// Structure-aware chunking: chunks never span a section boundary, carry their heading
// breadcrumb and page range, and overlap by a few sentences inside a section.
import type { Block, Chunk, ParsedDoc } from "./types.js";

export interface ChunkOptions {
  targetTokens: number;
  overlapTokens: number;
}

/** Headings at this depth or deeper (run-in bold subheads, table titles) don't force a chunk break. */
const MINOR_HEADING_LEVEL = 4;

/** Cheap token estimate (~0.75 words/token for English prose); good enough for sizing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.33);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z("[])|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Unit {
  text: string;
  page?: number;
  tokens: number;
}

/** Break a block into units no larger than the target (tables by row, prose by sentence). */
function blockUnits(b: Block, max: number): Unit[] {
  const whole = { text: b.text, page: b.page, tokens: estimateTokens(b.text) };
  if (whole.tokens <= max) return [whole];
  const parts = b.type === "table" ? b.text.split("\n") : splitSentences(b.text);
  const units: Unit[] = [];
  for (const p of parts) {
    const t = estimateTokens(p);
    if (t <= max) {
      units.push({ text: p, page: b.page, tokens: t });
      continue;
    }
    // Pathological run-on text (no sentence breaks): hard-split by words.
    const words = p.split(/\s+/);
    const step = Math.floor(max / 1.33);
    for (let i = 0; i < words.length; i += step) {
      const text = words.slice(i, i + step).join(" ");
      units.push({ text, page: b.page, tokens: estimateTokens(text) });
    }
  }
  return units;
}

export function chunkDocument(doc: ParsedDoc, opts: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  const headings: { level: number; text: string }[] = [];
  let current: Unit[] = [];
  let currentTokens = 0;
  let currentSection: string[] = [];

  const section = () => headings.map((h) => h.text);
  const emit = () => {
    if (!current.length) return;
    const pages = current.map((u) => u.page).filter((p): p is number => p !== undefined);
    chunks.push({
      id: `${doc.id}#${chunks.length}`,
      docId: doc.id,
      docTitle: doc.title,
      section: currentSection,
      pageStart: pages.length ? Math.min(...pages) : undefined,
      pageEnd: pages.length ? Math.max(...pages) : undefined,
      text: current.map((u) => u.text).join("\n"),
    });
  };

  for (const b of doc.blocks) {
    let text = b.type === "list_item" ? `- ${b.text.replace(/^[•●▪◦○■□➢►–-]\s*/, "")}` : b.text;
    if (b.type === "heading") {
      const level = b.level ?? 1;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, text: b.text });
      // Major headings start a new chunk. Minor ones stay inline so tiny subsections
      // ("Accountability" + two sentences) merge with their siblings instead of becoming 30-token chunks.
      if (level < MINOR_HEADING_LEVEL || currentTokens >= opts.targetTokens * 0.5) {
        emit();
        current = [];
        currentTokens = 0;
        continue;
      }
      text = `${b.text}:`;
    }
    for (const u of blockUnits({ ...b, text }, opts.targetTokens)) {
      if (currentTokens + u.tokens > opts.targetTokens && current.length) {
        emit();
        // Overlap: carry trailing units (up to overlapTokens) into the next chunk.
        const carry: Unit[] = [];
        let carried = 0;
        for (let i = current.length - 1; i >= 0 && carried + current[i].tokens <= opts.overlapTokens; i--) {
          carry.unshift(current[i]);
          carried += current[i].tokens;
        }
        // Drop the overlap if it would push the next chunk over target.
        current = carried + u.tokens <= opts.targetTokens ? carry : [];
        currentTokens = current.length ? carried : 0;
      }
      if (!current.length) currentSection = section();
      current.push(u);
      currentTokens += u.tokens;
    }
  }
  emit();
  return chunks.filter((c) => estimateTokens(c.text) >= 8);
}

/**
 * Text that gets embedded/indexed: the chunk prefixed with its document title and section path.
 * A chunk that says "This function..." is unretrievable without knowing it sits under "5.1 Govern".
 */
export function contextualText(c: Chunk): string {
  const crumb = [c.docTitle, ...c.section].join(" > ");
  return `${crumb}\n${c.text}`;
}
