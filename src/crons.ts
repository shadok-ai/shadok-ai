import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel } from "./channels.js";
import { loadConfig } from "./config.js";

/**
 * Per-channel scheduled prompts ("crons") for monitoring/reporting. The server
 * fires them on a timer — no session needs to stay alive between runs, so there
 * is no duration cap (unlike an agent scheduling itself). Persisted per launch
 * directory at ~/.shadok-ai/crons/<encoded cwd>.json, so they survive restarts.
 */

export type CronSchedule =
  | { kind: "interval"; everyMin: number } // every N minutes
  | { kind: "daily"; hour: number; minute: number } // daily at HH:MM, in the cron's time zone
  /**
   * One-shot: fires once at an ABSOLUTE instant, then the cron is spent.
   *
   * Stored as an epoch and not as a wall clock + tz on purpose. A `daily` is a
   * RULE, re-read every day, so changing the default timezone must move it
   * (that is what `primeCrons` does). A one-shot is an instant already
   * arbitrated at creation — moving it under the user because a global setting
   * changed would be the surprise, not the service.
   */
  | { kind: "once"; at: number };

export interface Cron {
  id: string;
  /** The channel this cron drives (its session is resumed and prompted). */
  sessionId: string;
  prompt: string;
  schedule: CronSchedule;
  enabled: boolean;
  /**
   * Optional deterministic guard command, run server-side WITHOUT the LLM
   * before each fire (in the channel's cwd, with the profile's secrets). The
   * convention: print nothing = nothing to report → the agent is NOT woken (no
   * tokens); print something = news → the agent runs, with the output prepended
   * to the prompt. Lets routine monitoring cost zero tokens on quiet runs.
   */
  check?: string;
  /**
   * IANA time zone ("Europe/Paris") a `daily` schedule is read in. Without it
   * the hour follows the MACHINE's zone: the same `daily:09:00` fires at 09:00
   * in Paris and at 09:00 UTC on a server running UTC, i.e. 11:00 as lived.
   * Resolved by `cronTimeZone`: this field, else the global default (config
   * `timezone`), else the system zone — so nothing moves until it is set.
   */
  tz?: string;
  /** ms epoch of the last fire, and the next scheduled fire. */
  lastRun?: number;
  nextRun?: number;
  /**
   * Consecutive delivery failures being retried (see `nextRunAfterFailure`),
   * reset to 0 as soon as a run lands or we give up until the next slot.
   */
  retries?: number;
  /** Why the last fire ended: "ok" | "quiet" | "check-failed" | a DriveReason.
   *  Persisted so the JSON store alone tells you what happened, without logs. */
  lastOutcome?: string;
}

/**
 * Mark carried by the TEXT of a prompt sent by a cron.
 *
 * Why in the content and not only in the protocol (`origin: "cron"`): the
 * prompt goes through the TUI, so Claude Code writes it into the transcript
 * like any other user message. Hiding only the direct echo left the wall of
 * text — the prompt PLUS the guard's output, kilobytes of it — coming back on
 * a page reload and in a Telegram topic's backfill, both of which re-read
 * `loadHistory`.
 *
 * Same choice as the `NOTHING TO SHOW` sentinel: a mark in the content,
 * filtered wherever we render. It has a useful side effect — the agent learns
 * this turn comes from a schedule, which nothing else told it.
 */
export const CRON_PROMPT_MARK = "⏰ [cron]";

/** Prefix a cron's prompt. Idempotent: re-marking does not double the mark. */
export function markCronPrompt(text: string): string {
  return isCronPrompt(text) ? text : `${CRON_PROMPT_MARK} ${text}`;
}

/**
 * Is this text a cron prompt? Deliberately STRICT — the mark must OPEN the
 * message. An agent (or a human) quoting "⏰ [cron]" mid-sentence must not see
 * its message vanish: that is the cost of an over-broad heuristic, the one
 * invariant 2 is about.
 */
export function isCronPrompt(text: string): boolean {
  return typeof text === "string" && text.trimStart().startsWith(CRON_PROMPT_MARK);
}

/** Why a cron's delivery to its channel failed. Lives here (not in server.ts)
 *  so `nextRunAfterFailure` can be typed and tested without the server. */
export type DriveReason =
  | "pace-blocked" // the pace guard refused the prompt
  | "busy" // a turn was already running on that channel
  | "error" // the server refused for another reason
  | "gone" // the channel's directory no longer exists
  | "exited" // the claude process died mid-turn
  | "ws-error" // loopback WS broke, or closed before the turn ended
  | "timeout"; // the 30 min safety cap fired

/** Delivery failures worth replaying shortly. `error` is excluded (an
 *  application-level refusal doesn't evaporate in 10 min), so is `gone` (a
 *  vanished directory won't come back in 10 min, and the resume already tries
 *  to recreate a worktree checkout) and so is `timeout` (the cap means the turn
 *  is STILL running — replaying would stack prompts). */
const TRANSIENT: ReadonlySet<DriveReason> = new Set<DriveReason>(["pace-blocked", "busy", "ws-error", "exited"]);

export function isTransient(reason: DriveReason): boolean {
  return TRANSIENT.has(reason);
}

