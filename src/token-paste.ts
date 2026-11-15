/**
 * A long-lived subscription token PASTED into the cockpit ("I already have a
 * token" on the Connect Claude card) — minted elsewhere with `claude setup-token`.
 *
 * Pure: trims what a copy-paste drags along, and accepts only the shape
 * `setup-token` prints (`sk-ant-oat01-…`, the same pattern `src/setup-token.ts`
 * captures). An API key (`sk-ant-api03-…`) is refused: it is billed per call,
 * which is exactly what the subscription path exists to avoid. The error never
 * repeats the input — it may be a real credential pasted in the wrong place.
 */
const TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

export function normalizePastedToken(raw: unknown): { ok: true; token: string } | { ok: false; error: string } {
  // ALL whitespace, not just the ends: a terminal wraps a ~110-char token, and
  // copying it back drags a newline into the middle. The shape has none.
  const token = typeof raw === "string" ? raw.replace(/\s+/g, "") : "";
  if (!token) return { ok: false, error: "paste the token first" };
  if (TOKEN_RE.test(token)) return { ok: true, token };
  return {
    ok: false,
    error: "that doesn't look like a long-lived Claude token (it starts with sk-ant-oat01-, from claude setup-token)",
  };
}
