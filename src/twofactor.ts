import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { BOOTSTRAP_ADMIN, signSession, readSession, type Account, type Passkey, type Role } from "./accounts.js";

/**
 * Two-factor sign-in: a passkey (WebAuthn, user verification REQUIRED — the
 * platform's biometric) after the password. Design and threat model:
 * docs/superpowers/specs/2026-10-21-passkey-2fa-design.md.
 *
 * The rules are pure functions here, so the whole policy is one testable place,
 * like `userWriteVerdict`. The one rule everything else rests on: while 2FA is
 * on, a PASSWORD ALONE never registers a passkey — registration needs a verified
 * session or an enrollment code minted by one. Otherwise a stolen password would
 * enroll the thief's own phone and the second factor would be decoration.
 */

type Verdict = { ok: true } | { ok: false; error: string };

/** How long a password-only sign-in may wait for its second step. */
export const PENDING_TTL_MS = 5 * 60 * 1000;
/** An enrollment code: long enough to pick up the other device, no longer. */
export const ENROLL_TTL_MS = 10 * 60 * 1000;
/** A WebAuthn challenge: one ceremony. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;

/** Admins who could vouch for someone: a named account, signed up, with a passkey. */
export function admins2fa(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.role === "admin" && a.name !== BOOTSTRAP_ADMIN && a.passwordHash && a.passkeys?.length);
}

/**
 * May two-factor be switched ON? Each refusal says what to do about it.
 *
 * Two admins with a passkey, not one: the recovery rule is "another admin resets
 * you", so a lone admin who loses their phone locks the cockpit for good. The
 * bootstrap admin does not count — it is the instance password, which lives in
 * every agent's env and which no admin can reset.
 */
export function twoFactorEnableVerdict(o: {
  passwordSet: boolean;
  actor: { name: string; role: Role } | null;
  accounts: Account[];
}): Verdict {
  if (!o.passwordSet)
    return { ok: false, error: "the cockpit has no password (SHADOK_GUI_PASSWORD), so there is nothing to add a second factor to" };
  if (!o.actor || o.actor.role !== "admin") return { ok: false, error: "only an admin can change two-factor sign-in" };
  if (o.actor.name === BOOTSTRAP_ADMIN)
    return { ok: false, error: "sign in with your own named admin account — the instance password cannot use two-factor" };
  const named = o.accounts.filter((a) => a.role === "admin" && a.name !== BOOTSTRAP_ADMIN && a.passwordHash);
  if (named.length < 2)
    return { ok: false, error: "two-factor needs at least 2 admins, so that one can reset the other — invite a second admin first" };
  const missing = named.filter((a) => !a.passkeys?.length).map((a) => a.name);
  if (missing.length)
    return { ok: false, error: `every admin needs a passkey first — still missing: ${missing.join(", ")}` };
  return { ok: true };
}

/**
 * While 2FA is on, would this change leave fewer than 2 admins able to vouch
 * for the others? Covers a deletion, a demotion and removing a last passkey —
 * pass the account list AS IT WOULD BE afterwards.
 */
export function keepsTwoAdminsVerdict(enabled: boolean, after: Account[]): Verdict {
  if (!enabled) return { ok: true };
  return admins2fa(after).length >= 2
    ? { ok: true }
    : { ok: false, error: "two-factor is on and this would leave fewer than 2 admins with a passkey — nobody could reset a lost device" };
}

/** Another admin resets someone who lost their password or their device. */
export function resetVerdict(o: { actor: { name: string; role: Role } | null; target: string; accounts: Account[] }): Verdict {
  if (!o.actor || o.actor.role !== "admin") return { ok: false, error: "only an admin can reset someone's access" };
  if (o.actor.name === o.target) return { ok: false, error: "you cannot reset yourself — ask another admin" };
  if (o.target === BOOTSTRAP_ADMIN) return { ok: false, error: `"${BOOTSTRAP_ADMIN}" is the instance password and cannot be reset here` };
  if (!o.accounts.some((a) => a.name === o.target)) return { ok: false, error: `no such account: ${o.target}` };
  return { ok: true };
}

/** What a correct password leads to. */
export function loginNext(acct: Account | undefined, enabled: boolean): "session" | "passkey" | "enroll" {
  if (!enabled) return "session";
  return acct?.passkeys?.length ? "passkey" : "enroll";
}

// No 0/O, 1/I/L: the code is read on one screen and typed on another.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newEnrollCode(now: number, by: string): { code: string; expiresAt: number; by: string } {
  const bytes = randomBytes(8);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return { code, expiresAt: now + ENROLL_TTL_MS, by };
}

