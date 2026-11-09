// Per-agent token + (notional) cost over rolling time windows, for the menu's
// "stats" view. Pure: the server does the IO (scanning a transcript, reading the
// live `usage` map) and hands the samples here.
//
// IMPORTANT about "cost": shadok runs on the user's Claude SUBSCRIPTION, not the
// API, so no money is billed per token. The figure here is NOTIONAL — what the
// same tokens would cost at Anthropic API list prices — a proxy for an agent's
// intensity, not an invoice. The UI must say so.

import type { TokenUsage } from "./tail.js";

/** One assistant message's final usage, with when it was written and by which
 *  model — the three facts a windowed/priced sum needs. */
export interface MsgSample {
  at: number; // epoch ms (the transcript line's timestamp, or arrival time live)
  model: string; // the RESOLVED model name, e.g. "claude-opus-5"
  usage: TokenUsage;
}

/** API list price per 1M tokens, in USD. `cacheRead`/`cacheWrite` are the
 *  cached-input rates (read ≈ 0.1× input, write ≈ 1.25× input, except where
 *  Anthropic lists a specific rate). NOTIONAL — see the file header — and a
 *  table to keep current, not a billing source of truth. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Source: the claude-api skill's model table (cached 2026-11-03) for input/output;
// cache rates from Anthropic's standard multipliers unless the table lists one.
// Unknown models fall through to a null cost (tokens still counted) — never a
// guessed price, which would read as fact.
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};

/** The notional USD cost of one message's usage, or `null` when the model's
 *  price is unknown (a synthetic/injected message, or a model not in the table).
 *  A `null` must not be summed as 0 — the caller marks the total as partial. */
export function messageCostUSD(model: string, u: TokenUsage): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheCreation * p.cacheWrite +
      u.cacheRead * p.cacheRead) /
    1_000_000
  );
}

/** A window's totals: the four token classes, their sum, and the notional cost.
 *  `costPartial` is true when at least one message in the window had an unknown
 *  price (so `costUSD` is a floor, not the whole). */
export interface WindowStat {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  tokens: number;
  costUSD: number;
  costPartial: boolean;
}

export interface TokenStats {
  h1: WindowStat;
  h24: WindowStat;
  d7: WindowStat;
  d30: WindowStat;
}

const WINDOWS_MS = {
  h1: 60 * 60 * 1000,
  h24: 24 * 60 * 60 * 1000,
  d7: 7 * 24 * 60 * 60 * 1000,
  d30: 30 * 24 * 60 * 60 * 1000,
} as const;

function emptyWindow(): WindowStat {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, tokens: 0, costUSD: 0, costPartial: false };
}

function addSample(w: WindowStat, s: MsgSample): void {
  w.input += s.usage.input;
  w.output += s.usage.output;
  w.cacheCreation += s.usage.cacheCreation;
  w.cacheRead += s.usage.cacheRead;
  w.tokens += s.usage.input + s.usage.output + s.usage.cacheCreation + s.usage.cacheRead;
  const c = messageCostUSD(s.model, s.usage);
  if (c === null) w.costPartial = true;
  else w.costUSD += c;
}

/**
 * Sum samples into the four nested rolling windows (1h ⊂ 24h ⊂ 7d ⊂ 30d), each
 * measured back from `now`. One pass: a message in the last hour counts in all
 * four. Samples are the CURRENT session's messages —
 * the server keeps one per message id, so streaming partials are already
 * collapsed to each message's final usage.
 */
export function windowStats(samples: Iterable<MsgSample>, now: number): TokenStats {
  const out: TokenStats = { h1: emptyWindow(), h24: emptyWindow(), d7: emptyWindow(), d30: emptyWindow() };
  for (const s of samples) {
    const age = now - s.at;
    if (age < 0 || age > WINDOWS_MS.d30) continue; // future (clock skew) or older than the widest window
    addSample(out.d30, s);
    if (age <= WINDOWS_MS.d7) addSample(out.d7, s);
    if (age <= WINDOWS_MS.h24) addSample(out.h24, s);
    if (age <= WINDOWS_MS.h1) addSample(out.h1, s);
  }
  return out;
}
