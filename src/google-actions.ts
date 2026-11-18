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
import { annotateOps, buildEditRequests, docHeadings, docState, editOpCounts, editOpsVerdict, editPlan, sheetState, slidesState, translateEditError, type EditApp, type EditOp, type EditState, type SlidesCreated } from "./google-edits.js";
import {
  GoogleError,
  GoogleInputError,
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
 * - `mail`: sends email — the account's MAIL setting.
 * - `calendar`: creates, changes or deletes an event, with or without
 *   attendees — the account's CALENDAR setting.
 */
export type GoogleActionClass = "read" | "own-write" | "file-write" | "file-manage" | "file-copy" | "mail" | "calendar";

export const GOOGLE_ACTIONS = {
  "calendar.list": { class: "read", area: "calendar" },
  "drive.list": { class: "read", area: "drive" },
  "doc.read": { class: "read", area: "drive" },
  "sheet.read": { class: "read", area: "drive" },
  "gmail.search": { class: "read", area: "gmail_read", audit: true },
  "gmail.read": { class: "read", area: "gmail_read", audit: true },
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
  "calendar.create": { class: "calendar", area: "calendar" },
  "calendar.update": { class: "calendar", area: "calendar" },
  "calendar.delete": { class: "calendar", area: "calendar" },
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
const REFUSED = /^(drive|doc|sheet|file)\.(share|unshare|permission|permissions|purge|destroy|erase|emptytrash|empty-trash)$/;
export const DRIVE_REFUSED_SENTENCE =
  "Not available to agents: changing who a Drive file is shared with, and deleting one for good or emptying the bin. `drive delete` moves a file to the bin, where the person can restore it — the rest is for the person to do in Drive.";

/** Is this an action we know, on an area Google GRANTED to this account? */
export function actionVerdict(
  account: Pick<ConnectedAccount, "scopes" | "label" | "owner">,
  action: unknown,
): { ok: true; action: GoogleAction } | { ok: false; status: number; reason: string } {
  if (typeof action === "string" && REFUSED.test(action)) return { ok: false, status: 403, reason: DRIVE_REFUSED_SENTENCE };
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
  writeFile: (fileName: string, bytes: Buffer) => Promise<string>;
  /** The Drive files `doc create` / `sheet create` made for an account,
   *  oldest first — what tells the cockpit's own files from the rest of a Drive. */
  ownFiles: { has: (accountId: string, fileId: string) => boolean; add: (accountId: string, fileId: string) => void; list: (accountId: string) => readonly string[] };
}

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
    // A read event is always "default" when it has no colour of its own; the
    // card names the colour only when it says something — an own colour, or
    // an update that takes one away.
    ...(e.color && (e.color !== "default" || extra.patch?.color === "default") ? { color: e.color } : {}),
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
      // The headings are what `doc edit` can insert after.
      const headings = docHeadings(st);
      const text = st.paragraphs.map((p) => p.text).join("").replace(/\uFFFC/g, "");
      if (!meta) return { kind: "result", result: { id, name: st.title, text, headings } };
      const cut = truncateBody(text.replace(/\s+$/, ""), MAX_FILE_CHARS);
      return { kind: "result", result: { file: meta, kind: "text", text: cut.body, headings, truncated: cut.truncated, untrusted: true }, log: { summary: `file ${meta.id} — "${meta.name.slice(0, 200)}"`, ...(meta.link ? { link: meta.link } : {}) } };
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
      const slides = st.slides.map((s) => ({
        ...s,
        elements: s.elements.map((e) => {
          const t = e.text.replace(/\n$/, "");
          const kept = [...t].slice(0, Math.max(0, left)).join("");
          left -= kept.length;
          if (kept.length < t.length) truncated = true;
          return { ...e, text: kept };
        }),
      }));
      // Always untrusted: a deck's text is whatever anyone typed into it.
      const file = meta ?? { id, name: st.title, mimeType: MIME_SLIDES, owners: [] };
      return { kind: "result", result: { file, kind: "slides", slides, layouts, truncated, untrusted: true }, ...(meta ? { log: { summary: `file ${meta.id} — "${meta.name.slice(0, 200)}"`, ...(meta.link ? { link: meta.link } : {}) } } : {}) };
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
      const token = await deps.token(account.id);
      // A reply goes in the original's conversation. Finding the original's
      // ids means READING a message, which only `gmail_read` may do.
      const replyTo = str(args.replyTo);
      let threadId: string | undefined;
      if (replyTo) {
        if (!areaHeld(account, "gmail_read")) {
          throw new GoogleInputError(`Replying in a thread needs Read Gmail access, which Google account '${account.label}' was connected without — ${account.owner} can reconnect it and tick Read Gmail. Without it, send a new email instead.`);
        }
        const t = await replyTarget(token, replyTo, f);
        fields.inReplyTo = t.inReplyTo;
        fields.references = t.references;
        threadId = t.threadId;
      }
      // The person's signature, which Gmail never adds to mail an API creates.
      // Reading it is reading their settings: `gmail_read` (gmail.readonly).
      if (args.signature === true) {
        if (!areaHeld(account, "gmail_read")) {
          throw new GoogleInputError(`Adding the Gmail signature needs Read Gmail access, which Google account '${account.label}' was connected without — ${account.owner} can reconnect it and tick Read Gmail. Without it, write the signature into the body yourself.`);
        }
        const sig = await gmailSignature(token, f);
        if (!sig) throw new GoogleInputError(`Google account '${account.label}' has no Gmail signature set — nothing to add. Send without --signature, or ask ${account.owner} to set one in Gmail's settings.`);
        fields.signature = sig;
      }
      const raw = rawMessage(buildMime(fields, attachments));
      const summary = mailSummary(fields) + (replyTo ? " (reply)" : "") + (fields.signature ? " (signed)" : "");
      if (action === "gmail.draft") {
        const d = replace ? await updateGmailDraft(token, replace, raw, f, threadId) : await createGmailDraft(token, raw, f, threadId);
        if (!replace) deps.ownGmailDrafts.add(account.id, d.id);
        return { kind: "result", result: { draftId: d.id, status: "draft" }, log: { summary: `draft ${summary}` } };
      }
      if (setting === "autonomous") {
        const sent = await sendGmailMessage(token, raw, f, threadId);
        return { kind: "result", result: { status: "sent", messageId: sent.id }, log: { summary } };
      }
      // With approval, the Gmail draft IS the draft: the person may open Gmail
      // and edit it; the card's fingerprint is what Send compares against.
      const d = await createGmailDraft(token, raw, f, threadId);
      // The card shows, and fingerprints, the text part as built — signature
      // included — which is what re-reading the Gmail draft gives back.
      const { signature: _sig, ...shown } = fields;
      const content: MailContent = { ...shown, body: mailPlainBody(fields), attachments: names };
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
    const e = await patchEvent(token, p.calendarId, p.eventId ?? "", (p.patch ?? {}) as Partial<EventFields>, deps.fetchFn);
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
