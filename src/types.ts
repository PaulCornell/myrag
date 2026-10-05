export type BlockType = "heading" | "paragraph" | "list_item" | "table";

/** A structural unit extracted from a source document, before chunking. */
export interface Block {
  type: BlockType;
  text: string;
  /** 1-indexed page number (PDF only; Word files have no stable pagination). */
  page?: number;
  /** Heading depth, 1 = top level. */
  level?: number;
}

export interface ParsedDoc {
  id: string;
  title: string;
  format: "pdf" | "docx";
  sourceUrl: string;
  blocks: Block[];
  /** Ingestion diagnostics — surfaced in the ingest report so messy inputs are visible, not silent. */
  stats: Record<string, number>;
}

export interface Chunk {
  id: string;
  docId: string;
  docTitle: string;
  /** Heading breadcrumb, e.g. ["5. AI RMF Core", "5.1 Govern"]. */
  section: string[];
  pageStart?: number;
  pageEnd?: number;
  text: string;
}

export interface RetrievedChunk {
  chunk: Chunk;
  score: number;
  rank: number;
}
