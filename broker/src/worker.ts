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

export interface Env {
  LINKEDIN_CLIENT_ID: string;
  LINKEDIN_CLIENT_SECRET: string;
  STATE_KEY: string;
  // Google is optional: without both secrets the broker does not offer it.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // "1" while the Google app is in Testing (refresh tokens last 7 days); the
  // instance reads it off /health to warn about weekly reconnects.
  GOOGLE_TESTING?: string;
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
  clientId: (env: Env) => string;
  clientSecret: (env: Env) => string;
}

// A second provider (or a second LinkedIn app) is one more entry here.
const PROVIDERS: Record<ProviderId, Provider> = {
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scope: () => "openid profile w_member_social",
    clientId: (e) => e.LINKEDIN_CLIENT_ID,
    clientSecret: (e) => e.LINKEDIN_CLIENT_SECRET,
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
    clientId: (e) => e.GOOGLE_CLIENT_ID ?? "",
    clientSecret: (e) => e.GOOGLE_CLIENT_SECRET ?? "",
  },
};

/** A provider is offered only once its secrets exist: a deploy before the
 *  Google app is set up must not show a Connect button that leads nowhere. */
const available = (p: Provider, env: Env) => !!p.clientId(env) && !!p.clientSecret(env);
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

const bad = (msg: string) => page(400, "Cannot connect", `<p>${esc(msg)}</p>`);
const link = (returnUrl: string, nonce: string, tail: string) => `${returnUrl}#n=${nonce}&${tail}`;

async function start(url: URL, env: Env, p: Provider): Promise<Response> {
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
  const state = await signState(st, env.STATE_KEY);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId(env),
    redirect_uri: `${url.origin}/${p.id}/callback`,
    scope: p.scope(st),
    ...(p.extra ?? {}),
    state,
  });
  return new Response(null, { status: 302, headers: { location: `${p.authorizeUrl}?${q}`, "cache-control": "no-store" } });
}

async function callback(url: URL, env: Env, p: Provider): Promise<Response> {
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

  const failed = (sentence: string) =>
    page(200, "Connection failed", `<p>${esc(sentence)}</p><a class="b" href="${esc(link(returnUrl, st.nonce, "error=token_exchange_failed"))}">Back to ${esc(host)}</a>`);
  let res: Response;
  try {
    res = await fetch(p.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${url.origin}/${p.id}/callback`,
        client_id: p.clientId(env),
        client_secret: p.clientSecret(env),
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
    const j = (await res.json()) as TokenPayload;
    if (typeof j.access_token !== "string" || !j.access_token) throw new Error("no token");
    token = {
      access_token: j.access_token,
      expires_in: j.expires_in,
      scope: j.scope,
      ...(j.refresh_token ? { refresh_token: j.refresh_token, refresh_token_expires_in: j.refresh_token_expires_in } : {}),
    };
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
// Google's error codes are short snake_case words; anything else is not echoed.
const ERROR_CODE_RE = /^[a-z_]{1,64}$/;

/**
 * `POST /<provider>/refresh` `{refresh_token}` → `{access_token, expires_in,
 * scope}`. Google access tokens last about an hour and refreshing needs the
 * client secret, which only the broker holds; the instance's SERVER calls this
 * (outbound, so it works behind NAT). Stateless: the refresh token is used and
 * forgotten, never logged, never echoed. `invalid_grant` (revoked, expired —
 * 7 days in Testing) is passed through so the instance can say "reconnect".
 */
async function refresh(req: Request, env: Env, p: Provider): Promise<Response> {
  let body: { refresh_token?: unknown };
  try {
    body = (await req.json()) as { refresh_token?: unknown };
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const rt = body?.refresh_token;
  if (typeof rt !== "string" || !rt || rt.length > MAX_REFRESH_TOKEN) return json(400, { error: "invalid_request" });
  let res: Response;
  try {
    res = await fetch(p.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: p.clientId(env), client_secret: p.clientSecret(env) }),
    });
  } catch {
    return json(502, { error: "unreachable" });
  }
  let j: Record<string, unknown> = {};
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    /* a non-JSON answer is handled below as an unexpected one */
  }
  if (!res.ok) {
    const code = typeof j.error === "string" && ERROR_CODE_RE.test(j.error) ? j.error : "refresh_failed";
    // 400 for what the caller must act on (reconnect); 502 for the provider's trouble.
    return json(code === "invalid_grant" ? 400 : 502, { error: code, status: res.status });
  }
  if (typeof j.access_token !== "string" || !j.access_token) return json(502, { error: "unexpected_answer" });
  return json(200, { access_token: j.access_token, expires_in: j.expires_in, scope: j.scope });
}

function health(env: Env): Response {
  const providers = Object.values(PROVIDERS).filter((p) => available(p, env)).map((p) => p.id);
  const google = providers.includes("google");
  // `googleAreas`: the areas THIS deploy accepts at /google/start. An instance
  // newer than the broker would otherwise offer an area the broker refuses.
  return Response.json({
    ok: true,
    providers,
    ...(env.GOOGLE_TESTING === "1" && google ? { testing: ["google"] } : {}),
    ...(google ? { googleAreas: Object.keys(GOOGLE_AREAS) } : {}),
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/([a-z]+)\/(start|callback|refresh)$/.exec(url.pathname);
    const p = m ? providerOf(m[1]) : undefined;
    const route = m && p && available(p, env) && (m[2] !== "refresh" || p.refresh) ? m[2] : undefined;
    const ours = url.pathname === "/health" || route !== undefined;
    // Every path the broker does not own goes to the site, whatever the method
    // (the waitlist is a POST). The broker's own routes never do.
    if (!ours) return env.SITE ? env.SITE.fetch(req) : new Response("Not found", { status: 404 });
    if (route === "refresh") return req.method === "POST" ? refresh(req, env, p!) : new Response("Method not allowed", { status: 405 });
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/health") return health(env);
    return route === "start" ? start(url, env, p!) : callback(url, env, p!);
  },
};
