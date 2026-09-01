import { randomUUID, timingSafeEqual, createHmac } from "node:crypto";
import { execFile, spawn as spawnChild } from "node:child_process";
import type { IncomingMessage } from "node:http";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  detectDialog,
  dialogKey,
  isResumeSummaryDialog,
  findSessionId,
  lastPromptAt,
  listSessions,
  loadHistory,
  readHistoryTurns,
  resumedTurnStart,
  type TuiDialog,
} from "./extract.js";
import { searchTurns, normalizeQuery, MIN_QUERY } from "./search.js";
// Same implementation as the web client's preview (plain JS, loaded as is by
// the browser): one source for reading the in-flight text off the screen.
import { extractLiveText } from "../public/live-text.js";
import { findTransientErrors, newTransientErrors, RETRY_DELAYS_MS } from "./retry.js";
import { screenShowsWork, moveToOption } from "./detect.js";
import { PtyPilot } from "./session.js";
import { ensureClaudeHome, ensureProjectTrusted } from "./claude-home.js";
import { authStatus, cancelLogin, startLogin, submitLoginCode } from "./claude-auth.js";
import { starCount } from "./stars.js";
import { ensureFirstAgent } from "./first-agent.js";
import { readGroundAt } from "./ground.js";
import { homeGreetingBrief } from "./greeting.js";
import { ensureSshIdentity } from "./ssh.js";
import { openBrowser } from "./open-browser.js";
import { parseSkillMeta, prepromptParts, type PrepromptPart } from "./preprompt.js";
import { ensureSpawnHelperExecutable } from "./node-pty-fix.js";
import { TmuxPilot, tmuxAvailable, tmuxHasSession, tmuxKillSession, tmuxPaneCwd } from "./tmux.js";
import { scanUsage, sessionFilePath, tailSession, clearTailPos, seedTailPos, isNothingToShow, type TokenUsage } from "./tail.js";
import { detectFork, rootIdOfFile } from "./forktrace.js";
import { computePace, paceBlock, WINDOW_SEC } from "./pace.js";
import { getUsage, type Window } from "./usage.js";
import {
  loadChannels,
  loadGroups,
  saveGroups,
  upsertChannel,
  removeChannel,
  mergeClientChannels,
  loadTgGroup,
  saveTgGroup,
  isHomeChannel,
  homeAdoptionTarget,
  resolveSessionTarget,
  resumeTarget,
  type Channel,
  type SessionTarget,
} from "./channels.js";
import { deliverWithRetry } from "./reload.js";
import {
  startTelegram,
  renameTelegramTopic,
  closeTelegramTopic,
  probeToken,
  isStalePreface,
  announceLoggedOut,
  resetLoggedOutNotice,
  attachmentPrompt,
  pasteFileName,
  MEDIA_DIR,
  type TelegramHandle,
} from "./telegram.js";
import { migrateTgBindings } from "./channels.js";
import { instanceKey } from "./paths.js";
import {
  loadCrons,
  saveCrons,
  upsertCron,
  removeCron,
  resolveCronId,
  nextRunFor,
  nextRunAfterFailure,
  isTransient,
  CRON_MAX_RETRIES,
  markCronPrompt,
  normalizeSchedule,
  onceAt,
  stateAfterFire,
  scheduleLabel,
  cronTimeZone,
  defaultTimeZone,
  systemTimeZone,
  isValidTimeZone,
  type Cron,
  type DriveReason,
} from "./crons.js";
import { markPromptMeta, promptMetaHeader } from "./promptmeta.js";
import {
  ledgerFileFor,
  ensureLedgerFile,
  loadLedger,
  deltaSince,
  formatLedgerBlock,
  markLedgerBlock,
  ledgerSeenFileFor,
  seenFor,
  recordSeen,
} from "./ledger.js";
import {
  childrenOf,
  linkRefusal,
  markAgentPrompt,
  notificationText,
  type ChildReport,
} from "./kinship.js";
import {
  loadConfig,
  saveConfig,
  telegramConfig,
  applyTelegramPatch,
  titleForCwd,
  setTitleForCwd,
  themeForCwd,
  setThemeForCwd,
  type TelegramPatch,
} from "./config.js";
import { secretsFor, secretNames, setSecret, deleteSecret, secretWriteVerdict } from "./secrets.js";
import {
  getProfile,
  profileArgs,
  permissionModeArgs,
  isPermissionMode,
  envVarsNote,
  seedDefaultProfiles,
  migrateToTracking,
  seedTweakProfile,
  loadProfiles,
  upsertProfile,
  removeProfile,
  promptEditVerdict,
  READONLY_DENY,
  TWEAK_PROFILE_NAME,
  type Profile,
  promptOrigin,
  effectiveProfile,
  adoptTracking,
  shippedProfile,
  withManagedPrompt,
} from "./profiles.js";
import {
  BOOTSTRAP_ADMIN,
  loadAccounts,
  verifyPassword,
  sessionSecret,
  signSession,
  readSession,
  saveAccounts,
  userWriteVerdict,
  newInvite,
  inviteVerdict,
  hashPassword,
  promptAuthor,
  type Role,
  signSessionKey,
  readSessionKey,
} from "./accounts.js";
import { ensureSelfRepo } from "./selfrepo.js";
import {
  createWorktree,
  pruneWorktree,
  ensureWorktreeCheckout,
  gitDiff,
  isGitRepo,
  listPastSessions,
  type Worktree,
} from "./worktree.js";
import { latestVersion, update } from "./updater.js";
import { resolveChannel, type UpdateChannel } from "./update-channel.js";
import { isNewer } from "./version.js";
import { RELOAD_EXIT_CODE } from "./supervisor.js";
import { acquireInstanceLock, releaseInstanceLock } from "./lock.js";
import { bindRefusal, originAllowed, parseOrigins, resolveHost,
  browserOrigin,
} from "./net.js";
import { pctFromUsage, windowForModel } from "./context.js";
import { startHeartbeat } from "./heartbeat.js";
import {
  ensureClaude,
  claudeCommand,
  classifyBin,
  findClaudeBinWithRetry,
  liveClaudeDeps,
  rememberClaudeBin,
  resolveBin,
  sampleBin,
  type EnsureClaudeResult,
} from "./claude-bin.js";
import { ensureTmux, tmuxInstallCommand, type TmuxInstall } from "./tmux-install.js";
import { cspHeader, injectNonce, NONCE_PLACEHOLDER, injectAssetVersion, injectInstanceKey } from "./csp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_PORT = Number(process.env.PORT ?? 3789);
const MAX_PORT_TRIES = 20;
// Listening interface: the loopback by default (the cockpit runs commands, it
// does not expose itself to a network unasked). SHADOK_HOST=0.0.0.0 for a
// container — see bindRefusal, which then requires a password.
const HOST = resolveHost(process.env);
// Browser origins accepted on top of same-origin (typically a reverse proxy
// that rewrites the Host).
const EXTRA_ORIGINS = parseOrigins(process.env.SHADOK_ORIGINS);

// Single instance per launch directory. A second server sharing this dir's
// registry + telegram-group config (a port-fallback duplicate, a stray dev
// server, an auto-update zombie) corrupts them with concurrent writes and runs
// a rival Telegram bridge on the same bot. Refuse to start instead — exit 0 so
// a supervisor treats it as a clean stop and doesn't crash-loop.
const instanceLock = acquireInstanceLock();
if (!instanceLock.ok) {
  console.error(
    `[shadok-ai] another instance is already running from this directory (pid ${instanceLock.pid}) — exiting.`,
  );
  process.exit(0);
}
process.on("exit", () => releaseInstanceLock());

const app = express();
app.use(express.json({ limit: "1mb" }));
/** A screenshot is a few hundred kB, but any file can be pasted now (a PDF
 *  easily tops 12 MB); past this a paste is really an upload it shouldn't be. */
const PASTE_LIMIT = "50mb";

// ── Optional GUI password ────────────────────────────────────────────────
// If SHADOK_GUI_PASSWORD is set (at startup, via env or the CLI --password
// flag), the whole GUI — pages, endpoints AND the WebSocket — requires a login.
// Unset → no auth (the default).
const GUI_PASSWORD = (process.env.SHADOK_GUI_PASSWORD ?? "").trim();
// The session cookie is derived DETERMINISTICALLY from the password (HMAC), not
// a per-login random token kept in memory. That way it survives a server
// restart — so an auto-update reload stays logged in instead of bouncing the
// user back to the login screen. Any instance with the same password accepts
// the same cookie; it's one-way, so the cookie never leaks the password. The
// in-process Telegram bridge presents this same cookie on its WS.
/** A week, matching the cookie's Max-Age: one is the other's enforcement. */
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
// Sessions are signed with a per-instance secret, NOT with the password: the
// password reaches every agent's environment, so signing with it would let an
// agent mint a cookie for anyone. Drawn lazily, so an instance with no password
// never creates a key file it will not use.
let sessionKeyCache: Buffer | null = null;
const signingSecret = (): Buffer => (sessionKeyCache ??= sessionSecret());
/** The Telegram bridge and the agents authenticate as the bootstrap admin. */
const adminCookie = (): string | undefined =>
  GUI_PASSWORD ? `sk_auth=${signSession(BOOTSTRAP_ADMIN, Date.now(), signingSecret())}` : undefined;

// The live Telegram bridge handle + the port we actually bound, so the
// /telegram endpoint can tear it down and recreate it hot (no server restart).
let tgBridge: TelegramHandle = {
  stop() {},
  running: () => false,
  status: () => ({ username: null, tokenError: null }),
};
let boundPort = 0;
const tgCookie = adminCookie;

/**
 * Start the instance's lead agent when it has no channel at all.
 *
 * Called from two places — the boot callback, and a successful sign-in — because
 * a brand-new instance is signed OUT at boot and would be skipped there. The
 * "no channel" condition makes both calls idempotent, so neither needs to know
 * about the other.
 */
/**
 * Give a cockpit that predates the `home` flag its home base, without ever
 * guessing: `homeAdoptionTarget` designates a channel only when exactly one is
 * already playing the part, and refuses otherwise.
 */
function adoptHomeChannel(): void {
  try {
    const id = homeAdoptionTarget(loadChannels(), process.cwd());
    if (!id) return;
    upsertChannel({ sessionId: id, home: true });
    console.log(`home channel: adopted the existing "general" (${id.slice(0, 8)})`);
  } catch {
    /* a cockpit without a home base still works */
  }
}

/**
 * The lead's first message: it introduces itself, says what it found in the
 * directory it woke up in, and makes ONE concrete offer.
 *
 * Delivered as a HIDDEN prompt over the loopback, exactly like a cron fire or a
 * parent notification — so the greeting ARRIVES on its own instead of reading
 * as the answer to something the user can plainly see they never typed.
 *
 * Retried like the reload nudge, for the same reason: the agent it is aimed at
 * was spawned a second ago and may still be finishing its own startup turn, and
 * a single refused delivery would leave the cockpit exactly as silent as the
 * blank chat this exists to replace.
 *
 * Never fatal, and never blocking: a cockpit whose lead forgot to say hello is
 * a far smaller problem than one whose boot path threw. `SHADOK_GREETING=0`
 * turns it off, the way `SHADOK_PILOT_PROMPT=0` does for the pilot prompt.
 */
function greetHomeAgent(id: string): void {
  if (process.env.SHADOK_GREETING === "0") return;
  const tag = `first agent: greeting ${id.slice(0, 8)}`;
  let brief: string;
  try {
    const cwd = process.cwd();
    brief = markAgentPrompt(
      homeGreetingBrief({
        // The launch directory, not a worktree: the lead runs in the project
        // the person actually opened the cockpit on.
        ground: readGroundAt(cwd),
        profiles: loadProfiles(),
        dirName: path.basename(cwd) || cwd,
      }),
    );
  } catch (e) {
    console.log(`${tag} — not built (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  void deliverWithRetry(
    () => driveChannel(id, brief, resolveSessionTarget(loadChannels(), id, process.cwd())),
    () => sessions.has(id),
  ).then((res) => {
    if (res.ok) console.log(`${tag} — delivered (attempt ${res.attempts})`);
    else if (res.gone) console.log(`${tag} — session gone before it landed`);
    else console.log(`${tag} — gave up after ${res.attempts} tries (${res.reason})`);
  });
}

async function startFirstAgent(): Promise<void> {
  try {
    const why = await ensureFirstAgent({
      port: boundPort,
      cookie: tgCookie(),
      cwd: process.cwd(),
      // `start` carries no name, so the channel is named once the server has
      // told us its session id.
      onReady: (sessionId, name) => {
        // `home` here rather than in the `start` handler: this is the ONE
        // channel an instance is born with, and nothing else may mint one.
        upsertChannel({ sessionId, name, home: true });
        console.log(`first agent: started "${name}" (${sessionId.slice(0, 8)})`);
        // Only ever from here: this callback runs when a lead agent is really
        // created, which `firstAgentPlan` already gates on "no channel at all".
        // A second trigger would be a second way to greet, and they would drift.
        greetHomeAgent(sessionId);
      },
    });
    if (why !== "first-boot") console.log(`first agent: skipped (${why})`);
  } catch (e) {
    console.log(`first agent: could not start — ${e instanceof Error ? e.message : String(e)}`);
  }
}
function restartTelegram(): void {
  tgBridge.stop();
  tgBridge = startTelegram(boundPort, tgCookie());
}

// ── Cron scheduler ───────────────────────────────────────────────────────────
// Scheduled per-channel prompts (monitoring/reporting). The server drives the
// channel like any other client: it opens a loopback WS to its own /ws, resumes
// the channel's session and submits the prompt — so it reuses the whole session
// lifecycle + web/Telegram delivery. No session stays alive between runs, so
// there's no duration cap. Persisted, rescheduled on boot: survives restarts.
const cronsFiring = new Set<string>();

/** What a single delivery attempt ended as. Every failure path used to resolve
 *  exactly like a success, which made a lost cron run undiagnosable. */
type DriveOutcome = { ok: true } | { ok: false; reason: DriveReason; detail?: string };

/** Short id used in every `cron:` log line, like the `telegram:` ones. */
function cronTag(c: Cron): string {
  return `cron: ${c.id.slice(0, 8)}`;
}

/** The three ways a guard can end. A non-zero exit is NOT enough to call it
 *  broken: `grep`/`diff`/`test` exit 1 with no output precisely when there is
 *  nothing to report — the normal quiet case. */
type CheckResult =
  | { kind: "news"; out: string }
  | { kind: "quiet" }
  | { kind: "failed"; detail: string };

/**
 * Run a cron's optional guard command WITHOUT the LLM (in the channel's cwd,
 * with the profile's secrets). stdout is the only content signal: whatever it
 * prints gets prepended to the prompt.
 */
function runCronCheck(c: Cron, target: SessionTarget): Promise<CheckResult> {
  if (!c.check?.trim()) return Promise.resolve({ kind: "quiet" }); // no guard → the agent always runs
  return new Promise((resolve) => {
    const profile = target.profile ? getProfile(target.profile) : undefined;
    const env = { ...process.env, ...secretsFor(profile?.secrets) };
    execFile(
      "sh",
      ["-c", c.check!],
      { cwd: target.cwd, env, timeout: 2 * 60_000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const out = (stdout || "").trim();
        if (out) return resolve({ kind: "news", out }); // news, whatever the exit code
        const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
        if (!e) return resolve({ kind: "quiet" });
        const errText = (stderr || "").trim();
        // Killed by the 2 min cap, or the shell couldn't even run it.
        if (e.killed || e.signal) return resolve({ kind: "failed", detail: "timed out after 2m" });
        if (typeof e.code !== "number") return resolve({ kind: "failed", detail: e.message.split("\n")[0] });
        // Non-zero exit: only an incident if it also complained on stderr.
        if (!errText) return resolve({ kind: "quiet" });
        resolve({ kind: "failed", detail: `exit ${e.code}: ${errText.split("\n")[0].slice(0, 200)}` });
      },
    );
  });
}

/** Fire a cron: run its guard (if any), then drive the agent unless the guard
 *  stayed silent. Returns the outcome so `cronTick` can reschedule a lost run. */
async function fireCron(c: Cron): Promise<{ outcome: string; reason?: DriveReason; detail?: string }> {
  // Resolved once, used by BOTH halves: the guard runs there and the session is
  // resumed there. Two independent lookups is how the resume ended up on the
  // repo root while the guard ran in the worktree.
  const target = resolveSessionTarget(loadChannels(), c.sessionId, process.cwd());
  // Firing from the fallback cwd is a guess, not a fact: say so rather than let
  // a cron whose channel record was lost run somewhere unexpected in silence.
  if (!target.known)
    console.log(`${cronTag(c)} no channel for session ${c.sessionId.slice(0, 8)} — falling back to ${target.cwd}`);
  const check = await runCronCheck(c, target);
  // A guard that stayed silent means "nothing to report": no turn, zero tokens.
  // Logged anyway — otherwise "ran and stayed quiet" still looks like "never ran",
  // which is exactly the ambiguity this whole change is about.
  if (check.kind === "quiet" && c.check?.trim()) {
    console.log(`${cronTag(c)} quiet (check silent)`);
    return { outcome: "quiet" };
  }
  let promptText: string;
  let checkNote = "";
  if (check.kind === "news") {
    promptText = `Monitoring output (act on it, raise the alarm if needed):\n${check.out}\n\n${c.prompt}`;
    checkNote = ` (check: ${(Buffer.byteLength(check.out) / 1000).toFixed(1)} kB)`;
  } else if (check.kind === "failed") {
    // A broken guard used to disable the cron in silence. Wake the agent so it
    // can raise the alarm — a monitoring job that dies quietly is the bug we're
    // fixing. It costs tokens every slot until the guard is repaired.
    promptText =
      `This cron's guard command failed (${check.detail}). No monitoring data could be collected. ` +
      `Report it, and diagnose the command if you can:\n\`\`\`\n${c.check}\n\`\`\`\n\n${c.prompt}`;
    console.log(`${cronTag(c)} check failed (${check.detail}) — waking the agent`);
  } else {
    promptText = c.prompt; // no guard at all: the agent always runs
  }
  const res = await driveChannel(c.sessionId, markCronPrompt(promptText), target);
  if (res.ok) {
    console.log(`${cronTag(c)} fired${checkNote} -> ok`);
    return { outcome: check.kind === "failed" ? "check-failed" : "ok" };
  }
  return { outcome: res.reason, reason: res.reason, detail: res.detail };
}

/** Drive a channel once with `text` over a loopback WS (resumes its session in
 *  `target.cwd`). Resolves when the turn ends, the delivery fails, or a safety
 *  cap hits. */
function driveChannel(sessionId: string, text: string, target: SessionTarget): Promise<DriveOutcome> {
  return new Promise((resolve) => {
    const cookie = tgCookie();
    const ws = new WebSocket(`ws://127.0.0.1:${boundPort}/ws`, cookie ? { headers: { cookie } } : {});
    let done = false;
    const finish = (out: DriveOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      try { ws.close(); } catch { /* already closing */ }
      resolve(out);
    };
    const guard = setTimeout(() => finish({ ok: false, reason: "timeout" }), 30 * 60_000); // can't hold the slot forever
    guard.unref?.();
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "start",
          resume: sessionId,
          // The CHANNEL's directory: `loadHistory` is keyed by the cwd, so
          // resuming a worktree session at the repo root wakes it with no
          // history at all (invariant nº 1).
          cwd: target.cwd,
          // Only when known: they let the server recreate a worktree checkout
          // that was reclaimed, and it needs BOTH to try. A root channel has
          // neither, and sending nulls would widen the protocol for nothing.
          ...(target.branch && target.repo ? { branch: target.branch, repo: target.repo } : {}),
          origin: "cron",
        }),
      ),
    );
    ws.on("message", (raw) => {
      let m: { type?: string; message?: string; code?: string; reason?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "ready") {
        ws.send(JSON.stringify({ type: "prompt", text }));
      } else if (m.type === "turn-done") {
        finish({ ok: true });
      } else if (m.type === "pace-blocked") {
        finish({ ok: false, reason: "pace-blocked", detail: m.reason });
      } else if (m.type === "error") {
        // `code` tells a refused-because-busy apart from any other refusal —
        // matching the message text would break the day it's reworded.
        const reason: DriveReason = m.code === "busy" ? "busy" : "error";
        finish({ ok: false, reason, detail: m.message });
      } else if (m.type === "exited") {
        finish({ ok: false, reason: "exited" });
      } else if (m.type === "gone") {
        // The channel's directory is really gone — we passed branch+repo, so the
        // server already tried to recreate a reclaimed worktree checkout. Its own
        // reason so the log names the diagnosis; non-transient, since replaying
        // in 10 min would fail identically.
        finish({ ok: false, reason: "gone", detail: m.message ?? m.type });
      } else if (m.type === "stopped") {
        // Someone ended the session. Not a hiccup either.
        finish({ ok: false, reason: "error", detail: m.message ?? m.type });
      }
    });
    ws.on("error", (e) => finish({ ok: false, reason: "ws-error", detail: e.message }));
    // A close BEFORE turn-done means the delivery was cut short (typically the
    // server reloading mid-run). After it, `done` is already set and this is
    // just the socket we closed ourselves.
    ws.on("close", () => finish({ ok: false, reason: "ws-error", detail: "closed before the turn ended" }));
  });
}

