// The connect broker: a stateless Worker that holds the OAuth client secret so
// the instances never do. It sends the browser to the provider, exchanges the
// code on the way back, and hands the token to the instance through the
// browser -- encrypted for a key only that instance holds (see core.ts).

import {
  encryptForInstance,
  GOOGLE_AREAS,
  googleScope,
  parseGoogleAreas,
  signState,
  validateReturnUrl,
  verifyState,
  type ConnectState,
  type ProviderId,
  type TokenPayload,
} from "./core.js";
import { handleAdmin, type AdminEnv, type ProviderView } from "./admin.js";
import { allPicks, loadConfig, openPick, pickApp, type AppsConfig, type EnvApps, type OAuthApp } from "./apps.js";

export interface Env extends AdminEnv {
  LINKEDIN_CLIENT_ID: string;
  LINKEDIN_CLIENT_SECRET: string;
  STATE_KEY: string;
  // Google is optional: without both secrets the broker does not offer it.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // "1" while the Google app is in Testing (refresh tokens last 7 days); the
  // instance reads it off /health to warn about weekly reconnects.
  GOOGLE_TESTING?: string;
  // A second Google OAuth app, served only to the hosts in GOOGLE_ALT_HOSTS
  // (comma-separated hostnames, e.g. "demo.shadok.ai"). Lets one app stay in
  // Testing for every instance while another goes through Google's
  // verification on a demo instance. Optional: without all three, one app.
  GOOGLE_ALT_CLIENT_ID?: string;
  GOOGLE_ALT_CLIENT_SECRET?: string;
  GOOGLE_ALT_HOSTS?: string;
  // GitHub is optional too: a GitHub App (not an OAuth App) — the person picks
  // the repositories it reaches, and user tokens expire (8 h, refresh 6 months).
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  // The app's slug (github.com/apps/<slug>): /health turns it into the link
  // where a person picks or changes the repositories the app may reach.
  GITHUB_APP_SLUG?: string;
  // The site served on the same hostname (landing page, waitlist), deployed
  // as its own Worker from another repo. Optional: without the binding the
  // broker answers 404 for every path it does not own, as before.
  SITE?: { fetch(req: Request): Promise<Response> };
}

