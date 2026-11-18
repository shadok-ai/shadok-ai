// What an agent may do in a connected Google account, and under which
// approval setting. Each action declares a CLASS; the class — never the
// arguments — decides whether a setting applies and which one. Everything here
// takes its Google access through injected deps, so the whole table and the
// Gmail approval cycle are tested against a fake fetch. Design:
// docs/superpowers/specs/2026-11-13-connected-accounts-google-design.md §4.
import path from "node:path";
import { googlePolicies, grantedAreas, type AccountPolicy, type ConnectedAccount, type GoogleArea } from "./connected-accounts.js";
import type { Draft, DraftAction, DraftPayload, EditPayload, EventPayload, FilePayload, MailPayload } from "./social-drafts.js";
import { passthroughGet, passthroughPlan } from "./google-passthrough.js";
import { annotateOps, buildEditRequests, docHeadings, docState, docTables, editOpCounts, editOpsVerdict, editPlan, sheetState, slidesState, translateEditError, type EditApp, type EditOp, type EditState, type SlidesCreated } from "./google-edits.js";
import {
  GoogleError,
  GoogleInputError,
  attendeeChangeVerdict,
  attachmentPickVerdict,
  forwardBody,
  forwardSource,
  forwardSubject,
  freeBusyIdsVerdict,
  freeBusyQuery,
  freeOptionsVerdict,
  freeSlots,
  getMailAttachment,
  listGmailLabels,
  mailTargetVerdict,
  modifyGmail,
  ownAddresses,
  ownBusy,
  recipientsVerdict,
  replyAllRecipients,
  resolveLabels,
  respondEvent,
  rsvpVerdict,
  trashGmail,
  zonedIso,
  addrSpecs,
  type EventPatch,
  type MailFields,
  type MailTarget,
  MAX_ATTACHMENTS_BYTES,
  MIME_DOC,
  MIME_SHEET,
  appendDoc,
  appendSheet,
  appendTextVerdict,
  createPresentation,
  downloadDriveFile,
  getEditSource,
  MAX_FILE_CHARS,
  MIME_SLIDES,
  sendEditBatch,
  truncateBody,
  fileNameVerdict,
  getFileMeta,
  MIME_FOLDER,
  MAX_UPLOAD_BYTES,
  convertVerdict,
  createFolder,
  fileIdVerdict,
  folderTargetVerdict,
  getComment,
  getFileState,
  listAccess,
  listComments,
  replyTextVerdict,
  replyToComment,
  restoreFile,
  uploadFile,
  uploadMime,
  type DriveFileState,
  copyFile,
  moveFile,
  renameFile,
  trashFile,
  rangeOk,
  readDriveFile,
  rowsVerdict,
  searchDrive,
  updateRangeVerdict,
  updateSheet,
  type DriveFileMeta,
  attachmentName,
  buildMime,
  gmailSignature,
  mailPlainBody,
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
  readGmail,
  replyTarget,
  searchGmail,
  readSheet,
  formulasFlag,
  getSlideThumbnail,
  THUMBNAIL_SIZES,
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
 * - `file-manage`: moves a file to the bin, out of it, into another folder,
 *   renames it, or replies to / resolves one of its comments. ALWAYS the
 *   account's DRIVE setting, the cockpit's own files included: a file that
 *   vanishes, comes back or changes place is felt by whoever uses it, and a
 *   reply is read by everyone who sees the file's comments.
 * - `file-copy`: makes a copy of a file (`drive.copy`). Nothing existing
 *   changes, so a copy left BESIDE the original (same folder, same audience)
 *   never asks; one put in ANOTHER folder lands in front of whoever that folder
 *   is shared with — the account's DRIVE setting. The copy becomes the
 *   cockpit's own file (`ownFiles`, edited without asking) only when nobody
 *   else can see it (`copyIsPrivate`); a copy in a shared folder stays foreign,
 *   so its edits follow the DRIVE setting like anything in a shared folder.
 *   An UPLOAD of a local file and a new FOLDER are the same shape: nothing
 *   existing changes, so at the top of the Drive or in a folder only the
 *   person can see they never ask; in a folder others can see, the DRIVE
 *   setting. Own (`ownFiles`) only when private, by the same rule.
 * - `mailbox`: triage of the person's OWN mailbox (`gmail_modify`): archive,
 *   read/unread, star, labels, the bin. Never asks, always logged: it changes
 *   how the person's own mail is filed and nothing anyone else sees — no mail
 *   leaves, no sender is told, and every move is undone from Gmail (the bin
 *   keeps a message 30 days; nothing deletes for good). An approval card for
 *   "mark as read" would train the person to click through cards — the very
 *   habit the cards that DO reach other people depend on not forming.
 * - `mail`: sends email (a forward too) — the account's MAIL setting.
 * - `calendar`: creates, changes or deletes an event, with or without
 *   attendees — the account's CALENDAR setting.
 */
export type GoogleActionClass = "read" | "own-write" | "file-write" | "file-manage" | "file-copy" | "mailbox" | "mail" | "calendar";

export const GOOGLE_ACTIONS = {
  "calendar.list": { class: "read", area: "calendar" },
  "drive.list": { class: "read", area: "drive" },
  "doc.read": { class: "read", area: "drive" },
  "sheet.read": { class: "read", area: "drive" },
  "gmail.search": { class: "read", area: "gmail_read", audit: true },
  "gmail.read": { class: "read", area: "gmail_read", audit: true },
  "gmail.attachment": { class: "read", area: "gmail_read", audit: true },
  "gmail.labels": { class: "read", area: "gmail_read" },
  "gmail.archive": { class: "mailbox", area: "gmail_modify" },
  "gmail.mark": { class: "mailbox", area: "gmail_modify" },
  "gmail.star": { class: "mailbox", area: "gmail_modify" },
  "gmail.label": { class: "mailbox", area: "gmail_modify" },
  "gmail.trash": { class: "mailbox", area: "gmail_modify" },
  "drive.search": { class: "read", area: "drive_all", audit: true },
  "drive.read": { class: "read", area: "drive_all", audit: true },
  "drive.download": { class: "read", area: "drive", audit: true },
  "drive.delete": { class: "file-manage", area: "drive" },
  "drive.move": { class: "file-manage", area: "drive" },
  "drive.rename": { class: "file-manage", area: "drive" },
  "drive.copy": { class: "file-copy", area: "drive" },
  "drive.upload": { class: "file-copy", area: "drive" },
  "drive.mkdir": { class: "file-copy", area: "drive" },
  "drive.untrash": { class: "file-manage", area: "drive" },
  "drive.comments": { class: "read", area: "drive", audit: true },
  "drive.reply": { class: "file-manage", area: "drive" },
  "drive.access": { class: "read", area: "drive", audit: true },
  // The read-only passthrough: its area depends on the URL, checked per call
  // (`passthroughPlan`) before any token is fetched.
  "api.get": { class: "read", area: "url", audit: true },
  "gmail.draft": { class: "own-write", area: "gmail" },
  "slides.read": { class: "read", area: "drive" },
  "slides.thumbnail": { class: "read", area: "drive" },
  "slides.create": { class: "own-write", area: "drive" },
  "slides.edit": { class: "file-write", area: "drive" },
  "doc.edit": { class: "file-write", area: "drive" },
  "sheet.edit": { class: "file-write", area: "drive" },
  "doc.create": { class: "own-write", area: "drive" },
  "sheet.create": { class: "own-write", area: "drive" },
  "doc.append": { class: "file-write", area: "drive" },
  "sheet.append": { class: "file-write", area: "drive" },
  "sheet.update": { class: "file-write", area: "drive" },
  "gmail.send": { class: "mail", area: "gmail" },
  "gmail.forward": { class: "mail", area: "gmail" },
  "calendar.create": { class: "calendar", area: "calendar" },
  "calendar.update": { class: "calendar", area: "calendar" },
  "calendar.delete": { class: "calendar", area: "calendar" },
  "calendar.respond": { class: "calendar", area: "calendar" },
  "calendar.free": { class: "read", area: "calendar" },
} as const satisfies Record<string, { class: GoogleActionClass; area: GoogleArea | "url"; audit?: boolean }>;

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
  // A copy's setting applies only when it leaves the original's folder —
  // decided in `runGoogleAction`, which knows where the original is.
  return c === "mail" ? p.mail : c === "calendar" ? p.calendar : c === "file-manage" || c === "file-copy" || (c === "file-write" && foreign) ? p.drive : null;
}

