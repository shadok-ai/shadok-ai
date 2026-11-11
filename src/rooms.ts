import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TgBinding } from "./channels.js";
import { canSeeGroup, type Group, type Viewer } from "./groups.js";
import { instanceKey } from "./paths.js";

/**
 * Rooms: channels with no agent, where PEOPLE talk.
 *
 * A room is deliberately NOT a row of the channel registry (`channels.ts`).
 * That registry answers "which agents exist", and every consumer of it reads it
 * that way: the client resumes each row, the Telegram reconciler opens a bridge
 * (= spawns an agent) behind each mirrored row, `firstAgentPlan` counts rows,
 * crons, kinship and the ledger list them. A row with no process behind it
 * would make each of those either spawn a `claude` or misbehave, and the only
 * thing a room must never do is run one. A separate registry makes that
 * mistake impossible rather than merely checked. Design:
 * docs/superpowers/specs/2026-11-02-human-rooms-design.md.
 *
 * Storage, per launch dir (keyed like channels, crons and the ledger):
 *   ~/.shadok-ai/rooms/<key>.json            the room list (rewritten atomically)
 *   ~/.shadok-ai/rooms/<key>.read.json       per account, the last message seen
 *   ~/.shadok-ai/rooms/<key>/<roomId>.jsonl  the messages, APPEND-ONLY
 * Messages are appended and never rewritten, the reason the secret audit log is
 * JSONL too: two processes never rewrite each other's lines, and a crash
 * mid-write costs one truncated last line, which `parseMessages` skips.
 */

export interface Room {
  /** `r_` + 16 hex chars: never UUID-shaped, so it can never pass for a session id. */
  id: string;
  name: string;
  /** Same group ids as channels: one column, one set of groups. */
  group?: string | null;
  createdBy: string;
  createdAt: number;
  /** Present iff the room is bound to a Telegram topic — what IS. Server-owned. */
  telegram?: TgBinding | null;
  /** What the user WANTS (same meaning as `Channel.mirror`). */
  mirror?: boolean;
  /** Closed rooms are archived, never deleted: a conversation between people is
   *  a record someone wants back the week after. */
  archivedAt?: number;
}

export interface RoomMessage {
  id: string;
  ts: number;
  /** Display name: the account on the web, the sender on Telegram. */
  author: string;
  /** Set only when the server KNOWS the account (a web session). */
  account?: string;
  origin: "web" | "telegram";
  text: string;
  /** The Telegram message id, for the mirror (dedup). */
  tgMessageId?: number;
}

export const ROOM_ID_RE = /^r_[0-9a-f]{16}$/;
export const ROOM_NAME_MAX = 80;
/** A room message is chat, not a document: past this it is refused, out loud. */
export const ROOM_TEXT_MAX = 16_000;
export const ROOM_PAGE = 200;

export function newRoomId(): string {
  return "r_" + randomBytes(8).toString("hex");
}
export function isRoomId(s: unknown): s is string {
  return typeof s === "string" && ROOM_ID_RE.test(s);
}

/** The trimmed name, or an explicit refusal. */
export function roomName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) return { ok: false, error: "a room needs a name" };
  if (name.length > ROOM_NAME_MAX) return { ok: false, error: `a room name is at most ${ROOM_NAME_MAX} characters` };
  return { ok: true, name };
}

/**
 * The group a NEW room is filed into: the one the caller asked for, but only if
 * it exists and the caller may see it; otherwise the commons (null). A caller
 * can place a room in a group they belong to, never plant one in a group they
 * do not — `spawnGroupForRequest`'s rule, minus the parent clause (a room has
 * no launcher).
 */
export function roomGroupFor(requested: unknown, groups: readonly Group[], viewer: Viewer | null): string | null {
  if (typeof requested !== "string" || !requested.trim()) return null;
  const g = groups.find((x) => x.id === requested.trim());
  return g && canSeeGroup(g, viewer) ? g.id : null;
}

/**
 * The rooms a viewer may see: not archived, and the group rule of
 * `visibleChannels` — no group → the commons, visible to all; a dangling group
 * id → HIDDEN (fail closed, a lost group row must never reveal its rooms).
 */
export function visibleRooms(rooms: readonly Room[], groups: readonly Group[], viewer: Viewer | null): Room[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  return rooms.filter((r) => {
    if (r.archivedAt) return false;
    if (!r.group) return true;
    const g = byId.get(r.group);
    return !!g && canSeeGroup(g, viewer);
  });
}

export function canSeeRoom(room: Room | undefined, groups: readonly Group[], viewer: Viewer | null): boolean {
  return !!room && visibleRooms([room], groups, viewer).length === 1;
}

/** Why a post is refused, or null. A `code` a client can switch on, and words. */
export function postRefusal(room: Room | undefined, text: unknown): { code: string; error: string } | null {
  if (!room) return { code: "unknown-room", error: "no such room" };
  if (room.archivedAt) return { code: "archived", error: "this room is closed" };
  if (typeof text !== "string" || !text.trim()) return { code: "empty", error: "an empty message" };
  if (text.length > ROOM_TEXT_MAX) return { code: "too-long", error: `a message is at most ${ROOM_TEXT_MAX} characters` };
  return null;
}