/**
 * Notifications waiting for a parent that is mid-turn, keyed by the PARENT's
 * session id. A prompt sent during a turn is refused (`code:"busy"`), so
 * without this a child finishing while its parent thinks would simply be lost.
 *
 * It is also where batching comes from, for free: a parent is busy precisely
 * when it is working, so several children coalesce on their own — no timer, no
 * window, and the expensive case partly corrects itself.
 */
const parentInbox = new Map<string, string[]>();

/** A child's display name for its parent, falling back to a short id. */
function childLabel(channels: readonly Channel[], childId: string): string {
  const ch = channels.find((c) => c.sessionId === childId);
  return ch?.name?.trim() || childId.slice(0, 8);
}

/** Send one message (or a coalesced batch) to a parent, over the cron path. */
function deliverToParent(parentId: string, text: string): void {
  const target = resolveSessionTarget(loadChannels(), parentId, process.cwd());
  const tag = `agent: → ${parentId.slice(0, 8)}`;
  // Fire and forget: awaiting would hold the CHILD's finishTurn open for as
  // long as the parent takes to think.
  void driveChannel(parentId, text, target).then((res) => {
    console.log(res.ok ? `${tag} delivered` : `${tag} failed (${res.reason})`);
  });
}

/** One line of context, not a bare "continue": after a `--resume` the agent has
 *  no signal it was reloaded, so tell it WHY it woke and let it resume with
 *  intent. Marked hidden (`markAgentPrompt`), so it drives a turn but never shows
 *  as a chat bubble — the display strips it like a cron/notification prompt. */
const RELOAD_CONTINUE_MSG =
  "You've just been reloaded — your updated pilot prompt and any newly-seeded skills are now active. Resume what you were doing.";

/** Nudge a freshly self-reloaded (and therefore idle) agent to carry on. Uses
 *  the same hidden loopback path as a parent notification, so it drives a real
 *  turn server-side without a client.
 *
 *  Delivered with RETRY: a `--resume` can still be finishing its own resume turn
 *  (the session reads busy) or its respawned TUI is not yet accepting a paste, so
 *  the first delivery can be refused — and a single refusal used to leave the
 *  agent idle forever (an agent reloaded fine, then nothing happened). We retry,
 *  backing off, until it lands or the session is gone. If it stays busy every
 *  time, the agent is already working and needs no nudge, so giving up is right. */
function continueAfterReload(id: string): void {
  const tag = `reload: ${id.slice(0, 8)}`;
  const nudge = markAgentPrompt(RELOAD_CONTINUE_MSG);
  void deliverWithRetry(
    () => driveChannel(id, nudge, resolveSessionTarget(loadChannels(), id, process.cwd())),
    () => sessions.has(id),
  ).then((res) => {
    if (res.ok) console.log(`${tag} — continued (attempt ${res.attempts})`);
    else if (res.gone) console.log(`${tag} — session gone before continue landed`);
    else console.log(`${tag} — continue gave up after ${res.attempts} tries (${res.reason})`);
  });
}

/**
 * Tell a child's parent what just happened to it. A channel with no parent
 * notifies nobody — that scoping is the whole point: a parent hears about the
 * agents IT launched and nothing else.
 */
function notifyParent(child: Live, report: Omit<ChildReport, "name" | "sessionId">): void {
  const channels = loadChannels();
  const me = channels.find((c) => c.sessionId === child.id);
  const parentId = me?.parent ?? null;
  if (!parentId) return;
  if (!channels.some((c) => c.sessionId === parentId)) return; // parent is gone
  // A child whose whole answer is the silence placeholder wakes nobody — the
  // same right to stay quiet a cron has.
  // A child whose whole answer is the silence placeholder wakes nobody. Both
  // forms are checked: `silent` is the one that actually fires, since the tail
  // drops the block before it can reach `summary`; the text check stays for a
  // caller that passes a summary of its own.
  if (report.kind === "done" && (report.silent || (report.summary && isNothingToShow(report.summary))))
    return;

  const text = markAgentPrompt(
    notificationText(
      {
        ...report,
        name: childLabel(channels, child.id),
        sessionId: child.id,
        branch: child.worktree?.branch ?? me?.branch ?? null,
      },
      boundPort,
    ),
  );

  const parent = sessions.get(parentId);
  if (parent?.busy) {
    parentInbox.set(parentId, [...(parentInbox.get(parentId) ?? []), text]);
    console.log(`agent: ${child.id.slice(0, 8)} → ${parentId.slice(0, 8)} queued (parent busy)`);
    return;
  }
  deliverToParent(parentId, text);
}

/** Flush whatever piled up for a parent that has just gone idle. */
function flushParentInbox(parentId: string): void {
  const queued = parentInbox.get(parentId);
  if (!queued?.length) return;
  parentInbox.delete(parentId);
  // One wake for the whole batch: N separate wakes would re-pay the parent's
  // entire prefix N times over for the same information.
  deliverToParent(parentId, queued.join("\n\n---\n\n"));
}

/**
 * Record how a fire ended, and replay it soon if the delivery was lost for a
 * transient reason (paced, busy, WS cut by a server reload…). Without this a
 * daily cron loses its information for 24 h on a hiccup.
 *
 * Reloads the list from disk on purpose: a tick — or a user edit — may have
 * saved it while the run was in flight, so only this cron's fields are touched.
 */
function settleCron(id: string, outcome: string, reason: DriveReason | undefined, detail?: string): void {
  const list = loadCrons();
  const c = list.find((x) => x.id === id);
  if (!c) return; // deleted while running
  c.lastOutcome = outcome;
  if (!reason || !isTransient(reason)) {
    // Landed, or failed for a reason a retry wouldn't fix.
    if (reason) console.log(`${cronTag(c)} fired -> ${reason}${detail ? `: ${detail}` : ""}`);
    c.retries = 0;
    saveCrons(list);
    return;
  }
  // `nextRun` was already advanced to the next normal slot before firing — a
  // one-shot has none, and passes null so nothing caps its retries.
  const once = c.schedule.kind === "once";
  const slot = once ? null : (c.nextRun ?? nextRunFor(c.schedule, Date.now(), cronTimeZone(c)));
  const r = nextRunAfterFailure(Date.now(), slot, c.retries ?? 0);
  c.nextRun = r.nextRun ?? undefined;
  c.retries = r.attempts;
  // `cronTick` disabled it before the fire; a transient loss must put it back,
  // otherwise a channel that was merely busy eats the reminder for good.
  if (once) c.enabled = r.retrying;
  console.log(
    r.retrying
      ? `${cronTag(c)} skipped: ${reason}, retry in ${Math.round(((r.nextRun ?? Date.now()) - Date.now()) / 60_000)}m (${r.attempts}/${CRON_MAX_RETRIES})`
      : `${cronTag(c)} skipped: ${reason}, giving up until next slot`,
  );
  saveCrons(list);
}

/** Fire every due, enabled cron whose previous run has finished. */
function cronTick(): void {
  const now = Date.now();
  const list = loadCrons();
  let changed = false;
  for (const c of list) {
    if (!c.enabled) continue;
    if (c.nextRun == null) { c.nextRun = nextRunFor(c.schedule, now, cronTimeZone(c)); changed = true; continue; }
    if (now < c.nextRun) continue;
    // Due: advance the schedule now (so a long run doesn't double-fire), then
    // fire unless a previous run of THIS cron is still in flight. A retry
    // scheduled by settleCron is always in the future, so it can't re-trigger
    // a run that is still going.
    c.lastRun = now;
    // A recurring cron advances to its next slot; a one-shot cannot (its
    // instant is fixed) and is disabled instead — a stronger anti-double-fire
    // guarantee, and a state every consumer already skips.
    const st = stateAfterFire(c.schedule, now, cronTimeZone(c));
    c.enabled = st.enabled;
    c.nextRun = st.nextRun;
    changed = true;
    if (cronsFiring.has(c.id)) continue;
    cronsFiring.add(c.id);
    const id = c.id;
    void fireCron(c)
      .then((r) => settleCron(id, r.outcome, r.reason, r.detail))
      .catch((e) => console.log(`cron: ${id.slice(0, 8)} crashed: ${e?.message ?? e}`))
      .finally(() => cronsFiring.delete(id));
  }
  if (changed) saveCrons(list);
}

/**
 * Recompute the schedule of enabled crons — at boot, and whenever the default
 * timezone changes.
 *
 * An already stored `nextRun` is RECOMPUTED when it is in the future:
 * otherwise setting `timezone` on a UTC server would only take effect after one
 * last fire at the wrong hour. A `nextRun` in the PAST is left alone — it is due
 * (a fire missed while down) and `cronTick` still has to catch it up.
 */
function primeCrons(): void {
  const now = Date.now();
  const list = loadCrons();
  let changed = false;
  for (const c of list) {
    if (!c.enabled) continue;
    if (c.nextRun != null && c.nextRun <= now) continue; // due: do not skip it
    // An `interval` is only recomputed when it is MISSING: recomputing would
    // push the deadline back at every start, and the server restarts on every
    // auto-update — a 30 min cron could then never fire at all.
    if (c.schedule.kind === "interval" && c.nextRun != null) continue;
    const next = nextRunFor(c.schedule, now, cronTimeZone(c));
    if (c.nextRun !== next) { c.nextRun = next; changed = true; }
  }
  if (changed) saveCrons(list);
}

