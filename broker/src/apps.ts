// The OAuth apps the broker serves, configurable at run time.
//
// Before this, an app was a pair of Worker secrets (and Google had one
// hard-wired "alternative" app for a list of hosts). An operator now sets, per
// provider, ONE default app and any number of per-host overrides from the admin
// page (admin.ts), stored in a KV namespace. The Worker secrets still work and
// are the fallback, so a deploy without KV behaves exactly as before.
//
// Resolution for an instance on host H, most specific first:
//   1. the KV override for H
//   2. the Worker-secret alternative app, when H is listed (Google, legacy)
//   3. the KV default
//   4. the Worker-secret default
//
// A client secret is stored ENCRYPTED (AES-256-GCM under `CONFIG_KEY`, a Worker
// secret), never in clear in KV, and the admin page never shows it back. The
// AAD binds the ciphertext to its provider, host and client id, so a secret
// cannot be moved to another entry by editing KV.

import { b64uDecode, b64uEncode, isProviderId, type ProviderId } from "./core.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

/** The KV key holding the whole configuration (one small JSON document). */
export const APPS_KEY = "apps:v1";

/** One app as stored: the secret is the ciphertext, never the value. */
export interface StoredApp {
  clientId: string;
  secret: string;
  /** Google: the app is in Testing (refresh tokens last 7 days). */
  testing?: boolean;
  /** GitHub: the app's slug, for the installation page (github.com/apps/<slug>). */
  slug?: string;
  updatedAt: number;
  updatedBy: string;
}

export interface ProviderApps {
  default?: StoredApp;
  hosts?: Record<string, StoredApp>;
}

export type AppsConfig = Partial<Record<ProviderId, ProviderApps>>;

/** An app ready to use: the secret in clear, only ever held in memory. */
export interface OAuthApp {
  id: string;
  secret: string;
  testing?: boolean;
  slug?: string;
}

// Hostnames as an instance's return URL carries them: lowercase labels, no port.
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
// Client ids are printable ASCII (Google: "...apps.googleusercontent.com",
// GitHub: "Iv23li…", LinkedIn: alphanumeric). Bounded so KV stays small.
const CLIENT_ID_RE = /^[\x21-\x7e]{1,256}$/;
const SECRET_RE = /^[\x21-\x7e]{1,512}$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export const normalizeHost = (h: string): string | null => {
  const v = h.trim().toLowerCase();
  return HOST_RE.test(v) ? v : null;
};

/** What the admin form sends, checked. `host` "" is the default app. */
export interface AppInput {
  provider: ProviderId;
  host: string;
  clientId: string;
  /** Empty = keep the stored secret (only allowed when the client id is unchanged). */
  secret: string;
  testing: boolean;
  slug: string;
}

export function appInputVerdict(raw: Record<string, string | undefined>): { ok: true; input: AppInput } | { ok: false; reason: string } {
  const provider = raw.provider ?? "";
  if (!isProviderId(provider)) return { ok: false, reason: "unknown provider" };
  const hostRaw = (raw.host ?? "").trim();
  const host = hostRaw === "" ? "" : normalizeHost(hostRaw);
  if (host === null) return { ok: false, reason: "the domain must be a plain hostname, like demo.example.com" };
  const clientId = (raw.clientId ?? "").trim();
  if (!CLIENT_ID_RE.test(clientId)) return { ok: false, reason: "the client id is missing or malformed" };
  const secret = (raw.secret ?? "").trim();
  if (secret && !SECRET_RE.test(secret)) return { ok: false, reason: "the client secret is malformed" };
  const slug = (raw.slug ?? "").trim();
  if (slug && (provider !== "github" || !SLUG_RE.test(slug))) return { ok: false, reason: "the app slug is GitHub only, lowercase letters, digits and dashes" };
  const testing = provider === "google" && (raw.testing === "on" || raw.testing === "1");
  return { ok: true, input: { provider, host, clientId, secret, testing, slug } };
}

/** A KV document of unknown shape → only the entries that make sense. */
export function parseConfig(raw: unknown): AppsConfig {
  const out: AppsConfig = {};
  if (!raw || typeof raw !== "object") return out;
  const okApp = (a: unknown): a is StoredApp =>
    !!a && typeof a === "object" && typeof (a as StoredApp).clientId === "string" && typeof (a as StoredApp).secret === "string";
  for (const [p, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isProviderId(p) || !v || typeof v !== "object") continue;
    const pa: ProviderApps = {};
    const d = (v as ProviderApps).default;
    if (okApp(d)) pa.default = d;
    const hosts = (v as ProviderApps).hosts;
    if (hosts && typeof hosts === "object") {
      for (const [h, a] of Object.entries(hosts)) if (normalizeHost(h) === h && okApp(a)) (pa.hosts ??= {})[h] = a;
    }
    out[p] = pa;
  }
  return out;
}

async function aesKey(keyB64u: string): Promise<CryptoKey> {
  const raw = b64uDecode(keyB64u);
  if (raw.length !== 32) throw new Error("CONFIG_KEY must be 32 bytes, base64url");
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const aadFor = (provider: ProviderId, host: string, clientId: string) => enc.encode(`shadok-broker-app-v1|${provider}|${host || "*"}|${clientId}`);

export async function sealSecret(key: string, provider: ProviderId, host: string, clientId: string, secret: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadFor(provider, host, clientId) }, await aesKey(key), enc.encode(secret));
  return `${b64uEncode(iv)}.${b64uEncode(new Uint8Array(ct))}`;
}

