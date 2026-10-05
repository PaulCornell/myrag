// Grounded answering. Two engines behind one function:
//   - ollama (default, free): a local open-weight model cites passages with [n] markers, which
//     CitationTracker renumbers and verifies against the cited passage text.
//   - anthropic: Claude's native citations API. Each chunk is its own document block and the API
//     returns cited_text spans guaranteed to be verbatim from those documents.
// Either way, every citation maps to an exact chunk, document, section, and page.
import type Anthropic from "@anthropic-ai/sdk";
import { CitationTracker, type Citation } from "./citations.js";
import { ANSWER_MODEL, LLM_PROVIDER, type LlmProvider } from "./config.js";
import { anthropic, FALLBACK_PARAMS, type UsageMeter } from "./llm.js";
import { chatStream } from "./ollama.js";
import type { RetrievedChunk } from "./types.js";

export type { Citation } from "./citations.js";

export const ABSTAIN_PHRASE = "I can't answer that from the provided documents.";

const SYSTEM = `You answer questions about a corpus of government AI-governance and cybersecurity documents.
Answer only from the documents provided in the user turn, and cite them for every factual statement.
If the documents do not contain the answer, reply exactly: "${ABSTAIN_PHRASE}" and optionally one sentence on what the documents do cover. Do not use outside knowledge to fill gaps.
Be concise: lead with the direct answer, then supporting detail. No preamble.`;

export interface Answer {
  text: string;
  citations: Citation[];
  abstained: boolean;
  stopReason: string | null;
  model: string;
  provider: LlmProvider;
  /** Local models only: share of [n] markers whose claim the cited passage supports. */
  citationSupport?: number;
}

