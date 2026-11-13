// What an agent may do in a connected Google account, and under which
// approval setting. Each action declares a CLASS; the class — never the
// arguments — decides whether a setting applies and which one. Everything here
// takes its Google access through injected deps, so the whole table and the
// Gmail approval cycle are tested against a fake fetch. Design:
// docs/superpowers/specs/2026-11-13-connected-accounts-google-design.md §4.
import path from "node:path";
import { googlePolicies, grantedAreas, type AccountPolicy, type ConnectedAccount, type GoogleArea } from "./connected-accounts.js";
import type { Draft, DraftAction, DraftPayload, EventPayload, FilePayload, MailPayload } from "./social-drafts.js";
import {
  GoogleError,
  GoogleInputError,
  MAX_ATTACHMENTS_BYTES,
  MIME_DOC,
  MIME_SHEET,
  appendDoc,
  appendSheet,
  appendTextVerdict,
  getFileMeta,
  rangeOk,
  readDriveFile,
  rowsVerdict,
  searchDrive,
  updateRangeVerdict,
  updateSheet,
  type DriveFileMeta,
  attachmentName,
  buildMime,
  createDoc,
  createGmailDraft,
  createSheet,
  deleteEvent,
  deleteGmailDraft,
  eventFieldsVerdict,
  getEvent,
  getGmailDraft,
  insertEvent,
  listEvents,
  listFiles,
  mailFieldsVerdict,
  mailFingerprint,
  patchEvent,
  rawMessage,
  readDoc,
  readGmail,
  searchGmail,
  readSheet,
  sendGmailDraft,
  sendGmailMessage,
  updateGmailDraft,
  type EventFields,
  type EventView,
  type FetchFn,
  type MailAttachment,
  type MailContent,
} from "./google.js";

/**
 * - `read`: leaves nothing — never asks. Reading MAIL is a read too, but an
 *   audited one (`audit`): what was searched and which message was opened is
 *   logged — never a body or a snippet.
 * - `own-write`: changes only the person's own drafts and the files the
 *   cockpit created (Drive keeps history) — never asks.
 * - `file-write`: writes into an existing Drive file. One the cockpit created
 *   is an own-write. ANY OTHER file — reachable only with the whole-Drive area
 *   — may be shared with other people: the account's DRIVE setting.
 * - `mail`: sends email — the account's MAIL setting.
 * - `calendar`: creates, changes or deletes an event, with or without
 *   attendees — the account's CALENDAR setting.
 */
export type GoogleActionClass = "read" | "own-write" | "file-write" | "mail" | "calendar";

export const GOOGLE_ACTIONS = {
  "calendar.list": { class: "read", area: "calendar" },
  "drive.list": { class: "read", area: "drive" },
  "doc.read": { class: "read", area: "drive" },
  "sheet.read": { class: "read", area: "drive" },
  "gmail.search": { class: "read", area: "gmail_read", audit: true },
  "gmail.read": { class: "read", area: "gmail_read", audit: true },
  "drive.search": { class: "read", area: "drive_all", audit: true },
  "drive.read": { class: "read", area: "drive_all", audit: true },
  "gmail.draft": { class: "own-write", area: "gmail" },
  "doc.create": { class: "own-write", area: "drive" },
  "sheet.create": { class: "own-write", area: "drive" },
  "doc.append": { class: "file-write", area: "drive" },
  "sheet.append": { class: "file-write", area: "drive" },
  "sheet.update": { class: "file-write", area: "drive" },
  "gmail.send": { class: "mail", area: "gmail" },
  "calendar.create": { class: "calendar", area: "calendar" },
  "calendar.update": { class: "calendar", area: "calendar" },
  "calendar.delete": { class: "calendar", area: "calendar" },
} as const satisfies Record<string, { class: GoogleActionClass; area: GoogleArea; audit?: boolean }>;

/** Does this action go in the account's log? Everything but a plain read. */
export function actionLogged(action: GoogleAction): boolean {
  const a: { class: GoogleActionClass; audit?: boolean } = GOOGLE_ACTIONS[action];
  return a.class !== "read" || a.audit === true;
}

export type GoogleAction = keyof typeof GOOGLE_ACTIONS;
export const isGoogleAction = (v: unknown): v is GoogleAction => typeof v === "string" && Object.hasOwn(GOOGLE_ACTIONS, v);