/** null when it does not decrypt (wrong key, moved entry, tampered). */
export async function openSecret(key: string, provider: ProviderId, host: string, clientId: string, sealed: string): Promise<string | null> {
  try {
    const [iv, ct] = sealed.split(".");
    if (!iv || !ct) return null;
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64uDecode(iv), additionalData: aadFor(provider, host, clientId) }, await aesKey(key), b64uDecode(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** The legacy, Worker-secret apps of one provider (passed in by worker.ts). */
export interface EnvApps {
  default: OAuthApp | null;
  alt: (OAuthApp & { hosts: string[] }) | null;
}

/** Which entry serves this host: a pure decision, the secret opened by the caller. */
export type AppPick =
  | { from: "kv"; host: string; app: StoredApp }
  | { from: "env"; app: OAuthApp }
  | null;

export function pickApp(cfg: ProviderApps | undefined, envApps: EnvApps, host: string): AppPick {
  const h = host.toLowerCase();
  const override = cfg?.hosts?.[h];
  if (override) return { from: "kv", host: h, app: override };
  if (envApps.alt && envApps.alt.hosts.includes(h)) return { from: "env", app: envApps.alt };
  if (cfg?.default) return { from: "kv", host: "", app: cfg.default };
  return envApps.default ? { from: "env", app: envApps.default } : null;
}

/** Every app a refresh token may belong to, default first, each client id once. */
export function allPicks(cfg: ProviderApps | undefined, envApps: EnvApps): Exclude<AppPick, null>[] {
  const out: Exclude<AppPick, null>[] = [];
  const seen = new Set<string>();
  const add = (p: Exclude<AppPick, null>) => {
    const id = p.from === "kv" ? p.app.clientId : p.app.id;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(p);
  };
  if (cfg?.default) add({ from: "kv", host: "", app: cfg.default });
  if (envApps.default) add({ from: "env", app: envApps.default });
  for (const [h, a] of Object.entries(cfg?.hosts ?? {})) add({ from: "kv", host: h, app: a });
  if (envApps.alt) add({ from: "env", app: envApps.alt });
  return out;
}

/** A pick → a usable app, or null when a KV secret cannot be opened. */
export async function openPick(p: Exclude<AppPick, null>, provider: ProviderId, key: string | undefined): Promise<OAuthApp | null> {
  if (p.from === "env") return p.app;
  if (!key) return null;
  const secret = await openSecret(key, provider, p.host, p.app.clientId, p.app.secret);
  return secret === null ? null : { id: p.app.clientId, secret, ...(p.app.testing ? { testing: true } : {}), ...(p.app.slug ? { slug: p.app.slug } : {}) };
}

/**
 * Apply one admin save to the config (pure; the caller stores the result).
 * An empty secret keeps the stored one, but only for the SAME client id: a new
 * client id with the old secret would be a pair that never existed.
 */
export async function applySave(cfg: AppsConfig, input: AppInput, key: string, by: string, now: number): Promise<{ ok: true; cfg: AppsConfig } | { ok: false; reason: string }> {
  const pa: ProviderApps = { ...(cfg[input.provider] ?? {}), hosts: { ...(cfg[input.provider]?.hosts ?? {}) } };
  const prev = input.host ? pa.hosts![input.host] : pa.default;
  let sealed: string;
  if (input.secret) sealed = await sealSecret(key, input.provider, input.host, input.clientId, input.secret);
  else if (prev && prev.clientId === input.clientId) sealed = prev.secret;
  else return { ok: false, reason: "enter the client secret (it is required for a new app or a new client id)" };
  const app: StoredApp = {
    clientId: input.clientId,
    secret: sealed,
    ...(input.testing ? { testing: true } : {}),
    ...(input.slug ? { slug: input.slug } : {}),
    updatedAt: now,
    updatedBy: by,
  };
  if (input.host) pa.hosts![input.host] = app;
  else pa.default = app;
  if (!Object.keys(pa.hosts!).length) delete pa.hosts;
  return { ok: true, cfg: { ...cfg, [input.provider]: pa } };
}

export function applyDelete(cfg: AppsConfig, provider: ProviderId, host: string): AppsConfig {
  const pa: ProviderApps = { ...(cfg[provider] ?? {}), hosts: { ...(cfg[provider]?.hosts ?? {}) } };
  if (host) delete pa.hosts![host];
  else delete pa.default;
  if (!Object.keys(pa.hosts!).length) delete pa.hosts;
  return { ...cfg, [provider]: pa };
}

/** The KV namespace, as much of it as the broker uses. */
export interface ConfigKV {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

export async function loadConfig(kv: ConfigKV | undefined): Promise<AppsConfig> {
  if (!kv) return {};
  try {
    return parseConfig(await kv.get(APPS_KEY, "json"));
  } catch {
    // KV unreachable: fall back to the Worker secrets rather than offering nothing.
    return {};
  }
}
