import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { instanceKey } from "./paths.js";
import { isBrowserPerson } from "./agent-principal.js";
import { isAgentViewer, type Group, type Viewer } from "./groups.js";
import { accountDeadline, accountLapsed, accountVisible, resolveAccountId, type AccountProvider, type ConnectedAccount } from "./connected-accounts.js";
import { LinkedInError, PostOutcomeUnknownError, postTextVerdict } from "./linkedin.js";
import { GoogleError, GoogleInputError, GoogleOutcomeUnknownError } from "./google.js";

/**
 * Drafts, the approval gate, and the publication log. An agent asks for an
 * ACTION that leaves a connected account — a LinkedIn post, an email, a
 * calendar change; under `approve` the server keeps a DRAFT a person must
 * approve from the browser, under `autonomous` it acts at once. A draft
 * carries `{provider, action, payload}` and the publish step dispatches on it;
 * one written before those fields existed is a LinkedIn post. Pure rules up
 * top, thin fs below. The token never appears in anything this file builds.
 * Design: docs/superpowers/specs/2026-11-08-connected-accounts-linkedin-design.md §4–5,
 * docs/superpowers/specs/2026-11-13-connected-accounts-google-design.md §4–5.
 */

export const DRAFT_TTL_MS = 7 * 24 * 3600_000;

/** `gone`: the Gmail draft behind the card was deleted in Gmail — nothing left to send. */
export type DraftStatus = "pending" | "publishing" | "published" | "discarded" | "expired" | "failed" | "gone";

/** What an email approval card holds. The Gmail draft IS the draft: `gmailDraftId`
 *  names it, `fingerprint` is the hash of what the card shows (`mailFingerprint`). */
export interface MailPayload {
  kind: "mail";
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Attachment NAMES; the bytes are in the Gmail draft, read once at draft time. */
  attachments: string[];
  gmailDraftId: string;
  fingerprint: string;
  /** The person changed the draft in Gmail after the agent wrote it. */
  edited?: boolean;
}

/** What a calendar approval card holds: the event as it will be (create,
 *  update) or as it is (delete), and for an update the fields that change. */
export interface EventPayload {
  kind: "event";
  op: "create" | "update" | "delete";
  calendarId: string;
  eventId?: string;
  title: string;
  start: string;
  end: string;
  timeZone?: string;
  attendees: string[];
  location?: string;
  description?: string;
  /** update only: exactly what is sent to Google. */
  patch?: Record<string, unknown>;
}

/** What a Drive-edit approval card holds: the file (name and link as they
 *  were when the agent asked) and EXACTLY what will be written into it. Only
 *  for a file the cockpit did not create — its own files are edited at once. */
export interface FilePayload {
  kind: "file";
  op: "doc.append" | "sheet.append" | "sheet.update" | "drive.delete" | "drive.move" | "drive.rename";
  fileId: string;
  /** The file's name and folder WHEN THE CARD WAS MADE; a bin / move / rename
   *  is applied only if both are still the same. */
  name: string;
  link?: string;
  owners: string[];
  parentId?: string;
  parentName?: string;
  /** drive.move: where it goes. */
  toId?: string;
  toName?: string;
  /** drive.rename: what it becomes. */
  newName?: string;
  /** doc.append: the text added at the end. */
  text?: string;
  /** sheet.*: the range asked for (absent = the sheet's end) and the rows. */
  range?: string;
  rows?: (string | number | boolean)[][];
}

export type DraftPayload = MailPayload | EventPayload | FilePayload;
export type DraftAction = "post" | "gmail.send" | "calendar.create" | "calendar.update" | "calendar.delete" | FilePayload["op"];
const FILE_ACTIONS: readonly DraftAction[] = ["doc.append", "sheet.append", "sheet.update", "drive.delete", "drive.move", "drive.rename"];
export const isFileAction = (a: DraftAction): boolean => FILE_ACTIONS.includes(a);

export interface Draft {
  id: string;
  sessionId: string;
  accountId: string;
  /** Absent on a draft written before Google existed → "linkedin". */
  provider?: AccountProvider;
  /** Absent → "post". */
  action?: DraftAction;
  /** Google only: what the card shows and the publish step sends. */
  payload?: DraftPayload;
  /** LinkedIn: the post. Google: the one-line summary the LOG keeps (recipients
   *  + subject, title + time) — never a mail body. */
  text: string;
  /** Where the agent's image was — kept for its NAME only. The bytes that go
   *  out are the snapshot's, never this file's (it can change after approval). */
  imagePath?: string;
  /** The server-owned copy taken when the agent drafted (`snapshotPathFor`). */
  imageSnapshot?: string;
  /** sha256 of the snapshot's bytes, checked again at publish. */
  imageSha256?: string;
  status: DraftStatus;
  createdAt: number;
  /** When the draft entered `publishing` (approval time). Staleness of a
   *  stuck publish is measured from here; absent on older drafts → createdAt. */
  publishingAt?: number;
  /** Who started the turn that drafted it — recorded at drafting time, since
   *  the turn running when a person later clicks Publish is a different one.
   *  Absent on drafts written before the field existed → "agent". */
  origin?: DraftOrigin;
  decidedBy?: string;
  postUrl?: string;
  error?: string;
}

