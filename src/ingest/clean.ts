// Text normalization shared by the PDF and Word parsers.

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st",
};

export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c)
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[­​‌‍﻿]/g, "") // soft hyphen, zero-width chars
    .replace(/ /g, " ")
    .replace(/[-]/g, "") // private-use glyphs (bullets/icons from symbol fonts)
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Lines that are only a page number ("12", "Page 12 of 40", "- 12 -", "iv"). */
export function isPageNumberLine(s: string): boolean {
  const t = s.trim();
  return /^(page\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?(\s*(of|\/)\s*\d{1,4})?$/i.test(t) || /^[ivxlcdm]{1,6}$/i.test(t);
}

/** Key used to detect running headers/footers: digits collapsed so "Page 3" and "Page 4" match. */
export function boilerplateKey(s: string): string {
  return s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

const SUSPENDED_HYPHEN_NEXT = new Set(["and", "or", "nor", "to"]);

/** Collect intra-line hyphenated compounds ("risk-based") so dehyphenation can keep them. */
export function collectHyphenatedVocab(lines: string[]): Set<string> {
  const vocab = new Set<string>();
  for (const l of lines) {
    for (const m of l.matchAll(/\b([A-Za-z]+-[a-z]+)\b/g)) vocab.add(m[1].toLowerCase());
  }
  return vocab;
}

/**
 * Repair hyphenation that survived as "design- ing" inside a single string (how `unstructured`
 * returns words broken across lines): keep compounds seen elsewhere in the document ("risk-based")
 * and suspended hyphens ("energy- and carbon-intensive"), otherwise join the halves.
 */
export function repairInlineHyphenation(text: string, hyphenatedVocab: Set<string>): string {
  // All-caps words broken across lines ("GOV- ERN") are never real compounds.
  text = text.replace(/\b([A-Z]{2,})- ([A-Z]{2,})\b/g, "$1$2");
  return text.replace(/\b([A-Za-z]+)- ([a-z]+)/g, (whole, left: string, right: string) => {
    if (SUSPENDED_HYPHEN_NEXT.has(right)) return whole;
    return hyphenatedVocab.has(`${left}-${right}`.toLowerCase()) ? `${left}-${right}` : left + right;
  });
}
