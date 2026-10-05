import { Fragment, useEffect, useMemo, useState } from "react";
import { getJSON } from "../api";
import { ColumnChart, LineChart } from "../components/Charts";

// Shapes of the files written by `npm run eval:retrieval` and `npm run eval:answers`.
interface PerQuestion {
  id: string;
  type: string;
  recall: Record<string, number>;
  mrr: number;
  ndcg10: number;
  top: string[];
}
interface ModeResult {
  mode: string;
  recall: Record<string, number>;
  mrr: number;
  ndcg10: number;
  byType: Record<string, Record<string, number>>;
  perQuestion: PerQuestion[];
}
interface RetrievalRun {
  meta: { count: number; chunking: { targetTokens: number; overlapTokens: number }; embedModel: string; builtAt: string };
  results: { label: string; r: ModeResult }[];
  sweep: { label: string; r: ModeResult }[];
}
interface AnswerRow {
  id: string;
  type: string;
  question: string;
  answer: { text: string; abstained: boolean; citations: { n: number; docTitle: string; citedText: string }[] };
  contextRecall: number;
  faithfulness: { score: number; claims: { claim: string; verdict: string }[] };
  correctness: { verdict: string; rationale: string };
  citationPrecision: number;
}
interface AnswerRun {
  config: { answerModel: string; answerProvider?: string; judgeModel: string; judgeProvider?: string; k: number; mode: string; costUsd?: number };
  summary: Record<string, number>;
  rows: AnswerRow[];
}
interface Golden {
  id: string;
  type: string;
  question: string;
  evidence: { docId: string; text: string }[];
  reference_answer: string;
}
interface RunFile {
  file: string;
  source: "local" | "reference";
  kind: string;
  mtime: string;
  judge?: string;
  answerer?: string;
}
const runKey = (r: RunFile) => `${r.source}/${r.file}`;

const MODE_LABEL: Record<string, string> = {
  lexical: "Keyword",
  dense: "Vector",
  hybrid: "Hybrid",
  "hybrid+rerank": "Hybrid + rerank",
};
const MODE_COLOR: Record<string, string> = {
  lexical: "var(--series-1)",
  dense: "var(--series-2)",
  hybrid: "var(--series-3)",
  "hybrid+rerank": "var(--series-4)",
};
const KS = ["1", "3", "5", "10"];
const pct = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? "—" : `${Math.round(v * 100)}%`);

