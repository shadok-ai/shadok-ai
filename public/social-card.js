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

/** Who may use the account, in words: the confirm copy's `<scope>`. */
export function scopeText(share, groups) {
  const s = share && typeof share === "object" ? share : { scope: "private" };
  if (s.scope === "instance") return "every group";
  if (s.scope === "groups" && Array.isArray(s.groups) && s.groups.length) {
    return s.groups.map((id) => groupName(groups, id)).join(", ");
  }
  return "your private group";
}

/** The sentence a person confirms before letting an account post unasked. */
export function autonomousConfirmText(account, groups) {
  const a = account || {};
  return `Agents in ${scopeText(a.share, groups)} will be able to post as ${a.label || "this account"} without asking anyone.`;
}

/**
 * The share picker: Private, each group the person can share into, Everyone.
 * `groups` is what GET /groups returned (already filtered to the caller's
 * groups and the public ones); Main is left out — sharing with the commons is
 * what "Everyone" says. A current multi-group share keeps its own option so the
 * picker never silently rewrites it.
 */
export function shareOptions(groups, share) {
  const list = (Array.isArray(groups) ? groups : []).filter((g) => g && g.id != null && String(g.id) !== "main");
  const out = [{ value: "private", label: "Private" }];
  for (const g of list) out.push({ value: "group:" + g.id, label: g.nature === "private" ? "Personal" : g.name });
  out.push({ value: "instance", label: "Everyone" });
  const s = share || {};
  if (s.scope === "groups" && Array.isArray(s.groups) && s.groups.length > 1) {
    out.splice(out.length - 1, 0, { value: "groups:" + s.groups.join(","), label: s.groups.map((id) => groupName(groups, id)).join(", ") });
  }
  return out;
}

/** The picker value that matches a stored share. */
export function shareValue(share) {
  const s = share || {};
  if (s.scope === "instance") return "instance";
  if (s.scope === "groups" && Array.isArray(s.groups) && s.groups.length) {
    return s.groups.length === 1 ? "group:" + s.groups[0] : "groups:" + s.groups.join(",");
  }
  return "private";
}

/** A picker value back to the `share` body PUT /connected-accounts/:id takes. */
export function shareFromValue(value) {
  const v = String(value ?? "");
  if (v === "instance") return { scope: "instance" };
  if (v.startsWith("group:")) return { scope: "groups", groups: [v.slice(6)] };
  if (v.startsWith("groups:")) return { scope: "groups", groups: v.slice(7).split(",").filter(Boolean) };
  return { scope: "private" };
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
