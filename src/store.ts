// pgvector-backed index. Postgres holds documents, chunks, embeddings and a full-text index, and
// does dense, lexical and hybrid (reciprocal rank fusion) search in SQL. Each index lives in its
// own schema, so experiments (e.g. the chunk-size sweep) don't touch the main index.
import pg from "pg";
import pgvector from "pgvector/pg";
import { contextualText } from "./chunk.js";
import { DATABASE_URL, EMBED_MODEL } from "./config.js";
import { buildTsQueries, identifierTerms } from "./lexical.js";
import type { Chunk, ParsedDoc } from "./types.js";

export interface IndexMeta {
  embedModel: string;
  dim: number;
  count: number;
  chunking: { targetTokens: number; overlapTokens: number };
  builtAt: string;
}

export interface Scored {
  chunk: Chunk;
  score: number;
}

const RRF_K = 60;
const CANDIDATES = 100;

export class PgStore {
  private constructor(
    private pool: pg.Pool,
    readonly schema: string,
  ) {}

  static async connect(schema = "public"): Promise<PgStore> {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
    // Session settings go in the startup packet so every pooled connection has them before its
    // first query (an async pool "connect" hook isn't awaited by pg and would race).
    // hnsw.ef_search bounds how many candidates an HNSW scan can return, so it must exceed CANDIDATES.
    const pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 4,
      options: `-c search_path=${schema},public -c hnsw.ef_search=${CANDIDATES * 2}`,
    });
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector");
    await admin.end();
    return new PgStore(pool, schema);
  }

  async close() {
    await this.pool.end();
  }

  async dropSchema() {
    if (this.schema === "public") throw new Error("Refusing to drop the public schema");
    await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
  }

  /** Drops and recreates this schema's tables. */
  async reset(dim: number) {
    const s = this.schema;
    await this.pool.query(`
      ${s === "public" ? "" : `DROP SCHEMA IF EXISTS ${s} CASCADE; CREATE SCHEMA ${s};`}
      DROP TABLE IF EXISTS ${s}.chunks, ${s}.documents, ${s}.index_meta, ${s}.term_stats CASCADE;
      CREATE TABLE ${s}.index_meta (
        id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        embed_model text NOT NULL, dim int NOT NULL, chunking jsonb NOT NULL, built_at timestamptz NOT NULL
      );
      CREATE TABLE ${s}.documents (
        id text PRIMARY KEY, title text NOT NULL, format text NOT NULL, source_url text NOT NULL, stats jsonb
      );
      CREATE TABLE ${s}.chunks (
        id text PRIMARY KEY,
        doc_id text NOT NULL REFERENCES ${s}.documents(id) ON DELETE CASCADE,
        ord int NOT NULL,
        section text[] NOT NULL,
        page_start int,
        page_end int,
        text text NOT NULL,
        contextual_text text NOT NULL,
        id_terms text NOT NULL DEFAULT '',
        doc_len int NOT NULL,
        embedding vector(${dim}) NOT NULL,
        tsv tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', contextual_text), 'B') || setweight(to_tsvector('simple', id_terms), 'A')
        ) STORED
      );
      CREATE INDEX ON ${s}.chunks USING hnsw (embedding vector_cosine_ops);
      CREATE INDEX ON ${s}.chunks USING gin (tsv);
      -- Document frequency per lexeme, for BM25's IDF term. Refreshed by write().
      CREATE TABLE ${s}.term_stats (word text PRIMARY KEY, ndoc int NOT NULL);
    `);
  }

  async write(docs: ParsedDoc[], chunks: Chunk[], vectors: Float32Array[], chunking: IndexMeta["chunking"]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO index_meta (embed_model, dim, chunking, built_at) VALUES ($1, $2, $3, now())`,
        [EMBED_MODEL, vectors[0].length, chunking],
      );
      for (const d of docs) {
        await client.query(`INSERT INTO documents (id, title, format, source_url, stats) VALUES ($1, $2, $3, $4, $5)`, [
          d.id, d.title, d.format, d.sourceUrl, d.stats,
        ]);
      }
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await client.query(
          `INSERT INTO chunks (id, doc_id, ord, section, page_start, page_end, text, contextual_text, id_terms, doc_len, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [c.id, c.docId, i, c.section, c.pageStart ?? null, c.pageEnd ?? null, c.text, contextualText(c),
           identifierTerms(contextualText(c)).join(" "), contextualText(c).split(/\s+/).length,
           pgvector.toSql(Array.from(vectors[i]))],
        );
      }
      await client.query(`INSERT INTO term_stats (word, ndoc) SELECT word, ndoc FROM ts_stat('SELECT tsv FROM ${this.schema}.chunks')`);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async meta(): Promise<IndexMeta> {
    const { rows } = await this.pool.query(
      `SELECT m.embed_model, m.dim, m.chunking, m.built_at, (SELECT count(*) FROM chunks)::int AS count FROM index_meta m`,
    );
    if (!rows.length) throw new Error(`No index in schema "${this.schema}"; run \`npm run index\`.`);
    const r = rows[0];
    if (r.embed_model !== EMBED_MODEL) {
      throw new Error(`Index was built with ${r.embed_model} but EMBED_MODEL=${EMBED_MODEL}; rebuild with \`npm run index\`.`);
    }
    return { embedModel: r.embed_model, dim: r.dim, count: r.count, chunking: r.chunking, builtAt: r.built_at.toISOString() };
  }

  async dense(queryVec: Float32Array, k: number): Promise<Scored[]> {
    const { rows } = await this.pool.query(
      `${CHUNK_COLUMNS_CTE}
       SELECT c.*, 1 - (ch.embedding <=> $1) AS score
       FROM chunks ch JOIN c USING (id)
       ORDER BY ch.embedding <=> $1 LIMIT $2`,
      [pgvector.toSql(Array.from(queryVec)), k],
    );
    return rows.map(toScored);
  }

  /**
   * BM25 over Postgres's full-text index. Built-in ts_rank/ts_rank_cd have no inverse document
   * frequency, so a common word ("risk", "AI") counts as much as a rare one; on this corpus that
   * cost ~20 points of recall@5 versus BM25. The GIN index narrows candidates; scoring uses the
   * stored per-lexeme term frequencies (tsvector positions) and document frequencies (term_stats).
   */
  async lexical(query: string, k: number): Promise<Scored[]> {
    const q = buildTsQueries(query);
    const { rows } = await this.pool.query(
      `${CHUNK_COLUMNS_CTE}, ${BM25_CTE}
       SELECT c.*, bm25.score FROM bm25 JOIN c USING (id) ORDER BY bm25.score DESC LIMIT $3`,
      [q.english, q.ids, k],
    );
    return rows.map(toScored);
  }

  /** Reciprocal rank fusion of dense and lexical rankings, computed in one SQL statement. */
  async hybrid(query: string, queryVec: Float32Array, k: number): Promise<Scored[]> {
    const q = buildTsQueries(query);
    const { rows } = await this.pool.query(
      `${CHUNK_COLUMNS_CTE},
       ${BM25_CTE},
       dense AS (
         SELECT id, row_number() OVER (ORDER BY embedding <=> $3) AS r
         FROM (SELECT id, embedding FROM chunks ORDER BY embedding <=> $3 LIMIT ${CANDIDATES}) d
       ),
       lex AS (
         SELECT id, row_number() OVER (ORDER BY score DESC) AS r FROM bm25 ORDER BY r LIMIT ${CANDIDATES}
       )
       SELECT c.*, COALESCE(1.0 / (${RRF_K} + dense.r), 0) + COALESCE(1.0 / (${RRF_K} + lex.r), 0) AS score
       FROM dense FULL OUTER JOIN lex USING (id) JOIN c USING (id)
       ORDER BY score DESC LIMIT $4`,
      [q.english, q.ids, pgvector.toSql(Array.from(queryVec)), k],
    );
    return rows.map(toScored);
  }

  async documents(): Promise<{ id: string; title: string; format: string; sourceUrl: string; stats: Record<string, number>; chunks: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT d.id, d.title, d.format, d.source_url, d.stats, count(c.id)::int AS chunks
       FROM documents d LEFT JOIN chunks c ON c.doc_id = d.id GROUP BY d.id ORDER BY d.id`,
    );
    return rows.map((r) => ({ id: r.id, title: r.title, format: r.format, sourceUrl: r.source_url, stats: r.stats, chunks: r.chunks }));
  }
}

// Empty query strings become an empty tsquery that matches nothing (rather than a syntax error).
const TSQUERY_SQL = `
  (CASE WHEN $1 = '' THEN ''::tsquery ELSE to_tsquery('english', $1) END) ||
  (CASE WHEN $2 = '' THEN ''::tsquery ELSE to_tsquery('simple', $2) END)`;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_CTE = `
  q AS (SELECT ${TSQUERY_SQL} AS tsq),
  q_terms AS (
    SELECT DISTINCT unnest(tsvector_to_array(
      (CASE WHEN $1 = '' THEN ''::tsvector ELSE to_tsvector('english', replace($1, ' | ', ' ')) END) ||
      (CASE WHEN $2 = '' THEN ''::tsvector ELSE to_tsvector('simple', replace($2, ' | ', ' ')) END)
    )) AS term
  ),
  corpus AS (SELECT count(*)::float AS n, avg(doc_len)::float AS avgdl FROM chunks),
  matches AS (
    SELECT ch.id, ch.doc_len, u.lexeme, coalesce(array_length(u.positions, 1), 1) AS tf
    FROM chunks ch, q, unnest(ch.tsv) u
    WHERE ch.tsv @@ q.tsq AND u.lexeme IN (SELECT term FROM q_terms)
  ),
  bm25 AS (
    SELECT m.id, sum(
      ln(1 + (corpus.n - ts.ndoc + 0.5) / (ts.ndoc + 0.5)) *
      (m.tf * (${BM25_K1} + 1)) / (m.tf + ${BM25_K1} * (1 - ${BM25_B} + ${BM25_B} * m.doc_len / corpus.avgdl))
    ) AS score
    FROM matches m JOIN term_stats ts ON ts.word = m.lexeme, corpus
    GROUP BY m.id
  )`;

const CHUNK_COLUMNS_CTE = `
  WITH c AS (
    SELECT ch.id, ch.doc_id, d.title AS doc_title, ch.section, ch.page_start, ch.page_end, ch.text
    FROM chunks ch JOIN documents d ON d.id = ch.doc_id
  )`;

function toScored(r: Record<string, any>): Scored {
  return {
    chunk: {
      id: r.id,
      docId: r.doc_id,
      docTitle: r.doc_title,
      section: r.section,
      pageStart: r.page_start ?? undefined,
      pageEnd: r.page_end ?? undefined,
      text: r.text,
    },
    score: Number(r.score ?? 0),
  };
}
