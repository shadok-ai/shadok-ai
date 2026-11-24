import fs from "node:fs";
import path from "node:path";

/**
 * What was received from WhatsApp and not yet submitted to an agent — and the
 * message ids already seen — persisted, so a server restart loses nothing and
 * replays nothing (design constraint 11).
 *
 * Why it must exist: the library acknowledges a message on RECEIPT, before
 * anything of ours runs, so WhatsApp will never deliver it again. A prompt can
 * sit in memory for the seconds an agent takes to spawn, and the server
 * restarts on every auto-update. Without this file, that window is a message
 * gone for good, with nobody told.
 *
 * Lives in `~/.shadok-ai/whatsapp-state/<instanceKey>/`, BESIDE the session
 * directory and not in it: Link wipes the session (it is the account's
 * credentials), while the agents — and a message waiting for one — are not the
 * session's. 0700 / 0600: it holds strangers' words.
 */

export interface InboxEntry {
  /** The WhatsApp message id — the dedup key. */
  id: string;
  /** The canonical sender (`senderKey`): who the prompt goes to. */
  sender: string;
  /** The chat the message ARRIVED on (its `remoteJid`), which the read receipt
   *  must name — it may be the phone address while `sender` is the LID.
   *  Absent on entries written before receipts existed: `sender` stands in. */
  chat?: string;
  /** Their phone digits and display name, when known — what a FRESH spawn
   *  binds and names the channel with. */
  phone?: string;
  name?: string;
  /** The text — or a medium's caption ("" when it has none). */
  text: string;
  at: number;
  /** A medium (step 3), already downloaded to a STAGING file beside the inbox:
   *  the library's message does not survive a restart, this file does. It is
   *  removed with the entry's acknowledgement. */
  media?: { path: string; kind: "image" | "document" | "audio" | "video"; mime?: string; voice?: boolean };
}

export interface Inbox {
  seen(id: string): boolean;
  /** Record a message as received. False when its id was already seen: a
   *  redelivery (a reconnect, the library's own resend) is one message, once. */
  add(e: InboxEntry): boolean;
  /** The message reached its agent (or was refused, and the person told). */
  ack(id: string): void;
  pending(): InboxEntry[];
}

export function waStateDir(home: string, instanceKey: string): string {
  return path.join(home, ".shadok-ai", "whatsapp-state", instanceKey);
}

const SEEN_CAP = 2000;

export function openInbox(file: string, o: { seenCap?: number; log?: (l: string) => void } = {}): Inbox {
  const cap = o.seenCap ?? SEEN_CAP;
  const log = o.log ?? ((l: string) => console.log(l));
  let pending: InboxEntry[] = [];
  let seen: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { pending?: unknown; seen?: unknown };
    if (Array.isArray(raw.pending))
      pending = raw.pending.filter(
        (e): e is InboxEntry =>
          !!e && typeof e.id === "string" && typeof e.sender === "string" && typeof e.text === "string",
      );
    if (Array.isArray(raw.seen)) seen = raw.seen.filter((x): x is string => typeof x === "string");
  } catch (e) {
    // Absent is the normal first start. Unreadable is said, never thrown: a
    // broken inbox must not take the bridge — and every guest — down with it.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`whatsapp: the inbox file was unreadable, starting empty (${file})`);
  }
  const seenSet = new Set(seen);

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pending, seen }), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  };

  return {
    seen: (id) => seenSet.has(id) || pending.some((e) => e.id === id),
    add(e) {
      if (seenSet.has(e.id) || pending.some((p) => p.id === e.id)) return false;
      pending.push(e);
      seen.push(e.id);
      seenSet.add(e.id);
      // The cap bounds the seen ids only; a pending entry is never dropped by it.
      while (seen.length > cap) seenSet.delete(seen.shift()!);
      save();
      return true;
    },
    ack(id) {
      const before = pending.length;
      pending = pending.filter((e) => e.id !== id);
      if (pending.length !== before) save();
    },
    pending: () => pending.map((e) => ({ ...e })),
  };
}
