import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { instanceKey } from "./paths.js";
import { fileCard, type FileCard } from "./download.js";

/**
 * Files an agent OFFERS the user through shadok's own path, rather than through
 * the harness's `SendUserFile` tool.
 *
 * Why this exists next to a tool that already does it: a tmux agent keeps the
 * Claude Code binary it was spawned with — that is what lets it survive an
 * auto-update — so an agent older than the tool never sees it, and the whole
 * fleet runs pre-upgrade binaries by design (measured: 67 panes of 67). One
 * instance answered "cet outil n'existe pas dans ma session" and invented a
 * `fichier: /path` line of its own, which looks like a feature without being
 * one. A skill calling this endpoint works on any build, including the ones
 * already running.
 *
 * This is a registry of OFFERS, not a copy: the bytes stay where the agent
 * wrote them, and the row records that this session chose to hand them over.
 *
 * See docs/superpowers/specs/2026-09-25-file-handover-design.md.
 */

/**
 * The `stream-tool` name a shadok-side delivery travels under.
 *
 * Deliberately NOT "SendUserFile": the two reach the same card, but one is a
 * harness tool call recorded in the transcript and the other is an HTTP offer,
 * and spelling them alike would make every later `grep SendUserFile` lie about
 * where a file came from. The consumers accept both names; nothing else about
 * the message differs, which is why no new client or Telegram rendering was
 * needed for this feature.
 */
export const OFFER_TOOL = "ShadokFile";

export interface OfferedFile {
  sessionId: string;
  path: string;
  name: string;
  size: number;
  /** ms epoch of the offer. */
  at: number;
  caption?: string;
}

/** Biggest file we will register. Beyond this the agent is told, not ignored. */
export const MAX_OFFER_BYTES = 512 * 1024 * 1024;

/** How many offers we keep per instance — a bound, like the ledger's. */
export const MAX_OFFERS = 500;

export type OfferRefusal =
  | { ok: false; reason: "not-absolute" | "missing" | "not-a-file" | "too-big" | "unreadable"; path: string; detail?: string };
export type OfferVerdict = { ok: true; file: OfferedFile } | OfferRefusal;

/**
 * Pure: may this path be offered, given what the filesystem says about it?
 *
 * `stat` is injected so the decision is testable without touching a disk — the
 * same shape as `classifyBin` and `readGround`. "missing" and "unreadable" are
 * kept APART rather than collapsed into one failure: they send the agent to
 * different places (it wrote the wrong path, versus the server cannot see a
 * path that is really there), and telling it the wrong one costs a round trip.
 * Invariant 27's discipline applied to a much smaller thing.
 */
export type OfferStat = { isFile: boolean; size: number } | "missing" | "unreadable";

export function offerVerdict(
  sessionId: string,
  p: string,
  stat: OfferStat,
  now: number,
  caption?: string,
): OfferVerdict {
  const raw = String(p ?? "").trim();
  // An absolute path is required, and not out of fussiness: the server's cwd is
  // its launch dir and never the agent's (invariant 1), so a relative path here
  // would resolve against the wrong directory and "work" by accident whenever
  // the two happened to coincide. The skill resolves it agent-side, where the
  // cwd IS right.
  if (!raw || !path.isAbsolute(raw)) return { ok: false, reason: "not-absolute", path: raw };
  if (stat === "missing") return { ok: false, reason: "missing", path: raw };
  if (stat === "unreadable") return { ok: false, reason: "unreadable", path: raw };
  if (!stat.isFile) return { ok: false, reason: "not-a-file", path: raw };
  if (stat.size > MAX_OFFER_BYTES)
    return { ok: false, reason: "too-big", path: raw, detail: `${stat.size} bytes > ${MAX_OFFER_BYTES}` };
  const name = path.basename(raw);
  return {
    ok: true,
    file: { sessionId, path: raw, name, size: stat.size, at: now, ...(caption?.trim() ? { caption: caption.trim() } : {}) },
  };
}

/**
 * Pure: the table after an offer, newest last, bounded and de-duplicated.
 *
 * Re-offering the same path from the same session REPLACES the row rather than
 * appending one: an agent that regenerates a report and sends it again should
 * leave one card's worth of state, not a log. Same "supersede, not append" rule
 * the ledger learned the hard way.
 */
export function withOffer(rows: readonly OfferedFile[], f: OfferedFile): OfferedFile[] {
  const kept = rows.filter((r) => !(r.sessionId === f.sessionId && r.path === f.path));
  const next = [...kept, f];
  return next.length > MAX_OFFERS ? next.slice(next.length - MAX_OFFERS) : next;
}

/**
 * Pure: every path this SESSION has offered.
 *
 * The read-side gate, and the twin of `sentFilePaths`: `GET /download` serves a
 * path only when it is in one of the two, so the endpoint still cannot be walked
 * into an arbitrary file — it serves back exactly what an agent chose to hand
 * over, and only to that agent's own channel.
 */
export function offeredPaths(rows: readonly OfferedFile[], sessionId: string): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.sessionId === sessionId) out.add(r.path);
  return out;
}

/** Pure: the cards for an offer, the shape the client and Telegram already take. */
export function offerCards(files: readonly OfferedFile[]): FileCard[] {
  return files.map((f) => fileCard(f.path));
}

/** Pure: a refusal, worded for the agent that will read it. */
export function refusalMessage(r: OfferRefusal): string {
  switch (r.reason) {
    case "not-absolute":
      return `${r.path || "(empty)"}: give an absolute path — the server's working directory is not yours`;
    case "missing":
      return `${r.path}: no such file`;
    case "unreadable":
      return `${r.path}: cannot be read from the server`;
    case "not-a-file":
      return `${r.path}: not a regular file`;
    case "too-big":
      return `${r.path}: too large to hand over (${r.detail})`;
  }
}

const filesDir = (): string => path.join(os.homedir(), ".shadok-ai", "files");
export const filesFileFor = (cwd: string): string => path.join(filesDir(), `${instanceKey(cwd)}.json`);

export function loadOffers(file: string): OfferedFile[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j) ? j.filter((r) => r && typeof r.path === "string" && typeof r.sessionId === "string") : [];
  } catch {
    return [];
  }
}

export function saveOffers(file: string, rows: readonly OfferedFile[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.shadok-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Stat for `offerVerdict`, keeping absent and unreadable apart. */
export function statForOffer(p: string): OfferStat {
  try {
    const s = fs.statSync(p);
    return { isFile: s.isFile(), size: s.size };
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
  }
}
