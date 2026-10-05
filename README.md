# MyRAG: cited answers over messy government documents, with real evals

MyRAG is a retrieval-augmented generation (RAG) system over five public government documents on AI risk and cybersecurity: three NIST PDFs and two government Word templates. You ask a question in plain English. It finds the relevant passages, and a language model answers **only from those passages**, citing each claim with a link to the exact sentence, section, and page it came from. When the documents don't cover a question, it says so instead of guessing.

**It's free to run.** By default everything runs on your own computer: a small open-weight model (Qwen 2.5 3B via [Ollama](https://ollama.com)) writes the answers, and local models handle search. No account, API key, or payment is needed. If you have an Anthropic API key, one setting switches answering to **Claude** for higher-quality answers and guaranteed-verbatim citations.

The repo also includes the evaluation that shows how well it works: a labeled test set with exact source quotes, search metrics (recall@k, MRR, nDCG), an LLM-graded check of answer faithfulness and correctness, and a web dashboard for exploring the results.

| | |
|---|---|
| **Ask screen** | Streams the answer with clickable citations; a source panel shows the cited text highlighted in context; "Why these sources?" shows how each retrieval method ranked every passage. |
| **Evals dashboard** | Plain-English explanation of the tests, headline scores, recall@k per retrieval method, a chunk-size sweep, scores by question type, and a drill-down for every test question. |

---

## Quick start

