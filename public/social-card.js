// Connected accounts (LinkedIn, Google) as pure view models, shared by the browser and
// the tests — like public/profile-card.js. Nothing here touches the DOM: the
// page renders what these return, and renders the draft's TEXT with
// textContent only (invariant 13) — it is whatever the agent wrote, so this
// module passes it through untouched rather than "cleaning" it.
// Design: docs/superpowers/specs/2026-11-08-connected-accounts-linkedin-design.md,
// docs/superpowers/specs/2026-11-13-connected-accounts-google-design.md.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same threshold as the server's expiry warning (7 days before `expiresAt`). */
export const EXPIRY_SOON_MS = 7 * DAY_MS;
/** Google in Testing lasts 7 days in all, so it warns 2 days ahead (server: GOOGLE_WARN_BEFORE_MS). */
export const GOOGLE_EXPIRY_SOON_MS = 2 * DAY_MS;

/** The areas of the Connect Google dialog, in the broker's order. */
export const GOOGLE_AREA_CHOICES = [
  { key: "calendar", label: "Calendar", hint: "read, add, change and delete events" },
  { key: "drive", label: "Drive files", hint: "the Docs and Sheets the cockpit creates — never the rest of the Drive" },
  { key: "gmail", label: "Gmail", hint: "write drafts and send email — reading mail is a separate choice" },
  // Off by default: opening a mailbox to agents is a choice made on purpose.
  { key: "gmail_read", label: "Read Gmail", hint: "search and read the mailbox", defaultOn: false },
  // Off by default too: every file of the Drive, the shared ones included.
  { key: "drive_all", label: "All of Drive", hint: "search, read, download, edit, rename, move and bin every file of the Drive, shared ones included — changes ask first", defaultOn: false },
];

/**
 * The chips of the Connect Google dialog. `offered` is what the broker accepts
 * (`/connect/status` → `googleAreas`): an area it does not name is not shown.
 * `preset` is what the account holds today (a Reconnect): exactly those are
 * ticked; without one, each area's own default — everything but reading mail.
 */
export function googleAreaChips(offered, preset) {
  const ok = Array.isArray(offered) ? offered.map(String) : [];
  const held = Array.isArray(preset) && preset.length ? preset.map(String) : null;
  return GOOGLE_AREA_CHOICES.filter((c) => ok.includes(c.key)).map((c) => ({
    key: c.key,
    label: c.label,
    hint: c.hint,
    checked: held ? held.includes(c.key) : c.defaultOn !== false,
  }));
}

/**
 * When the account stops working unless reconnected, or null when no date is
 * known. LinkedIn: `expiresAt`. Google: `refreshExpiresAt` — its `expiresAt`
 * is the hourly access token's, which the server renews by itself.
 */
export function accountDeadline(account) {
  const a = account || {};
  if (a.provider !== "google") return Number(a.expiresAt) || 0;
  return typeof a.refreshExpiresAt === "number" ? a.refreshExpiresAt : null;
}

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
  if (d.provider === "google") return googleCardModel(d);
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
    kind: "post",
    kindLabel: "LinkedIn post",
    fields: [],
    attachments: [],
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

const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []);

/** `2026-11-20T10:00:00+01:00` → `2026-11-20 10:00`; an all-day date stays as is.
 *  The wall-clock time is shown AS WRITTEN, next to its zone — never converted
 *  to the browser's, which would show a time the event does not say. */
function eventWhen(v, tz) {
  const s = typeof v === "string" ? v : "";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(s);
  if (!m) return s;
  // A time with its own offset is labelled by that offset, never by the
  // zone beside it: the offset is what fixes when the event happens.
  const zone = m[3] === "Z" ? "UTC" : m[3] ? "UTC" + m[3] : tz || "";
  return `${m[1]} ${m[2]}${zone ? ` (${zone})` : ""}`;
}

