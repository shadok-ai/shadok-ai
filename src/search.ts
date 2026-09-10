/**
 * The cockpit's search engine, pure half: turn a query + a session's turns into
 * ranked snippets. No filesystem here — `server.ts` reads the transcripts
 * (`readHistoryTurns`) and the client renders the hits; this module is what a
 * node test can exercise directly, like live-text.js / notify.js on the front.
 *
 * Match is a plain case-insensitive SUBSTRING. Deliberately simple: it is what a
 * reader means by "find where I talked about X", it never surprises with regex
 * metacharacters, and the corpus (plain transcript text) is small enough that a
 * scan per query is fine. A smarter index can come later behind the same shape.
 */

export interface Snippet {
  /** Text just before the match (prefixed "…" when the message was longer). */
  before: string;
  /** The matched text, in the message's own casing — for the client to mark. */
  match: string;
  /** Text just after the match (suffixed "…" when the message was longer). */
  after: string;
}

export interface SearchHit {
  role: "user" | "assistant";
  at?: number;
  snippet: Snippet;
}

/** Trim and collapse whitespace; matching is case-insensitive on top of this. */
export function normalizeQuery(q: string): string {
  return (q ?? "").replace(/\s+/g, " ").trim();
}

/** Below this the query is treated as empty — a single letter matches half the
 *  corpus and is never what a search means. */
export const MIN_QUERY = 2;

/**
 * A one-line context window around the FIRST occurrence of `query` in `text`, or
 * null when it isn't there. The whole message is flattened to one line first, so
 * the returned offsets are consistent and the snippet reads cleanly; `before` /
 * `after` are cut to `radius` characters with an ellipsis when the message runs
 * past them.
 */
export function makeSnippet(text: string, query: string, radius = 64): Snippet | null {
  const q = query.toLowerCase();
  if (!q) return null;
  const flat = (text ?? "").replace(/\s+/g, " ");
  const i = flat.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const end = i + q.length;
  const start = Math.max(0, i - radius);
  const stop = Math.min(flat.length, end + radius);
  return {
    before: (start > 0 ? "…" : "") + flat.slice(start, i),
    match: flat.slice(i, end),
    after: flat.slice(end, stop) + (stop < flat.length ? "…" : ""),
  };
}

/**
 * Search one session's turns, NEWEST hit first, at most `maxPerAgent` — so a
 * single chatty agent can't crowd out every other in the result list. Returns
 * [] for a query under `MIN_QUERY`.
 */
export function searchTurns(
  turns: { role: "user" | "assistant"; text: string; at?: number }[],
  query: string,
  maxPerAgent = 5,
): SearchHit[] {
  const q = normalizeQuery(query);
  if (q.length < MIN_QUERY) return [];
  const hits: SearchHit[] = [];
  for (let k = turns.length - 1; k >= 0 && hits.length < maxPerAgent; k--) {
    const snippet = makeSnippet(turns[k].text, q);
    if (snippet) hits.push({ role: turns[k].role, at: turns[k].at, snippet });
  }
  return hits;
}
