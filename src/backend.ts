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

// ---------------------------------------------------------------------------
// The backend CHOSEN AT ONBOARDING (or later, from the version menu), stored
// per launch directory in config.json. When present it REPLACES shadok's own
// environment as the instance-wide source — wholesale, never merged: merging
// would carry a developer's `ANTHROPIC_API_KEY` from the shell to whatever
// third-party server was just configured, i.e. hand an Anthropic key to
// someone else's API.

/** What config.json stores for one launch directory. */
export interface ConfiguredBackend {
  baseUrl: string;
  model: string;
  /** Sent as a bearer token. Absent for a local server that checks none. */
  authToken?: string;
  /** For the gauge, e.g. 64000. */
  contextWindow?: number;
}

/** The ready-made choices the onboarding card offers. ONLY servers that speak
 *  the Anthropic Messages API: Claude Code speaks nothing else, so an
 *  OpenAI-only provider (Hugging Face Inference, Together, Groq) needs a
 *  translating proxy such as LiteLLM in front, and goes through "custom". The
 *  model names are starting points — the Test button is what proves them. */
export const BACKEND_PRESETS = [
  { id: "ollama", label: "Ollama (on this machine)", baseUrl: "http://localhost:11434", needsKey: false, model: "" },
  { id: "llamacpp", label: "llama.cpp server (on this machine)", baseUrl: "http://localhost:8080", needsKey: false, model: "" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic", needsKey: true, model: "deepseek-chat" },
  { id: "zai", label: "Z.ai (GLM)", baseUrl: "https://api.z.ai/api/anthropic", needsKey: true, model: "glm-4.6" },
  { id: "moonshot", label: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.ai/anthropic", needsKey: true, model: "kimi-k2-0905-preview" },
  { id: "custom", label: "Another Anthropic-compatible server", baseUrl: "", needsKey: false, model: "" },
] as const;

/** The env a configured backend hands an agent (before alias mapping). */
export function configuredBackendEnv(b: ConfiguredBackend): Record<string, string> {
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: b.baseUrl, ANTHROPIC_MODEL: b.model };
  // Claude Code wants SOME credential to skip its own sign-in; a local server
  // ignores it. A placeholder is safer than leaving the field empty.
  env.ANTHROPIC_AUTH_TOKEN = b.authToken || "none";
  if (b.contextWindow) env.SHADOK_CONTEXT_WINDOW = String(b.contextWindow);
  return env;
}

/** The instance-wide source: the configured backend if any, else shadok's env. */
export function instanceEnv(
  processEnv: Record<string, string | undefined>,
  configured: ConfiguredBackend | null | undefined,
): Record<string, string | undefined> {
  return configured ? configuredBackendEnv(configured) : processEnv;
}

export type SaveVerdict = { ok: true; value: ConfiguredBackend } | { ok: false; error: string };

/** Validate a PUT /backend body. `savedToken` is kept when the body leaves the
 *  key empty for the SAME server — the field shows no secret, so an empty box
 *  means "unchanged", never "remove it". */
export function backendSaveVerdict(body: unknown, saved?: ConfiguredBackend | null): SaveVerdict {
  const b = (body ?? {}) as Record<string, unknown>;
  const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl.trim().replace(/\/+$/, "") : "";
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!isCustomBaseUrl(baseUrl))
    return { ok: false, error: "the server address must be an http(s) URL, and not Anthropic's (that is the subscription)" };
  if (!model) return { ok: false, error: "name the model to run" };
  const out: ConfiguredBackend = { baseUrl, model };
  const token = typeof b.authToken === "string" ? b.authToken.trim() : "";
  if (token) out.authToken = token;
  else if (saved?.authToken && saved.baseUrl === baseUrl) out.authToken = saved.authToken;
  const rawWindow = b.contextWindow;
  if (rawWindow !== undefined && rawWindow !== null && String(rawWindow).trim() !== "") {
    const w = parseContextWindow(String(rawWindow));
    if (!w) return { ok: false, error: "context window: a number of tokens such as 64000 or 64k" };
    out.contextWindow = w;
  }
  return { ok: true, value: out };
}

/** `base` + `path`, without doubling or dropping a slash. */
export function joinUrl(base: string, p: string): string {
  return base.replace(/\/+$/, "") + "/" + p.replace(/^\/+/, "");
}

/** Model names out of an Ollama `/api/tags` or an OpenAI-style `/v1/models`
 *  answer; anything else is an empty list, never a throw. */
export function parseModelList(json: unknown): string[] {
  const j = (json ?? {}) as { models?: unknown; data?: unknown };
  const rows = Array.isArray(j.models) ? j.models : Array.isArray(j.data) ? j.data : [];
  const names = rows
    .map((r) => (r && typeof r === "object" ? ((r as { name?: unknown; id?: unknown }).name ?? (r as { id?: unknown }).id) : null))
    .filter((n): n is string => typeof n === "string" && n.trim() !== "");
  return [...new Set(names)].sort();
}

/** The smallest request that proves the whole chain: URL, key, model, and the
 *  Anthropic format itself. */
export function testRequestBody(model: string): Record<string, unknown> {
  return { model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ok" }] };
}

/** A test that failed, in words that say what to change. */
export function testFailure(status: number, bodyText: string): string {
  let detail = "";
  try {
    const j = JSON.parse(bodyText);
    detail = String(j?.error?.message ?? j?.error ?? j?.message ?? "").trim();
  } catch {
    detail = bodyText.trim().slice(0, 200);
  }
  if (status === 401 || status === 403) return "the server refused the API key" + (detail ? ` (${detail})` : "");
  if (status === 404 && !/model/i.test(detail))
    return "no Anthropic API at this address (/v1/messages not found) — an OpenAI-only server needs a proxy such as LiteLLM in front";
  if (/model/i.test(detail)) return `the server does not know this model: ${detail}`;
  return `the server answered ${status}` + (detail ? `: ${detail}` : "");
}

/** Did a /v1/messages answer look like an Anthropic message? */
export function looksLikeMessage(json: unknown): boolean {
  const j = json as { type?: unknown; content?: unknown };
  return !!j && j.type === "message" && Array.isArray(j.content);
}