export type DraftOrigin = "agent" | "cron";

export type Verdict = { ok: true } | { ok: false; status: number; reason: string };

const refuse = (status: number, reason: string): Verdict => ({ ok: false, status, reason });

// ---- sentences -----------------------------------------------------------

export const draftProvider = (d: Pick<Draft, "provider">): AccountProvider => (d.provider === "google" ? "google" : "linkedin");
export const draftAction = (d: Pick<Draft, "action">): DraftAction => d.action ?? "post";

/** What a draft is called in a sentence. */
export function draftNoun(d: Pick<Draft, "provider" | "action">): string {
  const a = draftAction(d);
  if (a === "gmail.send") return "email";
  if (a.startsWith("calendar.")) return "calendar change";
  if (isFileAction(a)) return "Drive edit";
  return "LinkedIn draft";
}
const accountNoun = (p: AccountProvider) => (p === "google" ? "Google account" : "LinkedIn account");

export const DISCONNECTED_SENTENCE = "The LinkedIn account this draft was for has been disconnected.";
export const BEING_PUBLISHED_SENTENCE = "This draft is being published.";
export const DRAFT_EXPIRED_SENTENCE = "This draft expired after 7 days without approval — it was not published.";
export const notSharedWithApprover = (p: AccountProvider) => `That ${accountNoun(p)} is not shared with you.`;
export const drafterNotAllowed = (p: AccountProvider) => `That ${accountNoun(p)} is no longer shared with the agent that drafted this${p === "google" ? "" : " post"}.`;
export const disconnectedSentence = (p: AccountProvider) => `The ${accountNoun(p)} this draft was for has been disconnected.`;
export const NOT_SHARED_WITH_APPROVER = notSharedWithApprover("linkedin");
export const DRAFTER_NOT_ALLOWED = drafterNotAllowed("linkedin");
export const NOT_SHARED_WITH_AGENT = "That account is not shared with this agent.";
export const AGENT_CANNOT_APPROVE = "Only a person can approve a LinkedIn post, from the cockpit.";
/** The same rule for an email or a calendar change. */
export const AGENT_CANNOT_APPROVE_ACTION = "Only a person can approve this, from the cockpit.";
const agentCannotApprove = (d: Pick<Draft, "provider">) => (draftProvider(d) === "google" ? AGENT_CANNOT_APPROVE_ACTION : AGENT_CANNOT_APPROVE);
export const SESSION_NOT_VISIBLE = "This draft belongs to an agent you cannot see.";
export const POST_OUTCOME_UNKNOWN_SENTENCE = "LinkedIn did not answer in time — check LinkedIn before retrying, the post may have gone out.";
export const IMAGE_GONE_SENTENCE = "The draft's image is gone — ask the agent to draft again.";
export const GOOGLE_OUTCOME_UNKNOWN_SENTENCE = "Google did not answer in time — check Gmail's Sent folder or the calendar before retrying, it may have gone through.";
export const GOOGLE_FAILED_SENTENCE = "Google was not reached or did not answer. Try again later.";
export const EDITED_IN_GMAIL_SENTENCE = "Edited in Gmail since — send this version?";
// A draft that is no longer there was deleted in Gmail OR sent from Gmail by
// the person: Gmail answers the same for both, so the sentence claims neither.
export const GONE_IN_GMAIL_SENTENCE = "This draft is no longer in Gmail — deleted there, or already sent from Gmail. The cockpit sent nothing.";
export const PUBLISH_FAILED_SENTENCE = "The post could not be published — LinkedIn was not reached or did not answer. Try again later.";

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Is the account unusable because its authorisation has lapsed (by date, or
 *  the provider refused it)? For Google the date is the refresh token's. */
export function accountExpired(a: ConnectedAccount, now: number): boolean {
  return accountLapsed(a, now);
}

/**
 * The expiry sentence. When LinkedIn refused the token BEFORE its expiry date
 * (a revoked grant), the date shown is when we learnt it — the 401 path stamps
 * `updatedAt` as it sets `status: "expired"` — not a date still in the future.
 */