/** The setting that governs this action on this account, or null when none
 *  does (a read, an own-write). Each setting governs only its own class.
 *  `foreign`: the file written to is not one the cockpit created
 *  (`foreignFile`) — the only case where a `file-write` has a setting. */
export function actionSetting(account: Pick<ConnectedAccount, "policies">, action: GoogleAction, foreign = false): AccountPolicy | null {
  const p = googlePolicies(account);
  const c: GoogleActionClass = GOOGLE_ACTIONS[action].class;
  return c === "mail" ? p.mail : c === "calendar" ? p.calendar : c === "file-write" && foreign ? p.drive : null;
}

const AREA_LABEL: Record<GoogleArea, string> = { calendar: "Calendar", drive: "Drive files", gmail: "Gmail", gmail_read: "Read Gmail", drive_all: "All of Drive" };

/** Does the account hold this area? The whole Drive includes the cockpit's own files. */
export function areaHeld(account: Pick<ConnectedAccount, "scopes">, area: GoogleArea): boolean {
  const g = grantedAreas(account);
  return g.includes(area) || (area === "drive" && g.includes("drive_all"));
}

/**
 * Is `fileId` a file the cockpit did NOT create for this account? Only an
 * account holding the whole Drive can reach one: with `drive.file` alone
 * Google itself shows nothing but the cockpit's files, so nothing is foreign.
 * Decided by the record of created ids — a file created before the record
 * existed counts as foreign once the whole Drive is granted (it asks; it never
 * writes unasked).
 */
export function foreignFile(account: Pick<ConnectedAccount, "scopes" | "id">, own: Pick<GoogleDeps["ownFiles"], "has">, fileId: string): boolean {
  return grantedAreas(account).includes("drive_all") && !own.has(account.id, fileId);
}

/** Does this request write into a file the cockpit did not create? */
export function writesForeignFile(account: Pick<ConnectedAccount, "scopes" | "id">, own: Pick<GoogleDeps["ownFiles"], "has">, action: GoogleAction, args: Record<string, unknown>): boolean {
  const c: GoogleActionClass = GOOGLE_ACTIONS[action].class;
  return c === "file-write" && foreignFile(account, own, String(args.id ?? ""));
}

/** What no agent may do in a Drive, whatever the account allows: asked for by
 *  name, it gets this sentence rather than "unknown action". */
const REFUSED = /^(drive|doc|sheet|file)\.(delete|trash|remove|move|rename|share|unshare|permission|permissions|download|copy|replace)$/;
export const DRIVE_REFUSED_SENTENCE =
  "Not available to agents: deleting or binning a Drive file, moving or renaming it, changing who it is shared with, replacing its content, and downloading it. An agent can search, read, and add to a file — the rest is for the person to do in Drive.";

/** Is this an action we know, on an area Google GRANTED to this account? */
export function actionVerdict(
  account: Pick<ConnectedAccount, "scopes" | "label" | "owner">,
  action: unknown,
): { ok: true; action: GoogleAction } | { ok: false; status: number; reason: string } {
  if (typeof action === "string" && REFUSED.test(action)) return { ok: false, status: 403, reason: DRIVE_REFUSED_SENTENCE };
  if (!isGoogleAction(action)) return { ok: false, status: 400, reason: `Unknown Google action '${String(action).slice(0, 40)}'.` };
  const area = GOOGLE_ACTIONS[action].area;
  if (!areaHeld(account, area)) {
    return {
      ok: false,
      status: 403,
      reason: `Google account '${account.label}' was connected without ${AREA_LABEL[area]} access — ${account.owner} can reconnect it and tick ${AREA_LABEL[area]} in Secrets → Connected accounts.`,
    };
  }
  return { ok: true, action };
}

export interface GoogleDeps {
  fetchFn: FetchFn;
  /** The account's access token, refreshed when needed (`GoogleTokens.accessToken`). */
  token: (accountId: string) => Promise<string>;
  /** Read a file with the AGENT's rights (invariant 60) — an attachment. */
  readFile: (absPath: string) => Promise<Buffer>;
  now: () => number;
  /** The Gmail draft ids that are waiting on an approval card for this account. */
  pendingGmailDrafts: (accountId: string) => ReadonlySet<string>;
  /** The Gmail drafts `gmail.draft` created for an account — the only ones it may rewrite. */
  ownGmailDrafts: { has: (accountId: string, draftId: string) => boolean; add: (accountId: string, draftId: string) => void };
  /** The Drive files `doc create` / `sheet create` made for an account,
   *  oldest first — what tells the cockpit's own files from the rest of a Drive. */
  ownFiles: { has: (accountId: string, fileId: string) => boolean; add: (accountId: string, fileId: string) => void; list: (accountId: string) => readonly string[] };
}