function cookieToken(cookieHeader: string | undefined): string | null {
  const m = /(?:^|;\s*)sk_auth=([^;]+)/.exec(cookieHeader ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}
/**
 * Who this request is, or null. Re-reads the account file every time, so
 * deleting an account or changing a role takes effect at once — that is what
 * buys us the absence of a session store.
 */
function currentAccount(req: { headers: Record<string, unknown> }): { name: string; role: Role } | null {
  if (!GUI_PASSWORD) return { name: BOOTSTRAP_ADMIN, role: "admin" };
  // An AGENT authenticates with its own session key, not with the cookie.
  //
  // `SHADOK_AUTH` is still injected and still works, but it is a dated token in
  // a process environment, and an environment cannot be refreshed: an agent
  // alive longer than SESSION_TTL_MS got 401 on every call to its own server —
  // schedules, sibling agents, the vault, all of it — with nothing to see and
  // nothing it could do, since the self-reload skill sits behind this same
  // gate. A running agent proving it is that agent has no reason to expire.
  //
  // It grants exactly what the cookie already did, no more: `SHADOK_AUTH` IS
  // the bootstrap admin's cookie, so this is the same authority reached by a
  // credential that cannot age out. `sessionForKey` requires the session to be
  // live, so the key dies with the agent.
  const skey = req.headers["x-shadok-session-key"];
  if (typeof skey === "string" && skey && sessionForKey(skey))
    return { name: BOOTSTRAP_ADMIN, role: "admin" };
  const tok = cookieToken(req.headers.cookie as string | undefined);
  if (!tok) return null;
  const user = readSession(tok, signingSecret(), Date.now(), SESSION_TTL_MS);
  if (!user) return null;
  if (user === BOOTSTRAP_ADMIN) return { name: BOOTSTRAP_ADMIN, role: "admin" };
  const acct = loadAccounts().find((a) => a.name === user);
  // No hash means an invitation that was never redeemed: not a login yet.
  if (!acct?.passwordHash) return null;
  return { name: acct.name, role: acct.role };
}

function requestAuthed(req: { headers: Record<string, unknown> }): boolean {
  return currentAccount(req) !== null;
}
function passwordMatches(input: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(GUI_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}
// The submit handler is a nonce-d <script> block, not an inline `onsubmit=`:
// the CSP forbids handler attributes (that is exactly what neutralises an
// `<img onerror>` injected elsewhere), and a login page exempting itself from
// its own policy would send an odd message.
const LOGIN_HTML = `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
<title>shadok-ai — login</title><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#14161a;color:#e8e8ea;font-family:system-ui}
form{background:#1b1d22;padding:28px;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.5);width:min(320px,90vw)}
h1{font-size:16px;margin:0 0 14px;color:#e0a44a}input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:7px;border:1px solid #333;background:#0d0f12;color:inherit;font-size:14px}
button{margin-top:12px;width:100%;padding:9px;border-radius:7px;border:none;background:#e0a44a;color:#14161a;font-weight:600;cursor:pointer}.err{color:#e26;font-size:12px;margin-top:8px;min-height:14px}</style>
<form id=f data-action="/login">
<h1>◆ shadok-ai</h1><input id=u placeholder="User (blank = admin)" autocomplete=username><input id=pw type=password placeholder="Password" autofocus autocomplete=current-password><button>Enter</button><div class=err></div></form>
<script nonce="${NONCE_PLACEHOLDER}">
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  // One form, two destinations: signing in, or choosing a password for the
  // first time. The user field only exists on the first.
  const u = document.getElementById("u");
  const body = u
    ? { user: u.value, password: document.getElementById("pw").value }
    : { password: document.getElementById("pw").value };
  fetch(f.dataset.action, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (r.ok) return location.assign("/");
    const j = await r.json().catch(() => ({}));
    document.querySelector(".err").textContent = j.error || "Wrong username or password";
  });
});
</script>`;

/** Serves a login-shaped page with its CSP and nonce (these sit outside the
 *  gate, so they do not go through the index route). */
function sendAuthPage(res: express.Response, html: string, status: number): void {
  const nonce = randomUUID();
  res.setHeader("Content-Security-Policy", cspHeader(nonce));
  res.status(status).type("html").send(injectNonce(html, nonce));
}

function sendLogin(res: express.Response): void {
  sendAuthPage(res, LOGIN_HTML, 401);
}

/** The page an invited person lands on: the login shell, pointed at the
 *  redemption route. Same CSP and same nonce — a page that exempted itself from
 *  the policy protecting every other page would be a strange message. */
function invitePage(name: string, token: string): string {
  return LOGIN_HTML
    .replace("<title>shadok-ai — login</title>", "<title>shadok-ai — choose a password</title>")
    .replace('data-action="/login"', `data-action="/invite/${encodeURIComponent(token)}"`)
    // The name is the admin's input: it must never be able to close the tag.
    .replace("◆ shadok-ai", `Welcome, ${name.replace(/[<>&"']/g, "")}`)
    .replace('<input id=u placeholder="User (blank = admin)" autocomplete=username>', "")
    .replace('placeholder="Password"', 'placeholder="Choose a password (8+ characters)"')
    .replace("autocomplete=current-password", "autocomplete=new-password");
}

/** This server's same-origin guard (see `originAllowed`). */
/**
 * Per-session capability key, injected into the agent's env as
 * SHADOK_SESSION_KEY. The session id is PUBLIC (`/live` lists every id), so it
 * cannot prove "this is my own profile" — this can. Same-user shell access
 * still trumps it: soft isolation, not a sandbox.
 *
 * DERIVED from the id (see `signSessionKey`), not drawn and remembered. The Map
 * this replaced died with the server while tmux agents did not, so every
 * auto-update silently invalidated the key of every surviving agent.
 */
function sessionKeyFor(id: string): string {
  return signSessionKey(id, signingSecret());
}
/**
 * The session a key attests to — while that agent still EXISTS.
 *
 * A derived key stays verifiable forever, so something has to bound it; that is
 * what the Map's `delete` on teardown used to do. The bound is deliberately the
 * CHANNEL and not the `sessions` map, and the difference is not academic: after
 * a restart the server does not re-adopt a web session until a client opens it
 * (`reconcileOnBoot` reattaches Telegram bridges, not sessions), so a tmux agent
 * can be running, executing tools, and absent from `sessions` for hours.
 * Measured: pane alive, `/live` empty, key refused — which would have rebuilt
 * the very cliff this change removes, one restart wide instead of a week.
 *
 * The channel list is on disk, survives the restart, and loses the entry when
 * the agent is closed — which is the moment the key should stop working.
 * The map is still consulted first: it costs nothing and spares the file read.
 */
function sessionForKey(key: string): string | null {
  const id = readSessionKey(key, signingSecret());
  if (!id) return null;
  if (sessions.has(id)) return id;
  return loadChannels().some((c) => c.sessionId === id) ? id : null;
}

/** A browser on our own origin — the only caller allowed to change guardrails. */
function requestFromBrowser(req: { headers: Record<string, unknown> }): boolean {
  return browserOrigin(
    req.headers.origin as string | undefined,
    req.headers.host as string | undefined,
    EXTRA_ORIGINS,
  );
}

function requestOriginOk(req: { headers: Record<string, unknown> }): boolean {
  return originAllowed(
    req.headers.origin as string | undefined,
    req.headers.host as string | undefined,
    EXTRA_ORIGINS,
  );
}

// A browser from another origin has no business here — /login included, or a
// third-party page could try passwords. Placed BEFORE everything else.
app.use((req, res, next) => {
  if (requestOriginOk(req)) return next();
  res.status(403).json({ error: "cross-origin request refused" });
});

// Login endpoint (always reachable) — sets an HttpOnly cookie naming the user.
app.post("/login", (req, res) => {
  if (!GUI_PASSWORD) return res.json({ ok: true });
  const user = String(req.body?.user ?? "").trim();
  const password = String(req.body?.password ?? "");
  // No username means the instance password: the habit of typing just the
  // password keeps working, and that IS the bootstrap admin.
  const ok =
    !user || user === BOOTSTRAP_ADMIN
      ? passwordMatches(password)
      : (() => {
          const a = loadAccounts().find((x) => x.name === user);
          return !!a?.passwordHash && verifyPassword(password, a.passwordHash);
        })();
  if (!ok) return res.status(401).json({ error: "wrong username or password" });
  const name = user || BOOTSTRAP_ADMIN;
  res.setHeader(
    "Set-Cookie",
    `sk_auth=${signSession(name, Date.now(), signingSecret())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  );
  return res.json({ ok: true, user: name });
});

// Redeeming an invitation happens WITHOUT a session: the whole point is that
// the holder cannot get in yet. Hence these sit before the gate.
app.get("/invite/:token", (req, res) => {
  const token = String(req.params.token ?? "");
  const acct = loadAccounts().find((a) => a.invite?.token === token);
  const v = inviteVerdict(acct, token, Date.now());
  if (!v.ok) return res.status(400).type("text").send(v.error);
  return sendAuthPage(res, invitePage(acct!.name, token), 200);
});

app.post("/invite/:token", (req, res) => {
  const token = String(req.params.token ?? "");
  const password = String(req.body?.password ?? "");
  const list = loadAccounts();
  const acct = list.find((a) => a.invite?.token === token);
  const v = inviteVerdict(acct, token, Date.now());
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  // Redeeming DROPS the invite and sets the hash: the link is single-use by
  // construction, not by a flag someone could forget to check.
  saveAccounts(
    list.map((a) =>
      a.name === acct!.name
        ? { name: a.name, role: a.role, createdAt: a.createdAt, passwordHash: hashPassword(password) }
        : a,
    ),
  );
  console.log(`users: ${acct!.name} redeemed their invitation`);
  // Redeeming SIGNS YOU IN. Holding the link and choosing the password is an
  // authentication, and without this the browser keeps whatever session it
  // already had — an admin who invites someone from their own browser lands
  // back as the admin, with nothing to say the redemption did not take.
  res.setHeader(
    "Set-Cookie",
    `sk_auth=${signSession(acct!.name, Date.now(), signingSecret())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  );
  res.json({ ok: true, user: acct!.name });
});

// Signing out expires the cookie. Before the gate on purpose: throwing away a
// session must work even when that session is already invalid, otherwise a
// stale cookie would leave you stuck on a 401 with no way to clear it.
app.post("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "sk_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

// Who am I? The client labels itself with this, and a tab whose session expired
// finds out here rather than by a silent failure.
app.get("/me", (req, res) => {
  const me = currentAccount(req);
  return me ? res.json(me) : res.status(401).json({ error: "unauthorized" });
});

// Gate everything else behind the cookie when a password is set. /me answers
// for itself: it must return 401, not the login page.
app.use((req, res, next) => {
  if (req.path === "/me" || req.path === "/logout" || req.path.startsWith("/invite/") || requestAuthed(req)) return next();
  if (req.method === "GET" && (req.headers.accept ?? "").includes("text/html"))
    return sendLogin(res);
  return res.status(401).json({ error: "unauthorized" });
});

// The page goes through here BEFORE express.static: it must receive its CSP's
// nonce, which a file served as is cannot do.
//
// Re-read on EVERY request, as express.static would. The earlier version kept
// it in memory — "it does not change at runtime" — and therefore served a stale
// page as soon as index.html was edited: you reload, nothing moves, you go hunt
// the bug elsewhere. A 170 KB file read once per tab opening does not register;
// the trap does.
const INDEX_PATH = path.join(__dirname, "..", "public", "index.html");
app.get(["/", "/index.html"], (_req, res) => {
  let html: string;
  try {
    html = fs.readFileSync(INDEX_PATH, "utf8");
  } catch {
    return res.status(500).type("text").send("index.html not found");
  }
  const nonce = randomUUID();
  res.setHeader("Content-Security-Policy", cspHeader(nonce));
  // La version part AUSSI dans l'URL des modules : cette page ne peut alors
  // demander que les modules de sa propre version, jamais ceux d'une plus
  // ancienne restés en cache (cf. invariant 10).
  res.type("html").send(injectInstanceKey(injectAssetVersion(injectNonce(html, nonce), OWN_VERSION), instanceKey()));
});

/**
 * Any file pasted into the composer — an image, a PDF, a CSV, anything. The web
 * had no way to hand a file to an agent at all (only Telegram did), so a
 * screenshot or a document meant saving it somewhere and typing the path by
 * hand. It started image-only; now it takes any type, since an agent can read a
 * PDF/CSV/text by path just as well.
 *
 * Same destination as the Telegram attachments (`MEDIA_DIR`): one folder, one
 * purge, and the agent reads the file by absolute path exactly the same way.
 * The original filename (via `x-filename`) is preserved so the extension stays
 * truthful — a `.pdf` is what makes the agent's Read tool treat it as a PDF.
 *
 * `express.raw({ type: () => true })`: accept EVERY content type (image-only
 * before), so a non-image body is still parsed to a Buffer rather than dropped.
 *
 * `requestFromBrowser` (stricter than the WS origin guard, cf. the profile
 * guardrails): this route WRITES a file, so an `Origin`-less caller — a script,
 * a curl — has no business here even on loopback.
 */
app.post("/paste", express.raw({ type: () => true, limit: PASTE_LIMIT }), (req, res) => {
  if (!requestFromBrowser(req)) return res.status(403).json({ error: "same-origin browser only" });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: "empty body" });
  const contentType = String(req.headers["content-type"] ?? "");
  const name = decodeURIComponent(String(req.headers["x-filename"] ?? ""));
  const kind = contentType.trim().toLowerCase().startsWith("image/") ? "image" : "file";
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const file = path.join(MEDIA_DIR, pasteFileName(randomUUID(), name, contentType));
    fs.writeFileSync(file, body);
    // The very wording Telegram already uses, so an agent sees one format.
    res.json({ path: file, line: attachmentPrompt([{ path: file, kind }]) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));
// Markdown parser served locally (history rendering on the client).
// Resolved through require.resolve, not a hardcoded path: in the npm install
// (~/.shadok-ai/app) marked is hoisted above node_modules/shadok-ai and the
// path relative to __dirname 404'd — the client fell back to plain text.
const require = createRequire(import.meta.url);
const markedUmd = path.join(
  path.dirname(require.resolve("marked/package.json")),
  "lib",
  "marked.umd.js",
);
// `dotfiles: "allow"` is MANDATORY: the app is installed under ~/.shadok-ai/,
// so marked's absolute path contains a `.shadok-ai` segment. Express 5 / `send`
// treats any segment starting with `.` as a dotfile and, with the `ignore`
// default, returns 404 WITHOUT ever stat-ing the file — the client then fell
// back to plain text (unrendered Markdown). (express.static above is unaffected:
// once a `root` is set, send only tests the RELATIVE segments.)
app.get("/vendor/marked.js", (_req, res) =>
  res.sendFile(markedUmd, { dotfiles: "allow" }),
);
// HTML sanitiser — the transcript renders Markdown written by the agent, hence
// derived from untrusted content (a cloned README, a web page, a Telegram
// message). We resolve the browser build DIRECTLY: unlike marked, dompurify
// does not publish `./package.json` in its `exports`, so going through the
// package folder throws ERR_PACKAGE_PATH_NOT_EXPORTED. This subpath is
// exported.
const purifyDist = require.resolve("dompurify/purify.min.js");
app.get("/vendor/purify.js", (_req, res) =>
  res.sendFile(purifyDist, { dotfiles: "allow" }),
);
// xterm.js (experimental interactive terminal) — same require.resolve +
// dotfiles:"allow" reasoning as marked above.
const xtermDir = path.dirname(require.resolve("@xterm/xterm/package.json"));
app.get("/vendor/xterm.js", (_req, res) =>
  res.sendFile(path.join(xtermDir, "lib", "xterm.js"), { dotfiles: "allow" }),
);
app.get("/vendor/xterm.css", (_req, res) =>
  res.sendFile(path.join(xtermDir, "css", "xterm.css"), { dotfiles: "allow" }),
);
const xtermFitDir = path.dirname(require.resolve("@xterm/addon-fit/package.json"));
app.get("/vendor/addon-fit.js", (_req, res) =>
  res.sendFile(path.join(xtermFitDir, "lib", "addon-fit.js"), { dotfiles: "allow" }),
);
// Resumable sessions of a directory (for the "resume by id" picker).
app.get("/sessions", (req, res) => {
  const cwd = String(req.query.cwd ?? "").trim() || process.cwd();
  res.json(listSessions(cwd));
});
// Full-text search across THIS cockpit's agents: every channel's WHOLE
// transcript (readHistoryTurns, uncapped) matched by the pure `searchTurns`,
// with the same text a human would have read. Behind the gate above, like the
// rest — a transcript can hold anything an agent printed. The corpus is small,
// so scanning on demand is fine; hits are newest-first across agents and capped
// so one query can't return a giant payload.
app.get("/search", (req, res) => {
  const q = normalizeQuery(String(req.query.q ?? ""));
  if (q.length < MIN_QUERY) return res.json({ q, results: [], truncated: false });
  const TOTAL_CAP = 80;
  const results: {
    sessionId: string;
    agent: string;
    role: string;
    at: number | null;
    snippet: { before: string; match: string; after: string };
  }[] = [];
  for (const ch of loadChannels()) {
    if (!ch.sessionId || !ch.cwd) continue;
    for (const h of searchTurns(readHistoryTurns(ch.cwd, ch.sessionId), q, 5)) {
      results.push({
        sessionId: ch.sessionId,
        agent: ch.name || ch.sessionId.slice(0, 8),
        role: h.role,
        at: h.at ?? null,
        snippet: h.snippet,
      });
    }
  }
  results.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  res.json({ q, results: results.slice(0, TOTAL_CAP), truncated: results.length > TOTAL_CAP });
});
// Sessions alive in THIS server (agents spawned by any client, including the
// pilotctl thin client). They own no transcript until their first turn, so
// /sessions cannot see them — this is the only way the UI can list them.
app.get("/live", (_req, res) => {
  res.json(
    [...sessions.values()]
      .filter((s) => !s.pilot.hasExited)
      .map((s) => ({
        id: s.id,
        cwd: s.cwd,
        branch: s.worktree?.branch ?? null,
        busy: s.busy,
        clients: s.clients.size,
        lastPrompt: s.lastPrompt,
      })),
  );
});
// Current 5-hour and 7-day subscription usage, each window enriched with how it
// compares to the time already elapsed (for the quota gauges and the send guard).
app.get("/usage", async (_req, res) => {
  const u = await getUsage();
  const now = Date.now();
  // The pace is derived per request, not per fetch: getUsage() caches for 60 s
  // and a frozen pace would drift away from the clock.
  const enrich = (w: Window | null, durationSec: number) =>
    w ? { ...w, ...computePace(w, durationSec, now) } : null;
  res.json({
    fiveHour: enrich(u?.fiveHour ?? null, WINDOW_SEC.fiveHour),
    sevenDay: enrich(u?.sevenDay ?? null, WINDOW_SEC.sevenDay),
    fetchedAt: u?.fetchedAt ?? now,
    ...paceBlock(u, now),
  });
});
// Changes made by a session (git status + diff), for the review panel.
app.get("/diff", (req, res) => {
  const s = sessions.get(String(req.query.session ?? ""));
  if (!s) return res.json({ status: "", diff: "", branch: null, error: "no such session" });
  // The repo is what gives the diff a baseline (gitDiff computes the fork point
  // off it). A RESUME has no `worktree` object even when the session lives in
  // one (invariant 1), and a multi-day agent — the very case the live base
  // exists for — has certainly been resumed by then, so fall back to the
  // channel's own `repo`, as endChannel already does.
  const ch = loadChannels().find((c) => c.sessionId === s.id);
  res.json(gitDiff(s.cwd, s.worktree?.repo ?? ch?.repo ?? null));
});
// Past worktree sessions of a repo (for reopening unfinished work).
app.get("/recover", (req, res) => {
  const repo = String(req.query.repo ?? "").trim() || process.cwd();
  res.json(isGitRepo(repo) ? listPastSessions(repo) : []);
});
// Server-side defaults (the launch directory pre-fills the working dir field).
app.get("/defaults", (_req, res) => {
  // instanceKey namespaces the client's localStorage channel cache by launch
  // dir, so two cockpits on the same origin (same port, sequentially) never
  // share it. One source of truth with the server's own per-dir keying.
  res.json({ cwd: process.cwd(), instanceKey: instanceKey() });
});
// Cockpit name (header brand + browser tab), per launch directory — so several
// cockpits stay distinguishable across a reload. Empty PUT clears it.
app.get("/title", (_req, res) => {
  res.json({ title: titleForCwd(loadConfig(), process.cwd()) });
});
app.put("/title", (req, res) => {
  const raw = String(req.body?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  setTitleForCwd(loadConfig(), process.cwd(), raw);
  res.json({ title: titleForCwd(loadConfig(), process.cwd()) });
});
// Colour palette, per launch directory — an accent key ("emerald"…). The setter
// validates against the known palettes; the default/unknown clears it.
app.get("/theme", (_req, res) => {
  res.json({ theme: themeForCwd(loadConfig(), process.cwd()) });
});
app.put("/theme", (req, res) => {
  setThemeForCwd(loadConfig(), process.cwd(), String(req.body?.theme ?? ""));
  res.json({ theme: themeForCwd(loadConfig(), process.cwd()) });
});
// Materialises shadok-ai's own source for the "Tweak Shadok-AI" CTA, and hands
// back the directory to start the agent in. Sits here so it inherits the same
// password gate as its neighbours.
app.post("/tweak/prepare", (_req, res) => {
  const r = ensureSelfRepo();
  if (r.error) return res.status(500).json({ error: r.error });
  res.json({ cwd: r.cwd });
});
// Running version + latest seen on npm (null if not yet polled / check disabled).
// Same payload as the WS `version` message, deliberately from ONE builder: the
// two used to be written out separately and drifted the moment a field was
// added — the HTTP route silently kept serving the older shape.
app.get("/version", (_req, res) => res.json(versionState()));

// Claude sign-in state. Instance-global — NOT per session — hence HTTP rather
// than a WS message: every tab and the Telegram bridge share one answer.
app.get("/auth", async (_req, res) => res.json(await authStatus()));

app.post("/auth/login", async (_req, res) => {
  const r = await startLogin();
  if ("error" in r) return res.status(502).json(r);
  res.json(r);   // {url} or {alreadySignedIn:true} — the latter spawns nothing
});

app.post("/auth/code", async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const r = await submitLoginCode(code);
  if (r.ok) resetLoggedOutNotice(); // the next sign-out gets announced again
  res.status(r.ok ? 200 : 400).json(r);
  // A brand-new instance was signed out at boot, so this is where its lead
  // agent is really born. Answer the browser FIRST — the spawn takes seconds
  // and the sign-in card has no reason to wait for it.
  if (r.ok) void startFirstAgent();
});

app.delete("/auth/login", (_req, res) => {
  cancelLogin();
  res.json({ ok: true });
});

// The header's GitHub button. Proxied through us so the browser never talks to
// GitHub: no third-party script, no CSP to widen, and no user IP handed over.
app.get("/stars", async (_req, res) => res.json({ count: await starCount() }));
// Channel list, persisted server-side per launch directory — survives a wiped
// browser, another device, a restart or a reboot.
/**
 * The registry, enriched with what the client cannot derive on its own: each
 * channel's schedules (the tab shows a ⏰ for them).
 *
 * Derived on read, never stored: the browser PUT only sends back a fixed shape
 * (see invariant 6), so this field cannot pollute the registry. And it is what
 * avoids a second poll — `/channels` is already re-read every 4 s.
 */
app.get("/channels", (_req, res) => {
  const active = loadCrons().filter((c) => c.enabled);
  res.json(
    loadChannels().map((ch) => {
      const mine = active.filter((c) => c.sessionId === ch.sessionId);
      return mine.length ? { ...ch, crons: mine.map((c) => scheduleLabel(c.schedule, cronTimeZone(c))) } : ch;
    }),
  );
});

// ── Crons (scheduled channel prompts) ───────────────────────────────────────
app.get("/crons", (_req, res) => res.json(loadCrons()));
// Create (no id) or update (id present). Body: { id?, sessionId, prompt,
// schedule:{kind,...}, enabled? }.
app.post("/crons", (req, res) => {
  const b = req.body ?? {};
  const sessionId = String(b.sessionId ?? "").trim();
  const prompt = String(b.prompt ?? "").trim();
  const existing = b.id ? loadCrons().find((c) => c.id === b.id) : undefined;
  // The zone is resolved BEFORE the schedule: a one-shot dated as a wall clock
  // ("2026-08-25T08:42") means nothing without it.
  //
  // Explicit zone: refused when invalid rather than silently ignored — a
  // "Europe/Pariss" falling back to the machine's zone would produce exactly
  // the silent shift this is meant to remove.
  const rawTz = typeof b.tz === "string" ? b.tz.trim() : "";
  if (rawTz && !isValidTimeZone(rawTz)) return res.status(400).json({ error: `unknown timezone '${rawTz}'` });
  const tz = rawTz || existing?.tz;
  const zone = cronTimeZone({ tz });
  let rawSchedule = b.schedule;
  if (rawSchedule?.kind === "once" && typeof rawSchedule.at === "string" && !/^\d+$/.test(rawSchedule.at.trim())) {
    const at = onceAt(zone, rawSchedule.at);
    if (at == null) return res.status(400).json({ error: `unreadable date '${rawSchedule.at}' — use YYYY-MM-DDTHH:MM` });
    rawSchedule = { kind: "once", at };
  }
  const schedule = normalizeSchedule(rawSchedule);
  if (!sessionId || !prompt || !schedule) return res.status(400).json({ error: "sessionId, prompt and a valid schedule are required" });
  // An instant already past is refused rather than stored: it would fire within
  // the second, which is not what anyone means by writing a date.
  if (schedule.kind === "once" && schedule.at <= Date.now())
    return res.status(400).json({ error: `that instant is already past (${scheduleLabel(schedule, zone)})` });
  const enabled =
    typeof b.enabled === "boolean"
      ? b.enabled
      : schedule.kind === "once"
        ? true // re-arm: a spent one-shot being re-edited is enabled:false
        : (existing?.enabled ?? true);
  const check = typeof b.check === "string" && b.check.trim() ? String(b.check).trim() : undefined;
  const cron: Cron = {
    id: existing?.id ?? randomUUID(),
    sessionId,
    prompt,
    schedule,
    enabled,
    ...(check ? { check } : {}),
    ...(tz ? { tz } : {}),
    lastRun: existing?.lastRun,
    nextRun: enabled ? nextRunFor(schedule, Date.now(), zone) : undefined,
  };
  upsertCron(cron);
  res.json({ ...cron, timezone: cronTimeZone(cron) });
});
// Default zone for `daily` crons. GET also returns the machine's zone, so the
// caller can show what actually applies when nothing is set.
app.get("/timezone", (_req, res) =>
  res.json({ timezone: defaultTimeZone() ?? null, system: systemTimeZone() }),
);
app.post("/timezone", (req, res) => {
  const raw = String(req.body?.timezone ?? "").trim();
  if (raw && !isValidTimeZone(raw)) return res.status(400).json({ error: `unknown timezone '${raw}'` });
  const cfg = loadConfig();
  if (raw) cfg.timezone = raw;
  else delete cfg.timezone; // empty = back to the machine's zone
  saveConfig(cfg);
  // Crons already scheduled still aim at the old hour: realign them right
  // away, otherwise the change looks like it did nothing until the first fire
  // (at the wrong hour).
  primeCrons();
  res.json({ timezone: defaultTimeZone() ?? null, system: systemTimeZone() });
});
app.delete("/crons", (req, res) => {
  // Accepts a prefix (that is all the `list` views show) and tells the truth:
  // an unconditional `{ok:true}` made a deletion that deleted nothing look like
  // a success — the cron stayed, and nothing said so.
  const r = resolveCronId(loadCrons(), String(req.query.id ?? ""));
  if (!r.ok) {
    const status = r.error === "empty" ? 400 : r.error === "ambiguous" ? 409 : 404;
    return res.status(status).json({
      error:
        r.error === "empty"
          ? "id required"
          : r.error === "ambiguous"
            ? `'${req.query.id}' matches ${r.matches} crons — use more characters`
            : `no cron matches '${req.query.id}'`,
    });
  }
  removeCron(r.id);
  res.json({ ok: true, id: r.id });
});
app.put("/channels", (req, res) => {
  // Merge, don't overwrite: the browser owns order + name/group, but must never
  // drop a live or Telegram-bound session or strip server-owned fields.
  const live = new Set([...sessions.values()].filter((s) => !s.pilot.hasExited).map((s) => s.id));
  const before = new Map(loadChannels().map((c) => [c.sessionId, c.name]));
  const merged = mergeClientChannels(Array.isArray(req.body) ? req.body : [], live);
  // A web-side rename of a Telegram-bound channel → rename its topic too.
  for (const c of merged) {
    if (c.telegram?.threadId && c.name && c.name !== before.get(c.sessionId)) {
      renameTelegramTopic(c.telegram.chatId, c.telegram.threadId, c.name);
    }
  }
  res.json(merged);
});
// Kill a channel by id over HTTP — works with no live WebSocket, so the web ✕
// can remove a dead/zombie channel (registry entry + Telegram topic + any live
// session), not just a running one.
app.delete("/channel", async (req, res) => {
  const id = String(req.query.session ?? "").trim();
  if (!id) return res.status(400).json({ error: "session required" });
  const ok = await endChannel(id);
  // 409, not 200: the caller asked for something the server will not do, and a
  // client that believes it succeeded removes a tab the registry still has.
  res.status(ok ? 200 : 409).json(ok ? { ok } : { ok, error: "the home channel can't be closed" });
});
app.get("/groups", (_req, res) => res.json(loadGroups()));
app.put("/groups", (req, res) => {
  saveGroups(Array.isArray(req.body) ? req.body : []);
  res.json({ ok: true });
});

// Central secret vault (global, stored 600 outside any repo). Values are NEVER
// returned — only names. A profile references names to inject them.
app.get("/secrets", (_req, res) => res.json({ names: secretNames() }));
app.put("/secrets", (req, res) => {
  const { name, value, overwrite } = req.body ?? {};
  if (typeof name !== "string" || !name.trim() || typeof value !== "string")
    return res.status(400).json({ error: "name and value required" });
  const key = name.trim();
  // HTTP is the ONLY way an agent can reach the vault — it is a separate
  // process, and Telegram's /secret calls setSecret() directly. So guarding
  // here guards exactly the machine path, and nothing a human does by hand.
  const verdict = secretWriteVerdict(secretNames().includes(key), overwrite === true);
  if (verdict === "refused") return res.status(409).json({ error: "exists", name: key });
  setSecret(key, value);
  res.json({ names: secretNames(), result: verdict });
});
app.delete("/secrets", (req, res) => {
  const name = String(req.query.name ?? req.body?.name ?? "").trim();
  if (name) deleteSecret(name);
  res.json({ names: secretNames() });
});

// Agent profiles (global): role + permission guardrails + referenced secrets,
// applied at spawn. `secrets` is a list of vault NAMES (not values).
// `origin` is DERIVED, never stored (like `crons` on /channels, cf. invariant 6):
// "tracked" = no prompt stored, so the build's is used and is always current;
// "edited" = the user wrote their own; "outdated" = their own, and the build's
// has moved since they forked it; "custom" = a role this build does not ship.
// Only an edited prompt can fall behind now — a tracked one has nothing to fall
// behind, which is the point of storing nothing.
// `origin` and `effectivePrompt` are both DERIVED, never stored (like `crons` on
// /channels, cf. invariant 6). A tracked role holds no prompt of its own, so the
// panel had nothing to show and displayed an empty box — you could not read the
// role you were about to run, and saving that empty box pinned it to "".
/**
 * Managing accounts is BROWSER-ONLY, on top of the admin role.
 *
 * Every agent is handed `SHADOK_AUTH` — a signed session for the bootstrap
 * admin — so the role check alone is satisfied by any agent on this machine: it
 * could mint an admin invitation or delete an account without anyone asking it
 * to. The account surface is exactly where that must not be reachable by
 * accident, so it takes the same guard as the guardrail routes (invariant 28,
 * `PUT /profiles`): a real same-origin `Origin`, which loopback callers —
 * agents, pilotctl, the Telegram bridge — do not send.
 *
 * It is a boundary against ACCIDENT, not against intent, and the difference is
 * worth stating: agents run as the same OS user, so one that means to escalate
 * can read the signing key out of `~/.shadok-ai/users/` and forge any cookie,
 * or edit the accounts file directly. Real separation between PEOPLE needs the
 * agent-side leaks closed and, ultimately, an OS user or a container per agent.
 * What this buys is that nothing reaches these routes without meaning to.
 */
function accountAdmin(
  req: { headers: Record<string, unknown> },
  res: { status: (n: number) => { json: (b: unknown) => unknown } },
  /**
   * Require a real same-origin `Origin`. True for WRITES only.
   *
   * A browser sends no `Origin` on a same-origin GET — that is the spec, not a
   * quirk — so demanding one on the read made the Users panel's own `fetch`
   * impossible: it got 403 and showed "no accounts yet" while an account
   * existed. The guard is a CSRF protection; it belongs on the requests that
   * CHANGE something, where the browser does send the header. A read stays
   * admin-only, which is what it was designed to be.
   */
  browserOnly = true,
): { name: string; role: Role } | null {
  if (browserOnly && !requestFromBrowser(req)) {
    res.status(403).json({ error: "same-origin browser only" });
    return null;
  }
  const me = currentAccount(req);
  if (me?.role !== "admin") {
    res.status(403).json({ error: "only an admin can manage accounts" });
    return null;
  }
  return me;
}

/** Accounts are listed to admins only: a member has no use for the list, and
 *  the shortest surface wins. Hashes and live invitation tokens never leave. */
app.get("/users", (req, res) => {
  if (!accountAdmin(req, res, false)) return;
  res.json(
    loadAccounts().map((a) => ({
      name: a.name,
      role: a.role,
      pending: !a.passwordHash,
      expiresAt: a.invite?.expiresAt ?? null,
    })),
  );
});

// Create AND issue the invitation in one step: an account with no way in is a
// dead row, and two calls would let one succeed without the other.
app.post("/users", (req, res) => {
  const me = accountAdmin(req, res);
  if (!me) return;
  const name = String(req.body?.name ?? "").trim();
  const role: Role = req.body?.role === "admin" ? "admin" : "member";
  const list = loadAccounts();
  const v = userWriteVerdict({
    actorRole: me?.role ?? null,
    action: "create",
    target: name,
    exists: list.some((a) => a.name === name),
  });
  if (!v.ok) return res.status(me?.role === "admin" ? 400 : 403).json({ error: v.error });
  const invite = newInvite(Date.now());
  saveAccounts([...list, { name, role, createdAt: Date.now(), invite }]);
  console.log(`users: ${me!.name} invited ${name} as ${role}`);
  res.json({ ok: true, name, role, inviteUrl: `/invite/${invite.token}` });
});

app.delete("/users", (req, res) => {
  const me = accountAdmin(req, res);
  if (!me) return;
  const name = String(req.query.name ?? "").trim();
  const list = loadAccounts();
  const v = userWriteVerdict({
    actorRole: me?.role ?? null,
    action: "delete",
    target: name,
    exists: list.some((a) => a.name === name),
  });
  if (!v.ok) return res.status(me?.role === "admin" ? 400 : 403).json({ error: v.error });
  saveAccounts(list.filter((a) => a.name !== name));
  console.log(`users: ${me!.name} removed ${name}`);
  res.json({ ok: true });
});

app.post("/users/role", (req, res) => {
  const me = accountAdmin(req, res);
  if (!me) return;
  const name = String(req.body?.name ?? "").trim();
  const role: Role = req.body?.role === "admin" ? "admin" : "member";
  const list = loadAccounts();
  const v = userWriteVerdict({
    actorRole: me?.role ?? null,
    action: "role",
    target: name,
    exists: list.some((a) => a.name === name),
  });
  if (!v.ok) return res.status(me?.role === "admin" ? 400 : 403).json({ error: v.error });
  saveAccounts(list.map((a) => (a.name === name ? { ...a, role } : a)));
  res.json({ ok: true });
});

app.get("/profiles", (_req, res) =>
  res.json(
    loadProfiles().map((p) => ({
      ...p,
      origin: promptOrigin(p, shippedProfile(p.name)),
      effectivePrompt: effectiveProfile(p)?.systemPrompt ?? "",
    })),
  ),
);

// Hand a starter role back to the build. Browser-only, like every guardrail
// write. It DROPS the stored prompt rather than copying today's text in: the
// profile goes back to tracking, so it also picks up whatever ships next.
// Copying would leave a fresh snapshot that starts going stale immediately —
// the very thing this replaced. Whatever the user attached (deny/allow/secrets/
// model) is theirs and survives.
app.post("/profiles/restore", (req, res) => {
  if (!requestFromBrowser(req))
    return res.status(403).json({ error: "profiles are restored from the web UI only" });
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const shipped = name ? shippedProfile(name) : undefined;
  if (!shipped?.systemPrompt)
    return res.status(404).json({ error: `this build ships no prompt for ${name || "(unnamed)"}` });
  const existing: Profile = getProfile(name) ?? { name };
  const { systemPrompt: _drop, promptBase: _base, ...kept } = existing;
  upsertProfile(kept as Profile);
  res.json(loadProfiles().map((p) => ({ ...p, origin: promptOrigin(p, shippedProfile(p.name)) })));
});
// Full profile write — INCLUDING the guardrails (deny/allow/secrets/model).
// Browser-only: an agent's shell sends no Origin and is refused here. Without
// this gate any agent could `curl -X PUT /profiles` with `deny: []` and strip
// its own guardrails. Agents get the narrow, prompt-only route below.
app.put("/profiles", (req, res) => {
  if (!requestFromBrowser(req))
    return res.status(403).json({
      error: "guardrails are edited from the web UI only; agents use PUT /profiles/prompt",
    });
  const b = req.body ?? {};
  if (typeof b.name !== "string" || !b.name.trim())
    return res.status(400).json({ error: "name required" });
  const name = b.name.trim();
  const written = typeof b.systemPrompt === "string" ? b.systemPrompt : undefined;
  const shipped = shippedProfile(name)?.systemPrompt;
  // Saving a shipped role UNCHANGED leaves it tracking the build rather than
  // freezing today's text — opening the editor and pressing save must not
  // quietly opt a profile out of future improvements.
  const tracks = written === undefined || (!!shipped && written.trim() === shipped.trim());
  const p: Profile = {
    name,
    systemPrompt: tracks ? undefined : written,
    // Record WHICH shipped text they forked from, so a later release can be
    // reported as "the build has moved" instead of a bare "you edited this".
    promptBase: tracks ? undefined : shipped,
    deny: Array.isArray(b.deny) ? b.deny.filter((x: unknown) => typeof x === "string") : undefined,
    allow: Array.isArray(b.allow) ? b.allow.filter((x: unknown) => typeof x === "string") : undefined,
    secrets: Array.isArray(b.secrets) ? b.secrets.filter((x: unknown) => typeof x === "string") : undefined,
    model: typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined,
  };
  upsertProfile(p);
  res.json(loadProfiles().map((x) => ({ ...x, origin: promptOrigin(x, shippedProfile(x.name)) })));
});

/**
 * The ONLY profile write an agent can make: its own `systemPrompt` — and for
 * the lead profile, any prompt plus minting new roles. Guardrails are never
 * read from this body, so a read-only agent can never hand itself git writes,
 * and a created profile never carries a vault secret (the one capability the
 * lead does not already have: it can already spawn a full-access Shadok-dev).
 *
 * Authorization is the session KEY from the agent's env, never the session id —
 * `/live` publishes every id.
 */
app.put("/profiles/prompt", (req, res) => {
  const b = req.body ?? {};
  const key = typeof b.key === "string" ? b.key : "";
  const id = key ? sessionForKey(key) : null;
  if (!id) return res.status(403).json({ error: "unknown or missing session key" });
  const caller =
    sessions.get(id)?.profile ?? loadChannels().find((c) => c.sessionId === id)?.profile ?? null;
  const target = typeof b.name === "string" && b.name.trim() ? b.name.trim() : (caller ?? "");
  const existing = target ? getProfile(target) : undefined;
  const verdict = promptEditVerdict({
    caller,
    target,
    targetExists: !!existing,
    managed: target === TWEAK_PROFILE_NAME,
  });
  if (!verdict.ok) return res.status(403).json({ error: verdict.error });
  const systemPrompt = typeof b.systemPrompt === "string" ? b.systemPrompt : "";
  if (!systemPrompt.trim()) return res.status(400).json({ error: "systemPrompt required" });
  // Update: we start from the stored profile, so deny/allow/secrets/model
  // survive. Creation: never a secret, and access is an explicit choice.
  const next: Profile = verdict.create
    ? { name: target, systemPrompt, deny: b.readOnly ? [...READONLY_DENY] : undefined, secrets: [] }
    : { ...existing!, systemPrompt };
  upsertProfile(next);
  console.log(`profile-prompt: ${id.slice(0, 8)} (${caller ?? "no profile"}) → ${target}${verdict.create ? " [created]" : ""}`);
  res.json({
    ok: true,
    profile: target,
    created: verdict.create,
    note: "applies at the agent's next restart — the prompt is passed at spawn",
  });
});

// An agent reloads ITSELF (the `shadok-reload` skill) to pick up a changed pilot
// prompt or newly-seeded skills. Scoped by the per-session key, exactly like
// /profiles/prompt: the public session id proves nothing. Respond BEFORE the
// respawn — restartSession tears down the very process that made this call.
app.post("/reload", (req, res) => {
  const key = typeof req.body?.key === "string" ? req.body.key : "";
  const id = key ? sessionForKey(key) : null;
  if (!id) return res.status(403).json({ error: "unknown or missing session key" });
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: "session not running" });
  console.log(`reload: ${id.slice(0, 8)} — agent respawned itself`);
  res.json({ ok: true, note: "respawning — resumes with new prompt/skills" });
  // The respawn is a `--resume`: the conversation is loaded but NOTHING drives a
  // turn, so the agent sits idle ("il ne se passe plus rien"). Nudge it once the
  // new process is ready so it carries on. Scoped to the SELF-reload only — not
  // the GUI reload, restart-all, or an auto-update respawn (those touch many/all
  // agents at once, and waking every idle one would be a token storm).
  void restartSession(s)
    .then(() => continueAfterReload(s.id))
    .catch(() => {});
});

app.delete("/profiles", (req, res) => {
  const name = String(req.query.name ?? req.body?.name ?? "").trim();
  if (name) removeProfile(name);
  res.json(loadProfiles());
});

/** Build the /telegram state view (token is never included). */
async function telegramState() {
  const tc = telegramConfig(loadConfig(), process.cwd());
  const probe = await probeToken(tc.token);
  const groupId = loadTgGroup();
  return {
    hasToken: Boolean(tc.token),
    enabled: tc.enabled,
    running: tgBridge.running(),
    username: probe.username ?? tgBridge.status().username,
    tokenError: probe.error ?? tgBridge.status().tokenError,
    boundGroup: groupId === null ? null : { chatId: groupId, title: null as string | null },
    allowedChats: tc.allowedChats,
    envOverride: tc.envOverride,
  };
}

// Telegram bot config — token/on-off/allowed-chats, applied hot (no restart).
// Behind the GUI password gate like the rest. The token is write-only: never
// returned here, only set/removed.
app.get("/telegram", async (_req, res) => res.json(await telegramState()));
app.put("/telegram", async (req, res) => {
  const b = req.body ?? {};
  const patch: TelegramPatch = {};
  if (typeof b.token === "string" || b.token === null) patch.token = b.token;
  if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
  if (Array.isArray(b.allowedChats))
    patch.allowedChats = b.allowedChats.map((x: unknown) => String(x).trim()).filter(Boolean);

  const cwd = process.cwd();
  const tc = telegramConfig(loadConfig(), cwd);
  if (patch.token !== undefined && tc.envOverride)
    return res.status(403).json({ error: "token is set by the TELEGRAM_BOT_TOKEN environment variable" });

  // Unbind the board group (e.g. after a stale supergroup migration): clears the
  // binding so /setup can bind a fresh group. Read live by the bridge — no
  // restart needed for this alone.
  if (b.unbindGroup === true) saveTgGroup(null);

  const hasConfigChange =
    patch.token !== undefined || patch.enabled !== undefined || patch.allowedChats !== undefined;
  if (hasConfigChange) {
    saveConfig(applyTelegramPatch(loadConfig(), cwd, patch, tc.envOverride));
    restartTelegram();
  }
  res.json(await telegramState());
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  // Require the auth cookie on the upgrade when a password is set (the browser
  // sends it automatically; the Telegram bridge sends the internal token).
  // The origin check matters AS MUCH as the cookie: a WebSocket ignores the
  // same-origin policy, so without it any page the user visits could open a
  // session and drive an agent.
  verifyClient: (info, cb) => cb(requestOriginOk(info.req) && requestAuthed(info.req)),
});
// The ws server re-emits the http server's listen error; let the http server's
// own handler drive the port fallback instead of crashing on the re-emit.
wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") console.error(`ws server error: ${err.message}`);
});
// Keep idle /ws connections alive through reverse proxies (nginx/Caddy/Cloudflare
// idle-close a quiet socket, so a resting agent's client would loop on
// "reconnecting"). Ping well under the common 60s window; a client that misses a
// pong is dropped.
startHeartbeat(wss, Number(process.env.SHADOK_WS_PING_MS ?? 25000));