/** Normalise what a person typed: case, spaces and dashes do not count. */
export function normCode(input: unknown): string {
  return String(input ?? "").toUpperCase().replace(/[\s-]/g, "");
}

/** Does `input` redeem this account's outstanding code? Same refusal for every
 *  failure, so a guesser learns nothing. */
export function enrollCodeVerdict(acct: Account | undefined, input: unknown, now: number): Verdict {
  const bad: Verdict = { ok: false, error: "this code is not valid (wrong, used or expired) — ask for a new one" };
  const want = acct?.enroll?.code;
  const got = normCode(input);
  if (!want || !got || got.length !== want.length) return bad;
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(want))) return bad;
  if (now > acct!.enroll!.expiresAt) return bad;
  return { ok: true };
}

// ── The pending sign-in (password accepted, second factor not yet) ──────────
// Signed with a key DERIVED for this purpose, never with the session key
// itself: a pending token copied into `sk_auth` must not read as a session.

function pendingKey(secret: Buffer): Buffer {
  return createHmac("sha256", secret).update("sk_pending").digest();
}
export function signPending(user: string, now: number, secret: Buffer): string {
  return signSession(user, now, pendingKey(secret));
}
export function readPending(token: string, secret: Buffer, now: number): string | null {
  return readSession(token, pendingKey(secret), now, PENDING_TTL_MS);
}

// ── Challenges: single use, bound to a user and a purpose ───────────────────

export type ChallengePurpose = "login" | "register" | "stepup";
interface Challenge {
  challenge: string;
  user: string;
  purpose: ChallengePurpose;
  expiresAt: number;
}
const challenges = new Map<string, Challenge>();

export function putChallenge(challenge: string, user: string, purpose: ChallengePurpose, now = Date.now()): string {
  for (const [k, c] of challenges) if (c.expiresAt < now) challenges.delete(k);
  const id = randomUUID();
  challenges.set(id, { challenge, user, purpose, expiresAt: now + CHALLENGE_TTL_MS });
  return id;
}

/** Take (and burn) a challenge — only for the user and purpose it was issued to. */
export function takeChallenge(id: unknown, user: string, purpose: ChallengePurpose, now = Date.now()): string | null {
  if (typeof id !== "string") return null;
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.user !== user || c.purpose !== purpose || c.expiresAt < now) return null;
  return c.challenge;
}

// ── WebAuthn ceremonies (thin over @simplewebauthn/server) ──────────────────

/** Where the ceremony happens: the RP ID is the hostname, the origin the page's. */
export interface Rp {
  id: string;
  origin: string;
}

export async function registrationOptions(rp: Rp, acct: Account) {
  return generateRegistrationOptions({
    rpName: "shadok-ai",
    rpID: rp.id,
    userName: acct.name,
    attestationType: "none",
    excludeCredentials: (acct.passkeys ?? []).map((p) => ({ id: p.id, transports: p.transports })),
    // A passkey on THIS device, unlocked by its biometric: that is the feature.
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export async function verifyRegistration(rp: Rp, expectedChallenge: string, response: any, label: string, now: number): Promise<Passkey | null> {
  try {
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
    });
    if (!v.verified) return null;
    const c = v.registrationInfo.credential;
    return {
      id: c.id,
      publicKey: Buffer.from(c.publicKey).toString("base64url"),
      counter: c.counter,
      ...(c.transports?.length ? { transports: c.transports } : {}),
      label: cleanLabel(label),
      createdAt: now,
    };
  } catch {
    return null;
  }
}

export async function authenticationOptions(rp: Rp, acct: Account) {
  return generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: (acct.passkeys ?? []).map((p) => ({ id: p.id, transports: p.transports })),
    userVerification: "required",
  });
}

/** Verify an assertion against this account's passkeys → the updated passkey
 *  (counter, last use), or null. */
export async function verifyAuthentication(rp: Rp, expectedChallenge: string, response: any, acct: Account, now: number): Promise<Passkey | null> {
  const pk = (acct.passkeys ?? []).find((p) => p.id === response?.id);
  if (!pk) return null;
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(Buffer.from(pk.publicKey, "base64url")),
        counter: pk.counter,
        transports: pk.transports as any,
      },
      requireUserVerification: true,
    });
    if (!v.verified) return null;
    return { ...pk, counter: v.authenticationInfo.newCounter, lastUsedAt: now };
  } catch {
    return null;
  }
}

export function cleanLabel(label: unknown): string {
  const s = String(label ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
  return s || "passkey";
}

/** A passkey as the UI may see it: never the key material. */
export function publicPasskey(p: Passkey) {
  return { id: p.id, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt ?? null };
}
