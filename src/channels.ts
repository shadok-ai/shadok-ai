import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A Telegram chat/topic a channel is bound to (folded into the channel). */
export interface TgBinding {
  chatId: number;
  threadId?: number;
}

/** A remembered session — the ONE registry, whatever created it (web or
 *  Telegram). Enough to restore, resume, and route it. */
export interface Channel {
  sessionId: string;
  cwd: string;
  name?: string;
  branch?: string | null;
  /** Repo the worktree belongs to, to recreate a reclaimed checkout. */
  repo?: string;
  /** Tab group id (client-owned metadata). */
  group?: number | null;
  /** The environment's home base: pinned, never closable. Server-owned, so a
   *  stale client's PUT cannot clear it. See `isHomeChannel`. */
  home?: boolean;
  /** Present iff the session is bound to a Telegram chat/topic — what IS. */
  telegram?: TgBinding | null;
  /** What the user WANTS: should this channel also live in Telegram?
   *  Distinct from `telegram` — without an explicit intent, "not mirrored yet"
   *  and "deliberately not mirrored" are indistinguishable, and the reconcile
   *  loop would recreate the very topic we just deleted. */
  mirror?: boolean;
  /** Agent profile applied at spawn (role/guardrails/secrets) — re-applied on
   *  resume/restart so the guardrails aren't lost. */
  profile?: string | null;
  /** The channel that spawned this one, or one attached to it by hand. Only
   *  this parent is told when the agent finishes, blocks on a question or dies
   *  — without that scoping a chatty channel would wake a boss on every turn,
   *  and a wake in a large session is not free. The CHILD stores its parent and
   *  never the reverse, so there is one writer per fact and the two directions
   *  cannot disagree. */
  parent?: string | null;
  /** Muted channel: it raises no global signal (favicon pip, title badge,
   *  blink, chime). Client-owned like `name`/`group`, stored here so the mute
   *  survives a reload and follows the user's other devices. */
  muted?: boolean;
}

/**
 * Should this channel be mirrored into Telegram?
 *
 * Falling back to `!!c.telegram` is what makes the migration free: a channel
 * that already has a binding stays mirrored without writing anything, so a
 * running install doesn't un-mirror itself on deploy. It also makes the field
 * robust to a client that ignores it (`mirror` is client-owned, hence absent
 * from an old tab's PUT): with no intent, the binding decides.
 */
export function isMirrored(c: Channel): boolean {
  return c.mirror ?? !!c.telegram;
}

/** Fields the server owns; a browser PUT must never overwrite or drop them. */
const SERVER_OWNED = ["cwd", "branch", "repo", "telegram", "profile", "parent", "home"] as const;

/**
 * Pure: is this channel the environment's home base — pinned and never closable?
 *
 * Two ways to be one, and both are needed. The explicit `home` flag is set on
 * the lead agent an instance starts life with. The Telegram clause is the rule
 * that predates the flag and is kept verbatim, so an instance already running
 * with a bound board does not lose its home base on upgrade.
 *
 * The `chatId < 0` half of that clause is load-bearing: a DM binding ALSO has no
 * threadId, but it is an ordinary channel that must stay closable — treating it
 * as home once made a bogus second "general" appear.
 */
export function isHomeChannel(c: Pick<Channel, "home" | "telegram">): boolean {
  if (c.home) return true;
  return !!c.telegram && c.telegram.threadId == null && c.telegram.chatId < 0;
}

/**
 * Pure: the channel an existing instance should adopt as its home base, or null.
 *
 * For cockpits that predate the flag. It only ever designates a channel already
 * playing the part — named `general`, in the launch directory, with no worktree
 * — and **refuses when it cannot tell**: zero candidates, or several. A wrong
 * adoption is irreversible from the UI, since the channel becomes precisely the
 * one that cannot be closed; doing nothing always stays recoverable.
 */
export function homeAdoptionTarget(channels: Channel[], launchCwd: string): string | null {
  if (channels.some((c) => isHomeChannel(c))) return null;
  const candidates = channels.filter(
    (c) => c.name === "general" && c.cwd === launchCwd && !c.branch,
  );
  return candidates.length === 1 ? candidates[0].sessionId : null;
}

