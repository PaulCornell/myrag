import { describe, expect, it } from "vitest";
import { bestSentence, CitationTracker, lastClaim, supportScore } from "../src/citations.js";
import type { RetrievedChunk } from "../src/types.js";

const rc = (id: string, text: string): RetrievedChunk => ({
  chunk: { id, docId: id.split("#")[0], docTitle: "Doc", section: ["S"], pageStart: 3, pageEnd: 3, text },
  score: 1,
  rank: 1,
});
const retrieved = [
  rc("a#0", "Notional Illustration of the CSF Tiers.\nTier 1 is Partial. Tier 2 is Risk Informed. Tier 3 is Repeatable. Tier 4 is Adaptive."),
  rc("b#1", "The GOVERN function is cross-cutting and informs the other functions."),
];

function run(chunks: string[]) {
  let text = "";
  const events: string[] = [];
  const t = new CitationTracker(
    retrieved,
    (x) => {
      text += x;
      events.push(x);
    },
    () => {},
  );
  for (const c of chunks) t.push(c);
  t.flush();
  return { text, events, t };
}

describe("CitationTracker", () => {
  it("renumbers passages by first citation and never emits a half marker", () => {
    const { text, events, t } = run(["GOVERN is cross-cutting [", "2]. The tiers are Partial and Adaptive [1", "]."]);
    expect(text).toBe("GOVERN is cross-cutting [1]. The tiers are Partial and Adaptive [2].");
    expect(events.some((e) => /\[\d?$/.test(e))).toBe(false);
    expect(t.citations.map((c) => c.chunkId)).toEqual(["b#1", "a#0"]);
  });
  it("verifies claims against the cited passage and flags unsupported ones", () => {
    const { t } = run(["The tiers are Partial, Risk Informed, Repeatable and Adaptive [1]. Budgets must be approved by Congress [2]."]);
    expect(t.citations[0].verified).toBe(true);
    expect(t.citations[1].verified).toBe(false);
    expect(t.supportedUses).toBe(1);
    expect(t.totalUses).toBe(2);
  });
  it("drops markers that point at passages that don't exist", () => {
    const { text, t } = run(["Something about tiers [7]."]);
    expect(text).toBe("Something about tiers .");
    expect(t.invalidMarkers).toBe(1);
  });
  it("accepts grouped and labelled markers", () => {
    const { text } = run(["Both apply [1, 2]. Also [Passage 2]."]);
    expect(text).toBe("Both apply [1][2]. Also [2].");
  });
});

describe("citation helpers", () => {
  it("scores support by shared content words", () => {
    expect(supportScore("Tier 4 is Adaptive", retrieved[0].chunk.text)).toBe(1);
    expect(supportScore("Budgets need congressional approval", retrieved[0].chunk.text)).toBe(0);
  });
  it("picks the passage sentence that contains the most claim words", () => {
    expect(bestSentence("Tier 4 is called Adaptive", retrieved[0].chunk.text)).toBe("Tier 4 is Adaptive.");
  });
  it("takes the last sentence before a marker as the claim", () => {
    expect(lastClaim("First point here. Second point is this one ")).toBe("Second point is this one");
  });
});
