/**
 * Which model backend an agent talks to: the Claude subscription, or a CUSTOM
 * one — a self-hosted open model (Ollama, llama.cpp, vLLM) or a gateway
 * (LiteLLM) that speaks the Anthropic Messages API.
 *
 * shadok never calls a model itself; it drives the `claude` TUI. So "plugging
 * in another model" is Claude Code's own mechanism — `ANTHROPIC_BASE_URL` plus
 * a token and a model name — and all shadok has to do is (a) carry those
 * variables to the agent and (b) stop treating that agent as a subscription
 * agent: no sign-in required, no quota guard, a context window that is not
 * Claude's.
 *
 * Two sources, the same order as everything else an agent gets: the
 * environment shadok was launched with (a whole instance on a local model),
 * then the profile's vault secrets (one role on a local model, the rest on the
 * subscription). Secrets win, like they do for every other variable.
 *
 * Pure: takes plain records, so the rules are tested without a process.
 */

/** The variables that select and configure a backend. Only these are carried
 *  over from shadok's own environment — never the whole env. */
export const BACKEND_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "SHADOK_CONTEXT_WINDOW",
] as const;

/** The aliases a model picker or Claude Code itself may resolve. Each needs a
 *  local name, or the request reaches the custom server as `claude-opus-…`, a
 *  model it has never heard of. */
const ALIAS_VARS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  // Claude Code's background calls (titles, summaries) use the small model.
  // Left unmapped, every one of them fails against a server that only has one.
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

export type Backend =
  | { kind: "subscription" }
  | { kind: "custom"; baseUrl: string; model: string | null; contextWindow: number | null };

/**
 * Is `ANTHROPIC_BASE_URL` pointing somewhere that is NOT Anthropic?
 *
 * Anthropic's own host is excluded so that a user who happens to export the
 * default URL is not silently taken off the sign-in and quota guards. A URL
 * that does not parse is NOT treated as custom: guessing "custom" would drop
 * the sign-in check for an agent that will then fail to reach anything.
 */
export function isCustomBaseUrl(raw: string | undefined): boolean {
  const v = raw?.trim();
  if (!v) return false;
  let host: string;
  try {
    const u = new URL(v);
    // `localhost:11434` parses too — with `localhost:` as its SCHEME. Only an
    // http(s) URL is a server Claude Code can reach.
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return host !== "anthropic.com" && !host.endsWith(".anthropic.com");
}

/** A positive integer window, or null. Accepts `64000`, `64k`, `1m`. */
export function parseContextWindow(raw: string | undefined): number | null {
  const m = raw?.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  return Number.isFinite(n) && n >= 1_000 ? Math.round(n) : null;
}

/** Which backend an agent with this environment talks to. */
export function backendFor(env: Record<string, string | undefined>): Backend {
  if (!isCustomBaseUrl(env.ANTHROPIC_BASE_URL)) return { kind: "subscription" };
  return {
    kind: "custom",
    baseUrl: env.ANTHROPIC_BASE_URL!.trim(),
    model: env.ANTHROPIC_MODEL?.trim() || null,
    contextWindow: parseContextWindow(env.SHADOK_CONTEXT_WINDOW),
  };
}

/**
 * The backend variables to hand an agent, from shadok's own environment and
 * the profile's secrets.
 *
 * Shadok's environment contributes ONLY when it points at a custom backend.
 * A developer's shell commonly carries an `ANTHROPIC_API_KEY` for other work;
 * forwarding it to a subscription instance would quietly move every agent onto
 * API billing. (A node-pty agent inherits the whole env anyway — that was
 * already true and is not widened here; a tmux pane does NOT reliably inherit
 * it, since tmux hands a new session its server's environment, which is why
 * the variables are passed explicitly.)
 *
 * On a custom backend with a model named, every alias that is not mapped is
 * mapped to it, so `opus` in the picker and Claude Code's background
 * small-model calls land on the one model the server serves.
 */
export function backendEnv(
  processEnv: Record<string, string | undefined>,
  secretEnv: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (isCustomBaseUrl(processEnv.ANTHROPIC_BASE_URL)) {
    for (const k of BACKEND_VARS) {
      const v = processEnv[k];
      if (v !== undefined && v !== "") out[k] = v;
    }
  }
  for (const k of BACKEND_VARS) if (k in secretEnv) out[k] = secretEnv[k];
  const b = backendFor(out);
  if (b.kind === "custom" && b.model) {
    for (const k of ALIAS_VARS) if (!out[k]) out[k] = b.model;
  }
  return out;
}
