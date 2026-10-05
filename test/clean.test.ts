import { describe, expect, it } from "vitest";
import { boilerplateKey, collectHyphenatedVocab, isPageNumberLine, normalizeText, repairInlineHyphenation } from "../src/ingest/clean.js";

describe("normalizeText", () => {
  it("expands ligatures, straightens quotes, strips zero-width chars", () => {
    expect(normalizeText("conﬁdence “quoted”​  text")).toBe('confidence "quoted" text');
  });
});

describe("page furniture", () => {
  it("recognizes page-number lines", () => {
    for (const s of ["12", "Page 3 of 40", "- 7 -", "iv"]) expect(isPageNumberLine(s)).toBe(true);
    expect(isPageNumberLine("12 risks")).toBe(false);
  });
  it("collapses digits so running footers match across pages", () => {
    expect(boilerplateKey("NIST AI 100-1  Page 3")).toBe(boilerplateKey("NIST AI 100-1 Page 14"));
  });
});

describe("repairInlineHyphenation", () => {
  it("joins words unstructured left broken across lines", () => {
    expect(repairInlineHyphenation("orga- nizational GOV- ERN", new Set())).toBe("organizational GOVERN");
    expect(repairInlineHyphenation("a risk- based plan", new Set(["risk-based"]))).toBe("a risk-based plan");
    expect(repairInlineHyphenation("energy- and carbon", new Set())).toBe("energy- and carbon");
  });
  it("keeps compounds seen elsewhere in the document", () => {
    const vocab = collectHyphenatedVocab(["a risk-based approach"]);
    expect(repairInlineHyphenation("a risk- based plan", vocab)).toBe("a risk-based plan");
  });
});

describe("realignCells", () => {
  it("replaces OCR'd cell text with exact text-layer words, keeping the grid", async () => {
    const { realignCells } = await import("../src/ingest/unstructured.js");
    const rows = [
      ["Action ID", "Suggested Action", "GAI Risks"],
      ["GV-1.6-001", "Enumerate organizational GAI systems for incorporation into Al system inventor . eB . y", "Information Security"],
    ];
    const flat =
      "Action ID Suggested Action GAI Risks GV-1.6-001 Enumerate organizational GAI systems for incorporation into AI system inventory and adjust requirements. Information Security";
    const { rows: out, unanchored } = realignCells(rows, flat);
    expect(unanchored).toBe(0);
    expect(out[1][1]).toBe("Enumerate organizational GAI systems for incorporation into AI system inventory and adjust requirements.");
    expect(out[1][2]).toBe("Information Security");
  });
});