// ── Version / auto-update ───────────────────────────────────────────────────
// The running server's own version (this is the managed install's package.json
// when launched via the supervisor, i.e. exactly the version that's live).
const OWN_VERSION: string = (() => {
  try {
    return require(path.join(__dirname, "..", "package.json")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
// Latest version seen on npm (null until the first successful poll).
let latestKnown: string | null = null;
// How often to poll npm for a newer release (minutes; 0 disables the check).
const VERSION_CHECK_MIN = Number(process.env.SHADOK_VERSION_CHECK_MIN ?? 15);
// Auto-apply a newer release: notify clients, then exit 75 so the supervisor
// installs it and respawns. Runtime-toggleable via the GUI checkbox; the
// persisted config wins, falling back to the SHADOK_AUTOUPDATE env var. The
// display poll runs regardless of this flag.
let autoUpdate: boolean =
  loadConfig().autoUpdate ?? /^(1|true|yes|on)$/i.test(process.env.SHADOK_AUTOUPDATE ?? "");
// Shared-ledger reflex: OFF unless opted in (config, else SHADOK_LEDGER env).
// Gates the pilot-prompt paragraph; a live agent picks it up at next respawn.
let ledgerEnabled: boolean =
  loadConfig().ledgerEnabled ?? /^(1|true|yes|on)$/i.test(process.env.SHADOK_LEDGER ?? "");
// Most ledger changes to push ahead of one human prompt; the rest collapse to a
// "+N more" line. Deltas are usually tiny, so this rarely bites.
const LEDGER_PUSH_CAP = 8;
// Which release stream this instance follows: "alpha" (every merge) or "beta"
// (promoted versions only). Absent config → beta, so an instance that predates
// the setting keeps updating, just on the calmer channel.
let updateChannel: UpdateChannel = resolveChannel(loadConfig().updateChannel);

// Permission mode every spawned agent starts in. Config wins, then the
// SHADOK_PERMISSION_MODE env var, then the built-in default "auto" (the
// Shift+Tab "auto mode on") so agents run without stalling on prompts.
// Only affects NEW spawns; a running agent keeps the mode it launched with.
let permissionMode: string = (() => {
  const cfg = loadConfig().permissionMode;
  if (cfg && isPermissionMode(cfg)) return cfg;
  const env = (process.env.SHADOK_PERMISSION_MODE ?? "").trim();
  return env && isPermissionMode(env) ? env : "auto";
})();

/** Send a message to every connected client, regardless of session. */
function broadcastAll(msg: object): void {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(data);
}

/** The version + settings snapshot every client needs: running/latest version,
 *  whether auto-update is armed, and the spawn permission mode. */
/** What both /version and the WS `version` message report. */
function versionState() {
  return { current: OWN_VERSION, latest: latestKnown, autoUpdate, ledgerEnabled, permissionMode, updateChannel };
}

function versionMessage(): object {
  return { type: "version", ...versionState() };
}

// One in-flight update at a time (the poll can fire again mid-install).
let updating = false;

/**
 * Install the newer release in the background WHILE still serving, then exit
 * with RELOAD_EXIT_CODE so the supervisor just respawns the (already-installed)
 * new version. This keeps the downtime to a single process restart instead of
 * the full npm install. A failed install is retried on the next poll.
 */
async function triggerUpdate(version: string): Promise<void> {
  if (updating) return;
  updating = true;
  console.log(`[shadok-ai] auto-update: v${OWN_VERSION} → v${version} (installing in background…)`);
  const r = await update(version);
  if (!r.ok) {
    console.log(`[shadok-ai] auto-update install failed: ${r.error}; retrying next poll`);
    updating = false;
    return;
  }
  console.log(`[shadok-ai] auto-update installed v${r.version}; reloading`);
  broadcastAll({ type: "server-reload", version: r.version });
  // New version already on disk — the supervisor respawns it in ~1s. Small
  // delay just to flush the notice to connected clients.
  setTimeout(() => process.exit(RELOAD_EXIT_CODE), 500);
}

async function pollVersion(): Promise<void> {
  const latest = await latestVersion(updateChannel);
  if (!latest) return; // couldn't reach the registry; keep the last known value
  if (latest !== latestKnown) {
    latestKnown = latest;
    broadcastAll(versionMessage());
  }
  if (autoUpdate && isNewer(latest, OWN_VERSION)) void triggerUpdate(latest);
}

if (VERSION_CHECK_MIN > 0) {
  const timer = setInterval(() => void pollVersion(), VERSION_CHECK_MIN * 60_000);
  timer.unref(); // never keep the process alive just for the version check
  void pollVersion(); // check once shortly after boot
}

// Toggle auto-update from the GUI. Persisted so it survives restarts; when
// turned on while npm is already ahead, apply immediately instead of waiting
// for the next poll.
app.post("/autoupdate", (req, res) => {
  autoUpdate = !!req.body?.enabled;
  const cfg = loadConfig();
  cfg.autoUpdate = autoUpdate;
  saveConfig(cfg);
  broadcastAll(versionMessage());
  if (autoUpdate && latestKnown && isNewer(latestKnown, OWN_VERSION)) void triggerUpdate(latestKnown);
  res.json({ autoUpdate });
});

/**
 * Respawn every running agent (a `--resume`, so history is kept) — ONE AT A TIME,
 * in the BACKGROUND. Returns how many will be restarted, immediately.
 *
 * Concurrency here is the bug this replaces: a herd of simultaneous
 * `claude --resume` trips the upstream OAuth refresh-token race (single-use
 * refresh tokens, concurrent processes, biting at ~30+ agents) and spikes
 * resources, leaving agents flapping/stuck. The manual single reload is safe
 * precisely because it is isolated — so we serialize, matching it. And we do NOT
 * await the loop: a caller (the toggle, the button) must not hang for minutes
 * while a big fleet cycles.
 */
function restartAllSessions(): number {
  const live = [...sessions.values()];
  void (async () => {
    for (const s of live) await restartSession(s).catch(() => {});
  })();
  return live.length;
}

// Restart every agent from the GUI (they resume with history). Behind the same
// password gate as the other version-menu controls. Returns at once; the agents
// cycle one by one in the background.
app.post("/restart-all", (_req, res) => {
  const restarted = restartAllSessions();
  console.log(`restart-all: respawning ${restarted} agent(s), one at a time`);
  res.json({ restarted });
});

// The shared-ledger table for the GUI viewer (the version-menu / header button).
// Reads the same file the `shadok-ledger` skill writes; most-recent first; an
// absent or unreadable file → []. Read-only — agents write it via the skill.
app.get("/ledger", (_req, res) => {
  // This instance's own ledger (keyed by the launch dir), the same file agents
  // write through SHADOK_LEDGER_FILE.
  const entries = loadLedger(ledgerFileFor(process.cwd()));
  entries.sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
  res.json({ entries, enabled: ledgerEnabled });
});

// Toggle the shared-ledger reflex from the GUI. Persisted. The reflex is fixed
// at spawn, so flipping it only lands once agents respawn — so we respawn them
// all (when it actually changed), making the toggle "just work". Serial and in
// the background (see restartAllSessions), so the request never hangs. Default
// OFF, opt-in per instance.
app.post("/ledger", (req, res) => {
  const next = !!req.body?.enabled;
  const changed = next !== ledgerEnabled;
  ledgerEnabled = next;
  const cfg = loadConfig();
  cfg.ledgerEnabled = ledgerEnabled;
  saveConfig(cfg);
  broadcastAll(versionMessage());
  const restarted = changed ? restartAllSessions() : 0;
  res.json({ ledgerEnabled, restarted });
});

/**
 * Switch release stream from the GUI. Persisted, then polled at once: the whole
 * point of moving to alpha is not waiting up to VERSION_CHECK_MIN to see it,
 * and moving to beta must re-resolve too — `latestKnown` still holds the alpha
 * version, which would otherwise be offered as an update on the calm channel.
 */
app.post("/update-channel", (req, res) => {
  const c = String(req.body?.channel ?? "");
  if (c !== "alpha" && c !== "beta") return res.status(400).json({ error: "invalid channel" });
  updateChannel = c;
  const cfg = loadConfig();
  cfg.updateChannel = c;
  saveConfig(cfg);
  latestKnown = null; // stale for the new channel until the poll answers
  broadcastAll(versionMessage());
  // Re-resolve at once — waiting up to VERSION_CHECK_MIN to see the channel you
  // just picked is the whole point of the immediate poll. But it MUST honour the
  // same gate as the periodic one: `SHADOK_VERSION_CHECK_MIN=0` is how a
  // developer runs a local build without it updating itself away (CLAUDE.md,
  // "Running YOUR build"), and a poll fired from here bypassed it — the local
  // build installed the published version and exited mid-test.
  if (VERSION_CHECK_MIN > 0) void pollVersion();
  res.json({ updateChannel });
});

// Set the spawn permission mode from the GUI. Persisted; only affects agents
// started after the change (existing ones keep their launch mode).
app.post("/permission-mode", (req, res) => {
  const m = String(req.body?.mode ?? "").trim();
  if (!isPermissionMode(m)) return res.status(400).json({ error: "invalid mode" });
  permissionMode = m;
  const cfg = loadConfig();
  cfg.permissionMode = m;
  saveConfig(cfg);
  broadcastAll(versionMessage());
  res.json({ permissionMode });
});

type ClientMessage =
  | {
      type: "start";
      cwd?: string;
      resume?: string;
      continue?: boolean;
      worktree?: boolean;
      /** Reopen: recreate this worktree branch's checkout if it was reclaimed. */
      branch?: string;
      /** Reopen: the repo the worktree belongs to (to recreate the checkout). */
      repo?: string;
      /** Agent profile to apply (role/guardrails/secrets) — new sessions only. */
      profile?: string;
      /** The channel that launched this one. pilotctl sends its own
       *  SHADOK_SESSION_ID here, so the link needs no configuring. Refused on a
       *  cycle / unknown parent / cap, exactly like `set-parent`. */
      parent?: string | null;
      /** Who drives this client: "web", "cron", "telegram", "cli"… Travels with
       *  the prompt echo so other clients can say who spoke. */
      origin?: string;
      /** Should this channel be mirrored into Telegram? Chosen at creation
       *  (the form's checkbox); afterwards the channel menu decides. */
      mirror?: boolean;
    }
  /** `force`: send despite a pace overrun. Applies to this message only. */
  /** `from`: display name of whoever typed it, when a client knows it (the
   *  Telegram bridge does). Echoed to the OTHER clients so the web can name the
   *  author instead of an anonymous "pilot (elsewhere)". */
  | { type: "prompt"; text: string; force?: boolean; from?: string }
  | { type: "choose"; n: number }
  | { type: "toggle"; n: number }
  | { type: "confirm" }
  | { type: "freetext"; n: number; text: string }
  | { type: "key"; key: string }
  | { type: "settle" }
  | { type: "restart" }
  /** Change the agent's profile. `profile: null` = no profile. `restart` applies
   *  it right away (re-spawn in place, history kept); without it the change is
   *  stored and takes effect at the next restart. */
  | { type: "set-profile"; profile: string | null; restart?: boolean }
  /** Attach this channel under another (or detach with null), so that parent —
   *  and only that parent — is told when this agent finishes, blocks on a
   *  question, or dies. Like `profile`, `parent` is SERVER_OWNED, so this is
   *  the only path that may write it. */
  | { type: "set-parent"; parent: string | null }
  /** Experimental raw terminal: attach/detach the pipe, or feed raw input
   *  bytes (base64). */
  | { type: "term-attach" }
  | { type: "term-input"; data: string }
  | { type: "term-resize"; cols: number; rows: number }
  | { type: "term-detach" }
  /** `sessionId`: kill a specific channel even if it isn't the connection's
   *  attached session (lets the UI remove a dead/zombie channel). */
  | { type: "stop"; sessionId?: string };

/**
 * A piloted session = ONE claude process, shared by N WebSocket clients.
 * Every event (prompts, answers, dialogs, screen) is broadcast to all
 * attached clients — several tabs or interfaces can follow the same
 * session live.
 */
/** Either transport — same surface; TmuxPilot additionally survives restarts. */
type Pilot = PtyPilot | TmuxPilot;

/**
 * Selects the transport. tmux is the DEFAULT whenever it is installed: the
 * agent runs in a detached tmux session named after the Claude session id, so
 * it survives the server restarting/crashing and is reattached on the next
 * start of the same id. Set SHADOK_TMUX=0 to force the node-pty transport
 * (which dies with the server). Falls back to node-pty if tmux is absent.
 */
// `let`, not `const`: a boot-time tmux auto-install (below) can flip this
// process onto tmux without waiting for the next restart.
let USE_TMUX = process.env.SHADOK_TMUX !== "0" && tmuxAvailable();

/**
 * System prompt appended to every piloted session (--append-system-prompt):
 * tells the agent it runs under the shadok-ai cockpit (chat rendering, sibling
 * sessions, worktree discipline…). Read once from context/pilot-prompt.md;
 * absent file or SHADOK_PILOT_PROMPT=0 → no injection.
 */
const PILOT_PROMPT_PATH = path.join(__dirname, "..", "context", "pilot-prompt.md");
let pilotPromptCache: string | null | undefined;
function pilotPrompt(): string | null {
  if (pilotPromptCache === undefined) {
    try {
      pilotPromptCache =
        process.env.SHADOK_PILOT_PROMPT === "0"
          ? null
          : fs.readFileSync(PILOT_PROMPT_PATH, "utf8").trim() || null;
    } catch {
      pilotPromptCache = null;
    }
  }
  return pilotPromptCache;
}

/**
 * The shared-ledger reflex, appended to the pilot prompt ONLY when `ledgerEnabled`
 * is on. Kept OUT of pilot-prompt.md — which is always appended — precisely so it
 * can be gated. Read once from context/ledger-reflex.md.
 */
const LEDGER_REFLEX_PATH = path.join(__dirname, "..", "context", "ledger-reflex.md");
let ledgerReflexCache: string | null | undefined;
function ledgerReflex(): string | null {
  if (ledgerReflexCache === undefined) {
    try {
      ledgerReflexCache = fs.readFileSync(LEDGER_REFLEX_PATH, "utf8").trim() || null;
    } catch {
      ledgerReflexCache = null;
    }
  }
  return ledgerReflexCache;
}

/**
 * The model SETTING this session runs with — the string that may carry the
 * `[1m]` suffix, not the resolved model name.
 *
 * Two sources, in the order the CLI itself resolves them: a shadok profile that
 * pins a model passes it as `--model` (`profileArgs`), and otherwise the process
 * inherits `~/.claude/settings.json`. Reading that file is why this cannot live
 * in the pure `context.ts`. Returns null when nothing is set anywhere — a
 * container's settings.json typically has no model at all — and `windowForModel`
 * then assumes the standard window, which `effectiveWindow` corrects if the
 * session ever proves it wrong.
 */
function sessionModelSetting(profileName?: string | null): string | null {
  const pinned = (profileName ? getProfile(profileName) : undefined)?.model?.trim();
  if (pinned) return pinned;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8");
    const model = JSON.parse(raw)?.model;
    return typeof model === "string" && model.trim() ? model.trim() : null;
  } catch {
    return null; // no settings file, unreadable, or not JSON — assume the default
  }
}

/**
 * What shadok added to each agent's context, captured AT SPAWN.
 *
 * Not recomputed on demand: the profile and the permission mode can change
 * after an agent started, and the panel must show what the RUNNING process was
 * given — the same gap the UI already models as `profile` vs `appliedProfile`.
 */
const prepromptById = new Map<string, PrepromptPart[]>();

/** The skills shadok seeds — the ones it is answerable for. */
const SEEDED_SKILLS = [
  "shadok-ai-agents",
  "shadok-scheduler",
  "shadok-secrets",
  "shadok-ledger",
  "shadok-reload",
];

/**
 * What shadok installed into this machine's skills directory, read from DISK
 * rather than assumed from the list above: a seed that failed must show as
 * missing, not as present. Read at spawn, because these are refreshed at every
 * boot and are not captured with the rest of the arguments.
 */
function installedCapabilities(): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const name of SEEDED_SKILLS) {
    try {
      const md = fs.readFileSync(
        path.join(os.homedir(), ".claude", "skills", name, "SKILL.md"),
        "utf8",
      );
      const meta = parseSkillMeta(md);
      out.push({ name, description: meta.description ?? "(no description)" });
    } catch {
      /* not seeded here — leaving it out IS the honest answer */
    }
  }
  return out;
}

function makePilot(id: string, cwd: string, args: string[], profileName?: string | null): Pilot {
  // A worktree is a brand-new directory, so it carries a brand-new trust
  // dialog. Seed it before the process exists, not after it is stuck on it.
  ensureProjectTrusted(cwd);
  const profile = profileName ? getProfile(profileName) : undefined;
  // Env = the vault secrets the profile references (none without a profile).
  // Kept apart from the SHADOK_* plumbing below: only THESE are secrets, and
  // only these belong in the note. Announcing SHADOK_SESSION_ID as a "secret you
  // must never print" was noise that buried the real ones.
  const secretEnv = secretsFor(profile?.secrets);
  const env: Record<string, string> = { ...secretEnv };
  // Self-scheduling context: lets the shadok-scheduler skill register/list/remove
  // crons on THIS channel via the local API (so the user can set up monitoring in
  // plain language just by asking the agent).
  env.SHADOK_SESSION_ID = id;
  env.SHADOK_PORT = String(boundPort || START_PORT);
  if (GUI_PASSWORD) env.SHADOK_AUTH = adminCookie()!;
  // Proves WHO calls /profiles/prompt: without it "my own profile" means
  // nothing, since the session id is public.
  env.SHADOK_SESSION_KEY = sessionKeyFor(id);
  // The PER-INSTANCE ledger file: an agent's cwd is a worktree, not the launch
  // dir, so it cannot derive the scope itself — hand it the path the skill writes.
  env.SHADOK_LEDGER_FILE = ledgerFileFor(process.cwd());
  // Args = base + profile flags (role / guardrails / model) + a note listing the
  // injected env-var names (so the agent knows what it has) + the cockpit pilot
  // prompt. Profile flags first so a profile never overrides the cockpit context.
  // The RESOLVED names: a profile referencing a secret missing from the vault
  // must not promise the agent a variable that does not exist.
  const note = envVarsNote(Object.keys(secretEnv));
  const sp = pilotPrompt();
  // Opt-in only: a live agent gains the reflex at its next (re)spawn.
  const lr = ledgerEnabled ? ledgerReflex() : null;
  const fullArgs = [
    ...args,
    ...permissionModeArgs(permissionMode),
    ...profileArgs(effectiveProfile(profile)),
    ...(note ? ["--append-system-prompt", note] : []),
    ...(sp ? ["--append-system-prompt", sp] : []),
    ...(lr ? ["--append-system-prompt", lr] : []),
  ];
  const resolved = effectiveProfile(profile);
  prepromptById.set(
    id,
    prepromptParts({
      profileName: profileName ?? null,
      role: resolved?.systemPrompt,
      model: resolved?.model,
      deny: resolved?.deny,
      allow: resolved?.allow,
      permissionMode,
      // NAMES only: the values are in `env`, and never travel to a client.
      secretNames: Object.keys(secretEnv),
      capabilities: installedCapabilities(),
      pilotPrompt: sp ?? undefined,
      ledgerReflex: lr,
    }),
  );
  // Spawn the binary `claudeCommand` resolved, not the bare name `claude`. They
  // differ exactly when the npm launcher is the fallback placeholder: spawning
  // by name would then run the 500-byte stub, which exits 1 on stderr and looks
  // like an agent that died for no reason. With nothing resolvable it falls
  // back to the bare name, i.e. the historical behaviour.
  const claudePath = claudeCommand();
  return USE_TMUX
    ? new TmuxPilot({ cwd, args: fullArgs, env, tmuxName: "sk-" + id, claudePath })
    : new PtyPilot({ cwd, args: fullArgs, env, claudePath });
}

interface Live {
  id: string;
  /** The transcript the content tail FOLLOWS. Defaults to `id`; set to a new id
   *  when Claude Code forks the session (context overflow) so the chat follows
   *  the live transcript instead of freezing on the old one. See forktrace.ts. */
  tailId?: string;
  /** Lineage-root id used to recognise a fork (the transcript's snake_case
   *  `session_id`, constant across the whole fork chain). Cached on first need;
   *  falls back to `id` when the file has no root record yet. See forktrace.ts. */
  rootId?: string;
  /** Transcript ids this session has already tailed and left (anti-flap: never
   *  follow back onto a transcript we moved off). See forktrace.ts. */
  tailSeen?: Set<string>;
  /** When the tracked transcript last produced content. The fork detector only
   *  hunts once this has been silent for FORK_STALL_MS while the pane shows work
   *  — so a healthy, still-streaming session never looks for a fork. */
  lastContentAt?: number;
  /** Watermark for the pushed ledger delta: the moment this agent last saw the
   *  ledger. Each human prompt injects the rows changed since, then advances it.
   *  In-memory (near-real-time, not an audit); a restart re-anchors it to now. */
  ledgerSeenAt?: number;
  cwd: string;
  pilot: Pilot;
  clients: Set<WebSocket>;
  busy: boolean;
  lastPrompt: string;
  screenTimer: ReturnType<typeof setInterval> | null;
  lastScreen: string;
  /** Identity of the dialog last broadcast, so the screen watcher can surface a
   *  NEW question without re-sending the current one 3 times a second. */
  lastDialogKey: string | null;
  /** Context-window fill (%), computed from the transcript's token usage. */
  contextPct: number | null;
  /** The window this session's model setting asks for (see `windowForModel`). */
  contextWindow: number;
  /** The last assistant block of this turn was the silence placeholder. */
  lastTurnSilent: boolean;
  /** A hidden prompt (a `cron` fire or a parent notification) was just
   *  submitted and is NOT echoed, so the next assistant text would stream
   *  adjacent to the previous turn and merge under one label. Set here, consumed
   *  by the first streamed text as `afterInternal` — the live twin of the
   *  history-replay flag (`HistoryTurn.afterInternal`). Cleared when a visible
   *  prompt (which breaks the group itself) takes over. */
  gapBeforeNextText?: boolean;
  /** Stops the .jsonl tail loop (content streaming). */
  stopTail: (() => void) | null;
  /** The last text blocks ALREADY broadcast, so they are not offered again as
   *  a question's preface (see `isStalePreface`). Bounded: a preface can only
   *  describe a block still visible on screen, hence recent — keeping more
   *  would only raise the risk of a wrong match. */
  recentTexts: string[];
  /** Unsubscribes the current pilot's exit handler (so a restart can swap the
   *  pilot without the old handler tearing the session down). */
  pilotOff?: (() => void) | null;
  /** True while a restart is swapping the pilot in place — suppresses the old
   *  pilot's exit teardown. */
  restarting?: boolean;
  /** Isolated git worktree, when the session runs in one. */
  worktree: Worktree | null;
  /** Agent profile applied at spawn — re-applied on restart. This is the
   *  DESIRED one: `set-profile` without a restart changes it while the running
   *  process still carries the old one. */
  profile?: string | null;
  /** The profile the RUNNING process actually got. Differs from `profile` only
   *  between a stored change and the restart that applies it — that gap is what
   *  the UI shows as "(at next reload)". */
  appliedProfile?: string | null;
  /** Reclaim timer armed when no client is attached. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Token usage per assistant message id (final counts win), from the .jsonl. */
  usage: Map<string, TokenUsage>;
  /** Pending auto-retry of a turn that died on a transient API error. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Auto-retry attempts consumed for the current error streak (0–3). */
  retryCount: number;
  /** Transient error lines already on screen when the turn started. */
  errorsAtTurnStart: string[];
  /** Epoch ms when the in-flight turn started — lets clients (re)joining
   *  mid-turn show the real thinking time instead of restarting at zero. */
  turnStartedAt: number | null;
  /**
   * When the user pressed the interrupt key during this turn, or null.
   *
   * A turn normally ends on an absence of change, proved over two seconds. That
   * conservatism is right when we are guessing; it is pure waiting once the
   * user has explicitly asked the turn to stop. The flag lets `finishTurn` lower
   * the bar — never the check that the screen actually stopped working.
   */
  interruptedAt: number | null;
  /** How long the last finished turn took, so a client attaching between
   *  turns can restore the frozen time instead of showing a blank timer. */
  lastTurnMs: number | null;
  /** Experimental raw terminal: pilot detach fn + the clients streaming it.
   *  The pipe stays open while ≥1 client is attached, closed when the last
   *  leaves. */
  rawOff?: (() => void) | null;
  rawClients?: Set<WebSocket>;
}

/** Session-wide token totals, for the window-title counter. */
function tokenTotals(s: Live) {
  const t = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const u of s.usage.values()) {
    t.input += u.input;
    t.output += u.output;
    t.cacheCreation += u.cacheCreation;
    t.cacheRead += u.cacheRead;
  }
  return t;
}

