// The connect broker: a stateless Worker that holds the OAuth client secret so
// the instances never do. It sends the browser to the provider, exchanges the
// code on the way back, and hands the token to the instance through the
// browser -- encrypted for a key only that instance holds (see core.ts).

import {
  encryptForInstance,
  signState,
  validateReturnUrl,
  verifyState,
  type TokenPayload,
} from "./core.js";

export interface Env {
  LINKEDIN_CLIENT_ID: string;
  LINKEDIN_CLIENT_SECRET: string;
  STATE_KEY: string;
}

interface Provider {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: (env: Env) => string;
  clientSecret: (env: Env) => string;
}

// A second provider (or a second LinkedIn app) is one more entry here.
const PROVIDERS: Record<string, Provider> = {
  linkedin: {
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scope: "openid profile w_member_social",
    clientId: (e) => e.LINKEDIN_CLIENT_ID,
    clientSecret: (e) => e.LINKEDIN_CLIENT_SECRET,
  },
};

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
  const v = validateReturnUrl(ret);
  if (!v.ok) return bad(`Invalid return URL: ${v.reason}.`);
  if (!pub || !nonce) return bad("Missing pub or nonce.");
  if (!NONCE_RE.test(nonce) || !PUB_RE.test(pub)) return bad("Malformed pub or nonce.");
  const state = await signState({ v: 1, provider: "linkedin", returnUrl: v.url.toString(), pub, nonce, iat: Date.now() }, env.STATE_KEY);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId(env),
    redirect_uri: `${url.origin}/linkedin/callback`,
    scope: p.scope,
    state,
  });
  return new Response(null, { status: 302, headers: { location: `${p.authorizeUrl}?${q}`, "cache-control": "no-store" } });
}

async function callback(url: URL, env: Env, p: Provider): Promise<Response> {
  const st = await verifyState(url.searchParams.get("state") ?? "", env.STATE_KEY);
  if (!st) return bad("This connection attempt is invalid or has expired. Start again from your cockpit.");
  // Defence in depth: the state is signed by us, but a redirect carrying a
  // token is the one place an open redirect would hurt, so check again.
  const v = validateReturnUrl(st.returnUrl);
  if (!v.ok || typeof st.pub !== "string" || !st.pub || typeof st.nonce !== "string" || !st.nonce) {
    return bad("This connection attempt is invalid. Start again from your cockpit.");
  }
  const returnUrl = v.url.toString();
  const host = v.url.host;
  const cancel = `<a class="c" href="${esc(link(returnUrl, st.nonce, "error=cancelled"))}">Cancel</a>`;

  const err = url.searchParams.get("error");
  if (err) {
    const code = encodeURIComponent(err);
    return page(200, "LinkedIn connection not completed", `<p>LinkedIn did not complete the connection (${esc(err)}).</p><a class="b" href="${esc(link(returnUrl, st.nonce, `error=${code}`))}">Back to ${esc(host)}</a>`);
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
        redirect_uri: `${url.origin}/linkedin/callback`,
        client_id: p.clientId(env),
        client_secret: p.clientSecret(env),
      }),
    });
  } catch {
    // A network failure: without this the Worker throws, the person gets a bare
    // 1101 page and no way back, and the instance's attempt is never consumed.
    // The error's text is not shown — it is not ours to vouch for.
    return failed("The connector could not reach LinkedIn. Try again in a moment.");
  }
  if (!res.ok) {
    // Status only: the body could echo the code or the client secret.
    return failed(`LinkedIn refused the connection (HTTP ${res.status}).`);
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
    // HTTP 200 but no usable token: LinkedIn did not refuse anything.
    return failed("LinkedIn returned an unexpected answer.");
  }
  let c: string;
  try {
    c = await encryptForInstance(st.pub, st.nonce, token);
  } catch {
    return page(200, "Connection failed", `<p>The key sent by your cockpit was not usable.</p><a class="b" href="${esc(link(returnUrl, st.nonce, "error=encryption_failed"))}">Back to ${esc(host)}</a>`);
  }
  return page(
    200,
    "Connect LinkedIn",
    `<p>You are connecting LinkedIn to the shadok cockpit at <strong>${esc(host)}</strong>. Only continue if that is your cockpit.</p><a class="b" href="${esc(link(returnUrl, st.nonce, `c=${c}`))}">Continue</a>${cancel}`,
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/health") return Response.json({ ok: true, providers: Object.keys(PROVIDERS) });
    const m = /^\/([a-z]+)\/(start|callback)$/.exec(url.pathname);
    const p = m ? PROVIDERS[m[1]] : undefined;
    if (!m || !p) return new Response("Not found", { status: 404 });
    return m[2] === "start" ? start(url, env, p) : callback(url, env, p);
  },
};