export function expirySentence(a: ConnectedAccount, now: number): string {
  if (a.provider === "google") {
    // A deadline means a Testing app: say why it lapses every week.
    const why = accountDeadline(a) !== null ? " (test app authorisations last 7 days)" : "";
    return `Google account '${a.label}' needs a reconnect${why} — ${a.owner} can do it in Secrets → Connected accounts.`;
  }
  const when = a.expiresAt <= now ? a.expiresAt : Math.min(a.updatedAt, now);
  return `LinkedIn account '${a.label}' expired on ${shortDate(when)} — ${a.owner} must reconnect it in Secrets → Connected accounts.`;
}

// ---- the agent's request -------------------------------------------------

/**
 * `POST /social/posts`, everything but the image: which account, may this
 * agent use it, is it alive, is the text postable. A restricted-peer agent
 * never sees any account (`accountVisible`'s peerBox).
 */
export function postRequestVerdict(
  accounts: readonly ConnectedAccount[],
  accountArg: unknown,
  text: unknown,
  viewer: Viewer | null,
  groups: readonly Group[],
  peerBox: string | null,
  now: number,
  agentsUnwalled = false,
  agentProfile: string | null = null,
): { ok: true; account: ConnectedAccount } | { ok: false; status: number; reason: string; account?: ConnectedAccount } {
  const u = usableAccountVerdict(accounts, "linkedin", accountArg, viewer, groups, peerBox, now, agentsUnwalled, agentProfile);
  if (!u.ok) return u;
  const hit = u.account;
  if (typeof text !== "string") return { ok: false, status: 400, reason: "The post is empty.", account: hit };
  const tv = postTextVerdict(text);
  if (!tv.ok) return { ok: false, status: 400, reason: tv.reason, account: hit };
  return { ok: true, account: hit };
}

/**
 * Which account of `provider` an agent's request names, and may it use it:
 * resolved by unique id prefix (invariant 17), visible to the agent, alive.
 * Only that provider's accounts are considered — a Google id handed to the
 * LinkedIn route matches nothing. A restricted-peer agent never sees any.
 */
export function usableAccountVerdict(
  all: readonly ConnectedAccount[],
  provider: AccountProvider,
  accountArg: unknown,
  viewer: Viewer | null,
  groups: readonly Group[],
  peerBox: string | null,
  now: number,
  agentsUnwalled = false,
  agentProfile: string | null = null,
): { ok: true; account: ConnectedAccount } | { ok: false; status: number; reason: string; account?: ConnectedAccount } {
  const label = provider === "google" ? "Google" : "LinkedIn";
  const script = provider === "google" ? "google.mjs" : "social.mjs";
  const accounts = all.filter((a) => a.provider === provider);
  const arg = typeof accountArg === "string" ? accountArg.trim() : "";
  const visible = accounts.filter((a) => accountVisible(a, viewer, groups, { peerBox, agentsUnwalled, agentProfile }));
  let hit = resolveAccountId(accounts, arg);
  // An account the agent cannot see answers like one that does not exist — but
  // only when it would not have matched otherwise; a hit it may not use says so.
  const none = { ok: false as const, status: 404, reason: `No ${label} account matches '${arg}'. Run \`${script} accounts\` to list yours.` };
  if (hit === "none") return none;
  if (hit === "ambiguous") {
    const vis = resolveAccountId(visible, arg);
    if (vis === "none") return none;
    if (vis === "ambiguous") return { ok: false, status: 409, reason: `Several ${label} accounts match '${arg}' — give more characters.` };
    hit = vis;
  }
  if (!visible.includes(hit)) return { ok: false, status: 403, reason: NOT_SHARED_WITH_AGENT };
  // From here on the agent may use the account, so a refusal is a refused
  // action on it and is logged: the account rides along for the route.
  if (accountExpired(hit, now)) return { ok: false, status: 409, reason: expirySentence(hit, now), account: hit };
  return { ok: true, account: hit };
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };

/** The MIME LinkedIn will accept for this path, or null (PNG, JPEG, GIF only). */
export function imageMimeFor(p: string): string | null {
  return IMAGE_MIME[path.extname(p).toLowerCase()] ?? null;
}

/** The image argument, before any disk access: absolute, and a type LinkedIn takes. */
export function imagePathVerdict(p: unknown): { ok: true; path: string; mime: string } | { ok: false; reason: string } {
  if (typeof p !== "string" || !p.trim()) return { ok: false, reason: "The image must be an absolute path to a file." };
  if (!path.isAbsolute(p)) return { ok: false, reason: `The image must be an absolute path, not '${p}'.` };
  const mime = imageMimeFor(p);
  if (!mime) return { ok: false, reason: `LinkedIn accepts PNG, JPEG or GIF images, not '${path.basename(p)}'.` };
  return { ok: true, path: p, mime };
}