const AREA_LABEL: Record<GoogleArea, string> = {
  calendar: "Calendar",
  drive: "Drive files",
  gmail: "Gmail",
  gmail_read: "Read Gmail",
  drive_all: "All of Drive",
  gmail_modify: "Triage Gmail",
  calendar_freebusy: "Others' free/busy",
};

/** Does the account hold this area? The whole Drive includes the cockpit's
 *  own files; triaging Gmail (gmail.modify) includes reading it — Google's
 *  own consent screen says "view and modify", and the token can read. */
export function areaHeld(account: Pick<ConnectedAccount, "scopes">, area: GoogleArea): boolean {
  const g = grantedAreas(account);
  return g.includes(area) || (area === "drive" && g.includes("drive_all")) || (area === "gmail_read" && g.includes("gmail_modify"));
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
const REFUSED = /^(drive|doc|sheet|file)\.(share|unshare|permission|permissions|purge|destroy|erase|emptytrash|empty-trash)$/;
export const DRIVE_REFUSED_SENTENCE =
  "Not available to agents: changing who a Drive file is shared with, and deleting one for good or emptying the bin. `drive delete` moves a file to the bin, where the person can restore it — the rest is for the person to do in Drive.";

/** The mail twin: nothing deletes mail for good, whatever the account holds. */
const MAIL_REFUSED = /^gmail\.(delete|purge|destroy|erase|batchdelete|emptytrash|empty-trash|spam|filter|filters|forwarding|settings)$/;
export const MAIL_REFUSED_SENTENCE =
  "Not available to agents: deleting mail for good, reporting spam, and changing Gmail's settings (filters, forwarding). `gmail trash` moves a message to the bin, where the person can restore it for 30 days — the rest is for the person to do in Gmail.";

/** Is this an action we know, on an area Google GRANTED to this account? */
export function actionVerdict(
  account: Pick<ConnectedAccount, "scopes" | "label" | "owner">,
  action: unknown,
): { ok: true; action: GoogleAction } | { ok: false; status: number; reason: string } {
  if (typeof action === "string" && REFUSED.test(action)) return { ok: false, status: 403, reason: DRIVE_REFUSED_SENTENCE };
  if (typeof action === "string" && MAIL_REFUSED.test(action)) return { ok: false, status: 403, reason: MAIL_REFUSED_SENTENCE };
  if (!isGoogleAction(action)) return { ok: false, status: 400, reason: `Unknown Google action '${String(action).slice(0, 40)}'.` };
  const area: GoogleArea | "url" = GOOGLE_ACTIONS[action].area;
  if (area !== "url" && !areaHeld(account, area)) {
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
  /** Write a NEW file into the requesting agent's working directory, with
   *  the AGENT's rights (invariant 60); returns the absolute path. */
  writeFile: (fileName: string, bytes: Buffer, folder?: DownloadFolder) => Promise<string>;
  /** The Drive files `doc create` / `sheet create` made for an account,
   *  oldest first — what tells the cockpit's own files from the rest of a Drive. */
  ownFiles: { has: (accountId: string, fileId: string) => boolean; add: (accountId: string, fileId: string) => void; list: (accountId: string) => readonly string[] };
}

/** Where a download lands under the agent's working directory: a closed list. */
export type DownloadFolder = "drive-downloads" | "mail-attachments";

export type ActionOutcome =
  /** Done at once. `log` is absent for a plain read (it leaves nothing). */
  | { kind: "result"; result: Record<string, unknown>; log?: { summary: string; link?: string } }
  /** Waiting for a person: the route stores a draft and shows a card.
   *  \`result\` is what the agent may know already (the ids an edit will create). */
  | { kind: "pending"; action: DraftAction; payload: DraftPayload; summary: string; result?: Record<string, unknown> };

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

export function fileEditSummary(p: Pick<FilePayload, "op" | "name" | "fileId" | "text" | "range" | "rows" | "toId" | "toName" | "newName" | "bytes" | "convert" | "commentId" | "resolve">): string {
  const where = `"${p.name}" (${p.fileId})`;
  if (p.op === "drive.upload") return `upload "${p.name}" (${p.bytes ?? 0} bytes${p.convert ? `, as a Google ${p.convert}` : ""}) into folder "${p.toName ?? ""}" (${p.toId ?? ""})`;
  if (p.op === "drive.mkdir") return `create folder "${p.newName ?? ""}" in ${where}`;
  if (p.op === "drive.untrash") return `restore ${where} from the bin`;
  if (p.op === "drive.reply") {
    const verb = p.resolve ? (p.text ? "reply to and resolve" : "resolve") : "reply to";
    return `${verb} comment ${p.commentId ?? ""} on ${where}${p.text ? ` (${[...p.text].length} characters)` : ""}`;
  }
  if (p.op === "drive.delete") return `move ${where} to the bin`;
  if (p.op === "drive.move") return `move ${where} to folder "${p.toName ?? ""}" (${p.toId ?? ""})`;
  if (p.op === "drive.rename") return `rename ${where} to "${p.newName ?? ""}"`;
  if (p.op === "drive.copy") return `copy ${where}${p.newName ? ` as "${p.newName}"` : ""} into folder "${p.toName ?? ""}" (${p.toId ?? ""})`;
  if (p.op === "doc.append") return `append ${[...(p.text ?? "")].length} characters to ${where}`;
  const n = p.rows?.length ?? 0;
  const rows = `${n} row${n === 1 ? "" : "s"}`;
  return p.op === "sheet.update" ? `overwrite ${p.range ?? ""} of ${where} with ${rows}` : `append ${rows} to ${where}${p.range ? ` at ${p.range}` : ""}`;
}

export const FILE_CHANGED_SENTENCE = "That file was renamed or moved since this card was made — nothing was changed. Ask again if it is still wanted.";
export const FILE_GONE_SENTENCE = "That file is no longer in the Drive (deleted, binned, or no longer shared with this account) — nothing was changed.";

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
    out.push({ name, mime: uploadMime(name), bytes });
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const calendarOf = (args: Record<string, unknown>) => str(args.calendar) ?? "primary";

function eventPayload(op: EventPayload["op"], calendarId: string, e: Omit<Partial<EventView>, "meet"> & Pick<EventFields, "title" | "start" | "end"> & { meet?: unknown }, extra: Partial<EventPayload> = {}): EventPayload {
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
    // A read event is always "default" when it has no colour of its own; the
    // card names the colour only when it says something — an own colour, or
    // an update that takes one away.
    ...(e.color && (e.color !== "default" || extra.patch?.color === "default") ? { color: e.color } : {}),
    ...(e.meet === true ? { addMeet: true } : typeof e.meet === "string" ? { meetLink: e.meet } : {}),
    ...(e.recurrence ? { recurrence: e.recurrence } : {}),
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
  const formulas = formulasFlag(args.formulas);
  const r = await readDriveFile(await deps.token(account.id), { id: args.id, range: args.range, formulas }, deps.fetchFn);
  if (!r) throw new GoogleInputError(`No file '${String(args.id ?? "").slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
  return { kind: "result", result: { ...r, untrusted: true }, log: { summary: `file ${r.file.id} — "${r.file.name.slice(0, 200)}"`, ...(r.file.link ? { link: r.file.link } : {}) } };
}

/** The write a `file-write` action stands for, with its input checked. */
function fileEdit(action: "doc.append" | "sheet.append" | "sheet.update", args: Record<string, unknown>): FileEdit {
  if (action === "doc.append") return { op: action, text: appendTextVerdict(args.text) };
  const rows = rowsVerdict(args.rows);
  if (action === "sheet.update") return { op: action, range: updateRangeVerdict(args.range), rows };
  const given = args.range === undefined || args.range === null || args.range === "";
  return { op: action, ...(given ? {} : { range: rangeOk(args.range) }), rows };
}

type FileEdit = Pick<FilePayload, "op" | "text" | "range" | "rows" | "parentId" | "toId" | "newName" | "commentId" | "resolve">;

async function applyFileEdit(token: string, fileId: string, e: FileEdit, f: FetchFn, outbound: boolean): Promise<{ updatedRange?: string; copy?: DriveFileMeta & { private: boolean } }> {
  if (e.op === "drive.copy") return { copy: await copyFile(token, fileId, e.newName, e.toId, f) };
  // A folder created where the card said: `fileId` is the folder it goes in.
  if (e.op === "drive.mkdir") return { copy: await createFolder(token, e.newName ?? "", fileId, f) };
  // The upload waited, private, at the top of the Drive: approving moves it in.
  if (e.op === "drive.upload") return moveFile(token, fileId, e.parentId, e.toId ?? "", f).then(() => ({}));
  if (e.op === "drive.untrash") return restoreFile(token, fileId, f).then(() => ({}));
  if (e.op === "drive.reply") return replyToComment(token, fileId, e.commentId ?? "", { ...(e.text ? { text: e.text } : {}), ...(e.resolve ? { resolve: true } : {}) }, f).then(() => ({}));
  if (e.op === "drive.delete") return trashFile(token, fileId, f).then(() => ({}));
  if (e.op === "drive.rename") return renameFile(token, fileId, e.newName ?? "", f).then(() => ({}));
  if (e.op === "drive.move") return moveFile(token, fileId, e.parentId, e.toId ?? "", f).then(() => ({}));
  if (e.op === "doc.append") {
    await appendDoc(token, fileId, e.text, f, outbound);
    return {};
  }
  return e.op === "sheet.update" ? updateSheet(token, fileId, e.range, e.rows, f, outbound) : appendSheet(token, fileId, e.range, e.rows, f, outbound);
}

// ---- editing content: one checked batch (src/google-edits.ts) -------------

const EDIT_MIME: Record<EditApp, string> = { slides: MIME_SLIDES, doc: MIME_DOC, sheet: MIME_SHEET };
const EDIT_NOUN: Record<EditApp, string> = { slides: "Google Slides deck", doc: "Google Doc", sheet: "Google Sheet" };

async function editState(token: string, app: EditApp, id: string, f: FetchFn): Promise<EditState> {
  const src = await getEditSource(token, app, id, f);
  return app === "slides" ? slidesState(src) : app === "doc" ? docState(src) : sheetState(src);
}

/** Read the file, build the requests against what was just read, send them
 *  as ONE batch that Google applies whole or not at all. */
async function applyEdit(token: string, app: EditApp, id: string, ops: readonly EditOp[], f: FetchFn, outbound: boolean): Promise<SlidesCreated[]> {
  const state = await editState(token, app, id, f);
  const { requests, created } = editPlan(app, ops, state);
  try {
    await sendEditBatch(token, app, id, requests, state.app === "sheet" ? undefined : state.revisionId, f, outbound);
  } catch (e) {
    throw translateEditError(e);
  }
  return created;
}

/** The ids a batch creates, for the agent's result — absent when none. */
const createdField = (created: readonly SlidesCreated[]) => (created.length ? { created } : {});

/** The log's line for a batch: the file and how many of each operation — never a text or a value. */
export function editSummary(p: Pick<EditPayload, "fileId" | "name" | "ops">): string {
  return `edit ${p.name ? `"${p.name.slice(0, 200)}" ` : ""}(${p.fileId}): ${editOpCounts(p.ops)}`;
}

export const FILE_MOVED_SENTENCE = "This file changed since the card was made — nothing was applied. The operations listed would now apply to it as it is: apply them?";

/** The folder a new item goes into: null for the top of the Drive. Refused
 *  when it is not a folder of this Drive (or sits in the bin). */
async function folderTarget(token: string, to: string | undefined, f: FetchFn): Promise<DriveFileState | null> {
  if (to === undefined) return null;
  const dest = await getFileState(token, to, f);
  if (!dest || dest.trashed || dest.mimeType !== MIME_FOLDER) throw new GoogleInputError(`'${to.slice(0, 60)}' is not a folder of this Drive.`);
  return dest;
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
    case "doc.read": {
      const id = String(args.id ?? "");
      const token = await deps.token(account.id);
      const other = foreignFile(account, deps.ownFiles, id);
      // Someone else's document is audited and untrusted, like any Drive file.
      const meta = other ? await getFileMeta(token, id, f) : null;
      if (other && !meta) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      if (meta && meta.mimeType !== MIME_DOC) return driveRead(deps, account, args);
      const st = docState(await getEditSource(token, "doc", id, f));
      // The headings are what `doc edit` can insert after; the tables' sizes
      // are what its table operations count (only sizes: their text is in `text`).
      const headings = docHeadings(st);
      const tables = docTables(st);
      const text = st.paragraphs.map((p) => p.text).join("").replace(/\uFFFC/g, "");
      if (!meta) return { kind: "result", result: { id, name: st.title, text, headings, ...(tables.length ? { tables } : {}) } };
      const cut = truncateBody(text.replace(/\s+$/, ""), MAX_FILE_CHARS);
      return { kind: "result", result: { file: meta, kind: "text", text: cut.body, headings, ...(tables.length ? { tables } : {}), truncated: cut.truncated, untrusted: true }, log: { summary: `file ${meta.id} — "${meta.name.slice(0, 200)}"`, ...(meta.link ? { link: meta.link } : {}) } };
    }
    case "slides.read": {
      const id = String(args.id ?? "");
      const token = await deps.token(account.id);
      const other = foreignFile(account, deps.ownFiles, id);
      const meta = other ? await getFileMeta(token, id, f) : null;
      if (other && !meta) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      if (meta && meta.mimeType !== MIME_SLIDES) throw new GoogleInputError(`File '${id.slice(0, 60)}' is not a Google Slides deck.`);
      const st = slidesState(await getEditSource(token, "slides", id, f));
      // Bounded like any file read: element texts are cut once the budget is spent.
      let left = MAX_FILE_CHARS;
      let truncated = false;
      // The deck's own layouts: what \`add_slide\` can name, by id or name.
      const layouts = st.layouts.map((l) => ({ id: l.id, name: l.name.slice(0, 200) }));
      const budget = (raw: string) => {
        const t = raw.replace(/\n$/, "");
        const kept = [...t].slice(0, Math.max(0, left)).join("");
        left -= kept.length;
        if (kept.length < t.length) truncated = true;
        return kept;
      };
      // Each element with its box in points (what \`move\` changes); the
      // speaker notes after the slide's elements (what \`set_notes\` writes).
      const slides = st.slides.map((s) => ({
        id: s.id,
        layout: s.layout,
        elements: s.elements.map((e) => ({ id: e.id, type: e.type, text: budget(e.text), ...(e.box ? { box: e.box } : {}), ...(e.inGroup ? { inGroup: true } : {}) })),
        ...(s.notes !== undefined ? { notes: budget(s.notes) } : {}),
      }));
      // Always untrusted: a deck's text is whatever anyone typed into it.
      const file = meta ?? { id, name: st.title, mimeType: MIME_SLIDES, owners: [] };
      return { kind: "result", result: { file, kind: "slides", slides, layouts, truncated, untrusted: true }, ...(meta ? { log: { summary: `file ${meta.id} — "${meta.name.slice(0, 200)}"`, ...(meta.link ? { link: meta.link } : {}) } } : {}) };
    }
    case "slides.thumbnail": {
      const id = String(args.id ?? "");
      const slideId = String(args.slideId ?? "");
      // Checked before a token is fetched: an object id, a size from the list.
      if (!/^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,99}$/.test(slideId)) throw new GoogleInputError("Give the slide's id (see `slides read`).");
      const size = args.size === undefined || args.size === null ? "LARGE" : String(args.size).toUpperCase();
      if (!(THUMBNAIL_SIZES as readonly string[]).includes(size)) throw new GoogleInputError(`'size' must be one of ${THUMBNAIL_SIZES.join(", ")}.`);
      const token = await deps.token(account.id);
      const other = foreignFile(account, deps.ownFiles, id);
      const meta = other ? await getFileMeta(token, id, f) : null;
      if (other && !meta) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      if (meta && meta.mimeType !== MIME_SLIDES) throw new GoogleInputError(`File '${id.slice(0, 60)}' is not a Google Slides deck.`);
      const shot = await getSlideThumbnail(token, id, slideId, size as (typeof THUMBNAIL_SIZES)[number], f);
      // The name is ours, never the deck's: nothing someone else wrote goes into a path.
      const safe = slideId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
      let saved: string;
      try {
        saved = await deps.writeFile(`slide-${safe}.png`, shot.bytes);
      } catch {
        throw new GoogleInputError("The image could not be written into this agent's working directory.");
      }
      // The picture shows whatever anyone typed on the slide: untrusted, like the deck's text.
      return {
        kind: "result",
        result: { kind: "thumbnail", path: saved, slideId, width: shot.width, height: shot.height, bytes: shot.bytes.length, untrusted: true, ...(meta ? { file: meta } : {}) },
        ...(meta ? { log: { summary: `thumbnail of slide ${slideId} of file ${meta.id} — "${meta.name.slice(0, 200)}"`, ...(meta.link ? { link: meta.link } : {}) } } : {}),
      };
    }
    case "slides.create": {
      const deck = await createPresentation(await deps.token(account.id), args.title, f);
      deps.ownFiles.add(account.id, deck.id);
      return { kind: "result", result: deck, log: { summary: `presentation "${deck.name}" (${deck.id})`, link: deck.link } };
    }
    case "slides.edit":
    case "doc.edit":
    case "sheet.edit": {
      const app = action.split(".")[0] as EditApp;
      const id = String(args.id ?? "");
      const ops = editOpsVerdict(app, args.ops);
      const token = await deps.token(account.id);
      if (!foreign) {
        // One of the cockpit's own files: applied at once.
        const created = await applyEdit(token, app, id, ops, f, false);
        return { kind: "result", result: { id, status: "applied", operations: ops.length, ...createdField(created) }, log: { summary: editSummary({ fileId: id, name: "", ops }) } };
      }
      const meta = await getFileMeta(token, id, f);
      if (!meta) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      if (meta.mimeType !== EDIT_MIME[app]) throw new GoogleInputError(`File '${id.slice(0, 60)}' is not a ${EDIT_NOUN[app]}, so \`${action.replace(".", " ")}\` cannot edit it.`);
      // Built once now, against the file as it is: an operation whose target
      // is not there is refused before a person is asked anything.
      const state = await editState(token, app, id, f);
      const planned = editPlan(app, ops, state).created;
      const payload: EditPayload = { kind: "edit", app, fileId: meta.id, name: meta.name, ...(meta.link ? { link: meta.link } : {}), owners: meta.owners, ops: annotateOps(app, ops, state), stamp: meta.modifiedTime ?? "" };
      const summary = editSummary(payload);
      if (setting === "autonomous") {
        const created = await applyEdit(token, app, id, ops, f, true);
        return { kind: "result", result: { id, status: "applied", operations: ops.length, ...createdField(created) }, log: { summary, ...(meta.link ? { link: meta.link } : {}) } };
      }
      // The ids are drawn now and travel in the stored ops, so the agent can
      // be told what the edit WILL create before anyone approves it.
      return { kind: "pending", action, payload, summary, ...(planned.length ? { result: { created: planned } } : {}) };
    }
    case "sheet.read": {
      if (foreignFile(account, deps.ownFiles, String(args.id ?? ""))) return driveRead(deps, account, args);
      const formulas = formulasFlag(args.formulas);
      return { kind: "result", result: await readSheet(await deps.token(account.id), String(args.id ?? ""), args.range, f, formulas) };
    }
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
      // The file's NAME stays out of the sentence: it is someone else's
      // words, and an error is printed to the agent outside any fence.
      if (meta.mimeType !== want) throw new GoogleInputError(`File '${id.slice(0, 60)}' is not a Google ${action === "doc.append" ? "Doc" : "Sheet"}, so \`${action.replace(".", " ")}\` cannot write to it.`);
      const payload: FilePayload = { kind: "file", ...edit, fileId: meta.id, name: meta.name, ...(meta.link ? { link: meta.link } : {}), owners: meta.owners };
      const summary = fileEditSummary(payload);
      if (setting === "autonomous") {
        const r = await applyFileEdit(token, id, edit, f, true);
        return { kind: "result", result: { id, status: "applied", ...r }, log: { summary, ...(meta.link ? { link: meta.link } : {}) } };
      }
      return { kind: "pending", action, payload, summary };
    }
    case "drive.download": {
      const r = await downloadDriveFile(await deps.token(account.id), { id: args.id, format: args.format }, f);
      if (!r) throw new GoogleInputError(`No file '${String(args.id ?? "").slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      let saved: string;
      try {
        saved = await deps.writeFile(r.fileName, r.bytes);
      } catch {
        throw new GoogleInputError("The file could not be written into this agent's working directory.");
      }
      // Audited by id and name. The path carries the file's (sanitised) name —
      // someone else's words — so the whole answer is marked untrusted.
      return {
        kind: "result",
        result: { file: r.file, kind: "download", path: saved, bytes: r.bytes.length, format: r.format, truncated: false, untrusted: true },
        log: { summary: `download file ${r.file.id} — "${r.file.name.slice(0, 200)}" (${r.format}, ${r.bytes.length} bytes)` },
      };
    }
    case "drive.delete":
    case "drive.move":
    case "drive.rename": {
      const id = String(args.id ?? "");
      const newName = action === "drive.rename" ? fileNameVerdict(args.name) : undefined;
      const to = action === "drive.move" ? String(args.to ?? "") : undefined;
      if (action === "drive.move" && !to) throw new GoogleInputError("Give the folder to move it to (--to <folder id>, or `root` for the top of the Drive).");
      const token = await deps.token(account.id);
      const meta = await getFileMeta(token, id, f);
      if (!meta) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      // Where it is now — what the card shows, and what Approve compares against.
      const parent = meta.parentId ? await getFileMeta(token, meta.parentId, f).catch(() => null) : null;
      let dest: DriveFileMeta | null = null;
      if (to !== undefined) {
        dest = await getFileMeta(token, to, f);
        if (!dest || dest.mimeType !== MIME_FOLDER) throw new GoogleInputError(`'${to.slice(0, 60)}' is not a folder of this Drive.`);
        if (dest.id === meta.parentId) throw new GoogleInputError("That file is already in that folder.");
        if (dest.id === meta.id) throw new GoogleInputError("A folder cannot be moved into itself.");
      }
      if (newName !== undefined && newName === meta.name) throw new GoogleInputError("That is already the file's name.");
      const payload: FilePayload = {
        kind: "file", op: action, fileId: meta.id, name: meta.name, ...(meta.link ? { link: meta.link } : {}), owners: meta.owners,
        ...(meta.parentId ? { parentId: meta.parentId } : {}),
        ...(parent ? { parentName: parent.name } : {}),
        ...(dest ? { toId: dest.id, toName: dest.name } : {}),
        ...(newName !== undefined ? { newName } : {}),
      };
      const summary = fileEditSummary(payload);
      if (setting === "autonomous") {
        await applyFileEdit(token, meta.id, payload, f, true);
        return { kind: "result", result: { id: meta.id, status: action === "drive.delete" ? "binned" : action === "drive.move" ? "moved" : "renamed" }, log: { summary, ...(meta.link ? { link: meta.link } : {}) } };
      }
      return { kind: "pending", action, payload, summary };
    }
    case "drive.copy": {
      const id = String(args.id ?? "");
      const newName = args.name === undefined || args.name === null || args.name === "" ? undefined : fileNameVerdict(args.name);
      const to = args.to === undefined || args.to === null || args.to === "" ? undefined : String(args.to);
      const token = await deps.token(account.id);
      const meta = await getFileMeta(token, id, f);
      if (!meta) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      if (meta.mimeType === MIME_FOLDER) throw new GoogleInputError("That is a folder: Drive copies files, not folders.");
      let dest: DriveFileMeta | null = null;
      if (to !== undefined) {
        dest = await getFileMeta(token, to, f);
        if (!dest || dest.mimeType !== MIME_FOLDER) throw new GoogleInputError(`'${to.slice(0, 60)}' is not a folder of this Drive.`);
      }
      // Beside the original (no --to, or its own folder): the copy reaches no
      // one the original did not — no card. Elsewhere: the DRIVE setting.
      const elsewhere = dest !== null && dest.id !== meta.parentId;
      if (!elsewhere || setting === "autonomous") {
        const copy = await copyFile(token, meta.id, newName, dest?.id, f);
        // Edited without asking ONLY when nobody else can see it: a copy in a
        // shared folder stays someone else's file to the Drive setting, or an
        // agent could put content it controls before a whole team, unasked.
        if (copy.private) deps.ownFiles.add(account.id, copy.id);
        const summary = `copy "${meta.name.slice(0, 200)}" (${meta.id}) → "${copy.name.slice(0, 200)}" (${copy.id})`;
        return { kind: "result", result: { id: copy.id, name: copy.name, ...(copy.link ? { link: copy.link } : {}), status: "copied", private: copy.private }, log: { summary, ...(copy.link ? { link: copy.link } : {}) } };
      }
      const parent = meta.parentId ? await getFileMeta(token, meta.parentId, f).catch(() => null) : null;
      const payload: FilePayload = {
        kind: "file", op: "drive.copy", fileId: meta.id, name: meta.name, ...(meta.link ? { link: meta.link } : {}), owners: meta.owners,
        ...(meta.parentId ? { parentId: meta.parentId } : {}),
        ...(parent ? { parentName: parent.name } : {}),
        toId: dest!.id, toName: dest!.name,
        ...(newName !== undefined ? { newName } : {}),
      };
      return { kind: "pending", action: "drive.copy", payload, summary: fileEditSummary(payload) };
    }
    case "drive.upload":
    case "drive.mkdir": {
      // Checked — and the agent's file read, with ITS rights — before a token.
      const to = folderTargetVerdict(args.to);
      let name: string;
      let upload: { bytes: Buffer; mime: string; convert?: ReturnType<typeof convertVerdict> } | undefined;
      if (action === "drive.upload") {
        const p = args.path;
        if (typeof p !== "string" || !path.isAbsolute(p)) throw new GoogleInputError("Give the file to upload as an absolute path (--path /abs/path/file.pdf).");
        const local = attachmentName(p);
        name = args.name === undefined || args.name === null || args.name === "" ? local : fileNameVerdict(args.name);
        const convert = convertVerdict(args.convert, local);
        let bytes: Buffer;
        try {
          bytes = await deps.readFile(p);
        } catch {
          throw new GoogleInputError(`'${p.slice(0, 120)}' is not a file this agent can read.`);
        }
        if (bytes.length > MAX_UPLOAD_BYTES) throw new GoogleInputError(`That file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB — too large to upload here.`);
        upload = { bytes, mime: uploadMime(local), ...(convert ? { convert } : {}) };
      } else {
        if (args.name === undefined || args.name === null || args.name === "") throw new GoogleInputError("Give the new folder's name (--name).");
        name = fileNameVerdict(args.name);
      }
      const token = await deps.token(account.id);
      const dest = await folderTarget(token, to, f);
      // At the top of the Drive or in a folder only the person can see, the
      // new item reaches no one: no card. In a folder others see: the DRIVE setting.
      const shared = dest !== null && !dest.private;
      const into = dest ? ` in "${dest.name.slice(0, 200)}" (${dest.id})` : "";
      const make = () =>
        upload ? uploadFile(token, { name, bytes: upload.bytes, mime: upload.mime, ...(upload.convert ? { convertTo: upload.convert } : {}), ...(dest ? { parentId: dest.id } : {}) }, f) : createFolder(token, name, dest?.id, f);
      if (!shared || setting === "autonomous") {
        const made = await make();
        // Own — edited without asking — only when nobody else can see it (`copyIsPrivate`).
        if (made.private) deps.ownFiles.add(account.id, made.id);
        const what = upload ? `upload "${made.name.slice(0, 200)}" (${made.id}), ${upload.bytes.length} bytes${upload.convert ? `, as a Google ${upload.convert}` : ""}` : `folder "${made.name.slice(0, 200)}" (${made.id})`;
        return {
          kind: "result",
          result: { id: made.id, name: made.name, mimeType: made.mimeType, ...(made.link ? { link: made.link } : {}), status: upload ? "uploaded" : "created", private: made.private },
          log: { summary: what + into, ...(made.link ? { link: made.link } : {}) },
        };
      }
      if (!upload) {
        // `fileId` is the folder it goes IN: what Approve checks is still there.
        const payload: FilePayload = { kind: "file", op: "drive.mkdir", fileId: dest!.id, name: dest!.name, ...(dest!.link ? { link: dest!.link } : {}), owners: dest!.owners, newName: name };
        return { kind: "pending", action: "drive.mkdir", payload, summary: fileEditSummary(payload) };
      }
      // The bytes are uploaded NOW, privately, to the top of the Drive — the
      // upload IS the draft, as a Gmail draft is an email's: the person can
      // open it from the card, Approve moves it into the folder, Discard bins
      // it. Not recorded as the cockpit's own: it is meant for a shared folder.
      const staged = await uploadFile(token, { name, bytes: upload.bytes, mime: upload.mime, ...(upload.convert ? { convertTo: upload.convert } : {}) }, f);
      const payload: FilePayload = {
        kind: "file", op: "drive.upload", fileId: staged.id, name: staged.name, ...(staged.link ? { link: staged.link } : {}), owners: staged.owners,
        ...(staged.parentId ? { parentId: staged.parentId } : {}),
        toId: dest!.id, toName: dest!.name, bytes: upload.bytes.length,
        ...(upload.convert ? { convert: upload.convert } : {}),
      };
      return { kind: "pending", action: "drive.upload", payload, summary: fileEditSummary(payload), result: { id: staged.id, staged: true } };
    }
    case "drive.untrash": {
      const id = fileIdVerdict(args.id);
      const token = await deps.token(account.id);
      const st = await getFileState(token, id, f);
      if (!st) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Find what is in the bin with \`drive search --query "trashed = true"\`.`);
      if (!st.trashed) throw new GoogleInputError("That file is not in the bin.");
      // Where it goes back to — what the card shows.
      const parent = st.parentId ? await getFileMeta(token, st.parentId, f).catch(() => null) : null;
      const payload: FilePayload = {
        kind: "file", op: "drive.untrash", fileId: st.id, name: st.name, ...(st.link ? { link: st.link } : {}), owners: st.owners,
        ...(st.parentId ? { parentId: st.parentId } : {}),
        ...(parent ? { parentName: parent.name } : {}),
      };
      const summary = fileEditSummary(payload);
      if (setting === "autonomous") {
        await restoreFile(token, st.id, f);
        return { kind: "result", result: { id: st.id, status: "restored" }, log: { summary, ...(st.link ? { link: st.link } : {}) } };
      }
      return { kind: "pending", action: "drive.untrash", payload, summary };
    }
    case "drive.comments":
    case "drive.access": {
      const id = fileIdVerdict(args.id);
      const token = await deps.token(account.id);
      const meta = await getFileMeta(token, id, f);
      if (!meta) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      const file = `file ${meta.id} — "${meta.name.slice(0, 200)}"`;
      // Audited by file and count — never a comment's text or a person's name.
      if (action === "drive.comments") {
        const r = await listComments(token, meta.id, { pageToken: args.pageToken }, f);
        return { kind: "result", result: { kind: "comments", file: meta, ...r, untrusted: true }, log: { summary: `comments of ${file} — ${r.comments.length}` } };
      }
      const r = await listAccess(token, meta.id, f);
      return { kind: "result", result: { kind: "access", file: meta, ...r, untrusted: true }, log: { summary: `access of ${file} — ${r.access.length}` } };
    }
    case "drive.reply": {
      const id = fileIdVerdict(args.id);
      const commentId = fileIdVerdict(args.comment, "comment");
      const resolve = args.resolve === true;
      const text = replyTextVerdict(args.text, resolve);
      const token = await deps.token(account.id);
      const meta = await getFileMeta(token, id, f);
      if (!meta) throw new GoogleInputError(`No file '${id.slice(0, 60)}' in this Drive. Run \`drive search\` to find its id.`);
      const c = await getComment(token, meta.id, commentId, f);
      if (!c) throw new GoogleInputError(`No comment '${commentId.slice(0, 60)}' on that file. Run \`drive comments\` to find its id.`);
      if (resolve && c.resolved && !text) throw new GoogleInputError("That comment is already resolved.");
      const payload: FilePayload = {
        kind: "file", op: "drive.reply", fileId: meta.id, name: meta.name, ...(meta.link ? { link: meta.link } : {}), owners: meta.owners,
        commentId: c.id || commentId, commentAuthor: c.author, commentText: truncateBody(c.text, 1000).body,
        ...(text ? { text } : {}),
        ...(resolve ? { resolve: true } : {}),
      };
      const summary = fileEditSummary(payload);
      if (setting === "autonomous") {
        await applyFileEdit(token, meta.id, payload, f, true);
        return { kind: "result", result: { id: meta.id, comment: payload.commentId, status: resolve ? "resolved" : "replied" }, log: { summary, ...(meta.link ? { link: meta.link } : {}) } };
      }
      return { kind: "pending", action: "drive.reply", payload, summary };
    }
    case "api.get": {
      const plan = passthroughPlan(args.url);
      if (!areaHeld(account, plan.area)) {
        throw new GoogleInputError(`That URL needs ${AREA_LABEL[plan.area]} access, which Google account '${account.label}' was connected without — ${account.owner} can reconnect it and tick ${AREA_LABEL[plan.area]} in Secrets → Connected accounts.`);
      }
      const r = await passthroughGet(await deps.token(account.id), plan.url, f);
      // Audited by URL — never by what came back.
      return { kind: "result", result: { kind: "api", ...r, untrusted: true }, log: { summary: `GET ${plan.url.slice(0, 500)}` } };
    }
    case "gmail.draft":
    case "gmail.send": {
      const replyAll = args.replyAll === true;
      const replyTo = str(args.replyTo);
      if (replyAll && !replyTo) throw new GoogleInputError("--reply-all goes with --reply <message id>: it fills the recipients from that message.");
      const fields = mailFieldsVerdict(args, { recipientsLater: replyAll });
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
      // A reply goes in the original's conversation. Finding the original's
      // ids means READING a message, which only `gmail_read` may do.
      if (replyTo && !areaHeld(account, "gmail_read")) {
        throw new GoogleInputError(`Replying in a thread needs Read Gmail access, which Google account '${account.label}' was connected without — ${account.owner} can reconnect it and tick Read Gmail. Without it, send a new email instead.`);
      }
      if (args.signature === true) needReadGmail(account, "Adding the Gmail signature", "write the signature into the body yourself");
      const token = await deps.token(account.id);
      let threadId: string | undefined;
      if (replyTo) {
        const t = await replyTarget(token, replyTo, f);
        fields.inReplyTo = t.inReplyTo;
        fields.references = t.references;
        threadId = t.threadId;
        if (replyAll) {
          // Gmail's own reply-all: the original's sender and recipients, minus
          // every address of the person. Added to what the agent named.
          const all = replyAllRecipients(t.headers, await ownAddresses(token, f));
          const taken = new Set([...fields.to, ...fields.cc, ...fields.bcc].flatMap((x) => addrSpecs(x)));
          const fresh = (l: string[]) => l.filter((a) => !taken.has(a) && (taken.add(a), true));
          fields.to = [...fields.to, ...fresh(all.to)];
          fields.cc = [...fields.cc, ...fresh(all.cc)];
          recipientsVerdict(fields);
        }
      }
      if (args.signature === true) await addSignature(token, account, fields, f);
      const summary = mailSummary(fields) + (replyTo ? (replyAll ? " (reply all)" : " (reply)") : "") + (fields.signature ? " (signed)" : "");
      if (action === "gmail.draft") {
        const raw = rawMessage(buildMime(fields, attachments));
        const d = replace ? await updateGmailDraft(token, replace, raw, f, threadId) : await createGmailDraft(token, raw, f, threadId);
        if (!replace) deps.ownGmailDrafts.add(account.id, d.id);
        return { kind: "result", result: { draftId: d.id, status: "draft", to: fields.to, cc: fields.cc }, log: { summary: `draft ${summary}` } };
      }
      return deliverMail(deps, account, token, setting, fields, attachments, summary, threadId);
    }
    case "gmail.forward": {
      const id = str(args.id);
      if (!id) throw new GoogleInputError("Say which message to forward: --id <message id> (see `gmail search`).");
      const note = args.body === undefined || args.body === null ? "" : args.body;
      if (typeof note !== "string") throw new GoogleInputError("The note above a forward must be text.");
      // Recipients (and a subject, when given) are checked like any email's;
      // the body is the forwarded message, built below.
      const fields = mailFieldsVerdict({ ...args, subject: args.subject ?? "Fwd", body: "-" });
      const ownSubject = typeof args.subject === "string" && args.subject.trim() ? fields.subject : undefined;
      // Forwarding means READING the original — text and attachments.
      needReadGmail(account, "Forwarding a message", "write a new email instead");
      if (args.signature === true) needReadGmail(account, "Adding the Gmail signature", "write the signature into the note yourself");
      const token = await deps.token(account.id);
      const src = await forwardSource(token, id, f);
      fields.subject = ownSubject ?? forwardSubject(src.subject);
      fields.body = forwardBody(note, src);
      if (args.signature === true) await addSignature(token, account, fields, f);
      const summary = `${mailSummary(fields)} (forward of ${id}${src.attachments.length ? `, ${src.attachments.length} attachment${src.attachments.length === 1 ? "" : "s"}` : ""})`;
      return deliverMail(deps, account, token, setting, fields, src.attachments, summary);
    }
    case "gmail.attachment": {
      // Which attachment, checked before a token is fetched.
      attachmentPickVerdict({ index: args.index, name: args.name });
      if (typeof args.id !== "string" || !args.id) throw new GoogleInputError("Say which message: --id <message id> (see `gmail search`).");
      const r = await getMailAttachment(await deps.token(account.id), { id: args.id, index: args.index, name: args.name }, f);
      let saved: string;
      try {
        saved = await deps.writeFile(r.fileName, r.bytes, "mail-attachments");
      } catch {
        throw new GoogleInputError("The attachment could not be written into this agent's working directory.");
      }
      // Audited by message id and attachment number — never the name, which
      // is the sender's words. The path carries that name: untrusted.
      return {
        kind: "result",
        result: { kind: "attachment", messageId: r.messageId, attachment: r.attachment, path: saved, bytes: r.bytes.length, untrusted: true },
        log: { summary: `attachment ${r.attachment.index} of message ${r.messageId} (${r.bytes.length} bytes)` },
      };
    }
    case "gmail.labels": {
      const labels = await listGmailLabels(await deps.token(account.id), f);
      return { kind: "result", result: { labels } };
    }
    case "gmail.archive":
    case "gmail.mark":
    case "gmail.star":
    case "gmail.label":
    case "gmail.trash": {
      const target = mailTargetVerdict({ ids: args.ids, threadId: args.threadId });
      let add: string[] = [];
      let remove: string[] = [];
      let want: { add: string[]; remove: string[] } | null = null;
      let what: string;
      if (action === "gmail.archive") [remove, what] = [["INBOX"], "archive"];
      else if (action === "gmail.mark") {
        if (typeof args.read !== "boolean") throw new GoogleInputError("Say --read or --unread.");
        [add, remove, what] = args.read ? [[], ["UNREAD"], "mark read"] : [["UNREAD"], [], "mark unread"];
      } else if (action === "gmail.star") {
        if (typeof args.star !== "boolean") throw new GoogleInputError("Say --on or --off (star or unstar).");
        [add, remove, what] = args.star ? [["STARRED"], [], "star"] : [[], ["STARRED"], "unstar"];
      } else if (action === "gmail.label") {
        const names = (k: string) => {
          const v = args[k] === undefined || args[k] === null ? [] : args[k];
          if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x && x.length <= 200)) throw new GoogleInputError(`${k} must be a list of label names.`);
          return v as string[];
        };
        want = { add: names("add"), remove: names("remove") };
        if (!want.add.length && !want.remove.length) throw new GoogleInputError("Give a label to add (--add) or remove (--remove) — see `gmail labels`.");
        what = "label";
      } else what = "move to the bin";
      const token = await deps.token(account.id);
      if (want) {
        const labels = await listGmailLabels(token, f);
        add = resolveLabels(want.add, labels);
        remove = resolveLabels(want.remove, labels);
        const name = (id: string) => labels.find((l) => l.id === id)?.name ?? id;
        what = [add.length ? `add ${add.map(name).join(", ")}` : "", remove.length ? `remove ${remove.map(name).join(", ")}` : ""].filter(Boolean).join("; ");
      }
      if (action === "gmail.trash") await trashGmail(token, target, f);
      else await modifyGmail(token, target, add, remove, f);
      // Logged by ids, never by subject: what was filed, not what it said.
      return { kind: "result", result: { status: "done", ...("threadId" in target ? { threadId: target.threadId } : { ids: target.ids }) }, log: { summary: `${what} — ${targetLine(target)}` } };
    }
    case "calendar.free": {
      const o = freeOptionsVerdict({ from: args.from, to: args.to, minutes: args.minutes, dayStart: args.dayStart, dayEnd: args.dayEnd, timeZone: args.timeZone, weekends: args.weekends }, deps.now());
      const ids = args.with === undefined || args.with === null ? [] : freeBusyIdsVerdict(args.with);
      // The person's OWN free time is read from their events (calendar.events);
      // anyone else's needs the free/busy area.
      if (ids.length && !areaHeld(account, "calendar_freebusy")) {
        throw new GoogleInputError(`Seeing other people's free/busy needs the Others' free/busy area, which Google account '${account.label}' was connected without — ${account.owner} can reconnect it and tick it. Without it, \`calendar free\` finds the person's own free time only.`);
      }
      const token = await deps.token(account.id);
      const own = await ownBusy(token, o.from, o.to, f);
      const timeZone = o.timeZone ?? own.timeZone ?? "UTC";
      const others = ids.length ? await freeBusyQuery(token, ids, o.from, o.to, f) : [];
      const busy = [...own.busy, ...others.flatMap((c) => c.busy)];
      const slots = freeSlots(busy, { ...o, timeZone }).map((s) => ({ start: zonedIso(s.start, timeZone), end: zonedIso(s.end, timeZone), minutes: Math.round((s.end - s.start) / 60_000) }));
      const result = {
        timeZone,
        from: zonedIso(o.from, timeZone),
        to: zonedIso(o.to, timeZone),
        dayStart: o.dayStart,
        dayEnd: o.dayEnd,
        minutes: o.minutes,
        slots,
        calendars: others.map((c) => ({ id: c.id, busy: c.busy.map((b) => ({ start: zonedIso(b.start, timeZone), end: zonedIso(b.end, timeZone) })), ...(c.error ? { error: c.error } : {}) })),
      };
      // Other people's availability is logged (whose, over which window); the
      // person's own is a plain read, like `calendar list`.
      return { kind: "result", result, ...(ids.length ? { log: { summary: `free/busy of ${ids.join(", ")} — ${result.from} → ${result.to}` } } : {}) };
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
    case "calendar.delete":
    case "calendar.respond": {
      const calendarId = calendarOf(args);
      const eventId = String(args.event ?? "");
      // `--attendee` on an update used to REPLACE the whole guest list, which
      // silently dropped everyone not repeated: replacing is now explicit.
      if (action === "calendar.update" && args.attendees !== undefined && args.attendees !== null && args.replaceAttendees !== true) {
        throw new GoogleInputError("To change the guests of an event use --add-attendee / --remove-attendee. Replacing the whole list needs --attendee together with --replace-attendees.");
      }
      const change = action === "calendar.update" ? attendeeChangeVerdict(args) : { add: [], remove: [] };
      const changesGuests = change.add.length + change.remove.length > 0;
      const patch = action === "calendar.update" ? eventFieldsVerdict(args, true, changesGuests) : null;
      const response = action === "calendar.respond" ? rsvpVerdict(args.response) : null;
      const series = args.series === true;
      const token = await deps.token(account.id);
      // The event as it is now: what the card shows for a delete, and what an
      // update is merged over so the card shows the event as it WILL be.
      const given = await getEvent(token, calendarId, eventId, f);
      if (!given) throw new GoogleInputError(`No event '${eventId.slice(0, 60)}' in that calendar. Run \`calendar list\` to find its id.`);
      // A repeating event: an occurrence id (what `calendar list` prints)
      // changes that occurrence; `--series` reaches the whole series, through
      // the series' own id. The card says which.
      let current: EventView = given;
      let targetId = eventId;
      let scope: EventPayload["scope"];
      if (series) {
        if (given.recurringEventId) {
          const master = await getEvent(token, calendarId, given.recurringEventId, f);
          if (!master) throw new GoogleInputError("The series this occurrence belongs to is no longer there.");
          current = master;
          targetId = given.recurringEventId;
        } else if (!given.recurrence) throw new GoogleInputError("That event does not repeat — drop --series.");
        scope = "series";
      } else if (given.recurringEventId) scope = "occurrence";
      else if (given.recurrence) scope = "series";
      const occurrence = scope === "occurrence" ? { occurrence: given.start } : {};
      if (action === "calendar.delete") {
        const summary = eventSummary("delete", current) + scopeNote(scope);
        if (setting === "autonomous") {
          await deleteEvent(token, calendarId, targetId, f);
          return { kind: "result", result: { status: "deleted", event: targetId, ...(scope ? { scope } : {}) }, log: { summary } };
        }
        return { kind: "pending", action: "calendar.delete", payload: eventPayload("delete", calendarId, current, { eventId: targetId, ...(scope ? { scope } : {}), ...occurrence }), summary };
      }
      if (action === "calendar.respond") {
        const me = (current.guests ?? []).find((g) => g.self);
        if (!me) throw new GoogleInputError("The person is not on that event's guest list, so there is no invitation to answer.");
        if (me.organizer) throw new GoogleInputError("The person organises that event — there is no invitation to answer.");
        const summary = `respond ${response} to "${current.title}" ${current.start}${scopeNote(scope)}`;
        if (setting === "autonomous") {
          const e = await respondEvent(token, calendarId, targetId, response!, f);
          return { kind: "result", result: { status: "responded", response, event: e }, log: { summary, ...(e.link ? { link: e.link } : {}) } };
        }
        return {
          kind: "pending",
          action: "calendar.respond",
          payload: eventPayload("respond", calendarId, current, { eventId: targetId, response: response!, ...(current.organizer ? { organizer: current.organizer } : {}), ...(scope ? { scope } : {}), ...occurrence }),
          summary,
        };
      }
      const p = patch as Partial<EventFields>;
      if (p.recurrence && scope === "occurrence") throw new GoogleInputError("How an event repeats belongs to the whole series: add --series to change it.");
      if (p.meet && current.meet) throw new GoogleInputError("That event already has a Google Meet link — drop --meet.");
      const guests = current.attendees.map((a) => a.toLowerCase());
      const missing = change.remove.filter((a) => !guests.includes(a));
      if (missing.length) throw new GoogleInputError(`'${missing[0]}' is not a guest of that event.`);
      // What the card lists: the guests as they WILL be, and who is added or
      // dropped — a replaced list included (the organizer always stays).
      const organizerOf = new Set((current.guests ?? []).filter((g) => g.organizer).map((g) => g.email.toLowerCase()));
      const base = p.attendees ? [...current.attendees.filter((a) => organizerOf.has(a.toLowerCase()) && !p.attendees!.includes(a.toLowerCase())), ...p.attendees] : current.attendees;
      const now = base.map((a) => a.toLowerCase());
      const added = [...(p.attendees ?? []), ...change.add].filter((a, i, l) => !guests.includes(a) && l.indexOf(a) === i);
      const dropped = [...guests.filter((a) => !now.includes(a)), ...change.remove];
      const attendees = [...base.filter((a) => !change.remove.includes(a.toLowerCase())), ...change.add.filter((a) => !now.includes(a))];
      const { meet: _m, ...view } = current;
      const next: Omit<EventView, "meet"> & { meet?: string | boolean } = { ...view, ...p, attendees, ...(p.meet ? { meet: true } : current.meet ? { meet: current.meet } : {}) };
      const summary = eventSummary("update", next) + scopeNote(scope);
      const sent: EventPatch = { ...p, ...(change.add.length ? { addAttendees: change.add } : {}), ...(change.remove.length ? { removeAttendees: change.remove } : {}) };
      if (setting === "autonomous") {
        const e = await patchEvent(token, calendarId, targetId, sent, f);
        return { kind: "result", result: { status: "updated", event: e, ...(scope ? { scope } : {}) }, log: { summary, link: e.link } };
      }
      return {
        kind: "pending",
        action: "calendar.update",
        payload: eventPayload("update", calendarId, next, {
          eventId: targetId,
          patch: sent as Record<string, unknown>,
          ...(scope ? { scope } : {}),
          ...(added.length ? { added } : {}),
          ...(dropped.length ? { removed: dropped } : {}),
          ...occurrence,
        }),
        summary,
      };
    }
  }
}

