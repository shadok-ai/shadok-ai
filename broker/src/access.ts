// Who may open the broker's admin page: a person Cloudflare Access let in.
//
// Access sits in front of `connect.<domain>/admin*` and signs every request it
// forwards with a JWT in `Cf-Access-Jwt-Assertion`. The Worker verifies that
// JWT itself (signature against the team's published keys, audience, issuer,
// expiry) instead of trusting that Access is configured: a missing or
// misconfigured Access application must leave the page CLOSED, never open.
// Without ACCESS_TEAM_DOMAIN and ACCESS_AUD the admin routes do not exist.

import { b64uDecode } from "./core.js";

const dec = new TextDecoder();
const enc = new TextEncoder();

export interface AccessEnv {
  /** e.g. "myteam.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience tag. */
  ACCESS_AUD?: string;
  /** Optional allowlist (comma-separated emails), checked AFTER Access. */
  ADMIN_EMAILS?: string;
}

const TEAM_RE = /^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/;

export function accessConfigured(env: AccessEnv): boolean {
  return TEAM_RE.test((env.ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase()) && !!(env.ACCESS_AUD ?? "").trim();
}

interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
}

// The team's keys, kept for 10 minutes: Access rotates them every few weeks
// and publishes the next one in advance, so a short cache is enough.
let certCache: { team: string; at: number; keys: Jwk[] } | null = null;
const CERT_TTL_MS = 10 * 60_000;

async function teamKeys(team: string, now: number, force = false): Promise<Jwk[]> {
  if (!force && certCache && certCache.team === team && now - certCache.at < CERT_TTL_MS) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`certs HTTP ${r.status}`);
  const j = (await r.json()) as { keys?: unknown };
  const keys = Array.isArray(j.keys) ? (j.keys as Jwk[]).filter((k) => k && k.kty === "RSA") : [];
  certCache = { team, at: now, keys };
  return keys;
}

/** For tests: forget the cached keys. */
export function resetAccessCache(): void {
  certCache = null;
}

/** The verified person's email, or null. Never throws. */
export async function accessUser(req: Request, env: AccessEnv, now = Date.now()): Promise<string | null> {
  if (!accessConfigured(env)) return null;
  const team = env.ACCESS_TEAM_DOMAIN!.trim().toLowerCase();
  const aud = env.ACCESS_AUD!.trim();
  const token = req.headers.get("cf-access-jwt-assertion") ?? "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(dec.decode(b64uDecode(parts[0]))) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    let keys = await teamKeys(team, now);
    // A kid we do not know may be a freshly rotated key: refetch once.
    if (!keys.some((k) => k.kid === header.kid)) keys = await teamKeys(team, now, true);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const c = JSON.parse(dec.decode(b64uDecode(parts[1]))) as { aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; email?: unknown };
    const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!auds.includes(aud)) return null;
    if (c.iss !== `https://${team}`) return null;
    const secs = Math.floor(now / 1000);
    if (typeof c.exp !== "number" || c.exp <= secs) return null;
    if (typeof c.nbf === "number" && c.nbf > secs + 60) return null;
    if (typeof c.email !== "string" || !c.email) return null;
    const email = c.email.toLowerCase();
    const allow = (env.ADMIN_EMAILS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(email)) return null;
    return email;
  } catch {
    return null;
  }
}