interface Provider {
  id: ProviderId;
  /** Shown on the broker's pages. */
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** The scope for this attempt, from the signed state (Google's areas). */
  scope: (st: Pick<ConnectState, "areas">) => string;
  /** Extra authorize parameters (Google: offline access, a fresh refresh token). */
  extra?: Record<string, string>;
  /** Whether the instance may refresh through `POST /<id>/refresh`. */
  refresh?: boolean;
  /** The Worker-secret apps (the fallback under the admin page's, apps.ts). */
  envApps: (env: Env) => EnvApps;
  /** GitHub: `GET /<id>/setup` exists, the page GitHub's "Setup URL" lands on
   *  after a person picks repositories. */
  setup?: boolean;
}

/** A Worker-secret app, or null when either half is missing. */
const envApp = (id: string | undefined, secret: string | undefined, extra: Partial<OAuthApp> = {}): OAuthApp | null =>
  id && secret ? { id, secret, ...extra } : null;

// A second provider (or a second LinkedIn app) is one more entry here.
const PROVIDERS: Record<ProviderId, Provider> = {
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scope: () => "openid profile w_member_social",
    envApps: (e) => ({ default: envApp(e.LINKEDIN_CLIENT_ID, e.LINKEDIN_CLIENT_SECRET), alt: null }),
  },
  google: {
    id: "google",
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: (st) => googleScope(st.areas ?? []),
    // offline: a refresh token at all; consent: Google returns one only on the
    // FIRST grant otherwise, so a reconnect would come back without it;
    // include_granted_scopes: a reconnect that adds an area keeps the others.
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    refresh: true,
    envApps: (e) => {
      // GOOGLE_TESTING was one flag for the whole broker: it still covers both
      // Worker-secret apps. A per-app flag is set on the admin page.
      const testing = e.GOOGLE_TESTING === "1" ? { testing: true } : {};
      const hosts = (e.GOOGLE_ALT_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      const alt = envApp(e.GOOGLE_ALT_CLIENT_ID, e.GOOGLE_ALT_CLIENT_SECRET, testing);
      return { default: envApp(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET, testing), alt: alt && hosts.length ? { ...alt, hosts } : null };
    },
  },
  github: {
    id: "github",
    label: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    // A GitHub App takes no scopes: what the token reaches is the app's
    // permissions on the repositories the person installed it on.
    scope: () => "",
    refresh: true,
    setup: true,
    envApps: (e) => ({ default: envApp(e.GITHUB_CLIENT_ID, e.GITHUB_CLIENT_SECRET, e.GITHUB_APP_SLUG ? { slug: e.GITHUB_APP_SLUG.trim() } : {}), alt: null }),
  },
};

/** A provider is offered only once it has a DEFAULT app (admin page or Worker
 *  secrets): a deploy before the Google app is set up must not show a Connect
 *  button that leads nowhere. */
const available = (p: Provider, env: Env, cfg: AppsConfig) => !!cfg[p.id]?.default || !!p.envApps(env).default;

/** The app that serves this instance (apps.ts `pickApp`: its domain's app, else
 *  the default). The host comes from the validated return URL (start) or the
 *  signed state (callback), never from a header. Null when the stored secret
 *  cannot be opened (CONFIG_KEY missing or changed). */
async function appFor(p: Provider, env: Env, cfg: AppsConfig, host: string): Promise<OAuthApp | null> {
  const pick = pickApp(cfg[p.id], p.envApps(env), host);
  return pick ? openPick(pick, p.id, env.CONFIG_KEY) : null;
}

/** Every app a refresh token may belong to, the default first. */
async function appsOf(p: Provider, env: Env, cfg: AppsConfig): Promise<OAuthApp[]> {
  const out: OAuthApp[] = [];
  for (const pick of allPicks(cfg[p.id], p.envApps(env))) {
    const app = await openPick(pick, p.id, env.CONFIG_KEY);
    if (app) out.push(app);
  }
  return out;
}

const misconfigured = () => page(500, "Cannot connect", "<p>This connector is misconfigured. Tell its operator.</p>");

/** Google issues 7-day refresh tokens while an app is in Testing, without
 *  always saying so: the broker says it, per app, so the instance needs no
 *  broker-wide flag (`/health` → `deadlineStamped`). */
const TESTING_REFRESH_SECONDS = 7 * 24 * 3600;
const providerOf = (id: string): Provider | undefined => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id as ProviderId] : undefined);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem}a.b{display:inline-block;margin:.5rem 1rem .5rem 0;padding:.5rem 1rem;border-radius:6px;background:#0a66c2;color:#fff;text-decoration:none}a.c{color:#555}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

// The shapes the instance makes (src/connect-crypto.ts `newAttempt`): a 16-byte
// nonce and a raw P-256 public key (65 bytes), both base64url without padding.
// Anything else did not come from a cockpit and must not reach a signed state.
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const PUB_RE = /^[A-Za-z0-9_-]{87}$/;

// GitHub answers its token endpoint in form encoding unless asked for JSON;
// Google and LinkedIn answer JSON either way.
const TOKEN_HEADERS = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
// Provider error codes are short snake_case words; anything else is not echoed.
const ERROR_CODE_RE = /^[a-z_]{1,64}$/;
/** The codes that mean "this refresh token is dead, reconnect" — Google's
 *  `invalid_grant`, GitHub's `bad_refresh_token` — all reported to the
 *  instance as `invalid_grant`, so it needs no per-provider table. */
const REVOKED_CODES = new Set(["invalid_grant", "bad_refresh_token"]);
const errorCode = (j: Record<string, unknown>, fallback: string) => {
  const raw = typeof j.error === "string" && ERROR_CODE_RE.test(j.error) ? j.error : fallback;
  return REVOKED_CODES.has(raw) ? "invalid_grant" : raw;
};

const bad = (msg: string) => page(400, "Cannot connect", `<p>${esc(msg)}</p>`);
const link = (returnUrl: string, nonce: string, tail: string) => `${returnUrl}#n=${nonce}&${tail}`;

async function start(url: URL, env: Env, cfg: AppsConfig, p: Provider): Promise<Response> {
  const ret = url.searchParams.get("return") ?? "";
  const pub = url.searchParams.get("pub") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  const v = validateReturnUrl(ret, p.id);
  if (!v.ok) return bad(`Invalid return URL: ${v.reason}.`);
  if (!pub || !nonce) return bad("Missing pub or nonce.");
  if (!NONCE_RE.test(nonce) || !PUB_RE.test(pub)) return bad("Malformed pub or nonce.");
  let areas: ConnectState["areas"];
  if (p.id === "google") {
    const parsed = parseGoogleAreas(url.searchParams.get("areas") ?? "");
    if (!parsed) return bad(`Choose at least one Google area (${Object.keys(GOOGLE_AREAS).join(", ")}).`);
    areas = parsed;
  }
  const st: ConnectState = { v: 1, provider: p.id, returnUrl: v.url.toString(), pub, nonce, iat: Date.now(), ...(areas ? { areas } : {}) };
  const app = await appFor(p, env, cfg, v.url.hostname);
  if (!app) return misconfigured();
  const state = await signState(st, env.STATE_KEY);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: app.id,
    redirect_uri: `${url.origin}/${p.id}/callback`,
    ...(p.scope(st) ? { scope: p.scope(st) } : {}),
    ...(p.extra ?? {}),
    state,
  });
  return new Response(null, { status: 302, headers: { location: `${p.authorizeUrl}?${q}`, "cache-control": "no-store" } });
}

