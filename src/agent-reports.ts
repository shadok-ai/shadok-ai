/**
 * Agent reports — the place an agent that is STUCK goes to ask an admin for
 * help: an expired Linear token, no access to the Slack token it was told to
 * use, a Claude API key answering 401, a bug in shadok itself.
 *
 * Before this, the only way out was to say it in its own chat, which nobody
 * reads if nobody is watching that agent — so a cron agent blocked on a dead
 * token failed every hour, silently, for days. A report lands in ONE place every
 * admin sees (the Reports panel, with a badge), and the Telegram owner gets a DM.
 *
 * Spec: docs/superpowers/specs/2026-11-10-agent-reports.md. Pure cores
 * (`reportInput`, `fileReport`, `rateRefusal`, `shouldNotify`, `reportsInbox`,
 * `markReportsSeen`, `resolveReport`, `notificationText`) are tested; the file
 * I/O is the thin part.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceKey } from "./paths.js";

/** What kind of help is asked. `access` is the common one: a credential that is
 *  missing, expired or refused — which an admin fixes in the vault. */
export const REPORT_KINDS = ["access", "bug", "blocked"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface AgentReport {
  id: string;
  /** First filed. */
  at: number;
  /** Last filed again (a duplicate bumps it and `count`). */
  lastAt: number;
  sessionId: string;
  /** The agent's display name and group at filing time — the agent may be gone
   *  by the time someone reads it. */
  agent: string;
  group?: string | null;
  profile?: string | null;
  kind: ReportKind;
  title: string;
  body?: string;
  /** For `access`: the environment variable / vault name concerned, so the panel
   *  can open the vault on it. */
  secret?: string;
  count: number;
  status: "open" | "resolved";
  resolvedBy?: string;
  resolvedAt?: number;
  /** When the owner was last DMed about it (a duplicate re-notifies at most hourly). */
  notifiedAt?: number;
  /** Admins who have opened the panel since it was (re)filed. */
  seenBy?: string[];
}

export const TITLE_MAX = 200;
export const BODY_MAX = 8000;
/** A runaway agent must not flood the admins: new reports per agent per hour. */
export const MAX_NEW_PER_HOUR = 10;
/** A duplicate re-notifies at most this often. */
export const RENOTIFY_MS = 3600_000;
export const MAX_REPORTS = 500;
/** Resolved reports are kept this long, open ones until resolved. */
export const RESOLVED_TTL_MS = 30 * 24 * 3600_000;

/** Same shape as the vault's names (src/secrets.ts): what an env var can be. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type ReportInput = { kind: ReportKind; title: string; body?: string; secret?: string };

/** Validate what an agent posted. Never echoes the body back. */
export function reportInput(raw: unknown): { ok: true; input: ReportInput } | { ok: false; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim().replace(/\s+/g, " ") : "";
  if (!title) return { ok: false, error: "a report needs a title: one line saying what is wrong" };
  if (title.length > TITLE_MAX) return { ok: false, error: `title too long (max ${TITLE_MAX} characters) — put the detail in the body` };
  const kind = b.kind === undefined || b.kind === "" ? "bug" : b.kind;
  if (!REPORT_KINDS.includes(kind as ReportKind)) return { ok: false, error: `kind must be one of ${REPORT_KINDS.join(", ")}` };
  const body = typeof b.body === "string" ? b.body.trim() : "";
  if (body.length > BODY_MAX) return { ok: false, error: `body too long (max ${BODY_MAX} characters)` };
  const secret = typeof b.secret === "string" ? b.secret.trim() : "";
  if (secret && !ENV_NAME.test(secret)) return { ok: false, error: "secret must be an environment variable NAME (e.g. LINEAR_API_KEY), never its value" };
  return { ok: true, input: { kind: kind as ReportKind, title, ...(body ? { body } : {}), ...(secret ? { secret } : {}) } };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Drop what has aged out: resolved reports past their TTL, then the oldest beyond the cap. */
function prune(list: AgentReport[], now: number): AgentReport[] {
  const kept = list.filter((r) => r.status === "open" || now - (r.resolvedAt ?? r.lastAt) <= RESOLVED_TTL_MS);
  return kept.length > MAX_REPORTS ? [...kept].sort((a, b) => a.lastAt - b.lastAt).slice(-MAX_REPORTS) : kept;
}

/**
 * Refuse a NEW report from an agent that already filed `MAX_NEW_PER_HOUR` in the
 * last hour. Duplicates are not counted (they merge), so an agent retrying the
 * same failure in a loop is never refused — it just bumps the count.
 */
export function rateRefusal(list: AgentReport[], sessionId: string, now: number): string | null {
  const recent = list.filter((r) => r.sessionId === sessionId && now - r.at < 3600_000).length;
  return recent >= MAX_NEW_PER_HOUR ? `too many reports from this agent in the last hour (max ${MAX_NEW_PER_HOUR}) — wait for an admin` : null;
}

/**
 * File a report. An OPEN report from the same agent with the same title is the
 * same problem seen again: it is bumped (count, lastAt, latest body, unread
 * again), never duplicated.
 */
export function fileReport(
  list: AgentReport[],
  input: ReportInput,
  who: { sessionId: string; agent: string; group?: string | null; profile?: string | null },
  now: number,
  id?: string,
): { list: AgentReport[]; report: AgentReport; merged: boolean } {
  const same = list.find((r) => r.status === "open" && r.sessionId === who.sessionId && norm(r.title) === norm(input.title));
  if (same) {
    const report: AgentReport = {
      ...same,
      lastAt: now,
      count: same.count + 1,
      kind: input.kind,
      ...(input.body ? { body: input.body } : {}),
      ...(input.secret ? { secret: input.secret } : {}),
      seenBy: [],
    };
    return { list: prune(list.map((r) => (r.id === same.id ? report : r)), now), report, merged: true };
  }
  const report: AgentReport = {
    id: id ?? randomBytes(9).toString("base64url"),
    at: now,
    lastAt: now,
    sessionId: who.sessionId,
    agent: who.agent,
    ...(who.group !== undefined ? { group: who.group } : {}),
    ...(who.profile ? { profile: who.profile } : {}),
    ...input,
    count: 1,
    status: "open",
    seenBy: [],
  };
  return { list: prune([...list, report], now), report, merged: false };
}

/** DM the owner for a new report; for a duplicate, only if the last DM is an hour old. */
export function shouldNotify(r: AgentReport, merged: boolean, now: number): boolean {
  if (!merged) return true;
  return now - (r.notifiedAt ?? 0) >= RENOTIFY_MS;
}

export interface ReportsInbox {
  /** Open first (newest activity first), then resolved. */
  reports: (AgentReport & { unread: boolean })[];
  /** Open reports this admin has not seen since they were (re)filed. */
  badge: number;
}

export function reportsInbox(list: AgentReport[], viewer: string): ReportsInbox {
  const rows = [...list]
    .sort((a, b) => (a.status === b.status ? b.lastAt - a.lastAt : a.status === "open" ? -1 : 1))
    .map((r) => ({ ...r, unread: r.status === "open" && !(r.seenBy ?? []).includes(viewer) }));
  return { reports: rows, badge: rows.filter((r) => r.unread).length };
}

export function markReportsSeen(list: AgentReport[], viewer: string): AgentReport[] {
  return list.map((r) => ((r.seenBy ?? []).includes(viewer) ? r : { ...r, seenBy: [...(r.seenBy ?? []), viewer] }));
}

/** Resolve (or reopen) one report. */
export function resolveReport(
  list: AgentReport[],
  id: string,
  by: string,
  now: number,
  reopen = false,
): { ok: true; list: AgentReport[]; report: AgentReport } | { ok: false; error: string } {
  const r = list.find((x) => x.id === id);
  if (!r) return { ok: false, error: "no such report" };
  const next: AgentReport = reopen
    ? (({ resolvedBy: _b, resolvedAt: _a, ...rest }) => ({ ...rest, status: "open" as const }))(r)
    : { ...r, status: "resolved", resolvedBy: by, resolvedAt: now };
  return { ok: true, list: list.map((x) => (x.id === id ? next : x)), report: next };
}

const KIND_LABEL: Record<ReportKind, string> = { access: "🔑 access", bug: "🐞 bug", blocked: "⛔ blocked" };
export const kindLabel = (k: ReportKind) => KIND_LABEL[k];

/** The Telegram DM. Short: the panel holds the detail. */
export function notificationText(r: AgentReport, cockpitTitle?: string | null): string {
  const where = cockpitTitle ? ` · ${cockpitTitle}` : "";
  const again = r.count > 1 ? ` (×${r.count})` : "";
  const lines = [`🆘 ${r.agent} needs an admin${where}`, `${KIND_LABEL[r.kind]}: ${r.title}${again}`];
  if (r.secret) lines.push(`secret: ${r.secret}`);
  if (r.body) lines.push("", r.body.length > 600 ? r.body.slice(0, 600) + "…" : r.body);
  lines.push("", "Open the cockpit → Reports to resolve it.");
  return lines.join("\n");
}

// ── Storage ──────────────────────────────────────────────────────────────────

export function reportsFile(cwd: string = process.cwd()): string {
  return path.join(os.homedir(), ".shadok-ai", "reports", instanceKey(cwd) + ".json");
}

export function loadReports(file: string = reportsFile()): AgentReport[] {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === "string" && typeof r.title === "string") : [];
  } catch {
    return [];
  }
}

export function saveReports(list: AgentReport[], file: string = reportsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
