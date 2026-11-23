/**
 * The state of the instance's WhatsApp link, as a pure reducer.
 *
 * The panel shows exactly ONE of these phases at a time, and the whole point of
 * this module is that the phase is never a lie: a dead socket must leave
 * `connected` on its own (the liveness timeout), and the "restart required"
 * close that follows a scan must NOT read as a failure — it is how linking
 * ends. No I/O and no timers here: the handle (`src/whatsapp.ts`) feeds events
 * and a periodic `tick`, and every rule below is unit-tested on its own.
 */

/** Who the instance is linked as. `id` is the transport's raw device id and
 *  carries the number: it never leaves the server (see `linkView`). */
export interface WaAccount {
  id: string;
  name?: string;
  phone?: string;
}

export type WaLinkState =
  | { phase: "unavailable"; reason: string }
  | { phase: "unlinked" }
  | { phase: "linking"; startedAt: number; qr?: string; qrExpiresAt?: number }
  | { phase: "connected"; account: WaAccount; linkedAt: number; connectedAt: number; lastSeenAt: number }
  | { phase: "reconnecting"; account: WaAccount; linkedAt: number; lostAt: number; attempt: number }
  | { phase: "logged-out"; account?: WaAccount; at: number; detail: string };

export type WaLinkEvent =
  | { type: "link-requested" }
  | { type: "cancel" }
  | { type: "unlinked" }
  | { type: "qr"; payload: string; ttlMs: number }
  | { type: "open"; account: WaAccount }
  | { type: "alive" }
  | { type: "close"; reason: "restart" | "lost" | "logged-out" | "error"; detail?: string }
  | { type: "stored-session"; account: WaAccount; linkedAt: number }
  | { type: "tick" }
  | { type: "unavailable"; reason: string };

/** A QR nobody scans: linking gives up after this and goes back to Not linked,
 *  so nothing keeps rotating codes in the background for an absent admin. */
export const LINK_TIMEOUT_MS = 3 * 60_000;

/** A connected socket that has shown no sign of life for this long is treated
 *  as lost. The library pings every ~30 s, so three missed rounds is a dead
 *  socket, not a quiet one. Without it a link that died WITHOUT a close event
 *  would sit on "Connected" for ever — the one lie the panel must not tell. */
export const LIVENESS_MS = 90_000;

const DEFAULT_LOGOUT_DETAIL = "the session was closed by WhatsApp";

export function linkReduce(s: WaLinkState, e: WaLinkEvent, now: number): WaLinkState {
  switch (e.type) {
    case "unavailable":
      return { phase: "unavailable", reason: e.reason };

    case "stored-session":
      // Attempt 0: the first connection of a boot is not a retry, it starts at once.
      return { phase: "reconnecting", account: e.account, linkedAt: e.linkedAt, lostAt: now, attempt: 0 };

    case "unlinked":
      return { phase: "unlinked" };

    case "cancel":
      // Unavailable is about the process (no library, refused deployment):
      // nothing a click can cancel out of.
      return s.phase === "unavailable" ? s : { phase: "unlinked" };

    case "link-requested":
      // Idempotent while a link exists or is being made: a double click must
      // never start a second linking.
      return s.phase === "unlinked" || s.phase === "logged-out" ? { phase: "linking", startedAt: now } : s;

    case "qr":
      return s.phase === "linking" ? { ...s, qr: e.payload, qrExpiresAt: now + e.ttlMs } : s;

    case "open":
      if (s.phase === "linking")
        return { phase: "connected", account: e.account, linkedAt: now, connectedAt: now, lastSeenAt: now };
      if (s.phase === "reconnecting" || s.phase === "connected")
        return { phase: "connected", account: e.account, linkedAt: s.linkedAt, connectedAt: now, lastSeenAt: now };
      // An `open` racing a cancel or an unlink: the handle stops that transport.
      return s;

    case "alive":
      return s.phase === "connected" ? { ...s, lastSeenAt: now } : s;

    case "close": {
      if (e.reason === "logged-out")
        return {
          phase: "logged-out",
          ...("account" in s && s.account ? { account: s.account } : {}),
          at: now,
          detail: e.detail ?? DEFAULT_LOGOUT_DETAIL,
        };
      if (s.phase === "linking") {
        // The "restart required" after a scan is the normal end of linking, and
        // a lost socket mid-linking is retried: either way we stay in linking
        // (bounded by LINK_TIMEOUT_MS), and the spent QR is dropped.
        const { qr: _qr, qrExpiresAt: _exp, ...rest } = s;
        return rest;
      }
      if (s.phase === "connected")
        return { phase: "reconnecting", account: s.account, linkedAt: s.linkedAt, lostAt: now, attempt: 1 };
      if (s.phase === "reconnecting") return { ...s, attempt: s.attempt + 1 };
      return s;
    }

    case "tick":
      if (s.phase === "linking" && now - s.startedAt > LINK_TIMEOUT_MS) return { phase: "unlinked" };
      if (s.phase === "connected" && now - s.lastSeenAt > LIVENESS_MS)
        return { phase: "reconnecting", account: s.account, linkedAt: s.linkedAt, lostAt: now, attempt: 1 };
      return s;
  }
}

/** Delay before reconnect attempt n (1-based): 2s, 4s, 8s … capped at 60s.
 *  Attempt 0 (a boot resuming a stored session) waits for nothing. */
export function reconnectDelayMs(attempt: number): number {
  if (attempt < 1) return 0;
  return Math.min(60_000, 2000 * 2 ** (attempt - 1));
}

/** `336…00`: enough to tell two numbers apart in a log, not enough to dial. */
export function maskPhone(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  const d = p.replace(/\D/g, "");
  if (d.length < 6) return "…";
  return `${d.slice(0, 3)}…${d.slice(-2)}`;
}

/**
 * What the panel may see. `qr` is included only when `forPerson` is true — a
 * caller authenticated by an agent's session key passes some admin GETs and
 * must never obtain the payload that links a device to the account. For the
 * same reason the number is masked for anything but a person, and the raw
 * device id (which carries the number) is never included at all.
 */
export function linkView(s: WaLinkState, now: number, forPerson: boolean): Record<string, unknown> {
  const acct = (a: WaAccount | undefined) =>
    a ? { ...(a.name ? { name: a.name } : {}), ...(a.phone ? { phone: forPerson ? a.phone : maskPhone(a.phone) } : {}) } : undefined;
  switch (s.phase) {
    case "unavailable":
      return { phase: s.phase, reason: s.reason, now };
    case "unlinked":
      return { phase: s.phase, now };
    case "linking": {
      const v: Record<string, unknown> = { phase: s.phase, startedAt: s.startedAt, expiresAt: s.startedAt + LINK_TIMEOUT_MS, now };
      // An expired payload would only make the phone say "invalid code".
      if (forPerson && s.qr && (s.qrExpiresAt ?? 0) > now) {
        v.qr = s.qr;
        v.qrExpiresAt = s.qrExpiresAt;
      }
      return v;
    }
    case "connected":
      return { phase: s.phase, account: acct(s.account), linkedAt: s.linkedAt, connectedAt: s.connectedAt, lastSeenAt: s.lastSeenAt, now };
    case "reconnecting":
      return { phase: s.phase, account: acct(s.account), linkedAt: s.linkedAt, lostAt: s.lostAt, attempt: s.attempt, now };
    case "logged-out":
      return { phase: s.phase, ...(s.account ? { account: acct(s.account) } : {}), at: s.at, detail: s.detail, now };
  }
}
