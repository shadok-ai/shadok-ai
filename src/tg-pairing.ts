/**
 * The Telegram pairing code: the ONLY way a Telegram account gets to bind this
 * instance's board group, or to become the owner of its DMs.
 *
 * It replaces two first-come rules. `/setup` bound whichever group sent it
 * first, with no check on the sender, so anyone who found the bot's username
 * could add it to their own group, send `/setup`, and drive agents — i.e. run
 * commands on the host. And DMs belonged to whoever wrote to the bot first.
 * Both now require a code shown in the web cockpit's Telegram panel, which is
 * admin-only: whoever can read the code is someone the cockpit already trusts,
 * and the Telegram account that types it is the one that account vouches for.
 *
 * The code is 8 digits, single-use, lives 10 minutes, and dies after
 * `MAX_ATTEMPTS` wrong guesses — 10^8 codes against 5 tries leaves a guesser
 * nothing. Issuing a new one revokes the previous one. It lives in memory only:
 * a server restart invalidating a 10-minute code costs one click.
 *
 * The state transitions are pure (`redeemPairing`), so the rules are tested
 * without a clock or a bot.
 */
import { randomInt, timingSafeEqual } from "node:crypto";

export const PAIRING_DIGITS = 8;
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;

export interface PairingState {
  code: string;
  expiresAt: number;
  /** Wrong guesses so far. */
  failures: number;
}

export type PairingVerdict = "ok" | "none" | "expired" | "invalid" | "locked";

/** A fresh code. `rand` is injectable for the tests. */
export function newPairing(now: number, rand: (max: number) => number = randomInt): PairingState {
  let code = "";
  for (let i = 0; i < PAIRING_DIGITS; i++) code += String(rand(10));
  return { code, expiresAt: now + PAIRING_TTL_MS, failures: 0 };
}

/** Pull the code out of what was typed: tolerant of spaces and dashes
 *  ("1234 5678", "1234-5678"), since people copy codes the way they read them. */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, "");
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Try a code against the current state. Returns the verdict and the state to
 * keep: `null` once the code is spent (used, expired or locked out), so nothing
 * can be retried against a dead code. Pure — unit tested.
 */
export function redeemPairing(
  state: PairingState | null,
  input: string,
  now: number,
): { verdict: PairingVerdict; next: PairingState | null } {
  if (!state) return { verdict: "none", next: null };
  if (now >= state.expiresAt) return { verdict: "expired", next: null };
  if (sameCode(normalizeCode(input), state.code)) return { verdict: "ok", next: null };
  const failures = state.failures + 1;
  if (failures >= PAIRING_MAX_ATTEMPTS) return { verdict: "locked", next: null };
  return { verdict: "invalid", next: { ...state, failures } };
}

/** What a refused redemption tells the Telegram sender. Never says how many
 *  tries are left: that is information for the guesser, not for the owner. */
export function pairingRefusal(verdict: Exclude<PairingVerdict, "ok">): string {
  const where = "Open the cockpit's Telegram panel (admin) and click “Pair Telegram” to get a code.";
  switch (verdict) {
    case "none":
      return `🔒 This bot is not paired yet. ${where}`;
    case "expired":
      return `⌛ That code has expired. ${where}`;
    case "locked":
      return `⛔ Too many wrong codes — that code is cancelled. ${where}`;
    case "invalid":
      return "❌ Wrong code.";
  }
}

// The live code. One per process: the server and the bridge share it.
let current: PairingState | null = null;

/** Issue a new code, revoking any previous one. */
export function issuePairingCode(now = Date.now()): PairingState {
  current = newPairing(now);
  return current;
}

/** Redeem against the live code, advancing its state. */
export function redeemPairingCode(input: string, now = Date.now()): PairingVerdict {
  const { verdict, next } = redeemPairing(current, input, now);
  current = next;
  return verdict;
}

/** Revoke the live code, if any (the panel's "cancel"). */
export function cancelPairingCode(): void {
  current = null;
}

/** Is a code live right now, and until when? For the panel, never the code. */
export function pairingStatus(now = Date.now()): { active: boolean; expiresAt: number | null } {
  if (current && now < current.expiresAt) return { active: true, expiresAt: current.expiresAt };
  return { active: false, expiresAt: null };
}