/** How long to wait before replaying a lost run, and how many times. */
export const CRON_RETRY_DELAY_MS = 10 * 60_000;
export const CRON_MAX_RETRIES = 3;

/**
 * Where to reschedule a cron whose delivery just failed transiently.
 *
 * `attempts` is how many retries already happened for this run. The result's
 * `nextRun` is ALWAYS in the future, which is what keeps the "advance nextRun
 * before firing" anti-double-fire invariant intact.
 */
export function nextRunAfterFailure(
  nowMs: number,
  scheduledNextMs: number | null,
  attempts: number,
): { nextRun: number | null; retrying: boolean; attempts: number } {
  const giveUp = { nextRun: scheduledNextMs, retrying: false, attempts: 0 };
  // Don't loop forever on a channel that is simply broken.
  if (attempts >= CRON_MAX_RETRIES) return giveUp;
  const candidate = nowMs + CRON_RETRY_DELAY_MS;
  // The normal slot comes first (short intervals, or a daily cron whose next
  // run is imminent): retrying would fire twice in a row for nothing, and it
  // must never push a run PAST its own schedule.
  // A one-shot passes `null`: it has no next slot, so nothing caps the retry —
  // giving up on it would simply lose the reminder.
  if (scheduledNextMs !== null && candidate >= scheduledNextMs) return giveUp;
  return { nextRun: candidate, retrying: true, attempts: attempts + 1 };
}

/**
 * Next fire time (ms epoch) for a schedule, strictly after `fromMs`.
 * `tz` (IANA) only applies to `daily` — an interval is a duration, it has no
 * time zone. Absent → the machine's local time (historical behaviour).
 */
export function nextRunFor(s: CronSchedule, fromMs: number, tz?: string | null): number {
  // A one-shot never rolls forward: its instant is fixed, and returning it even
  // when it is already past is what lets a fire missed during a restart still
  // be caught up by `cronTick` (a past `nextRun` is due, not skipped).
  if (s.kind === "once") return s.at;
  if (s.kind === "interval") {
    const step = Math.max(1, Math.floor(s.everyMin)) * 60_000;
    return fromMs + step;
  }
  if (!tz || !isValidTimeZone(tz)) {
    // Machine zone. `setHours` on a local Date follows daylight-saving shifts
    // on its own (09:00 stays 09:00), which is why this path is kept as is.
    const next = new Date(fromMs);
    next.setHours(s.hour, s.minute, 0, 0);
    if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  const today = calendarDayIn(tz, fromMs);
  let t = instantOfWallClock(tz, today.y, today.mo, today.d, s.hour, s.minute);
  if (t <= fromMs) {
    // Next CALENDAR day (not +24h: a daylight-saving switch day lasts 23 or
    // 25 hours, and the schedule must stay at HH:MM).
    const nd = new Date(Date.UTC(today.y, today.mo - 1, today.d) + 86_400_000);
    t = instantOfWallClock(tz, nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), s.hour, s.minute);
  }
  return t;
}

/**
 * What firing does to a cron's OWN schedule state, applied the instant it is
 * fired (before the delivery is even attempted).
 *
 * A recurring cron advances to its next slot — that is what stops a long run
 * from double-firing. A one-shot cannot: advancing lands on the same fixed
 * instant, so it would fire forever. It is DISABLED instead, which is a
 * stronger guarantee and reuses a state `cronTick`, `primeCrons` and
 * `GET /channels` already skip. A transient delivery failure re-arms it — see
 * `nextRunAfterFailure` with a null slot.
 */
export function stateAfterFire(
  s: CronSchedule,
  nowMs: number,
  tz?: string | null,
): { enabled: boolean; nextRun?: number } {
  if (s.kind === "once") return { enabled: false, nextRun: undefined };
  return { enabled: true, nextRun: nextRunFor(s, nowMs, tz) };
}

/** Is this an IANA zone identifier the bundled ICU knows? */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant, read in `tz`. */
function wallClockIn(tz: string, atMs: number): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atMs));
  const out: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = Number(p.value);
  // Some ICU versions render hour "24" at midnight in the h23 cycle.
  out.hour = out.hour % 24;
  return out;
}

/** Calendar date (y/mo/d) as lived in `tz` at that instant. */
function calendarDayIn(tz: string, atMs: number): { y: number; mo: number; d: number } {
  const w = wallClockIn(tz, atMs);
  return { y: w.year, mo: w.month, d: w.day };
}

/**
 * Instant (ms epoch) at which `tz`'s wall clock reads that date/time.
 *
 * Two passes: the offset from UTC depends on the very instant we are looking
 * for, which we only know once the offset is applied. The first pass gives a
 * candidate, the second re-reads the REAL offset at that candidate — which
 * fixes daylight-saving switches (a single pass was an hour off on both
 * changeover days).
 */
function instantOfWallClock(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const offsetAt = (ms: number) => {
    const w = wallClockIn(tz, ms);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms;
  };
  return naive - offsetAt(naive - offsetAt(naive));
}

/** Days in a Gregorian month — so "2026-02-31" is refused instead of rolling
 *  over into March in silence. */