// ---- the approval gate ---------------------------------------------------

/**
 * Who may click Publish / Discard: a browser PERSON (`isBrowserPerson`) whose
 * resolved account is not an agent. The route builds the inputs exactly as
 * `requestFromBrowser` does, so an agent key, a peer token, a missing person
 * cookie or a foreign origin all refuse here — an agent can never reach
 * `publishVerdict` as the approver.
 */
export function approvalCaller(o: {
  hasAgentKey: boolean;
  hasPeerToken: boolean;
  passwordSet: boolean;
  personCookie: boolean;
  sameOrigin: boolean;
  account: { name: string; agent?: unknown } | null;
}): { ok: true; person: string } | { ok: false; status: number; reason: string } {
  if (!isBrowserPerson(o)) return { ok: false, status: 403, reason: "web UI only" };
  if (!o.account) return { ok: false, status: 401, reason: "Sign in to approve a LinkedIn post." };
  if (o.account.agent) return { ok: false, status: 403, reason: AGENT_CANNOT_APPROVE };
  return { ok: true, person: o.account.name };
}

/** The refusal for a draft that is no longer pending, or null when it is. */
function notPending(d: Draft, now: number): Verdict | null {
  switch (d.status) {
    case "published":
      return refuse(409, draftProvider(d) === "google" ? "Already done." : `Already published: ${d.postUrl ?? ""}`.trimEnd());
    case "publishing":
      return refuse(409, BEING_PUBLISHED_SENTENCE);
    case "discarded":
      return refuse(409, `This draft was discarded${d.decidedBy ? ` by ${d.decidedBy}` : ""}.`);
    case "expired":
      return refuse(409, DRAFT_EXPIRED_SENTENCE);
    case "failed":
      return refuse(409, `This draft could not be published${d.error ? `: ${d.error}` : "."} Ask the agent to draft it again.`);
    case "gone":
      return refuse(409, GONE_IN_GMAIL_SENTENCE);
  }
  if (now - d.createdAt >= DRAFT_TTL_MS) return refuse(409, DRAFT_EXPIRED_SENTENCE);
  return null;
}

/**
 * May `viewer` publish this draft NOW? Re-checked at click time against the
 * account as it is today, not as it was when the agent drafted: an account
 * unshared, disconnected or expired since then refuses. `sessionVisible` is
 * the route's `mayActFor(req, draft.sessionId)`: a draft is its agent's
 * content, behind the same group boundary as /download.
 */
export function publishVerdict(
  draft: Draft,
  account: ConnectedAccount | undefined,
  viewer: Viewer | null,
  groups: readonly Group[],
  now: number,
  sessionVisible: boolean,
  agentsUnwalled = false,
  /** The drafting agent as it is now; omitted = not re-checked (tests of the person rules). */
  drafter?: { viewer: Viewer | null; peerBox: string | null; profile: string | null },
): Verdict {
  const provider = draftProvider(draft);
  if (!viewer || isAgentViewer(viewer)) return refuse(403, agentCannotApprove(draft));
  if (!sessionVisible) return refuse(403, SESSION_NOT_VISIBLE);
  const np = notPending(draft, now);
  if (np) return np;
  if (!account) return refuse(410, disconnectedSentence(provider));
  // The drafting agent, read at click time: a share narrowed after the draft
  // (a group dropped, a profile filter added) refuses it.
  if (drafter && !accountVisible(account, drafter.viewer, groups, { peerBox: drafter.peerBox, agentsUnwalled, agentProfile: drafter.profile }))
    return refuse(403, drafterNotAllowed(provider));
  // The approver is a person: `agentsUnwalled` never widens what they see.
  if (!accountVisible(account, viewer, groups, { peerBox: null, agentsUnwalled })) return refuse(403, notSharedWithApprover(provider));
  if (accountExpired(account, now)) return refuse(409, expirySentence(account, now));
  return { ok: true };
}

/**
 * May `viewer` discard it? Same person rule, and the draft must still be
 * pending — but a disconnected or expired account does not block a discard:
 * throwing away a post that can no longer go out is exactly what is left to do.
 */
export function discardVerdict(
  draft: Draft,
  account: ConnectedAccount | undefined,
  viewer: Viewer | null,
  groups: readonly Group[],
  now: number,
  sessionVisible: boolean,
  agentsUnwalled = false,
): Verdict {
  if (!viewer || isAgentViewer(viewer)) return refuse(403, agentCannotApprove(draft));
  // The session is the boundary that still holds when the account is gone.
  if (!sessionVisible) return refuse(403, SESSION_NOT_VISIBLE);
  const np = notPending(draft, now);
  if (np) return np;
  if (account && !accountVisible(account, viewer, groups, { peerBox: null, agentsUnwalled })) return refuse(403, notSharedWithApprover(draftProvider(draft)));
  return { ok: true };
}

