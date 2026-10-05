import { describe, expect, it } from "vitest";
import { chunkDocument, contextualText, estimateTokens } from "../src/chunk.js";
import type { ParsedDoc } from "../src/types.js";

const sentence = (i: number) => `Sentence number ${i} talks about risk management outcomes in detail.`;
const doc: ParsedDoc = {
  id: "d",
  title: "Doc",
  format: "pdf",
  sourceUrl: "",
  stats: {},
  blocks: [
    { type: "heading", text: "1. Intro", level: 1, page: 1 },
    { type: "paragraph", text: Array.from({ length: 30 }, (_, i) => sentence(i)).join(" "), page: 1 },
    { type: "heading", text: "1.1 Detail", level: 2, page: 2 },
    { type: "paragraph", text: "Short detail paragraph.", page: 2 },
    { type: "heading", text: "Run-in subhead", level: 5, page: 2 },
    { type: "paragraph", text: "Text under the subhead.", page: 3 },
  ],
};

describe("chunkDocument", () => {
  const chunks = chunkDocument(doc, { targetTokens: 80, overlapTokens: 20 });

  it("respects the size target", () => {
    for (const c of chunks) expect(estimateTokens(c.text)).toBeLessThanOrEqual(80);
  });
  it("never crosses a major heading and records the breadcrumb", () => {
    const detail = chunks.filter((c) => c.text.includes("Short detail"));
    expect(detail).toHaveLength(1);
    expect(detail[0].section).toEqual(["1. Intro", "1.1 Detail"]);
    expect(detail[0].text).not.toContain("Sentence number");
  });
  it("folds minor headings into the surrounding chunk with a page range", () => {
    const c = chunks.find((c) => c.text.includes("Run-in subhead:"))!;
    expect(c.text).toContain("Short detail");
    expect([c.pageStart, c.pageEnd]).toEqual([2, 3]);
  });
  it("overlaps consecutive chunks within a section", () => {
    const intro = chunks.filter((c) => c.section.length === 1);
    expect(intro.length).toBeGreaterThan(1);
    const lastSentence = intro[0].text.split("\n").at(-1)!;
    expect(intro[1].text.startsWith(lastSentence)).toBe(true);
  });
  it("prefixes the doc title and section path for embedding", () => {
    expect(contextualText(chunks[0]).split("\n")[0]).toBe("Doc > 1. Intro");
  });
});