These are macOS commands, run from the project root; see [Setup](#setup) for details, Linux, and [Windows](#setup-on-windows). Everything is free: no account or API key needed.

**First time** (*roughly 30–45 minutes, an estimate*: mostly downloads and the one-time document analysis):

```bash
brew install node python@3.12 postgresql@18 pgvector poppler tesseract ollama
brew services start postgresql@18 && brew services start ollama
npm install
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
createdb myrag
ollama pull qwen2.5:3b
npm run build          # download, analyze, and index the documents (~15 min; see "How long things take")
npm run dev            # then open http://localhost:5173
```

**Coming back later** (everything is already built):

```bash
brew services start postgresql@18 && brew services start ollama   # skip if they're already running
npm run dev                                                       # then open http://localhost:5173
```

**What you'll see:** the **Ask** tab answers questions in about 5–20 seconds, with numbered citations you can click to read the exact source text. A citation outlined in orange couldn't be verified against its source. The **Evals** tab shows how well search and answers score on 35 test questions. When you're done, press **Ctrl+C**, then see [Turning everything off](#turning-everything-off) to stop the background services.

---

## Contents

- [Quick start](#quick-start)
- [Key ideas in plain English](#key-ideas-in-plain-english)
- [Results](#results)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Setup](#setup)
- [Running it](#running-it)
- [How long things take](#how-long-things-take)
- [Choosing the answering model: Ollama or Claude](#choosing-the-answering-model-ollama-or-claude)
- [Turning everything off](#turning-everything-off)
- [How the evals work](#how-the-evals-work)
- [Code guide](#code-guide)
- [Design decisions and lessons learned](#design-decisions-and-lessons-learned)
- [How the design evolved](#how-the-design-evolved)
- [Known limitations and next steps](#known-limitations-and-next-steps)
- [Corpus and licensing](#corpus-and-licensing)
- [How this project was built](#how-this-project-was-built)

---

## Key ideas in plain English

A few terms come up throughout this README. None of them require a technical background.

- **Passage (or "chunk").** The documents are cut into short, overlapping pieces of about a paragraph or two (roughly 250 tokens, about 190 words). Search works on passages, not whole documents, so the AI is handed just the relevant parts.

- **Keyword search and BM25.** Keyword search finds passages that contain the words in your question, like the search box on most websites. **BM25** is the standard recipe, used by search engines for decades, for deciding which keyword match is best. It follows three common-sense rules:
  1. A passage that mentions your word more often is probably more relevant, but with diminishing returns: the tenth mention adds less than the second.
  2. **Rare words count more than common ones.** In these documents nearly every passage says "AI" or "risk", so those words barely help; a passage that matches "confabulation" or "GV.SC-05" is a strong signal.
  3. Short passages that match aren't drowned out by long ones that happen to contain the word somewhere.

  Keyword search is excellent for exact terms and codes, but it misses passages that say the same thing in different words.

- **Vector search (embeddings).** A small AI model turns every passage, and your question, into a list of numbers that captures its *meaning*. Passages whose meaning is close to the question's score highest, even if they share no words with it. Asking "how much risk an organization is willing to accept" can find a passage about "risk tolerance". Its weakness is the opposite of keyword search: it blurs exact codes and names.

- **Hybrid search.** Run both searches and merge the two ranked lists, so each method covers the other's blind spots. A passage ranked high by *either* method, or decently by both, ends up near the top. (The merging method is called *reciprocal rank fusion*; it works from positions in each list, so the two methods' very different scoring scales don't need to be compared.)

- **Reranking and rerankers.** The first searches are fast but shallow: they look at the question and each passage separately. A **reranker** is a second, more careful AI model that reads the question and a passage *together*, like a person checking whether a page really answers the question, and gives each pair a relevance score. It's too slow to run over every passage, so it only **re-orders the top 30 candidates** from hybrid search, and the best 6 go to the answering model. Reranking mostly helps put the *best* passage first rather than merely somewhere in the list.

- **Grounded answers and citations.** The answering model is told to use *only* the six passages it's given and to cite which passage each statement came from. Each citation links to the exact text, so you can check it yourself.

- **Declining ("abstaining").** If the passages don't contain the answer, the system should say "I can't answer that from the provided documents" rather than guess. Four test questions exist specifically to check this.

---

## Results

<!-- RESULTS:START -->
Measured on the 35-question test set (31 answerable, 4 deliberately unanswerable). The index has 412 passages of about 250 tokens, built from the `unstructured` `hi_res` parse. Reproduce with `npm run eval:retrieval -- --sweep`.

**Retrieval: which search method finds the right passage?**

> **How to read this table**
>
> **The rows are four ways of searching** (see [Key ideas](#key-ideas-in-plain-english)):
> - **Keyword (BM25):** finds passages containing the question's words, weighting rare words more.
> - **Vector:** finds passages whose *meaning* is closest to the question, even with different wording.
> - **Hybrid:** runs both and merges their rankings.
> - **Hybrid + rerank:** hybrid, then a second AI model re-reads the top 30 candidates alongside the question and re-orders them. **This is what the app uses.**
>
> **The columns are scores**, each from 0 to 1, where higher is better. Multiply by 100 to read one as "out of 100 questions":
> - **R@1, R@3, R@5, R@10 (recall at 1, 3, 5, 10):** how often the passage containing the answer was in the top 1, 3, 5, or 10 search results. **R@5 = 0.887** means that for about 89 of every 100 questions, the right passage was among the five the app handed to the AI. R@1 is the strictest (it had to be first); R@10 the most lenient.
> - **MRR@10 (mean reciprocal rank):** how close to the top the right passage was. First place scores 1, second ½, third ⅓, and so on; not in the top 10 scores 0. **0.835** means it was usually first and occasionally second or third.
> - **nDCG@10:** how well the *whole* top-10 list was ordered, giving credit for every needed passage (some questions need two) and more credit the higher each one sits. 1.0 would mean every needed passage was at the very top.
>
> "@10" just means only the top 10 results were looked at. Full plain-English definitions are in [How the evals work](#how-the-evals-work).

| Method | R@1 | R@3 | R@5 | R@10 | MRR@10 | nDCG@10 |
|---|---|---|---|---|---|---|
| Keyword (BM25 in Postgres) | 0.581 | 0.758 | 0.839 | 0.871 | 0.683 | 0.736 |
| Vector (pgvector HNSW) | 0.500 | 0.774 | 0.823 | 0.823 | 0.657 | 0.685 |
| Hybrid (rank fusion) | 0.710 | 0.823 | 0.839 | **0.935** | 0.781 | 0.827 |
| **Hybrid + rerank** (default) | **0.774** | **0.855** | **0.887** | **0.935** | **0.835** | **0.848** |

**What this means:** the default method finds the right passage in the top 5 for 89% of questions and ranks it first for 77%. Keyword and vector search each miss *different* questions, so combining them lifts "ranked first" from 58% to 71%, and the reranker lifts it to 77%. For about 11% of questions the answering model never sees the right passage, so its answer to those can't be right; that's the ceiling search puts on answer quality.

**By question type**: the same scores split by the kind of question asked (hybrid + rerank). Groups are small, so one question moves a row by 17–50 points.

| Type | n | R@1 | R@5 | R@10 |
|---|---|---|---|---|
| List | 6 | 0.833 | 1.000 | 1.000 |
| Factoid | 15 | 0.867 | 0.933 | 0.933 |
| Identifier lookup | 3 | 1.000 | 1.000 | 1.000 |
| Paraphrase | 5 | 0.600 | 0.600 | 0.800 |
| Multi-document | 2 | 0.000 | 0.750 | 1.000 |

Paraphrased questions are the weak spot: the question uses different words from the document ("how much risk an organization is willing to accept" vs. "risk tolerance"). Remaining top-5 misses: q04 and q20 (paraphrase), q16 (a definition the reranker scores below related passages), and half of q30 (multi-document).

**Chunk-size sweep**: the documents cut into smaller or larger passages, re-indexed, and re-tested with the same questions (hybrid + rerank). Smaller passages mean more, narrower pieces to search.

| Target chunk size | Chunks | R@1 | R@5 | R@10 | MRR@10 | nDCG@10 |
|---|---|---|---|---|---|---|
| 150 tokens | 681 | 0.758 | **0.919** | **0.968** | **0.860** | **0.885** |
| 250 tokens (default) | 412 | **0.774** | 0.887 | 0.935 | 0.835 | 0.848 |
| 350 tokens | 304 | 0.677 | 0.887 | 0.887 | 0.780 | 0.797 |
| 500 tokens | 216 | 0.726 | 0.887 | 0.887 | 0.809 | 0.816 |
| 800 tokens | 147 | 0.742 | 0.855 | 0.919 | 0.826 | 0.828 |

150-token chunks score slightly higher on most search metrics, but the gap to 250 is one question (about 3 points), which is within noise. The default stays at 250 because each passage handed to the answering model then carries more surrounding context; whether smaller chunks hurt *answer* quality is what the answer eval would settle.

**How the numbers moved as the system changed**: the same test re-run after each major change (hybrid + rerank, R@5 and MRR as defined above).

| Step | R@5 | MRR | What changed |
|---|---|---|---|
| Custom parser (pdf.js + mammoth), in-app BM25, flat-file index | 0.952 | 0.834 | Original prototype |
| → `unstructured` `fast` + Postgres `ts_rank_cd` keyword search | 0.823 | 0.784 | Keyword R@5 fell to 0.532: Postgres ranking has no IDF |
| → BM25 implemented in SQL | 0.887 | 0.822 | Keyword R@5 back up to 0.871 |
| → `unstructured` `hi_res` + OCR table-cell realignment | 0.855 | 0.787 | Table structure recovered; reranker began burying an ID lookup |
| → exact-identifier rerank guard + repeated-header filter | **0.887** | **0.835** | Identifier questions: R@1 0.33 → 1.00 |

Two honest takeaways. First, the hand-tuned custom parser scored about 2 questions higher on recall@5 than `unstructured` does here, with the same MRR. `unstructured` gives a maintained, general-purpose parser and real table structure, but it isn't free accuracy on this corpus. Second, `hi_res` alone didn't improve search scores over `fast`; its value is the recovered tables, which show up in answers and source cards rather than in these metrics.

**Answer quality** (free local model, all 35 questions)

Answered by **Qwen 2.5 3B** via Ollama and graded by the same model, from `eval/reference/answers-ollama-…json` (committed, so the dashboard shows it out of the box). The run took about 17 minutes and cost $0. The table is split by how much each number can be trusted.

| Metric | Score | What it means | Trust |
|---|---|---|---|
| Declines when it should | **4 / 4** | Every trick question got "I can't answer that from the provided documents" | High: checked by code |
| Wrongly declines | **0 / 31** | No answerable question was refused | High: checked by code |
| Answers with at least one citation | **100%** | Every answer cited its sources | High: checked by code |
| Citations verified against their passage | **85%** | For 85% of `[n]` markers, the cited passage contains most of the sentence's key words; the rest are flagged in the UI | High: checked by code (a word-overlap check, so heavy paraphrase can be flagged even when correct) |
| Citations pointing at the gold passage | **67%** | Two-thirds of citations point at the passage holding the test answer; others cite a different but often still relevant passage | High: checked by code, but strict |
| Right passage among the 6 the model saw | **89%** | The ceiling search sets: for 11% of questions the answer was never in front of the model | High: checked by code |
| Answer matches the reference | 0.74 | Graded by the 3B model (correct = 1, partial = ½) | **Low.** In a manual review by Claude, 6 of the 13 answers it marked down were actually correct (for example, it penalized answers for naming the very control ID the question asked about). Counting those 6 as correct gives about 0.86. |
| Claims backed by the passages | 1.00 | Graded by the 3B model | **Low.** It rated every answer fully faithful, which isn't believable; this grader doesn't discriminate. |

**What this means:** the free local setup reliably stays grounded. It declines what it can't answer, never refuses what it can, and cites every answer, with most citations checkably backed by their source. Where answers go wrong, the most common cause is search not finding the right passage (q04, q16, q20), followed by incomplete answers to list questions. **The answer-grading scores need a stronger grader to be meaningful.** Running `JUDGE_PROVIDER=anthropic npm run eval:answers -- --reference` once (about $1–3) would replace the two "low trust" rows with trustworthy numbers.
<!-- RESULTS:END -->

---

## How it works

In short:

```text
Once, at setup:    download the 5 documents → split them into passages → store passages in Postgres
For each question: keyword + meaning search → reranker picks the best 6 → AI writes a cited answer
```

Step by step:

**1. Fetch.** `corpus.json` lists the five documents and their official URLs. They're downloaded into `data/raw/`; the repo doesn't redistribute them.

**2. Partition.** The open-source [`unstructured`](https://github.com/Unstructured-IO/unstructured) library splits each file into typed elements (`Title`, `NarrativeText`, `ListItem`, `Table`, `Header`, …). PDFs use the **`hi_res`** strategy: each page is rendered to an image, a layout-detection model finds titles, text blocks, and tables, and tesseract OCR reconstructs table rows and columns. Word files are read structurally. The raw output is saved to `data/unstructured/` so parser problems can be told apart from mapping problems.

**3. Clean and map.** `unstructured` does the layout work, but its output on these documents still needs fixing. `src/ingest/unstructured.ts` handles:
- dropping running headers, footers, page numbers, and table-of-contents pages
- repairing words hyphenated across lines ("orga- nizational" → "organizational") while keeping real compounds ("risk-based")
- inferring heading levels from numbering ("1.2.1" → level 3), because PDF titles come without depth
- rejecting false titles (bullets, table column headers, "The GOVERN function:")
- rejoining paragraphs split at page breaks
- re-filling OCR'd table cells with exact words from the PDF text layer (see [design decisions](#design-decisions-and-lessons-learned))

**4. Chunk and embed.** `src/chunk.ts` splits each document into roughly 250-token passages that never cross a major section boundary. Each chunk keeps its heading path and page range, and consecutive chunks overlap by about 40 tokens. Before embedding, each chunk gets its document title and section path prepended, so a passage that says "This function…" stays findable as part of "5.1 Govern". Embeddings come from **bge-small-en-v1.5**, running locally with no API key.

**5. Store.** Postgres holds the documents, chunks, 384-dimension vectors (HNSW index), and a full-text `tsvector` (GIN index). It also keeps a separate index of control identifiers ("GV.SC-05" → `gvsc05`), because Postgres's text parser splits them apart.

**6. Retrieve.** Every question is searched two ways: **BM25 keyword search** (implemented in SQL) and **vector search** (pgvector). The two ranked lists are merged in SQL with **reciprocal rank fusion**. A **cross-encoder reranker** (`ms-marco-MiniLM-L-6-v2`, also local) then re-scores the top 30 candidates by reading the question and each passage together, and the best 6 go to the answering model.

**7. Answer.** Two engines sit behind one interface (`src/answer.ts`), chosen with `LLM_PROVIDER`:

- **Local model (default, free).** The six passages are numbered and sent to **Qwen 2.5 3B** running in Ollama. The model is told to end every factual sentence with a passage marker like `[2]`. As the answer streams, `src/citations.ts` renumbers the markers in order of first use and **checks each cited sentence against the passage it points to**. A citation counts as verified when the passage contains at least 60% of the sentence's key words; otherwise the UI marks it with a warning. This matters because a small model will sometimes attach a marker to a claim its passage doesn't support.
- **Claude (optional, paid).** Each passage is sent to **Claude Opus 5.5** as its own document block with the API's **citations** feature turned on. The API returns `cited_text` spans that are guaranteed to be verbatim from those documents, so no after-the-fact checking is needed.

Either way, every citation maps to an exact chunk, section, and page, the instructions require answering only from the passages with a fixed phrase for declining, and the answer streams to the browser token by token.

---

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| Language | **TypeScript** on Node 20+ (`tsx` to run, `tsc` to typecheck) | One language for pipeline, API, and UI |
| Document parsing | **`unstructured`** (Python, `hi_res` strategy) + **poppler** + **tesseract** | Layout-model element detection and table structure for messy PDFs; structural Word parsing |
| Glue | `scripts/partition.py` writes JSON that the TypeScript pipeline reads | `unstructured` is Python-only; JSON on disk keeps the boundary simple and inspectable |
| Embeddings | **bge-small-en-v1.5** via `@huggingface/transformers` (ONNX on CPU) | Free, offline, deterministic, so evals are reproducible |
| Reranker | **ms-marco-MiniLM-L-6-v2** cross-encoder, same runtime | Large precision gain for about 1 s of CPU |
| Database | **Postgres 18 + pgvector 0.8** (HNSW + GIN indexes) | One store for vectors, keyword search, and metadata; hybrid fusion in a single SQL query |
| LLM (default) | **Qwen 2.5 3B** via **Ollama**, with citation verification | Free and offline; fits in 8 GB of RAM |
| LLM (optional) | **Claude Opus 5.5** via `@anthropic-ai/sdk` with native **citations** | Best answer quality; verbatim citations guaranteed by the API |
| Eval judge | Same provider choice, with **structured outputs** validated by Zod (Ollama JSON-schema output or Claude structured outputs) | Parse-safe per-claim verdicts; Claude is the trustworthy grader, a local model a rough free one |
| API server | **Hono** on Node, server-sent events for streaming | Small, typed, streams cleanly |
| Web UI | **React + Vite**, custom SVG charts | No chart library; charts follow a validated colorblind-safe palette in light and dark mode |
| Tests | **Vitest** | Runs TypeScript and ES modules with no config |

---

## Setup

These steps are written for macOS with Homebrew, with Linux equivalents noted. **Windows users:** see [Setup on Windows](#setup-on-windows) below.

### 1. Prerequisites

| Need | macOS | Linux (Debian/Ubuntu) |
|---|---|---|
| Node.js ≥ 20 | `brew install node` | [nodejs.org](https://nodejs.org) or `nvm` |
| Python ≥ 3.10 (3.12 tested) | `brew install python@3.12` | `apt install python3.12 python3.12-venv` |
| Postgres ≥ 16 + pgvector | `brew install postgresql@18 pgvector` | `apt install postgresql postgresql-16-pgvector`, or Docker (below) |
| poppler + tesseract (for `hi_res`) | `brew install poppler tesseract` | `apt install poppler-utils tesseract-ocr` |
| Ollama + a model (free, for answers) | `brew install ollama && brew services start ollama && ollama pull qwen2.5:3b` | [ollama.com/download](https://ollama.com/download), then `ollama pull qwen2.5:3b` |
| *Optional:* Anthropic API key, only to use Claude | [console.anthropic.com](https://console.anthropic.com) | same |

**Hardware.** Everything was developed and measured on an 8 GB M1 MacBook Air. The 3B model is a 1.9 GB download and answers in about 5–20 seconds there. With 16 GB or more you can use a larger, better model, for example `OLLAMA_MODEL=qwen2.5:7b` (run `ollama pull qwen2.5:7b` first).

If you'd rather not install Postgres, the official pgvector image works:

```bash
docker run -d --name myrag-db -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=myrag -p 5432:5432 pgvector/pgvector:pg18
export DATABASE_URL=postgres://postgres@localhost:5432/myrag
```

### 2. Install

```bash
git clone <this repo> myrag && cd myrag

# JavaScript dependencies
npm install

# Python environment for unstructured (about 1.7 GB, mostly PyTorch for the layout model)
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Database (skip if you used Docker)
brew services start postgresql@18      # Linux: sudo systemctl start postgresql
createdb myrag                         # the pgvector extension is created automatically

# Free local model for answers (1.9 GB download, once)
brew services start ollama             # Linux: the installer sets up a systemd service
ollama pull qwen2.5:3b
```

### 3. Configure

All settings are environment variables with working defaults. **Nothing is required**: the defaults use the free local model.

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | Who writes answers: `ollama` (free, local) or `anthropic` (Claude; needs a key) |
| `JUDGE_PROVIDER` | same as `LLM_PROVIDER` | Who grades answers in `eval:answers` |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Local model (must be pulled with `ollama pull` first) |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama is listening |
| `ANTHROPIC_API_KEY` | none | Only needed when a provider is set to `anthropic` |
| `DATABASE_URL` | `postgres://localhost:5432/myrag` | Postgres connection |
| `ANSWER_MODEL` / `JUDGE_MODEL` | `OLLAMA_MODEL`, or `claude-opus-5-5` for Anthropic | Override the model per role |
| `EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | Embedding model (changing it requires `npm run index`) |
| `RERANK_MODEL` / `RERANK_CANDIDATES` | `Xenova/ms-marco-MiniLM-L-6-v2` / `30` | Reranker and how many candidates it re-scores |
| `CHUNK_TARGET_TOKENS` / `CHUNK_OVERLAP_TOKENS` | `250` / `40` | Chunk sizing |
| `PORT` | `8787` | API server port |

To use Claude instead of the local model (optional):

```bash
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Build the index

```bash
npm run build
```

This runs four steps, each of which can also be run on its own:

| Step | Command | Time (Apple Silicon, CPU) |
|---|---|---|
| Download the 5 documents | `npm run fetch` | seconds |
| Partition with `unstructured` `hi_res` | `npm run partition` | **about 13 minutes** (OCR + layout model); cached afterwards |
| Clean and map to blocks | `npm run ingest` | seconds |
| Chunk, embed, write to Postgres | `npm run index` | about 30 s (models download once on first run) |

> In a hurry? `npm run partition -- --strategy fast --force` partitions in about 15 seconds. It skips table detection and gives somewhat lower retrieval scores (see [Results](#results)).

### Setup on Windows

> **Not tested on Windows.** The project was built and measured on macOS. The steps below use standard Windows tooling and the project's commands are written to be cross-platform, but expect to adapt a step or two.

**Option A, recommended: WSL 2 (Linux inside Windows).** This avoids nearly all Windows-specific issues.

1. In PowerShell **as Administrator**: `wsl --install`, then restart. This installs Ubuntu.
2. Open the **Ubuntu** app and follow the Linux instructions above, cloning the repo inside Ubuntu (for example `~/myrag`, not under `/mnt/c/`, which is much slower).
3. Install **Ollama for Windows** ([ollama.com/download](https://ollama.com/download)) and run `ollama pull qwen2.5:3b` in PowerShell. Recent WSL versions let Ubuntu reach it at `localhost:11434`. If they can't, install Ollama inside Ubuntu instead (`curl -fsSL https://ollama.com/install.sh | sh`).
4. Open http://localhost:5173 in your normal Windows browser; WSL forwards the port.

**Option B: native Windows (PowerShell).**

1. **Install the tools** with `winget`, which is built into Windows 10/11:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Python.Python.3.12
   winget install Ollama.Ollama
   winget install Docker.DockerDesktop
   winget install UB-Mannheim.TesseractOCR
   ```
   For **poppler**, download the latest release zip from [poppler-windows](https://github.com/oschwartz10612/poppler-windows/releases) and add its `Library\bin` folder to your `PATH` (or `choco install poppler` if you use Chocolatey). Add Tesseract's install folder (usually `C:\Program Files\Tesseract-OCR`) to `PATH` too. Then open a **new** PowerShell window so the `PATH` changes apply.

2. **Run Postgres + pgvector in Docker.** pgvector has no simple Windows installer, so Docker is by far the easiest route. Start Docker Desktop, then:
   ```powershell
   docker run -d --name myrag-db -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=myrag -p 5432:5432 pgvector/pgvector:pg18
   $env:DATABASE_URL = "postgres://postgres@localhost:5432/myrag"
   ```
   The `myrag` database is created by the container; no `createdb` needed.

3. **Install the project:**
   ```powershell
   git clone <this repo> myrag; cd myrag
   npm install
   py -3.12 -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   ollama pull qwen2.5:3b          # Ollama for Windows runs in the background after install
   ```

4. **Build and run** with the same commands as macOS: `npm run build`, then `npm run dev`. Environment variables use PowerShell syntax: `$env:NAME = "value"`.

---

## Running it

> **Start the background services first.** The app needs Postgres (the search index) and Ollama (the local model). Homebrew starts both at login unless you stopped them, for example with the steps in [Turning everything off](#turning-everything-off). To check and start them:
>
> ```bash
> brew services list | grep -E "postgresql|ollama"                    # both should say "started"
> brew services start postgresql@18 && brew services start ollama     # if not
> ```
>
> Without Postgres the app can't start and prints a connection error. Without Ollama, search and the Evals tab still work, but asking a question shows how to start it. On Windows, start Docker Desktop (`docker start myrag-db`) and Ollama from the Start menu.

### Web app

```bash
npm run dev       # API on :8787 + Vite on :5173 with hot reload → open http://localhost:5173
npm start         # production: builds the UI and serves UI + API from :8787
```

On startup the API prints which model will answer (for example `Answering with qwen2.5:3b via Ollama (free, local)`) or a one-line fix if Ollama isn't running. Search and the evals dashboard work even without a model.

### Command line

| Command | What it does |
|---|---|
| `npm run ask -- "What are the CSF 2.0 Tiers?"` | Answer with citations in the terminal (streams) |
| `npm run search -- "GV.SC-05" --mode lexical --k 5` | Debug retrieval; modes: `lexical`, `dense`, `hybrid`, `hybrid+rerank` |
| `npm run eval:validate` | Check that every gold evidence quote exists in the parsed text |
| `npm run eval:retrieval` | Search metrics for all four retrieval modes (free, local) |
| `npm run eval:retrieval -- --sweep` | Also rebuild throwaway indexes at 150–800-token chunks and compare |
| `npm run eval:answers` | Answer and grade all 35 questions (free with the local model, about 17–25 min) |
| `npm run eval:answers -- --limit 5` | Quick smoke test of the answer eval |
| `JUDGE_PROVIDER=anthropic npm run eval:answers -- --reference` | Grade with Claude (trustworthy scores, about $1–3) and save to `eval/reference/` for committing |
| `npm test` / `npm run typecheck` | Unit tests / typecheck the pipeline and UI |

Eval runs are saved to `eval/results/` (git-ignored) as timestamped JSON files. Runs saved with `--reference` go to `eval/reference/`, which **is committed**, so anyone who clones the repo sees real scores in the dashboard without running anything. The dashboard lists both kinds, preferring your own newest run.

---

## How long things take

Some steps here are slow, especially the first time and on a laptop. Times marked **measured** were recorded on the development machine: an **8 GB Apple M1 MacBook Air, CPU only**, running the default local model. Times marked *estimate* weren't timed precisely and depend mostly on your internet connection.

### One-time setup

| Step | Time | Notes |
|---|---|---|
| `npm install` | *a few minutes (estimate)* | About 1 GB of packages |
| Python environment (`pip install -r requirements.txt`) | *5–15 minutes (estimate)* | About 1.8 GB, mostly PyTorch |
| `ollama pull qwen2.5:3b` | *a few minutes (estimate)* | 1.9 GB download |
| `npm run fetch` | **seconds (measured)** | 5 documents, about 5 MB |
| `npm run partition` (`hi_res`) | **about 13 minutes (measured)**: 3.8, 6.6 and 2.4 min for the three PDFs; under a second per Word file | Renders and analyzes every page. Runs once; later runs reuse the output unless you pass `--force`. The first run also downloads about 300 MB of layout models. |
| `npm run partition -- --strategy fast --force` | **about 12 seconds (measured)** | The quick alternative; no table structure |
| `npm run ingest` | **seconds (measured)** | |
| `npm run index` | **19–28 seconds (measured)** | Plus a one-time download of about 340 MB of embedding and reranker models |

### Everyday use

| Action | Time | Notes |
|---|---|---|
| Starting `npm run dev` | *10–20 seconds (estimate)* before answers work | Loads the search models |
| Search for a question | **about 1.7 seconds (measured)** | Keyword + vector search + reranking |
| Local answer (Ollama) | **5–20 seconds (measured)**: 12 s for a declined question, 18 s for a cited answer including model load | Text streams in as it's written, so you start reading sooner |
| First question after 5+ idle minutes | *a few extra seconds (estimate)* | Ollama unloads the model after 5 idle minutes and reloads it on demand |
| Claude answer (optional) | *not measured* | Likely faster than the local model on this hardware, since the work runs on Anthropic's servers |

### Evaluations

| Command | Time | Notes |
|---|---|---|
| `npm test` | **under 1 second (measured)** | |
| `npm run eval:retrieval` | *1–2 minutes (estimate)* | 4 search methods × 31 questions |
| `npm run eval:retrieval -- --sweep` | **about 6 minutes (measured)**, including the main eval | Re-indexes the corpus at 5 chunk sizes |
| `npm run eval:answers -- --limit 3` | **71 seconds (measured)** | Quick check |
| `npm run eval:answers` (local) | **17–25 minutes (measured, two full runs)** | 105 calls to the local model (35 answers + 70 grading calls), about 10–14 s each |

### What makes things slower or faster

- **Running two heavy things at once.** The app and an answer eval share the one local model, so each waits for the other. Run evals when you're not using the app.
- **Your hardware.** These numbers are from a small 8 GB laptop with no GPU. Machines with more memory or a recent GPU will be noticeably faster, and can run a larger, better model (for example `qwen2.5:7b`) at similar speed.
- **First runs.** Model downloads happen once, and later runs are faster.
- **Bigger models are slower.** A 7B model is roughly 2–3× slower than the 3B default on the same machine (*estimate*).
- **Claude** moves the answer and grading work to Anthropic's servers, so the slowest steps get much faster, at a cost.

---

## Choosing the answering model: Ollama or Claude

One setting, `LLM_PROVIDER`, decides who writes the answers. Search, citations, and the UI work the same either way.

| | **Ollama (default)** | **Claude** |
|---|---|---|
| Cost | Free | Pay per use (fractions of a cent per question; about $1–3 for a full answer eval) |
| Needs | Ollama running with `qwen2.5:3b` pulled | An Anthropic API key |
| Runs | On your computer, offline | On Anthropic's servers |
| Answer quality | Good on simple questions; shorter, sometimes incomplete on long lists | Noticeably more complete and reliable |
| Citations | `[n]` markers checked against the source by this project; unverified ones are flagged | Exact quotes guaranteed by the API |

### Switch to Claude

Set two environment variables in the terminal you'll start the app from, then start (or restart) it:

macOS / Linux:
```bash
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...      # from console.anthropic.com
npm run dev
```

Windows (PowerShell):
```powershell
$env:LLM_PROVIDER = "anthropic"
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run dev
```

These settings last until you close that terminal. The server reads them **at startup**, so stop it with Ctrl+C and start it again after changing them.

### Switch back to Ollama (free)

Close the terminal and open a new one, or clear the setting:

```bash
unset LLM_PROVIDER                              # macOS / Linux
```
```powershell
Remove-Item Env:LLM_PROVIDER                    # Windows PowerShell
```

### Check which one is active

- **Terminal:** on startup the API prints `Answering with qwen2.5:3b via Ollama (free, local)`, or warns if `LLM_PROVIDER=anthropic` is set without a key.
- **Ask screen:** each answer shows the model name, and either "free · local" or its cost.
- **Command line:** `curl localhost:8787/api/health` includes `"llm":{"provider":…,"model":…}`.

### Other combinations

- **A bigger free model** (needs about 16 GB of RAM): `ollama pull qwen2.5:7b`, then set `OLLAMA_MODEL=qwen2.5:7b`.
- **Answer locally, grade with Claude** (trustworthy eval scores for about a third of the cost of an all-Claude run): `JUDGE_PROVIDER=anthropic npm run eval:answers` with `ANTHROPIC_API_KEY` set.
- **Make a setting permanent:** add the `export` lines to your shell profile (`~/.zshrc` or `~/.bashrc`). On Windows, use `setx LLM_PROVIDER anthropic`, which applies to terminals opened afterwards.

---

## Turning everything off

This project starts background services that keep running after you close the terminal, and Homebrew restarts them **every time you log in**. Here's how to stop everything, check that it stopped, and optionally reclaim disk space. Steps 1–5 are for macOS (Linux notes inline); **Windows users:** see [Turning everything off on Windows](#turning-everything-off-on-windows).

### 1. Stop the app

In the terminal running `npm run dev` or `npm start`, press **Ctrl+C**. That stops both the API server (port 8787) and the web server (port 5173). Check that nothing is still listening:

```bash
lsof -nP -iTCP:5173 -iTCP:8787 -sTCP:LISTEN     # no output = stopped
```

If something is left over (for example, the terminal was closed instead of stopped), end it:

```bash
lsof -ti :5173,8787 | xargs kill
```

Long-running commands like `npm run eval:answers` or `npm run partition` also stop with **Ctrl+C**.

### 2. Stop the background services

```bash
ollama stop qwen2.5:3b                  # free the model's 2–3 GB of RAM right away (otherwise ~5 min after last use)
brew services stop ollama               # stop the Ollama server and don't restart it at login
brew services stop postgresql@18        # stop Postgres and don't restart it at login
```

> **Postgres is shared.** If you use Homebrew Postgres for other projects, stopping it stops those databases too. To remove only this project's data, keep the service running and use `dropdb myrag` (step 4).

If you ran Postgres in Docker instead: `docker stop myrag-db` (and `docker rm myrag-db` to delete it).

### 3. Check that everything is off

```bash
brew services list | grep -E "ollama|postgresql"   # both should say "none" or "stopped"
pgrep -fl "ollama|postgres|tsx|vite"               # no output = nothing left running
```

To use the project again later: `brew services start postgresql@18 && brew services start ollama`, then `npm run dev`.

### 4. Optional: reclaim disk space

Everything this project downloads or generates, from largest to smallest. Skip anything you want to keep.

| What | Size (measured) | Remove with |
|---|---|---|
| Python environment for `unstructured` (includes PyTorch) | ~1.8 GB | `rm -rf .venv` |
| Local language model | ~1.9 GB | `ollama rm qwen2.5:3b` |
| JavaScript dependencies, including the cached embedding and reranker models | ~0.95 GB | `rm -rf node_modules` |
| `unstructured` layout and table models (shared Hugging Face cache) | ~0.3 GB | `rm -rf ~/.cache/huggingface/hub/models--unstructuredio--yolo_x_layout ~/.cache/huggingface/hub/models--microsoft--table-transformer-structure-recognition` |
| Downloaded documents, partitions, parsed blocks | ~7 MB | `rm -rf data` |
| Database (chunks, vectors, indexes) | ~13 MB | `dropdb myrag` (while Postgres is running) |
| Built UI and your local eval runs | < 1 MB | `rm -rf web/dist eval/results/*.json` |

Rebuilding afterwards is `npm install`, the venv steps from [Setup](#setup), `createdb myrag`, `ollama pull qwen2.5:3b`, and `npm run build`.

### 5. Optional: uninstall the tools

Only if nothing else on your machine uses them:

```bash
brew uninstall ollama pgvector poppler tesseract
brew uninstall postgresql@18        # deletes the server, not its data directory; see `brew info postgresql@18`
rm -rf ~/.ollama                    # Ollama's model store, if you're done with local models entirely
```

### Turning everything off on Windows

> Not tested on Windows; these are the standard equivalents.

**If you used WSL 2 (Option A):** stop the app with **Ctrl+C**, then in the Ubuntu terminal run `sudo service postgresql stop` and, if you installed Ollama inside Ubuntu, `sudo systemctl stop ollama`. Finally, from PowerShell, `wsl --shutdown` stops the whole Linux environment and frees its memory. Quit Ollama for Windows as described below if you installed it there.

**If you ran natively (Option B), in PowerShell:**

1. **Stop the app:** press **Ctrl+C** in the terminal running `npm run dev`. To end anything still holding the app's ports:
   ```powershell
   Get-NetTCPConnection -LocalPort 5173,8787 -State Listen -ErrorAction SilentlyContinue |
     ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
   ```
2. **Stop Ollama:** `ollama stop qwen2.5:3b` frees the model's memory. To stop Ollama itself, right-click the llama icon in the system tray and choose **Quit Ollama**, or:
   ```powershell
   Get-Process "ollama*" -ErrorAction SilentlyContinue | Stop-Process -Force
   ```
   Ollama for Windows starts at sign-in by default. Turn that off in **Settings → Apps → Startup** (toggle **Ollama** off).
3. **Stop the database:** `docker stop myrag-db`, then quit **Docker Desktop** from its tray icon. Docker Desktop can also start at sign-in: Docker Desktop → **Settings → General → Start Docker Desktop when you sign in**.
4. **Check:** `Get-Process "ollama*","node","com.docker*" -ErrorAction SilentlyContinue` should show nothing related to this project.
5. **Optional, reclaim disk space:**
   ```powershell
   Remove-Item -Recurse -Force .venv, node_modules, data, web\dist
   ollama rm qwen2.5:3b
   docker rm myrag-db
   docker rmi pgvector/pgvector:pg18
   Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\huggingface\hub\models--unstructuredio--yolo_x_layout",
     "$env:USERPROFILE\.cache\huggingface\hub\models--microsoft--table-transformer-structure-recognition"
   ```
6. **Optional, uninstall the tools** (only if nothing else uses them): `winget uninstall Ollama.Ollama`, and likewise for `Docker.DockerDesktop`, `UB-Mannheim.TesseractOCR`, `Python.Python.3.12`, and `OpenJS.NodeJS.LTS`.

---

## How the evals work

### In plain English

Building a demo that answers *some* questions well is easy. The hard part is knowing how often it's right, and noticing when a change makes things worse. So this project tests itself the way a teacher grades an exam: with an answer key written in advance.

**The answer key.** The project has 35 test questions. For each one, the exact sentence from the source document that answers it was copied alongside it; that sentence is the "gold evidence". A script confirms every gold sentence really appears in the documents. (The questions and gold sentences were written by Claude while reading the documents, not by a human domain expert; see [How this project was built](#how-this-project-was-built).) The questions are deliberately mixed:

- **Simple facts** ("What does the MEASURE function do?")
- **Lists** ("What are the six CSF Functions?")
- **ID lookups** ("What does GV.SC-05 require?"). Search systems often miss these codes.
- **Paraphrases** that use different words from the document ("How does the AI RMF define how much risk an organization is willing to accept?", where the document says "risk tolerance")
- **Two-document questions** that need a passage from each document
- **Four trick questions** the documents can't answer ("What's the EU AI Act's maximum fine?")

**Test 1: does search find the right passage?** For each question we run the search and check whether a passage containing the gold sentence comes back, and how near the top. If search misses, the AI can't answer correctly no matter how capable it is, so this is the first thing to get right. This test runs on your machine and is free. It produces three scores:

> **Think of a librarian.** You ask a question, and the librarian hands you a short stack of pages, best guess on top. We already know which page holds the answer. Each score asks a slightly different question about that stack.
>
> - **Recall@k: "Was the right page in the stack at all?"** The *k* is the size of the stack. Recall@5 counts how often the right page was somewhere in the top 5. A recall@5 of 0.90 means that for 90 of every 100 questions, the answer was among the five pages handed to the AI. The AI reads the whole stack, so this is the most important score: if the right page isn't there, a correct answer is impossible. Higher k is easier (a bigger stack is more likely to include it), which is why the dashboard shows k = 1, 3, 5, and 10 side by side.
>
> - **MRR (mean reciprocal rank): "How close to the top was it?"** If the right page is on top, the question scores 1. Second from the top scores ½, third scores ⅓, and so on; not in the top 10 scores 0. MRR is the average across all questions. An MRR of 0.80 roughly means the right page is usually first, sometimes second. Recall only asks *whether* the page was found; MRR rewards finding it *early*, which matters because the AI pays most attention to the first passages and a user skimming sources looks at the top one.
>
> - **nDCG (normalized discounted cumulative gain): "How good was the whole ordering?"** Some questions need two pages, for example one from each of two documents. nDCG gives credit for every right page in the stack, but less credit the further down each one sits, then compares the result with the best possible ordering. 1.0 means every needed page was at the very top; lower means they were present but buried, or missing. It's the fairest single score when a question has more than one answer passage.
>
> All three run from 0 to 1, and higher is better. In short: recall says *did we find it?*, MRR says *how quickly?*, and nDCG says *how well did we rank everything that mattered?*

**Test 2: does the AI stick to the sources?** A second AI acts as a strict grader. It breaks each answer into individual claims ("CSF 2.0 has four Tiers", "Tier 1 is called Partial") and checks every claim against the passages the system actually retrieved. A claim the passages don't back counts against the answer, *even if it's true in the real world*, because the whole point is that answers come from the documents. That score is **faithfulness**.

**Test 3: is the answer actually right?** Separately, the grader compares each answer with a reference answer stored with each test question. That score is **correctness**. An answer can be faithful but wrong (it quoted the wrong passage) or right but unfaithful (it answered from memory), which is why these are two separate tests.

**Test 4: does it know when to say "I don't know"?** For the trick questions, the right behavior is to decline. We count how often it does, and also how often it wrongly declines a question it *could* have answered.

**Why the grader can be trusted.** The grader never sees the reference answer when judging faithfulness, so it can't be swayed by what the "right" answer is. It must return a verdict for every claim in a fixed format, so the score is computed by code, not by the grader's impression. And the citations themselves are checked mechanically: the API guarantees the cited text is copied word for word from the source.

### Technical details

**Chunk-independent relevance labels.** Gold labels are evidence *quotes*, not chunk IDs. A retrieved chunk counts as relevant if it contains at least 60% of the quote's word trigrams, after lowercasing and stripping punctuation. Recall uses the *union* of the top-k chunks, so a quote split across a chunk boundary still counts. This is what makes the chunk-size sweep possible: the same golden set scores any chunking strategy, and re-chunking never invalidates labels. `npm run eval:validate` fails loudly if a parser change mangles the text a label points at; it caught one such regression during the move to `hi_res`.

| Metric | Definition |
|---|---|
| **Recall@k** | Share of gold evidence quotes covered by the top-k chunks, averaged over the 31 answerable questions |
| **MRR@10** | Mean of 1/rank of the first relevant chunk (0 if none in the top 10) |
| **nDCG@10** | Binary-relevance discounted cumulative gain; the ideal ranking puts one relevant chunk per evidence quote first |
| **Faithfulness** | Mean share of an answer's claims supported by its retrieved context (supported = 1, partially = 0.5, unsupported = 0); declined answers excluded |
| **Correctness** | Judge verdict against the human reference (correct = 1, partial = 0.5, incorrect = 0) |
| **Citation coverage** | Share of non-declined answers with at least one citation |
| **Citation precision** | Share of citations pointing at a chunk that contains gold evidence |
| **Abstention** | Unanswerable questions correctly declined / answerable questions wrongly declined |

**Judge design** (`src/eval/judge.ts`): two separate calls per answer. The faithfulness judge sees only the numbered retrieved passages and the answer. The correctness judge sees the question, the reference, and the answer. Both return structured output validated against Zod schemas (Ollama's JSON-schema mode or Claude's structured outputs), and the scores are computed in code from per-claim verdicts.

**Which grader to trust.** The grader follows `JUDGE_PROVIDER`, which defaults to the same free local model that writes the answers. That's convenient but weak: a 3B model makes visible grading mistakes (in testing it once marked an answer as missing an item the answer contained), and a model grading its own answers is a conflict of interest. The dashboard therefore labels locally graded runs **"indicative"**. For numbers you'd put in front of someone, grade with Claude (`JUDGE_PROVIDER=anthropic`) while still answering locally, and commit the run with `--reference`.

**Local citation check.** With the local model, `citation_support` reports the share of `[n]` markers whose sentence is backed by the cited passage (at least 60% of its key words present). It's a cheap, deterministic check that runs on every answer, not just in evals.

**Cost.** With the default local model, every eval is free; a full `eval:answers` run makes 105 local model calls and takes about 17–25 minutes on an 8 GB M1. With Claude as answerer and grader, a full run costs roughly $1–3 at Opus 5.5 pricing (an estimate; the script prints the measured cost at the end). Grading with Claude while answering locally costs about two-thirds of that. Use `--limit` for quick checks.

**Honest caveats.** With 31 answerable questions, one question moves recall@k by about 3 points and a question-type row by 20–50 points. Treat differences under about 5 points as noise. The questions were written by Claude while reading the same documents the system indexes, and haven't been reviewed by a person, so the set is closer to "known-item search" than to real user traffic. The [next steps](#known-limitations-and-next-steps) cover how to grow it.

---

## Code guide

```
corpus.json                 The 5 source documents: id, title, official URL, format
requirements.txt            Python dependency (unstructured[pdf,docx])
scripts/partition.py        Runs unstructured on data/raw/ → data/unstructured/<id>.json
scripts/partition.mjs       Cross-platform launcher (`npm run partition`): finds the venv's Python on macOS, Linux, or Windows
eval/golden.jsonl           35 test questions with gold evidence quotes (written by Claude)
eval/results/               Your eval runs (git-ignored), read by the dashboard
eval/reference/             Committed reference runs, so the dashboard has real scores out of the box
src/                        Pipeline, retrieval, answering, evals, API (TypeScript)
web/                        React UI (Ask screen + evals dashboard)
test/                       Vitest unit tests
data/                       Generated artifacts (git-ignored): raw files, partitions, parsed blocks
```

### Pipeline (`src/`)

| File | What it does |
|---|---|
| `config.ts` | Every setting in one place (paths, models, chunk sizes, `DATABASE_URL`), each overridable by environment variable. |
| `types.ts` | Core data shapes: `Block` (heading/paragraph/list/table with page and level), `ParsedDoc`, `Chunk` (text, section path, page range), `RetrievedChunk`. |
| `corpus.ts` | Loads `corpus.json`. |
| `ingest/clean.ts` | Text normalization shared by the mapper: Unicode/ligature/quote cleanup, page-number detection, running-header keys, and vocabulary-aware hyphenation repair. |
| `ingest/unstructured.ts` | Maps `unstructured` elements to `Block`s. Drops page furniture and table-of-contents pages, infers heading levels, rejects false titles, rejoins page-split paragraphs, and builds table text by **re-aligning OCR'd grid cells to exact text-layer words** (`realignCells`). Reports per-document stats. |
| `chunk.ts` | Structure-aware chunker. Major headings always start a new chunk; minor ones (run-in bold subheads) stay inline so tiny subsections merge. Oversized blocks split by sentence (prose) or row (tables). Adds overlap, and `contextualText()` prepends the title and section path for embedding. |
| `embed.ts` | Local bge-small embeddings via transformers.js, with the bge query instruction prefix. |
| `rerank.ts` | Local cross-encoder scoring of (question, passage) pairs. |
| `lexical.ts` | Prepares keyword search: OR'd English tsqueries, plus compact control-identifier terms that Postgres's parser would otherwise split. |
| `store.ts` | **The pgvector layer.** Creates the schema (documents, chunks with `vector(384)` + generated `tsvector`, HNSW and GIN indexes, BM25 term stats) and implements `dense()`, `lexical()` (BM25 in SQL), and `hybrid()` (reciprocal rank fusion in one SQL statement). Each index lives in its own Postgres schema, so experiments can't touch the main one. |
| `retrieve.ts` | `Retriever.search()` for the four modes, and `searchWithTrace()`, which also reports each result's rank under every method (powers "Why these sources?"). |
| `llm.ts` | Lazily created Anthropic client (never touched in the default free setup), server-side refusal-fallback settings, and a `UsageMeter` that totals tokens and cost (local models count as $0). |
| `ollama.ts` | Minimal client for the local Ollama server: streaming chat for answers, JSON-schema-constrained chat for the judge, and setup hints when Ollama isn't running or the model isn't pulled. |
| `citations.ts` | Citations for models without a citations API: `CitationTracker` holds back half-streamed markers, renumbers passages by first use, and verifies each cited sentence against its passage (`supportScore`), choosing the best-matching passage sentence to highlight (`bestSentence`). |
| `answer.ts` | Grounded answering with two engines behind `answerQuestion()`: the local model (numbered passages, `[n]` markers, verified by `CitationTracker`) or Claude (citation-enabled document blocks whose citation deltas become numbered markers). Detects declines, including small models' paraphrases of the decline phrase. |
| `server.ts` | Hono HTTP API: `/api/ask` (server-sent events: sources → text → citations → done), `/api/documents`, `/api/evals`, `/api/golden`. Serves the built UI in production. |

### Command-line entry points (`src/cli/`)

| File | Script | What it does |
|---|---|---|
| `fetch.ts` | `npm run fetch` | Downloads the corpus (skips files already present) |
| `ingest.ts` | `npm run ingest` | Partitions → blocks; prints a diagnostics table |
| `build-index.ts` | `npm run index` | Chunks, embeds, and writes everything to Postgres |
| `search.ts` | `npm run search` | Prints ranked chunks for a query in any mode |
| `ask.ts` | `npm run ask` | Streams a cited answer in the terminal |
| `validate-golden.ts` | `npm run eval:validate` | Verifies gold quotes exist in the parsed corpus |
| `eval-retrieval.ts` | `npm run eval:retrieval` | Retrieval metrics per mode, by question type, misses, optional chunk-size sweep |
| `eval-answers.ts` | `npm run eval:answers` | End-to-end answer + judge eval with cost report |

### Evaluation library (`src/eval/`)

| File | What it does |
|---|---|
| `golden.ts` | Loads `eval/golden.jsonl` |
| `metrics.ts` | Trigram-coverage relevance, recall@k (union of top-k), MRR, nDCG |
| `retrieval.ts` | Runs one retrieval mode over the golden set; aggregates overall and per question type |
| `judge.ts` | Faithfulness and correctness judges, provider-agnostic: one Zod schema drives both Ollama's JSON-schema output and Claude's structured outputs |

### Web UI (`web/`)

| File | What it does |
|---|---|
| `vite.config.ts` | Dev server on :5173 proxying `/api` to :8787 |
| `src/main.tsx` | App shell: tabs (Ask / Evals) via URL hash, light/dark toggle |
| `src/api.ts` | Typed API client, including a small server-sent-events parser for the streaming `/api/ask` |
| `src/pages/Ask.tsx` | Question box and examples; streaming answer with citation chips; source cards with the cited span highlighted and a deep link to the PDF page; "Why these sources?" rank table; clear "not in the documents" state |
| `src/pages/Evals.tsx` | Plain-English explainer, run pickers, score tiles, recall chart, chunk-size sweep, question-type table, per-question and per-answer drill-downs |
| `src/components/Charts.tsx` | Dependency-free SVG line and column charts: drawn at measured pixel width, hover tooltips, direct labels, keyboard focus |
| `src/styles.css` | Design tokens (light and dark), layout, and a validated colorblind-safe series palette |

### Tests (`test/`)

`citations.test.ts` (marker streaming, renumbering, verification, invalid and grouped markers), `clean.test.ts` (normalization, hyphenation, page furniture, OCR cell realignment), `chunk.test.ts` (size limits, section boundaries, minor-heading folding, overlap, contextual headers), `retrieval.test.ts` (identifier extraction, tsquery building, every metric including split-evidence recall).

---

## Design decisions and lessons learned

These came from measuring, not guessing. Each one changed a number in the eval.

1. **Hybrid search beats either method alone.** Keyword search finds exact IDs ("GV.SC-05") that embeddings blur; vector search finds paraphrases that share no words with the question. Fusing their rankings recovers both. The cross-encoder reranker reads the question and passage *together*, which mainly improves the ordering (recall@1 and MRR); the "Why these sources?" panel in the UI shows it moving passages around for any question.

2. **Postgres's built-in text ranking isn't BM25, and the difference is large.** With keyword search moved into Postgres using `ts_rank_cd`, keyword recall@5 was **0.532**. `ts_rank`/`ts_rank_cd` have no inverse document frequency, so "AI" and "risk" count as much as rare, specific words. Implementing BM25 in SQL, from Postgres's own term statistics (`ts_stat`) and the per-lexeme frequencies stored in each `tsvector`, raised it to **0.871** on the same parse and index. That's also above the earlier in-app BM25 (0.742, different parser), helped by Postgres's English stemming.

3. **Postgres splits control identifiers.** Its parser reads "GV.SC-05" as the hostname "GV.SC" plus the integer "-05". A second, unstemmed lexeme set (`gvsc05`, `gvsc`) restores exact ID lookups.

4. **`hi_res` gives table structure, but OCR'd text.** `hi_res` recovered the GenAI Profile's Action ID / Suggested Action / GAI Risks grid, which neither text-based parser could. But its cell text comes from OCR ("Al system inventor . eB . y"), while the element's flat text comes from the PDF text layer and is exact. `realignCells()` keeps the grid and re-fills each cell with exact words, anchored in reading order. The golden-set validator caught this when one gold quote stopped matching.

5. **The section path is part of the content.** Prepending "Document > Section > Subsection" to each chunk before embedding makes pronoun-heavy passages ("This function…") retrievable.

6. **Chunk size mattered less than expected.** From 150 to 500 tokens, recall@5 moved by only one question. 150 tokens scored slightly best, 800 slightly worst (see the sweep). The default stays at 250 so each passage handed to the answering model keeps more context; the answer eval is the right tool to settle it.

7. **Native citations instead of "please cite [1]" prompting.** The citations API returns verbatim `cited_text` spans tied to specific document blocks. They can't be invented, and the UI can highlight the exact sentence.

8. **Rerankers don't understand control IDs, so exact-ID matches get a guard.** The MS MARCO cross-encoder (trained on web prose) pushed the one chunk containing "GV-1.6-001" out of the top 5, even though BM25 ranked it #1 by a wide margin. The reranker now keeps candidates that contain every full identifier in the question ahead of those that don't. Questions without identifiers are unaffected.

9. **A free local model works for this task, with guardrails.** Qwen 2.5 3B answers simple factual questions well. It needs three things Claude doesn't: (a) citation verification, because a small model sometimes attaches `[n]` to a claim its passage doesn't contain; (b) a format example about an *unrelated* topic, because with an on-topic example it copied the example's content into a real answer, which the faithfulness grader caught on the first test run; and (c) fuzzy decline detection, because it paraphrases "I can't answer that from the provided documents."

10. **Separate judges for faithfulness and correctness.** They fail differently. A single judge that also sees the reference tends to excuse unsupported claims that happen to be true.

## How the design evolved

The project didn't start in its final form. Each change below was either requested by the project owner during development or forced by a measurement, and the eval made it possible to see what each change cost or gained. Recall@5 and MRR are for the default retrieval mode at the time.

| Area | Started with | Ended with | Why it changed |
|---|---|---|---|
| **Language** | TypeScript (owner's choice) | TypeScript | Unchanged. One language across pipeline, API, and UI. |
| **PDF and Word parsing** | Custom parsers: `unpdf` (pdf.js) rebuilding lines, headings, and tables from positioned text, and `mammoth` with a custom style map for Word | Open-source **`unstructured`** via a Python script, plus a TypeScript mapping layer | Owner's request: a maintained, general-purpose parser instead of hand-tuned heuristics. **Measured cost:** recall@5 fell from 0.952 to 0.887 (about two questions), with MRR unchanged. The custom parser was tuned to these five documents; `unstructured` is more likely to hold up on new ones. |
| **`unstructured` strategy** | `fast` (text layer only, ~15 s for the corpus) | **`hi_res`** (layout model + OCR, ~13 min) | Owner's request, for table structure. It recovered real tables (e.g. the GenAI Profile's Action ID / Suggested Action / GAI Risks rows) but didn't raise search scores, and its OCR'd cell text had errors. That led to **re-filling OCR'd cells with exact text-layer words** (`realignCells`). |
| **Storage** | `chunks.json` + a flat `Float32` vector file, brute-force cosine search in Node | **Postgres 18 + pgvector** (HNSW + GIN indexes), each index in its own schema | Owner's request, and closer to production: one store for vectors, keyword search, and metadata, with hybrid fusion in a single SQL query. Brute force was exact and fast at 400 chunks, but doesn't scale. |
| **Keyword search** | BM25 implemented in TypeScript, in memory | Postgres `ts_rank_cd` → **BM25 implemented in SQL** | Moving to Postgres's built-in ranking dropped keyword recall@5 from 0.742 to **0.532**: `ts_rank` has no inverse document frequency. Rewriting BM25 in SQL over Postgres's own term statistics brought it to **0.871**, the best of the three thanks to Postgres's stemming. |
| **Control identifiers** ("GV.SC-05") | The in-memory tokenizer indexed compound IDs and their parts | A separate unstemmed identifier column (`gvsc05`, `gvsc`) | Postgres's parser splits IDs into a "host" and an "integer", so exact ID lookups broke after the move. |
| **Reranking** | None (hybrid fusion only) | **ms-marco-MiniLM-L-6-v2** cross-encoder + an **exact-identifier guard** | The reranker lifted recall@3 from 0.68 to 0.89 in the first version. `bge-reranker-base` was tried first but took ~54 s to load on CPU versus ~5 s. Later, the reranker buried an exact ID match, so candidates containing every ID in the question now stay on top (ID questions' recall@1: 0.33 → 1.00). |
| **Chunking** | 350-token target, every heading starts a chunk | **250-token** target; minor headings (bold run-in subheads) stay inline | The first sweep favored ~250 tokens. Treating every bold subhead as a section boundary produced 42-token chunks in the NZ template. (The final sweep slightly favors 150; see [Results](#results).) |
| **Answering model** | **Claude Opus 5.5** with native citations, the only option | **Qwen 2.5 3B via Ollama** by default (free, local) + **citation verification**; Claude optional | Owner's request: nobody should have to pay or sign up to run it. A 3B model fits an 8 GB laptop. Without a citations API, `[n]` markers are now checked against the cited passage, and the prompt's format example was moved to an unrelated topic after the model copied an on-topic example into a real answer. |
| **Answer delivery** | One response, printed when complete | **Streamed** token by token (server-sent events) | Needed for the web UI; small local models are slow enough that streaming matters even more. |
| **Answer grading** | Claude judge only | Same provider as answering by default (free), labeled **"indicative"** when local; trustworthy runs graded by Claude and committed to `eval/reference/` | Keeps evals free by default without passing off a 3B model's grades as authoritative. |
| **Interface** | Command line only | **React + Vite** UI (Ask + Evals) on a **Hono** API | Owner's request. Reviewers click a link more often than they clone a repo; the dashboard makes the evals understandable to non-engineers. |
| **Charts** | SVG scaled with `viewBox` | SVG drawn at the measured container width | Scaling made chart text twice its intended size on wide screens and overflowed on phones; found by screenshotting the running UI. |
| **Gold labels** | Evidence *quotes* rather than chunk IDs | Unchanged | This early choice made every later change measurable: re-chunking, re-parsing, and re-indexing never invalidated the labels, and the validator flagged the one parse change that did break a quote. |

---

## Known limitations and next steps

**Limitations**
- **Table cell boundaries.** When a row's ID is vertically centered in a tall cell, the PDF's reading order puts it after the neighboring cell, so a few realigned cells are off by a phrase. Every word is still there, so retrieval is unaffected, but displayed tables can look slightly off.
- **Small golden set, written by the AI that built the system.** 35 questions, written by Claude from the documents themselves and not yet reviewed by a person. A human-written or human-reviewed set would be a stronger test.
- **Single-turn only.** No follow-up questions or conversation memory.
- **Small-model answers.** The default 3B model gives shorter, sometimes incomplete answers, especially for long lists, and follows citation rules less reliably than Claude. Citation verification catches unsupported citations but can't add missing content. On machines with 16 GB or more, `qwen2.5:7b` is a free upgrade.
- **Lexical citation check.** Verification compares key words, so a claim that paraphrases its passage heavily can be marked unverified even when it's correct.
- **`hi_res` is slow on CPU** (about 13 minutes for the three PDFs). Fine for a fixed corpus; a growing corpus would need a GPU or incremental partitioning.
- **Scanned PDFs** are supported by `hi_res` OCR in principle but untested here; all three NIST PDFs have text layers.

**Next steps**
- Grow the golden set from real usage: add thumbs up/down and a "wrong citation" flag in the UI, store them in Postgres, and promote flagged questions into the test set.
- Generate harder synthetic questions with Claude (multi-hop, negation, "which document…"), with human review before they join the set.
- Run the answer eval in CI on a 10-question subset for every change, with the full run nightly.
- A corpus inspector page: each PDF page next to its extracted blocks and tables.
- Query rewriting for paraphrase questions (currently the weakest category).

---

## Corpus and licensing

| Document | Publisher | Format |
|---|---|---|
| NIST AI 100-1, AI Risk Management Framework 1.0 | NIST (US Government) | PDF, 48 pp. |
| NIST AI 600-1, Generative AI Profile | NIST (US Government) | PDF, 64 pp. |
| NIST CSWP 29, Cybersecurity Framework 2.0 | NIST (US Government) | PDF, 32 pp. |
| Use of Artificial Intelligence Policy template | New Zealand Government (DIA) | DOCX |
| FedRAMP System Security Plan template | FedRAMP / GSA (US Government) | DOCX |

The documents are downloaded from their official URLs at build time and are not stored in this repository. US federal government works are generally in the public domain. The New Zealand template is Crown copyright, so check its licence terms on digital.govt.nz before redistributing it. This project's code is yours to license as you choose.

---

## How this project was built

**Short version: Paul Cornell directed this project; Claude wrote it.** Every line of code, every test, the test questions, and this README were written by **Claude**, Anthropic's AI model (Claude Opus 5.5), working as a coding agent in **[Claude Code](https://claude.com/claude-code)** on Paul's laptop. Paul set the goals, made the key technology and product decisions, approved changes to the machine it was built on, and asked the questions that shaped the result. Paul did not write or hand-edit any of the code. It was built in a single extended working session on October 4, 2026.

### What Paul did

- **Defined the project.** The opening brief: *"Help me create a RAG system over a real document corpus. Ingest messy PDFs and Word files, chunk them, embed them, retrieve, and answer with citations. Include retrieval evals (recall@k, answer faithfulness), not just a demo."* The stated purpose was a portfolio piece for Product Builder and AI Engineering roles.
- **Made the decisions Claude asked for:** TypeScript as the language, public government documents as the corpus, and free local embeddings instead of a paid embeddings API.
- **Redirected the architecture.** Each of these was Paul's call, and each changed the design (see [How the design evolved](#how-the-design-evolved)):
  - replace the custom parsers with the open-source `unstructured` library, then switch it to the slower, more thorough `hi_res` mode
  - store everything in a local Postgres + pgvector database, with both keyword and vector search in Postgres
  - build a web front end: the Ask screen and the evals dashboard
  - make the project **free for anyone to run**, which led to the local Ollama model becoming the default
- **Approved every change to the development machine:** installing Homebrew packages (pgvector, poppler, tesseract, Ollama) and starting the Postgres and Ollama background services.
- **Asked the questions that exposed gaps.** "Why did you choose vitest?" led to a comparison with Node's built-in test runner. Asking whether leftover files should be removed after the switches led to deleting dead code, a stale index, and outdated results. Asking whether the README made it clear how to run the project led to the Quick start.
- **Shaped the documentation for a non-technical audience.** Paul asked for plain-English explanations of the evals and of recall@k, MRR, nDCG, BM25, and reranking, in both the README and the dashboard, and also for Windows instructions, a "turn everything off" section so nobody is left with orphaned services, realistic time estimates, the design history, removal of a hard-to-read diagram, and this section.

### What Claude did

- **Wrote all of the code:** about 4,000 lines across the TypeScript pipeline, the SQL (including BM25 scoring in SQL), the Python partitioning script, the React UI and charts, and 26 unit tests.
- **Chose and checked the corpus:** found the five documents and confirmed each URL downloads.
- **Wrote the evaluation set:** the 35 test questions, their gold evidence quotes, and reference answers, plus the script that verifies every quote exists in the parsed text. These have not yet been reviewed by a person.
- **Ran everything:** installs, builds, evals, the chunk-size sweeps, and headless-browser screenshots to check the UI layout. All numbers in this README come from runs Claude executed on Paul's machine.
- **Made the smaller design choices on its own:** chunk sizes and overlap, gold labels as quotes rather than chunk IDs, reciprocal rank fusion, the reranker model, Qwen 2.5 3B as the local model, the citation-verification rule, the chart palette, and more.
- **Found and fixed problems by measuring**, among them:
  - Postgres's built-in ranking cutting keyword recall@5 from 0.742 to 0.532, fixed by implementing BM25 in SQL
  - the reranker burying exact control-ID matches
  - OCR errors in `hi_res` table cells
  - the local model copying the prompt's example into real answers
  - a grading call that ran for five minutes
  - charts that scaled their text
  - a Windows-only path bug
  - a number of inaccurate claims in its own README drafts, including an earlier statement that the test questions were written "by hand"

### The kinds of prompts Paul used

| Kind of prompt | Examples (Paul's words) |
|---|---|
| Project brief | *"Help me create a RAG system over a real document corpus… Include retrieval evals (recall@k, answer faithfulness), not just a demo."* |
| Technology direction | *"Instead of unpdf and mammoth, can you use the open-source unstructured.io library?"*, *"Can you switch to hi_res for all?"*, *"What about storing the outputs in a local pgvector database?"* |
| Questions about choices | *"What libraries are being used to do the file parsing?"*, *"Why did you choose vitest?"*, *"And where are you storing the outputs?"* |
| Product scope | *"What kind of front end did you design for this?"*, then *"yes, build the Ask screen and evals dashboard after"* |
| Constraints | *"Instead of providing the Anthropic API key, is there any free alternative? I don't want others to run it to have to pay any money to do so."* |
| Housekeeping | *"Are there any folders or files in this project that should be removed when the switch was made…?"* |
| Documentation for real readers | *"describe how the evals work--especially to non-technical readers"*, *"I don't understand what each Method actually does"*, *"any way to add Windows stuff?"*, *"add a section to the README that describes how to "turn everything off""* |
| Checking in | *"Are you stalled?"*, *"How much longer do you expect the answer eval will take?"*, *"Is this already clear in the README how to run it?"* |
| Attribution | *"I don't want anyone to think I wrote all this code myself."* |

### What hasn't been checked by a person

- The code hasn't been reviewed line by line by a human.
- The 35 test questions and their answers were written by Claude and not independently reviewed.
- The Windows instructions haven't been tested on Windows.
- The Claude answering path (`LLM_PROVIDER=anthropic`) and Claude-graded evals compile and follow the Anthropic SDK documentation, but no Anthropic API key was used during development, so they haven't been run against the live API.

If you're reading this as a portfolio project: Paul's contribution is the direction, decisions, and scrutiny described above; the implementation is Claude's.