/**
 * What a refused click on a still-pending draft is logged as: past its TTL it
 * EXPIRED (nobody refused anything), otherwise the account refused it. Null for
 * a click that is not a refused publication at all — a decided draft, or a
 * person who may not see the agent — which is not logged.
 */
export function refusalLogOutcome(draft: Draft, reason: string, now: number): "expired" | "refused" | null {
  if (draft.status !== "pending" || reason === SESSION_NOT_VISIBLE || reason === AGENT_CANNOT_APPROVE || reason === AGENT_CANNOT_APPROVE_ACTION) return null;
  return now - draft.createdAt >= DRAFT_TTL_MS ? "expired" : "refused";
}

/** Pending drafts past the TTL become `expired`; the rest are untouched. */
export function expireDrafts(list: readonly Draft[], now: number): { list: Draft[]; expired: Draft[] } {
  const expired: Draft[] = [];
  const out = list.map((d) => {
    if (d.status !== "pending" || now - d.createdAt < DRAFT_TTL_MS) return d;
    const e: Draft = { ...d, status: "expired" };
    expired.push(e);
    return e;
  });
  return { list: out, expired };
}

// ---- a failed publish ----------------------------------------------------

/** A publish refused before LinkedIn was called (the image), in our own words. */
export class PublishInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishInputError";
  }
}

/**
 * What a failed publish means. LinkedIn's 401 (Review Focus 4) — even before
 * `expiresAt` — means the token is dead: the caller saves `accountPatch` so
 * every later publish refuses with the reconnect sentence instead of calling
 * LinkedIn again. Any other LinkedIn refusal relays LinkedIn's message (the
 * client builds it token-free); our own input refusal relays ours; anything
 * else (a network error, a bug) gets a generic sentence — its message is not
 * ours to vouch for.
 */
export function failureOutcome(
  err: unknown,
  account: ConnectedAccount,
  now: number,
): { accountPatch?: { status: "expired"; updatedAt: number }; reason: string; httpStatus: number } {
  if (err instanceof LinkedInError && err.expired) {
    const accountPatch = { status: "expired" as const, updatedAt: now };
    return { accountPatch, reason: expirySentence({ ...account, ...accountPatch }, now), httpStatus: 409 };
  }
  if (err instanceof LinkedInError) return { reason: err.message || "LinkedIn did not accept the post.", httpStatus: 502 };
  // Google: a dead grant (`invalid_grant` at refresh, a 401 on a fresh token)
  // marks the account expired the same way; a disconnected one (410) does not.
  if (err instanceof GoogleError && err.expired) {
    const accountPatch = { status: "expired" as const, updatedAt: now };
    return { accountPatch, reason: expirySentence({ ...account, ...accountPatch }, now), httpStatus: 409 };
  }
  if (err instanceof GoogleError) return { reason: err.message || "Google did not accept the request.", httpStatus: err.status === 410 ? 410 : 502 };
  if (err instanceof GoogleInputError) return { reason: err.message, httpStatus: 400 };
  if (err instanceof GoogleOutcomeUnknownError) return { reason: GOOGLE_OUTCOME_UNKNOWN_SENTENCE, httpStatus: 502 };
  if (account.provider === "google") return { reason: GOOGLE_FAILED_SENTENCE, httpStatus: 502 };
  if (err instanceof PublishInputError) return { reason: err.message, httpStatus: 400 };
  // Only the createPost call raises this: the post may exist, so "try again
  // later" would invite a duplicate.
  if (err instanceof PostOutcomeUnknownError) return { reason: POST_OUTCOME_UNKNOWN_SENTENCE, httpStatus: 502 };
  return { reason: PUBLISH_FAILED_SENTENCE, httpStatus: 502 };
}

// ---- building drafts and log entries ------------------------------------

/** A new pending draft; `origin` is the drafting turn's, fixed now. */
export function makeDraft(o: {
  id: string;
  sessionId: string;
  accountId: string;
  text: string;
  imagePath?: string;
  imageSnapshot?: string;
  imageSha256?: string;
  origin: DraftOrigin;
  now: number;
  provider?: AccountProvider;
  action?: DraftAction;
  payload?: DraftPayload;
}): Draft {
  return {
    id: o.id,
    sessionId: o.sessionId,
    accountId: o.accountId,
    ...(o.provider && o.provider !== "linkedin" ? { provider: o.provider } : {}),
    ...(o.action && o.action !== "post" ? { action: o.action } : {}),
    ...(o.payload ? { payload: o.payload } : {}),
    text: o.text,
    ...(o.imagePath ? { imagePath: o.imagePath } : {}),
    ...(o.imageSnapshot ? { imageSnapshot: o.imageSnapshot } : {}),
    ...(o.imageSha256 ? { imageSha256: o.imageSha256 } : {}),
    status: "pending",
    createdAt: o.now,
    origin: o.origin,
  };
}

