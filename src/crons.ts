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
  | { kind: "daily"; hour: number; minute: number }; // daily at HH:MM, dans le fuseau du cron

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
   * Fuseau IANA (« Europe/Paris ») dans lequel lire un horaire `daily`. Sans
   * lui, l'heure suit le fuseau de la MACHINE : le même `daily:09:00` tire à 9h
   * à Paris et à 9h UTC sur un serveur en UTC, soit 11h vécues. Résolu par
   * `cronTimeZone` : ce champ, sinon le défaut global (config `timezone`),
   * sinon le fuseau système — donc rien ne bouge tant que personne ne configure.
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
 * Everything a fire needs to know about the channel it drives: where to run,
 * and how to resume it. Resolved ONCE per fire and shared by both halves — the
 * deterministic guard and the session resume. They used to decide separately,
 * and the resume decided wrong (see `resolveCronTarget`).
 */
export interface CronTarget {
  /** The channel's own directory — NOT the server's cwd. Invariant nº 1. */
  cwd: string;
  /** Profile whose secrets the guard gets, and whose guardrails the resume keeps. */
  profile: string | null;
  /** Worktree branch + origin repo, to recreate a reclaimed checkout on resume. */
  branch: string | null;
  repo: string | null;
  /** False when no channel carries this sessionId: `cwd` is the fallback. */
  known: boolean;
}

/**
 * Resolve a cron's target channel. Pure on purpose: it's the single place that
 * answers "where does this cron run", so the guard and the resume can no longer
 * disagree — resuming a worktree session with the repo root loses its whole
 * history (invariant nº 1), which is exactly what that split caused.
 *
 * An unknown sessionId falls back to `fallbackCwd` instead of failing: the
 * historical behaviour, and right for the common case of a root-directory
 * channel whose registry entry was lost.
 */
export function resolveCronTarget(
  channels: readonly Channel[],
  sessionId: string,
  fallbackCwd: string,
): CronTarget {
  const ch = channels.find((x) => x.sessionId === sessionId);
  return {
    cwd: ch?.cwd?.trim() || fallbackCwd,
    profile: ch?.profile ?? null,
    branch: ch?.branch ?? null,
    repo: ch?.repo ?? null,
    known: !!ch,
  };
}

/**
 * Marque portée par le TEXTE d'un prompt envoyé par un cron.
 *
 * Pourquoi dans le contenu et pas seulement dans le protocole (`origin: "cron"`)
 * : le prompt part dans la TUI, donc Claude Code l'écrit dans le transcript
 * comme n'importe quel message utilisateur. Ne masquer que l'écho direct
 * laissait le mur de texte — le prompt PLUS la sortie de la garde, des
 * kilo-octets — revenir au rechargement de la page et dans le backfill d'un
 * topic Telegram, qui relisent tous deux `loadHistory`.
 *
 * Même parti pris que la sentinelle `NOTHING TO SHOW` : une marque dans le
 * contenu, filtrée partout où l'on rend. Elle a un second effet utile — l'agent
 * apprend que ce tour vient d'une programmation, ce que rien ne lui disait.
 */
export const CRON_PROMPT_MARK = "⏰ [cron]";

/** Préfixe le prompt d'un cron. Idempotent : re-marquer ne double pas la marque. */
export function markCronPrompt(text: string): string {
  return isCronPrompt(text) ? text : `${CRON_PROMPT_MARK} ${text}`;
}

/**
 * Ce texte est-il un prompt de cron ? Volontairement STRICT — la marque doit
 * OUVRIR le message. Un agent (ou un humain) qui cite « ⏰ [cron] » au milieu
 * d'une phrase ne doit pas voir son message disparaître : c'est le coût d'une
 * heuristique trop large que rappelle l'invariant 2.
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
  scheduledNextMs: number,
  attempts: number,
): { nextRun: number; retrying: boolean; attempts: number } {
  const giveUp = { nextRun: scheduledNextMs, retrying: false, attempts: 0 };
  // Don't loop forever on a channel that is simply broken.
  if (attempts >= CRON_MAX_RETRIES) return giveUp;
  const candidate = nowMs + CRON_RETRY_DELAY_MS;
  // The normal slot comes first (short intervals, or a daily cron whose next
  // run is imminent): retrying would fire twice in a row for nothing, and it
  // must never push a run PAST its own schedule.
  if (candidate >= scheduledNextMs) return giveUp;
  return { nextRun: candidate, retrying: true, attempts: attempts + 1 };
}

/**
 * Next fire time (ms epoch) for a schedule, strictly after `fromMs`.
 * `tz` (IANA) ne concerne que les `daily` — un intervalle est une durée, il n'a
 * pas de fuseau. Absent → heure locale de la machine (comportement historique).
 */
