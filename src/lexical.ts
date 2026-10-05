// Query/document preparation for Postgres full-text search.
//
// Postgres's default parser mangles control and section identifiers: "GV.SC-05" becomes the host
// "GV.SC" plus the integer "-05", so a search for the ID can't match it exactly. Identifiers are
// therefore extracted here and indexed as a second, unstemmed ('simple') lexeme set: "GV.SC-05" ->
// "gvsc05" plus its prefix "gvsc"; "AC-5" -> "ac5".

const IDENTIFIER_RE = /\b[A-Za-z]{1,4}(?:[.-][A-Za-z0-9]{1,4}){1,4}\b/g;

/** Compact forms of identifier-like tokens, e.g. "GV.SC-05" -> ["gvsc05", "gvsc"]. */
export function identifierTerms(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENTIFIER_RE)) {
    const raw = m[0];
    if (!/\d/.test(raw) && !/[A-Z]{2,}\.[A-Z]{2,}/.test(raw)) continue; // skip "risk-based", "e.g"
    const parts = raw.toLowerCase().split(/[.-]/);
    out.add(parts.join(""));
    if (parts.length > 2) out.add(parts.slice(0, -1).join(""));
  }
  return [...out];
}

/** Plain words of a query, for an OR'd English tsquery (Postgres applies stemming and stopwords). */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length > 1);
}

/**
 * Builds OR'd tsquery strings. Natural-language questions shouldn't require every word to
 * match (websearch_to_tsquery's AND semantics would return nothing for most questions); ranking
 * does the work of preferring chunks that match more terms.
 */
export function buildTsQueries(query: string): { english: string; ids: string } {
  return { english: queryWords(query).join(" | "), ids: identifierTerms(query).join(" | ") };
}
