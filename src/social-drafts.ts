import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { instanceKey } from "./paths.js";
import { isBrowserPerson } from "./agent-principal.js";
import { isAgentViewer, type Group, type Viewer } from "./groups.js";
import { accountVisible, resolveAccountId, type ConnectedAccount } from "./connected-accounts.js";
import { LinkedInError, postTextVerdict } from "./linkedin.js";

/**
 * LinkedIn drafts, the approval gate, and the publication log. An agent asks to
 * post; under policy `approve` the server keeps a DRAFT a person must publish
 * from the browser, under `autonomous` it publishes at once. Pure rules up
 * top, thin fs below. The token never appears in anything this file builds.
 * Design: docs/superpowers/specs/2026-11-08-connected-accounts-linkedin-design.md §4–5.
 */

export const DRAFT_TTL_MS = 7 * 24 * 3600_000;

export type DraftStatus = "pending" | "publishing" | "published" | "discarded" | "expired" | "failed";

export interface Draft {
  id: string;
  sessionId: string;
  accountId: string;
  text: string;
  imagePath?: string;
  status: DraftStatus;
  createdAt: number;
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

export const DISCONNECTED_SENTENCE = "The LinkedIn account this draft was for has been disconnected.";
export const BEING_PUBLISHED_SENTENCE = "This draft is being published.";
export const DRAFT_EXPIRED_SENTENCE = "This draft expired after 7 days without approval — it was not published.";
export const NOT_SHARED_WITH_APPROVER = "That LinkedIn account is not shared with you.";
export const NOT_SHARED_WITH_AGENT = "That account is not shared with this agent.";
export const AGENT_CANNOT_APPROVE = "Only a person can approve a LinkedIn post, from the cockpit.";
export const SESSION_NOT_VISIBLE = "This draft belongs to an agent you cannot see.";
export const PUBLISH_FAILED_SENTENCE = "The post could not be published — LinkedIn was not reached or did not answer. Try again later.";

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Is the account unusable because its token has lapsed (by date, or LinkedIn said 401)? */
export function accountExpired(a: ConnectedAccount, now: number): boolean {
  return a.status === "expired" || now >= a.expiresAt;
}

/**
 * The expiry sentence. When LinkedIn refused the token BEFORE its expiry date
 * (a revoked grant), the date shown is when we learnt it — the 401 path stamps
 * `updatedAt` as it sets `status: "expired"` — not a date still in the future.
 */
export function expirySentence(a: ConnectedAccount, now: number): string {
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
): { ok: true; account: ConnectedAccount } | { ok: false; status: number; reason: string } {
  const arg = typeof accountArg === "string" ? accountArg.trim() : "";
  const visible = accounts.filter((a) => accountVisible(a, viewer, groups, { peerBox }));
  const hit = resolveAccountId(accounts, arg);
  // An account the agent cannot see answers like one that does not exist — but
  // only when it would not have matched otherwise; a hit it may not use says so.
  if (hit === "none") return { ok: false, status: 404, reason: `No LinkedIn account matches '${arg}'. Run \`social.mjs accounts\` to list yours.` };
  if (hit === "ambiguous") {
    const vis = resolveAccountId(visible, arg);
    if (vis === "none") return { ok: false, status: 404, reason: `No LinkedIn account matches '${arg}'. Run \`social.mjs accounts\` to list yours.` };
    if (vis === "ambiguous") return { ok: false, status: 409, reason: `Several LinkedIn accounts match '${arg}' — give more characters.` };
    return postRequestVerdict(visible, vis.id, text, viewer, groups, peerBox, now);
  }
  if (!visible.includes(hit)) return { ok: false, status: 403, reason: NOT_SHARED_WITH_AGENT };
  if (accountExpired(hit, now)) return { ok: false, status: 409, reason: expirySentence(hit, now) };
  if (typeof text !== "string") return { ok: false, status: 400, reason: "The post is empty." };
  const tv = postTextVerdict(text);
  if (!tv.ok) return { ok: false, status: 400, reason: tv.reason };
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
      return refuse(409, `Already published: ${d.postUrl ?? ""}`.trimEnd());
    case "publishing":
      return refuse(409, BEING_PUBLISHED_SENTENCE);
    case "discarded":
      return refuse(409, `This draft was discarded${d.decidedBy ? ` by ${d.decidedBy}` : ""}.`);
    case "expired":
      return refuse(409, DRAFT_EXPIRED_SENTENCE);
    case "failed":
      return refuse(409, `This draft could not be published${d.error ? `: ${d.error}` : "."} Ask the agent to draft it again.`);
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
): Verdict {
  if (!viewer || isAgentViewer(viewer)) return refuse(403, AGENT_CANNOT_APPROVE);
  if (!sessionVisible) return refuse(403, SESSION_NOT_VISIBLE);
  const np = notPending(draft, now);
  if (np) return np;
  if (!account) return refuse(410, DISCONNECTED_SENTENCE);
  if (!accountVisible(account, viewer, groups, { peerBox: null })) return refuse(403, NOT_SHARED_WITH_APPROVER);
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
): Verdict {
  if (!viewer || isAgentViewer(viewer)) return refuse(403, AGENT_CANNOT_APPROVE);
  // The session is the boundary that still holds when the account is gone.
  if (!sessionVisible) return refuse(403, SESSION_NOT_VISIBLE);
  const np = notPending(draft, now);
  if (np) return np;
  if (account && !accountVisible(account, viewer, groups, { peerBox: null })) return refuse(403, NOT_SHARED_WITH_APPROVER);
  return { ok: true };
}

/**
 * What a refused click on a still-pending draft is logged as: past its TTL it
 * EXPIRED (nobody refused anything), otherwise the account refused it. Null for
 * a click that is not a refused publication at all — a decided draft, or a
 * person who may not see the agent — which is not logged.
 */
export function refusalLogOutcome(draft: Draft, reason: string, now: number): "expired" | "refused" | null {
  if (draft.status !== "pending" || reason === SESSION_NOT_VISIBLE || reason === AGENT_CANNOT_APPROVE) return null;
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
  if (err instanceof PublishInputError) return { reason: err.message, httpStatus: 400 };
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
  origin: DraftOrigin;
  now: number;
}): Draft {
  return {
    id: o.id,
    sessionId: o.sessionId,
    accountId: o.accountId,
    text: o.text,
    ...(o.imagePath ? { imagePath: o.imagePath } : {}),
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
  text: string;
  image?: unknown;
  status: DraftStatus;
  createdAt: number;
  decidedBy?: string;
  postUrl?: string;
  error?: string;
}

/**
 * The ONLY draft shape sent to a client. Built field by field, so nothing the
 * account carries (its token above all) can ride along. `image` is whatever the
 * caller renders the image as (a file card).
 */
export function draftView(d: Draft, account: Pick<ConnectedAccount, "label"> | undefined, image?: unknown): DraftView {
  return {
    id: d.id,
    sessionId: d.sessionId,
    accountId: d.accountId,
    account: account?.label ?? "(disconnected account)",
    text: d.text,
    ...(d.imagePath ? { image: image ?? path.basename(d.imagePath) } : {}),
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
  text: string;
  outcome: "published" | "refused" | "failed" | "expired";
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

// ---- store ---------------------------------------------------------------

function storeDir(): string {
  return path.join(os.homedir(), ".shadok-ai", "connected-accounts");
}

export function draftsFileFor(cwd: string): string {
  return path.join(storeDir(), `${instanceKey(cwd)}.drafts.json`);
}

export function socialLogFileFor(cwd: string): string {
  return path.join(storeDir(), `${instanceKey(cwd)}.log.jsonl`);
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
