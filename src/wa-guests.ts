import { type GuestSetup, normalizeGuestSetup } from "./tg-guests.js";

/**
 * WhatsApp's guest rules, pure and dependency-free like `src/tg-guests.ts`, so
 * the whole decision is unit-tested with no server and no phone.
 *
 * What lives here is what WhatsApp does DIFFERENTLY from Telegram — who a
 * sender is, which messages are someone talking to us, which channel is theirs
 * — while the trust decision (who may open a door, where a guest lands, what a
 * guest is told) is Telegram's, reused from `tg-guests.ts` rather than copied.
 *
 * See docs/superpowers/specs/2026-11-23-whatsapp-open-dm-design.md.
 */

/**
 * A channel's WhatsApp binding. Its OWN field (`Channel.whatsapp`), never
 * `Channel.telegram`: code all over the system reads the SIGN of a Telegram
 * `chatId` (home channel, DM reattach, owner adoption), and a phone number
 * written there would be reattached as a Telegram chat or become an
 * undeletable home channel.
 */
export interface WaBinding {
  /** The linked number this conversation belongs to (`waAccountKey`): linking
   *  a DIFFERENT number must never land anyone on another number's history. */
  account: string;
  /** The person, canonical: their LID when known, else their phone address. */
  id: string;
  /** Digits of their phone number, when the transport gave it — for display to
   *  the guest group's members only, never a key on its own. */
  phone?: string;
}

/** A medium carried by an inbound message (step 3). Its bytes are fetched
 *  separately (`WaTransport.downloadMedia`), the moment it arrives. */
export interface WaMedia {
  kind: "image" | "document" | "audio" | "video";
  mime?: string;
  fileName?: string;
  /** Declared size in bytes — checked BEFORE downloading. */
  size?: number;
  /** An audio recorded as a voice note (push-to-talk), as opposed to a file. */
  voice?: boolean;
}

/** What the transport says about one inbound message — library-neutral. */
export interface WaInbound {
  /** The message id, for dedup. */
  id: string;
  /** Who the conversation is with: a person (`…@lid`, `…@s.whatsapp.net`), a
   *  group, a broadcast, a newsletter. */
  chat: string;
  /** The same person's other address, when the server sent it along (a LID
   *  chat comes with the phone number, and the reverse). */
  chatAlt?: string;
  /** Written by the linked account itself (from its own phone, or by us). */
  fromMe: boolean;
  /** Delivered now — as opposed to a history sync replaying old messages. */
  live: boolean;
  /** Arrived without content: the sender's phone had not encrypted for this
   *  linked device yet (the spike's finding 3). */
  unreadable: boolean;
  /** The text — or, for a medium, its caption. */
  text?: string;
  media?: WaMedia;
  /** The sender's WhatsApp display name. Untrusted, display only. */
  pushName?: string;
  at: number;
}

const PERSON_SERVERS = new Set(["s.whatsapp.net", "lid"]);

/**
 * A person's address without its device suffix (`336…:12@s.whatsapp.net` →
 * `336…@s.whatsapp.net`), or null when it is not a person's address at all.
 * The same person writes from several devices; keying on the raw jid would
 * give each device its own agent.
 */
export function bareJid(jid: string | undefined | null): string | null {
  if (typeof jid !== "string") return null;
  const m = /^(\d+)(?::\d+)?@([a-z.]+)$/.exec(jid.trim().toLowerCase());
  if (!m || !PERSON_SERVERS.has(m[2])) return null;
  return `${m[1]}@${m[2]}`;
}

/** The linked number, device dropped: relinking the SAME number (a new device
 *  suffix) must resume everyone; only a different number starts afresh. */
export function waAccountKey(account: { id: string } | undefined | null): string | null {
  if (!account || typeof account.id !== "string" || !account.id) return null;
  return bareJid(account.id) ?? account.id;
}

/**
 * The directory, under the guest group's home, that belongs to ONE WhatsApp
 * sender — the `wa-` twin of `guestWorkDirName`, for the same reason (two
 * strangers must not share Claude Code's per-directory memory) and with the
 * same honesty about what it is not: same Unix user, so it stops an accident,
 * not a determined agent.
 *
 * The id is untrusted input joined to a path, so the name is REBUILT from its
 * digits — device suffix dropped first — and can only ever be `wa-<digits>`.
 * Kept as a string of digits: whether a LID fits a JavaScript safe integer is
 * not established, and rounding would merge two people into one folder.
 */
export function waGuestWorkDirName(id: unknown): string | null {
  const bare = typeof id === "string" ? bareJid(id) : null;
  if (!bare) return null;
  const digits = bare.slice(0, bare.indexOf("@"));
  if (!/^\d{1,40}$/.test(digits)) return null;
  return `wa-${digits}`;
}

export type InboundVerdict =
  | { kind: "ignore"; why: string }
  | { kind: "text"; lid: string | null; pn: string | null; text: string }
  | { kind: "media"; lid: string | null; pn: string | null; media: WaMedia; caption?: string }
  /** Arrived without content: never a prompt, never stored — only the one
   *  notice asking for a resend goes to `replyTo` (step 3). */
  | { kind: "unreadable"; replyTo: string };

/**
 * Is this message someone talking to us, and if so, who and what?
 *
 * Everything that is not a live, readable text DM from another person is
 * ignored outright — groups, status, newsletters, broadcasts, calls, the
 * account's own messages (the operator typing from the phone is not a prompt),
 * history replays. An unreadable message never spawns an agent: only a readable
 * one does (the one-line notice that asks for a resend is step 3).
 */
