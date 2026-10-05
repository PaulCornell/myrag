// Citations for models without a native citations API (local Ollama models).
//
// The model is asked to end each claim with a passage marker like [2]. As text streams in, this
// tracker (1) holds back partial markers so the UI never shows half of "[1", (2) renumbers
// passages in order of first citation so markers read [1], [2], [3]…, and (3) *verifies* each
// cited claim against the passage it points to. Claude's citations API guarantees cited text is
// verbatim; a small local model can attach a marker to a sentence the passage doesn't support, so
// each citation records how much of the claim the passage actually contains.
import type { RetrievedChunk } from "./types.js";

export interface Citation {
  /** 1-based marker shown in the answer text. */
  n: number;
  chunkId: string;
  docId: string;
  docTitle: string;
  section: string[];
  pages?: string;
  /** Verbatim source text: the API's cited span (Claude) or the best-matching passage sentence (local). */
  citedText: string;
  /** Local models only: whether the cited claim's content words were found in the passage. */
  verified?: boolean;
  /** Local models only: best share (0–1) of a citing claim's content words found in the passage. */
  support?: number;
}

/** Share of a claim's content words that must appear in the cited passage to count as supported. */
export const SUPPORT_THRESHOLD = 0.6;

const STOP = new Set(
  "the and for are was were with that this from into its their they them which what when where who how does have has had can could should would will been being also such than then there these those not but any all each per via may might must our your".split(" "),
);

function contentWords(text: string): string[] {
  // 5-character prefixes are a crude, dependency-free stemmer: "governs"/"governance" -> "gover".
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 5));
}

/** Share of the claim's content words that occur in the passage (0–1). */
export function supportScore(claim: string, passage: string): number {
  const words = contentWords(claim);
  if (!words.length) return 1;
  const vocab = new Set(contentWords(passage));
  return words.filter((w) => vocab.has(w)).length / words.length;
}

/** The passage sentence that best matches the claim; shown and highlighted as the cited text. */
export function bestSentence(claim: string, passage: string): string {
  const sentences = passage.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 12);
  if (!sentences.length) return passage.slice(0, 300);
  const claimWords = new Set(contentWords(claim));
  // Most distinct claim words wins; among ties, the shorter sentence is the tighter quote.
  let best = sentences[0];
  let bestHits = -1;
  for (const s of sentences) {
    const hits = new Set(contentWords(s).filter((w) => claimWords.has(w))).size;
    if (hits > bestHits || (hits === bestHits && s.length < best.length)) [best, bestHits] = [s, hits];
  }
  return best;
}

/** The claim a marker refers to: the last sentence of the text written since the previous marker. */
export function lastClaim(text: string): string {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 3);
  return parts[parts.length - 1] ?? text.trim();
}

const MARKER_RE = /\[\s*(?:passages?|sources?|docs?)?\s*(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\s*\]/gi;
const MAX_MARKER_LEN = 24;

export class CitationTracker {
  readonly citations: Citation[] = [];
  /** Marker uses whose claim the passage supported / all valid marker uses. */
  supportedUses = 0;
  totalUses = 0;
  /** Markers pointing at a passage number that doesn't exist (dropped). */
  invalidMarkers = 0;
  private byPassage = new Map<number, Citation>();
  private pending = "";
  private sinceMarker = "";

  constructor(
    private retrieved: RetrievedChunk[],
    private emitText: (t: string) => void,
    private emitCitation: (c: Citation) => void,
  ) {}

  push(delta: string) {
    this.pending += delta;
    this.drain(false);
  }

  flush() {
    this.drain(true);
  }

  private drain(final: boolean) {
    for (;;) {
      MARKER_RE.lastIndex = 0;
      const m = MARKER_RE.exec(this.pending);
      if (!m) break;
      this.writeText(this.pending.slice(0, m.index));
      this.pending = this.pending.slice(m.index + m[0].length);
      this.handleMarker(m[1]);
    }
    // Hold back a possible partial marker at the end ("… [", "… [1") until it completes.
    const open = this.pending.lastIndexOf("[");
    if (!final && open !== -1 && this.pending.length - open <= MAX_MARKER_LEN && !this.pending.slice(open).includes("]")) {
      this.writeText(this.pending.slice(0, open));
      this.pending = this.pending.slice(open);
    } else {
      this.writeText(this.pending);
      this.pending = "";
    }
  }

  private writeText(t: string) {
    if (!t) return;
    this.sinceMarker += t;
    this.emitText(t);
  }

  private handleMarker(nums: string) {
    const claim = lastClaim(this.sinceMarker);
    const markers: number[] = [];
    for (const p of nums.split(/[,;]/).map((x) => Number(x.trim()))) {
      const rc = this.retrieved[p - 1];
      if (!rc) {
        this.invalidMarkers++;
        continue;
      }
      const support = supportScore(claim, rc.chunk.text);
      this.totalUses++;
      if (support >= SUPPORT_THRESHOLD) this.supportedUses++;
      let cit = this.byPassage.get(p);
      if (!cit) {
        const c = rc.chunk;
        cit = {
          n: this.citations.length + 1,
          chunkId: c.id,
          docId: c.docId,
          docTitle: c.docTitle,
          section: c.section,
          pages: c.pageStart ? `${c.pageStart}${c.pageEnd && c.pageEnd !== c.pageStart ? `-${c.pageEnd}` : ""}` : undefined,
          citedText: bestSentence(claim, c.text),
          verified: support >= SUPPORT_THRESHOLD,
          support,
        };
        this.byPassage.set(p, cit);
        this.citations.push(cit);
        this.emitCitation(cit);
      } else if (support > (cit.support ?? 0)) {
        cit.support = support;
        cit.verified = support >= SUPPORT_THRESHOLD;
      }
      if (!markers.includes(cit.n)) markers.push(cit.n);
    }
    if (markers.length) this.emitText(markers.map((n) => `[${n}]`).join(""));
    this.sinceMarker = "";
  }
}