/**
 * How long a session with no attached client is kept alive before being
 * reclaimed. Closing a tab or reloading detaches but does NOT kill the agent;
 * you reattach on return and the running turn continues. Set 0 to keep
 * sessions until the process exits or an explicit End.
 */
const IDLE_RECLAIM_MS = Number(process.env.SHADOK_IDLE_MIN ?? 60) * 60_000;

const sessions = new Map<string, Live>();

function broadcast(s: Live, msg: object, except?: WebSocket) {
  const data = JSON.stringify(msg);
  for (const c of s.clients) {
    if (c !== except && c.readyState === c.OPEN) c.send(data);
  }
}

/**
 * Re-spawns the agent in place, resuming the same session id, so it picks up
 * fresh env (newly-added secrets) or a freshly-changed profile. History is
 * preserved (resume reads the transcript); every attached client keeps its ref.
 * Shared by the `restart` message and by `set-profile` with `restart: true`.
 */
async function restartSession(s: Live): Promise<void> {
  s.restarting = true;
  // The raw pipe is bound to the pilot we're about to replace — close it;
  // clients re-attach on the next "ready" if the terminal is open.
  s.rawOff?.();
  s.rawOff = null;
  s.pilotOff?.();
  if (s.screenTimer) clearInterval(s.screenTimer);
  s.screenTimer = null;
  s.stopTail?.();
  s.stopTail = null;
  if (s.retryTimer) clearTimeout(s.retryTimer);
  s.retryTimer = null;
  // Clean /exit (not a hard kill) so claude releases the session lock
  // and `--resume` works; then make sure the tmux session is gone.
  await s.pilot.stop();
  if (USE_TMUX) {
    for (let i = 0; i < 30 && tmuxHasSession("sk-" + s.id); i++) await sleep(100);
    // A restart the user ASKED for must never degrade into a reattach.
    // `TmuxPilot.start()` adopts an existing pane by design — that is what makes
    // a session survive a server restart — so a pane that outlived the stop
    // would be inherited along with whatever wedged it, silently: same pane,
    // same stuck process, no error anywhere. This loop used to merely WATCH the
    // stop fail. Now it enforces the outcome.
    if (tmuxHasSession("sk-" + s.id)) {
      console.error(`[sk-${s.id}] restart: the pane outlived stop() — killing it before respawn`);
      tmuxKillSession("sk-" + s.id);
      for (let i = 0; i < 20 && tmuxHasSession("sk-" + s.id); i++) await sleep(100);
    }
  }
  s.busy = false;
  s.lastScreen = "";
  s.lastDialogKey = null;
  broadcast(s, { type: "working", startedAt: Date.now(), elapsedMs: 0 });
  // Resume only if there's a transcript; a never-used session has
  // nothing to resume (claude --resume would exit) — re-create it.
  const hasTranscript = fs.existsSync(sessionFilePath(s.cwd, s.id));
  // A restart respawns without passing through the `start` handler, so it is
  // its own chance to notice that the launcher has become the placeholder since
  // this session was created. Non-fatal: a restart that cannot re-resolve still
  // respawns on the last known path, which is what it did before.
  const claude = await ensureClaudeOnce();
  if (!claude.ok) console.error(`[sk-${s.id}] restart: ${claude.error}`);
  s.pilot = makePilot(s.id, s.cwd, hasTranscript ? ["--resume", s.id] : ["--session-id", s.id], s.profile);
  s.appliedProfile = s.profile;   // the new process carries the desired profile
  await attachPilot(s);
  s.restarting = false;
  // `lastTurnMs`, like the connect-path `ready`: the transient "working" above
  // started the client's turn timer, and this "ready" is what stops it — without
  // the last turn's duration to freeze onto, the counter kept ticking after the
  // reload instead of pausing.
  broadcast(s, {
    type: "ready",
    sessionId: s.id,
    preprompt: prepromptById.get(s.id) ?? [],
    cwd: s.cwd,
    branch: s.worktree?.branch ?? null,
    lastTurnMs: s.lastTurnMs,
  });
  broadcastProfile(s);            // the "at next reload" gap has just closed
  broadcast(s, { type: "screen", text: s.pilot.screen(), working: s.pilot.isWorking() });
}

/** Tells every attached client (other tabs, other devices) both the desired and
 *  the running profile — the pair is what lets the UI show "(at next reload)". */
function broadcastProfile(s: Live) {
  broadcast(s, { type: "profile", profile: s.profile ?? null, applied: s.appliedProfile ?? null });
}

function destroySession(s: Live) {
  prepromptById.delete(s.id);
  if (s.screenTimer) clearInterval(s.screenTimer);
  s.screenTimer = null;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = null;
  if (s.retryTimer) clearTimeout(s.retryTimer);
  s.retryTimer = null;
  s.stopTail?.();
  s.stopTail = null;
  // The session is over: its tail position has nothing left to resume.
  clearTailPos(sessionFilePath(s.cwd, s.id));
  s.pilot.kill();
  // Worktrees are durable: never auto-removed. They persist (with their
  // branch and any uncommitted changes) until an explicit merge/discard,
  // so no work is ever silently lost.
  sessions.delete(s.id);
}

/**
 * End a channel by id, whichever interface asked — works even when the session
 * isn't live (a dead/zombie channel after a crash): always drops it from the
 * registry and deletes its Telegram topic, and tears down the live session +
 * notifies clients if one exists. This is what makes ✕ / "End session" / `/end`
 * able to remove a channel that no longer has a running agent.
 */
