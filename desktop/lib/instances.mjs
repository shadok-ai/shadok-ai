// The desktop client's pure logic: the saved list of cockpit instances, and
// what an instance's page title says about its agents. No Electron, no fs —
// imported by main.mjs AND by the node tests (test/desktop-instances.test.ts),
// like public/notify.js.

/**
 * @typedef {{ id: string, name: string, url: string }} Instance
 * `id` is minted once, at creation, and names the instance's storage partition.
 * It never changes — not on a rename — so a rename keeps the login.
 */

/**
 * Turn what someone typed into a URL we are willing to load, or explain why
 * not. Only http(s): an instance is a web server, and `file:` / `javascript:`
 * in a window with a preload bridge is exactly what we must never load.
 *
 * A bare host gets a scheme: `http` for loopback (a local cockpit has no TLS),
 * `https` for anything else (a remote cockpit is meant to sit behind TLS,
 * README "Behind TLS" — guessing http there would send the password in clear).
 *
 * @param {string} input
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function normalizeUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, reason: "Enter the address of a cockpit." };
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // `localhost:3789` would parse as scheme "localhost:" — add one first.
    const host = raw.split(/[/:]/)[0].toLowerCase();
    const loopback = host === "localhost" || /^127\./.test(host) || host === "[";
    candidate = (loopback ? "http://" : "https://") + raw;
  }
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, reason: "That is not a valid address." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "Only http:// and https:// addresses are supported." };
  }
  if (!u.hostname) return { ok: false, reason: "That address has no host." };
  // Credentials in a URL would sit in plain text in the saved list.
  if (u.username || u.password) {
    return { ok: false, reason: "Leave the password out of the address — the cockpit asks for it." };
  }
  u.hash = "";
  return { ok: true, url: u.toString() };
}

/** The default label for a new instance: its host, plus a non-default port. */
export function defaultName(url) {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "cockpit";
  }
}

/**
 * The Electron session partition of an instance. One per instance, persisted.
 *
 * Keyed by the instance id, NOT by its origin, and that is the point: the
 * cockpit caches its channels in localStorage, which a browser scopes by
 * origin — and two instances can sit on the same origin one after the other
 * (invariants 34 and 35 in CLAUDE.md). A partition per saved entry means two
 * entries never share cookies or storage, whatever their URLs.
 */
export function partitionFor(id) {
  return `persist:instance-${id}`;
}

/**
 * Parse the saved file's content into a clean list. Anything malformed is
 * dropped rather than thrown on: a corrupted file must open an empty app, not
 * no app at all.
 *
 * @param {unknown} data
 * @returns {Instance[]}
 */
export function parseInstances(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.instances) ? data.instances : [];
  const seen = new Set();
  /** @type {Instance[]} */
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const id = typeof it.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(it.id) ? it.id : null;
    if (!id || seen.has(id)) continue;
    const norm = normalizeUrl(it.url);
    if (!norm.ok) continue;
    const name = typeof it.name === "string" && it.name.trim() ? it.name.trim().slice(0, 80) : defaultName(norm.url);
    seen.add(id);
    out.push({ id, name, url: norm.url });
  }
  return out;
}

/**
 * Add an instance. Returns the new list, or a refusal.
 * @param {Instance[]} list
 * @param {{ url: string, name?: string }} input
 * @param {string} id freshly minted by the caller (keeps this function pure)
 */
export function addInstance(list, input, id) {
  const norm = normalizeUrl(input?.url);
  if (!norm.ok) return norm;
  const name = String(input?.name ?? "").trim().slice(0, 80) || defaultName(norm.url);
  return { ok: true, list: [...list, { id, name, url: norm.url }], id };
}

/** Rename an instance; an empty name falls back to the host. */
export function renameInstance(list, id, name) {
  return list.map((it) =>
    it.id === id ? { ...it, name: String(name ?? "").trim().slice(0, 80) || defaultName(it.url) } : it,
  );
}

export function removeInstance(list, id) {
  return list.filter((it) => it.id !== id);
}

/** Move an instance to a new index (drag to reorder in the sidebar). */
export function moveInstance(list, id, toIndex) {
  const from = list.findIndex((it) => it.id === id);
  if (from < 0) return list;
  const next = list.slice();
  const [it] = next.splice(from, 1);
  const to = Math.max(0, Math.min(next.length, toIndex));
  next.splice(to, 0, it);
  return next;
}

/**
 * Does this page title say an agent wants attention?
 *
 * The cockpit stamps its own notification state into `document.title`
 * (public/notify.js): "● " when an agent is blocked on a question or an answer
 * is unread, alternating with "◉ " while it blinks. Reading the title costs the
 * cockpit no change at all, and Electron reports every title change — so the
 * desktop client learns about attention exactly when a browser tab would.
 *
 * @param {string} title
 */
export function titleWantsAttention(title) {
  return /^\s*[●◉]/.test(String(title ?? ""));
}

/** The page title without the notification glyph. */
export function cleanTitle(title) {
  return String(title ?? "").replace(/^\s*[●◉]\s*/, "");
}

/** How many instances want attention — the Dock / taskbar badge. */
export function attentionCount(states) {
  let n = 0;
  for (const s of Object.values(states || {})) if (s && s.attention) n++;
  return n;
}

/**
 * Should a navigation stay inside the instance's view? Only within its own
 * origin. Anything else — a GitHub link, an OAuth URL in an agent's answer —
 * goes to the system browser: the view holds a logged-in cockpit, and a
 * foreign page has no business running in that partition.
 */
export function staysInView(instanceUrl, targetUrl) {
  try {
    return new URL(instanceUrl).origin === new URL(targetUrl).origin;
  } catch {
    return false;
  }
}

/** May this URL be handed to the OS to open? http(s) and mailto only. */
export function externalAllowed(targetUrl) {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(targetUrl).protocol);
  } catch {
    return false;
  }
}