export function EvalsPage() {
  const [runs, setRuns] = useState<RunFile[]>([]);
  const [retrievalFile, setRetrievalFile] = useState<string>("");
  const [answersFile, setAnswersFile] = useState<string>("");
  const [retrieval, setRetrieval] = useState<RetrievalRun | null>(null);
  const [answers, setAnswers] = useState<AnswerRun | null>(null);
  const [golden, setGolden] = useState<Golden[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getJSON<RunFile[]>("/api/evals"), getJSON<Golden[]>("/api/golden")])
      .then(([list, g]) => {
        setRuns(list);
        setGolden(g);
        // Prefer your own newest run; fall back to the committed reference run.
        const pick = (kind: string) => list.find((r) => r.kind === kind && r.source === "local") ?? list.find((r) => r.kind === kind);
        const r = pick("retrieval");
        const a = pick("answers");
        setRetrievalFile(r ? runKey(r) : "");
        setAnswersFile(a ? runKey(a) : "");
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    if (retrievalFile) getJSON<RetrievalRun>(`/api/evals/${retrievalFile}`).then(setRetrieval).catch((e) => setError(String(e)));
  }, [retrievalFile]);
  useEffect(() => {
    if (answersFile) getJSON<AnswerRun>(`/api/evals/${answersFile}`).then(setAnswers).catch((e) => setError(String(e)));
  }, [answersFile]);

  const best = retrieval?.results.find((x) => x.label === "hybrid+rerank")?.r;
  const s = answers?.summary;
  // Scores from a small local grader are shown muted: in testing it rated every answer faithful
  // and marked several correct answers wrong. Code-checked metrics (abstention) are unaffected.
  const weakJudge = answers?.config.judgeProvider === "ollama";

  return (
    <div className="eval-grid">
      <HowItWorks />

      <div className="toggle-row">
        <RunPicker label="Retrieval run" kind="retrieval" runs={runs} value={retrievalFile} onChange={setRetrievalFile} />
        <RunPicker label="Answer run" kind="answers" runs={runs} value={answersFile} onChange={setAnswersFile} />
        {retrieval && (
          <span className="pill">
            {retrieval.meta.count} chunks · {retrieval.meta.chunking.targetTokens}-token chunks · {golden.length} test questions
          </span>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
      {!retrieval && !error && runs.length === 0 && (
        <div className="notice">
          No eval results yet. Run <code>npm run eval:retrieval</code> and <code>npm run eval:answers</code> (both free with the local model).
        </div>
      )}
      {answers && answers.config.judgeProvider === "ollama" && (
        <div className="notice" role="note">
          <span aria-hidden>ⓘ</span>
          <span>
            <strong>Indicative answer scores.</strong> This run was graded by a small local model ({answers.config.judgeModel}), which is a
            rough grader. For trustworthy scores, pick a reference run graded by Claude, or run{" "}
            <code>JUDGE_PROVIDER=anthropic npm run eval:answers</code>.
          </span>
        </div>
      )}

      <div className="tiles">
        <Tile label="Finds the right passage in the top 5" value={pct(best?.recall["5"])} hint="Recall@5, hybrid + rerank" />
        <Tile label="Right passage ranked first" value={pct(best?.recall["1"])} hint="Recall@1, hybrid + rerank" />
        <Tile
          label="Answer claims backed by sources"
          value={pct(s?.faithfulness)}
          muted={weakJudge}
          hint={s ? (weakJudge ? `Low trust: graded by ${answers?.config.judgeModel}` : `Faithfulness, graded by ${answers?.config.judgeModel}`) : "Run npm run eval:answers"}
        />
        <Tile
          label="Answers match the reference"
          value={pct(s?.correctness)}
          muted={weakJudge}
          hint={s ? (weakJudge ? `Low trust: graded by ${answers?.config.judgeModel}` : "Correctness (partial = ½)") : "Run npm run eval:answers"}
        />
        <Tile
          label="Declines when it should"
          value={pct(s?.abstention_on_unanswerable)}
          hint={s ? `False refusals on answerable: ${pct(s.false_abstention_on_answerable)}` : "Run npm run eval:answers"}
        />
      </div>

      {retrieval && <RecallCard run={retrieval} />}
      {retrieval && retrieval.sweep.length > 0 && <SweepCard run={retrieval} />}
      {best && <ByTypeCard best={best} />}
      {retrieval && <QuestionTable run={retrieval} golden={golden} />}
      {answers && <AnswersTable run={answers} />}
    </div>
  );
}

function HowItWorks() {
  return (
    <details className="card explainer" open>
      <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--text-primary)" }}>How these tests work (plain English)</summary>
      <div style={{ marginTop: 12 }}>
        <p>
          The project has <strong>35 test questions</strong>. Each one is stored with the exact sentence from the source document that
          answers it. Four questions are deliberately <em>not</em> answerable from the documents.
        </p>
        <p>
          <strong>Search tests (free, run on this machine):</strong> for each question we check whether the search step brings back the
          passage containing that sentence, and how high it ranks. "Top 5" means the right passage was among the five handed to the AI.
        </p>
        <div className="metric-defs">
          <p>
            <strong>What the search scores mean.</strong> Think of a librarian: you ask a question and get back a short stack of pages, best
            guess on top. We already know which page holds the answer.
          </p>
          <dl>
            <dt>Recall@k: "Was the right page in the stack at all?"</dt>
            <dd>
              <em>k</em> is the size of the stack. Recall@5 = 0.90 means that for 90 of every 100 questions, the answer was among the five pages
              handed to the AI. This matters most: if the page isn't there, a correct answer is impossible. A bigger stack is always easier, so
              we show k = 1, 3, 5 and 10.
            </dd>
            <dt>MRR: "How close to the top was it?"</dt>
            <dd>
              On top scores 1, second scores ½, third ⅓, and not in the top 10 scores 0, averaged over all questions. An MRR of 0.80 roughly
              means "usually first, sometimes second." Finding it early matters because the first passages get the most attention.
            </dd>
            <dt>nDCG: "How good was the whole ordering?"</dt>
            <dd>
              Some questions need two pages (one from each of two documents). nDCG credits every right page, less the further down it sits,
              compared with the best possible order. 1.0 means everything needed was at the very top.
            </dd>
          </dl>
          <p className="muted">All three run from 0 to 1; higher is better. Recall: did we find it? MRR: how quickly? nDCG: how well did we rank everything that mattered?</p>
        </div>
        <p>
          <strong>Answer tests (free with the local model; trustworthy with Claude):</strong> a second AI acts as a strict grader. It breaks each answer into individual claims and
          checks every claim against the passages the system actually retrieved, so any claim the passages don't back counts as made
          up. Separately, it compares the answer with a reference answer stored with each question. We also check that the system says "I can't answer
          that" for the trick questions instead of inventing something.
        </p>
      </div>
    </details>
  );
}

