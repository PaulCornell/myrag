// Maps elements from the open-source `unstructured` library (written by scripts/partition.py)
// onto the pipeline's Block format. unstructured does the layout work; this layer fixes what it
// leaves behind on these documents: page furniture classified as Title, unrepaired hyphenation,
// over-eager Title detection, flat heading depth in PDFs, and paragraphs split at page breaks.
import { parse } from "node-html-parser";
import type { Block } from "../types.js";
import { boilerplateKey, collectHyphenatedVocab, isPageNumberLine, normalizeText, repairInlineHyphenation } from "./clean.js";

export interface UnstructuredElement {
  type: string;
  element_id: string;
  text: string;
  metadata: {
    page_number?: number;
    category_depth?: number;
    text_as_html?: string;
    emphasized_text_contents?: string[];
    emphasized_text_tags?: string[];
  };
}

const DROP_TYPES = new Set(["Header", "Footer", "PageBreak", "PageNumber", "Image"]);
const NUMBERED_HEADING_RE = /^(\d+(?:\.\d+)*)\.?\s+[A-Z]/;
const MAJOR_UNNUMBERED_RE = /^(appendix|annex|part)\s+[A-Z0-9]+\b|^(executive summary|introduction|references|glossary)$/i;
const NOISE_RE = /^(continued on next page|this page intentionally left blank)$/i;

export function elementsToBlocks(elements: UnstructuredElement[]): { blocks: Block[]; stats: Record<string, number> } {
  const stats: Record<string, number> = { elements: elements.length };
  const count = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

  const vocab = collectHyphenatedVocab(elements.map((e) => e.text));
  const tocPages = findTocPages(elements);
  const repeated = repeatedShortLines(elements);
  // A "title" that recurs on several pages is a repeated table header ("Action ID Suggested Action").
  const titleCounts = new Map<string, number>();
  for (const e of elements) if (e.type === "Title") titleCounts.set(e.text.trim(), (titleCounts.get(e.text.trim()) ?? 0) + 1);
  stats.tocPagesSkipped = tocPages.size;

  const blocks: Block[] = [];
  for (const el of elements) {
    const page = el.metadata.page_number;
    const text = repairInlineHyphenation(normalizeText(el.text), vocab);
    if (DROP_TYPES.has(el.type)) {
      count(`dropped${el.type}`);
      continue;
    }
    if (!text || isPageNumberLine(text) || NOISE_RE.test(text) || (page !== undefined && tocPages.has(page))) {
      count("droppedFurniture");
      continue;
    }
    if (repeated.has(boilerplateKey(text))) {
      count("droppedRepeated");
      continue;
    }

    if (el.type === "Table") {
      blocks.push({ type: "table", text: tableText(el, text, count), page });
      continue;
    }
    const level = (titleCounts.get(el.text.trim()) ?? 0) >= 3 ? 0 : headingLevel(el, text);
    if (level) {
      blocks.push({ type: "heading", text, level, page });
    } else if (el.type === "ListItem" || /^([•●▪◦○■□➢►–-]|o)\s+\S/.test(text)) {
      blocks.push({ type: "list_item", text, page });
    } else {
      blocks.push({ type: "paragraph", text, page });
    }
  }

  const merged = mergePageSplitParagraphs(blocks);
  stats.headings = merged.filter((b) => b.type === "heading").length;
  stats.tables = merged.filter((b) => b.type === "table").length;
  stats.blocks = merged.length;
  return { blocks: merged, stats };
}

function headingLevel(el: UnstructuredElement, text: string): number {
  const fullyBold = isFullyBold(el, text);
  if (el.type !== "Title" && !fullyBold) return 0;
  if (text.length > 120 || !/[A-Za-z]{3}/.test(text)) return 0;
  if (/^([•●▪◦○■□➢►–-]|o)\s/.test(text)) return 0; // bullets misread as titles ("o GV.SC-02: …")
  // "The GOVERN function:" and "Categories" are lead-ins and table column headers, not sections.
  if (/[:;,]$/.test(text) || (/\.$/.test(text) && !NUMBERED_HEADING_RE.test(text))) return 0;
  const numbered = text.match(NUMBERED_HEADING_RE);
  if (numbered) return Math.min(numbered[1].split(".").length, 4);
  if (MAJOR_UNNUMBERED_RE.test(text)) return 1;
  // Word files carry real heading depth; PDFs don't, so unnumbered PDF titles are treated as minor.
  if (el.metadata.category_depth !== undefined && el.type === "Title") return el.metadata.category_depth + 1;
  return fullyBold && el.type !== "Title" ? 5 : 4;
}

/** Short Word paragraphs set entirely in bold act as headings in government templates. */
function isFullyBold(el: UnstructuredElement, text: string): boolean {
  const { emphasized_text_contents: contents, emphasized_text_tags: tags } = el.metadata;
  if (!contents?.length || !tags?.length || text.length > 100) return false;
  if (!tags.every((t) => t === "b")) return false;
  return normalizeText(contents.join(" ")).replace(/\s+/g, "") === text.replace(/\s+/g, "");
}