const FILE_OPS = {
  "doc.append": { head: "Add text to a Google Doc", go: "Add to the document", done: "Added to the document", what: "Text added at the end" },
  "sheet.append": { head: "Add rows to a Google Sheet", go: "Add the rows", done: "Rows added", what: "Rows added" },
  "sheet.update": { head: "Overwrite cells of a Google Sheet", go: "Overwrite the cells", done: "Cells overwritten", what: "New content of the range" },
  "drive.delete": { head: "Move a Drive file to the bin", go: "Move to the bin", done: "Moved to the bin", what: "Moved to the bin — it can be restored from there for about 30 days, then Google deletes it" },
  "drive.move": { head: "Move a Drive file", go: "Move the file", done: "File moved", what: "Moved to another folder" },
  "drive.rename": { head: "Rename a Drive file", go: "Rename the file", done: "File renamed", what: "Renamed" },
};
const FILE_MANAGE = ["drive.delete", "drive.move", "drive.rename"];

/** Rows exactly as they will be written: one JSON array per line. */
function rowsText(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => JSON.stringify(Array.isArray(r) ? r : [r])).join("\n");
}

const EVENT_OPS = {
  create: { head: "New calendar event", go: "Add to calendar", wait: "nothing is added until someone approves it", done: "Added to the calendar" },
  update: { head: "Change to a calendar event", go: "Apply the change", wait: "nothing changes until someone approves it", done: "Event changed" },
  delete: { head: "Delete a calendar event", go: "Delete the event", wait: "the event stays until someone approves it", done: "Event deleted" },
};

/**
 * The approval card of a Google action: an EMAIL (from, to/cc/bcc, subject,
 * the exact body, attachments by name) or a calendar EVENT (title, start/end
 * with its time zone, the attendees Google will email, location, description).
 * Invariant 43: the card shows exactly what will go out — every field the
 * server sends, none summarised. Same shape as the LinkedIn model; `fields`
 * are label/value rows and `text` is the body or the description, both the
 * agent's (or Gmail's) words, rendered with textContent only.
 */