/** The drafting turn's origin; a draft from before the field → "agent". */
export function draftOrigin(d: Draft): DraftOrigin {
  return d.origin === "cron" ? "cron" : "agent";
}

/** The log entry for a person's decision on a draft — origin from the DRAFT. */
export function draftLogEntry(
  d: Draft,
  o: { at: number; channel?: string; approvedBy: string; outcome: LogEntry["outcome"]; postUrl?: string; error?: string },
): LogEntry {
  return {
    at: o.at,
    accountId: d.accountId,
    sessionId: d.sessionId,
    ...(o.channel ? { channel: o.channel } : {}),
    origin: draftOrigin(d),
    approvedBy: o.approvedBy,
    ...(d.action && d.action !== "post" ? { action: d.action } : {}),
    text: d.text,
    outcome: o.outcome,
    ...(o.postUrl ? { postUrl: o.postUrl } : {}),
    ...(o.error ? { error: o.error } : {}),
  };
}

// ---- what clients and the agent see -------------------------------------

export interface DraftView {
  id: string;
  sessionId: string;
  accountId: string;
  account: string;
  provider: AccountProvider;
  action: DraftAction;
  text: string;
  image?: unknown;
  /** Google: the email or the event the card shows — exactly what will go out. */
  mail?: Omit<MailPayload, "kind" | "gmailDraftId" | "fingerprint">;
  event?: Omit<EventPayload, "kind" | "patch">;
  file?: Omit<FilePayload, "kind">;
  status: DraftStatus;
  createdAt: number;
  decidedBy?: string;
  postUrl?: string;
  error?: string;
}

function payloadView(p: DraftPayload | undefined): Pick<DraftView, "mail" | "event" | "file"> {
  if (!p) return {};
  if (p.kind === "file") {
    return {
      file: {
        op: p.op,
        fileId: p.fileId,
        name: p.name,
        ...(p.link ? { link: p.link } : {}),
        owners: [...p.owners],
        ...(p.parentId ? { parentId: p.parentId } : {}),
        ...(p.parentName ? { parentName: p.parentName } : {}),
        ...(p.toId ? { toId: p.toId } : {}),
        ...(p.toName ? { toName: p.toName } : {}),
        ...(p.newName ? { newName: p.newName } : {}),
        ...(p.text !== undefined ? { text: p.text } : {}),
        ...(p.range ? { range: p.range } : {}),
        ...(p.rows ? { rows: p.rows.map((r) => [...r]) } : {}),
      },
    };
  }
  if (p.kind === "mail") {
    return { mail: { from: p.from, to: [...p.to], cc: [...p.cc], bcc: [...p.bcc], subject: p.subject, body: p.body, attachments: [...p.attachments], ...(p.edited ? { edited: true } : {}) } };
  }
  return {
    event: {
      op: p.op,
      calendarId: p.calendarId,
      ...(p.eventId ? { eventId: p.eventId } : {}),
      title: p.title,
      start: p.start,
      end: p.end,
      ...(p.timeZone ? { timeZone: p.timeZone } : {}),
      attendees: [...p.attendees],
      ...(p.location ? { location: p.location } : {}),
      ...(p.description ? { description: p.description } : {}),
    },
  };
}

/**
 * The ONLY draft shape sent to a client. Built field by field, so nothing the
 * account carries (its token above all) can ride along. `image` is whatever the
 * caller renders the image as (a file card of the SNAPSHOT) — offered only while
 * the snapshot exists, i.e. while the draft is undecided; afterwards the card
 * names the image and no longer shows it.
 */
export function draftView(d: Draft, account: Pick<ConnectedAccount, "label"> | undefined, image?: unknown): DraftView {
  const live = d.imageSnapshot && !snapshotDone(d);
  return {
    id: d.id,
    sessionId: d.sessionId,
    accountId: d.accountId,
    account: account?.label ?? "(disconnected account)",
    provider: draftProvider(d),
    action: draftAction(d),
    text: d.text,
    ...payloadView(d.payload),
    ...(d.imagePath ? { image: (live && image) || path.basename(d.imagePath) } : {}),
    status: d.status,
    createdAt: d.createdAt,
    ...(d.decidedBy ? { decidedBy: d.decidedBy } : {}),
    ...(d.postUrl ? { postUrl: d.postUrl } : {}),
    ...(d.error ? { error: d.error } : {}),
  };
}