async function endChannel(sessionId: string): Promise<boolean> {
  const ch = loadChannels().find((c) => c.sessionId === sessionId);
  // The home base is never deleted — see `isHomeChannel` for the two ways a
  // channel earns that, and why a DM binding is not one of them. The refusal is
  // RETURNED rather than swallowed: a caller that is told "ok" while nothing
  // happened drops the tab from its own list and the two views disagree.
  if (ch && isHomeChannel(ch)) return false;
  removeChannel(sessionId); // registry first, so the sync poll sees it gone
  if (ch?.telegram?.threadId) closeTelegramTopic(ch.telegram.chatId, ch.telegram.threadId);
  const s = sessions.get(sessionId);
  const worktreeBranch = s?.worktree?.branch ?? ch?.branch;
  const repo = s?.worktree?.repo ?? ch?.repo;
  if (s) {
    broadcast(s, { type: "stopped" });
    await s.pilot.stop().catch(() => {});
    destroySession(s);
  }
  // Prune the worktree: remove it if clean (an agent that did nothing / already
  // merged), keep it if there's uncommitted or unmerged work. Stops the empty-
  // worktree pile-up while never discarding real work.
  if (repo && worktreeBranch) {
    const outcome = pruneWorktree(repo, worktreeBranch);
    if (outcome !== "none") console.log(`worktree ${worktreeBranch}: ${outcome} on session end`);
  }
  return true;
}

function detach(ws: WebSocket, s: Live) {
  s.clients.delete(ws);
  // Drop this client from the raw terminal stream; close the pipe if it was the
  // last one attached.
  if (s.rawClients?.delete(ws) && s.rawClients.size === 0 && s.rawOff) {
    s.rawOff();
    s.rawOff = null;
  }
  if (s.clients.size !== 0) return;
  // No viewer attached: keep the agent running and reclaim only after a long
  // idle, so reloading or closing a tab never aborts work.
  if (IDLE_RECLAIM_MS <= 0) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.clients.size === 0) destroySession(s);
  }, IDLE_RECLAIM_MS);
}

/** `npm i -g @anthropic-ai/claude-code`, streamed to the server log. Rejects on a
 *  non-zero exit or a spawn error (e.g. no write permission on the global dir). */