/** The Read-Gmail gate of a mail write that reads something first. */
function needReadGmail(account: ConnectedAccount, what: string, instead: string): void {
  if (!areaHeld(account, "gmail_read")) {
    throw new GoogleInputError(`${what} needs Read Gmail access, which Google account '${account.label}' was connected without — ${account.owner} can reconnect it and tick Read Gmail. Without it, ${instead}.`);
  }
}

/** The person's signature, which Gmail never adds to mail an API creates.
 *  Reading it is reading their settings: `gmail_read` (gmail.readonly). */
async function addSignature(token: string, account: ConnectedAccount, fields: MailFields, f: FetchFn): Promise<void> {
  const sig = await gmailSignature(token, f);
  if (!sig) throw new GoogleInputError(`Google account '${account.label}' has no Gmail signature set — nothing to add. Send without --signature, or ask ${account.owner} to set one in Gmail's settings.`);
  fields.signature = sig;
}

/** Send now (MAIL setting automatic) or make the Gmail draft a person
 *  approves — the one cycle every outgoing mail goes through, a forward too. */
async function deliverMail(
  deps: GoogleDeps,
  account: ConnectedAccount,
  token: string,
  setting: AccountPolicy | null,
  fields: MailFields,
  attachments: readonly MailAttachment[],
  summary: string,
  threadId?: string,
): Promise<ActionOutcome> {
  const f = deps.fetchFn;
  const raw = rawMessage(buildMime(fields, attachments));
  if (setting === "autonomous") {
    const sent = await sendGmailMessage(token, raw, f, threadId);
    return { kind: "result", result: { status: "sent", messageId: sent.id, to: fields.to, cc: fields.cc }, log: { summary } };
  }
  // With approval, the Gmail draft IS the draft: the person may open Gmail
  // and edit it; the card's fingerprint is what Send compares against.
  const d = await createGmailDraft(token, raw, f, threadId);
  // The card shows, and fingerprints, the text part as built — signature
  // included — which is what re-reading the Gmail draft gives back.
  const { signature: _sig, inReplyTo: _irt, references: _ref, ...shown } = fields;
  const content: MailContent = { to: shown.to, cc: shown.cc, bcc: shown.bcc, subject: shown.subject, body: mailPlainBody(fields), attachments: attachments.map((a) => a.name) };
  const payload: MailPayload = { kind: "mail", from: account.label, ...content, gmailDraftId: d.id, fingerprint: mailFingerprint(content) };
  return { kind: "pending", action: "gmail.send", payload, summary, result: { to: fields.to, cc: fields.cc } };
}

