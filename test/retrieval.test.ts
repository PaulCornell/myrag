import { describe, expect, it } from "vitest";
import { buildTsQueries, identifierTerms } from "../src/lexical.js";
import { coverage, ndcgAtK, normalizeForMatch, recallAtK, reciprocalRank, shingles } from "../src/eval/metrics.js";
import type { Chunk } from "../src/types.js";

const chunk = (id: string, text: string, docId = "d"): Chunk => ({ id, docId, docTitle: "", section: [], text });

describe("lexical query prep", () => {
  it("compacts control identifiers that Postgres's parser would split", () => {
    expect(identifierTerms("See GV.SC-05 and AC-5.")).toEqual(expect.arrayContaining(["gvsc05", "gvsc", "ac5"]));
  });
  it("ignores ordinary hyphenated words", () => {
    expect(identifierTerms("a risk-based, well-known approach")).toEqual([]);
  });
  it("builds OR'd tsquery strings safe for to_tsquery", () => {
    const q = buildTsQueries("What does GV.SC-05 require?");
    expect(q.english.split(" | ")).toEqual(expect.arrayContaining(["gv", "sc", "05", "require"]));
    expect(q.english).toMatch(/^[a-z0-9 |]+$/);
    expect(q.ids).toBe("gvsc05 | gvsc");
  });
});

describe("retrieval metrics", () => {
  const evidence = [{ docId: "d", text: "the core is composed of four functions govern map measure and manage" }];
  const relevant = chunk("r", "Intro. The Core is composed of four functions: GOVERN, MAP, MEASURE, and MANAGE. More text.");
  const other = chunk("o", "Unrelated passage about cryptography modules.");

  it("matches evidence regardless of punctuation and case", () => {
    expect(coverage(evidence[0].text, shingles(normalizeForMatch(relevant.text)))).toBe(1);
  });
  it("computes recall@k, MRR and nDCG from rank position", () => {
    expect(recallAtK([other, relevant], evidence, 1)).toBe(0);
    expect(recallAtK([other, relevant], evidence, 2)).toBe(1);
    expect(reciprocalRank([other, relevant], evidence)).toBe(0.5);
    expect(ndcgAtK([relevant, other], evidence, 10)).toBe(1);
  });
  it("credits evidence split across two retrieved chunks", () => {
    const a = chunk("a", "the core is composed of four functions");
    const b = chunk("b", "functions govern map measure and manage");
    expect(recallAtK([a, b], evidence, 1)).toBe(0);
    expect(recallAtK([a, b], evidence, 2)).toBe(1);
  });
  it("ignores matching text from a different document", () => {
    expect(recallAtK([{ ...relevant, docId: "other" }], evidence, 1)).toBe(0);
  });
});

describe("identifier guard inputs", () => {
  it("distinguishes full identifiers from their prefixes", () => {
    const terms = identifierTerms("What does GV-1.6-001 recommend?");
    expect(terms).toEqual(["gv16001", "gv16"]);
    const full = terms.filter((t) => !terms.some((o) => o !== t && o.startsWith(t)));
    expect(full).toEqual(["gv16001"]);
  });
});
