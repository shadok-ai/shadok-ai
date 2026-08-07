/**
 * How full the model's context window is, computed from the TRANSCRIPT.
 *
 * This used to be scraped off the TUI footer: `screen.match(/ctx:\s*(\d+)\s*%/)`.
 * That string is not produced by Claude Code — it comes from a **custom
 * statusLine** the user happens to have configured, so the gauge worked on the
 * author's machine and on nothing else. A fresh install, and every container,
 * simply never showed a bar. Reading the transcript instead puts the figure back
 * where the rest of the content already comes from (see "Core model": content is
 * the .jsonl, only control is the screen).
 *
 * Everything here is pure, so the arithmetic is testable without a session.
 */
import type { TokenUsage } from "./tail.js";

/** The standard window. Assumed when nothing says otherwise. */
export const DEFAULT_WINDOW = 200_000;
/** The long-context window, selected per SESSION (the `[1m]` model suffix). */
export const LONG_WINDOW = 1_000_000;

/**
 * How many tokens of the window one assistant message occupied.
 *
 * Cache reads and cache writes count: they are context the model was given, and
 * the cache is an billing/latency optimisation, not a smaller prompt. Output is
 * excluded — it is not part of the window the NEXT request starts from.
 * Verified against a real session: 1 + 4 672 + 404 568 = 409 241 tokens, which
 * the CLI's own statusline reported as 41% of 1M. The formula matches to the
 * rounding.
 */
export function contextTokens(u: TokenUsage): number {
  return (u.input ?? 0) + (u.cacheCreation ?? 0) + (u.cacheRead ?? 0);
}

/**
 * The window a model SETTING asks for.
 *
 * The 1M window is NOT a property of the model: it is a per-session setting,
 * written as a suffix on the model name (`"opus[1m]"` in
 * `~/.claude/settings.json`, or on a shadok profile). The transcript records the
 * RESOLVED model (`claude-opus-4-8`) with the suffix already stripped, which is
 * why the window cannot be recovered from the transcript alone, and why matching
 * on model NAMES would be wrong — the same model runs at either size.
 */
export function windowForModel(model: string | null | undefined): number {
  return /\[1m\]/i.test((model ?? "").trim()) ? LONG_WINDOW : DEFAULT_WINDOW;
}

/**
 * The window we ASSUME, corrected by what we have actually observed.
 *
 * A session can exceed the assumed window only if the assumption is wrong: you
 * cannot fit 409k tokens in a 200k window. So an over-run is a PROOF, not a
 * guess, and we promote to the next standard size instead of rendering a
 * nonsensical 205%. This is what rescues the case where nothing is configured at
 * all — a container whose `settings.json` carries no model — without inventing a
 * heuristic on model names.
 */
export function effectiveWindow(assumed: number, observedTokens: number): number {
  if (observedTokens <= assumed) return assumed;
  return observedTokens <= LONG_WINDOW ? LONG_WINDOW : observedTokens;
}

/**
 * Percentage of the window used, rounded, never negative.
 *
 * Not clamped at 100 on purpose: `effectiveWindow` has already promoted the
 * window when an over-run proved it too small, so anything still above 100 means
 * the transcript exceeds even the largest known size — worth showing rather than
 * flattening to a reassuring "100%".
 */
export function contextPct(tokens: number, window: number): number {
  if (!(window > 0)) return 0;
  return Math.max(0, Math.round((tokens / window) * 100));
}

/**
 * The whole computation, from the last assistant message's usage to a percent.
 * `assumedWindow` comes from the session's model setting (`windowForModel`).
 */
export function pctFromUsage(u: TokenUsage | undefined, assumedWindow: number): number | null {
  if (!u) return null;
  const tokens = contextTokens(u);
  return contextPct(tokens, effectiveWindow(assumedWindow, tokens));
}