/** What the agent is told once a person decided (hidden prompt text, unmarked). */
export function draftNotice(d: Draft): string | null {
  const id8 = d.id.slice(0, 8);
  if (draftProvider(d) === "google") {
    const what = `Your ${draftNoun(d)} ${id8} (${d.text})`;
    const done = draftAction(d) === "gmail.send" ? "was sent" : "was applied";
    if (d.status === "published") return `${what} ${done}${d.postUrl ? `: ${d.postUrl}` : "."}`;
    if (d.status === "discarded") return `${what} was discarded by ${d.decidedBy ?? "someone"} — nothing left the account.`;
    if (d.status === "failed") return `${what} could not be completed: ${d.error ?? "unknown error"}`;
    if (d.status === "gone") return `${what} is no longer in Gmail: the person deleted it there, or sent it from Gmail themselves. The cockpit sent nothing — ask them before sending it again.`;
    return null;
  }
  if (d.status === "published") return `Your LinkedIn draft ${id8} was published: ${d.postUrl ?? ""}`.trimEnd();
  if (d.status === "discarded") return `Your LinkedIn draft ${id8} was discarded by ${d.decidedBy ?? "someone"}.`;
  if (d.status === "failed") return `Your LinkedIn draft ${id8} could not be published: ${d.error ?? "unknown error"}`;
  return null;
}

/** Exact id wins; else a unique prefix. Empty/blank → none; several → ambiguous (invariant 17). */
export function resolveDraftId(list: readonly Draft[], prefix: string): Draft | "none" | "ambiguous" {
  const p = (prefix ?? "").trim();
  if (!p) return "none";
  const exact = list.find((d) => d.id === p);
  if (exact) return exact;
  const hits = list.filter((d) => d.id.startsWith(p));
  return hits.length === 0 ? "none" : hits.length === 1 ? hits[0] : "ambiguous";
}

export function newDraftId(list: readonly Draft[]): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!list.some((d) => d.id === id)) return id;
  }
}