export function inboundVerdict(m: WaInbound): InboundVerdict {
  const chat = String(m.chat ?? "").toLowerCase();
  if (chat.endsWith("@g.us")) return { kind: "ignore", why: "group" };
  if (chat === "status@broadcast") return { kind: "ignore", why: "status" };
  if (chat.endsWith("@newsletter")) return { kind: "ignore", why: "newsletter" };
  if (chat.endsWith("@broadcast")) return { kind: "ignore", why: "broadcast" };
  const primary = bareJid(chat);
  if (!primary) return { kind: "ignore", why: "not-a-person" };
  if (m.fromMe) return { kind: "ignore", why: "own" };
  if (!m.live) return { kind: "ignore", why: "replay" };
  if (m.unreadable) return { kind: "unreadable", replyTo: primary };
  const text = typeof m.text === "string" ? m.text : "";
  const alt = bareJid(m.chatAlt);
  const isLid = (j: string | null) => !!j && j.endsWith("@lid");
  const lid = isLid(primary) ? primary : isLid(alt) ? alt : null;
  const pn = !isLid(primary) ? primary : alt && !isLid(alt) ? alt : null;
  if (m.media) return { kind: "media", lid, pn, media: m.media, ...(text.trim() ? { caption: text } : {}) };
  if (!text.trim()) return { kind: "ignore", why: "no-text" };
  return { kind: "text", lid, pn, text };
}

/** The canonical id of a sender: the LID when known, else the phone address. */
export function senderKey(s: { lid: string | null; pn: string | null }): string | null {
  return s.lid ?? s.pn ?? null;
}

const digitsOf = (jid: string) => jid.slice(0, jid.indexOf("@"));

/**
 * The channel that belongs to this sender on this linked account, if any.
 *
 * The same person can show up under a LID and under a phone-number address,
 * and keying on whichever arrived would hand them a second agent with no
 * history the day the addressing changes. So a row matches on the LID, OR on
 * the phone address it was bound under, OR on the phone number stored beside a
 * LID binding — and only rows of the linked account count, so a different
 * number starts everyone afresh.
 */
export function findWaChannel<C extends { whatsapp?: WaBinding | null }>(
  list: readonly C[],
  account: string,
  s: { lid: string | null; pn: string | null },
): C | undefined {
  const mine = list.filter((c) => c.whatsapp && c.whatsapp.account === account);
  if (s.lid) {
    const byLid = mine.find((c) => c.whatsapp!.id === s.lid);
    if (byLid) return byLid;
  }
  if (s.pn) {
    const pnDigits = digitsOf(s.pn);
    return mine.find((c) => c.whatsapp!.id === s.pn || c.whatsapp!.phone === pnDigits);
  }
  return undefined;
}

/**
 * The WhatsApp guest setup, as stored. A `GuestSetup` so every Telegram guest
 * rule applies unchanged, with the mode narrowed to the two that mean
 * something here: WhatsApp is the twin of Telegram's `dm-only` (no board, no
 * owner, every DM is a guest's), so the door is `dm-only` when open and the
 * classic `group` when shut.
 */
export function waGuestSetup(raw: unknown): GuestSetup {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return normalizeGuestSetup({
    mode: r.mode === "dm-only" ? "dm-only" : "group",
    group: typeof r.group === "string" ? r.group : null,
    profile: typeof r.profile === "string" ? r.profile : null,
    ...(r.joined === true ? { joined: true } : {}),
    // The door's admission ceiling (`guestLimitsOf`), carried as stored: a
    // reader that dropped it would reset the operator's numbers on every save.
    ...(r.limits && typeof r.limits === "object" ? { limits: r.limits as { live?: number; perHour?: number } } : {}),
  });
}

/**
 * The bound channels whose bridge must be rebuilt (invariant 7): those of the
 * LINKED account that have none. The caller then keeps only those whose agent
 * is alive — never respawning a `claude` under every past guest — and asks
 * `hasBridge` first, so the steady state costs no process probe (invariant 38).
 */
export function waReattachList<C extends { sessionId: string; whatsapp?: WaBinding | null }>(
  list: readonly C[],
  account: string | null,
  hasBridge: (sessionId: string) => boolean,
): C[] {
  if (!account) return [];
  return list.filter((c) => c.whatsapp?.account === account && !hasBridge(c.sessionId));
}

/** How long after someone writes the bridge may answer them with a NOTICE. */
export const REPLY_WINDOW_MS = 10 * 60_000;

/**
 * May the bridge send a guest NOTICE to `to` — someone with no binding yet?
 *
 * The one exception to "only a binding": a person whose first message arrived
 * unreadable, or whose first file could not be received, has no agent and so
 * no binding, yet must be asked to send it again (the design's finding 3 —
 * and writing to them is what makes their next message readable). `recent` is
 * fed ONLY by inbound messages, so this still never writes first: it answers
 * someone who wrote minutes ago, and only with the bridge's own fixed lines.
 */
export function replyAllowed(recent: ReadonlyMap<string, number>, to: string, now: number, windowMs = REPLY_WINDOW_MS): boolean {
  const bare = bareJid(to);
  if (!bare) return false;
  const at = recent.get(bare);
  return at !== undefined && now - at >= 0 && now - at <= windowMs;
}

/**
 * May the bridge send to `to`? Only when it is an EXISTING binding of the
 * linked account. Bindings are only ever created by an inbound message, so
 * this is what makes "the bridge never writes first" a checked fact rather
 * than a property of the call sites: there is no path that takes a number as
 * input and sends to it.
 */
export function sendAllowed(list: readonly { whatsapp?: WaBinding | null }[], account: string, to: string): boolean {
  const bare = bareJid(to);
  if (!bare) return false;
  return list.some((c) => c.whatsapp?.account === account && c.whatsapp.id === bare);
}