export function nextRunFor(s: CronSchedule, fromMs: number, tz?: string | null): number {
  if (s.kind === "interval") {
    const step = Math.max(1, Math.floor(s.everyMin)) * 60_000;
    return fromMs + step;
  }
  if (!tz || !isValidTimeZone(tz)) {
    // Fuseau machine. `setHours` sur une Date locale suit les bascules d'heure
    // d'été toute seule (9h reste 9h), d'où ce chemin conservé tel quel.
    const next = new Date(fromMs);
    next.setHours(s.hour, s.minute, 0, 0);
    if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  const today = calendarDayIn(tz, fromMs);
  let t = instantOfWallClock(tz, today.y, today.mo, today.d, s.hour, s.minute);
  if (t <= fromMs) {
    // Jour suivant du CALENDRIER (pas +24h : un jour de bascule d'heure d'été
    // dure 23 ou 25h, et l'horaire doit rester à HH:MM).
    const nd = new Date(Date.UTC(today.y, today.mo - 1, today.d) + 86_400_000);
    t = instantOfWallClock(tz, nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), s.hour, s.minute);
  }
  return t;
}

/** Le fuseau est-il un identifiant IANA que l'ICU embarqué connaît ? */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Champs horloge-murale d'un instant, lus dans `tz`. */
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
  // Certaines versions d'ICU rendent l'heure « 24 » à minuit en cycle h23.
  out.hour = out.hour % 24;
  return out;
}

/** Date du calendrier (y/mo/d) telle qu'on la vit dans `tz` à cet instant. */
function calendarDayIn(tz: string, atMs: number): { y: number; mo: number; d: number } {
  const w = wallClockIn(tz, atMs);
  return { y: w.year, mo: w.month, d: w.day };
}

/**
 * Instant (ms epoch) auquel l'horloge murale de `tz` affiche cette date/heure.
 *
 * Deux passes : l'écart au UTC dépend de l'instant cherché, qu'on ne connaît
 * qu'une fois l'écart appliqué. La première passe donne un candidat, la seconde
 * relit l'écart RÉEL à ce candidat — ce qui corrige les bascules d'heure d'été
 * (une seule passe se trompait d'une heure les deux jours de changement).
 */
function instantOfWallClock(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const offsetAt = (ms: number) => {
    const w = wallClockIn(tz, ms);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms;
  };
  return naive - offsetAt(naive - offsetAt(naive));
}

/** Validate + normalize a raw schedule object; null if invalid. */
export function normalizeSchedule(raw: any): CronSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind === "interval") {
    const everyMin = Number(raw.everyMin);
    return Number.isFinite(everyMin) && everyMin >= 1 ? { kind: "interval", everyMin: Math.floor(everyMin) } : null;
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

/** Fuseau de la machine — le repli quand rien n'est configuré. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Défaut global (config `timezone`), ignoré s'il n'est pas un fuseau valide. */
export function defaultTimeZone(): string | undefined {
  const raw = loadConfig().timezone;
  const tz = typeof raw === "string" ? raw.trim() : "";
  return tz && isValidTimeZone(tz) ? tz : undefined;
}

/**
 * Fuseau effectif d'un cron : le sien, sinon le défaut global, sinon celui de
 * la machine. Un `tz` posé sur la config répare donc d'un coup tous les crons
 * existants — c'est exactement ce qu'on veut d'un serveur qui tourne en UTC.
 */
export function cronTimeZone(c: Pick<Cron, "tz">): string {
  if (c.tz && isValidTimeZone(c.tz)) return c.tz;
  return defaultTimeZone() ?? systemTimeZone();
}

/**
 * Human label for a schedule (UI/Telegram). Le fuseau est TOUJOURS affiché pour
 * un `daily` : c'est la seule façon de repérer un serveur qui n'est pas dans le
 * fuseau qu'on croit (un « daily at 09:00 » nu ne dit pas 9h où).
 */
export function scheduleLabel(s: CronSchedule, tz?: string): string {
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
 * Résout ce que l'utilisateur a tapé en un id de cron complet.
 *
 * Toutes les surfaces n'affichent QUE les 8 premiers caractères de l'id
 * (`list` du web, de la skill, de Telegram) : accepter un préfixe n'est donc
 * pas un confort, c'est la seule façon de désigner un cron avec ce qu'on a sous
 * les yeux. Et un préfixe vide ne doit surtout pas « matcher le premier » —
 * `/cron del` sans argument supprimerait un cron au hasard.
 */
export function resolveCronId(list: Cron[], needle: string): CronLookup {
  const n = (needle ?? "").trim();
  if (!n) return { ok: false, error: "empty", matches: 0 };
  // Un id complet gagne toujours, même s'il est aussi le préfixe d'un autre.
  if (list.some((c) => c.id === n)) return { ok: true, id: n };
  const hits = list.filter((c) => c.id.startsWith(n));
  if (hits.length === 0) return { ok: false, error: "not-found", matches: 0 };
  if (hits.length > 1) return { ok: false, error: "ambiguous", matches: hits.length };
  return { ok: true, id: hits[0].id };
}
