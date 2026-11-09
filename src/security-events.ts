/**
 * The Security panel's events — what happened to accounts and second factors,
 * kept per instance beside the accounts (`~/.shadok-ai/users/<key>.events.json`,
 * 600). Spec: docs/superpowers/specs/2026-10-28-2fa-v2-recovery-design.md § 6.
 *
 * No mail sender exists, so this is THE channel that tells someone what was
 * done to their account, and the place they can say "this wasn't me". Pure
 * cores (`appendEvent`, `inboxFor`, `notMeEffect`) are tested; the file I/O is
 * the thin part.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceKey } from "./paths.js";

export type SecEventKind =
  | "invited"
  | "invite-redeemed"
  | "removed"
  | "role-changed"
  | "access-reset"
  | "passkey-added"
  | "passkey-removed"
  | "device-code"
  | "two-factor"
  | "request"
  | "not-me";

export interface SecEvent {
  id: string;
  at: number;
  kind: SecEventKind;
  /** Who did it (an account name, or "admin" for the instance password). */
  actor: string;
  /** Whose account it concerns. */
  target: string;
  /** Kind-specific detail: the new role, a passkey's label, "on"/"off". */
  detail?: string;
  /** The passkey concerned, so "this wasn't me" can remove it. */
  passkeyId?: string;
  /** For a `not-me`: the event it disowns. */
  about?: string;
  /** For a `request` event: the two-admin request it reports on, so "this
   *  wasn't me" can cancel it while it is still open. */
  requestId?: string;
  /** Who has opened it in the panel. */
  seenBy?: string[];
  /** Already disowned by its target — the button is spent. */
  disowned?: boolean;
}

/** Bounds: the log is an audit trail, not an archive. */
export const MAX_EVENTS = 500;
export const MAX_AGE_MS = 90 * 24 * 3600 * 1000;

export function appendEvent(list: SecEvent[], ev: Omit<SecEvent, "id" | "at">, now: number, id?: string): SecEvent[] {
  const row: SecEvent = { id: id ?? randomBytes(9).toString("base64url"), at: now, ...ev };
  return [...list.filter((e) => now - e.at <= MAX_AGE_MS), row].slice(-MAX_EVENTS);
}

/**
 * Which events concern the viewer as a TARGET, i.e. what they need to hear
 * about: anything someone else did to their account, and every passkey added
 * or removed on it even by "themselves" — whoever holds their password and a
 * code IS "themselves" to the server, which is exactly the case to catch.
 */
export function aboutYou(e: SecEvent, viewer: string): boolean {
  if (e.target !== viewer || e.kind === "not-me") return false;
  if (e.kind === "passkey-added" || e.kind === "passkey-removed") return true;
  return e.actor !== viewer;
}

export interface Inbox {
  /** Events about the viewer, newest first. */
  aboutYou: (SecEvent & { unread: boolean })[];
  /** Admins only: every event, newest first. Empty for a member. */
  log: (SecEvent & { unread: boolean })[];
  /** What needs the viewer: unread notices about them, and — for an admin —
   *  unread "this wasn't me" flags. */
  badge: number;
}

export function inboxFor(viewer: { name: string; role: string }, events: SecEvent[]): Inbox {
  const mark = (e: SecEvent) => ({ ...e, unread: !(e.seenBy ?? []).includes(viewer.name) });
  const newest = [...events].sort((a, b) => b.at - a.at);
  const mine = newest.filter((e) => aboutYou(e, viewer.name)).map(mark);
  const admin = viewer.role === "admin";
  const log = admin ? newest.map(mark) : [];
  const flags = admin ? log.filter((e) => e.kind === "not-me" && e.unread).length : 0;
  return { aboutYou: mine, log, badge: mine.filter((e) => e.unread).length + flags };
}

/** Mark everything the viewer can see as seen by them. */
export function markSeen(events: SecEvent[], viewer: { name: string; role: string }): SecEvent[] {
  const visible = (e: SecEvent) => viewer.role === "admin" || aboutYou(e, viewer.name);
  return events.map((e) =>
    visible(e) && !(e.seenBy ?? []).includes(viewer.name) ? { ...e, seenBy: [...(e.seenBy ?? []), viewer.name] } : e,
  );
}

/**
 * What "this wasn't me" undoes for an event, or why it cannot. Every case ends
 * the account's other sessions; a passkey nobody admits to adding is removed.
 * Only the event's TARGET may disown it, once.
 */
export function notMeEffect(
  e: SecEvent | undefined,
  viewer: string,
): { ok: true; removePasskey?: string; cancelRequest?: string } | { ok: false; error: string } {
  if (!e || !aboutYou(e, viewer)) return { ok: false, error: "no such notice for you" };
  if (e.disowned) return { ok: false, error: "already reported" };
  return {
    ok: true,
    ...(e.kind === "passkey-added" && e.passkeyId ? { removePasskey: e.passkeyId } : {}),
    ...(e.requestId ? { cancelRequest: e.requestId } : {}),
  };
}

/** One line a person reads, for the panel. */
export function describeEvent(e: SecEvent): string {
  const by = e.actor === e.target ? "you" : e.actor;
  switch (e.kind) {
    case "invited": return `${e.actor} invited ${e.target}${e.detail ? " as " + e.detail : ""}`;
    case "invite-redeemed": return `${e.target} set their password from an invitation or reset link`;
    case "removed": return `${e.actor} removed the account ${e.target}`;
    case "role-changed": return `${e.actor} made ${e.target} ${e.detail ?? "?"}`;
    case "access-reset": return `${e.actor} reset ${e.target}'s access (password and passkeys removed)`;
    case "passkey-added": return `a passkey${e.detail ? " “" + e.detail + "”" : ""} was registered on ${e.target}'s account (by ${by})`;
    case "passkey-removed": return `a passkey was removed from ${e.target}'s account (by ${by})`;
    case "device-code": return `${e.actor} issued a device code for ${e.target}`;
    case "two-factor": return `${e.actor} turned two-factor sign-in ${e.detail ?? ""}`.trim();
    case "request": return e.detail ?? `a request about ${e.target}`;
    case "not-me": return `⚠ ${e.actor} reported “this wasn't me”: ${e.detail ?? ""}`.trim();
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

function eventsFile(): string {
  return path.join(os.homedir(), ".shadok-ai", "users", instanceKey() + ".events.json");
}

export function loadEvents(): SecEvent[] {
  try {
    const v = JSON.parse(fs.readFileSync(eventsFile(), "utf8"));
    return Array.isArray(v) ? v.filter((e) => e && typeof e.id === "string") : [];
  } catch {
    return [];
  }
}

export function saveEvents(list: SecEvent[]): void {
  const f = eventsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}

/** Record one event. Never throws: losing an audit line must not fail the
 *  action it describes (the console line beside each call still exists). */
export function recordEvent(ev: Omit<SecEvent, "id" | "at">): SecEvent | null {
  try {
    const list = appendEvent(loadEvents(), ev, Date.now());
    saveEvents(list);
    return list[list.length - 1];
  } catch (err) {
    console.log(`security: could not record ${ev.kind} — ${(err as Error).message}`);
    return null;
  }
}