/**
 * Best available text for a table element.
 *
 * With hi_res, unstructured builds the row/column grid (text_as_html) from the page *image*, so
 * cell text carries OCR errors ("Al" for "AI", stray characters), while the element's flat `text`
 * comes from the PDF text layer: exact words, but no structure. We keep the grid and re-fill each
 * cell with the matching span of text-layer words. Cells appear in the flat text in row-major
 * order, so each cell is located by anchoring a few of its OCR words at or after the previous
 * cell's position. If too many cells can't be anchored, or the grid lost a large share of the
 * words, the flat text is used instead. Word tables (no OCR) align trivially.
 */
function tableText(el: UnstructuredElement, flat: string, count: (k: string) => void): string {
  const rows = el.metadata.text_as_html ? htmlTableToRows(el.metadata.text_as_html) : [];
  const gridChars = rows.flat().join("").replace(/\s/g, "").length;
  if (!rows.length || gridChars < flat.replace(/\s/g, "").length * 0.6) {
    count("tablesFlatFallback");
    return flat;
  }
  const { rows: aligned, unanchored, total } = realignCells(rows, flat);
  if (unanchored > total * 0.3) {
    count("tablesFlatFallback");
    return flat;
  }
  count(unanchored ? "tablesPartlyRealigned" : "tablesRealigned");
  return aligned.map((r) => r.filter(Boolean).join(" | ")).filter(Boolean).join("\n");
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

export function realignCells(rows: string[][], flat: string): { rows: string[][]; unanchored: number; total: number } {
  const words = flat.split(/\s+/).filter(Boolean);
  const keys = words.map(norm);
  const cells = rows.flatMap((r, ri) => r.map((c, ci) => ({ ri, ci, text: c })));
  const starts: (number | null)[] = [];
  let pos = 0;
  for (const cell of cells) {
    const cw = cell.text.split(/\s+/).map(norm).filter(Boolean);
    starts.push(null);
    if (!cw.length) continue;
    // Try anchors from the first few cell words: two consecutive words (or one, for 1-word cells).
    outer: for (let a = 0; a < Math.min(4, cw.length); a++) {
      const need = cw.length - a >= 2 ? 2 : 1;
      for (let j = pos; j + need <= keys.length && j < pos + 400; j++) {
        if (keys[j] === cw[a] && (need === 1 || keys[j + 1] === cw[a + 1])) {
          const start = Math.max(pos, j - a);
          starts[starts.length - 1] = start;
          pos = start + 1;
          break outer;
        }
      }
    }
  }
  const out = rows.map((r) => r.map(() => ""));
  let unanchored = 0;
  let total = 0;
  for (let i = 0; i < cells.length; i++) {
    const { ri, ci, text } = cells[i];
    if (!text.trim()) continue;
    total++;
    const start = starts[i];
    if (start === null) {
      unanchored++;
      out[ri][ci] = text;
      continue;
    }
    const next = starts.slice(i + 1).find((s): s is number => s !== null) ?? words.length;
    out[ri][ci] = words.slice(start, Math.max(start + 1, next)).join(" ");
  }
  return { rows: out, unanchored, total };
}

function htmlTableToRows(html: string): string[][] {
  return parse(html)
    .querySelectorAll("tr")
    .map((tr) => tr.querySelectorAll("td, th").map((c) => normalizeText(c.textContent)));
}

/** Pages where most elements end in a bare page number are tables of contents / lists of figures. */
function findTocPages(elements: UnstructuredElement[]): Set<number> {
  const byPage = new Map<number, string[]>();
  for (const e of elements) {
    const p = e.metadata.page_number;
    if (p === undefined) continue;
    byPage.set(p, [...(byPage.get(p) ?? []), e.text.trim()]);
  }
  const toc = new Set<number>();
  for (const [p, texts] of byPage) {
    const tocLike = texts.filter((t) => /\S\s+\.{0,}\s*\d{1,3}$/.test(t) && t.length < 150).length;
    const titled = texts.some((t) => /^(table of )?contents$|^list of (tables|figures)$/i.test(t));
    if (tocLike >= 5 && (tocLike / texts.length > 0.4 || titled)) toc.add(p);
  }
  return toc;
}

/** Short lines repeated on many pages are running headers/footers unstructured didn't label. */
function repeatedShortLines(elements: UnstructuredElement[]): Set<string> {
  const pagesByKey = new Map<string, Set<number>>();
  const pages = new Set<number>();
  for (const e of elements) {
    const p = e.metadata.page_number;
    if (p === undefined || e.text.length > 80) continue;
    pages.add(p);
    const k = boilerplateKey(normalizeText(e.text));
    if (!pagesByKey.has(k)) pagesByKey.set(k, new Set());
    pagesByKey.get(k)!.add(p);
  }
  const threshold = Math.max(4, Math.floor(pages.size * 0.3));
  return new Set([...pagesByKey].filter(([, ps]) => ps.size >= threshold).map(([k]) => k));
}

/** unstructured ends a paragraph at every page break; rejoin ones that continue mid-sentence. */
function mergePageSplitParagraphs(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (
      prev &&
      b.type === "paragraph" &&
      (prev.type === "paragraph" || prev.type === "list_item") &&
      prev.page !== undefined &&
      b.page === prev.page + 1 &&
      !/[.!?:;"')\]]$/.test(prev.text) &&
      /^[a-z(]/.test(b.text)
    ) {
      prev.text += " " + b.text;
    } else {
      out.push({ ...b });
    }
  }
  return out;
}
