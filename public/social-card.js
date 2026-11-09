// Connected accounts (LinkedIn) as pure view models, shared by the browser and
// the tests — like public/profile-card.js. Nothing here touches the DOM: the
// page renders what these return, and renders the draft's TEXT with
// textContent only (invariant 13) — it is whatever the agent wrote, so this
// module passes it through untouched rather than "cleaning" it.
// Design: docs/superpowers/specs/2026-11-08-connected-accounts-linkedin-design.md.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same threshold as the server's expiry warning (7 days before `expiresAt`). */
export const EXPIRY_SOON_MS = 7 * DAY_MS;

/** Only an http(s) address becomes a link; anything else stays text. */
function safeUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;
}

/**
 * The approval card for one draft (`DraftView`, src/social-drafts.ts).
 * `actions` is non-empty exactly while the draft waits for a person — that is
 * also what makes the channel's tab ask for an answer.
 */
export function draftCardModel(draft) {
  const d = draft && typeof draft === "object" ? draft : {};
  const status = typeof d.status === "string" ? d.status : "pending";
  const pending = status === "pending";
  const link = status === "published" ? safeUrl(d.postUrl) : null;
  let statusLine;
  if (pending) statusLine = "Waiting for approval — nothing is posted until someone publishes it.";
  else if (status === "publishing") statusLine = "Publishing…";
  else if (status === "published") statusLine = "Published — " + (link ?? (typeof d.postUrl === "string" ? d.postUrl : ""));
  else if (status === "discarded") statusLine = "Discarded by " + (d.decidedBy || "someone");
  else if (status === "expired") statusLine = "Expired — this draft was never published.";
  else if (status === "failed") statusLine = d.error || "This draft could not be published.";
  else statusLine = status;
  return {
    title: "LinkedIn post as " + (d.account || "(disconnected account)"),
    text: typeof d.text === "string" ? d.text : "",
    image: d.image && typeof d.image === "object" ? d.image : null,
    actions: pending
      ? [{ action: "publish", label: "Publish" }, { action: "discard", label: "Discard" }]
      : [],
    statusLine: statusLine.trimEnd(),
    link,
    pending,
  };
}

/** Does any of these drafts still wait for a person? */
export function hasPendingDraft(drafts) {
  return [...(drafts ?? [])].some((d) => d && d.status === "pending");
}

function groupName(groups, id) {
  const g = (Array.isArray(groups) ? groups : []).find((x) => x && String(x.id) === String(id));
  return g ? g.name : String(id);
}

/**
 * A share in the current shape (src/connected-accounts.ts `ShareScope`): any
 * combination of the owner's Personal group, named groups and Everyone, then a
 * profile filter. Reads the v1 single-choice form too, and folds a PERSONAL
 * group named in `groups` into `personal` — the two meant the same thing.
 */
export function normalizeShare(share, groups = []) {
  const s = share && typeof share === "object" ? share : {};
  const list = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []);
  let out;
  if (typeof s.scope === "string") {
    out = {
      personal: s.scope === "private",
      groups: s.scope === "groups" ? list(s.groups) : [],
      everyone: s.scope === "instance",
      profiles: [],
    };
  } else {
    out = { personal: s.personal === true, groups: list(s.groups), everyone: s.everyone === true, profiles: list(s.profiles) };
  }
  const gl = Array.isArray(groups) ? groups : [];
  const personalIds = new Set(gl.filter((g) => g && g.nature === "private").map((g) => String(g.id)));
  if (out.groups.some((id) => personalIds.has(id))) {
    out.personal = true;
    out.groups = out.groups.filter((id) => !personalIds.has(id));
  }
  // Every public group (Main included) is the same commons: one named in
  // `groups` reads — and is saved back — as the Public chip.
  const publicIds = new Set(["main", ...gl.filter((g) => g && g.nature === "public").map((g) => String(g.id))]);
  if (out.groups.some((id) => publicIds.has(id))) {
    out.everyone = true;
    out.groups = out.groups.filter((id) => !publicIds.has(id));
  }
  return out;
}

/** Who may use the account, in words: the confirm copy's `<scope>`. */
export function scopeText(share, groups) {
  const s = normalizeShare(share, groups);
  const parts = [];
  if (s.personal) parts.push("your Personal group");
  for (const id of s.groups) parts.push(groupName(groups, id));
  if (s.everyone) parts.push("the public groups");
  if (!parts.length) return "no group";
  const where = parts.join(", ");
  return s.profiles.length ? `${where} (profile ${s.profiles.join(", ")} only)` : where;
}

/** The sentence a person confirms before letting an account post unasked. */
export function autonomousConfirmText(account, groups) {
  const a = account || {};
  return `Agents in ${scopeText(a.share, groups)} will be able to post as ${a.label || "this account"} without asking anyone.`;
}

/**
 * The "Shared with" chips, in order: Public (Main and every public group — one
 * commons), Personal (the owner's own), then each restricted group the person
 * can share into — any combination. `groups` is what GET /groups returned. A stored group the list no longer carries keeps its box,
 * so the picker never silently drops it.
 */
