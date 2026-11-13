import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { instanceKey } from "./paths.js";
import { accountDeadline, accountLapsed, type ConnectedAccount } from "./connected-accounts.js";
import { draftAction, draftNoun, draftProvider, expireDrafts, type Draft } from "./social-drafts.js";

/**
 * The hourly watch over connected accounts and drafts: which accounts are close
 * to (or past) their expiry, which drafts timed out, which publishes were
 * orphaned by a restart. Pure decisions up top, the warning memory below. The
 * server applies them; nothing here touches a token.
 */

export const WARN_BEFORE_MS = 7 * 24 * 3600_000;
/** A Google app in Testing issues 7-day authorisations: a 7-day warning would
 *  fire the moment the account is connected, so Google warns 2 days ahead. */
export const GOOGLE_WARN_BEFORE_MS = 2 * 24 * 3600_000;
export const warnBeforeMs = (a: Pick<ConnectedAccount, "provider">) => (a.provider === "google" ? GOOGLE_WARN_BEFORE_MS : WARN_BEFORE_MS);
export const REWARN_AFTER_MS = 24 * 3600_000;
export const STALE_PUBLISHING_MS = 10 * 60_000;
export const STALE_PUBLISHING_SENTENCE = "The cockpit restarted while publishing; check LinkedIn before retrying.";
export const STALE_GOOGLE_SENTENCE = "The cockpit restarted while sending; check Gmail's Sent folder or the calendar before retrying.";

export interface ExpiryActions {
  warn: ConnectedAccount[];
  expire: ConnectedAccount[];
  expiredDrafts: Draft[];
}

/**
 * Warn once a day from 7 days (Google: 2) before the account's deadline;
 * expire at the deadline (`accountDeadline` — for Google the refresh token's,
 * and an account with no known deadline is never warned nor expired by date).
 * An account already marked expired is neither warned nor expired again. The
 * draft TTL is `expireDrafts`' — one definition.
 */
export function expiryActions(
  accounts: readonly ConnectedAccount[],
  drafts: readonly Draft[],
  now: number,
  lastWarned: Readonly<Record<string, number>>,
): ExpiryActions {
  const warn: ConnectedAccount[] = [];
  const expire: ConnectedAccount[] = [];
  for (const a of accounts) {
    if (a.status === "expired") continue;
    const deadline = accountDeadline(a);
    if (deadline === null) continue;
    if (now >= deadline) {
      expire.push(a);
      continue;
    }
    const last = lastWarned[a.id];
    if (deadline - now <= warnBeforeMs(a) && (last === undefined || now - last >= REWARN_AFTER_MS)) warn.push(a);
  }
  return { warn, expire, expiredDrafts: expireDrafts(drafts, now).expired };
}

/** Drafts stuck `publishing` past the window (the process died mid-publish) → failed.
 *  Measured from `publishingAt` (legacy: createdAt); ids in `inFlight` are being
 *  published by this process right now, slow but alive, and are never failed. */
export function stalePublishing(
  list: readonly Draft[],
  now: number,
  inFlight: ReadonlySet<string> = new Set(),
): { list: Draft[]; failed: Draft[] } {
  const failed: Draft[] = [];
  const out = list.map((d) => {
    if (d.status !== "publishing" || inFlight.has(d.id) || now - (d.publishingAt ?? d.createdAt) < STALE_PUBLISHING_MS) return d;
    const f: Draft = { ...d, status: "failed", error: draftProvider(d) === "google" ? STALE_GOOGLE_SENTENCE : STALE_PUBLISHING_SENTENCE };
    failed.push(f);
    return f;
  });
  return { list: out, failed };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function expiryWarningText(a: Pick<ConnectedAccount, "label" | "expiresAt"> & Partial<Pick<ConnectedAccount, "provider" | "refreshExpiresAt">>): string {
  if (a.provider === "google") {
    const d = accountDeadline({ provider: "google", expiresAt: a.expiresAt, refreshExpiresAt: a.refreshExpiresAt }) ?? a.expiresAt;
    return `Your Google connection '${a.label}' must be reconnected by ${isoDay(d)} (test app authorisations last 7 days). Reconnect it in Secrets → Connected accounts so agents keep working in it.`;
  }
  return `Your LinkedIn connection '${a.label}' expires on ${isoDay(a.expiresAt)}. Reconnect it in Secrets → Connected accounts so posts keep going out.`;
}

export function draftExpiredNotice(d: Pick<Draft, "id"> & Partial<Pick<Draft, "provider" | "action">>): string {
  if (draftProvider(d) === "google") return `Your ${draftNoun(d)} ${d.id.slice(0, 8)} expired after 7 days without approval — nothing left the account.`;
  return `Your LinkedIn draft ${d.id.slice(0, 8)} expired after 7 days without approval — it was not published.`;
}

export function pendingDraftText(channel: string, d: Partial<Pick<Draft, "provider" | "action">> = {}): string {
  const a = draftAction(d);
  const what = a === "gmail.send" ? "an email" : a.startsWith("calendar.") ? "a calendar change" : "a LinkedIn post";
  return `${channel} has ${what} waiting for your approval in the cockpit.`;
}

/**
 * What the cockpit's banner needs about an account, for its OWNER only: the
 * DM reaches the operator alone, so every other owner learns of an expiry from
 * the page (`GET /connected-accounts`). Someone else's account gets nothing —
 * reconnecting it is not theirs to do.
 */
export function ownerExpiryFlags(
  a: Pick<ConnectedAccount, "owner" | "expiresAt" | "status"> & Partial<Pick<ConnectedAccount, "provider" | "refreshExpiresAt">>,
  viewerName: string | null,
  now: number,
): { expiringSoon?: boolean; expired?: boolean } {
  if (!viewerName || viewerName !== a.owner) return {};
  const full = { provider: a.provider ?? ("linkedin" as const), expiresAt: a.expiresAt, refreshExpiresAt: a.refreshExpiresAt, status: a.status };
  const expired = accountLapsed(full, now);
  const deadline = accountDeadline(full);
  return { expiringSoon: !expired && deadline !== null && deadline - now <= warnBeforeMs(full), expired };
}

/** Only the instance operator (the bootstrap admin) is the Telegram DM owner. */
export function ownerIsOperator(owner: string, bootstrapAdmin: string): boolean {
  return owner === bootstrapAdmin;
}

// ---- the warning memory (sidecar: the account store's shape is fixed) -----

export function warnedFileFor(cwd: string): string {
  return path.join(os.homedir(), ".shadok-ai", "connected-accounts", `${instanceKey(cwd)}.warned.json`);
}

/** Missing or unparseable → {}. Never throws. */
export function loadWarned(file: string): Record<string, number> {
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(p)) if (typeof v === "number") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Drops ids no longer in the store; atomic, mode 600. Written only when its
 *  content changes — the watch runs hourly and almost always has nothing new. */
export function saveWarned(file: string, warned: Record<string, number>, liveIds: readonly string[]): void {
  const keep: Record<string, number> = {};
  for (const id of liveIds) if (warned[id] !== undefined) keep[id] = warned[id];
  const before = fs.existsSync(file) ? loadWarned(file) : null;
  if (before ? JSON.stringify(before) === JSON.stringify(keep) : Object.keys(keep).length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keep, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