function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/**
 * Read a human date into the absolute instant a one-shot fires at.
 *
 * Two shapes, on purpose. A bare "2026-08-25T08:42" is a WALL CLOCK: it means
 * 08:42 where the cron lives, so it is resolved through `tz` — that is what the
 * web form, the CLI and Telegram all produce. A string carrying an explicit
 * offset (or Z) is already absolute and `tz` must NOT shift it; parsing that
 * one as a wall clock would move a correct instant by the offset.
 *
 * Returns null on anything it cannot read — never a guessed date. A reminder
 * silently scheduled for the wrong day is worse than a refused one.
 */
export function onceAt(tz: string, text: string): number | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::\d{2})?$/.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59) return null;
  const zone = isValidTimeZone(tz) ? tz : systemTimeZone();
  return instantOfWallClock(zone, y, mo, d, h, mi);
}

/** Validate + normalize a raw schedule object; null if invalid. */
export function normalizeSchedule(raw: any): CronSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind === "interval") {
    const everyMin = Number(raw.everyMin);
    return Number.isFinite(everyMin) && everyMin >= 1 ? { kind: "interval", everyMin: Math.floor(everyMin) } : null;
  }
  if (raw.kind === "once") {
    // `at` arrives as a string from an HTTP body often enough to accept one.
    const at = Number(raw.at);
    return Number.isFinite(at) && at > 0 ? { kind: "once", at: Math.floor(at) } : null;
  }
  if (raw.kind === "daily") {
    const hour = Number(raw.hour);
    const minute = Number(raw.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { kind: "daily", hour, minute };
  }
  return null;
}

/** The machine's zone — the fallback when nothing is configured. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Global default (config `timezone`), ignored unless it is a valid zone. */
export function defaultTimeZone(): string | undefined {
  const raw = loadConfig().timezone;
  const tz = typeof raw === "string" ? raw.trim() : "";
  return tz && isValidTimeZone(tz) ? tz : undefined;
}

/**
 * A cron's effective zone: its own, else the global default, else the
 * machine's. Setting `tz` on the config therefore fixes every existing cron at
 * once — exactly what you want on a server running UTC.
 */
export function cronTimeZone(c: Pick<Cron, "tz">): string {
  if (c.tz && isValidTimeZone(c.tz)) return c.tz;
  return defaultTimeZone() ?? systemTimeZone();
}

/**
 * Human label for a schedule (UI/Telegram). The zone is ALWAYS shown for a
 * `daily`: it is the only way to spot a server that is not in the zone you
 * assume (a bare "daily at 09:00" does not say 09:00 where).
 */
export function scheduleLabel(s: CronSchedule, tz?: string): string {
  if (s.kind === "once") {
    const zone = tz || systemTimeZone();
    const w = wallClockIn(zone, s.at);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `once at ${w.year}-${p2(w.month)}-${p2(w.day)} ${p2(w.hour)}:${p2(w.minute)} (${zone})`;
  }
  if (s.kind === "interval") {
    if (s.everyMin % 60 === 0) return `every ${s.everyMin / 60}h`;
    return `every ${s.everyMin}m`;
  }
  const hhmm = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  return `daily at ${hhmm} (${tz || systemTimeZone()})`;
}

function storeFile(): string {
  const enc = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".shadok-ai", "crons", enc + ".json");
}

export function loadCrons(): Cron[] {
  try {
    const v = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return Array.isArray(v) ? v.filter((c) => c && typeof c.sessionId === "string" && c.schedule) : [];
  } catch {
    return [];
  }
}

export function saveCrons(list: Cron[]): void {
  const f = storeFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(list, null, 2));
  } catch {
    /* best effort */
  }
}

/** Insert or replace a cron by id. */
export function upsertCron(cron: Cron): void {
  const list = loadCrons().filter((c) => c.id !== cron.id);
  list.push(cron);
  saveCrons(list);
}

export function removeCron(id: string): void {
  saveCrons(loadCrons().filter((c) => c.id !== id));
}

export type CronLookup =
  | { ok: true; id: string }
  | { ok: false; error: "empty" | "not-found" | "ambiguous"; matches: number };

/**
 * Resolve what the user typed into a full cron id.
 *
 * Every surface shows ONLY the first 8 characters of the id (the web, skill
 * and Telegram `list`), so accepting a prefix is not a convenience: it is the
 * only way to name a cron with what is on screen. And an empty prefix must
 * never "match the first one" — a bare `/cron del` would delete a cron at
 * random.
 */
export function resolveCronId(list: Cron[], needle: string): CronLookup {
  const n = (needle ?? "").trim();
  if (!n) return { ok: false, error: "empty", matches: 0 };
  // A full id always wins, even when it is also the prefix of another.
  if (list.some((c) => c.id === n)) return { ok: true, id: n };
  const hits = list.filter((c) => c.id.startsWith(n));
  if (hits.length === 0) return { ok: false, error: "not-found", matches: 0 };
  if (hits.length > 1) return { ok: false, error: "ambiguous", matches: hits.length };
  return { ok: true, id: hits[0].id };
}
