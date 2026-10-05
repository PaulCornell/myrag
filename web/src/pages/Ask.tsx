import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ask, getJSON, pageLabel, type Citation, type DocumentInfo, type DoneInfo, type Health, type Source } from "../api";

const EXAMPLES = [
  "What are the four functions of the AI RMF Core?",
  "What are the CSF 2.0 Tiers?",
  "What does subcategory GV.SC-05 require?",
  "Can staff put customer personal information into enterprise AI tools?",
  "How do the AI RMF and CSF 2.0 each describe GOVERN?",
  "What is the EU AI Act's maximum fine?",
];

type Phase = "idle" | "retrieving" | "streaming" | "done" | "error";

export function AskPage() {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [sources, setSources] = useState<Source[]>([]);
  const [retrievalMs, setRetrievalMs] = useState(0);
  const [text, setText] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [done, setDone] = useState<DoneInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [docs, setDocs] = useState<Record<string, DocumentInfo>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sourceRefs = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    getJSON<DocumentInfo[]>("/api/documents")
      .then((list) => setDocs(Object.fromEntries(list.map((d) => [d.id, d]))))
      .catch(() => {});
    getJSON<Health>("/api/health").then(setHealth).catch(() => {});
  }, []);

  async function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed || phase === "retrieving" || phase === "streaming") return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAsked(trimmed);
    setPhase("retrieving");
    setSources([]);
    setText("");
    setCitations([]);
    setDone(null);
    setError(null);
    setActive(null);
    try {
      await ask(
        trimmed,
        (e) => {
          if (e.type === "sources") {
            setSources(e.data.sources);
            setRetrievalMs(e.data.retrievalMs);
            setPhase("streaming");
          } else if (e.type === "text") setText((t) => t + e.data.text);
          else if (e.type === "citation") setCitations((cs) => [...cs, e.data]);
          else if (e.type === "done") {
            setDone(e.data);
            setCitations(e.data.citations);
            setPhase("done");
          } else if (e.type === "error") {
            setError(e.data.message);
            setPhase("error");
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  function focusCitation(n: number) {
    setActive(n);
    sourceRefs.current[n]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const busy = phase === "retrieving" || phase === "streaming";

  return (
    <>
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(question);
        }}
      >
        <textarea
          aria-label="Question"
          placeholder="Ask about the NIST AI RMF, the GenAI Profile, CSF 2.0, the NZ AI policy template, or the FedRAMP SSP…"
          value={question}
          rows={2}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(question);
            }
          }}
        />
        <button className="primary" type="submit" disabled={busy || !question.trim()}>
          {busy ? "Working…" : "Ask"}
        </button>
      </form>
      <div className="examples">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            className="example"
            type="button"
            onClick={() => {
              setQuestion(ex);
              submit(ex);
            }}
          >
            {ex}
          </button>
        ))}
      </div>

      {phase === "idle" && (
        <div className="card explainer">
          <p>
            Answers come only from five public government documents and cite the exact passage they rely on. Click a
            numbered citation to see the source text, its section, and page.
          </p>
          <p className="muted">
            Under the hood: keyword + vector search in Postgres/pgvector, a local reranker, and{" "}
            {health?.llm.provider === "anthropic"
              ? "Claude with native citations"
              : `a free local model (${health?.llm.model ?? "via Ollama"}) whose citations are checked against the source text`}
            . If the documents don't cover a question, the system says so instead of guessing.
          </p>
        </div>
      )}

      {phase !== "idle" && (
        <div className="ask-layout">
          <section>
            <div className="card">
              <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
                {asked}
              </div>
              {error && <div className="error-box">Something went wrong: {error}</div>}
              {phase === "retrieving" && <div className="muted">Searching the documents…</div>}
              {done?.abstained && (
                <div className="notice" role="status">
                  <span aria-hidden>ⓘ</span>
                  <span>
                    <strong>Not in the documents.</strong> The system declined rather than answer from outside
                    knowledge.
                  </span>
                </div>
              )}
              {(phase === "streaming" || phase === "done") && (
                <div className={`answer${done?.abstained ? " abstained" : ""}`}>
                  {renderWithCitations(text, active, focusCitation, new Set(citations.filter((c) => c.verified === false).map((c) => c.n)))}
                  {phase === "streaming" && <span className="cursor" aria-hidden />}
                </div>
              )}
              {done && (
                <div className="meta-row">
                  <span className="pill">{citations.length} citations</span>
                  <span className="pill">retrieval {retrievalMs} ms</span>
                  <span className="pill">total {(done.totalMs / 1000).toFixed(1)} s</span>
                  <span className="pill">{done.model}</span>
                  <span className="pill">{done.usage.costUsd > 0 ? `~$${done.usage.costUsd.toFixed(4)}` : "free · local"}</span>
                  {done.citationSupport !== null && done.citationSupport < 1 && (
                    <span className="pill">
                      {Math.round(done.citationSupport * 100)}% of citations verified
                    </span>
                  )}
                </div>
              )}
            </div>

            {sources.length > 0 && <WhyTheseSources sources={sources} citations={citations} />}
          </section>

          <aside className="source-panel" aria-label="Cited sources">
            {citations.length === 0 && phase === "done" && (
              <div className="muted" style={{ fontSize: 14 }}>
                No sources cited.
              </div>
            )}
            {citations.map((c) => {
              const src = sources.find((s) => s.chunk.id === c.chunkId);
              const doc = docs[c.docId];
              const page = src?.chunk.pageStart;
              const href = doc ? (doc.format === "pdf" && page ? `${doc.sourceUrl}#page=${page}` : doc.sourceUrl) : undefined;
              return (
                <div
                  key={c.n}
                  ref={(el) => {
                    sourceRefs.current[c.n] = el;
                  }}
                  className={`source${active === c.n ? " active" : ""}`}
                  onMouseEnter={() => setActive(c.n)}
                >
                  <h3>
                    <span className={`cite${c.verified === false ? " unverified" : ""}`} aria-hidden>
                      {c.n}
                    </span>{" "}
                    {c.docTitle}
                  </h3>
                  {c.verified === false && (
                    <div className="status warning" style={{ fontSize: 12.5, margin: "4px 0" }}>
                      ⚠ Unverified: this passage contains only {Math.round((c.support ?? 0) * 100)}% of the claim's key words
                    </div>
                  )}
                  <div className="crumb">
                    {[c.section.join(" › "), src && pageLabel(src.chunk)].filter(Boolean).join(" · ") || "—"}
                  </div>
                  <div className="quote">{src ? highlight(src.chunk.text, c.citedText) : c.citedText}</div>
                  <div className="source-actions">
                    <span className="muted">
                      rank #{src?.rank ?? "?"} of {sources.length}
                    </span>
                    {href && (
                      <a href={href} target="_blank" rel="noreferrer">
                        Open source ↗
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </aside>
        </div>
      )}
    </>
  );
}

/** Turns "[1][2]" markers in the streamed answer into clickable citation chips. */
function renderWithCitations(text: string, active: number | null, onClick: (n: number) => void, unverified: Set<number>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const n = Number(m[1]);
    out.push(
      <button
        key={`${m.index}-${n}`}
        className={`cite${unverified.has(n) ? " unverified" : ""}`}
        aria-pressed={active === n}
        aria-label={`Source ${n}${unverified.has(n) ? " (unverified)" : ""}`}
        onClick={() => onClick(n)}
      >
        {n}
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Highlights the verbatim cited span inside the chunk text (whitespace-insensitive). */
function highlight(chunkText: string, cited: string): ReactNode {
  const needle = cited.replace(/\s+/g, " ").trim();
  const flat = chunkText.replace(/\s+/g, " ");
  const i = needle ? flat.indexOf(needle) : -1;
  if (i === -1) return chunkText;
  return (
    <>
      {flat.slice(0, i)}
      <mark>{flat.slice(i, i + needle.length)}</mark>
      {flat.slice(i + needle.length)}
    </>
  );
}

function WhyTheseSources({ sources, citations }: { sources: Source[]; citations: Citation[] }) {
  const cited = useMemo(() => new Map(citations.map((c) => [c.chunkId, c.n])), [citations]);
  const r = (v: number | null) => (v === null ? <span className="none">—</span> : `#${v}`);
  return (
    <details className="card why">
      <summary>Why these sources?</summary>
      <p className="sub" style={{ marginTop: 8 }}>
        Each passage's rank under keyword search (Postgres full-text), vector search (pgvector), their fusion, and the
        final cross-encoder rerank. "—" means that method didn't find it in its top 100.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table className="rank-table">
          <thead>
            <tr>
              <th>Passage</th>
              <th className="num">Keyword</th>
              <th className="num">Vector</th>
              <th className="num">Hybrid</th>
              <th className="num">Final</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.chunk.id}>
                <td>
                  {cited.has(s.chunk.id) && <span className="cite">{cited.get(s.chunk.id)}</span>}{" "}
                  <strong>{s.chunk.docTitle.split(":")[0]}</strong>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {[s.chunk.section.at(-1), pageLabel(s.chunk)].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className="num">{r(s.trace.lexical)}</td>
                <td className="num">{r(s.trace.dense)}</td>
                <td className="num">{r(s.trace.hybrid)}</td>
                <td className="num">
                  <strong>#{s.trace.rerank}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