const scopeNote = (scope: EventPayload["scope"]) => (scope === "series" ? " (whole series)" : scope === "occurrence" ? " (this occurrence)" : "");

function targetLine(t: MailTarget): string {
  if ("threadId" in t) return `thread ${t.threadId}`;
  return `${t.ids.length} message${t.ids.length === 1 ? "" : "s"} (${t.ids.slice(0, 10).join(", ")}${t.ids.length > 10 ? ", …" : ""})`;
}

export type ApprovalOutcome =
  | { kind: "done"; link?: string }
  /** Nothing was attempted — the token could not be renewed, or Gmail could not
   *  be read — so nothing left the account: the card stays, to be clicked again. */
  | { kind: "retry"; reason: string }
  /** The Gmail draft is not what the card showed: the card is refreshed and asks again. */
  | { kind: "changed"; payload: MailPayload | EditPayload; summary: string; reason?: string }
  /** The Gmail draft is no longer there — deleted in Gmail, or sent from
   *  Gmail by the person: the two are not told apart. Nothing left to send. */
  | { kind: "gone" };

export const RESTORED_SENTENCE = "That file is no longer in the bin — someone restored it already. Nothing was changed.";
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
    // A restore is for a file IN the bin, which `getFileMeta` does not see.
    if (p.kind === "file" && p.op === "drive.untrash") {
      const st = await getFileState(token, p.fileId, deps.fetchFn);
      if (st && !st.trashed) throw new GoogleInputError(RESTORED_SENTENCE);
      file = st;
    } else if (p.kind === "file" || p.kind === "edit") file = await getFileMeta(token, p.fileId, deps.fetchFn);
  } catch (e) {
    if (retryable(e)) return { kind: "retry", reason: RETRY_SENTENCE };
    throw e;
  }
  if (p.kind === "edit") {
    if (!file) throw new GoogleInputError(FILE_GONE_SENTENCE);
    if ((file.modifiedTime ?? "") !== p.stamp) {
      // Someone edited the file since the card: NOT applied. The card is
      // refreshed against the file as it is now and asks again — the same
      // cycle as an email edited in Gmail.
      let state: EditState;
      try {
        state = await editState(token, p.app, p.fileId, deps.fetchFn);
      } catch (e) {
        if (retryable(e)) return { kind: "retry", reason: RETRY_SENTENCE };
        throw e;
      }
      buildEditRequests(p.app, p.ops, state);
      const next: EditPayload = { ...p, name: file.name, ...(file.link ? { link: file.link } : {}), owners: file.owners, ops: annotateOps(p.app, p.ops, state), stamp: file.modifiedTime ?? "", moved: true };
      return { kind: "changed", payload: next, summary: editSummary(next), reason: FILE_MOVED_SENTENCE };
    }
    await applyEdit(token, p.app, p.fileId, p.ops, deps.fetchFn, true);
    const link = file.link ?? p.link;
    return { kind: "done", ...(link ? { link } : {}) };
  }
  if (p.kind === "file") {
    if (!file) throw new GoogleInputError(FILE_GONE_SENTENCE);
    // A bin / move / rename is for the file AS THE CARD SHOWED IT: renamed or
    // moved since, the person approved something else.
    // So is an upload waiting at the top of the Drive (renamed or moved there
    // by the person since, it is theirs now), and a file to bring back.
    const manage = p.op === "drive.delete" || p.op === "drive.move" || p.op === "drive.rename" || p.op === "drive.upload" || p.op === "drive.untrash";
    if (manage && (file.name !== p.name || (file.parentId ?? "") !== (p.parentId ?? ""))) throw new GoogleInputError(FILE_CHANGED_SENTENCE);
    const r = await applyFileEdit(token, p.fileId, p, deps.fetchFn, true);
    if (r.copy) {
      // Approving the copy is not approving every later edit of it: own only
      // when nobody else can see it (`copyIsPrivate`).
      if (r.copy.private) deps.ownFiles.add(account.id, r.copy.id);
      return { kind: "done", ...(r.copy.link ? { link: r.copy.link } : {}) };
    }
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
    // Attendee changes are re-applied to the guest list as it is NOW
    // (`patchEvent` → `mergeAttendees`): an answer that came in since the
    // card is kept, never overwritten by the card's snapshot.
    const e = await patchEvent(token, p.calendarId, p.eventId ?? "", (p.patch ?? {}) as EventPatch, deps.fetchFn);
    return { kind: "done", ...(e.link ? { link: e.link } : {}) };
  }
  if (p.op === "respond") {
    const e = await respondEvent(token, p.calendarId, p.eventId ?? "", p.response ?? "accepted", deps.fetchFn);
    return { kind: "done", ...(e.link ? { link: e.link } : {}) };
  }
  await deleteEvent(token, p.calendarId, p.eventId ?? "", deps.fetchFn);
  return { kind: "done" };
}

/** Discard on an email card deletes the Gmail draft too; on an upload card it
 *  bins the file that waited, private, at the top of the Drive. Best effort: a draft
 *  that outlives its card is a stray draft in the person's own Gmail. True
 *  when there is nothing left behind. */
export async function discardGoogleDraft(deps: GoogleDeps, account: ConnectedAccount, draft: Pick<Draft, "payload">): Promise<boolean> {
  const p = draft.payload;
  if (p?.kind === "file" && p.op === "drive.upload") {
    // The upload waiting at the top of the Drive goes to the BIN (restorable)
    // — unless the person already took it over (renamed or moved it).
    try {
      const token = await deps.token(account.id);
      const now = await getFileMeta(token, p.fileId, deps.fetchFn);
      if (!now) return true;
      if (now.name !== p.name || (now.parentId ?? "") !== (p.parentId ?? "")) return true;
      await trashFile(token, p.fileId, deps.fetchFn);
      return true;
    } catch {
      return false;
    }
  }
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