async function callback(url: URL, env: Env, cfg: AppsConfig, p: Provider): Promise<Response> {
  const st = await verifyState(url.searchParams.get("state") ?? "", env.STATE_KEY);
  // A state minted for one provider is never redeemed at another's callback.
  if (!st || st.provider !== p.id) return bad("This connection attempt is invalid or has expired. Start again from your cockpit.");
  // Defence in depth: the state is signed by us, but a redirect carrying a
  // token is the one place an open redirect would hurt, so check again.
  const v = validateReturnUrl(st.returnUrl, p.id);
  if (!v.ok || typeof st.pub !== "string" || !st.pub || typeof st.nonce !== "string" || !st.nonce) {
    return bad("This connection attempt is invalid. Start again from your cockpit.");
  }
  const returnUrl = v.url.toString();
  const host = v.url.host;
  const cancel = `<a class="c" href="${esc(link(returnUrl, st.nonce, "error=cancelled"))}">Cancel</a>`;

  const err = url.searchParams.get("error");
  if (err) {
    const code = encodeURIComponent(err);
    return page(200, `${p.label} connection not completed`, `<p>${p.label} did not complete the connection (${esc(err)}).</p><a class="b" href="${esc(link(returnUrl, st.nonce, `error=${code}`))}">Back to ${esc(host)}</a>`);
  }
  const code = url.searchParams.get("code");
  if (!code) return bad("Missing authorization code.");

  // The same app as at start: the code was issued to it.
  const app = await appFor(p, env, cfg, v.url.hostname);
  if (!app) return misconfigured();
  const failed = (sentence: string) =>
    page(200, "Connection failed", `<p>${esc(sentence)}</p><a class="b" href="${esc(link(returnUrl, st.nonce, "error=token_exchange_failed"))}">Back to ${esc(host)}</a>`);
  let res: Response;
  try {
    res = await fetch(p.tokenUrl, {
      method: "POST",
      headers: TOKEN_HEADERS,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${url.origin}/${p.id}/callback`,
        client_id: app.id,
        client_secret: app.secret,
      }),
    });
  } catch {
    // A network failure: without this the Worker throws, the person gets a bare
    // 1101 page and no way back, and the instance's attempt is never consumed.
    // The error's text is not shown — it is not ours to vouch for.
    return failed(`The connector could not reach ${p.label}. Try again in a moment.`);
  }
  if (!res.ok) {
    // Status only: the body could echo the code or the client secret.
    return failed(`${p.label} refused the connection (HTTP ${res.status}).`);
  }
  let token: TokenPayload;
  try {
    const j = (await res.json()) as TokenPayload & { error?: unknown };
    // GitHub refuses with HTTP 200 and an `error` field (a used or expired
    // code, a wrong secret): a refusal, said as one, the code sanitised.
    if (j.error !== undefined) return failed(`${p.label} refused the connection (${errorCode(j as unknown as Record<string, unknown>, "error")}).`);
    if (typeof j.access_token !== "string" || !j.access_token) throw new Error("no token");
    token = {
      access_token: j.access_token,
      expires_in: j.expires_in,
      scope: j.scope,
      ...(j.refresh_token ? { refresh_token: j.refresh_token, refresh_token_expires_in: j.refresh_token_expires_in } : {}),
    };
    if (token.refresh_token && app.testing && !(typeof token.refresh_token_expires_in === "number" && token.refresh_token_expires_in > 0))
      token.refresh_token_expires_in = TESTING_REFRESH_SECONDS;
  } catch {
    // HTTP 200 but no usable token: the provider did not refuse anything.
    return failed(`${p.label} returned an unexpected answer.`);
  }
  let c: string;
  try {
    c = await encryptForInstance(st.pub, st.nonce, token);
  } catch {
    return page(200, "Connection failed", `<p>The key sent by your cockpit was not usable.</p><a class="b" href="${esc(link(returnUrl, st.nonce, "error=encryption_failed"))}">Back to ${esc(host)}</a>`);
  }
  return page(
    200,
    `Connect ${p.label}`,
    `<p>You are connecting ${p.label} to the shadok cockpit at <strong>${esc(host)}</strong>. Only continue if that is your cockpit.</p><a class="b" href="${esc(link(returnUrl, st.nonce, `c=${c}`))}">Continue</a>${cancel}`,
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// A refresh token is opaque but bounded; anything larger is not one.
const MAX_REFRESH_TOKEN = 2048;

/**
 * `POST /<provider>/refresh` `{refresh_token}` → `{access_token, expires_in,
 * scope}`. Google access tokens last about an hour and refreshing needs the
 * client secret, which only the broker holds; the instance's SERVER calls this
 * (outbound, so it works behind NAT). Stateless: the refresh token is used and
 * forgotten, never logged, never echoed. `invalid_grant` (revoked, expired —
 * 7 days in Testing; GitHub's `bad_refresh_token`) is passed through so the
 * instance can say "reconnect". A rotated refresh token (GitHub) is returned.
 */
async function refresh(req: Request, env: Env, cfg: AppsConfig, p: Provider): Promise<Response> {
  let body: { refresh_token?: unknown };
  try {
    body = (await req.json()) as { refresh_token?: unknown };
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const rt = body?.refresh_token;
  if (typeof rt !== "string" || !rt || rt.length > MAX_REFRESH_TOKEN) return json(400, { error: "invalid_request" });
  // The instance does not say which app minted its token (it never knew), so
  // each app is tried in turn: a token from the other app is refused with an
  // error and the next one is asked. A token every app refuses as
  // `invalid_grant` is revoked or expired: the instance must reconnect.
  let last: Response = json(502, { error: "unreachable" });
  let revoked = false;
  for (const app of await appsOf(p, env, cfg)) {
    let res: Response;
    try {
      res = await fetch(p.tokenUrl, {
        method: "POST",
        headers: TOKEN_HEADERS,
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: app.id, client_secret: app.secret }),
      });
    } catch {
      last = json(502, { error: "unreachable" });
      continue;
    }
    let j: Record<string, unknown> = {};
    try {
      j = (await res.json()) as Record<string, unknown>;
    } catch {
      /* a non-JSON answer is handled below as an unexpected one */
    }
    // GitHub refuses with HTTP 200 and an `error` field, Google with a 400.
    if (!res.ok || j.error !== undefined) {
      const code = errorCode(j, "refresh_failed");
      if (code === "invalid_grant") revoked = true;
      // 400 for what the caller must act on (reconnect); 502 for the provider's trouble.
      last = json(code === "invalid_grant" ? 400 : 502, { error: code, status: res.ok ? 400 : res.status });
      continue;
    }
    if (typeof j.access_token !== "string" || !j.access_token) return json(502, { error: "unexpected_answer" });
    // GitHub ROTATES the refresh token: the one just used is dead, so the new
    // one must reach the instance or the next refresh fails. Google keeps it.
    const rotated = typeof j.refresh_token === "string" && j.refresh_token ? { refresh_token: j.refresh_token, refresh_token_expires_in: j.refresh_token_expires_in } : {};
    return json(200, { access_token: j.access_token, expires_in: j.expires_in, scope: j.scope, ...rotated });
  }
  return revoked ? json(400, { error: "invalid_grant", status: 400 }) : last;
}

/** GitHub's "Setup URL": where the browser lands after a person picks or
 *  changes the repositories. GitHub carries no state through that page, so it
 *  cannot send anyone back to a cockpit — and need not: a user token reaches
 *  newly-picked repositories at once, without reconnecting. */
function setupDone(p: Provider): Response {
  return page(200, "Repositories updated", `<p>${esc(p.label)} has saved your choice of repositories. You can close this tab and go back to your cockpit: your agents can use them right away.</p>`);
}

function health(env: Env, cfg: AppsConfig): Response {
  const providers = Object.values(PROVIDERS).filter((p) => available(p, env, cfg)).map((p) => p.id);
  const google = providers.includes("google");
  // The DEFAULT app's flags: the admin page's when it set one, else the Worker's.
  const gDefault = cfg.google?.default ?? null;
  const googleTesting = gDefault ? !!gDefault.testing : env.GOOGLE_TESTING === "1";
  const slug = (cfg.github?.default ? cfg.github.default.slug ?? "" : env.GITHUB_APP_SLUG ?? "").trim();
  const github = providers.includes("github") && /^[a-z0-9-]{1,64}$/.test(slug);
  // `googleAreas`: the areas THIS deploy accepts at /google/start. An instance
  // newer than the broker would otherwise offer an area the broker refuses.
  return Response.json({
    ok: true,
    providers,
    ...(googleTesting && google ? { testing: ["google"] } : {}),
    // The callback stamps each Testing app's 7-day deadline itself
    // (`refresh_token_expires_in`), so `testing` is only the default app's:
    // an instance must not stamp it again on a domain whose app is verified.
    ...(google ? { deadlineStamped: true } : {}),
    ...(google ? { googleAreas: Object.keys(GOOGLE_AREAS) } : {}),
    // Where a person picks (or changes) the repositories the GitHub App
    // reaches. Authorizing alone grants no repository: installing does.
    ...(github ? { githubInstallUrl: `https://github.com/apps/${slug}/installations/new` } : {}),
  });
}

/** What the admin page shows of the Worker-secret apps: client ids, never secrets. */
function providerViews(env: Env): ProviderView[] {
  return Object.values(PROVIDERS).map((p) => {
    const e = p.envApps(env);
    return { id: p.id, label: p.label, envDefault: e.default?.id ?? null, envAlt: e.alt ? { clientId: e.alt.id, hosts: e.alt.hosts } : null };
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const admin = await handleAdmin(req, url, env, providerViews(env));
    if (admin) return admin;
    const m = /^\/([a-z]+)\/(start|callback|refresh|setup)$/.exec(url.pathname);
    const p = m ? providerOf(m[1]) : undefined;
    // KV is read only for the broker's own routes, never for the site's pages.
    const cfg = m || url.pathname === "/health" ? await loadConfig(env.CONFIG) : {};
    const route = m && p && available(p, env, cfg) && (m[2] !== "refresh" || p.refresh) && (m[2] !== "setup" || p.setup) ? m[2] : undefined;
    const ours = url.pathname === "/health" || route !== undefined;
    // Every path the broker does not own goes to the site, whatever the method
    // (the waitlist is a POST). The broker's own routes never do.
    if (!ours) return env.SITE ? env.SITE.fetch(req) : new Response("Not found", { status: 404 });
    if (route === "refresh") return req.method === "POST" ? refresh(req, env, cfg, p!) : new Response("Method not allowed", { status: 405 });
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/health") return health(env, cfg);
    if (route === "setup") return setupDone(p!);
    return route === "start" ? start(url, env, cfg, p!) : callback(url, env, cfg, p!);
  },
};
