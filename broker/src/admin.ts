// The broker's admin page: set each provider's OAuth app (client id + secret),
// one default for every instance and any number of per-domain overrides.
//
// Plain HTML forms, no script: the page needs none, and a CSP of
// `default-src 'none'` leaves nothing to inject into. Every request is
// authenticated by Cloudflare Access (access.ts); a write also needs a
// same-origin `Origin` — a CSRF guard on top of the Access JWT, never the
// authentication itself. A stored secret is never sent back to the browser.

import { accessUser, type AccessEnv } from "./access.js";
import { appInputVerdict, applyDelete, applySave, APPS_KEY, loadConfig, normalizeHost, type AppsConfig, type ConfigKV, type StoredApp } from "./apps.js";
import { isProviderId, type ProviderId } from "./core.js";

export interface AdminEnv extends AccessEnv {
  CONFIG?: ConfigKV;
  /** 32 bytes, base64url: the key client secrets are sealed with in KV. */
  CONFIG_KEY?: string;
}

/** What the page shows of a provider's Worker-secret apps (never a secret). */
export interface ProviderView {
  id: ProviderId;
  label: string;
  envDefault: string | null;
  envAlt: { clientId: string; hosts: string[] } | null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#222}
h1{margin-bottom:.2rem}h2{margin-top:2rem;border-bottom:1px solid #ddd}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #eee;vertical-align:top}
code{font-size:.85em;word-break:break-all}.muted{color:#777;font-size:.85em}.ok{background:#e7f6ec;padding:.5rem 1rem}.err{background:#fdecea;padding:.5rem 1rem}
form.inline{display:inline}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:.3rem}
details{margin:.3rem 0}fieldset{border:1px solid #ddd;margin:.5rem 0}label{display:block;margin:.3rem 0}
button{padding:.3rem .8rem}`;

function html(status: number, body: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connector admin</title><style>${STYLE}</style></head><body>${body}</body></html>`, { status, headers: HEADERS });
}

const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";

function appForm(p: ProviderView, host: string, cur: StoredApp | null, ready: boolean): string {
  const dis = ready ? "" : " disabled";
  return `<form method="post" action="/admin/save">
<input type="hidden" name="provider" value="${p.id}">
${host === "\0new" ? `<label>Domain <input type="text" name="host" placeholder="demo.example.com" required${dis}></label>` : `<input type="hidden" name="host" value="${esc(host)}">`}
<label>Client ID <input type="text" name="clientId" value="${esc(cur?.clientId ?? "")}" required autocomplete="off"${dis}></label>
<label>Client secret <input type="password" name="secret" placeholder="${cur ? "unchanged — type a new one to replace it" : ""}" autocomplete="new-password"${dis}></label>
${p.id === "google" ? `<label><input type="checkbox" name="testing"${cur?.testing ? " checked" : ""}${dis}> App in Testing (authorisations last 7 days)</label>` : ""}
${p.id === "github" ? `<label>App slug (github.com/apps/<em>slug</em>) <input type="text" name="slug" value="${esc(cur?.slug ?? "")}"${dis}></label>` : ""}
<button${dis}>Save</button></form>`;
}

function row(p: ProviderView, domain: string, host: string, app: StoredApp | null, envNote: string | null, ready: boolean): string {
  const flags = [app?.testing ? "Testing" : "", app?.slug ? `slug ${esc(app.slug)}` : ""].filter(Boolean).join(", ");
  const del = app
    ? `<form class="inline" method="post" action="/admin/delete"><input type="hidden" name="provider" value="${p.id}"><input type="hidden" name="host" value="${esc(host)}"><button${ready ? "" : " disabled"}>Remove</button></form>`
    : "";
  const cid = app ? `<code>${esc(app.clientId)}</code>` : envNote ? `<code>${esc(envNote)}</code> <span class="muted">(Worker secret)</span>` : `<span class="muted">not set</span>`;
  const meta = app ? `<span class="muted">${esc(when(app.updatedAt))} · ${esc(app.updatedBy)}</span>` : "";
  return `<tr><td>${domain}</td><td>${cid}${flags ? `<br><span class="muted">${flags}</span>` : ""}</td><td>${meta}</td><td>
<details><summary>${app ? "Edit" : "Set"}</summary>${appForm(p, host, app, ready)}</details>${del}</td></tr>`;
}

export function renderAdmin(providers: ProviderView[], cfg: AppsConfig, user: string, ready: boolean, flash: { ok?: string; err?: string }): string {
  let out = `<h1>Connector admin</h1><p class="muted">Signed in as ${esc(user)} through Cloudflare Access.</p>`;
  if (flash.ok) out += `<p class="ok">${esc(flash.ok)}</p>`;
  if (flash.err) out += `<p class="err">${esc(flash.err)}</p>`;
  if (!ready) out += `<p class="err">Storage is not set up (KV binding <code>CONFIG</code> and secret <code>CONFIG_KEY</code>): the apps below are read-only.</p>`;
  out += `<p>Each provider has one app for every cockpit, and may have another app for specific domains (the cockpit's hostname, e.g. a demo instance). A domain's app wins over the default. Apps set here win over the Worker secrets. Secrets are stored encrypted and never shown again. A change reaches every Cloudflare location within about a minute.</p>`;
  for (const p of providers) {
    const pa = cfg[p.id] ?? {};
    out += `<h2>${esc(p.label)}</h2><table><tr><th>Domain</th><th>App</th><th>Updated</th><th></th></tr>`;
    out += row(p, "<strong>All domains</strong> (default)", "", pa.default ?? null, p.envDefault, ready);
    const kvHosts = Object.keys(pa.hosts ?? {}).sort();
    for (const h of kvHosts) out += row(p, `<code>${esc(h)}</code>`, h, pa.hosts![h], null, ready);
    for (const h of p.envAlt?.hosts ?? []) {
      if (kvHosts.includes(h)) continue;
      out += row(p, `<code>${esc(h)}</code>`, h, null, p.envAlt!.clientId, ready);
    }
    out += `</table><details><summary>Add a domain</summary>${appForm(p, "\0new", null, ready)}</details>`;
  }
  return out;
}

async function formOf(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const f = await req.formData();
    f.forEach((v, k) => {
      if (typeof v === "string") out[k] = v;
    });
  } catch {
    /* an unreadable body is an empty form, refused by the verdicts */
  }
  return out;
}

