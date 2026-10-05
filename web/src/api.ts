// Types mirror the server's JSON; kept here so the UI builds without importing server code.
export interface Chunk {
  id: string;
  docId: string;
  docTitle: string;
  section: string[];
  pageStart?: number;
  pageEnd?: number;
  text: string;
}
export interface RankTrace {
  chunkId: string;
  lexical: number | null;
  dense: number | null;
  hybrid: number | null;
  rerank: number;
  rerankScore: number;
}
export interface Source {
  chunk: Chunk;
  score: number;
  rank: number;
  trace: RankTrace;
}
export interface Citation {
  n: number;
  chunkId: string;
  docId: string;
  docTitle: string;
  section: string[];
  pages?: string;
  citedText: string;
  /** Local models only: whether the cited passage contains the claim. */
  verified?: boolean;
  support?: number;
}
export interface DoneInfo {
  abstained: boolean;
  model: string;
  provider: "ollama" | "anthropic";
  citations: Citation[];
  citationSupport: number | null;
  stopReason: string | null;
  usage: { input: number; output: number; costUsd: number };
  totalMs: number;
}
export interface DocumentInfo {
  id: string;
  title: string;
  format: string;
  sourceUrl: string;
  stats: Record<string, number>;
  chunks: number;
}

export type AskEvent =
  | { type: "sources"; data: { retrievalMs: number; sources: Source[] } }
  | { type: "text"; data: { text: string } }
  | { type: "citation"; data: Citation }
  | { type: "done"; data: DoneInfo }
  | { type: "error"; data: { message: string } };

/** POST /api/ask and parse its server-sent event stream. */
export async function ask(question: string, onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent({ type: event, data: JSON.parse(data) } as AskEvent);
    }
  }
}

export interface Health {
  ok: boolean;
  llm: { provider: "ollama" | "anthropic"; model: string };
  index: { count: number };
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export function pageLabel(c: { pageStart?: number; pageEnd?: number }): string | null {
  if (!c.pageStart) return null;
  return c.pageEnd && c.pageEnd !== c.pageStart ? `pp. ${c.pageStart}–${c.pageEnd}` : `p. ${c.pageStart}`;
}