export type ActionOutcome =
  /** Done at once. `log` is absent for a plain read (it leaves nothing). */
  | { kind: "result"; result: Record<string, unknown>; log?: { summary: string; link?: string } }
  /** Waiting for a person: the route stores a draft and shows a card. */
  | { kind: "pending"; action: DraftAction; payload: DraftPayload; summary: string };

const list = (l: readonly string[]) => l.join(", ");

export function mailSummary(m: Pick<MailContent, "to" | "cc" | "bcc" | "subject">): string {
  const who = [m.to.length ? `to ${list(m.to)}` : "", m.cc.length ? `cc ${list(m.cc)}` : "", m.bcc.length ? `bcc ${list(m.bcc)}` : ""].filter(Boolean).join("; ");
  return `${who} — "${m.subject}"`;
}

export function eventSummary(op: EventPayload["op"], e: Pick<EventFields, "title" | "start" | "end" | "timeZone">): string {
  // The zone is named only for a wall-clock time; one with an offset says its own.
  const zone = e.timeZone && !/(Z|[+-]\d{2}:\d{2})$/.test(e.start) ? ` (${e.timeZone})` : "";
  return `${op} "${e.title}" ${e.start} → ${e.end}${zone}`;
}

export function fileEditSummary(p: Pick<FilePayload, "op" | "name" | "fileId" | "text" | "range" | "rows">): string {
  const where = `"${p.name}" (${p.fileId})`;
  if (p.op === "doc.append") return `append ${[...(p.text ?? "")].length} characters to ${where}`;
  const n = p.rows?.length ?? 0;
  const rows = `${n} row${n === 1 ? "" : "s"}`;
  return p.op === "sheet.update" ? `overwrite ${p.range ?? ""} of ${where} with ${rows}` : `append ${rows} to ${where}${p.range ? ` at ${p.range}` : ""}`;
}

export const FILE_GONE_SENTENCE = "That file is no longer in the Drive (deleted, binned, or no longer shared with this account) — nothing was changed.";

const ATTACH_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The attachments, read ONCE, now, with the agent's rights: these bytes are
 *  what is sent or what goes into the Gmail draft a person approves — the
 *  agent's file is never read again (the snapshot rule). */