const back = (url: URL, q: Record<string, string>) =>
  new Response(null, { status: 303, headers: { location: `${url.origin}/admin?${new URLSearchParams(q)}`, "cache-control": "no-store" } });

/**
 * `/admin` (GET) and `/admin/save`, `/admin/delete` (POST). Returns null when
 * the path is not an admin path. Anyone Access did not let in gets a bare 404:
 * the page's existence is not advertised.
 */
export async function handleAdmin(req: Request, url: URL, env: AdminEnv, providers: ProviderView[]): Promise<Response | null> {
  if (url.pathname !== "/admin" && url.pathname !== "/admin/save" && url.pathname !== "/admin/delete") return null;
  const user = await accessUser(req, env);
  if (!user) return new Response("Not found", { status: 404 });
  const ready = !!env.CONFIG && !!env.CONFIG_KEY;
  if (url.pathname === "/admin") {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const cfg = await loadConfig(env.CONFIG);
    const ok = url.searchParams.get("ok") ?? undefined;
    const err = url.searchParams.get("err") ?? undefined;
    return html(200, renderAdmin(providers, cfg, user, ready, { ok, err }));
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("origin") !== url.origin) return new Response("Forbidden", { status: 403 });
  if (!ready) return back(url, { err: "Storage is not set up." });
  const form = await formOf(req);
  const cfg = await loadConfig(env.CONFIG);
  let next: AppsConfig;
  let done: string;
  if (url.pathname === "/admin/save") {
    const v = appInputVerdict(form);
    if (!v.ok) return back(url, { err: `Not saved: ${v.reason}.` });
    const r = await applySave(cfg, v.input, env.CONFIG_KEY!, user, Date.now());
    if (!r.ok) return back(url, { err: `Not saved: ${r.reason}.` });
    next = r.cfg;
    done = `Saved the ${v.input.provider} app for ${v.input.host || "all domains"}.`;
  } else {
    const provider = form.provider ?? "";
    const host = (form.host ?? "").trim() === "" ? "" : normalizeHost(form.host ?? "");
    if (!isProviderId(provider) || host === null) return back(url, { err: "Not removed: unknown entry." });
    next = applyDelete(cfg, provider, host);
    done = `Removed the ${provider} app for ${host || "all domains"}.`;
  }
  await env.CONFIG!.put(APPS_KEY, JSON.stringify(next));
  return back(url, { ok: done });
}