function googleCardModel(d) {
  const status = typeof d.status === "string" ? d.status : "pending";
  const pending = status === "pending";
  const link = status === "published" ? safeUrl(d.postUrl) : null;
  const account = d.account || "(disconnected account)";
  const fields = [];
  let title, kind, kindLabel, text, go, wait, done, attachments = [];
  if (d.mail && typeof d.mail === "object") {
    const m = d.mail;
    kind = "mail";
    kindLabel = "Email";
    title = "Email from " + (m.from || account);
    fields.push({ label: "From", value: m.from || account });
    fields.push({ label: "To", value: strs(m.to).join(", ") || "(nobody)" });
    if (strs(m.cc).length) fields.push({ label: "Cc", value: strs(m.cc).join(", ") });
    if (strs(m.bcc).length) fields.push({ label: "Bcc", value: strs(m.bcc).join(", ") });
    fields.push({ label: "Subject", value: typeof m.subject === "string" ? m.subject : "" });
    attachments = strs(m.attachments);
    text = typeof m.body === "string" ? m.body : "";
    go = "Send";
    wait = m.edited
      ? "Edited in Gmail since — send this version?"
      : "Waiting for approval — nothing is sent until someone sends it. It is in Gmail's drafts too, where it can still be edited.";
    done = "Sent";
  } else if (d.edit && typeof d.edit === "object") {
    // A batch of content edits to a Slides deck, a Doc or a Sheet: the file,
    // then ONE LINE PER OPERATION, in the order they are applied — the lines
    // come from the same operations the server will send.
    const e = d.edit;
    const noun = e.app === "slides" ? "Google Slides deck" : e.app === "sheet" ? "Google Sheet" : "Google Doc";
    const lines = strs(e.lines);
    kind = "file";
    kindLabel = "Drive edit";
    title = "Edit a " + noun + " — " + account;
    fields.push({ label: "File", value: typeof e.name === "string" && e.name ? e.name : "(unnamed file)" });
    if (safeUrl(e.link)) fields.push({ label: "Link", value: e.link, href: safeUrl(e.link) });
    if (strs(e.owners).length) fields.push({ label: "Owner", value: strs(e.owners).join(", ") });
    fields.push({ label: "Change", value: lines.length + (lines.length === 1 ? " operation" : " operations, applied together in this order") });
    text = lines.map((l, i) => i + 1 + ". " + l).join("\n");
    go = lines.length === 1 ? "Apply the edit" : "Apply the edits";
    wait = e.moved
      ? "This file changed since the card was made — the operations above would now apply to it as it is. Apply them?"
      : "Waiting for approval — the file is not changed until someone approves it. Other people may have access to this file.";
    done = "Edits applied";
  } else if (d.file && typeof d.file === "object") {
    // An edit to a Drive file the cockpit did not create: which file, and
    // exactly what goes into it.
    const f = d.file;
    const op = FILE_OPS[f.op] || FILE_OPS["doc.append"];
    kind = "file";
    kindLabel = "Drive edit";
    title = op.head + " — " + account;
    fields.push({ label: "File", value: typeof f.name === "string" && f.name ? f.name : "(unnamed file)" });
    if (safeUrl(f.link)) fields.push({ label: "Link", value: f.link, href: safeUrl(f.link) });
    if (strs(f.owners).length) fields.push({ label: "Owner", value: strs(f.owners).join(", ") });
    const manage = FILE_MANAGE.includes(f.op);
    if (manage) {
      // Where it is and what it is called NOW, then exactly what happens to it.
      fields.push({ label: "In folder", value: f.parentName ? String(f.parentName) : f.parentId ? String(f.parentId) : "(none — shared with this account)" });
      if (f.op === "drive.move") fields.push({ label: "Moves to", value: (f.toName ? String(f.toName) : "") + (f.toId ? ` (${f.toId})` : "") });
      if (f.op === "drive.rename") fields.push({ label: "New name", value: typeof f.newName === "string" ? f.newName : "" });
    } else if (f.op !== "doc.append") fields.push({ label: "Range", value: f.range ? String(f.range) : "after the last row" });
    fields.push({ label: "Change", value: op.what });
    text = manage ? "" : f.op === "doc.append" ? (typeof f.text === "string" ? f.text : "") : rowsText(f.rows);
    go = op.go;
    wait = manage
      ? "Waiting for approval — the file stays as it is until someone approves it. Other people may have access to this file."
      : "Waiting for approval — the file is not changed until someone approves it. Other people may have access to this file.";
    done = op.done;
  } else {
    const e = d.event && typeof d.event === "object" ? d.event : {};
    const op = EVENT_OPS[e.op] || EVENT_OPS.create;
    kind = "event";
    kindLabel = "Calendar event";
    title = op.head + " — " + account;
    fields.push({ label: "Title", value: typeof e.title === "string" ? e.title : "" });
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    if (DAY.test(e.start) && DAY.test(e.end)) {
      // All day: Google's end date is the day AFTER the last one, so the card
      // names the last day itself rather than a day the event does not cover.
      const last = new Date(Date.parse(e.end + "T00:00:00Z") - DAY_MS).toISOString().slice(0, 10);
      fields.push({ label: "Starts", value: e.start + " (all day)" });
      fields.push({ label: "Ends", value: (last < e.start ? e.start : last) + " (all day, last day)" });
    } else {
      fields.push({ label: "Starts", value: eventWhen(e.start, e.timeZone) });
      fields.push({ label: "Ends", value: eventWhen(e.end, e.timeZone) });
    }
    const who = strs(e.attendees);
    if (who.length) fields.push({ label: "Attendees", value: who.join(", ") + " — Google will email them" });
    if (e.location) fields.push({ label: "Location", value: String(e.location) });
    if (e.calendarId && e.calendarId !== "primary") fields.push({ label: "Calendar", value: String(e.calendarId) });
    text = typeof e.description === "string" ? e.description : "";
    go = op.go;
    wait = "Waiting for approval — " + op.wait + ".";
    done = op.done;
  }
  let statusLine;
  if (pending) statusLine = wait;
  else if (status === "publishing") statusLine = kind === "mail" ? "Sending…" : "Applying…";
  else if (status === "published") statusLine = done + (link ? " — " + link : ".");
  else if (status === "discarded") statusLine = "Discarded by " + (d.decidedBy || "someone") + " — nothing left the account.";
  else if (status === "expired") statusLine = kind === "mail" ? "Expired — this email was never sent." : kind === "file" ? "Expired — the file was not changed." : "Expired — the calendar was not changed.";
  else if (status === "gone") statusLine = "This draft is no longer in Gmail — deleted there, or already sent from Gmail. The cockpit sent nothing.";
  else if (status === "failed") statusLine = d.error || "This could not be completed.";
  else statusLine = status;
  return {
    title,
    kind,
    kindLabel,
    fields,
    attachments,
    text,
    image: null,
    actions: pending ? [{ action: "publish", label: go }, { action: "discard", label: "Discard" }] : [],
    statusLine,
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
 * The sentence a person confirms before switching one of a Google account's
 * three settings to automatic. `setting` is `mail`, `calendar` or `drive`.
 */
export function googleAutonomousConfirmText(account, setting, groups) {
  const a = account || {};
  const who = a.label || "this account";
  const scope = scopeText(a.share, groups);
  if (setting === "drive") return `Agents in ${scope} will be able to edit, rename, move and bin files in ${who}'s Drive — files shared with other people included — without asking anyone.`;
  return setting === "calendar"
    ? `Agents in ${scope} will be able to add, change and delete events in ${who}'s calendar without asking anyone.`
    : `Agents in ${scope} will be able to send email as ${who} without asking anyone.`;
}

/** A Google account's approval settings as chip rows (`mail`, `calendar`, and
 *  `drive` once the account holds a Drive area — it governs nothing before). */
export function googlePolicyRows(account) {
  const p = (account && account.policies) || {};
  const row = (key, label, hint, ask, auto) => {
    const autonomous = p[key] === "autonomous";
    return {
      key,
      label,
      hint,
      choices: [
        { key: "approve", label: ask, checked: !autonomous },
        { key: "autonomous", label: auto, checked: autonomous },
      ],
    };
  };
  const held = Array.isArray(account && account.areas) ? account.areas.map(String) : [];
  const wholeDrive = held.includes("drive_all") || held.includes("drive");
  return [
    row("mail", "Mail", "Whether a person approves each email on a card in the chat", "Ask before sending", "Send on its own"),
    row("calendar", "Events", "Whether a person approves each event added, changed or deleted", "Ask before changing", "Change on its own"),
    ...(wholeDrive
      ? [row("drive", "Drive edits", "Whether a person approves each file moved to the bin, moved or renamed — and each edit to a file the cockpit did not create", "Ask before editing", "Edit on its own")]
      : []),
  ];
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
  const google = a.provider === "google";
  const deadline = accountDeadline(a);
  // A Google account with no known deadline (a published app) simply lasts.
  const left = deadline === null ? Infinity : deadline - now;
  const expired = a.status === "expired" || left <= 0;
  const tone = expired ? "expired" : left < (google ? GOOGLE_EXPIRY_SOON_MS : EXPIRY_SOON_MS) ? "soon" : "ok";
  const verb = google ? "reconnect in " : "expires in ";
  let expiryText;
  if (expired) expiryText = google ? "expired — reconnect to keep it working" : "expired — reconnect to keep posting";
  else if (left === Infinity) expiryText = "connected";
  else if (left >= 2 * DAY_MS) expiryText = verb + Math.round(left / DAY_MS) + " days";
  else if (left >= 2 * 60 * 60 * 1000) expiryText = verb + Math.round(left / 3_600_000) + " h";
  else expiryText = verb + Math.max(1, Math.round(left / 60_000)) + " min";
  const granted = Array.isArray(a.areas) ? a.areas.map(String) : [];
  const pol = a.policies || {};
  return {
    provider: google ? "google" : "linkedin",
    label: a.label || "(unnamed account)",
    via: (google ? "Google" : "LinkedIn") + (a.connectedVia ? " · connected by " + a.connectedVia : ""),
    expiryText,
    tone,
    shareText: "Shared with " + scopeText(a.share, groups),
    policyText: google
      ? `Mail: ${pol.mail === "autonomous" ? "automatic" : "with approval"} · Events: ${pol.calendar === "autonomous" ? "automatic" : "with approval"}` +
        (granted.includes("drive_all") || granted.includes("drive") ? ` · Drive edits: ${pol.drive === "autonomous" ? "automatic" : "with approval"}` : "")
      : a.policy === "autonomous" ? "Posts without approval" : "Every post needs approval",
    // Google: which areas the person granted (they may untick one on Google's
    // own screen), and — while the app is in Testing — the weekly deadline.
    // An opt-in area (reading mail) that was never asked for is not a missing
    // grant: it is simply absent, not struck out.
    areas: google
      ? GOOGLE_AREA_CHOICES.filter((c) => c.defaultOn !== false || granted.includes(c.key)).map((c) => ({ key: c.key, label: c.label, granted: granted.includes(c.key) || (c.key === "drive" && granted.includes("drive_all")) }))
      : [],
    testNote: google && deadline !== null ? "Test app — reconnect weekly" : "",
    shareHint: google ? "Whose agents may work in this account — any combination" : "Whose agents may post as this account — any combination",
    disconnectText: google ? "Agents will no longer be able to work in this account." : "Agents will no longer be able to post as this account.",
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
export function accountBannerKey(a) {
  // The DEADLINE, not `expiresAt`: a Google account's access token is renewed
  // every hour, and a dismissal must not come back with each renewal.
  return String(a && a.id) + ":" + String(accountDeadline(a));
}

export function accountBanners(accounts) {
  const out = [];
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (!a || typeof a !== "object") continue;
    const label = a.label || "(unnamed account)";
    const key = accountBannerKey(a);
    const name = a.provider === "google" ? "Google" : "LinkedIn";
    if (a.expired === true) {
      out.push({ key, text: `Your ${name} connection '${label}' has expired — reconnect it in Secrets → Connected accounts.` });
    } else if (a.expiringSoon === true) {
      out.push({ key, text: `Your ${name} connection '${label}' expires on ${isoDay(accountDeadline(a))} — reconnect it in Secrets → Connected accounts.` });
    }
  }
  return out;
}

/** One publication-log entry (GET /connected-accounts/:id/log) as one plain line. */
export function logEntryLine(e) {
  const x = e && typeof e === "object" ? e : {};
  const when = new Date(Number(x.at) || 0).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const who = x.channel ? `${x.channel} (${x.origin || "agent"})` : String(x.origin || "agent");
  const parts = [when, x.action ? String(x.action) : "", String(x.outcome || ""), who];
  if (x.approvedBy === "autonomous") parts.push("without approval");
  else if (x.approvedBy && x.approvedBy !== "none" && x.approvedBy !== "system") parts.push("approved by " + x.approvedBy);
  if ((x.outcome === "published" || x.outcome === "done") && x.postUrl) parts.push(String(x.postUrl));
  else if (x.error) parts.push(String(x.error));
  const text = typeof x.text === "string" ? x.text.replace(/\s+/g, " ").trim() : "";
  parts.push(text.length > 80 ? text.slice(0, 79) + "…" : text);
  return parts.filter(Boolean).join(" · ");
}
