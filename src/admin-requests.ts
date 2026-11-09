/**
 * Two-admin requests — 2FA v2 (spec docs/superpowers/specs/2026-10-28-2fa-v2-recovery-design.md
 * §§ 4–5). What one admin may no longer do alone while two-factor is on:
 *
 * - `passkey-reset` (level 2): let someone who lost their passkey register a
 *   new device — a second admin approves, then a device code is issued;
 * - `full-reset` (level 3): wipe password and passkeys — effective 24 h after
 *   the ask, or at once when a second admin approves;
 * - `promote` / `demote`: make or unmake an admin.
 *
 * Stored beside the accounts (`~/.shadok-ai/users/<key>.requests.json`, 600).
 * No timer anywhere: a due request is APPLIED by whoever next reads the list
 * (`dueRequests`), so a restart loses nothing and nothing has to stay alive.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceKey } from "./paths.js";

export type RequestKind = "passkey-reset" | "full-reset" | "promote" | "demote";

export interface AdminRequest {
  id: string;
  kind: RequestKind;
  target: string;
  /** The admin who asked. */
  by: string;
  createdAt: number;
  /** The second admin, once approved. */
  approvedBy?: string;
  /** full-reset only: when it takes effect on its own. */
  effectiveAt?: number;
  /** Set when it took effect / was cancelled or refused; the row then only
   *  lingers so its asker can read the outcome. */
  doneAt?: number;
  outcome?: "applied" | "cancelled" | "refused" | "expired";
  /** Who cancelled or refused. */
  closedBy?: string;
  /** What the asker hands over once applied: a reset link or a device code. */
  handover?: { kind: "link" | "code"; value: string; expiresAt: number };
}

/** An unapproved request dies after this. */
export const REQUEST_TTL_MS = 48 * 3600 * 1000;
/** Level 3's waiting time. */
export const FULL_RESET_DELAY_MS = 24 * 3600 * 1000;
/** A closed row stays this long so its outcome (and handover) can be read. */
export const CLOSED_KEEP_MS = 7 * 24 * 3600 * 1000;

type Verdict = { ok: true } | { ok: false; error: string };
interface Who { name: string; role: string }
interface Acct { name: string; role: string }

export function newRequest(kind: RequestKind, target: string, by: string, now: number): AdminRequest {
  return {
    id: randomBytes(12).toString("base64url"),
    kind,
    target,
    by,
    createdAt: now,
    ...(kind === "full-reset" ? { effectiveAt: now + FULL_RESET_DELAY_MS } : {}),
  };
}

export const isOpen = (r: AdminRequest) => r.doneAt == null;

/** May `actor` ask for this? */
export function askVerdict(o: { actor: Who | null; kind: RequestKind; target: string; accounts: Acct[] }): Verdict {
  if (!o.actor || o.actor.role !== "admin") return { ok: false, error: "only an admin can ask for this" };
  if (o.actor.name === o.target) return { ok: false, error: "not for yourself — ask another admin" };
  const t = o.accounts.find((a) => a.name === o.target);
  if (!t) return { ok: false, error: `no such account: ${o.target}` };
  if (o.kind === "promote" && t.role === "admin") return { ok: false, error: `${o.target} is already an admin` };
  if (o.kind === "demote" && t.role !== "admin") return { ok: false, error: `${o.target} is not an admin` };
  return { ok: true };
}

/** May `approver` approve this request now? */
export function approveVerdict(r: AdminRequest | undefined, approver: Who | null, now: number): Verdict {
  if (!r || !isOpen(r)) return { ok: false, error: "no such open request" };
  if (!approver || approver.role !== "admin") return { ok: false, error: "only an admin can approve" };
  if (approver.name === r.by) return { ok: false, error: "you asked for it — a SECOND admin must approve" };
  if (approver.name === r.target) return { ok: false, error: "it concerns you — another admin must approve" };
  if (r.approvedBy) return { ok: false, error: "already approved" };
  if (r.kind !== "full-reset" && now - r.createdAt > REQUEST_TTL_MS) return { ok: false, error: "this request has expired" };
  return { ok: true };
}

/**
 * May `who` cancel it? The asker, any OTHER admin (the 24 h of level 3 are
 * worth what the other admins' attention is worth), or the target themself —
 * a request made behind their back is precisely what they must be able to stop.
 */
export function cancelVerdict(r: AdminRequest | undefined, who: Who | null): Verdict {
  if (!r || !isOpen(r)) return { ok: false, error: "no such open request" };
  if (!who) return { ok: false, error: "sign in first" };
  if (who.name === r.by || who.name === r.target || who.role === "admin") return { ok: true };
  return { ok: false, error: "only an admin, the asker or the person concerned can cancel this" };
}

/** Open full-resets whose 24 h are over: to apply now. */
export function dueRequests(list: AdminRequest[], now: number): AdminRequest[] {
  return list.filter((r) => isOpen(r) && r.kind === "full-reset" && r.effectiveAt != null && now >= r.effectiveAt);
}

/** Close open requests that ran out without approval. */
export function expire(list: AdminRequest[], now: number): AdminRequest[] {
  return list.map((r) =>
    isOpen(r) && r.kind !== "full-reset" && now - r.createdAt > REQUEST_TTL_MS
      ? { ...r, doneAt: now, outcome: "expired" as const }
      : r,
  );
}

/** Add a request, replacing an open one of the same kind on the same target,
 *  and dropping closed rows past their keep window. */
export function upsertRequest(list: AdminRequest[], r: AdminRequest, now: number): AdminRequest[] {
  return [
    ...list.filter(
      (x) => !(isOpen(x) && x.kind === r.kind && x.target === r.target) && !(x.doneAt != null && now - x.doneAt > CLOSED_KEEP_MS),
    ),
    r,
  ];
}

/** What the Security panel shows a viewer: what they may approve, and what they asked. */
export function requestsFor(viewer: Who, list: AdminRequest[], now: number) {
  const waiting =
    viewer.role === "admin"
      ? list.filter((r) => approveVerdict(r, viewer, now).ok)
      : [];
  const mine = list.filter((r) => r.by === viewer.name).sort((a, b) => b.createdAt - a.createdAt);
  // Every OTHER admin can see (and cancel) an open full reset they did not ask
  // for, even though approving it is one click away in `waiting` already.
  return { waiting, mine };
}

export function describeRequest(r: AdminRequest): string {
  switch (r.kind) {
    case "passkey-reset": return `${r.by} asks to let ${r.target} register a new device (lost passkey)`;
    case "full-reset": return `${r.by} asks for a FULL reset of ${r.target} (password and passkeys)`;
    case "promote": return `${r.by} asks to make ${r.target} admin`;
    case "demote": return `${r.by} asks to make ${r.target} member`;
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

function requestsFile(): string {
  return path.join(os.homedir(), ".shadok-ai", "users", instanceKey() + ".requests.json");
}

export function loadRequests(): AdminRequest[] {
  try {
    const v = JSON.parse(fs.readFileSync(requestsFile(), "utf8"));
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}

export function saveRequests(list: AdminRequest[]): void {
  const f = requestsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}