async function readAttachments(deps: GoogleDeps, raw: unknown): Promise<MailAttachment[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) throw new GoogleInputError("attachments must be a list of absolute file paths.");
  const out: MailAttachment[] = [];
  let total = 0;
  for (const p of raw as string[]) {
    if (!path.isAbsolute(p)) throw new GoogleInputError(`An attachment must be an absolute path, not '${p.slice(0, 120)}'.`);
    const name = attachmentName(p);
    let bytes: Buffer;
    try {
      bytes = await deps.readFile(p);
    } catch {
      throw new GoogleInputError(`The attachment '${p.slice(0, 120)}' is not a file this agent can read.`);
    }
    total += bytes.length;
    if (total > MAX_ATTACHMENTS_BYTES) throw new GoogleInputError(`The attachments are over ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)} MB in total.`);
    out.push({ name, mime: ATTACH_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream", bytes });
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const calendarOf = (args: Record<string, unknown>) => str(args.calendar) ?? "primary";

function eventPayload(op: EventPayload["op"], calendarId: string, e: Partial<EventView> & Pick<EventFields, "title" | "start" | "end">, extra: Partial<EventPayload> = {}): EventPayload {
  return {
    kind: "event",
    op,
    calendarId,
    title: e.title,
    start: e.start,
    end: e.end,
    ...(e.timeZone ? { timeZone: e.timeZone } : {}),
    attendees: [...(e.attendees ?? [])],
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...extra,
  };
}

/**
 * Carry out `action` for an agent, or prepare it for a person's approval.
 * The caller has already checked the account (visible, alive) and the action
 * (`actionVerdict`). Throws `GoogleInputError` / `GoogleError` /
 * `GoogleOutcomeUnknownError`; `failureOutcome` turns them into sentences.
 */
/** Read any file as text (`readDriveFile`): audited by id and name — never by
 *  content — and marked untrusted, since anyone may have written it. */
async function driveRead(deps: GoogleDeps, account: ConnectedAccount, args: Record<string, unknown>): Promise<ActionOutcome> {
  const r = await readDriveFile(await deps.token(account.id), { id: args.id, range: args.range }, deps.fetchFn);
  if (!r) throw new GoogleInputError(`No file '${String(args.id ?? "").slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
  return { kind: "result", result: { ...r, untrusted: true }, log: { summary: `file ${r.file.id} — "${r.file.name.slice(0, 200)}"`, ...(r.file.link ? { link: r.file.link } : {}) } };
}

/** The write a `file-write` action stands for, with its input checked. */
function fileEdit(action: "doc.append" | "sheet.append" | "sheet.update", args: Record<string, unknown>): Pick<FilePayload, "op" | "text" | "range" | "rows"> {
  if (action === "doc.append") return { op: action, text: appendTextVerdict(args.text) };
  const rows = rowsVerdict(args.rows);
  if (action === "sheet.update") return { op: action, range: updateRangeVerdict(args.range), rows };
  const given = args.range === undefined || args.range === null || args.range === "";
  return { op: action, ...(given ? {} : { range: rangeOk(args.range) }), rows };
}

async function applyFileEdit(token: string, fileId: string, e: Pick<FilePayload, "op" | "text" | "range" | "rows">, f: FetchFn, outbound: boolean): Promise<{ updatedRange?: string }> {
  if (e.op === "doc.append") {
    await appendDoc(token, fileId, e.text, f, outbound);
    return {};
  }
  return e.op === "sheet.update" ? updateSheet(token, fileId, e.range, e.rows, f, outbound) : appendSheet(token, fileId, e.range, e.rows, f, outbound);
}

export async function runGoogleAction(deps: GoogleDeps, account: ConnectedAccount, action: GoogleAction, args: Record<string, unknown>): Promise<ActionOutcome> {
  const f = deps.fetchFn;
  const foreign = writesForeignFile(account, deps.ownFiles, action, args);
  const setting = actionSetting(account, action, foreign);
  const wholeDrive = grantedAreas(account).includes("drive_all");
  // Input is checked BEFORE a token is fetched: a refused request costs nothing.
  switch (action) {
    case "calendar.list": {
      const token = await deps.token(account.id);
      const events = await listEvents(token, { calendarId: calendarOf(args), from: args.from ?? undefined, to: args.to ?? undefined, max: typeof args.max === "number" ? args.max : undefined }, f, deps.now());
      return { kind: "result", result: { events } };
    }
    case "drive.list": {
      const token = await deps.token(account.id);
      const max = typeof args.max === "number" ? args.max : undefined;
      // `drive list` is the cockpit's OWN files. With `drive.file` Google
      // returns nothing else; with the whole Drive it would return everything,
      // so the list is rebuilt from the record of created ids instead.
      if (!wholeDrive) return { kind: "result", result: { files: await listFiles(token, { max }, f) } };
      const ids = [...deps.ownFiles.list(account.id)].reverse().slice(0, Math.min(Math.max(Math.trunc(max ?? 50) || 50, 1), 200));
      const files: DriveFileMeta[] = [];
      for (let i = 0; i < ids.length; i += 10) {
        const batch = await Promise.all(ids.slice(i, i + 10).map((id) => getFileMeta(token, id, f).catch(() => null)));
        files.push(...batch.filter((m): m is DriveFileMeta => m !== null));
      }
      return { kind: "result", result: { files } };
    }
    case "doc.read":
      // Someone else's document is read like any Drive file: audited, untrusted.
      if (foreignFile(account, deps.ownFiles, String(args.id ?? ""))) return driveRead(deps, account, args);
      return { kind: "result", result: await readDoc(await deps.token(account.id), String(args.id ?? ""), f) };
    case "sheet.read":
      if (foreignFile(account, deps.ownFiles, String(args.id ?? ""))) return driveRead(deps, account, args);
      return { kind: "result", result: await readSheet(await deps.token(account.id), String(args.id ?? ""), args.range, f) };
    case "drive.read":
      return driveRead(deps, account, args);
    case "drive.search": {
      const r = await searchDrive(await deps.token(account.id), { query: args.query, max: args.max, pageToken: args.pageToken }, f);
      // Audited: the query and how many came back — never a file name.
      return { kind: "result", result: { ...r, untrusted: true }, log: { summary: `search ${JSON.stringify(r.query)} — ${r.files.length} result${r.files.length === 1 ? "" : "s"}` } };
    }
    case "gmail.search": {
      const r = await searchGmail(await deps.token(account.id), { query: args.query, max: args.max, pageToken: args.pageToken }, f);
      // Audited: the query and how many came back — never a subject or a snippet.
      return { kind: "result", result: { ...r, untrusted: true }, log: { summary: `search ${JSON.stringify(r.query)} — ${r.messages.length} result${r.messages.length === 1 ? "" : "s"}` } };
    }
    case "gmail.read": {
      const r = await readGmail(await deps.token(account.id), { id: args.id, threadId: args.threadId }, f);
      const first = r.messages[0];
      const what = typeof args.threadId === "string" && args.threadId ? `thread ${args.threadId} (${r.messages.length + r.omitted} messages)` : `message ${first?.id ?? ""}`;
      // Audited: which message, by id and subject — never its body.
      return { kind: "result", result: { ...r, untrusted: true }, log: { summary: `${what} — "${(first?.subject ?? "").slice(0, 200)}"` } };
    }
    case "doc.create": {
      const token = await deps.token(account.id);
      const doc = await createDoc(token, args.title, f);
      // Recorded BEFORE anything else: an unrecorded file is treated as
      // someone else's on an account that holds the whole Drive.
      deps.ownFiles.add(account.id, doc.id);
      if (typeof args.text === "string" && args.text) await appendDoc(token, doc.id, args.text, f);
      return { kind: "result", result: doc, log: { summary: `document "${doc.name}" (${doc.id})`, link: doc.link } };
    }
    case "sheet.create": {
      const sheet = await createSheet(await deps.token(account.id), args.title, f);
      deps.ownFiles.add(account.id, sheet.id);
      return { kind: "result", result: sheet, log: { summary: `spreadsheet "${sheet.name}" (${sheet.id})`, link: sheet.link } };
    }
    case "doc.append":
    case "sheet.append":
    case "sheet.update": {
      const id = String(args.id ?? "");
      const edit = fileEdit(action, args);
      const token = await deps.token(account.id);
      if (!foreign) {
        // One of the cockpit's own files: done at once, as before.
        const r = await applyFileEdit(token, id, edit, f, false);
        const what = action === "doc.append" ? `document ${id}` : `spreadsheet ${id}${r.updatedRange ? ` ${r.updatedRange}` : ""}`;
        return { kind: "result", result: action === "doc.append" ? { id, appended: true } : { id, ...r }, log: { summary: what } };
      }
      // Someone's file — possibly one other people read. The card must name
      // it, so it is looked up now; that also refuses the wrong kind of file
      // before a person is asked anything.
      const meta = await getFileMeta(token, id, f);
      if (!meta) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      const want = action === "doc.append" ? MIME_DOC : MIME_SHEET;
      if (meta.mimeType !== want) throw new GoogleInputError(`"${meta.name.slice(0, 120)}" is not a Google ${action === "doc.append" ? "Doc" : "Sheet"}, so \`${action.replace(".", " ")}\` cannot write to it.`);
      const payload: FilePayload = { kind: "file", ...edit, fileId: meta.id, name: meta.name, ...(meta.link ? { link: meta.link } : {}), owners: meta.owners };
      const summary = fileEditSummary(payload);
      if (setting === "autonomous") {
        const r = await applyFileEdit(token, id, edit, f, true);
        return { kind: "result", result: { id, status: "applied", ...r }, log: { summary, ...(meta.link ? { link: meta.link } : {}) } };
      }
      return { kind: "pending", action, payload, summary };
    }
    case "gmail.draft":
    case "gmail.send": {
      const fields = mailFieldsVerdict(args);
      const replace = action === "gmail.draft" ? str(args.update) : undefined;
      // A draft waiting on an approval card is what a person is about to send:
      // the agent may not rewrite it under them. Only a new `send` makes a new card.
      if (replace && deps.pendingGmailDrafts(account.id).has(replace)) {
        throw new GoogleInputError("That Gmail draft is waiting for approval in the cockpit — it cannot be changed. Ask the person to discard its card, or send a new one.");
      }
      // …and only a draft `gmail draft` made here: `drafts.update` would
      // otherwise rewrite ANY draft of the mailbox — one the person is
      // writing themselves included.
      if (replace && !deps.ownGmailDrafts.has(account.id, replace)) {
        throw new GoogleInputError("That Gmail draft was not created by this cockpit for this account, so it cannot be rewritten — make a new one with `gmail draft`.");
      }
      const attachments = await readAttachments(deps, args.attachments);
      const names = attachments.map((a) => a.name);
      const raw = rawMessage(buildMime(fields, attachments));
      const summary = mailSummary(fields);
      const token = await deps.token(account.id);
      if (action === "gmail.draft") {
        const d = replace ? await updateGmailDraft(token, replace, raw, f) : await createGmailDraft(token, raw, f);
        if (!replace) deps.ownGmailDrafts.add(account.id, d.id);
        return { kind: "result", result: { draftId: d.id, status: "draft" }, log: { summary: `draft ${summary}` } };
      }
      if (setting === "autonomous") {
        const sent = await sendGmailMessage(token, raw, f);
        return { kind: "result", result: { status: "sent", messageId: sent.id }, log: { summary } };
      }
      // With approval, the Gmail draft IS the draft: the person may open Gmail
      // and edit it; the card's fingerprint is what Send compares against.
      const d = await createGmailDraft(token, raw, f);
      const content: MailContent = { ...fields, attachments: names };
      const payload: MailPayload = { kind: "mail", from: account.label, ...content, gmailDraftId: d.id, fingerprint: mailFingerprint(content) };
      return { kind: "pending", action: "gmail.send", payload, summary };
    }
    case "calendar.create": {
      const fields = eventFieldsVerdict(args) as EventFields;
      const calendarId = calendarOf(args);
      if (setting === "autonomous") {
        const e = await insertEvent(await deps.token(account.id), calendarId, fields, f);
        return { kind: "result", result: { status: "created", event: e }, log: { summary: eventSummary("create", fields), link: e.link } };
      }
      return { kind: "pending", action: "calendar.create", payload: eventPayload("create", calendarId, fields), summary: eventSummary("create", fields) };
    }
    case "calendar.update":
    case "calendar.delete": {
      const calendarId = calendarOf(args);
      const eventId = String(args.event ?? "");
      const patch = action === "calendar.update" ? eventFieldsVerdict(args, true) : null;
      const token = await deps.token(account.id);
      // The event as it is now: what the card shows for a delete, and what an
      // update is merged over so the card shows the event as it WILL be.
      const current = await getEvent(token, calendarId, eventId, f);
      if (!current) throw new GoogleInputError(`No event '${eventId.slice(0, 60)}' in that calendar. Run \`calendar list\` to find its id.`);
      if (action === "calendar.delete") {
        const summary = eventSummary("delete", current);
        if (setting === "autonomous") {
          await deleteEvent(token, calendarId, eventId, f);
          return { kind: "result", result: { status: "deleted", event: eventId }, log: { summary } };
        }
        return { kind: "pending", action: "calendar.delete", payload: eventPayload("delete", calendarId, current, { eventId }), summary };
      }
      const next = { ...current, ...patch } as EventView;
      const summary = eventSummary("update", next);
      if (setting === "autonomous") {
        const e = await patchEvent(token, calendarId, eventId, patch as Partial<EventFields>, f);
        return { kind: "result", result: { status: "updated", event: e }, log: { summary, link: e.link } };
      }
      return { kind: "pending", action: "calendar.update", payload: eventPayload("update", calendarId, next, { eventId, patch: patch as Record<string, unknown> }), summary };
    }
  }
}

export type ApprovalOutcome =
  | { kind: "done"; link?: string }
  /** Nothing was attempted — the token could not be renewed, or Gmail could not
   *  be read — so nothing left the account: the card stays, to be clicked again. */
  | { kind: "retry"; reason: string }
  /** The Gmail draft is not what the card showed: the card is refreshed and asks again. */
  | { kind: "changed"; payload: MailPayload; summary: string }
  /** The Gmail draft is no longer there — deleted in Gmail, or sent from
   *  Gmail by the person: the two are not told apart. Nothing left to send. */
  | { kind: "gone" };

export const RETRY_SENTENCE = "Google could not be reached, so nothing was sent or changed — try again in a moment.";

/** A failure BEFORE the outbound call that a second click may well get past
 *  (an outage at the broker or at Google). A dead grant, a disconnected
 *  account or a refusal of the request itself is not one. */
function retryable(e: unknown): boolean {
  if (e instanceof GoogleInputError) return false;
  if (e instanceof GoogleError) return !e.expired && e.status >= 500;
  return true;
}

/**
 * A person clicked Send / Apply on a Google card. For an email the Gmail draft
 * is re-read first and compared with what the card showed: unchanged → sent;
 * changed in Gmail → NOT sent, the new content comes back so the card shows it
 * and asks again (a person always sends what they are looking at, invariant
 * 43); deleted → gone. A calendar change is applied as the card showed it.
 */
export async function approveGoogleDraft(deps: GoogleDeps, account: ConnectedAccount, draft: Pick<Draft, "payload">): Promise<ApprovalOutcome> {
  const p = draft.payload;
  if (!p) throw new GoogleInputError("This draft has nothing to send.");
  // Everything up to the outbound call leaves the account untouched, so a
  // passing failure there must not kill the card (the hourly token renewal
  // alone makes one likely): it comes back as `retry`.
  let token: string;
  let now: MailContent | null = null;
  let file: DriveFileMeta | null = null;
  try {
    token = await deps.token(account.id);
    if (p.kind === "mail") now = await getGmailDraft(token, p.gmailDraftId, deps.fetchFn);
    // A Drive edit: is the file still there? Days may have passed since the card.
    if (p.kind === "file") file = await getFileMeta(token, p.fileId, deps.fetchFn);
  } catch (e) {
    if (retryable(e)) return { kind: "retry", reason: RETRY_SENTENCE };
    throw e;
  }
  if (p.kind === "file") {
    if (!file) throw new GoogleInputError(FILE_GONE_SENTENCE);
    await applyFileEdit(token, p.fileId, p, deps.fetchFn, true);
    const link = file.link ?? p.link;
    return { kind: "done", ...(link ? { link } : {}) };
  }
  if (p.kind === "mail") {
    if (!now) return { kind: "gone" };
    const fingerprint = mailFingerprint(now);
    if (fingerprint !== p.fingerprint) {
      return { kind: "changed", payload: { ...p, ...now, fingerprint, edited: true }, summary: mailSummary(now) };
    }
    await sendGmailDraft(token, p.gmailDraftId, deps.fetchFn);
    return { kind: "done" };
  }
  if (p.op === "create") {
    const e = await insertEvent(token, p.calendarId, p, deps.fetchFn);
    return { kind: "done", ...(e.link ? { link: e.link } : {}) };
  }
  if (p.op === "update") {
    const e = await patchEvent(token, p.calendarId, p.eventId ?? "", (p.patch ?? {}) as Partial<EventFields>, deps.fetchFn);
    return { kind: "done", ...(e.link ? { link: e.link } : {}) };
  }
  await deleteEvent(token, p.calendarId, p.eventId ?? "", deps.fetchFn);
  return { kind: "done" };
}

/** Discard on an email card deletes the Gmail draft too. Best effort: a draft
 *  that outlives its card is a stray draft in the person's own Gmail. True
 *  when there is nothing left behind. */
export async function discardGoogleDraft(deps: GoogleDeps, account: ConnectedAccount, draft: Pick<Draft, "payload">): Promise<boolean> {
  const p = draft.payload;
  if (!p || p.kind !== "mail") return true;
  try {
    return await deleteGmailDraft(await deps.token(account.id), p.gmailDraftId, deps.fetchFn);
  } catch {
    return false;
  }
}

/** The Gmail draft ids behind this account's undecided email cards. */
export function pendingGmailDraftIds(drafts: readonly Draft[], accountId: string): Set<string> {
  const out = new Set<string>();
  for (const d of drafts) {
    if (d.accountId === accountId && (d.status === "pending" || d.status === "publishing") && d.payload?.kind === "mail") out.add(d.payload.gmailDraftId);
  }
  return out;
}