/**
 * The registry is stored server-side, keyed by the directory the server was
 * launched from — so the set of sessions survives a wiped browser, another
 * device, a restart, or a reboot. One file per launch dir:
 * ~/.shadok-ai/channels/<encoded cwd>.json.
 */
function storeFile(kind: string): string {
  const enc = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  const suffix = kind === "channels" ? "" : "-" + kind;
  return path.join(os.homedir(), ".shadok-ai", "channels", enc + suffix + ".json");
}

function readJson(kind: string): any[] {
  try {
    const v = JSON.parse(fs.readFileSync(storeFile(kind), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeJson(kind: string, value: any[]): void {
  const f = storeFile(kind);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(value, null, 2));
  } catch {
    // best effort: losing the persisted list is non-fatal
  }
}

export function loadChannels(): Channel[] {
  return readJson("channels").filter((c) => c && typeof c.sessionId === "string");
}
export function saveChannels(list: Channel[]): void {
  writeJson("channels", list);
}

/**
 * Insert or update a channel by sessionId, shallow-merging the given fields
 * (an `undefined` field never clobbers an existing value). The server calls
 * this whenever a session reaches `ready`, so every session — web or Telegram —
 * lands in the one list.
 */
/** Pure core of upsertChannel — returns a new list; exported for testing. */
export function upsertInto(list: Channel[], patch: Partial<Channel> & { sessionId: string }): Channel[] {
  const out = list.map((c) => ({ ...c }));
  const cur = out.find((c) => c.sessionId === patch.sessionId);
  if (!cur) {
    out.push({ cwd: "", ...patch });
  } else {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (cur as any)[k] = v;
  }
  return out;
}

export function upsertChannel(patch: Partial<Channel> & { sessionId: string }): void {
  saveChannels(upsertInto(loadChannels(), patch));
}

export function removeChannel(sessionId: string): void {
  saveChannels(loadChannels().filter((c) => c.sessionId !== sessionId));
}

/** Pure lookup of the channel bound to a Telegram chat/topic. */
export function findTelegramChannel(list: Channel[], chatId: number, threadId?: number): Channel | undefined {
  return list.find(
    (c) => c.telegram && c.telegram.chatId === chatId && (c.telegram.threadId ?? undefined) === threadId,
  );
}

/** The channel bound to a given Telegram chat/topic, or undefined. */
export function channelForTelegram(chatId: number, threadId?: number): Channel | undefined {
  return findTelegramChannel(loadChannels(), chatId, threadId);
}

/**
 * Pure core of the PUT merge (exported for testing). The client drives order
 * and its own metadata (name, group); server-owned fields are preserved per
 * sessionId, and any stored channel the client omitted is kept when its session
 * is live or it has a Telegram binding — so persistence never drops a
 * live/Telegram session (invariant #6).
 */
export function mergeChannels(stored: Channel[], clientList: Channel[], liveIds: Set<string>): Channel[] {
  const byId = new Map(stored.map((c) => [c.sessionId, c]));
  const result: Channel[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(clientList) ? clientList : []) {
    if (!c || typeof c.sessionId !== "string") continue;
    seen.add(c.sessionId);
    const prev = byId.get(c.sessionId);
    if (!prev) {
      result.push(c); // a new channel the client just created
      continue;
    }
    const merged: Channel = { ...c };
    for (const k of SERVER_OWNED) if (prev[k] !== undefined) (merged as any)[k] = prev[k];
    result.push(merged);
  }
  for (const c of stored) {
    if (seen.has(c.sessionId)) continue;
    if (liveIds.has(c.sessionId) || c.telegram) result.push(c); // never erase live/Telegram
  }
  // The main channel — a GROUP's General topic (no threadId) — is always named
  // "general", server-authoritative so a stale client can't rename it. A DM
  // binding ALSO has no threadId but is NOT the main channel; forcing it to
  // "general" made a bogus second "general" appear. Gate on chatId < 0 (a
  // group/supergroup); DMs (positive chatId) keep their own name, and one that
  // was wrongly forced to "general" gets un-named here.
  for (const c of result) {
    if (!c.telegram || c.telegram.threadId != null) continue;
    if (c.telegram.chatId < 0) c.name = "general";
    else if (c.name === "general") c.name = undefined;
  }
  return result;
}

export function mergeClientChannels(clientList: Channel[], liveIds: Set<string>): Channel[] {
  const result = mergeChannels(loadChannels(), clientList, liveIds);
  saveChannels(result);
  return result;
}

/** Tab groups (id, name, collapsed, order), persisted the same way as channels. */
export function loadGroups(): any[] {
  return readJson("groups");
}
export function saveGroups(list: any[]): void {
  writeJson("groups", list);
}

/** The single group this instance is bound to (one board per instance), or null.
 *  Instance-level, not a session — kept separate from the channel registry. */
export function loadTgGroup(): number | null {
  const v = readJson("telegram-group")[0];
  return typeof v === "number" ? v : null;
}
export function saveTgGroup(groupId: number | null): void {
  writeJson("telegram-group", groupId == null ? [] : [groupId]);
}

/**
 * Les canaux Telegram (`bindKey`) où les appels d'outils sont AFFICHÉS. Une
 * allowlist et pas une map clé → booléen : le défaut (masqué) ne coûte aucune
 * entrée, et un fichier absent ou illisible se dégrade exactement en « tout est
 * masqué » — le défaut voulu.
 *
 * Le réglage appartient au topic, pas à la session : `/new` recrée une session
 * dans le même topic et doit garder le choix de l'utilisateur.
 */
export function loadTgToolKeys(): string[] {
  return readJson("telegram-tools").filter((k) => typeof k === "string");
}

/** Pure core of setTgTools — returns a new list; exported for testing. */
export function setToolKeys(keys: string[], key: string, on: boolean): string[] {
  const without = keys.filter((k) => k !== key);
  return on ? [...without, key] : without;
}

export function tgToolsEnabled(key: string): boolean {
  return loadTgToolKeys().includes(key);
}

export function setTgTools(key: string, on: boolean): void {
  writeJson("telegram-tools", setToolKeys(loadTgToolKeys(), key, on));
}

/**
 * Le propriétaire des messages privés : l'id Telegram du premier utilisateur à
 * avoir écrit au bot en DM. Sans lui, un inconnu qui trouve le bot obtient une
 * session Claude sur la machine — les groupes sont déjà bornés au groupe lié,
 * les DM ne l'étaient pas.
 */
export function loadTgOwner(): number | null {
  const v = readJson("telegram-owner")[0];
  return typeof v === "number" ? v : null;
}
export function saveTgOwner(userId: number | null): void {
  writeJson("telegram-owner", userId == null ? [] : [userId]);
}

/**
 * Every forum topic the bot has created or seen (the Telegram Bot API can't
 * list topics, so we track them ourselves). Used by the boot reconciliation to
 * find orphan topics — ones that exist but have no channel — and delete them.
 */
export function loadTgTopics(): number[] {
  return readJson("telegram-topics").filter((n) => typeof n === "number");
}
export function saveTgTopics(list: number[]): void {
  writeJson("telegram-topics", [...new Set(list)]);
}
export function addTgTopic(threadId: number): void {
  const l = loadTgTopics();
  if (!l.includes(threadId)) saveTgTopics([...l, threadId]);
}

/**
 * One-time migration of the old separate `…-telegram.json` bindings into the
 * channel registry. Idempotent: renames the file once folded so it's never
 * re-applied. cwd/name are filled in later when the session next reaches ready.
 */
export function migrateTgBindings(): void {
  const f = storeFile("telegram");
  let raw: string;
  try {
    raw = fs.readFileSync(f, "utf8");
  } catch {
    return; // already migrated or never existed
  }
  let bindings: any[];
  try {
    bindings = JSON.parse(raw);
  } catch {
    return;
  }
  if (Array.isArray(bindings)) {
    for (const b of bindings) {
      if (b && typeof b.sessionId === "string" && typeof b.chatId === "number") {
        upsertChannel({
          sessionId: b.sessionId,
          telegram: { chatId: b.chatId, ...(typeof b.threadId === "number" ? { threadId: b.threadId } : {}) },
        });
      }
    }
  }
  try {
    fs.renameSync(f, f + ".migrated");
  } catch {
    /* best effort */
  }
}