/** Pure: the list with one room's mutable fields changed. Server-owned fields
 *  (`id`, `createdBy`, `createdAt`, `telegram`, `archivedAt`) never move here. */
export function patchRoomIn(
  list: readonly Room[],
  id: string,
  patch: { name?: string; group?: string | null; mirror?: boolean },
): Room[] {
  return list.map((r) => {
    if (r.id !== id) return r;
    const next: Room = { ...r };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.group !== undefined) next.group = patch.group;
    if (patch.mirror !== undefined) next.mirror = patch.mirror;
    return next;
  });
}

/** Pure: parse a JSONL message file, skipping any line that is not a message
 *  (a truncated last line after a crash, a stray edit). */
export function parseMessages(raw: string): RoomMessage[] {
  const out: RoomMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m.id === "string" && typeof m.ts === "number" && typeof m.text === "string") out.push(m);
    } catch {
      /* a torn line: skip it, never fail the whole room */
    }
  }
  return out;
}

/** Pure: the page of messages strictly before `before` (all when absent), the
 *  newest `limit` of them, oldest first. */
export function pageMessages(msgs: readonly RoomMessage[], before: number | undefined, limit: number = ROOM_PAGE): RoomMessage[] {
  const upTo = before === undefined ? msgs : msgs.filter((m) => m.ts < before);
  return upTo.slice(Math.max(0, upTo.length - limit));
}

/** Pure: how many messages after `lastRead` were written by someone else. */
export function unreadCount(msgs: readonly RoomMessage[], lastRead: number, account: string | null): number {
  let n = 0;
  for (const m of msgs) if (m.ts > lastRead && !(account && m.account === account)) n++;
  return n;
}

/** Pure: the (live) room mirrored into this Telegram topic. */
export function roomForTopic(rooms: readonly Room[], chatId: number, threadId: number | undefined): Room | undefined {
  if (threadId == null) return undefined; // a room is a topic, never a DM nor a General
  return rooms.find((r) => !r.archivedAt && r.telegram?.chatId === chatId && r.telegram?.threadId === threadId);
}

/** The text a room message becomes in a Telegram topic. Pure. */
export function telegramLine(m: Pick<RoomMessage, "author" | "text">): string {
  return `**${m.author}**\n${m.text}`;
}

// ── Storage ──────────────────────────────────────────────────────────────

export function roomsRoot(home: string = os.homedir()): string {
  return path.join(home, ".shadok-ai", "rooms");
}

/**
 * The on-disk store. A class only so tests can point it at a scratch dir; the
 * server keeps one. The message cache is keyed on the file's size: an append
 * always grows it, so a stale entry is impossible without a rewrite, and the
 * 4 s list poll does not re-read every room each time.
 */
export class RoomStore {
  private cache = new Map<string, { size: number; msgs: RoomMessage[] }>();
  constructor(
    private readonly root: string = roomsRoot(),
    private readonly key: string = instanceKey(),
  ) {}

  private listFile(): string {
    return path.join(this.root, this.key + ".json");
  }
  private readFile(): string {
    return path.join(this.root, this.key + ".read.json");
  }
  private msgFile(id: string): string {
    if (!isRoomId(id)) throw new Error("bad room id");
    return path.join(this.root, this.key, id + ".jsonl");
  }

  private writeAtomic(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  list(): Room[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.listFile(), "utf8"));
      return Array.isArray(v) ? v.filter((r) => r && isRoomId(r.id) && typeof r.name === "string") : [];
    } catch {
      return [];
    }
  }
  save(list: Room[]): void {
    this.writeAtomic(this.listFile(), list);
  }
  get(id: string): Room | undefined {
    return this.list().find((r) => r.id === id);
  }
  /** Read-modify-write of ONE room; returns it, or undefined when unknown. */
  update(id: string, fn: (r: Room) => Room): Room | undefined {
    const list = this.list();
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return undefined;
    list[i] = fn(list[i]);
    this.save(list);
    return list[i];
  }
  create(room: Room): void {
    this.save([...this.list(), room]);
  }

  messages(id: string): RoomMessage[] {
    const file = this.msgFile(id);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return [];
    }
    const hit = this.cache.get(id);
    if (hit && hit.size === size) return hit.msgs;
    const msgs = parseMessages(fs.readFileSync(file, "utf8"));
    this.cache.set(id, { size, msgs });
    return msgs;
  }
  append(id: string, m: RoomMessage): void {
    const file = this.msgFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(m) + "\n", { mode: 0o600 });
  }

  /** `{ [roomId]: { [account]: ts } }` */
  private marks(): Record<string, Record<string, number>> {
    try {
      const v = JSON.parse(fs.readFileSync(this.readFile(), "utf8"));
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  lastRead(id: string, account: string): number {
    const v = this.marks()[id]?.[account];
    return typeof v === "number" ? v : 0;
  }
  /** Only ever moves FORWARD: an old tab catching up must not resurrect unread. */
  markRead(id: string, account: string, ts: number): void {
    const all = this.marks();
    const cur = all[id]?.[account] ?? 0;
    if (ts <= cur) return;
    all[id] = { ...(all[id] ?? {}), [account]: ts };
    this.writeAtomic(this.readFile(), all);
  }
}