export function shareChoices(groups, share) {
  const s = normalizeShare(share, groups);
  const list = (Array.isArray(groups) ? groups : []).filter((g) => g && g.id != null && g.nature === "restricted");
  const out = [
    { key: "everyone", label: "Public", checked: s.everyone },
    { key: "personal", label: "Personal", checked: s.personal },
  ];
  const seen = new Set();
  for (const g of list) {
    seen.add(String(g.id));
    out.push({ key: "group:" + g.id, label: g.name, checked: s.groups.includes(String(g.id)) });
  }
  for (const id of s.groups) if (!seen.has(id)) out.push({ key: "group:" + id, label: groupName(groups, id), checked: true });
  return out;
}

/** The share after ticking (`on`) or unticking one `shareChoices` key. */
export function toggleShare(share, key, on, groups = []) {
  const s = normalizeShare(share, groups);
  const k = String(key ?? "");
  if (k === "personal") return { ...s, personal: !!on };
  if (k === "everyone") return { ...s, everyone: !!on };
  if (k.startsWith("group:")) {
    const id = k.slice(6);
    const rest = s.groups.filter((g) => g !== id);
    return { ...s, groups: on ? [...rest, id] : rest };
  }
  return s;
}

/**
 * The profile filter's chips: "Any profile" first (lit when the filter is
 * empty), then every pickable profile (managed roles left out by the caller)
 * plus any the share names that is gone. Keys: "*" for Any, else the name.
 */
export function profileChoices(names, share) {
  const s = normalizeShare(share);
  const all = [...new Set([...(Array.isArray(names) ? names.map(String) : []), ...s.profiles])].sort();
  return [
    { key: "*", label: "Any profile", checked: s.profiles.length === 0 },
    ...all.map((name) => ({ key: name, label: name, checked: s.profiles.includes(name) })),
  ];
}

/**
 * The share after a click on one profile chip. Any ("*") clears the filter and
 * cannot be switched off by itself (an empty filter IS "any"); a named profile
 * toggles, and unticking the last one falls back to Any.
 */
export function toggleProfile(share, key, on, groups = []) {
  const s = normalizeShare(share, groups);
  const k = String(key ?? "");
  if (k === "*") return { ...s, profiles: [] };
  const rest = s.profiles.filter((p) => p !== k);
  return { ...s, profiles: on ? [...rest, k] : rest };
}

/** One row of the Connected accounts list (`publicView`, src/connected-accounts.ts). */
export function accountRowModel(account, now = Date.now(), groups = []) {
  const a = account || {};
  const left = (Number(a.expiresAt) || 0) - now;
  const expired = a.status === "expired" || left <= 0;
  const tone = expired ? "expired" : left < EXPIRY_SOON_MS ? "soon" : "ok";
  let expiryText;
  if (expired) expiryText = "expired — reconnect to keep posting";
  else if (left >= 2 * DAY_MS) expiryText = "expires in " + Math.round(left / DAY_MS) + " days";
  else if (left >= 2 * 60 * 60 * 1000) expiryText = "expires in " + Math.round(left / 3_600_000) + " h";
  else expiryText = "expires in " + Math.max(1, Math.round(left / 60_000)) + " min";
  return {
    label: a.label || "(unnamed account)",
    via: "LinkedIn" + (a.connectedVia ? " · connected by " + a.connectedVia : ""),
    expiryText,
    tone,
    shareText: "Shared with " + scopeText(a.share, groups),
    policyText: a.policy === "autonomous" ? "Posts without approval" : "Every post needs approval",
  };
}

function isoDay(ms) {
  return new Date(Number(ms) || 0).toISOString().slice(0, 10);
}

/**
 * The header banners for the viewer's OWN accounts (GET /connected-accounts
 * flags only those: `expiringSoon` / `expired`). The Telegram DM reaches the
 * operator alone, so for every other owner this is the only warning. `key`
 * changes with `expiresAt`, so a dismissal does not outlive a reconnect.
 */
export function accountBanners(accounts) {
  const out = [];
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (!a || typeof a !== "object") continue;
    const label = a.label || "(unnamed account)";
    const key = String(a.id) + ":" + String(a.expiresAt);
    if (a.expired === true) {
      out.push({ key, text: `Your LinkedIn connection '${label}' has expired — reconnect it in Secrets → Connected accounts.` });
    } else if (a.expiringSoon === true) {
      out.push({ key, text: `Your LinkedIn connection '${label}' expires on ${isoDay(a.expiresAt)} — reconnect it in Secrets → Connected accounts.` });
    }
  }
  return out;
}

/** One publication-log entry (GET /connected-accounts/:id/log) as one plain line. */
export function logEntryLine(e) {
  const x = e && typeof e === "object" ? e : {};
  const when = new Date(Number(x.at) || 0).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const who = x.channel ? `${x.channel} (${x.origin || "agent"})` : String(x.origin || "agent");
  const parts = [when, String(x.outcome || ""), who];
  if (x.approvedBy === "autonomous") parts.push("without approval");
  else if (x.approvedBy && x.approvedBy !== "none" && x.approvedBy !== "system") parts.push("approved by " + x.approvedBy);
  if (x.outcome === "published" && x.postUrl) parts.push(String(x.postUrl));
  else if (x.error) parts.push(String(x.error));
  const text = typeof x.text === "string" ? x.text.replace(/\s+/g, " ").trim() : "";
  parts.push(text.length > 80 ? text.slice(0, 79) + "…" : text);
  return parts.filter(Boolean).join(" · ");
}