function installClaudeCli(): Promise<void> {
  return new Promise((resolve, reject) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const p = spawnChild(npm, ["install", "-g", "@anthropic-ai/claude-code", "--no-audit", "--no-fund"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm exited with code ${code}`))));
  });
}

// The first spawn on a fresh machine used to fail with a bare `posix_spawnp
// failed` when the `claude` CLI wasn't installed. We now install it once, on
// demand, and only surface a clear error if that can't help. A FAILURE is never
// cached, so a manual install after a failed attempt is picked up next spawn —
// and a success is re-validated (below), because the path it holds rots.
let claudeReady: Promise<EnsureClaudeResult> | null = null;
function ensureClaudeOnce(revalidate = true): Promise<EnsureClaudeResult> {
  const cached = claudeReady;
  if (cached) {
    if (!revalidate) return cached;
    // A cached path ROTS. The claude-code postinstall unlinks bin/claude.exe
    // and relinks the native binary over it on every upgrade, so a path that
    // was fine an hour ago can be the 500-byte placeholder right now — and
    // caching "ok" across that window is exactly what would turn a window of
    // milliseconds into a permanently broken instance. Re-validating is a stat
    // plus at most a 512-byte read, on a path we already have: cheap enough to
    // pay per spawn, which is a human-scale event.
    return cached.then((r) => {
      if (r.ok && classifyBin(sampleBin(r.path)) === "usable") return r;
      if (claudeReady === cached) claudeReady = null;
      // Re-resolve ONCE and take that answer as it comes. Looping until the
      // path validates would spin forever on a launcher that keeps flipping,
      // which is the very state we are trying to report.
      return ensureClaudeOnce(false);
    });
  }
  const p = ensureClaude({
    // A short bounded retry, not a single look: the placeholder window is
    // transient, so failing hard on the first sample would report a healthy
    // install as broken. Nothing here runs at boot.
    find: () => findClaudeBinWithRetry(liveClaudeDeps()),
    install: installClaudeCli,
    notify: (line) => console.log(`[shadok-ai] ${line}`),
  });
  claudeReady = p;
  p.then((r) => {
    rememberClaudeBin(r.ok ? r.path : null);
    if (!r.ok && claudeReady === p) claudeReady = null;
  }).catch(() => { if (claudeReady === p) claudeReady = null; });
  return p;
}

async function createSession(
  id: string,
  cwd: string,
  args: string[],
  worktree: Worktree | null = null,
  profile: string | null = null,
): Promise<Live> {
  const pilot = makePilot(id, cwd, args, profile);
  // Resumed sessions start with what the transcript already consumed.
  const seededUsage = scanUsage(sessionFilePath(cwd, id));
  const contextWindow = windowForModel(sessionModelSetting(profile));
  const s: Live = {
    id,
    cwd,
    pilot,
    profile,
    appliedProfile: profile,   // the process we just spawned did receive it
    clients: new Set(),
    busy: false,
    lastPrompt: "",
    screenTimer: null,
    lastScreen: "",
    lastDialogKey: null,
    contextWindow,
    // A reattached session must show its bar at once, not only after the next
    // turn writes a usage record — so seed from the transcript's last message.
    contextPct: pctFromUsage([...seededUsage.values()].pop(), contextWindow),
    stopTail: null,
    recentTexts: [],
    lastTurnSilent: false,
    worktree,
    idleTimer: null,
    usage: seededUsage,
    retryTimer: null,
    retryCount: 0,
    errorsAtTurnStart: [],
    turnStartedAt: null,
    interruptedAt: null,
    lastTurnMs: null,
  };
  await attachPilot(s);
  return s;
}

/**
 * Wires a session's pilot: exit handling, content tail, screen watcher, and the
 * wait-until-up handshake. Split out of createSession so a restart can swap in a
 * fresh pilot (e.g. to pick up new env/secrets) on the SAME Live object — every
 * WS client keeps its reference, so nobody is disconnected.
 */
/**
 * (Re)start the content tail on the transcript this session should FOLLOW —
 * `tailId` when a fork was detected, else the session id. Restarting it (instead
 * of letting the tail's path-resolver swap files, which KEEPS the byte offset —
 * right for a moved-but-same transcript, wrong for a genuinely different one)
 * gives the new file its OWN startOffset. For the initial tail that is EOF (only
 * new turns stream; `loadHistory` replays the rest); on a fork-follow the caller
 * seeds the new file's position to 0 first, so its unseen backlog replays.
 */
function startContentTail(s: Live): void {
  s.stopTail?.();
  const cwd = s.cwd;
  const tid = () => s.tailId ?? s.id;
  s.stopTail = tailSession(sessionFilePath(cwd, tid()), (e) => {
    // Any content from the tracked transcript means it is alive: stamp it so the
    // fork detector only hunts when THIS file has actually gone silent.
    s.lastContentAt = Date.now();
    if (e.kind === "silent") {
      // The turn's answer was the placeholder. Recorded here because it is the
      // only place that still sees it — the tail drops the block itself.
      s.lastTurnSilent = true;
      return;
    }
    if (e.kind === "text") {
      s.lastTurnSilent = false; // a real block: this turn has something to say
      // Remember BEFORE broadcasting: a question can follow immediately, and
      // its preface must not repeat this block.
      s.recentTexts.push(e.text);
      if (s.recentTexts.length > 8) s.recentTexts.shift();
      // A hidden prompt (cron / notification) preceded this turn: its first text
      // opens a group boundary, same as a thinking block within the message
      // (`e.afterInternal`). Consume the flag so only the FIRST text is marked;
      // the rest of the turn is continuous.
      const afterInternal = e.afterInternal || s.gapBeforeNextText || undefined;
      s.gapBeforeNextText = false;
      // `at` = when the block was WRITTEN, not when it was read (see
      // TailEvent): the client shows it as is instead of dating everything on
      // reception.
      broadcast(s, { type: "stream-text", text: e.text, at: e.at, afterInternal });
    } else if (e.kind === "tool")
      broadcast(s, { type: "stream-tool", id: e.id, name: e.name, summary: e.summary });
    else if (e.kind === "usage") {
      s.usage.set(e.messageId, e.usage);
      broadcast(s, { type: "tokens", tokens: tokenTotals(s) });
      // Context fill comes from THIS message, not from the running totals: the
      // window holds one request's prompt, while the totals accumulate the whole
      // session and would climb past 100% on any long conversation.
      const pct = pctFromUsage(e.usage, s.contextWindow);
      if (pct !== null && pct !== s.contextPct) {
        s.contextPct = pct;
        broadcast(s, { type: "context", pct });
      }
    } else
      broadcast(s, {
        type: "stream-result",
        toolUseId: e.toolUseId,
        text: e.text,
        isError: e.isError,
      });
  }, 250, () => sessionFilePath(cwd, tid()));
}

/**
 * Follow the agent's ACTUAL transcript when Claude Code forks the session id — a
 * context overflow ("Prompt is too long") makes the live `claude` continue under
 * a NEW id, freezing the old transcript the tail reads (the chat stops updating
 * while the TUI is fine). We find the new file by its lineage root (the snake
 * `session_id` shared across the fork chain): the newest file in the same
 * directory whose root matches ours but whose own id differs — never a sibling
 * agent's, even when agents share a cwd. Cross-platform (transcript content, no
 * /proc). See docs/superpowers/specs/2026-08-26-follow-forked-transcript-design.md.
 */
/** How long the tracked transcript must be silent — WHILE the pane shows work —
 *  before we go looking for a fork. The gate is the safety mechanism: a healthy
 *  session (its file still growing) never hunts, so it can never mis-adopt a
 *  stale same-lineage file. It also matches the exact symptom (terminal busy,
 *  chat frozen) and keeps the scan off all but genuinely-stuck sessions. */
const FORK_STALL_MS = 30_000;

function maybeFollowFork(s: Live): void {
  // Only hunt when the file we tail has gone quiet while the agent is visibly
  // working — the fork's signature. Skip the scan entirely otherwise.
  if (!s.pilot.isWorking()) return;
  if (Date.now() - (s.lastContentAt ?? 0) < FORK_STALL_MS) return;
  const tailId = s.tailId ?? s.id;
  const myFile = sessionFilePath(s.cwd, tailId);
  // Lineage root: read once from the file we currently tail, then cache. The
  // original session's root is its own id, so `?? s.id` is the right fallback
  // when the file has no root record yet (a session that never took a turn).
  const myRoot = (s.rootId ??= rootIdOfFile(myFile) ?? s.id);
  const seen = (s.tailSeen ??= new Set([tailId]));
  const target = detectFork(myFile, tailId, myRoot, seen);
  if (!target) return;
  console.log(`[sk-${s.id.slice(0, 8)}] transcript forked → following ${target.slice(0, 8)} (context overflow)`);
  seen.add(tailId);
  s.tailId = target;
  // None of the new file was ever shown in chat (it is a different transcript),
  // so replay it from the start rather than from EOF.
  seedTailPos(sessionFilePath(s.cwd, target), 0);
  startContentTail(s);
  broadcast(s, {
    type: "stream-text",
    text: "— la session précédente était pleine ; le chat s'est reconnecté à la session en cours de l'agent —",
    at: Date.now(),
  });
}

async function attachPilot(s: Live): Promise<void> {
  const pilot = s.pilot;
  const { id, cwd } = s;
  s.pilotOff = pilot.onExit((code) => {
    if (s.restarting) return; // a restart is swapping the pilot; don't tear down
    broadcast(s, { type: "exited", code });
    // A failure must notify too. A lost run that says nothing is
    // indistinguishable from a run with nothing to say (invariant 15), and the
    // parent would otherwise wait forever for a child that is already gone.
    notifyParent(s, { kind: "exited" });
    destroySession(s);
  });
  pilot.start();
  // Start the stall clock now: a session reattached mid-work must not look
  // instantly "silent since epoch" and trip the fork detector before its tail
  // has had a chance to stream anything.
  s.lastContentAt = Date.now();
  // The ledger watermark comes back from disk when this agent has one: a `Live`
  // is rebuilt on every server restart (so on every auto-update) and whenever a
  // dormant channel is woken, and anchoring to the attach instant made the next
  // delta silently empty — which is where two thirds of the pushes went.
  // A session with NO record is genuinely new and still anchors to now, so a
  // fresh agent is not handed the whole table on its first prompt.
  s.ledgerSeenAt ??= seenFor(ledgerSeenFileFor(process.cwd()), s.id) ?? Date.now();
  // Stream authoritative content from the session transcript: each assistant
  // text/tool block is broadcast as soon as Claude Code writes it — complete,
  // never truncated, at message granularity.
  startContentTail(s);
  let settled = false;
  let forkTick = 0;
  s.screenTimer = setInterval(() => {
    if (pilot.hasExited) return;
    const scr = pilot.screen();
    if (scr !== s.lastScreen) {
      s.lastScreen = scr;
      broadcast(s, { type: "screen", text: scr, working: pilot.isWorking() });
      // A question that appeared without anyone calling `finishTurn`. Typing in
      // the terminal view writes straight to the pilot (`case "key"`), so no
      // handler ever ran the detection: the dialog existed on the screen only —
      // visible in the engine room, absent from the chat. Detecting on every
      // screen change closes that hole for `key` and for any future path that
      // bypasses `finishTurn`. `publishDialog` dedups, so a dialog sitting
      // there while the footer clock ticks is announced exactly once.
      if (settled && !s.busy) {
        const d = detectDialog(scr);
        if (d) publishDialog(s, d);
        else s.lastDialogKey = null;
      }
    }
    // Spontaneous resume: work restarting without a client prompt (e.g. a
    // background agent completing and waking the model). No handler called
    // finishTurn, so watch for it here and signal the turn like any other.
    if (settled && !s.busy && pilot.isWorking()) finishTurn(s).catch(() => {});
    // Every ~15 s (50 × 300 ms): if the pane's process moved to a different
    // transcript (Claude Code forked the session on a context overflow), follow
    // it so the chat doesn't freeze on the old, dead transcript.
    if (settled && ++forkTick % 50 === 0) maybeFollowFork(s);
  }, 300);

  // Ready as soon as the TUI is up: trust prompt, input line, or an
  // in-flight turn. A session reattached MID-WORK (tmux survives server
  // restarts, and turns can run for many minutes) must not block on idle —
  // the screen watcher above signals the running turn right after `settled`.
  const isUp = (scr: string) =>
    /do you trust the files/i.test(scr) || screenShowsWork(scr) || scr.includes("❯");
  let screen = await pilot.waitFor(isUp, { timeoutMs: 60_000 });
  if (/do you trust the files/i.test(screen)) {
    pilot.press("enter");
    screen = await pilot.waitFor(
      (scr) => screenShowsWork(scr) || scr.includes("❯"),
      { timeoutMs: 30_000 },
    );
  }
  // Resuming a large session shows a "resume from summary?" prompt. Keep the
  // FULL session as-is automatically (the machine may have slept mid-work; the
  // user wants their full context back, not a summary), unless disabled.
  if (process.env.SHADOK_RESUME_SUMMARY !== "1") {
    const rd = detectDialog(screen);
    const full = rd?.options.find((o) => /full session/i.test(o.label));
    if (full && /resum|summary/i.test(rd!.question)) {
      await selectOption(pilot, full.n);
      await pilot
        .waitFor((scr) => screenShowsWork(scr) || scr.includes("❯"), { timeoutMs: 30_000 })
        .catch(() => {});
    }
  }
  settled = true;
  sessions.set(id, s);
}

/**
 * The "working" message.
 *
 * It carries `elapsedMs` — HOW LONG the turn has been running — on top of
 * `startedAt`. The client anchors on the duration, never on the instant:
 * comparing a SERVER timestamp to a BROWSER `Date.now()` shifted the display by
 * the whole gap between the two clocks, and the cockpit is often watched from a
 * device other than the one hosting the server (a phone, a second laptop). A
 * browser running behind could even show a negative duration.
 */
function workingMessage(s: Live): { type: "working"; startedAt: number | null; elapsedMs: number } {
  const startedAt = s.turnStartedAt;
  return { type: "working", startedAt, elapsedMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0 };
}

/**
 * Waits for the current turn to finish and broadcasts the outcome. Content is
 * streamed separately by the transcript tail; here we only signal an
 * interactive dialog (turn stays suspended) or turn completion.
 */
/**
 * How long the screen must hold still to end a turn the user INTERRUPTED.
 *
 * Short on purpose: the end state is not being inferred, it was requested. Not
 * zero either — the TUI still repaints the interruption, and calling the turn
 * on a single poll would race that repaint.
 */
const INTERRUPTED_STABLE_MS = 400;

async function finishTurn(s: Live) {
  s.busy = true;
  // Turn found already running (not started by us): typically after a server
  // restart, the tmux agent having carried on without it. `turnStartedAt` lives
  // in memory, so restarting from `now` reset the stopwatch while the agent had
  // been thinking for ten minutes; the transcript, though, survived.
  if (!s.turnStartedAt) s.turnStartedAt = resumedTurnStart(Date.now(), lastPromptAt(s.cwd, s.id));
  s.errorsAtTurnStart = findTransientErrors(s.pilot.screen());
  broadcast(s, workingMessage(s));
  try {
    // Read on every poll, so an interrupt arriving mid-wait takes effect at
    // once instead of at the next turn.
    await s.pilot.waitForIdle({
      stableMs: () => (s.interruptedAt ? INTERRUPTED_STABLE_MS : 2000),
      timeoutMs: 900_000,
    });
    // A MULTI-QUESTION AskUserQuestion ends on a recap page ("Ready to submit
    // your answers? · Submit answers / Cancel"). That is NOT a real question —
    // every question was already answered one by one — and it mis-parses as a
    // multi-select dialog. Auto-confirm it (Enter defaults to "Submit answers")
    // instead of surfacing a redundant, mis-rendered dialog.
    if (detectDialog(s.pilot.screen()) && SUBMIT_PAGE.test(s.pilot.screen())) {
      s.pilot.press("enter");
      await s.pilot.waitForIdle({ stableMs: 1500, timeoutMs: 120_000 }).catch(() => {});
    }
    const dialog = detectDialog(s.pilot.screen());
    if (dialog) {
      // finishTurn is only ever reached by a DELIBERATE transition — a prompt
      // submitted, or a dialog answered that then ran a turn. So a dialog on
      // screen now is a FRESH ask, even when its text is byte-for-byte the one
      // just answered: two back-to-back CLI permission prompts ("Do you want to
      // proceed? Yes/No") share a dialogKey, and so do two AskUserQuestions with
      // the same options. Clearing the dedup key here lets publishDialog surface
      // the second one instead of swallowing it as a repaint, which left the
      // session wedged on an invisible question. The watcher (invariant 23)
      // resumes deduping on the key publishDialog sets, so no double-broadcast.
      s.lastDialogKey = null;
      publishDialog(s, dialog);
    } else {
      // Forget the answered question: asking the SAME one again later must
      // still reach the clients, and the dedup key would otherwise swallow it.
      s.lastDialogKey = null;
      broadcast(s, { type: "turn-done", sessionId: s.id });
      maybeScheduleRetry(s);
      // As a CHILD: tell whoever launched this agent that it is done, with its
      // own last block as the summary — what it wrote to be read.
      notifyParent(s, { kind: "done", summary: s.recentTexts[s.recentTexts.length - 1], silent: s.lastTurnSilent });
    }
  } finally {
    s.busy = false;
    s.interruptedAt = null;
    // Remember how long it took: a dialog suspends the turn and a completion
    // ends it, but both freeze the client's timer, so both are worth keeping.
    if (s.turnStartedAt) s.lastTurnMs = Date.now() - s.turnStartedAt;
    s.turnStartedAt = null;
    // As a PARENT: anything that piled up while this session was working goes
    // out now. It has to be here, after `busy` is cleared — a prompt sent
    // during a turn is exactly what the queue exists to avoid.
    flushParentInbox(s.id);
  }
}

async function selectOption(pilot: Pilot, n: number): Promise<void> {
  if (await moveToOption(pilot, n)) {
    pilot.press("enter");
    return;
  }
  pilot.write(String(n)); // fallback: older digit-selectable dialogs
}

/**
 * Check/uncheck option `n` of a multi-select dialog.
 *
 * We do NOT type the digit: these dialogs ignore it entirely (verified on
 * screen — the box stayed `[ ]` and the cursor did not move). Their footer says
 * "Enter to select · ↑/↓ to navigate", but Enter checks nothing either: SPACE
 * is what toggles the box, once the arrows have brought the cursor onto it. So
 * a digit-based `toggle` did nothing, and the Submit that followed went out
 * with zero boxes checked — hence an "empty answer".
 */
async function toggleOption(pilot: Pilot, n: number): Promise<void> {
  if (await moveToOption(pilot, n)) pilot.write(" ");
}

/** Pattern of the summary page reached with Tab from a multi-select. */
const SUBMIT_PAGE = /ready to submit|submit answers/i;

/**
 * The `dialog` message broadcast to clients, with its **preface**: the text the
 * agent wrote just before asking its question.
 *
 * Why read it off the screen rather than from the transcript: the .jsonl only
 * writes an assistant message once FINISHED, hence with its `tool_use`
 * resolved — and `AskUserQuestion` only resolves when the user answers. The
 * text preceding the question would therefore arrive AFTER it. The screen
 * already has it.
 *
 * Provisional by construction (unwrapped, truncated if the screen scrolled):
 * the client replaces it with the authoritative block from the tail. The web
 * ignores it, it already has its grey bubble; the Telegram bridge is what uses
 * it.
 */
function dialogMessage(s: Live, d: TuiDialog): object {
  const preface = extractLiveText(s.pilot.screen());
  // The screen keeps the previous turn's answer until the new turn writes
  // anything: without this filter, every question was preceded by a duplicate
  // of the previous answer, which nothing ever came to repair.
  const fresh = preface && !isStalePreface(preface, s.recentTexts) ? preface : "";
  return { type: "dialog", ...d, ...(fresh ? { preface: fresh } : {}) };
}

/**
 * Surfaces a dialog already on screen when a client connects — e.g. the
 * "resume from summary" or permission prompt that appears at startup/resume.
 * Without this, a resumed session waiting on such a dialog looks frozen.
 */
function sendPendingDialog(s: Live, send: (msg: object) => void) {
  const d = detectDialog(s.pilot.screen());
  // The resume-from-summary prompt is auto-answered at startup; don't surface
  // it (a stale copy can otherwise flash before the auto-answer lands).
  if (!d || isResumeSummaryDialog(d)) return;
  send(dialogMessage(s, d));
}

/**
 * Broadcasts a dialog to every client, at most once per distinct question.
 *
 * Detection used to live ONLY in `finishTurn`, i.e. only on the paths that
 * submit something on the user's behalf. Raw keystrokes from the terminal view
 * (`case "key"`) don't go through it, so a question asked after typing there was
 * never announced: it sat on the screen, visible in the engine room and nowhere
 * else. The screen watcher now detects too, which covers `key` and anything
 * else that ever bypasses `finishTurn` — the dedup key is what makes that
 * affordable three times a second.
 */
function publishDialog(s: Live, d: TuiDialog): void {
  if (isResumeSummaryDialog(d)) return;
  // Never surface the multi-question recap ("Ready to submit your answers?").
  // It is not a real question (every question was answered one by one), it
  // mis-parses as a multi-select, and `finishTurn` auto-confirms it. Left to
  // the screen watcher, it would flash a broken, disabled dialog before the
  // auto-submit lands.
  if (SUBMIT_PAGE.test(s.pilot.screen())) return;
  const key = dialogKey(d);
  if (key === s.lastDialogKey) return;
  s.lastDialogKey = key;
  broadcast(s, dialogMessage(s, d));
  // A child blocked on a question is the deadlock this whole thing exists to
  // break: its turn is suspended, and its parent believes it is still working.
  // Hooking HERE covers every path — including raw `key` input — because this
  // is the single funnel for dialogs (invariant 19). The dedup above is what
  // keeps that affordable: the screen watcher runs several times a second.
  notifyParent(s, {
    kind: "dialog",
    question: d.question,
    options: d.options.map((o) => o.label),
  });
}

/** Cancels a pending auto-retry (user took over, or session ends). */
function clearRetry(s: Live, notify = false) {
  if (!s.retryTimer) return;
  clearTimeout(s.retryTimer);
  s.retryTimer = null;
  if (notify) broadcast(s, { type: "auto-retry-cancelled" });
}

/**
 * How long between pace re-checks during a hold. Aligned with usage.ts's cache
 * TTL: the waiting loop issues no request to the API.
 */
const PACE_RECHECK_MS = 60_000;

/**
 * If the turn died on a NEW transient API error (529 Overloaded, 5xx,
 * timeout…), schedules an automatic `continue` — 15 s, then 30 s, then
 * 60 s. Cancelled if the user takes over; gives up after 3 attempts.
 */
function maybeScheduleRetry(s: Live) {
  if (s.retryTimer) return; // one pending retry at a time
  const fresh = newTransientErrors(
    s.errorsAtTurnStart,
    findTransientErrors(s.pilot.screen()),
  );
  if (fresh.length === 0) {
    s.retryCount = 0; // clean turn: the error streak is over
    return;
  }
  if (s.retryCount >= RETRY_DELAYS_MS.length) {
    broadcast(s, { type: "auto-retry-gave-up", attempts: s.retryCount });
    s.retryCount = 0;
    return;
  }
  const delayMs = RETRY_DELAYS_MS[s.retryCount];
  s.retryCount++;
  broadcast(s, {
    type: "auto-retry",
    delayMs,
    attempt: s.retryCount,
    max: RETRY_DELAYS_MS.length,
  });
  // Set when the retry has been parked on a pace overrun, so the resume is
  // announced only to clients that were told about the pause.
  let held = false;
  const fire = async () => {
    // Keep s.retryTimer pointing at this chain across the await below: it is
    // both the "a retry is pending" guard for maybeScheduleRetry and this
    // chain's identity token.
    const mine = s.retryTimer;
    if (s.pilot.hasExited || s.busy) {
      s.retryTimer = null;
      return;
    }
    // Never forced: an automatic turn must not spend quota the user is being
    // asked to hold back on. Park and re-test until the pace comes back down.
    // A failed usage read must never block: paceBlock(null, …) reports
    // "not blocked", so a rejection degrades to letting the retry through
    // rather than wedging the chain on an unhandled rejection.
    const verdict = paceBlock(await getUsage().catch(() => null), Date.now());
    // A takeover (or teardown) replaced or cleared our timer while we were
    // fetching: this chain is no longer the live one, so stand down — and
    // leave s.retryTimer alone, it now belongs to whoever replaced us.
    if (s.retryTimer !== mine) return;
    // Still ours, but the session died or a turn started on its own while we
    // were fetching (the screen watcher sets s.busy without touching
    // s.retryTimer). Submitting `continue` now would spend quota on an
    // already-running turn. Release our own already-fired handle, otherwise
    // maybeScheduleRetry's `if (s.retryTimer) return` guard stays wedged for
    // this session until something else happens to call clearRetry.
    if (s.pilot.hasExited || s.busy) {
      s.retryTimer = null;
      return;
    }
    if (verdict.blocked) {
      if (!held) {
        held = true;
        broadcast(s, { type: "pace-hold", reason: verdict.reason });
      }
      s.retryTimer = setTimeout(fire, PACE_RECHECK_MS);
      return;
    }
    s.retryTimer = null;
    if (held) broadcast(s, { type: "pace-resumed" });
    broadcast(s, { type: "prompt-echo", text: "continue", auto: true });
    s.busy = true;
    s.turnStartedAt = Date.now();
    broadcast(s, workingMessage(s));
    try {
      await s.pilot.submit("continue");
    } catch {
      return; // TUI unreachable: give the user back the controls
    } finally {
      s.busy = false;
    }
    await finishTurn(s).catch(() => {});
  };
  s.retryTimer = setTimeout(fire, delayMs);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  // Who is on the other end, resolved ONCE at connect. A browser must not be
  // able to claim someone else's name by editing a frame, so THIS — not
  // `msg.from` — is what a web prompt is attributed to.
  const me = currentAccount(req);
  let session: Live | null = null;
  // Where does this client come from? Declared at `start` (web, cron, telegram,
  // cli…), it travels with the prompt echo: other clients must be able to SAY
  // who spoke. Without it, a cron firing looks like a human message.
  let origin: string | undefined;

  const send = (msg: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  // `code` is optional and purely additive: it lets a machine client (the cron
  // driver) tell "the session is busy" — a transient miss worth replaying —
  // apart from any other refusal, without matching on the message text.
  const fail = (message: string, code?: string) => send({ type: "error", message, ...(code ? { code } : {}) });

  // Announce the running version on connect. The client remembers the first
  // one it sees and reloads if a later (re)connect reports a different one —
  // so a server updated underneath it refreshes the page automatically.
  send(versionMessage());

  ws.on("close", () => {
    if (session) detach(ws, session);
    session = null;
  });

  ws.on("message", async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return fail("unreadable message");
    }

    try {
      // Any user takeover cancels a pending auto-retry and ends the streak.
      // "prompt" is settled inside its own case instead: a prompt refused on
      // pace grounds sends nothing, so it must not count as a takeover — it
      // would silently kill the pace pause it was just told about.
      if (
        session &&
        ["choose", "toggle", "freetext", "confirm", "key"].includes(msg.type)
      ) {
        clearRetry(session, true);
        session.retryCount = 0;
      }
      switch (msg.type) {
        case "start": {
          if (session) return fail("session already started");
          // Refusing here is what actually prevents zombies. The historical
          // failure was never "the login was missing" — it was "an agent was
          // allowed to start without one", and then sat on the first-run screen
          // for a day. `code` lets a machine client classify the refusal
          // without matching on message text (same contract as "busy").
          // Only a state we OBSERVED refuses a spawn. A probe that failed
          // ("unknown") means we could not look, not that the instance is
          // signed out — punishing the user for our own flakiness would block
          // an agent on a machine that is perfectly fine. The seeding already
          // removed the silent-zombie failure this guard was protecting
          // against, and an agent spawned without credentials now fails loudly.
          // Install the `claude` CLI first if it's missing: otherwise the auth
          // probe below (it runs `claude auth status`) can't run and reads as
          // "unknown", and the spawn itself would throw "posix_spawnp failed".
          const claude = await ensureClaudeOnce();
          if (!claude.ok) return fail(claude.error);
          const auth = await authStatus();
          if (auth.state === "unknown")
            console.log(`auth: could not verify sign-in state, allowing the spawn anyway`);
          if (auth.state === "signed-out") {
            // Telling the user is the whole point: a cron refused at 4am must
            // not be discovered a day later. Deduplicated inside, so a
            // five-minute cron does not turn one sign-out into a flood.
            announceLoggedOut();
            return fail(
              "this shadok-ai instance is not signed in to Claude — sign in from the cockpit",
              "logged-out",
            );
          }
          if (typeof msg.origin === "string") origin = msg.origin.slice(0, 16);
          const cwd = msg.cwd?.trim() || process.cwd();
          // Deterministic id: enforced with --session-id for a new session,
          // known for a resume. NEVER derive it from the most recent file
          // in the directory — with several channels in the same directory
          // they would all converge to the same session.
          let id: string;
          const args: string[] = [];
          let resumed = false;
          if (msg.resume) {
            id = msg.resume;
            args.push("--resume", id);
            resumed = true;
          } else if (msg.continue) {
            const found = findSessionId(cwd);
            if (found) {
              id = found;
              args.push("--resume", id);
              resumed = true;
            } else {
              // Nothing to resume in this directory: new session.
              id = randomUUID();
              args.push("--session-id", id);
            }
          } else {
            id = randomUUID();
            args.push("--session-id", id);
          }

          // Isolation: run a NEW session inside a fresh git worktree so the
          // agent's edits stay contained until the user merges them.
          let worktree: Worktree | null = null;
          // A RESUME asks the registry where this session lives, and prefers its
          // answer to anything the caller sent. The caller may be the browser, a
          // cron, the Telegram bridge or a future webhook; each used to derive
          // the directory on its own, and each got it wrong once. `loadHistory`
          // is keyed by the cwd, so the cost of guessing is the entire history.
          // A NEW session has nothing to resolve — `cwd` is all there is.
          const target = resumed
            ? resumeTarget(loadChannels(), id, { cwd: msg.cwd, branch: msg.branch, repo: msg.repo }, process.cwd())
            : null;
          let effectiveCwd = target?.cwd ?? cwd;
          // Resume: a reattached tmux agent knows its own cwd (e.g. a worktree
          // path the client didn't supply — the Telegram bridge only passes the
          // repo root). Trust the live pane so history and the transcript tail
          // resolve to the right directory (invariant: cwd ↔ history).
          if (resumed && USE_TMUX && tmuxHasSession("sk-" + id)) {
            const paneCwd = tmuxPaneCwd("sk-" + id);
            if (paneCwd && fs.existsSync(paneCwd)) effectiveCwd = paneCwd;
          }
          if (msg.worktree && !resumed && isGitRepo(cwd)) {
            try {
              worktree = createWorktree(cwd, id.slice(0, 8));
              effectiveCwd = worktree.path;
            } catch (e) {
              return fail(
                "worktree creation failed: " + (e instanceof Error ? e.message : String(e)),
              );
            }
          }

          // Reopen: if resuming into a worktree whose checkout was reclaimed,
          // recreate it from its branch so the past session can continue.
          if (target?.branch && target?.repo && !fs.existsSync(effectiveCwd)) {
            ensureWorktreeCheckout(target.repo, target.branch, effectiveCwd);
          }

          // Guard against a vanished directory (e.g. a restored channel whose
          // worktree was removed): spawning claude there would exit instantly
          // with a cryptic error. Signal it clearly so the client can drop it.
          if (!fs.existsSync(effectiveCwd)) {
            return send({
              type: "gone",
              sessionId: id,
              message: "working directory no longer exists: " + effectiveCwd,
            });
          }

          const existing = sessions.get(id);
          if (existing && !existing.pilot.hasExited) {
            // Session already piloted: attach to it (shared process). Cancel
            // any pending reclaim — a viewer is back.
            session = existing;
            if (session.idleTimer) {
              clearTimeout(session.idleTimer);
              session.idleTimer = null;
            }
            session.clients.add(ws);
            const turns = loadHistory(session.cwd, id);
            if (turns.length) send({ type: "history", turns });
            send({
              type: "ready",
              sessionId: id,
              preprompt: prepromptById.get(id) ?? [],
              cwd: session.cwd,
              lastTurnMs: session.lastTurnMs,
            });
            // `branch` is only ASSERTED, never cleared: see the note on the
            // resume upsert below — writing null here erases the channel's
            // branch, and with it the ability to recreate its checkout.
            upsertChannel({
              sessionId: id,
              cwd: session.cwd,
              ...(session.worktree ? { branch: session.worktree.branch } : {}),
            });
            send({ type: "tokens", tokens: tokenTotals(session) });
            send({ type: "profile", profile: session.profile ?? null, applied: session.appliedProfile ?? null });
            if (session.contextPct !== null) send({ type: "context", pct: session.contextPct });
            send({
              type: "screen",
              text: session.pilot.screen(),
              working: session.pilot.isWorking(),
            });
            if (session.busy)
              send(workingMessage(session));
            sendPendingDialog(session, send);
            break;
          }

          // Profile: the one the channel already carries when resuming, else the
          // one requested — so guardrails/role/secrets survive resume & restart.
          // The `?? msg.profile` fallback matters when a session is re-created
          // for an existing Telegram topic (new id, so the registry lookup by
          // that id is empty): the bridge passes the topic's channel profile, and
          // it gets re-persisted below — so a channel never silently loses its
          // profile (which would leave its cron scripts without secrets).
          let profile: string | null = msg.profile ?? null;
          if (resumed) {
            const stored = loadChannels().find((c) => c.sessionId === id)?.profile;
            if (stored != null) profile = stored; // the channel's own profile wins on resume
          }
          // Who launched this agent. Validated exactly like `set-parent` — a
          // cycle costs the same either way — but a refusal here only DROPS the
          // link instead of failing the start: the agent itself is fine, and
          // killing a spawn over a bad link would be a worse outcome than one
          // that reports to nobody. Logged so it isn't a silent loss.
          let parentAtStart: string | null | undefined;
          if (msg.parent !== undefined) {
            const refusal = linkRefusal(loadChannels(), id, msg.parent ?? null);
            if (refusal) console.log(`agent: ${id.slice(0, 8)} parent link refused (${refusal})`);
            else parentAtStart = msg.parent ?? null;
          }
          session = await createSession(id, effectiveCwd, args, worktree, profile);
          session.clients.add(ws);
          if (resumed) {
            const turns = loadHistory(effectiveCwd, id);
            if (turns.length) send({ type: "history", turns });
          }
          send({
            type: "ready",
            sessionId: id,
            preprompt: prepromptById.get(id) ?? [],
            cwd: effectiveCwd,
            branch: worktree?.branch ?? null,
          });
          upsertChannel({
            sessionId: id,
            cwd: effectiveCwd,
            // A RESUME has no `worktree` object even when the session lives in
            // one (it's only built when creating a checkout), so a `null` here
            // erased the branch recorded at creation — on the very first resume.
            // `upsertInto` skips undefined, so omitting the key keeps the stored
            // value; this is how `repo` already behaves (never rewritten). The
            // branch is what lets a reclaimed checkout be recreated later.
            //
            // `repo` is asserted here for the same reason, and it is NOT always
            // the launch directory: the "Tweak Shadok-AI" agent runs in a
            // worktree of shadok-ai's own clone. The client used to fabricate
            // `repo: serverCwd` for every channel, which was accidentally right
            // only while every worktree came from the launch repo — and
            // `ensureWorktreeCheckout` would then hunt the branch in the wrong
            // repository. The session's own worktree is the only source of truth.
            ...(worktree ? { branch: worktree.branch, repo: worktree.repo } : {}),
            profile,
            // The form's choice, recorded as soon as we're `ready` — that's
            // where the Telegram loop reads it. Absent (a client that ignores
            // the field) → decide nothing, and `isMirrored` falls back to the
            // binding.
            ...(typeof msg.mirror === "boolean" ? { mirror: msg.mirror } : {}),
            // Who launched this agent, sent by pilotctl from its own
            // SHADOK_SESSION_ID. ASSERT-only, like `branch` and `repo`: a
            // client that omits the key must not erase a link that already
            // exists. Validated for the same reasons `set-parent` validates —
            // a cycle here would be just as expensive.
            ...(parentAtStart !== undefined ? { parent: parentAtStart } : {}),
          });
          send({ type: "tokens", tokens: tokenTotals(session) });
          send({ type: "profile", profile: session.profile ?? null, applied: session.appliedProfile ?? null });
            if (session.contextPct !== null) send({ type: "context", pct: session.contextPct });
          sendPendingDialog(session, send);
          break;
        }

        case "prompt": {
          if (!session) return fail("no session started");
          if (session.busy) return fail("a response is already in progress", "busy");
          const text = msg.text.trim();
          if (!text) return;
          // The Telegram bridge is trusted to name its sender — it knows it. A
          // browser is not: for a web client the SESSION decides, and whatever
          // `from` the frame carried is discarded.
          const author = promptAuthor(origin, me?.name, msg.from);
          // Above the ideal pace, a prompt needs an explicit second click. The
          // check lives here because this is the single door every user prompt
          // goes through — including the pilotctl thin client.
          if (!msg.force) {
            const verdict = paceBlock(await getUsage(), Date.now());
            if (verdict.blocked) return send({ type: "pace-blocked", reason: verdict.reason, text });
            // The busy test above is now stale: a parked fire() (or another
            // client's prompt) can have claimed the session while we awaited
            // getUsage(). Submitting now would interleave two texts into one
            // TUI. Mirrors the re-check fire() does after its own await.
            if (session.busy) return fail("a response is already in progress", "busy");
          }
          // Getting here means the prompt is really being sent — that is the
          // takeover. A pending auto-retry (or pace pause) gives way to it.
          clearRetry(session, true);
          session.retryCount = 0;
          session.lastPrompt = text;
          // The session's other clients see the prompt arrive — except a cron:
          // that is not someone speaking, and its text (the prompt PLUS its
          // guard's dump) drowned the answer in both interfaces. The mark in
          // the content gives the same hiding on replay.
          if (origin !== "cron") {
            // A visible prompt breaks the group by itself (its bubble sits
            // between the turns), and clears any stale gap left by a silent cron
            // so the answer to a human is never wrongly detached.
            session.gapBeforeNextText = false;
            broadcast(
              session,
              { type: "prompt-echo", text, ...(origin ? { origin } : {}), ...(author ? { from: author } : {}) },
              ws,
            );
          } else {
            // A cron / notification is hidden: no echo, so the next streamed
            // text would glue onto the previous turn. Flag it for the tail.
            session.gapBeforeNextText = true;
          }
          session.busy = true;
          session.turnStartedAt = Date.now();
          broadcast(session, workingMessage(session));
          try {
            // A HUMAN prompt (web/telegram/cli) gets a context header — platform,
            // time, and sender when known — so the agent knows who is talking and
            // when. Only the TUI (and thus the transcript) receives it; the echo
            // above stays clean, and loadHistory strips the header on replay.
            // Cron/agent prompts carry their own mark and are not "someone
            // speaking", so they get no header.
            let submitText = text;
            if (origin === "web" || origin === "telegram" || origin === "cli") {
              submitText = markPromptMeta(text, promptMetaHeader(origin, new Date(), author, defaultTimeZone()));
            }
            // Push the ledger DELTA ahead of the message: rows changed since this
            // agent last saw the ledger, so it learns what siblings resolved /
            // decided in near-real-time. It rides ahead of ANY prompt that starts
            // a turn — human, cron, or an agent notification — because an
            // autonomous cron benefits from world-state awareness as much as a
            // human turn does (a monitoring cron reporting an issue a sibling
            // just fixed is the very silo this closes). Gated by the reflex
            // toggle; stripped from the display, and stripped before the
            // cron/agent mark is classified so a cron prompt stays hidden.
            // Advancing the watermark whether or not there was a delta keeps it
            // truthful: by now the agent has seen everything up to this moment.
            // But only ONCE THE SUBMIT LANDED, and persisted with it — advancing
            // first meant a submit that threw (a wedged screen, invariant 23)
            // burned the block for good, and keeping the mark only in memory
            // meant the next restart burned it too.
            let ledgerSeen: number | null = null;
            if (ledgerEnabled) {
              const { rows, total } = deltaSince(
                loadLedger(ledgerFileFor(process.cwd())),
                session.ledgerSeenAt ?? 0,
                LEDGER_PUSH_CAP,
              );
              ledgerSeen = Date.now();
              if (rows.length) submitText = markLedgerBlock(submitText, formatLedgerBlock(rows, total));
            }
            await session.pilot.submit(submitText);
            if (ledgerSeen !== null) {
              session.ledgerSeenAt = ledgerSeen;
              // The live channel list prunes the watermarks of agents that are
              // gone; the one being written is kept whatever the list says.
              recordSeen(
                ledgerSeenFileFor(process.cwd()),
                session.id,
                ledgerSeen,
                new Set(loadChannels().map((c) => c.sessionId)),
              );
            }
          } finally {
            session.busy = false;
          }
          await finishTurn(session);
          break;
        }

        case "choose": {
          // Single select. Preview-style dialogs ("Enter to select · ↑/↓ to
          // navigate") ignore digit keys, so navigate the ❯ cursor to the
          // target option with arrows, then Enter (works for all variants).
          if (!session) return fail("no session started");
          // You can only answer a dialog that's actually on screen. If it's not,
          // the keyboard is stale (the session moved past it) or a turn is
          // running — either way there's nothing to select here.
          if (!detectDialog(session.pilot.screen()))
            return fail(session.busy ? "a response is already in progress" : "this dialog is no longer active");
          await selectOption(session.pilot, msg.n);
          await sleep(500);
          await finishTurn(session);
          break;
        }

        case "toggle": {
          // Multi-select: toggle the checkbox then rebroadcast the state.
          if (!session) return fail("no session started");
          if (!detectDialog(session.pilot.screen()))
            return fail(session.busy ? "a response is already in progress" : "this dialog is no longer active");
          await toggleOption(session.pilot, msg.n);
          await sleep(500);
          const d = detectDialog(session.pilot.screen());
          if (d) broadcast(session, dialogMessage(session, d));
          else await finishTurn(session);
          break;
        }

        case "freetext": {
          // "Type something" option: digit → paste the text → Enter.
          if (!session) return fail("no session started");
          if (!detectDialog(session.pilot.screen()))
            return fail(session.busy ? "a response is already in progress" : "this dialog is no longer active");
          const t = msg.text.trim();
          if (!t) return;
          session.pilot.write(String(msg.n));
          await sleep(700);
          session.pilot.write(`\x1b[200~${t}\x1b[201~`);
          await sleep(400);
          session.pilot.press("enter");
          await sleep(600);
          const d = detectDialog(session.pilot.screen());
          if (d) broadcast(session, dialogMessage(session, d));
          else await finishTurn(session);
          break;
        }

        case "confirm": {
          // Multi-select: commit the checkboxes with Tab, then submit.
          if (!session) return fail("no session started");
          const before = detectDialog(session.pilot.screen());
          if (!before)
            return fail(session.busy ? "a response is already in progress" : "this dialog is no longer active");
          // Tab leaves this multi-select question. In a STANDALONE question it
          // opens the recap page ("Ready to submit your answers?"); in a
          // MULTI-QUESTION form (a "← ☐ Q1 ☐ Q2 ✔ Submit →" tab bar) it moves to
          // the NEXT question instead. The old code pressed Enter unconditionally
          // — in the multi-question case that Enter answered the next question
          // with its default (silently, wrongly), corrupting the form. Wait for
          // whichever screen Tab produced, then decide.
          session.pilot.press("tab");
          await session.pilot
            .waitFor(
              (scr) => SUBMIT_PAGE.test(scr) || (detectDialog(scr)?.question ?? before.question) !== before.question,
              { timeoutMs: 5000 },
            )
            .catch(() => {}); // neither settled in time: fall through and inspect
          await sleep(300);
          const scr = session.pilot.screen();
          const next = detectDialog(scr);
          if (SUBMIT_PAGE.test(scr) || !next) {
            // The recap/submit page (this was the last question), or the form is
            // gone: let finishTurn drive it — it auto-confirms the recap.
            await finishTurn(session);
          } else {
            // Tab landed on a FURTHER question — hand it back to the user to
            // answer rather than auto-picking its default with Enter.
            publishDialog(session, next);
          }
          break;
        }

        case "key": {
          // Manual keystroke from the terminal view (dialogs, menus…).
          if (!session) return fail("no session started");
          const named = [
            "enter",
            "escape",
            "up",
            "down",
            "left",
            "right",
            "tab",
            "ctrl-c",
          ] as const;
          if ((named as readonly string[]).includes(msg.key)) {
            // An interrupt during a turn is a signal WE emitted: from here on
            // the end state is known, so `finishTurn` may stop proving it the
            // slow way. Only while busy — an escape at rest ends no turn.
            if ((msg.key === "escape" || msg.key === "ctrl-c") && session.busy) {
              session.interruptedAt = Date.now();
            }
            session.pilot.press(msg.key as (typeof named)[number]);
          } else if (msg.key.length === 1) {
            session.pilot.write(msg.key);
          }
          break;
        }

        // ── Experimental raw interactive terminal (tmux transport only) ──
        case "term-attach": {
          if (!session) return fail("no session started");
          const s = session;
          if (!(s.pilot instanceof TmuxPilot)) return fail("interactive terminal needs the tmux transport");
          s.rawClients ??= new Set();
          s.rawClients.add(ws);
          // Sizing is driven SOLELY by the client: it fit()s xterm to the panel
          // and sends term-resize, which resizes the pane to the EXACT same
          // cols/rows. We must NOT push a pane size back here — it raced with the
          // client's fit and left xterm one column off from the pane, so every
          // line's first char landed at the far edge (garbled). The resize also
          // forces a full repaint (no capture-pane seed needed).
          // Open the pipe once, on the first attached client.
          if (!s.rawOff) {
            s.rawOff = s.pilot.attachRaw((chunk) => {
              const frame = JSON.stringify({ type: "term-data", data: chunk.toString("base64") });
              for (const c of s.rawClients ?? []) if (c.readyState === c.OPEN) c.send(frame);
            });
          }
          break;
        }
        case "term-input": {
          if (!session || !(session.pilot instanceof TmuxPilot)) return;
          if (typeof msg.data === "string") session.pilot.sendRaw(Buffer.from(msg.data, "base64"));
          break;
        }
        case "term-resize": {
          // Fit the pane to the browser terminal so the full-screen view fills.
          // Original size is remembered and restored when the pipe detaches.
          if (!session || !(session.pilot instanceof TmuxPilot)) return;
          if (typeof msg.cols === "number" && typeof msg.rows === "number")
            session.pilot.resizeWindow(msg.cols, msg.rows);
          break;
        }
        case "term-detach": {
          if (!session) return;
          session.rawClients?.delete(ws);
          if (session.rawClients && session.rawClients.size === 0 && session.rawOff) {
            session.rawOff();
            session.rawOff = null;
          }
          break;
        }

        case "settle": {
          // After a manual intervention: wait for the turn to finish.
          if (!session || session.busy) return;
          await finishTurn(session);
          break;
        }

        case "restart": {
          if (!session) return fail("no session started");
          await restartSession(session);
          break;
        }
        case "set-profile": {
          // Changing what an agent IS (role, guardrails, secrets, model) after
          // the fact. `profile` is SERVER_OWNED on the channel, so a browser PUT
          // can't touch it — this is the only legitimate path.
          if (!session) return fail("no session started");
          const s = session;
          const name = msg.profile ?? null;
          // Refuse an unknown name rather than silently spawning bare: a typo
          // would strip the agent of its guardrails without anyone noticing.
          if (name !== null && !getProfile(name)) return fail(`unknown profile: ${name}`);
          s.profile = name;
          upsertChannel({ sessionId: s.id, profile: name });
          broadcastProfile(s);            // even without a restart: the gap shows everywhere
          if (msg.restart) await restartSession(s);
          break;
        }
        case "set-parent": {
          // Attach this agent under another, or detach with null. `parent` is
          // SERVER_OWNED on the channel, so a browser PUT can't touch it —
          // this is the only legitimate path, exactly like `set-profile`.
          if (!session) return fail("no session started");
          const s = session;
          const wanted = msg.parent ?? null;
          const refusal = linkRefusal(loadChannels(), s.id, wanted);
          // Refuse out loud. Dropping the link silently would leave the parent
          // believing it will be notified, waiting for a child it isn't linked to.
          if (refusal) return fail(`cannot attach: ${refusal}`, "link-refused");
          upsertChannel({ sessionId: s.id, parent: wanted });
          broadcast(s, { type: "parent", parent: wanted });
          break;
        }
        case "stop": {
          // Kill a channel from any interface. `sessionId` lets the UI remove a
          // DEAD/zombie channel (no live session) — the previous handler bailed
          // on `!session`, so a crashed channel could never be closed from the
          // web ✕. Falls back to this connection's attached session.
          const id = msg.sessionId ?? session?.id;
          if (!id) return;
          await endChannel(id);
          if (session?.id === id) session = null;
          break;
        }
      }
    } catch (err) {
      if (session) session.busy = false;
      fail(err instanceof Error ? err.message : String(err));
    }
  });
});

// Fold any legacy separate Telegram bindings into the one channel registry.
migrateTgBindings();
// Seed the starter agent profiles (Shadok-dev / -Marketing / -Support) on a
// fresh install, when the user has none yet.
// Seeds the starter roles a fresh instance has none of — AND the ones a later
// release added, which an existing instance would otherwise never receive: the
// old all-or-nothing seed bailed as soon as the vault held anything. A role the
// user deleted stays deleted (profiles-declined.json).
try {
  const added = seedDefaultProfiles();
  if (added.length) console.log(`profiles: installed missing starter roles — ${added.join(", ")}`);
} catch {
  /* a malformed profiles.json must never stop the boot */
}
// Existing instances stored the starter prompts verbatim on their first boot,
// so no later release could reach them. Drop the ones that still match what we
// ship: identical today, current from now on. An edited prompt is the user's
// and is never touched.
try {
  const adopted = migrateToTracking();
  if (adopted.length) console.log(`profiles: now tracking this build's prompt — ${adopted.join(", ")}`);
} catch {
  /* a malformed profiles.json must never stop the boot */
}
// Install/refresh the managed Shadok-Tweak role from the repo's prompt file, so
// it tracks this build instead of going stale in the user's profiles.json.
try {
  const tweak = fs.readFileSync(path.join(__dirname, "..", "context", "tweak-prompt.md"), "utf8").trim();
  if (tweak) seedTweakProfile(tweak);
} catch {
  /* best effort — the CTA still starts an agent, just without the role */
}

// Install/refresh the bundled "shadok-scheduler" skill so agents can set up
// their own channel's crons in plain language. Server-owned, overwritten each
// boot to stay current.
function seedSchedulerSkill(): void {
  try {
    const src = path.join(__dirname, "..", "context", "scheduler-skill");
    if (!fs.existsSync(path.join(src, "SKILL.md"))) return;
    const dst = path.join(os.homedir(), ".claude", "skills", "shadok-scheduler");
    fs.mkdirSync(path.join(dst, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(src, "SKILL.md"), path.join(dst, "SKILL.md"));
    fs.copyFileSync(path.join(src, "scripts", "schedule.mjs"), path.join(dst, "scripts", "schedule.mjs"));
    fs.chmodSync(path.join(dst, "scripts", "schedule.mjs"), 0o755);
    // Seeding copies NAMED files, so a file dropped from the source stays
    // behind forever: an install seeded before the Node port keeps a
    // schedule.py that nothing updates any more, next to a SKILL.md that no
    // longer mentions it. Remove it — a "No such file" beats a stale twin that
    // silently drifts from the API it calls.
    fs.rmSync(path.join(dst, "scripts", "schedule.py"), { force: true });
  } catch {
    /* best effort — scheduling still works via the GUI/Telegram/API */
  }
}
seedSchedulerSkill();

// Install/refresh the bundled "shadok-secrets" skill, so an agent that obtains
// a credential can keep it for the next one. Server-owned, overwritten each
// boot to stay current — same contract as the scheduler skill above.
function seedSecretsSkill(): void {
  try {
    const src = path.join(__dirname, "..", "context", "secrets-skill");
    if (!fs.existsSync(path.join(src, "SKILL.md"))) return;
    const dst = path.join(os.homedir(), ".claude", "skills", "shadok-secrets");
    fs.mkdirSync(path.join(dst, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(src, "SKILL.md"), path.join(dst, "SKILL.md"));
    fs.copyFileSync(path.join(src, "scripts", "secret.mjs"), path.join(dst, "scripts", "secret.mjs"));
    fs.chmodSync(path.join(dst, "scripts", "secret.mjs"), 0o755);
    // Same as the scheduler above: drop the Python file a pre-port install
    // already has, since a named-file copy never prunes.
    fs.rmSync(path.join(dst, "scripts", "secret.py"), { force: true });
  } catch {
    /* best effort — the vault still works from the GUI and Telegram */
  }
}
seedSecretsSkill();

// Install/refresh the bundled "shadok-reload" skill so an agent can respawn
// itself to pick up a changed pilot prompt or newly-seeded skills. Server-owned,
// overwritten each boot — same contract as the skills above.
function seedReloadSkill(): void {
  try {
    const src = path.join(__dirname, "..", "context", "reload-skill");
    if (!fs.existsSync(path.join(src, "SKILL.md"))) return;
    const dst = path.join(os.homedir(), ".claude", "skills", "shadok-reload");
    fs.mkdirSync(dst, { recursive: true });
    for (const f of ["SKILL.md", "reload.mjs"]) {
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
    fs.chmodSync(path.join(dst, "reload.mjs"), 0o755);
  } catch {
    /* best effort — no self-reload skill just means a manual restart, never a crash */
  }
}
seedReloadSkill();

// Install/refresh the bundled "shadok-ledger" skill so agents can verify a
// status before asserting/acting, and record resolutions. Server-owned,
// overwritten each boot — same contract as the skills above. Seeded regardless
// of `ledgerEnabled`: a tool with no reflex is inert; the pilot-prompt gate is
// what actually turns the behaviour on.
function seedLedgerSkill(): void {
  try {
    const src = path.join(__dirname, "..", "context", "ledger-skill");
    if (!fs.existsSync(path.join(src, "SKILL.md"))) return;
    const dst = path.join(os.homedir(), ".claude", "skills", "shadok-ledger");
    fs.mkdirSync(dst, { recursive: true });
    for (const f of ["SKILL.md", "ledger.mjs", "ledger-core.mjs"]) {
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
    fs.chmodSync(path.join(dst, "ledger.mjs"), 0o755);
  } catch {
    /* best effort — an absent skill just means no ledger, never a crash */
  }
}
seedLedgerSkill();

// Install/refresh the bundled "shadok-ai-agents" skill so an agent in ANY repo
// (not just this one) can spawn/pilot other agents via pilotctl. It used to live
// only in the repo's .claude/skills — a project skill invisible to agents working
// elsewhere (e.g. a lead in another repo told to delegate). Now seeded globally like the
// others; only SKILL.md + the client ship, never the test dir.
function seedAgentsSkill(): void {
  try {
    const src = path.join(__dirname, "..", "context", "agents-skill");
    if (!fs.existsSync(path.join(src, "SKILL.md"))) return;
    const dst = path.join(os.homedir(), ".claude", "skills", "shadok-ai-agents");
    fs.mkdirSync(dst, { recursive: true });
    for (const f of ["SKILL.md", "pilotctl.mjs"]) {
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
    fs.chmodSync(path.join(dst, "pilotctl.mjs"), 0o755);
  } catch {
    /* best effort — no agents skill just means no cross-agent piloting, never a crash */
  }
}
seedAgentsSkill();

/** Run a package-manager install. Linux managers need root; if we aren't root,
 *  go through NON-interactive sudo so a password prompt fails fast rather than
 *  hanging the boot. brew (needsRoot:false) must never be sudo'd. */
function runTmuxInstall(c: TmuxInstall): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd = c.cmd;
    let args = c.args;
    if (c.needsRoot && typeof process.getuid === "function" && process.getuid() !== 0) {
      args = ["-n", cmd, ...args];
      cmd = "sudo";
    }
    const p = spawnChild(cmd, args, { stdio: ["ignore", "inherit", "inherit"], timeout: 180_000 });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${c.cmd} exited with code ${code}`))));
  });
}

// tmux is the durable transport — with node-pty, agents die on every server
// restart, and we auto-update often. If tmux is missing, install it once at
// boot (best-effort) and flip THIS process onto it, so even a first launch is
// smooth. Never blocks: on failure we stay on node-pty and log how to fix it.
void (async () => {
  if (process.env.SHADOK_TMUX === "0") return;
  const r = await ensureTmux({
    resolve: () => resolveBin("tmux"),
    plan: () => tmuxInstallCommand(process.platform, (b) => !!resolveBin(b)),
    install: runTmuxInstall,
    notify: (line) => console.log(`[shadok-ai] ${line}`),
  });
  if (r.installed && !USE_TMUX) {
    USE_TMUX = process.env.SHADOK_TMUX !== "0" && tmuxAvailable();
    if (USE_TMUX) console.log("[shadok-ai] transport: switched to tmux — agents now survive server restarts");
  }
})();

// node-pty's prebuilt spawn-helper must be executable, or the first agent's
// `pty.spawn` throws "posix_spawnp failed". The package postinstall chmods it
// but via a relative path that misses on a hoisted (npx / managed) install, so
// do it here from node-pty's real location — every layout, every boot.
ensureSpawnHelperExecutable((line) => console.log(`[shadok-ai] ${line}`));

/**
 * The tweak PR guard, copied OUT of the repo into ~/.shadok-ai so a cron can
 * still reach it once the agent's worktree is gone. After the tweak agent
 * commits and pushes, its tree is clean — closing the session prunes the
 * checkout, and a guard living in there would start failing every five minutes.
 */
function seedTweakPrCheck(): void {
  try {
    const src = path.join(__dirname, "..", "context", "tweak-pr-check.sh");
    if (!fs.existsSync(src)) return;
    const dst = path.join(os.homedir(), ".shadok-ai", "tweak-pr-check.sh");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  } catch {
    /* best effort — the tweak agent still works, it just cannot watch its PR */
  }
}
seedTweakPrCheck();

// Give this instance its own ledger (keyed by the launch dir), seeded from the
// legacy single-file ledger the first time and with ids backfilled, so both the
// pushed delta and the GUI viewer read a per-instance table with durable handles.
ensureLedgerFile(process.cwd());

// Fail-closed BEFORE listening: exposing the cockpit to a network with no
// password hands command execution to whoever reaches it. Better not to start
// than to start wide open.
const refusal = bindRefusal(HOST, Boolean(GUI_PASSWORD));
if (refusal) {
  console.error(`[shadok-ai] ${refusal}`);
  process.exit(1);
}

// Port fallback: if the requested port is busy, try the next ones. The Telegram
// bridge is started with the port we ACTUALLY bound, not the one we asked for.
let port = START_PORT;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && port < START_PORT + MAX_PORT_TRIES) {
    console.log(`port ${port} in use — trying ${port + 1}…`);
    port++;
    setTimeout(() => server.listen(port, HOST), 50);
  } else {
    console.error(`failed to listen: ${err.message}`);
    process.exit(1);
  }
});
// Before anything can spawn: make sure `claude` will not open on its first-run
// screens. reconcileOnBoot respawns sessions ~1s after boot, so this has to
// happen first — that race is exactly what produced the zombie agents.
ensureClaudeHome();
// Persistent per-container SSH identity: in Docker, generate/reuse a key on the
// shadok-data volume and point ~/.ssh at it so agents' git/ssh survive a
// recreate. No-op on a normal host. Its GIT_SSH_COMMAND fallback is merged into
// the env every spawned agent inherits.
Object.assign(process.env, ensureSshIdentity());

server.listen(port, HOST, () => {
  console.log(`shadok-ai web: http://localhost:${port}${HOST === "127.0.0.1" ? "" : `  (bind ${HOST})`}`);
  console.log(
    USE_TMUX
      ? "transport: tmux (agents survive server restarts)"
      : "transport: node-pty (agents die with the server; install tmux or unset SHADOK_TMUX=0 for durability)",
  );
  // Telegram control bridge — connects to this server's own /ws as a client
  // (only if a token is configured), so Telegram shares the web sessions. Pass
  // the internal auth cookie so it gets through the GUI password gate. The
  // handle + bound port let /telegram restart it hot when the config changes.
  boundPort = port;
  tgBridge = startTelegram(port, tgCookie());
  if (GUI_PASSWORD) console.log("gui: password protection ON");
  // Cron scheduler: prime nextRun then tick every 30s (unref'd so it never
  // keeps the process alive on its own).
  primeCrons();
  const cronTimer = setInterval(cronTick, 30_000);
  cronTimer.unref();
  // The lead agent, if this instance has none. Deferred a beat so it dials a
  // server that is already accepting, and never awaited: a cockpit that starts
  // without its lead agent is a far smaller problem than a boot that hangs.
  // Adopt BEFORE the spawn check: an instance whose `general` predates the flag
  // must be recognised, not given a second one.
  // Listening means ready enough: the page renders its empty state and picks
  // the lead agent up when it appears a moment later. Waiting for the agent
  // would delay the window for nothing.
  openBrowser("http://localhost:" + port);
  adoptHomeChannel();
  setTimeout(() => void startFirstAgent(), 1500).unref?.();
});