// Small models paraphrase the decline phrase, so match the gist rather than the exact string.
const ABSTAIN_RE = /\b(can(?:'|no)?t|cannot|unable to|not able to)\s+(?:answer|find|determine)\b[^.]*\b(provided|these|the)\s+(documents|passages|sources)\b/i;
export const isAbstention = (text: string) => text.includes(ABSTAIN_PHRASE) || ABSTAIN_RE.test(text);

export function sourceLabel(rc: RetrievedChunk): string {
  const c = rc.chunk;
  const pages = c.pageStart ? `, p. ${c.pageStart}${c.pageEnd && c.pageEnd !== c.pageStart ? `–${c.pageEnd}` : ""}` : "";
  return `${c.docTitle}${c.section.length ? ` — ${c.section[c.section.length - 1]}` : ""}${pages}`;
}

/** Incremental events for streaming UIs: answer text (including citation markers) and new citations. */
export type AnswerEvent = { type: "text"; text: string } | { type: "citation"; citation: Citation };

export async function answerQuestion(
  question: string,
  retrieved: RetrievedChunk[],
  meter?: UsageMeter,
  onEvent?: (e: AnswerEvent) => void,
): Promise<Answer> {
  return LLM_PROVIDER === "anthropic"
    ? answerWithClaude(question, retrieved, meter, onEvent)
    : answerWithOllama(question, retrieved, meter, onEvent);
}

const OLLAMA_SYSTEM = `You answer questions using ONLY the numbered passages the user provides.
Rules:
1. End every sentence that states a fact with the number of the passage it came from, in square brackets, like [2]. Only use passage numbers that appear in the passages.
2. If the passages do not contain the answer, reply with exactly: ${ABSTAIN_PHRASE}
3. Never use outside knowledge, even if you know the answer.
4. Be concise: answer directly in 1-5 sentences or a short bulleted list. No preamble.
Format example (about a different topic; never copy its content): Bees communicate through a waggle dance [2]. Colonies can hold up to 60,000 bees [4].`;

async function answerWithOllama(
  question: string,
  retrieved: RetrievedChunk[],
  meter?: UsageMeter,
  onEvent?: (e: AnswerEvent) => void,
): Promise<Answer> {
  // "Passage 1 (…):" rather than "[1] …": with bracketed labels, small models start their answer
  // with "[1] <title>" and paste the passage instead of answering.
  const passages = retrieved.map((rc, i) => `Passage ${i + 1} (${sourceLabel(rc)}):\n${rc.chunk.text}`).join("\n\n");
  let text = "";
  const tracker = new CitationTracker(
    retrieved,
    (t) => {
      text += t;
      onEvent?.({ type: "text", text: t });
    },
    (citation) => onEvent?.({ type: "citation", citation }),
  );
  const result = await chatStream(
    ANSWER_MODEL,
    [
      { role: "system", content: OLLAMA_SYSTEM },
      {
        role: "user",
        content: `${passages}\n\nQuestion: ${question}\nWrite the answer in your own words, ending each factual sentence with its passage number in brackets, like [1]. Do not copy whole passages.`,
      },
    ],
    (t) => tracker.push(t),
  );
  tracker.flush();
  meter?.add(result.model, { input_tokens: result.promptTokens, output_tokens: result.outputTokens });
  return {
    text: text.trim(),
    citations: tracker.citations,
    abstained: isAbstention(text),
    stopReason: result.doneReason,
    model: result.model,
    provider: "ollama",
    citationSupport: tracker.totalUses ? tracker.supportedUses / tracker.totalUses : undefined,
  };
}

async function answerWithClaude(
  question: string,
  retrieved: RetrievedChunk[],
  meter?: UsageMeter,
  onEvent?: (e: AnswerEvent) => void,
): Promise<Answer> {
  const documents: Anthropic.Beta.BetaRequestDocumentBlock[] = retrieved.map((rc) => ({
    type: "document",
    source: { type: "text", media_type: "text/plain", data: rc.chunk.text },
    title: sourceLabel(rc),
    context: `Section: ${rc.chunk.section.join(" > ") || "(none)"}`,
    citations: { enabled: true },
  }));

  const stream = anthropic().beta.messages.stream({
    ...FALLBACK_PARAMS,
    model: ANSWER_MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    system: SYSTEM,
    messages: [{ role: "user", content: [...documents, { type: "text", text: question }] }],
  });

  // Number citations by first appearance; reuse the marker when the same span is cited again.
  // Citations arrive as deltas inside a text block; their [n] markers are emitted when the block ends.
  const citations: Citation[] = [];
  const markerFor = new Map<string, number>();
  let text = "";
  let blockMarkers: number[] = [];
  const emitText = (t: string) => {
    text += t;
    onEvent?.({ type: "text", text: t });
  };

  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "text") {
      blockMarkers = [];
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") emitText(event.delta.text);
      else if (event.delta.type === "citations_delta" && event.delta.citation.type === "char_location") {
        const cit = event.delta.citation;
        const rc = retrieved[cit.document_index];
        const key = `${rc.chunk.id}|${cit.start_char_index}`;
        let n = markerFor.get(key);
        if (n === undefined) {
          n = citations.length + 1;
          markerFor.set(key, n);
          const c = rc.chunk;
          const citation: Citation = {
            n,
            chunkId: c.id,
            docId: c.docId,
            docTitle: c.docTitle,
            section: c.section,
            pages: c.pageStart ? `${c.pageStart}${c.pageEnd && c.pageEnd !== c.pageStart ? `-${c.pageEnd}` : ""}` : undefined,
            citedText: cit.cited_text.trim(),
          };
          citations.push(citation);
          onEvent?.({ type: "citation", citation });
        }
        if (!blockMarkers.includes(n)) blockMarkers.push(n);
      }
    } else if (event.type === "content_block_stop" && blockMarkers.length) {
      emitText(blockMarkers.map((n) => `[${n}]`).join(""));
      blockMarkers = [];
    }
  }

  const final = await stream.finalMessage();
  meter?.add(final.model, final.usage);
  if (final.stop_reason === "refusal") {
    return { text: "[refused]", citations: [], abstained: true, stopReason: final.stop_reason, model: final.model, provider: "anthropic" };
  }
  return {
    text: text.trim(),
    citations,
    abstained: isAbstention(text),
    stopReason: final.stop_reason,
    model: final.model,
    provider: "anthropic",
  };
}