/** A session's drafts as history turns, oldest first. */
export function sessionDrafts(list: readonly Draft[], sessionId: string): Draft[] {
  return list.filter((d) => d.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
}

// ---- the publication log -------------------------------------------------

export interface LogEntry {
  at: number;
  accountId: string;
  sessionId?: string;
  channel?: string;
  origin: "agent" | "cron" | "person";
  approvedBy: string | "autonomous";
  /** Google: which action (`gmail.send`, `doc.append`…). Absent = a LinkedIn post. */
  action?: string;
  /** LinkedIn: the post. Google: a summary — never a mail body. */
  text: string;
  /** `done`: a Google action carried out (sent, created, appended). */
  outcome: "published" | "done" | "refused" | "failed" | "expired";
  postUrl?: string;
  error?: string;
}

/** Field by field, in a fixed order: an entry can never carry anything else. */
export function serialiseLogEntry(e: LogEntry): string {
  const row: LogEntry = {
    at: e.at,
    accountId: e.accountId,
    ...(e.sessionId ? { sessionId: e.sessionId } : {}),
    ...(e.channel ? { channel: e.channel } : {}),
    origin: e.origin,
    approvedBy: e.approvedBy,
    ...(e.action ? { action: e.action } : {}),
    text: e.text,
    outcome: e.outcome,
    ...(e.postUrl ? { postUrl: e.postUrl } : {}),
    ...(e.error ? { error: e.error } : {}),
  };
  return JSON.stringify(row);
}

/** Append-only, one JSON line, mode 600, directory 700. */
export function appendLog(file: string, e: LogEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, serialiseLogEntry(e) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export const ACCOUNT_LOG_LIMIT = 50;

/**
 * One account's log entries, newest first, at most `limit`. Each line is
 * re-built through `serialiseLogEntry`'s field list, so whatever a line might
 * carry beyond it never reaches a reader; an unparseable line is skipped.
 */
export function accountLog(raw: string, accountId: string, limit = ACCOUNT_LOG_LIMIT): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: LogEntry;
    try {
      e = JSON.parse(line) as LogEntry;
    } catch {
      continue;
    }
    if (!e || typeof e !== "object" || e.accountId !== accountId || typeof e.at !== "number") continue;
    out.push(JSON.parse(serialiseLogEntry(e)) as LogEntry);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** The log as text; a missing file is an empty log. */
export function readLogFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// ---- the image snapshot --------------------------------------------------
// A person approves what the card SHOWS. Were the image re-read from the
// agent's path at publish, the agent could swap the file after the person
// looked at it. So the bytes are copied once, when the agent drafts, into a
// directory only the server writes, and both the card and the publish read
// that copy — checked against its sha256.

export function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

/** `<dir>/<draftId><ext>`. The id is ours (hex), never a path fragment. */
export function snapshotPathFor(dir: string, draftId: string, imagePath: string): string {
  if (!/^[0-9a-f]+$/.test(draftId)) throw new Error("invalid draft id");
  return path.join(dir, `${draftId}${path.extname(imagePath).toLowerCase()}`);
}

/** A decided draft (no Publish left to click) no longer needs its snapshot. */
export function snapshotDone(d: Pick<Draft, "status">): boolean {
  return d.status !== "pending" && d.status !== "publishing";
}

/**
 * The image to publish with this draft: the snapshot's bytes when they are
 * there and match the recorded hash, none when the draft has no image, and a
 * refusal otherwise — including a draft with an image but no snapshot.
 */
export function snapshotBytes(
  d: Pick<Draft, "imagePath" | "imageSnapshot" | "imageSha256">,
  read: (p: string) => Buffer | null,
): { ok: true; image: { bytes: Buffer; mime: string } | null } | { ok: false; reason: string } {
  if (!d.imagePath) return { ok: true, image: null };
  const mime = imageMimeFor(d.imagePath);
  if (!d.imageSnapshot || !d.imageSha256 || !mime) return { ok: false, reason: IMAGE_GONE_SENTENCE };
  const bytes = read(d.imageSnapshot);
  if (!bytes || sha256Hex(bytes) !== d.imageSha256) return { ok: false, reason: IMAGE_GONE_SENTENCE };
  return { ok: true, image: { bytes, mime } };
}

/** Atomic (tmp + rename), mode 600, directory 700. */
export function writeSnapshot(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Missing or unreadable → null. Never throws. */
export function readSnapshot(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Best effort: a snapshot left behind is a stray file, not a failure. */
export function removeSnapshot(file: string | undefined): void {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

// ---- store ---------------------------------------------------------------

function storeDir(): string {
  return path.join(os.homedir(), ".shadok-ai", "connected-accounts");
}

export function draftsFileFor(cwd: string): string {
  return path.join(storeDir(), `${instanceKey(cwd)}.drafts.json`);
}

/** Where draft image snapshots live, per instance. */
export function mediaDirFor(cwd: string): string {
  return path.join(storeDir(), `${instanceKey(cwd)}.media`);
}

export function socialLogFileFor(cwd: string): string {
  return path.join(storeDir(), `${instanceKey(cwd)}.log.jsonl`);
}

// ---- the Drive files the cockpit created (`doc create`, `sheet create`) ---
// Same shape as the Gmail drafts below (accountId → ids). On an account that
// holds the WHOLE Drive, this record — never a guess from the file's own
// properties — is what tells "ours, edited at once" from "someone's file,
// edited under the Drive setting".

export const OWN_FILES_KEPT = 5000;

export function ownFilesFileFor(cwd: string): string {
  return path.join(storeDir(), `${instanceKey(cwd)}.drive-files.json`);
}

// ---- the Gmail drafts an agent made (`gmail draft`) -----------------------
// `gmail draft --update <id>` may only rewrite one of these: Gmail's
// `drafts.update` takes any draft id of the mailbox, the person's own included.

export const OWN_DRAFTS_KEPT = 200;

export function ownDraftsFileFor(cwd: string): string {
  return path.join(storeDir(), `${instanceKey(cwd)}.gmail-drafts.json`);
}

/** accountId → Gmail draft ids, oldest first. Missing or unparseable → {}. */
export function loadOwnDrafts(file: string): Record<string, string[]> {
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(p)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    return out;
  } catch {
    return {};
  }
}

/** The map with one more id for that account, capped to the most recent. */
export function withOwnDraft(map: Readonly<Record<string, string[]>>, accountId: string, draftId: string, kept = OWN_DRAFTS_KEPT): Record<string, string[]> {
  const cur = (map[accountId] ?? []).filter((x) => x !== draftId);
  return { ...map, [accountId]: [...cur, draftId].slice(-kept) };
}

/** Atomic (tmp + rename), mode 600; ids of accounts no longer connected are dropped. */
export function saveOwnDrafts(file: string, map: Readonly<Record<string, string[]>>, liveAccountIds: readonly string[]): void {
  const keep: Record<string, string[]> = {};
  for (const id of liveAccountIds) if (map[id]?.length) keep[id] = map[id];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keep, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Missing or unparseable file → []. Never throws. */
export function loadDrafts(file: string): Draft[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as Draft[]) : [];
  } catch {
    return [];
  }
}

/** Atomic (tmp + rename), mode 600, directory 700. */
export function saveDrafts(file: string, list: readonly Draft[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