function RunPicker({ label, kind, runs, value, onChange }: { label: string; kind: string; runs: RunFile[]; value: string; onChange: (f: string) => void }) {
  const options = runs.filter((r) => r.kind === kind);
  return (
    <label className="pill" style={{ padding: "4px 10px" }}>
      {label}:
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ border: 0, background: "transparent" }} disabled={!options.length}>
        {!options.length && <option value="">none yet</option>}
        {options.map((r) => (
          <option key={runKey(r)} value={runKey(r)}>
            {r.source === "reference" ? "Reference · " : ""}
            {r.answerer ? `${r.answerer} · ` : ""}
            {new Date(r.mtime).toLocaleString()}
          </option>
        ))}
      </select>
    </label>
  );
}

function Tile({ label, value, hint, muted }: { label: string; value: string; hint: string; muted?: boolean }) {
  return (
    <div className={`tile${muted ? " muted-tile" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="hint">{hint}</div>
    </div>
  );
}

function RecallCard({ run }: { run: RetrievalRun }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <div className="card">
      <h2>Search quality by method</h2>
      <p className="sub">
        Share of test questions whose answer passage is in the top k results (higher is better). The table view adds MRR (how close to the
        top the right passage was) and nDCG (how well the whole list was ordered). Plain-English definitions are in "How these tests work"
        above.
      </p>
      <ViewToggle view={view} setView={setView} />
      {view === "chart" ? (
        <LineChart
          xs={KS.map((k) => `top ${k}`)}
          xLabel="results considered (k)"
          series={run.results.map(({ label, r }) => ({ name: MODE_LABEL[label] ?? label, color: MODE_COLOR[label], values: KS.map((k) => r.recall[k]) }))}
        />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Method</th>
              {KS.map((k) => (
                <th key={k} className="num">
                  R@{k}
                </th>
              ))}
              <th className="num">MRR</th>
              <th className="num">nDCG@10</th>
            </tr>
          </thead>
          <tbody>
            {run.results.map(({ label, r }) => (
              <tr key={label}>
                <td>{MODE_LABEL[label] ?? label}</td>
                {KS.map((k) => (
                  <td key={k} className="num">
                    {r.recall[k].toFixed(3)}
                  </td>
                ))}
                <td className="num">{r.mrr.toFixed(3)}</td>
                <td className="num">{r.ndcg10.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SweepCard({ run }: { run: RetrievalRun }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <div className="card">
      <h2>Recall@5 by chunk size</h2>
      <p className="sub">The same documents split into smaller or larger passages before indexing (hybrid + rerank).</p>
      <ViewToggle view={view} setView={setView} />
      {view === "chart" ? (
        <ColumnChart labels={run.sweep.map((s) => s.label.split(" (")[0])} values={run.sweep.map((s) => s.r.recall["5"])} valueLabel="Recall@5" />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Chunk size</th>
              <th className="num">R@1</th>
              <th className="num">R@5</th>
              <th className="num">MRR</th>
            </tr>
          </thead>
          <tbody>
            {run.sweep.map((s) => (
              <tr key={s.label}>
                <td>{s.label}</td>
                <td className="num">{s.r.recall["1"].toFixed(3)}</td>
                <td className="num">{s.r.recall["5"].toFixed(3)}</td>
                <td className="num">{s.r.mrr.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ByTypeCard({ best }: { best: ModeResult }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of best.perQuestion) c[p.type] = (c[p.type] ?? 0) + 1;
    return c;
  }, [best]);
  return (
    <div className="card">
      <h2>Which kinds of questions are hard?</h2>
      <p className="sub">Recall by question type for hybrid + rerank. Small groups: one question can move a row by 20–50 points.</p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Question type</th>
            <th className="num">n</th>
            {KS.map((k) => (
              <th key={k} className="num">
                R@{k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(best.byType).map(([t, rec]) => (
            <tr key={t}>
              <td>{t.replace("_", "-")}</td>
              <td className="num">{counts[t]}</td>
              {KS.map((k) => (
                <td key={k} className="num">
                  {rec[k].toFixed(2)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QuestionTable({ run, golden }: { run: RetrievalRun; golden: Golden[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(golden.map((g) => [g.id, g]));
  const modes = run.results.map((x) => x.label);
  const ids = run.results[0]?.r.perQuestion.map((p) => p.id) ?? [];
  return (
    <div className="card">
      <h2>Question by question</h2>
      <p className="sub">Found in the top 5? Click a row to see the gold evidence and what ranked first.</p>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Question</th>
              {modes.map((m) => (
                <th key={m} className="num">
                  {MODE_LABEL[m] ?? m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const g = byId.get(id);
              const isOpen = open === id;
              const best = run.results.find((x) => x.label === "hybrid+rerank")?.r.perQuestion.find((p) => p.id === id);
              return (
                <Fragment key={id}>
                  <tr className="clickable" onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen}>
                    <td>
                      <span className="muted mono">{id}</span> {g?.question}
                      <div>
                        <span className="pill">{g?.type.replace("_", "-")}</span>
                      </div>
                    </td>
                    {modes.map((m) => {
                      const r5 = run.results.find((x) => x.label === m)!.r.perQuestion.find((p) => p.id === id)!.recall["5"];
                      return (
                        <td key={m} className="num">
                          <Hit value={r5} />
                        </td>
                      );
                    })}
                  </tr>
                  {isOpen && g && (
                    <tr className="expanded">
                      <td colSpan={modes.length + 1}>
                        <div style={{ fontSize: 13.5 }}>
                          <strong>Gold evidence</strong>
                          {g.evidence.map((e, i) => (
                            <div key={i} className="muted" style={{ margin: "4px 0 8px" }}>
                              <span className="mono">{e.docId}</span>: "{e.text}"
                            </div>
                          ))}
                          <strong>Reference answer</strong>
                          <div className="muted" style={{ margin: "4px 0 8px" }}>
                            {g.reference_answer}
                          </div>
                          {best && (
                            <>
                              <strong>Top results (hybrid + rerank)</strong>
                              <div className="mono muted" style={{ marginTop: 4 }}>
                                {best.top.join("  ·  ")}
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AnswersTable({ run }: { run: AnswerRun }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="card">
      <h2>Answer grading</h2>
      <p className="sub">
        Answered by {run.config.answerModel}, graded by {run.config.judgeModel}. Click a row for the answer and any claims the grader could not
        find in the sources.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Question</th>
              <th className="num">Claims backed</th>
              <th>Matches reference</th>
            </tr>
          </thead>
          <tbody>
            {run.rows.map((r) => {
              const isOpen = open === r.id;
              const bad = r.faithfulness.claims.filter((c) => c.verdict !== "supported");
              return (
                <Fragment key={r.id}>
                  <tr className="clickable" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                    <td>
                      <span className="muted mono">{r.id}</span> {r.question}
                      {r.answer.abstained && (
                        <div>
                          <span className="pill">declined</span>
                        </div>
                      )}
                    </td>
                    <td className="num">{Number.isNaN(r.faithfulness.score) || r.faithfulness.score === null ? "—" : pct(r.faithfulness.score)}</td>
                    <td>
                      <Verdict v={r.correctness.verdict} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="expanded">
                      <td colSpan={3}>
                        <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{r.answer.text}</div>
                        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                          Grader: {r.correctness.rationale}
                        </div>
                        {bad.map((c, i) => (
                          <div key={i} style={{ fontSize: 13, marginTop: 6 }}>
                            <span className={`status ${c.verdict === "unsupported" ? "critical" : "warning"}`}>
                              {c.verdict === "unsupported" ? "✕ unsupported" : "◐ partly supported"}
                            </span>{" "}
                            {c.claim}
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Hit({ value }: { value: number }) {
  if (value >= 1) return <span className="status good">✓ yes</span>;
  if (value > 0) return <span className="status warning">◐ part</span>;
  return <span className="status critical">✕ no</span>;
}

function Verdict({ v }: { v: string }) {
  if (v === "correct") return <span className="status good">✓ correct</span>;
  if (v === "partially_correct") return <span className="status warning">◐ partial</span>;
  return <span className="status critical">✕ incorrect</span>;
}

function ViewToggle({ view, setView }: { view: "chart" | "table"; setView: (v: "chart" | "table") => void }) {
  return (
    <div className="toggle-row">
      <div className="seg" role="group" aria-label="View">
        <button aria-pressed={view === "chart"} onClick={() => setView("chart")}>
          Chart
        </button>
        <button aria-pressed={view === "table"} onClick={() => setView("table")}>
          Table
        </button>
      </div>
    </div>
  );
}
