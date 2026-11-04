import { randomUUID, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { newRequest, askVerdict, approveVerdict, cancelVerdict, dueRequests, expire, upsertRequest, requestsFor, describeRequest, loadRequests, saveRequests, isOpen, REQUEST_TTL_MS, type AdminRequest, type RequestKind } from "./admin-requests.js";
import { recordEvent, loadEvents, saveEvents, inboxFor, markSeen, notMeEffect, describeEvent, type SecEvent } from "./security-events.js";
import { execFile, execFileSync, spawnSync, spawn as spawnChild } from "node:child_process";
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
  resumedTurnStart,
  transcriptFilePath,
  type TuiDialog,
  type HistoryTurn,
} from "./extract.js";
import { fileCard, sentFilePaths, contentTypeFor, isImageFile, isVideoFile, parseByteRange } from "./download.js";
import {
  OFFER_TOOL, filesFileFor, loadOffers, saveOffers, offerVerdict, withOffer,
  offeredPaths, refusalMessage, statForOffer, type OfferedFile,
} from "./files.js";
// Same implementation as the web client's preview (plain JS, loaded as is by
// the browser): one source for reading the in-flight text off the screen.
import { extractLiveText } from "../public/live-text.js";
import { findTransientErrors, newTransientErrors, RETRY_DELAYS_MS } from "./retry.js";
import { backgroundTasks, screenShowsWork, moveToOption } from "./detect.js";
import { PtyPilot } from "./session.js";
import { ensureClaudeHome, ensureProjectTrusted,
  getDefaultModel,
  setDefaultModel,
  parseClaudeVersion,
  seedPlan,
  settingsPlan,
  type ClaudeHome,
  type ClaudeSettings,
} from "./claude-home.js";
import { authStatus, cancelLogin, invalidateAuthStatus, startLogin, submitLoginCode } from "./claude-auth.js";
import { startSetupToken, submitSetupTokenCode, cancelSetupToken } from "./setup-token.js";
import {
  startAgentLogin,
  submitAgentLoginCode,
  cancelAgentLogin,
  agentLoginPending,
  agentLoginInfo,
} from "./agent-login.js";
import { readTokenExpiry } from "./claude-creds.js";
import { starCount } from "./stars.js";
import {
  announceFirstAgent,
  countMainChannels,
  ensureFirstAgent,
  firstAgentStatus,
  settleFirstAgent,
} from "./first-agent.js";
import { readGroundAt } from "./ground.js";
import { homeGreetingBrief } from "./greeting.js";
import { ensureSshIdentity } from "./ssh.js";
import { accountsEnabled, deploymentMode, probeCanProvision } from "./capability.js";
import {
  migrationPlan,
  runMigration,
  respawnPlan,
  commonsOsUser,
  COMMONS_USER,
  MIGRATION_MARKER_FILE,
} from "./migrate-groups.js";
import { relayOAuthCallback } from "./oauth-relay.js";
import { openBrowser } from "./open-browser.js";
import {
  parseSkillMeta, prepromptParts, prepromptFingerprint, stalenessReasons,
  LEGACY_FINGERPRINT, type PrepromptPart, type StaleReason,
} from "./preprompt.js";
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
  normalizeGroups,
  ensureMainGroup,
  upsertChannel,
  removeChannel,
  mergeClientChannels,
  channelWriteAllowed,
  profilePatch,
  loadTgGroup,
  saveTgGroup,
  isHomeChannel,
  homeAdoptionTarget,
  resolveSessionTarget,
  resolveResumeId,
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
  mediaDir,
  type TelegramHandle,
} from "./telegram.js";
import { transcribe, audioClipExtension } from "./whisper.js";
import { cancelPairingCode, issuePairingCode, pairingStatus } from "./tg-pairing.js";
import { migrateTgBindings } from "./channels.js";
import {
  viewerFor,
  canResumeAs,
  canRestartInto,
  canSeeGroup,
  membershipVerdict,
  canSeeSession,
  listableGroups,
  visibleChannels,
  secretOwnGroupIds,
  ledgerGroupsFor,
  groupsPutFlow,
  privateGroupFor,
  newPrivateGroup,
  accountDeleteGroups,
  MAIN_GROUP_ID,
  type Viewer,
  type Group,
  type Nature,
} from "./groups.js";
import {
  resolveSpawnIsolation,
  osUserFor,
  homeForUser,
  runAsUser,
  provisionGroupUser,
  teardownGroupUser,
  reconcileGroupProvisioning,
  DEFAULT_HOME_BASE,
  createGroupFlow,
  deleteGroupFlow,
  SHARED_POT_GROUP,
  DEFAULT_SHARED_POT_PATH,
} from "./osusers.js";
import { instanceKey } from "./paths.js";
import {
  peerFileFor,
  loadPeers,
  savePeers,
  peerFromToken,
  signPeerToken,
  newPeer,
  withSalts,
  redeemVerdict,
  redeemPeer,
  normPeerName,
  removePeer,
  ownedByPeer,
  peersOutFileFor,
  agentInvitePrompt,
  peerScope,
  type Peer,
} from "./peers.js";
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
import { runRefusal, isShellMode } from "./bang.js";
import {
  ledgerFileFor,
  scopeVisible,
  recordIntoTable,
  saveLedger,
  mintLedgerId,
  ensureLedgerFile,
  loadLedger,
  deltaSince,
  formatLedgerChunks,
  ledgerSeenFileFor,
  seenFor,
  recordSeen,
} from "./ledger.js";
// The skill's pure core is the single source of the ledger's logic (CLAUDE.md):
// the server imports it rather than keeping a second copy of the kind inference.
import { rowKind } from "../context/ledger-skill/ledger-core.mjs";
import {
  childrenOf,
  linkRefusal,
  markAgentPrompt,
  notificationText,
  type ChildReport,
} from "./kinship.js";
import { talkVerdict, talkLetter } from "./talk.js";
import {
  loadConfig,
  saveConfig,
  telegramConfig,
  applyTelegramPatch,
  titleForCwd,
  setTitleForCwd,
  themeForCwd,
  setThemeForCwd,
  mutedForCwd,
  setMutedForCwd,
  agentAuthForCwd,
  setAgentAuthForCwd,
  twoFactorForCwd,
  setTwoFactorForCwd,
  backendForCwd,
  setBackendForCwd,
  type TelegramPatch,
} from "./config.js";
import {
  secretsFor,
  secretsForProfile,
  secretNamesForProfile,
  secretNames,
  setSecret,
  deleteSecret,
  setSecretSharing,
  setSecretProfiles,
  secretWriteVerdict,
  secretWriteDecision,
  secretOwnerGroup,
  visibleSecrets,
  RESERVED_SECRET_NAMES,
  MT_CLAUDE_OAUTH_TOKEN_NAME,
  longLivedTokenInfo,
  loadVault,
  recordOrigin,
  originProfile,
} from "./secrets.js";
import {
  recordSecretAudit,
  readSecretAudit,
  filterAudit,
  spawnActor,
  httpActor,
  profileSecretDiff,
  type SecretAuditVia,
} from "./secret-audit.js";
import {
  getProfile,
  profileArgs,
  permissionModeArgs,
  isPermissionMode,
  isEffortLevel,
  mcpServersVerdict,
  envVarsNote,
  seedDefaultProfiles,
  migrateToTracking,
  seedTweakProfile,
  loadProfiles,
  upsertProfile,
  removeProfile,
  promptEditVerdict,
  secretAttachVerdict,
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
  readSessionFull,
  sessionAlive,
  saveAccounts,
  userWriteVerdict,
  newInvite,
  inviteVerdict,
  hashPassword,
  promptAuthor,
  type Role,
  signSessionKey,
  readSessionKey,
  signTalkHandle,
  readTalkHandle,
  type Account,
} from "./accounts.js";
import {
  admins2fa,
  authenticationOptions,
  enrollCodeVerdict,
  isInternalClient,
  keepsTwoAdminsVerdict,
  loginNext,
  newEnrollCode,
  publicPasskey,
  putChallenge,
  readPending,
  registrationOptions,
  resetVerdict,
  signPending,
  takeChallenge,
  twoFactorEnableVerdict,
  verifyAuthentication,
  verifyRegistration,
  PENDING_TTL_MS,
  type Rp,
} from "./twofactor.js";
import { ensureSelfRepo } from "./selfrepo.js";
import { supersedeSession } from "./live-handover.js";
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
  browserOrigin, isLocalCaller,
} from "./net.js";
import { pctFromUsage, windowForModel } from "./context.js";
import {
  BACKEND_PRESETS,
  backendEnv,
  backendFor,
  backendSaveVerdict,
  instanceEnv,
  joinUrl,
  looksLikeMessage,
  parseModelList,
  testFailure,
  testRequestBody,
  type Backend,
} from "./backend.js";
import { availableModels, MODEL_FAMILIES } from "./claude-models.js";
import { startHeartbeat } from "./heartbeat.js";
import {
  ensureClaude,
  claudeInstallInProgress,
  claudeCommand,
  classifyBin,
  findClaudeBinWithRetry,
  startWithBusyRetry,
  liveClaudeDeps,
  rememberClaudeBin,
  resolveBin,
  sampleBin,
  type EnsureClaudeResult,
  mtCredentialMessage,
  mtTokenNeeded,
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
// Deployment mode, resolved ONCE at boot: the single source of truth for every
// privileged / isolation path. Multi-tenant needs BOTH the ability to provision
// an OS user and accounts; otherwise isolation is refused, never faked.
const DEPLOYMENT_MODE = deploymentMode({
  canProvision: probeCanProvision(),
  accountsEnabled: accountsEnabled(GUI_PASSWORD),
});
console.log(`deployment mode: ${DEPLOYMENT_MODE}`);

// The server drives channels it manages over its OWN loopback WS (cron fires,
// parent notifications, the reload nudge — all through `driveChannel`). Those
// deliveries authenticate as the bootstrap admin, but in multi-tenant the
// per-group drive gate (`mayDriveSession`) does NOT exempt the bootstrap admin,
// so a legitimate system delivery to a RESTRICTED or PRIVATE group's own channel
// would be refused `forbidden` — breaking crons/notifications/reload for every
// non-commons agent. This secret is the unforgeable proof that a drive comes
// from the server itself: `driveChannel` presents it as `x-shadok-system-drive`,
// the WS connect verifies it in constant time, and `mayDriveSession`/`canResumeAs`
// treat a verified system connection as authorized regardless of group.
//
// It is per-process and in-memory ONLY: a fresh random value every boot, never
// written to disk, never sent to any client, never logged. A client cannot forge
// it, and — unlike a client-settable field such as `origin` — a browser cannot
// claim it, which is why the exemption is gated on THIS and nothing else.
const SYSTEM_DRIVE_SECRET = randomBytes(32).toString("hex");

// The session cookie is derived DETERMINISTICALLY from the password (HMAC), not
// a per-login random token kept in memory. That way it survives a server
// restart — so an auto-update reload stays logged in instead of bouncing the
// user back to the login screen. Any instance with the same password accepts
// the same cookie; it's one-way, so the cookie never leaks the password. The
// in-process Telegram bridge presents this same cookie on its WS.
//
// SameSite is `Lax`, not `Strict`. Strict WITHHOLDS the cookie on any top-level
// navigation the browser considers cross-site — following a bookmark from
// another app, a link out of Telegram/notes, a restored session on some setups
// — so the cockpit greeted the user with the login screen despite a cookie that
// was still valid and persistent (a week's Max-Age). Reported as "it makes me
// log in again every time I reopen my machine" on an http://<tailscale-ip> URL.
// Strict was never what protected us: EVERY request already passes the
// same-origin `Origin` gate (the middleware below, `originAllowed`), which
// refuses a cross-site page's fetch/POST with a 403 regardless of SameSite, and
// a cross-site WS is refused the same way. Lax keeps that defense and only lets
// the cookie ride a top-level GET the user themselves initiated.
/** A week, matching the cookie's Max-Age: one is the other's enforcement. */
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
// Sessions are signed with a per-instance secret, NOT with the password: the
// password reaches every agent's environment, so signing with it would let an
// agent mint a cookie for anyone. Drawn lazily, so an instance with no password
// never creates a key file it will not use.
let sessionKeyCache: Buffer | null = null;
const signingSecret = (): Buffer => (sessionKeyCache ??= sessionSecret());
/**
 * The Telegram bridge and the agents authenticate as the bootstrap admin.
 *
 * `mfa` marks the cookie as second-factor verified. The BRIDGE gets it and an
 * agent does not, and that is not a privilege, it is what the flag means:
 * minting it takes the signing secret, which never leaves the server, so a
 * cookie carrying it IS the server (`isInternalClient`). An agent's
 * `SHADOK_AUTH` is a dated token sitting in a process env, which under 2FA must
 * read as what it is — a password-grade credential, not a second factor. Agents
 * lose nothing: they authenticate with `x-shadok-session-key`.
 */
const adminCookie = (mfa = false): string | undefined =>
  GUI_PASSWORD ? `sk_auth=${signSession(BOOTSTRAP_ADMIN, Date.now(), signingSecret(), mfa)}` : undefined;

// The live Telegram bridge handle + the port we actually bound, so the
// /telegram endpoint can tear it down and recreate it hot (no server restart).
let tgBridge: TelegramHandle = {
  stop() {},
  running: () => false,
  status: () => ({ username: null, tokenError: null }),
};
let boundPort = 0;
// The bridge is in-process and reaches us over the loopback WS: it is the
// server's own client, so its cookie says so. Without that, switching 2FA on
// refused it at the gate and Telegram went silent.
const tgCookie = (): string | undefined => adminCookie(true);

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
  // Before the attempt, not after it: the browser may already be loading, and
  // the empty state it would otherwise paint invites a SECOND lead agent.
  announceFirstAgent(countMainChannels(loadChannels()));
  try {
    const why = await ensureFirstAgent({
      port: boundPort,
      cookie: tgCookie(),
      cwd: process.cwd(),
      customBackend: instanceBackend().kind === "custom",
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
    // `ensureFirstAgent` settles its own status in a `finally`, but it can also
    // throw BEFORE reaching it (reading the channel list, probing auth). A
    // cockpit stuck on "starting your first agent…" is exactly what this
    // feature must never produce, so the outermost handler ends the wait too.
    settleFirstAgent("not-signed-in");
    console.log(`first agent: could not start — ${e instanceof Error ? e.message : String(e)}`);
  }
}
function restartTelegram(): void {
  tgBridge.stop();
  tgBridge = startTelegram(boundPort, tgCookie(), DEPLOYMENT_MODE === "multi-tenant");
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
    // Resolve the guard's secrets by the agent's REAL group (own → shared-in →
    // Main), not always Main (T9 carry). Mono-tenant leaves `group` null → Main.
    const secretEnv = secretsForProfile(target.profile, profile?.secrets, target.group ?? MAIN_GROUP_ID, commonsGroupIds());
    const env = { ...process.env, ...secretEnv };
    recordSecretAudit({
      action: "cron-check",
      secrets: Object.keys(secretEnv),
      actor: `cron ${c.id.slice(0, 8)}`,
      via: "cron",
      agent: c.sessionId,
      agentName: loadChannels().find((ch) => ch.sessionId === c.sessionId)?.name,
      ...(target.profile ? { profile: target.profile } : {}),
      instance: process.cwd(),
    });
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
    // The system-drive secret rides alongside the auth cookie: it is what tells
    // the WS connect this is the SERVER driving a channel it manages, so the
    // per-group gate (`mayDriveSession`) lets a cron/notification/reload delivery
    // through even when the channel's group is restricted or private (the
    // bootstrap admin alone is not exempt). The cookie still authenticates; the
    // secret only grants the group-boundary exemption.
    const headers = { ...(cookie ? { cookie } : {}), "x-shadok-system-drive": SYSTEM_DRIVE_SECRET };
    const ws = new WebSocket(`ws://127.0.0.1:${boundPort}/ws`, { headers });
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

/** A session's display name — the cockpit tab — falling back to a short id.
 *  What a parent is told its child is called, and what an agent's own prompts
 *  are signed with (`agentNameForKey`). */
function channelLabel(channels: readonly Channel[], sessionId: string): string {
  const ch = channels.find((c) => c.sessionId === sessionId);
  return ch?.name?.trim() || sessionId.slice(0, 8);
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
        name: channelLabel(channels, child.id),
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
/** The session a request's cookie carries, verified, or null. */
function cookieSession(req: { headers: Record<string, unknown> }): { user: string; mfa: boolean; issuedAt: number } | null {
  const tok = cookieToken(req.headers.cookie as string | undefined);
  return tok ? readSessionFull(tok, signingSecret(), Date.now(), SESSION_TTL_MS) : null;
}
/**
 * Who this request is, or null. Re-reads the account file every time, so
 * deleting an account or changing a role takes effect at once — that is what
 * buys us the absence of a session store.
 */
function currentAccount(req: Caller): { name: string; role: Role } | null {
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
  // live, so the key dies with the agent. And it only counts from THIS
  // machine (`localSessionForKey`): from the network it is ignored.
  const skey = req.headers["x-shadok-session-key"];
  if (typeof skey === "string" && skey && localSessionForKey(req, skey))
    return { name: BOOTSTRAP_ADMIN, role: "admin" };
  // A MEMBER-scope peer (an invited agent from another instance) authenticates
  // as a web MEMBER: everything a person you invite can do — see/drive EVERY
  // agent, read `/usage` and `/live`, spawn — but never admin (no account or
  // peer management). A RESTRICTED peer is NOT a member: it stays the boxed
  // principal that `peerName`/the `peer-scope` checks handle.
  const prow = peerRow(req);
  if (prow && peerScope(prow) === "member") return { name: prow.name, role: "member" };
  // The server's own in-process client (the Telegram bridge) — a machine, not a
  // person, so it is recognised HERE and stays refused by `cookieAccount`.
  if (isInternalClient(cookieSession(req))) return { name: BOOTSTRAP_ADMIN, role: "admin" };
  return cookieAccount(req);
}
/** Who is asking and which groups exist; routes filter with `visibleChannels`. */
export function callerGroups(req: Caller): { viewer: Viewer | null; groups: Group[] } {
  return { viewer: viewerFor(currentAccount(req)), groups: loadGroups() };
}

/** Is two-factor sign-in on for this instance? Meaningless with no password. */
function twoFactorOn(): boolean {
  return !!GUI_PASSWORD && twoFactorForCwd(loadConfig(), process.cwd());
}

/**
 * The PERSON behind a request: the signed-in browser session, and nothing else
 * — not an agent's session key, not a peer. Account and two-factor management
 * goes through this while 2FA is on, so an agent (whose key IS the bootstrap
 * admin) cannot reset anyone or switch the second factor off.
 *
 * With 2FA on, a cookie must carry the second-factor flag — which kills every
 * session issued before activation — and the bootstrap admin has no browser
 * session at all: it is the instance password, in every agent's env, and no
 * other admin can reset it.
 */
function cookieAccount(req: { headers: Record<string, unknown> }): { name: string; role: Role } | null {
  if (!GUI_PASSWORD) return { name: BOOTSTRAP_ADMIN, role: "admin" };
  const sess = cookieSession(req);
  if (!sess) return null;
  const tfa = twoFactorOn();
  if (tfa && !sess.mfa) return null;
  if (sess.user === BOOTSTRAP_ADMIN) return tfa ? null : { name: BOOTSTRAP_ADMIN, role: "admin" };
  const acct = loadAccounts().find((a) => a.name === sess.user);
  // No hash means an invitation that was never redeemed: not a login yet.
  if (!acct?.passwordHash) return null;
  // Opened before the account's access was reset: dead, whoever holds it.
  if (!sessionAlive(sess.issuedAt, acct)) return null;
  return { name: acct.name, role: acct.role };
}

/** The WebAuthn relying party for this request: the hostname the browser
 *  reached, and the page's own origin (already same-origin-checked). */
function rpFor(req: { headers: Record<string, unknown> }): Rp | null {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return null;
  try {
    const u = new URL(origin);
    return { id: u.hostname, origin: u.origin };
  } catch {
    return null;
  }
}

function sessionCookie(name: string, mfa: boolean): string {
  return `sk_auth=${signSession(name, Date.now(), signingSecret(), mfa)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}
function pendingCookie(name: string): string {
  return `sk_pending=${signPending(name, Date.now(), signingSecret())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${PENDING_TTL_MS / 1000}`;
}
const CLEAR_PENDING = "sk_pending=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
function pendingUser(req: { headers: Record<string, unknown> }): string | null {
  const m = /(?:^|;\s*)sk_pending=([^;]+)/.exec((req.headers.cookie as string | undefined) ?? "");
  return m ? readPending(decodeURIComponent(m[1]), signingSecret(), Date.now()) : null;
}

/** Write back one account (a passkey added / used, a code issued or burnt). */
function updateAccount(name: string, f: (a: Account) => Account): void {
  saveAccounts(loadAccounts().map((a) => (a.name === name ? f(a) : a)));
}

/**
 * A FRESH passkey confirmation from the acting admin — not merely their
 * session. Asked for the actions that would undo the second factor for
 * someone (reset, an enrollment code for another person, switching 2FA on or
 * off): a session can be ridden by a forged request, a biometric cannot.
 * Answers the refusal itself and returns false.
 */
/**
 * The fresh confirmation, for the admin writes that were plain session writes
 * in v1 — inviting, deleting an account, changing a role. Only while 2FA is on:
 * with it off nobody has to own a passkey, and asking for one would lock the
 * very setup that leads to switching it on.
 */
async function stepUpIfTwoFactor(req: express.Request, res: express.Response, me: { name: string }): Promise<boolean> {
  return !twoFactorOn() || stepUpOk(req, res, me);
}

async function stepUpOk(req: express.Request, res: express.Response, me: { name: string }): Promise<boolean> {
  const rp = rpFor(req);
  const acct = loadAccounts().find((a) => a.name === me.name);
  const challenge = takeChallenge(req.body?.challengeId, me.name, "stepup");
  if (!rp || !acct || !challenge) {
    res.status(403).json({ error: "confirm with your passkey first" });
    return false;
  }
  const used = await verifyAuthentication(rp, challenge, req.body?.assertion, acct, Date.now());
  if (!used) {
    res.status(403).json({ error: "passkey confirmation failed" });
    return false;
  }
  updateAccount(me.name, (a) => ({ ...a, passkeys: (a.passkeys ?? []).map((p) => (p.id === used.id ? used : p)) }));
  return true;
}

function requestAuthed(req: Caller): boolean {
  return currentAccount(req) !== null;
}

/**
 * The PEER a request authenticates as (`x-shadok-peer`), or null. A peer is a
 * DISTINCT principal from a web account — a remote instance/harness, scoped to
 * the agents it created (`Channel.createdByPeer`), never B's whole fleet. The
 * registry is re-read every call, so a `DELETE /peers` takes effect at once
 * (the invariant-33 pattern: no session store, revocation lives on disk).
 */
function peerRow(req: { headers: Record<string, unknown> }): Peer | null {
  const tok = req.headers["x-shadok-peer"];
  if (typeof tok !== "string" || !tok) return null;
  // `withSalts` so a row written before salts existed is verified against a
  // backfilled one — i.e. its old deterministic token is refused, not honoured.
  const peers = withSalts(loadPeers(peerFileFor()));
  const name = peerFromToken(tok, signingSecret(), peers);
  return name ? peers.find((p) => p.name === name) ?? null : null;
}
function peerName(req: { headers: Record<string, unknown> }): string | null {
  return peerRow(req)?.name ?? null;
}
/** The scope of the peer a request authenticates as (`member`/`restricted`), or
 *  null when it is not a peer. `member` peers act as web members; `restricted`
 *  ones stay boxed to the agents they created. */
function peerScopeFor(req: { headers: Record<string, unknown> }): "member" | "restricted" | null {
  const row = peerRow(req);
  return row ? peerScope(row) : null;
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
button{margin-top:12px;width:100%;padding:9px;border-radius:7px;border:none;background:#e0a44a;color:#14161a;font-weight:600;cursor:pointer}.err{color:#e26;font-size:12px;margin-top:8px;min-height:14px}
input+input{margin-top:8px}.hint{font-size:13px;color:#aab;margin:0 0 10px}.alt{display:block;margin-top:12px;font-size:12px;color:#aab}</style>
<form id=f data-action="/login">
<h1>◆ shadok-ai</h1><input id=u placeholder="User (blank = admin)" autocomplete=username><input id=pw type=password placeholder="Password" autofocus autocomplete=current-password><button>Enter</button><div class=err></div></form>
<form id=pk hidden><h1>◆ second step</h1><p class=hint>Confirm with this device's passkey (fingerprint, face, or device PIN).</p><button id=pkGo type=button>Use my passkey</button><a href=# id=pkCode class=alt>New device? Use a code from another one</a><div class=err></div></form>
<form id=en hidden><h1>◆ register this device</h1><p class=hint>Enter the code shown on a device already signed in (Users panel → Add a device), or the one an admin gave you.</p><input id=enCode placeholder="Code" autocomplete=one-time-code autocapitalize=characters><input id=enLabel placeholder="Name this device (e.g. MacBook)"><button>Register with my fingerprint / face</button><div class=err></div></form>
<script src="/vendor/simplewebauthn.js"></script>
<script nonce="${NONCE_PLACEHOLDER}">
const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
  .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }));
const show = (id) => { for (const f of ["f", "pk", "en"]) $(f).hidden = f !== id; };
const fail = (form, msg) => { $(form).querySelector(".err").textContent = msg; };
// No WebAuthn outside a secure context (https or localhost): say so rather
// than throw an opaque TypeError at the second step.
const webauthn = () => window.isSecureContext && window.SimpleWebAuthnBrowser && window.PublicKeyCredential;
function nextStep(j) {
  if (j.next === "passkey") return show("pk");
  if (j.next === "enroll") { show("en"); if (j.code) $("enCode").value = j.code; return; }
  location.assign("/" + location.hash);
}
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  // One form, two destinations: signing in, or choosing a password for the
  // first time. The user field only exists on the first.
  const u = document.getElementById("u");
  const body = u
    ? { user: u.value, password: document.getElementById("pw").value }
    : { password: document.getElementById("pw").value };
  post(f.dataset.action, body).then(({ ok, j }) => {
    if (ok) return nextStep(j);
    fail("f", j.error || "Wrong username or password");
  });
});
$("pkGo").addEventListener("click", async () => {
  if (!webauthn()) return fail("pk", "Passkeys need https:// (or localhost) and a recent browser.");
  const o = await post("/login/passkey/options");
  if (!o.ok) return fail("pk", o.j.error || "Start again");
  let response;
  try { response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: o.j.options }); }
  catch (err) { return fail("pk", "Cancelled or not available: " + (err && err.message || err)); }
  const r = await post("/login/passkey", { challengeId: o.j.challengeId, response });
  if (r.ok) return location.assign("/" + location.hash);
  fail("pk", r.j.error || "Not accepted");
});
$("pkCode").addEventListener("click", (e) => { e.preventDefault(); show("en"); });
$("en").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!webauthn()) return fail("en", "Passkeys need https:// (or localhost) and a recent browser.");
  const code = $("enCode").value;
  const o = await post("/login/enroll/options", { code });
  if (!o.ok) return fail("en", o.j.error || "Start again");
  let response;
  try { response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: o.j.options }); }
  catch (err) { return fail("en", "Cancelled or not available: " + (err && err.message || err)); }
  const r = await post("/login/enroll", { challengeId: o.j.challengeId, response, code, label: $("enLabel").value });
  if (r.ok) return location.assign("/" + location.hash);
  fail("en", r.j.error || "Not registered");
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
type Caller = { headers: Record<string, unknown>; socket?: { remoteAddress?: string } };

/**
 * `sessionForKey`, but only for a caller on THIS machine reaching us directly
 * (`isLocalCaller`): the key never expires and is worth the bootstrap admin,
 * so an exfiltrated one must buy nothing from the network. Every route that
 * accepts a session key goes through here — never `sessionForKey` alone.
 */
function localSessionForKey(req: Caller, key: string): string | null {
  if (!key || !isLocalCaller(req.socket?.remoteAddress, req.headers)) return null;
  return sessionForKey(key);
}

function sessionForKey(key: string): string | null {
  const id = readSessionKey(key, signingSecret());
  if (!id) return null;
  if (sessions.has(id)) return id;
  return loadChannels().some((c) => c.sessionId === id) ? id : null;
}

/**
 * WHICH agent is calling, from its per-session key — the header the skills
 * send, or the body field `/profiles/prompt` has always taken. The public
 * session id is never enough: `/live` lists every id, so it proves nothing.
 *
 * Returns the caller's PROFILE, which is what every agent-facing profile write
 * is scoped by. A session that is no longer running still resolves through the
 * channel list, exactly like `sessionForKey`.
 */
function callerOf(req: Caller & { body?: unknown }): { id: string | null; profile: string | null } {
  const h = req.headers["x-shadok-session-key"];
  const fromBody = (req.body as { key?: unknown } | undefined)?.key;
  const key = typeof h === "string" && h ? h : typeof fromBody === "string" ? fromBody : "";
  const id = localSessionForKey(req, key);
  if (!id) return { id: null, profile: null };
  const profile =
    sessions.get(id)?.profile ?? loadChannels().find((c) => c.sessionId === id)?.profile ?? null;
  return { id, profile };
}

/**
 * The identity a secret WRITE is scoped by, resolved SERVER-SIDE (never the
 * body). An AGENT (carrying its per-session key) owns its channel's group —
 * `agentGroupId` present (possibly null = its agent has no group → Main). A
 * browser leaves `agentGroupId` undefined and is resolved by `spawnGroupFor`
 * from its account. The `viewer` is the authorization principal either way (an
 * agent authenticates as the bootstrap admin).
 */
function secretCaller(req: Caller & { body?: unknown }): {
  agentGroupId?: string | null;
  viewer: Viewer | null;
} {
  const viewer = viewerFor(currentAccount(req));
  const agentId = callerOf(req).id;
  if (agentId) {
    const group = loadChannels().find((c) => c.sessionId === agentId)?.group ?? null;
    return { agentGroupId: group, viewer };
  }
  return { viewer };
}

/** The `createdBy` STAMPED on a secret — the agent's session id, or the signed-in
 *  account — never a value the client sent (which it could forge). */
function secretCreatedBy(req: Caller & { body?: unknown }): string {
  const agentId = callerOf(req).id;
  if (agentId) return `agent:${agentId}`;
  return currentAccount(req)?.name ?? "";
}

/**
 * The OWNER group a secret write lands in + the authorization verdict. The
 * owner-group membership gate is applied ONLY in multi-tenant: mono-tenant
 * cannot pose a real isolation wall (capability design, T3), so it keeps
 * today's behaviour — any authenticated caller writes the commons (Main). The
 * owner group is still derived from identity in BOTH modes (null/Main in
 * mono-tenant), so an agent always writes its own group and `createdBy` is
 * always stamped server-side.
 */
function secretWriteTarget(
  req: Caller & { body?: unknown; query?: Record<string, unknown> },
): { ownerGroup: string } | { refused: string } {
  const caller = secretCaller(req);
  const groups = loadGroups();
  if (DEPLOYMENT_MODE === "multi-tenant") {
    // The client may REQUEST a target group (the panel's selected group), in the
    // body (PUT/share/profiles) or the query (DELETE). It is only a request:
    // `secretWriteDecision` applies `canWriteSecretGroup` to it, and an agent's
    // is ignored (it writes only its own group). Mono-tenant drops the request
    // entirely — everything is Main, unchanged.
    const raw = (req.body as { group?: unknown } | undefined)?.group ?? req.query?.group;
    const requestedGroup = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    const decision = secretWriteDecision({ ...caller, requestedGroup, groups });
    return decision.ok ? { ownerGroup: decision.ownerGroup } : { refused: decision.error };
  }
  return { ownerGroup: secretOwnerGroup({ ...caller, groups }) };
}

/**
 * The AGENT whose session key signs this request, if any — its cockpit name for
 * the byline, and its id for the reply address.
 *
 * Attribution, deliberately NOT reusing `currentAccount`: that maps the very
 * same key to the bootstrap admin, which is the right answer for AUTHORISATION
 * (an agent may do what the human may) and the wrong one for a byline — an
 * agent's message would go out signed with the human's name, which is the bug
 * this exists to close. Resolved from the key, never from the frame, exactly
 * like a web prompt's author.
 */
function agentCaller(req: Caller): { id: string; name: string } | undefined {
  const key = req.headers["x-shadok-session-key"];
  if (typeof key !== "string" || !key) return undefined;
  const id = localSessionForKey(req, key);
  return id ? { id, name: channelLabel(loadChannels(), id) } : undefined;
}

/** Who an HTTP call to the vault/profile routes is, for the secret audit log. */
function auditActorOf(req: { headers: Record<string, unknown>; body?: unknown }): {
  actor: string;
  via: SecretAuditVia;
  agent?: string;
} {
  return httpActor({
    agentId: callerOf(req).id,
    account: currentAccount(req)?.name ?? null,
    browser: requestFromBrowser(req),
  });
}

/** One audit row per direction of a profile's secret list change. */
function auditProfileSecrets(
  req: { headers: Record<string, unknown>; body?: unknown },
  profile: string,
  diff: { added: string[]; removed: string[] },
  detail?: string,
): void {
  const who = auditActorOf(req);
  const base = { ...who, profile, instance: process.cwd(), ...(detail ? { detail } : {}) };
  recordSecretAudit({ action: "attached", secrets: diff.added, ...base });
  recordSecretAudit({ action: "detached", secrets: diff.removed, ...base });
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

// The WebAuthn browser helper. BEFORE the gate: the login page needs it for the
// passkey step, i.e. before any session exists. A public library, nothing more.
// Resolved from the package's main entry: its `exports` hide `package.json`.
const webauthnUmd = path.join(
  path.dirname(path.dirname(createRequire(import.meta.url).resolve("@simplewebauthn/browser"))),
  "dist",
  "bundle",
  "index.umd.min.js",
);
app.get("/vendor/simplewebauthn.js", (_req, res) => res.sendFile(webauthnUmd, { dotfiles: "allow" }));

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
  if (twoFactorOn()) {
    // Only AFTER the password checked out, so this says nothing to a guesser.
    if (name === BOOTSTRAP_ADMIN)
      return res.status(403).json({ error: "two-factor sign-in is on — sign in with your own named account" });
    // The password is half: a short-lived pending cookie carries it to the
    // passkey step, and no session exists until that step succeeds.
    const next = loginNext(loadAccounts().find((a) => a.name === name), true);
    res.setHeader("Set-Cookie", pendingCookie(name));
    return res.json({ ok: true, user: name, next });
  }
  res.setHeader("Set-Cookie", sessionCookie(name, false));
  return res.json({ ok: true, user: name });
});

// ── The second step of a sign-in (before the gate: no session exists yet) ────

app.post("/login/passkey/options", async (req, res) => {
  const name = pendingUser(req);
  const rp = rpFor(req);
  const acct = name ? loadAccounts().find((a) => a.name === name) : undefined;
  if (!name || !rp || !acct?.passkeys?.length) return res.status(401).json({ error: "sign in with your password again" });
  const options = await authenticationOptions(rp, acct);
  res.json({ options, challengeId: putChallenge(options.challenge, name, "login") });
});

app.post("/login/passkey", async (req, res) => {
  const name = pendingUser(req);
  const rp = rpFor(req);
  const acct = name ? loadAccounts().find((a) => a.name === name) : undefined;
  const challenge = name ? takeChallenge(req.body?.challengeId, name, "login") : null;
  if (!name || !rp || !acct || !challenge) return res.status(401).json({ error: "sign in with your password again" });
  const used = await verifyAuthentication(rp, challenge, req.body?.response, acct, Date.now());
  if (!used) return res.status(401).json({ error: "the passkey was not accepted" });
  updateAccount(name, (a) => ({ ...a, passkeys: (a.passkeys ?? []).map((p) => (p.id === used.id ? used : p)) }));
  res.setHeader("Set-Cookie", [sessionCookie(name, true), CLEAR_PENDING]);
  res.json({ ok: true, user: name });
});

// Registering a passkey during sign-in: the password is not enough — it needs
// an enrollment code minted by a verified device (yours, or an admin's). That
// is the rule the whole feature stands on (src/twofactor.ts).
app.post("/login/enroll/options", async (req, res) => {
  const name = pendingUser(req);
  const rp = rpFor(req);
  const acct = name ? loadAccounts().find((a) => a.name === name) : undefined;
  if (!name || !rp || !acct) return res.status(401).json({ error: "sign in with your password again" });
  const v = enrollCodeVerdict(acct, req.body?.code, Date.now());
  if (!v.ok) return res.status(403).json({ error: v.error });
  const options = await registrationOptions(rp, acct);
  res.json({ options, challengeId: putChallenge(options.challenge, name, "register") });
});

app.post("/login/enroll", async (req, res) => {
  const name = pendingUser(req);
  const rp = rpFor(req);
  const acct = name ? loadAccounts().find((a) => a.name === name) : undefined;
  const challenge = name ? takeChallenge(req.body?.challengeId, name, "register") : null;
  if (!name || !rp || !acct || !challenge) return res.status(401).json({ error: "sign in with your password again" });
  // Checked AGAIN here: the code is consumed only by a registration that lands.
  const v = enrollCodeVerdict(acct, req.body?.code, Date.now());
  if (!v.ok) return res.status(403).json({ error: v.error });
  const pk = await verifyRegistration(rp, challenge, req.body?.response, req.body?.label, Date.now());
  if (!pk) return res.status(400).json({ error: "the passkey could not be registered" });
  updateAccount(name, (a) => {
    const { enroll: _used, ...rest } = a;
    return { ...rest, passkeys: [...(a.passkeys ?? []), pk] };
  });
  console.log(`2fa: ${name} registered a passkey (${pk.label}) with an enrollment code from ${acct.enroll?.by}`);
  recordEvent({ kind: "passkey-added", actor: name, target: name, detail: pk.label, passkeyId: pk.id });
  res.setHeader("Set-Cookie", [sessionCookie(name, true), CLEAR_PENDING]);
  res.json({ ok: true, user: name });
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

app.post("/invite/:token", async (req, res) => {
  const token = String(req.params.token ?? "");
  const password = String(req.body?.password ?? "");
  const list = loadAccounts();
  const acct = list.find((a) => a.invite?.token === token);
  const v = inviteVerdict(acct, token, Date.now());
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  // Redeeming DROPS the invite and sets the hash: the link is single-use by
  // construction, not by a flag someone could forget to check.
  // With two-factor on, the invitation ALSO authorises registering a passkey:
  // the admin who issued it vouched for this person, which is exactly what an
  // enrollment code says. Handed straight to the page, which runs the step.
  const tfa = twoFactorOn();
  // Level 1 (lost password, passkeys kept): the link sets a password, then one
  // of the KEPT passkeys must answer. A link that only set a password would be
  // a way around the second factor for whoever intercepted it.
  const keptPasskey = tfa && acct!.invite?.reason === "password" && !!acct!.passkeys?.length;
  const enroll = tfa && !keptPasskey ? newEnrollCode(Date.now(), "invitation") : undefined;
  saveAccounts(
    list.map((a) =>
      a.name === acct!.name
        ? {
            name: a.name,
            role: a.role,
            createdAt: a.createdAt,
            passwordHash: hashPassword(password),
            ...(a.passkeys?.length ? { passkeys: a.passkeys } : {}),
            // Kept: dropping it would bring a session from before the reset
            // back to life the moment the new password is set.
            ...(a.sessionsAfter ? { sessionsAfter: a.sessionsAfter } : {}),
            ...(enroll ? { enroll } : {}),
          }
        : a,
    ),
  );
  console.log(`users: ${acct!.name} redeemed their invitation`);
  recordEvent({ kind: "invite-redeemed", actor: acct!.name, target: acct!.name });
  // Task 16: redeeming kicks the privileged private-group provision for this
  // person (multi-tenant only). Best-effort — a failure never blocks sign-in,
  // which is why it is awaited but cannot throw out of the handler.
  await ensurePrivateGroupProvisioned(acct!.name);
  if (tfa) {
    res.setHeader("Set-Cookie", pendingCookie(acct!.name));
    if (keptPasskey) return res.json({ ok: true, user: acct!.name, next: "passkey" });
    return res.json({ ok: true, user: acct!.name, next: "enroll", code: enroll!.code });
  }
  // Redeeming SIGNS YOU IN. Holding the link and choosing the password is an
  // authentication, and without this the browser keeps whatever session it
  // already had — an admin who invites someone from their own browser lands
  // back as the admin, with nothing to say the redemption did not take.
  res.setHeader(
    "Set-Cookie",
    `sk_auth=${signSession(acct!.name, Date.now(), signingSecret())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  );
  res.json({ ok: true, user: acct!.name });
});

// Signing out expires the cookie. Before the gate on purpose: throwing away a
// session must work even when that session is already invalid, otherwise a
// stale cookie would leave you stuck on a 401 with no way to clear it.
app.post("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", ["sk_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0", CLEAR_PENDING]);
  res.json({ ok: true });
});

/**
 * Redeem a peer invitation: a single-use ticket in, a durable token out.
 *
 * BEFORE the password gate on purpose, and it is the only peer route that is: an
 * invitee has no credential yet, which is the whole point of enrolling. The
 * surface is deliberately one field — the ticket authenticates the call and
 * nothing else is read — and it is narrow in three more ways: the ticket is
 * consumed on success (so a replay fails), it expires, and an unknown, used or
 * expired ticket all get the SAME refusal, so a guesser learns nothing about
 * which tickets ever existed.
 *
 * Twin of `POST /invite/:token` for humans.
 */
app.post("/peers/enrol", (req, res) => {
  const file = peerFileFor();
  const peers = withSalts(loadPeers(file));
  const v = redeemVerdict(peers, req.body?.ticket, Date.now());
  if (!v.ok) return res.status(400).json({ error: v.error });
  const row = peers.find((p) => p.name === v.name)!;
  savePeers(file, redeemPeer(peers, v.name, Date.now()));
  console.log(`peers: ${v.name} enrolled (ticket consumed)`);
  res.json({ ok: true, name: v.name, token: signPeerToken(v.name, signingSecret(), row.salt!) });
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
  // A peer is a NARROW principal, not a member: over HTTP it may reach ONLY
  // `GET /diff` (of its own agents — the handler ownership-checks). Everything
  // else stays denied, so a peer never touches B's vault, profiles, crons, other
  // agents or the account routes. Its spawn/drive path is the WS (verifyClient).
  if (req.method === "GET" && req.path === "/diff" && peerName(req)) return next();
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
    const dir = mediaDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, pasteFileName(randomUUID(), name, contentType));
    fs.writeFileSync(file, body);
    // The very wording Telegram already uses, so an agent sees one format.
    res.json({ path: file, line: attachmentPrompt([{ path: file, kind }]) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Speech-to-text for the composer's microphone button. The browser records a
 * short clip (MediaRecorder → webm/opus) and POSTs the raw bytes here; we run
 * the SAME local whisper.cpp pipeline the Telegram voice path uses
 * (`transcribe`) and return the text for the client to drop into the composer.
 *
 * The text is NEVER auto-sent — it lands in the editable composer so the user
 * reads it before acting, because a misheard instruction acted on in silence is
 * worse than a voice note that was ignored (the reason `heardNotice` exists).
 *
 * `requestFromBrowser` like `/paste`: this writes a file and records the mic, a
 * browser-only capability with no business being reachable by a script on
 * loopback. The clip is TRANSIENT — written to the OS temp dir and removed in
 * `finally`, never kept in `MEDIA_DIR`: it is spoken input, not a file to hand
 * the agent.
 *
 * The first call on a fresh instance provisions whisper (ffmpeg / model / build
 * via `ensureWhisper` inside `transcribe`), which can take minutes; the client
 * shows a working state and we simply wait. The French whisper notices are kept
 * server-side — the client maps `kind` to its own English UI copy, so the web
 * stays English while Telegram keeps its spoken-language notices.
 */
app.post("/transcribe", express.raw({ type: () => true, limit: PASTE_LIMIT }), async (req, res) => {
  if (!requestFromBrowser(req)) return res.status(403).json({ error: "same-origin browser only" });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: "empty body" });
  const ext = audioClipExtension(String(req.headers["content-type"] ?? ""));
  const tmp = path.join(os.tmpdir(), `shadok-stt-${randomUUID()}.${ext}`);
  try {
    await fs.promises.writeFile(tmp, body);
    const out = await transcribe(tmp);
    if (out.ok) return res.json({ ok: true, text: out.text });
    return res.json({ ok: false, kind: out.kind });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
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
  const list = listSessions(cwd);
  // `cwd` is a caller-supplied path, so a caller who knows another group's HOME
  // could enumerate that group's resumable sessions (ids + first-prompt preview).
  // Filter each to the caller's visible groups — the same session-level boundary
  // as /diff and /live. A session with no channel row (legacy/commons) stays
  // visible to all. Mono-tenant returns the list unchanged.
  if (DEPLOYMENT_MODE !== "multi-tenant") return res.json(list);
  const chans = loadChannels();
  const groups = loadGroups();
  const viewer = viewerFor(currentAccount(req));
  res.json(list.filter((s) => canSeeSession(s.id, chans, groups, viewer)));
});
// Sessions alive in THIS server (agents spawned by any client, including the
// pilotctl thin client). They own no transcript until their first turn, so
// /sessions cannot see them — this is the only way the UI can list them.
app.get("/live", (req, res) => {
  // Scope to the caller's visible groups: /live leaks `lastPrompt` (content) and
  // `cwd`/`branch` (location), and is the id-discovery vector for the WS resume
  // and term-* attach paths. Mirror `mayDriveSession` per session — mono-tenant
  // and any group-less (commons) channel resolve to always-visible, so the list
  // stays byte-for-byte today's outside multi-tenant. A dangling group id fails
  // closed, the twin of `visibleChannels`.
  const viewer = viewerFor(currentAccount(req));
  const chans = loadChannels();
  const groups = loadGroups();
  const visible = (id: string): boolean => {
    if (DEPLOYMENT_MODE !== "multi-tenant") return true;
    const gid = chans.find((c) => c.sessionId === id)?.group ?? null;
    if (!gid) return true; // commons / group-less
    const g = groups.find((x) => x.id === gid);
    if (!g) return false; // unresolvable → fail closed
    return canSeeGroup(g, viewer);
  };
  res.json(
    [...sessions.values()]
      .filter((s) => !s.pilot.hasExited && visible(s.id))
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
  const chans = loadChannels();
  const ch = chans.find((c) => c.sessionId === s.id);
  // A RESTRICTED peer sees the diff of ITS OWN agents only. A member peer (and
  // any account) passed the gate as a member and sees any.
  if (peerScopeFor(req) === "restricted" && !ownedByPeer(ch, peerName(req)!))
    return res.status(403).json({ error: "not your agent" });
  // /diff returns a session's git status + working-tree FILE CONTENTS, so it is a
  // cross-group confidentiality decision just like the drive/`/live` paths. Gate
  // it on the SAME group boundary (canSeeSession mirrors `mayDriveSession` /
  // `/live visible()`): agent-by-session-key and browser-by-account both resolve
  // through currentAccount. A group-less/commons session stays visible to all; an
  // unresolvable group fails closed. Mono-tenant short-circuits to visible.
  if (
    DEPLOYMENT_MODE === "multi-tenant" &&
    !canSeeSession(s.id, chans, loadGroups(), viewerFor(currentAccount(req)))
  )
    return res.status(403).json({ error: "not your agent" });
  res.json(gitDiff(s.cwd, s.worktree?.repo ?? ch?.repo ?? null));
});
// Past worktree sessions of a repo (for reopening unfinished work).
app.get("/recover", (req, res) => {
  const repo = String(req.query.repo ?? "").trim() || process.cwd();
  const list = isGitRepo(repo)
    ? listPastSessions(repo, agentStateHome(commonsOsUser({ migrated: groupsMigrated, mode: DEPLOYMENT_MODE })))
    : [];
  // `repo` is a caller-supplied path: a caller who knows another group's HOME
  // could enumerate that group's past worktree sessions (branch/commit metadata +
  // first-prompt preview). Filter each past session to the caller's visible
  // groups — the same boundary as /diff and /sessions. A session with no channel
  // row (legacy/commons) stays visible to all. Mono-tenant returns it unchanged.
  if (DEPLOYMENT_MODE !== "multi-tenant") return res.json(list);
  const chans = loadChannels();
  const groups = loadGroups();
  const viewer = viewerFor(currentAccount(req));
  res.json(list.filter((s) => canSeeSession(s.sessionId, chans, groups, viewer)));
});
// Server-side defaults (the launch directory pre-fills the working dir field).
app.get("/defaults", (_req, res) => {
  // instanceKey namespaces the client's localStorage channel cache by launch
  // dir, so two cockpits on the same origin (same port, sequentially) never
  // share it. One source of truth with the server's own per-dir keying.
  res.json({ cwd: process.cwd(), instanceKey: instanceKey() });
});
// Is the instance's lead agent on its way? A page with no channel cannot tell
// "one is being born" from "you closed your last tab" — both are zero channels
// (invariant 18) — and the difference decides whether it invites the user to
// create an agent or asks them to wait. Its own route rather than a field on
// `/defaults`, because the two have different lifetimes: `/defaults` hands out
// facts that cannot change under the page (the launch dir, its `instanceKey`)
// and is read once, while this one changes while the page watches and is
// POLLED — for as long as it answers `pending`, and never after.
app.get("/first-agent", (_req, res) => {
  res.json(firstAgentStatus());
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
// Instance-wide mute, per launch directory. `true` = NO web attention signal for
// any agent (favicon frozen, no title badge, no blink, no chime). Purely a
// display preference the client reads — no agent is restarted, unlike /ledger.
app.get("/mute", (_req, res) => {
  res.json({ muted: mutedForCwd(loadConfig(), process.cwd()) });
});
app.put("/mute", (req, res) => {
  setMutedForCwd(loadConfig(), process.cwd(), req.body?.muted === true);
  res.json({ muted: mutedForCwd(loadConfig(), process.cwd()) });
});
// Materialises shadok-ai's own source for the "Tweak Shadok-AI" CTA, and hands
// back the directory to start the agent in. Sits here so it inherits the same
// password gate as its neighbours.
app.post("/tweak/prepare", async (_req, res) => {
  // The tweak agent runs as the commons drop user; its self-repo clone must live
  // in THAT user's home (reachable under 0700 /root) and be owned by it — same
  // reason as the worktree created off it. `commonsOsUser → null` in mono-tenant
  // makes `agentStateHome(null)` the server home and the chown a no-op, so
  // nothing changes there.
  const commonsUser = commonsOsUser({ migrated: groupsMigrated, mode: DEPLOYMENT_MODE });
  const r = ensureSelfRepo(agentStateHome(commonsUser));
  if (r.error) return res.status(500).json({ error: r.error });
  if (r.cwd) await chownAgentStateToDropUser(r.cwd, commonsUser);
  res.json({ cwd: r.cwd });
});
// Running version + latest seen on npm (null if not yet polled / check disabled).
// Same payload as the WS `version` message, deliberately from ONE builder: the
// two used to be written out separately and drifted the moment a field was
// added — the HTTP route silently kept serving the older shape.
app.get("/version", (_req, res) => res.json(versionState()));

// Claude sign-in state. Instance-global — NOT per session — hence HTTP rather
// than a WS message: every tab and the Telegram bridge share one answer. The
// account login comes from `claude auth status`; the token expiry is read from
// the credentials store (never the token itself) and merged in, so the version
// menu can show WHO is signed in and WHEN a re-login will be needed.
// `backend: "custom"` when the whole instance runs on a custom model backend
// (src/backend.ts): the page then never opens the sign-in card, since no agent
// here needs the subscription. The probe still runs — a mixed setup's
// subscription agents still need to know.
app.get("/auth", async (_req, res) =>
  res.json({
    ...(await authStatus()),
    ...readTokenExpiry(),
    ...longLivedTokenInfo(loadVault(), DEPLOYMENT_MODE),
    ...customBackendFields(),
    ...mtTokenFields(),
  }),
);

/**
 * Whether this is a multi-tenant instance and, if so, whether its group agents'
 * subscription token is still missing — the signal the cockpit uses to offer the
 * in-cockpit provisioning card (and the blocking banner). Mono-tenant → both
 * false; it needs no token.
 */
function mtTokenFields(): { multiTenant: boolean; mtTokenMissing: boolean } {
  const multiTenant = DEPLOYMENT_MODE === "multi-tenant";
  const present = !!secretsFor([MT_CLAUDE_OAUTH_TOKEN_NAME], MAIN_GROUP_ID)[MT_CLAUDE_OAUTH_TOKEN_NAME];
  return { multiTenant, mtTokenMissing: multiTenant && !present };
}

function customBackendFields(): { backend?: "custom"; backendModel?: string | null } {
  const b = instanceBackend();
  return b.kind === "custom" ? { backend: "custom", backendModel: b.model } : {};
}

app.post("/auth/login", async (req, res) => {
  // `force` is a deliberate "re-login now" from a signed-in instance (the
  // version-menu button and the expiry reminder banner): renew the session
  // before its refresh token lapses. Without it, a signed-in instance short-
  // circuits to {alreadySignedIn} and nothing spawns.
  const force = req.body?.force === true;
  const r = await startLogin(force);
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
  if (r.ok) {
    void startFirstAgent();
    // Re-try the group migration once signed in (the credential seed it used to
    // need is gone, but a core step that failed while signed out is still retried
    // here instead of waiting for a MANUAL restart) — mirror of `startFirstAgent`
    // above. Idempotent + guarded against overlapping a boot run that is still going.
    void maybeRunGroupsMigration("post-sign-in");
  }
});

app.delete("/auth/login", (_req, res) => {
  cancelLogin();
  res.json({ ok: true });
});

// --- Subscription-token provisioning (src/setup-token.ts) -----------------
// A multi-tenant instance injects the long-lived subscription token
// (MT_CLAUDE_OAUTH_TOKEN) into its privilege-dropped agents; these two routes
// let an ADMIN mint/rotate it from the cockpit instead of a hand-run shell
// `claude setup-token`. Browser-origin + admin, exactly like the guardrail
// writes — and server-owned: the token is captured and stored server-side, and
// the response never carries it. Mono-tenant needs no token, so the routes are
// inert there (the UI hides them too).
function mtTokenGate(req: Caller & { headers: Record<string, unknown> }, res: {
  status: (n: number) => { json: (b: unknown) => void };
}): boolean {
  if (DEPLOYMENT_MODE !== "multi-tenant") {
    res.status(400).json({ error: "not applicable: this instance is single-tenant" });
    return false;
  }
  if (!requestFromBrowser(req)) {
    res.status(403).json({ error: "browser only" });
    return false;
  }
  if (currentAccount(req)?.role !== "admin") {
    res.status(403).json({ error: "admins only" });
    return false;
  }
  return true;
}

app.post("/mt-token/start", async (req, res) => {
  if (!mtTokenGate(req, res)) return;
  const r = await startSetupToken();
  if ("error" in r) return res.status(502).json(r);
  res.json(r); // {url}
});

app.post("/mt-token/code", async (req, res) => {
  if (!mtTokenGate(req, res)) return;
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  // The token is captured and written to the vault HERE and never leaves the
  // server: `store` is the only thing that ever touches the value.
  const r = await submitSetupTokenCode(code, (token) =>
    setSecret(MT_CLAUDE_OAUTH_TOKEN_NAME, token, MAIN_GROUP_ID, "operator:setup-token"),
  );
  if (r.ok) {
    mtTokenWarned = false; // a future absence gets warned again
    invalidateAuthStatus(); // so /auth re-reports longLived immediately
  }
  res.status(r.ok ? 200 : 400).json(r); // {ok} — never the token
});

app.delete("/mt-token", (req, res) => {
  // Same gate as start/code: a cancel is still a write on a credential flow, so
  // a non-admin/non-browser caller must not be able to kill an admin's live
  // mint mid-rotation.
  if (!mtTokenGate(req, res)) return;
  cancelSetupToken();
  res.json({ ok: true });
});

// --- Per-user subscription LOGIN ("login" auth mode, src/agent-login.ts) ----
// The alternative to the injected token: in "login" mode each OS user (commons
// `main` + each private/restricted group's own user) does its own interactive
// `claude auth login`, so its agents get the account's claude.ai connectors. A
// login is per-user because `claude`'s refresh rewrite is single-owner — it
// cannot be shared across OS users (see the connectors-via-global-login design).
// Same admin+browser+multi-tenant gate as /mt-token.

/** The OS users that each need their own login: commons + every group that has
 *  its own OS user (private/restricted). Deduped; mono-tenant yields none. */
function loginUsers(): Array<{ user: string; home: string; label: string }> {
  const out: Array<{ user: string; home: string; label: string }> = [];
  const commons = commonsOsUser({ migrated: groupsMigrated, mode: DEPLOYMENT_MODE });
  if (commons) out.push({ user: commons, home: agentStateHome(commons), label: "commons" });
  for (const g of loadGroups()) {
    const u = osUserFor(g);
    if (u && !out.some((x) => x.user === u))
      out.push({ user: u, home: agentStateHome(u), label: g.name || g.id });
  }
  return out;
}

app.get("/agent-login", (req, res) => {
  if (!mtTokenGate(req, res)) return;
  const mode = agentAuthForCwd(loadConfig(), process.cwd());
  const users = loginUsers().map(({ user, home, label }) => {
    const info = agentLoginInfo(home);
    return { user, label, loggedIn: info.loggedIn, expiresAt: info.expiresAt, pending: agentLoginPending(user) };
  });
  res.json({ mode, users });
});

app.post("/agent-login/mode", (req, res) => {
  if (!mtTokenGate(req, res)) return;
  const want = req.body?.mode === "login" ? "login" : "token";
  const cfg = loadConfig();
  const changed = agentAuthForCwd(cfg, process.cwd()) !== want;
  setAgentAuthForCwd(cfg, process.cwd(), want);
  // The auth wiring is a spawn-time decision — restart agents so it lands at once.
  if (changed) restartAllSessions();
  res.json({ mode: want, restarted: changed });
});

app.post("/agent-login/start", async (req, res) => {
  if (!mtTokenGate(req, res)) return;
  const user = typeof req.body?.user === "string" ? req.body.user : "";
  const target = loginUsers().find((u) => u.user === user);
  if (!target) return res.status(400).json({ error: "unknown user" });
  const r = await startAgentLogin(target.user, target.home);
  if ("error" in r) return res.status(502).json(r);
  res.json(r); // {url}
});

app.post("/agent-login/code", async (req, res) => {
  if (!mtTokenGate(req, res)) return;
  const user = typeof req.body?.user === "string" ? req.body.user : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!loginUsers().some((u) => u.user === user)) return res.status(400).json({ error: "unknown user" });
  const r = await submitAgentLoginCode(user, code);
  res.status(r.ok ? 200 : 400).json(r); // {ok} — never the credential
});

app.delete("/agent-login", (req, res) => {
  if (!mtTokenGate(req, res)) return;
  const user = typeof req.body?.user === "string" ? req.body.user : "";
  if (user) cancelAgentLogin(user);
  res.json({ ok: true });
});

// --- Model backend (src/backend.ts) ---------------------------------------
// The instance-wide source for every agent's backend variables: the backend
// chosen in the cockpit if any, else shadok's own environment. Read on every
// spawn, so a change applies to the next agent started without a restart.
function instanceBackendSource(): Record<string, string | undefined> {
  return instanceEnv(process.env, backendForCwd(loadConfig(), process.cwd()));
}
function instanceBackend(): Backend {
  return backendFor(backendEnv(instanceBackendSource(), {}));
}

// What is configured, WITHOUT the key (only whether there is one), and the
// presets the onboarding card offers. `source` tells the card whether a change
// here can take effect: an env-launched backend is shadowed by nothing but a
// saved one, and the card says so rather than pretend.
app.get("/backend", (_req, res) => {
  const saved = backendForCwd(loadConfig(), process.cwd());
  const b = instanceBackend();
  res.json({
    presets: BACKEND_PRESETS,
    source: saved ? "cockpit" : b.kind === "custom" ? "environment" : null,
    current:
      b.kind === "custom"
        ? { baseUrl: b.baseUrl, model: b.model, contextWindow: b.contextWindow, hasKey: !!saved?.authToken }
        : null,
  });
});

// Save (or, with {clear:true}, forget) the backend. Admin, browser only: it
// decides where every future agent sends its prompts — and with them, the
// code it reads. Running agents keep the backend they were spawned with.
app.put("/backend", (req, res) => {
  if (!accountAdmin(req, res)) return;
  const cfg = loadConfig();
  if (req.body?.clear === true) {
    setBackendForCwd(cfg, process.cwd(), null);
    console.log("backend: back to the Claude subscription");
    return res.json({ ok: true, current: null });
  }
  const v = backendSaveVerdict(req.body, backendForCwd(cfg, process.cwd()));
  if (!v.ok) return res.status(400).json({ error: v.error });
  setBackendForCwd(cfg, process.cwd(), v.value);
  console.log(`backend: ${v.value.baseUrl} · ${v.value.model}`);
  // The sign-in card may have started a `claude auth login` child before the
  // user chose another model: it would wait on stdin for ever.
  cancelLogin();
  res.json({ ok: true, current: { baseUrl: v.value.baseUrl, model: v.value.model } });
  // A brand-new instance had no way to start its lead agent until now.
  void startFirstAgent();
});

/** A server-side request with a deadline: a backend that never answers must
 *  not hang the card. */
async function backendFetch(url: string, init: RequestInit = {}, ms = 20_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** The key to test with: the one typed, else the saved one for the SAME server. */
function backendKey(body: { authToken?: unknown; baseUrl?: unknown }): string {
  const typed = typeof body.authToken === "string" ? body.authToken.trim() : "";
  if (typed) return typed;
  const saved = backendForCwd(loadConfig(), process.cwd());
  const url = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
  return saved && saved.baseUrl === url ? saved.authToken ?? "" : "";
}

// One real round trip — URL, key, model AND the Anthropic format — before
// anything is saved. Otherwise a wrong address shows up only as the first
// agent sitting on an error, which is exactly the opaque failure to avoid.
app.post("/backend/test", async (req, res) => {
  if (!accountAdmin(req, res)) return;
  const v = backendSaveVerdict(req.body);
  if (!v.ok) return res.json({ ok: false, error: v.error });
  const key = backendKey(req.body ?? {});
  const started = Date.now();
  try {
    const r = await backendFetch(joinUrl(v.value.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        // Exactly what Claude Code sends with ANTHROPIC_AUTH_TOKEN — a bearer
        // and nothing else — so a test that passes predicts an agent that works.
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(testRequestBody(v.value.model)),
    }, 60_000);
    const text = await r.text();
    if (!r.ok) return res.json({ ok: false, error: testFailure(r.status, text) });
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* judged below */ }
    if (!looksLikeMessage(json))
      return res.json({ ok: false, error: "the server answered, but not in the Anthropic format — an OpenAI-only server needs a proxy such as LiteLLM in front" });
    const reply = ((json as { content: { type?: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "").trim();
    res.json({ ok: true, ms: Date.now() - started, reply: reply.slice(0, 80) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const why =
      err.name === "TimeoutError" ? "no answer within 60 s"
      : err.cause?.code === "ECONNREFUSED" ? "nothing is listening at this address — is the server started?"
      : err.cause?.code === "ENOTFOUND" ? "this host name does not resolve"
      : err.message;
    res.json({ ok: false, error: why });
  }
});

// The models a server offers, for the card's picker: Ollama's /api/tags first
// (it lists what is PULLED, which is the useful answer), then the OpenAI-style
// /v1/models most others serve. Nothing found is an empty list, never an
// error — the model field stays free text.
app.post("/backend/models", async (req, res) => {
  if (!accountAdmin(req, res)) return;
  const base = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : "";
  if (!/^https?:\/\//i.test(base)) return res.json({ models: [] });
  const key = backendKey(req.body ?? {});
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {};
  for (const p of ["/api/tags", "/v1/models"]) {
    try {
      const r = await backendFetch(joinUrl(base, p), { headers }, 5_000);
      if (!r.ok) continue;
      const models = parseModelList(await r.json());
      if (models.length) return res.json({ models });
    } catch { /* try the next shape */ }
  }
  res.json({ models: [] });
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
app.get("/channels", (req, res) => {
  const active = loadCrons().filter((c) => c.enabled);
  // ACL: a caller sees only its own groups' channels + public/commons. The
  // registry is the authority — the client is never trusted to filter. A null
  // viewer (deleted account / no session) resolves to public-only, never a 500.
  // Mono-tenant leaves every channel group-less, so visibleChannels is a no-op.
  const visible = visibleChannels(loadChannels(), loadGroups(), viewerFor(currentAccount(req)));
  res.json(
    visible.map((ch) => {
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
  // A stale tab whose server was stopped and replaced by another instance on the
  // same port must not write its old channels into THIS instance's file. The
  // page carries the launch-dir key it was loaded from; refuse an explicit
  // mismatch. Return the live list so the confused client can reconcile.
  const clientKey = req.get("x-shadok-instance");
  if (!channelWriteAllowed(instanceKey(), clientKey)) {
    return res.status(409).json({ error: "instance-mismatch", channels: loadChannels() });
  }
  // Merge, don't overwrite: the browser owns order + name/group, but must never
  // drop a live or Telegram-bound session or strip server-owned fields.
  const live = new Set([...sessions.values()].filter((s) => !s.pilot.hasExited).map((s) => s.id));
  const before = new Map(loadChannels().map((c) => [c.sessionId, c.name]));
  const body = (Array.isArray(req.body) ? req.body : []) as any[];
  // Mirroring is admin-managed (cf. the Telegram config gate and the `start`
  // handler): a non-admin may reorder / rename / regroup their agents, but must
  // not flip an agent's Telegram mirror through a channel write (the agent-menu
  // toggle persists via this endpoint). Pin each incoming `mirror` to its stored
  // value for a non-admin; a brand-new channel they create is left un-mirrored.
  // Admins — and agents, who authenticate as the bootstrap admin — pass through.
  if (currentAccount(req)?.role !== "admin") {
    const storedMirror = new Map(loadChannels().map((c) => [c.sessionId, c.mirror]));
    for (const c of body) {
      if (!c || typeof c.sessionId !== "string") { if (c) delete c.mirror; continue; }
      const prev = storedMirror.get(c.sessionId);
      if (prev === undefined) delete c.mirror;
      else c.mirror = prev;
    }
  }
  const merged = mergeClientChannels(body, live);
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
app.get("/groups", (req, res) => {
  // A group row carries `members`/`owner`/`osUser`, so an unfiltered list leaks a
  // restricted group's roster to non-members and a private group's very existence
  // ("a private group is invisible even to an admin"). Filter by the caller via
  // listableGroups: member-of plus public groups only. An admin is NOT special
  // (operator decision 2026-11-03): a restricted group they don't belong to, and
  // a private group they don't own, are hidden from them too. Row-level only; no field trimming is needed
  // (a visible-but-not-member group is public, whose members are already empty).
  // Mono-tenant (only a public Main) keeps Main for everyone, unchanged.
  res.json(listableGroups(loadGroups(), viewerFor(currentAccount(req))));
});
app.put("/groups", (req, res) => {
  // BROWSER-ONLY (T2/T6 carry): an agent authenticates as the bootstrap admin,
  // so without this it could edit membership/nature by curl. The flow also
  // keeps the instance guard and refuses a non-member membership/nature change —
  // and MERGES cosmetic fields onto the stored rows, so the cosmetic client PUT
  // can never silently wipe a restricted group down to an empty public one.
  const r = groupsPutFlow({
    fromBrowser: requestFromBrowser(req),
    instanceOk: channelWriteAllowed(instanceKey(), req.get("x-shadok-instance")),
    actor: currentAccount(req)?.name ?? null,
    stored: loadGroups(),
    incoming: Array.isArray(req.body) ? req.body : [],
  });
  if (r.groups) saveGroups(r.groups);
  res.status(r.status).json(r.body);
});

// Add and/or remove members of a Private (`restricted`) group. Any MEMBER may do
// both (membershipVerdict owns that rule); browser-only for the same reason as
// PUT /groups: an agent holds the bootstrap admin cookie and sends no Origin.
// A group the caller cannot see is a 404 (fail closed — never confirm it exists).
app.post("/groups/members", (req, res) => {
  if (!requestFromBrowser(req)) return res.status(403).json({ error: "browser only" });
  if (!channelWriteAllowed(instanceKey(), req.get("x-shadok-instance"))) {
    return res.status(409).json({ error: "this page belongs to another instance" });
  }
  const body = req.body ?? {};
  const add = typeof body.add === "string" ? body.add.trim() : "";
  const remove = typeof body.remove === "string" ? body.remove.trim() : "";
  if (!add && !remove) return res.status(400).json({ error: "nothing to add or remove" });
  const viewer = viewerFor(currentAccount(req));
  const list = loadGroups();
  const group = list.find((g) => g.id === body.group);
  if (!group || !canSeeGroup(group, viewer)) return res.status(404).json({ error: "unknown group" });
  if (add) {
    const v = membershipVerdict(viewer, group, "invite", add);
    if (!v.ok) return res.status(403).json({ error: v.error });
  }
  if (remove) {
    const v = membershipVerdict(viewer, group, "remove", remove);
    if (!v.ok) return res.status(403).json({ error: v.error });
  }
  let members = group.members.filter((m) => m !== remove);
  if (add && !members.includes(add)) members = [...members, add];
  const updated = { ...group, members };
  saveGroups(list.map((g) => (g.id === group.id ? updated : g)));
  res.json({ ok: true, group: updated });
});

// ── Privileged group lifecycle (multi-tenant): provision on create, tear down
// on delete. These are the ONLY paths that create/destroy an OS user, so the
// DEPLOYMENT_MODE gate and the honest-failure rules (T3/T4) all live here. ──────

/** Where a group's HOME is created (`SHADOK_HOME_BASE` override, else `/home`). */
const GROUP_HOME_BASE = (process.env.SHADOK_HOME_BASE ?? "").trim() || DEFAULT_HOME_BASE;

/** The HOME that holds ALL of an agent's on-disk state: its transcript
 *  (`.claude/projects`, read by the content tail and `loadHistory`) AND its
 *  worktrees + self-repo clone (`.shadok-ai/worktrees`, `.shadok-ai/self`). The
 *  drop user's own home when the agent is privilege-dropped (multi-tenant
 *  isolation), else the server's own home (commons / mono-tenant). The single
 *  answer every one of those paths must use: the server's `/root` is mode 0700
 *  and un-traversable by a dropped user, so state created there is silently
 *  unreachable — a reply that never streams, or a Tweak agent wedged on Claude
 *  Code's invalid-settings screen (its worktree lived under `/root`). */
function agentStateHome(user: string | null | undefined): string {
  return user ? homeForUser(user, GROUP_HOME_BASE) : os.homedir();
}

/** The COMMONS tier for secret resolution: Main plus every PUBLIC non-Main group.
 *  A public group is visible-to-all ("public = commun"), so its secrets resolve
 *  for every agent like Main's — not only for an agent that happens to run in it.
 *  Mono-tenant (no groups) collapses to Main alone, today's behaviour. */
function commonsGroupIds(): string[] {
  const ids: string[] = [MAIN_GROUP_ID];
  for (const g of loadGroups()) if (g.nature === "public" && g.id !== MAIN_GROUP_ID) ids.push(g.id);
  return ids;
}

/** The state HOME for a CHANNEL that may not be live (e.g. GET /download of a
 *  past session, or pruning a worktree as the session ends): a live session's
 *  own `transcriptHome` when we have it, else re-derived from the channel's
 *  group the same way a spawn's drop user is — the group's `sk-*` user, or the
 *  commons user when migrated, else the server. Governs both the transcript and
 *  the worktree location, so prune finds exactly what the spawn created. */
function channelStateHome(chan: Channel): string {
  const live = sessions.get(chan.sessionId);
  if (live) return live.transcriptHome;
  if (DEPLOYMENT_MODE !== "multi-tenant") return os.homedir();
  const g = chan.group ? loadGroups().find((x) => x.id === chan.group) : null;
  const user = (g ? osUserFor(g) : null) ?? commonsOsUser({ migrated: groupsMigrated, mode: DEPLOYMENT_MODE });
  return agentStateHome(user);
}

/** Task 12: the one shared pot every group HOME links as `~/shared`. */
const SHARED_POT_PATH =
  (process.env.SHADOK_SHARED_POT_PATH ?? "").trim() || DEFAULT_SHARED_POT_PATH;

// Multi-tenant: Telegram/paste attachments must be readable by a privilege-
// dropped agent, but the default `~/.shadok-ai/media` is `/root/.shadok-ai/media`
// — and `/root` (mode 700) is un-traversable by the `main`/`sk-*` drop users, so
// an agent handed `[Attached image: /root/.shadok-ai/media/…]` cannot open it
// (invariant 54's family). Relocate media under the shared pot (which every drop
// user is in `shadok-shared` to traverse), carry existing attachments over so
// already-sent images keep resolving, and point `mediaDir()` there via the env.
// Best-effort: a failure just leaves media at `~/.shadok-ai/media`, the old
// (broken-for-agents) behaviour, never a boot failure. Mono-tenant is untouched.
if (DEPLOYMENT_MODE === "multi-tenant") {
  try {
    const shared = path.join(SHARED_POT_PATH, "media");
    fs.mkdirSync(shared, { recursive: true });
    // Own it to the pot's group (`shadok-shared`) with setgid, so files the
    // server writes inherit that group and the drop users can read them.
    try {
      const potGid = fs.statSync(SHARED_POT_PATH).gid;
      fs.chownSync(shared, 0, potGid);
      fs.chmodSync(shared, 0o2775);
    } catch {
      /* pot not provisioned yet (pre-migration) — the next boot fixes it */
    }
    const legacy = path.join(os.homedir(), ".shadok-ai", "media");
    if (legacy !== shared && fs.existsSync(legacy)) {
      for (const name of fs.readdirSync(legacy)) {
        const dst = path.join(shared, name);
        if (!fs.existsSync(dst)) {
          try {
            fs.copyFileSync(path.join(legacy, name), dst);
          } catch {
            /* skip an unreadable/odd entry */
          }
        }
      }
    }
    process.env.SHADOK_MEDIA_DIR = shared;
    console.log(`media: using ${shared} (reachable by dropped agents)`);
  } catch (e) {
    console.warn(
      "media: could not set up the shared media dir, keeping ~/.shadok-ai/media: " +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}

/** Run a privileged account command. Root runs it directly; otherwise go through
 *  NON-interactive sudo (`-n`) so a MISSING right fails fast with a non-zero exit
 *  instead of prompting — the T3 false positive (sudoers allows `true` but not
 *  `useradd`) surfaces here and `provisionGroupUser` turns it into a refusal. */
function runPrivileged(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let c = cmd;
    let a = argv;
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      a = ["-n", c, ...a];
      c = "sudo";
    }
    const p = spawnChild(c, a, { stdio: ["ignore", "inherit", "inherit"], timeout: 60_000 });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

/**
 * Make a freshly-created worktree (or self-repo clone) usable by the DROP USER.
 * The server creates it as ROOT, so the checkout AND git's own worktree admin
 * dir (`<repo>/.git/worktrees/<name>`, where the agent's index/HEAD/logs live)
 * are root-owned — and a dropped agent could neither write them nor, before this
 * fix, even reach them under the 0700 server HOME. Now the checkout lives in the
 * drop user's OWN home (`agentStateHome` → `worktreeDir`), so only ownership is
 * left: chown BOTH the checkout and (for a worktree) its external admin dir to
 * the user. Best-effort and logged — a chown failure degrades to the old symptom
 * rather than failing the spawn, and the log names it. No-op with no drop user
 * (mono-tenant, or commons-as-root before migration): ownership is already right.
 */
async function chownAgentStateToDropUser(checkout: string, user: string | null | undefined): Promise<void> {
  if (!user) return;
  const owner = `${user}:${user}`;
  try {
    await runPrivileged("chown", ["-R", owner, checkout]);
    // git's admin dir sits under the REPO's gitdir, not the checkout; resolve it
    // from inside the checkout so a worktree `.git` FILE is followed to it. Only
    // chown it when OUTSIDE the checkout (a worktree); for a plain clone it is
    // `<checkout>/.git`, already covered by the recursive chown above.
    let adminDir = "";
    try {
      adminDir = execFileSync("git", ["-C", checkout, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", timeout: 10_000 }).trim();
    } catch {
      /* not a git checkout: the recursive chown already covered it */
    }
    if (adminDir && !adminDir.startsWith(path.resolve(checkout) + path.sep)) {
      await runPrivileged("chown", ["-R", owner, adminDir]);
    }
  } catch (e) {
    console.warn(`state chown to ${user} failed for ${checkout} (agent may be unable to write it): ${(e as Error)?.message ?? e}`);
  }
}

/** The shadok skills to install: [package source dir, installed name]. Mirrored
 *  into the SERVER HOME by `seedXxxSkill` and, for multi-user isolation, into the
 *  machine-wide ENTERPRISE tier by `seedSystemSkills`. */
const SKILL_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["scheduler-skill", "shadok-scheduler"],
  ["secrets-skill", "shadok-secrets"],
  ["reload-skill", "shadok-reload"],
  ["ledger-skill", "shadok-ledger"],
  ["agents-skill", "shadok-ai-agents"],
  // files-skill is ALSO seeded to the server HOME by seedFilesSkill; it must be
  // here too, or a privilege-dropped group agent (which reads only the machine-
  // wide tier, never the server's /root HOME) silently loses it — which is
  // exactly what bit a migrated instance. test/system-skills.test.ts pins that
  // every shipped context/*-skill is listed here.
  ["files-skill", "shadok-files"],
];

/** Claude Code's machine-wide ("Enterprise"/managed) skills directory — read by
 *  EVERY OS user regardless of HOME, with precedence over a personal
 *  `~/.claude/skills`. `/etc/claude-code/.claude/skills` on Linux (overridable
 *  for other layouts). Disable in the CLI with `CLAUDE_CODE_DISABLE_POLICY_SKILLS`. */
const SYSTEM_SKILLS_DIR =
  (process.env.SHADOK_SYSTEM_SKILLS_DIR ?? "").trim() || "/etc/claude-code/.claude/skills";

/**
 * Install the shadok skills GLOBALLY, into the machine-wide Enterprise tier, so
 * every dropped group agent (`sk-<id>`, HOME `/home/sk-<id>`) gets them with NO
 * per-HOME copy. The per-HOME `~/.claude/skills` is only the SERVER user's;
 * `/etc/claude-code/.claude/skills` is read by all users. Copied from the package
 * source and made world-readable (root-owned dir, `a+rX`; `.mjs` entrypoints
 * executable). Idempotent, best-effort. Multi-tenant only: a mono-tenant / dev
 * instance keeps using its personal `~/.claude/skills` and never writes to /etc.
 */
function seedSystemSkills(): void {
  try {
    for (const [srcName, dstName] of SKILL_SOURCES) {
      const src = path.join(__dirname, "..", "context", srcName);
      if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
      const dst = path.join(SYSTEM_SKILLS_DIR, dstName);
      fs.mkdirSync(dst, { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
    // World-readable (every sk-* user reads the same install) and .mjs runnable.
    execFileSync("chmod", ["-R", "a+rX", SYSTEM_SKILLS_DIR]);
    execFileSync("find", [SYSTEM_SKILLS_DIR, "-name", "*.mjs", "-exec", "chmod", "a+rx", "{}", "+"]);
    console.log(`skills: seeded machine-wide skills into ${SYSTEM_SKILLS_DIR}`);
  } catch (e) {
    console.log(`skills: could not seed machine-wide skills into ${SYSTEM_SKILLS_DIR} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Seed a group user's HOME at PROVISION time. Skills are no longer copied here —
 * they live in the machine-wide Enterprise tier (`seedSystemSkills`), read by
 * every user. Kept as the hook for any future per-HOME provisioning step.
 */
async function seedGroupHome(_home: string, _user: string): Promise<void> {
  /* skills are machine-wide now; nothing per-HOME to seed */
}

/** Does an OS user already exist? Used to make provisioning idempotent. */
async function osUserExists(u: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile("id", ["-u", u], { timeout: 5000 }, (err) => resolve(!err));
  });
}

/** Best-effort: end every channel that belongs to a group (used on teardown). */
async function killGroupAgents(groupId: string): Promise<void> {
  const ids = loadChannels().filter((c) => c.group === groupId).map((c) => c.sessionId);
  for (const id of ids) await endChannel(id).catch(() => {});
}

// ── Task 15: automatic root→non-root commons migration ────────────────────────
//
// On the first boot of a CAPABLE (multi-tenant) instance, move the running
// single-tenant instance into isolated groups: create the non-root commons user
// `main`, chown the root-owned tree to it, lift the flat vault into Main,
// auto-provision each account's private group, and label what exists as public.
// The pure plan + fail-safe runner live in `src/migrate-groups.ts`; this is the
// impure plumbing (the injected side effects). See that file and invariant notes.
//
// The marker lives on the shadok-data volume (`~/.shadok-ai`, the one mount that
// survives `docker rm`+recreate — see `src/ssh.ts`), so the DATA migration never
// re-runs. The OS layer is a separate idempotency concern: a recreate keeps the
// volume but wipes `/etc/passwd` + the HOMEs, so we treat the instance as already
// migrated only when the marker is present AND `main` actually exists — the
// second term is what re-triggers the idempotent OS provisioning after a recreate.

/** Has the commons migration moved this instance to isolated groups yet? Drives
 *  `commonsOsUser`: only once true (and multi-tenant) do commons agents drop to
 *  the non-root `main`. Flipped on at boot if already migrated, and after a
 *  successful `runGroupsMigration`. Fail-safe default is `false` (commons as the
 *  server's own user — today's behaviour). */
let groupsMigrated = false;
/** Log the missing group token once, not on every spawn. */
let mtTokenWarned = false;

/**
 * A LOUD, persistent signal (surfaced on `/version` + the WS `version` message,
 * so the client can show a banner) for when the commons is running UN-ISOLATED:
 *  - `"ok"` — nothing to show: mono-tenant, or migration already completed;
 *  - `"pending"` — a capable instance is MID-migration (the long chown), so a
 *    commons agent is still running as the server's own (root) user for now;
 *  - `"failed"` — a capable instance RAN the migration but a core step failed
 *    (the marker was withheld), so it will NOT retry until the next boot and the
 *    commons stays un-isolated. Without this it is INVISIBLE (the only
 *    trace is a log line nobody reads). This turns it into an on-screen warning.
 */
let migrationState: "ok" | "pending" | "failed" = "ok";

/** Serialises the migration: it runs at boot AND is re-tried after a Claude
 *  sign-in (see `maybeRunGroupsMigration`). The two must never overlap: both
 *  chown the same tree and respawn the same panes. `maybeRunGroupsMigration`
 *  skips while this is set. */
let migrationInFlight = false;

function migrationMarkerPath(): string {
  return path.join(os.homedir(), ".shadok-ai", MIGRATION_MARKER_FILE);
}
function migrationMarkerExists(): boolean {
  try {
    return fs.existsSync(migrationMarkerPath());
  } catch {
    return false;
  }
}
function writeMigrationMarker(): void {
  const p = migrationMarkerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ at: Date.now() }, null, 2));
}
/** Synchronous `id -u <user>` — boot-time, so it must not be async. */
function osUserExistsSync(u: string): boolean {
  try {
    execFileSync("id", ["-u", u], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
/** Already migrated iff the marker is present AND `main` exists (the latter is
 *  what a docker recreate loses, re-triggering the idempotent provisioning). */
function alreadyMigratedNow(): boolean {
  return migrationMarkerExists() && osUserExistsSync(COMMONS_USER);
}

/** The full provisioning deps a group's OS user needs (shared with POST /groups):
 *  pot wiring. */
function provisionOsUserFor(g: Group): Promise<unknown> {
  return provisionGroupUser(g, {
    run: runPrivileged,
    seed: seedGroupHome,
    homeBase: GROUP_HOME_BASE,
    userExists: osUserExists,
    sharedPotPath: SHARED_POT_PATH,
  });
}

/**
 * Task 16 — the invite→provision hook. When a person REDEEMS their invitation
 * (the unprivileged path kicks this privileged step server-side), make sure their
 * SEALED private group exists and its OS user is provisioned.
 *
 * No-op in mono-tenant (there are no private groups), so a non-capable instance
 * stays byte-for-byte today. Idempotent: a password-reset redeem (the account +
 * group already exist) re-provisions the EXISTING group rather than minting a
 * twin — `provisionGroupUser` is itself idempotent (`userExists` skips useradd).
 *
 * PROVISION POLICY — best-effort, never block sign-in (the brief). The group ROW
 * is persisted FIRST, then the OS user is provisioned; a provision failure is
 * CAUGHT and logged loudly, not thrown into the redeem. Persisting the row first
 * is what makes the failure self-heal: `ensureGroupsProvisioned()` runs on EVERY
 * capable boot — INDEPENDENT of the migration marker — and re-provisions any
 * persisted private/restricted group whose OS user is missing. So a transient
 * failure here does not strand the person even on an already-migrated instance
 * (where the migration's own reprovision list never runs), and meanwhile the
 * account exists and they can sign in.
 */
async function ensurePrivateGroupProvisioned(accountName: string): Promise<void> {
  if (DEPLOYMENT_MODE !== "multi-tenant") return;
  const groups = loadGroups();
  let g = privateGroupFor(accountName, groups);
  if (!g) {
    g = newPrivateGroup(accountName, randomUUID(), Date.now());
    g.osUser = osUserFor(g);
    saveGroups([...groups, g]);
    console.log(`groups: created private group ${g.id.slice(0, 8)} for ${accountName} (invite redeemed)`);
  }
  try {
    await provisionOsUserFor(g);
  } catch (e) {
    // Best-effort: the account exists and the person signs in regardless; the
    // persisted row is re-provisioned at the next capable boot (reprovision list).
    console.error(
      `groups: provisioning private group for ${accountName} failed (will retry at next boot): ` +
        `${(e as Error)?.message ?? e}`,
    );
  }
}

/**
 * Task 16 (Important #1) — the boot provisioning reconciler. Runs on EVERY
 * capable (multi-tenant) boot, INDEPENDENT of the migration marker, so a persisted
 * private/restricted group whose OS user is missing is healed even on an already-
 * migrated instance — where `runGroupsMigration` returns early (marker + `main`
 * present) and its own reprovision list never runs. That is the gap that left a
 * person whose private-group ROW persisted but whose OS user failed to provision
 * (a transient `useradd`/credential error) permanently un-healed.
 *
 * Best-effort; `provisionGroupUser` is idempotent, so a group whose user already
 * exists is skipped (no `useradd`) and running this right after a fresh migration
 * finds everything present — which is why it is safe to wire AFTER migration.
 * Subsumes the docker-recreate reprovision for the steady state. No-op in
 * mono-tenant (no private groups), so a non-capable instance is byte-for-byte today.
 */
async function ensureGroupsProvisioned(): Promise<void> {
  if (DEPLOYMENT_MODE !== "multi-tenant") return;
  const r = await reconcileGroupProvisioning(loadGroups(), {
    userExists: osUserExists,
    provision: async (g) => {
      await provisionOsUserFor(g);
    },
    log: (m) => console.log(m),
  });
  if (r.provisioned.length || r.failed.length) {
    console.log(
      `groups: boot reprovision — ${r.provisioned.length} (re)provisioned, ` +
        `${r.present.length} already present, ${r.failed.length} failed`,
    );
  }
  // The bootstrap admin (the operator) has no accounts.json row, so neither the
  // invite-redeem hook nor the per-account migration loop ever fires for it.
  // Give it a Personal group here; idempotent (reuses an existing private group).
  await ensurePrivateGroupProvisioned(BOOTSTRAP_ADMIN);
}

/** Step 1 — create the non-root commons user `main` (+ HOME). Idempotent. */
async function migCreateCommonsUser(): Promise<void> {
  if (osUserExistsSync(COMMONS_USER)) return;
  const home = homeForUser(COMMONS_USER, GROUP_HOME_BASE);
  await runPrivileged("useradd", ["--create-home", "--home-dir", home, "--shell", "/bin/bash", COMMONS_USER]);
}

/** Step 2 — chown the root-owned tree (workspace, server data, Claude home) to
 *  `main`, ONCE. Files DO NOT move; only ownership changes, so the commons agent
 *  (now `main`) can read/write what it already worked on. Idempotent (chowning
 *  already-`main`-owned files is a no-op), best-effort per target. */
async function migChownTreeToCommons(): Promise<void> {
  const targets = [process.cwd(), path.join(os.homedir(), ".shadok-ai"), path.join(os.homedir(), ".claude")];
  const owner = `${COMMONS_USER}:${COMMONS_USER}`;
  for (const t of targets) {
    if (!t || !fs.existsSync(t)) continue;
    await runPrivileged("chown", ["-R", owner, t]);
  }
  // RELOCATE the commons agent's Claude state into its OWN HOME. Chowning
  // ~/.claude alone is useless: the files stay under `/root` (0700), which `main`
  // cannot even traverse — so `claude --resume <id>` (now running as `main` from
  // /home/main) never finds a PRE-migration transcript and exits instantly,
  // stranding every agent that predates the migration on the FIRST restart (the
  // home agent included). `--resume` reads `~/.claude/projects`; move that and
  // the state a resumed session reads beside it. Copy (never destructive in a
  // migration) and non-clobbering (a re-run, or a hand-repair, may already hold
  // the file). chown each to `main`.
  const srcClaude = path.join(os.homedir(), ".claude");
  const dstClaude = path.join(homeForUser(COMMONS_USER, GROUP_HOME_BASE), ".claude");
  if (fs.existsSync(srcClaude)) {
    await runPrivileged("install", ["-d", "-o", COMMONS_USER, "-g", COMMONS_USER, "-m", "700", dstClaude]);
    for (const sub of ["projects", "todos", "shell-snapshots", "file-history"]) {
      const s = path.join(srcClaude, sub);
      if (!fs.existsSync(s)) continue;
      const d = path.join(dstClaude, sub);
      await runPrivileged("install", ["-d", "-o", COMMONS_USER, "-g", COMMONS_USER, d]);
      await runPrivileged("cp", ["-rn", `${s}/.`, `${d}/`]);
      await runPrivileged("chown", ["-R", owner, d]);
    }
    const hist = path.join(srcClaude, "history.jsonl");
    const dhist = path.join(dstClaude, "history.jsonl");
    if (fs.existsSync(hist) && !fs.existsSync(dhist)) {
      await runPrivileged("cp", ["-n", hist, dhist]);
      await runPrivileged("chown", [owner, dhist]);
    }
  }
}

/** Step 3 — wire the commons HOME to the shared pot: the shared group, the pot
 *  base, and the `~/shared` link. Mirrors `sharedPotPlan` for the commons `main`
 *  user. Non-core: there is no credential to seed (the agent token is injected at
 *  spawn), so nothing here withholds the migration marker. */
async function migWireCommonsPot(): Promise<void> {
  const mainHome = homeForUser(COMMONS_USER, GROUP_HOME_BASE);
  await runPrivileged("groupadd", ["-f", SHARED_POT_GROUP]);
  await runPrivileged("usermod", ["-aG", SHARED_POT_GROUP, COMMONS_USER]);
  // Shared pot base (setgid, group shadok-shared).
  await runPrivileged("install", ["-d", "-o", "root", "-g", SHARED_POT_GROUP, "-m", "2770", SHARED_POT_PATH]);
  await runPrivileged("chmod", ["2770", SHARED_POT_PATH]);
  // HOME-side AS `main` (TOCTOU: root never writes through an agent-owned path).
  await runPrivileged("runuser", ["-u", COMMONS_USER, "--", "ln", "-sfn", SHARED_POT_PATH, `${mainHome}/shared`]);
}

/** Step 4 — flat vault → Main's slice. `loadVault` runs `normalizeVault`, which
 *  lifts a flat `{NAME:value}` map into Main (`migrateFlatVault`) and persists it;
 *  idempotent (an already-nested vault has nothing flat to migrate). */
function migVaultToMain(): void {
  loadVault();
}

/** Step 5a — provision one private group per account (owner as sole member).
 *  Idempotent: reuse an existing private group owned by the account rather than
 *  minting a twin. Minor #3: the group shape comes from the SAME `newPrivateGroup`
 *  the invite hook uses, so both creators agree on `members:[name]` (the owner is
 *  a member) — one source of truth rather than a members:[] / members:[name] split. */
async function migProvisionPrivateGroup(account: string): Promise<void> {
  const groups = loadGroups();
  let g = privateGroupFor(account, groups);
  if (!g) {
    g = newPrivateGroup(account, randomUUID(), Date.now());
    g.osUser = osUserFor(g);
    saveGroups([...groups, g]);
  }
  await provisionOsUserFor(g);
}

/** Step 5b — re-provision a persisted private/restricted group (docker-recreate
 *  carry: the group list survived on the volume but its OS user+HOME did not). */
async function migReprovisionGroup(gid: string): Promise<void> {
  const g = loadGroups().find((x) => x.id === gid);
  if (!g) return;
  await provisionOsUserFor(g);
}

/** Step 6 — label existing channels/groups public/commons: guarantee Main and
 *  normalise the group list. Channels with no group are already commons (Task 2),
 *  so nothing there is reclassified; the migration is additive. */
function migLabelExistingPublic(): void {
  saveGroups(ensureMainGroup(normalizeGroups(loadGroups())));
}

/** Respawn the running agents ONCE, one at a time — respawned, NOT re-adopted. A
 *  pre-migration tmux pane runs as root (invariant 25); killing it forces a fresh
 *  spawn under the new `main` drop on the next resume (history kept via --resume).
 *  Best-effort: a kill failure is logged, never fatal. */
async function migRespawnRunningAgents(ids: string[]): Promise<void> {
  for (const id of ids) {
    const name = "sk-" + id;
    try {
      if (!tmuxHasSession(name)) continue;
      // ENFORCE the kill, don't just fire it: a pane that outlives the kill would
      // be re-adopted as ROOT on the next resume (invariant 23/25 — `restartSession`
      // enforces for the same reason). Re-check, hard-kill again, and verify gone.
      tmuxKillSession(name);
      for (let i = 0; i < 30 && tmuxHasSession(name); i++) await sleep(100);
      if (tmuxHasSession(name)) {
        tmuxKillSession(name);
        for (let i = 0; i < 20 && tmuxHasSession(name); i++) await sleep(100);
      }
      if (tmuxHasSession(name)) {
        console.warn(
          `migrate: pane ${name.slice(0, 11)} OUTLIVED the kill — next resume may re-adopt a root pane ` +
            `(the adoption guard in TmuxPilot.start will then respawn it as ${COMMONS_USER})`,
        );
      } else {
        console.log(`migrate: killed root pane ${name.slice(0, 11)} — will respawn as ${COMMONS_USER} on next resume`);
      }
    } catch (e) {
      console.warn(`migrate: could not kill pane ${name.slice(0, 11)}: ${(e as Error)?.message ?? e}`);
    }
  }
}

/** Build the plan from what the instance IS and run it (fail-safe). Fire-and-
 *  forget at boot: a migration that is slow must never hang the boot, and a
 *  spawn that races it simply uses the pre-migration (root) drop until the
 *  marker flips. Flips `groupsMigrated` on success so later spawns drop to `main`. */
async function runGroupsMigration(): Promise<void> {
  groupsMigrated = alreadyMigratedNow();
  const plan = migrationPlan({
    alreadyMigrated: groupsMigrated,
    mode: DEPLOYMENT_MODE,
    accounts: loadAccounts().map((a) => a.name),
    existingGroups: loadGroups(),
  });
  if (!plan) return; // already migrated, or mono-tenant: nothing to do
  // A real migration is about to run: the commons is un-isolated until it lands.
  migrationState = "pending";
  broadcastAll(versionMessage()); // open tabs show the pending banner live
  await runMigration(plan, {
    createCommonsUser: migCreateCommonsUser,
    chownTreeToCommons: migChownTreeToCommons,
    wireCommonsPot: migWireCommonsPot,
    migrateVaultToMain: migVaultToMain,
    provisionPrivateGroup: migProvisionPrivateGroup,
    reprovisionGroup: migReprovisionGroup,
    labelExistingPublic: migLabelExistingPublic,
    markerExists: migrationMarkerExists,
    writeMarker: writeMigrationMarker,
    respawnIds: respawnPlan(loadChannels()),
    respawn: migRespawnRunningAgents,
    log: (m) => console.log(m),
  });
  // Re-evaluate: the marker is written only when the core steps succeeded, so
  // this flips to `main`-commons exactly when it is safe.
  groupsMigrated = alreadyMigratedNow();
  // If the marker did not land (a core step failed), the instance will NOT retry
  // until the next boot — surface it LOUDLY rather than let the commons sit
  // un-isolated in silence. Otherwise migration is done and there is nothing to show.
  migrationState = groupsMigrated ? "ok" : "failed";
  broadcastAll(versionMessage()); // tabs that saw "pending" must see the outcome
}

/**
 * Run the migration if it has something to do — at boot, AND re-tried after a
 * successful Claude sign-in. The second trigger is the fix for the fresh-instance
 * failure: a brand-new instance signs in AFTER boot, via the web card, and a
 * core step that failed in between would withhold the marker and show the red
 * "isolation did NOT complete" banner until a MANUAL restart. `startFirstAgent` is already re-fired from the same sign-in handler
 * for the mirror-image reason (a lead agent a signed-out boot could not start);
 * re-running the migration there makes a fresh instance heal itself the moment it
 * is signed in — no restart, no scary banner.
 *
 * Idempotent and safe to call repeatedly: `runGroupsMigration` short-circuits
 * once the instance is already migrated (the marker + `main` present), and the
 * in-flight guard keeps a sign-in that lands mid-boot-migration from starting a
 * second, overlapping run (both chown the same tree, both respawn the same panes).
 * No-op in mono-tenant. `reason` is logged so the two triggers stay legible.
 */
async function maybeRunGroupsMigration(reason: string): Promise<void> {
  if (DEPLOYMENT_MODE !== "multi-tenant") {
    groupsMigrated = migrationMarkerExists() && osUserExistsSync(COMMONS_USER);
    return;
  }
  if (migrationInFlight) {
    console.log(`migrate: ${reason} re-run skipped — a migration is already running`);
    return;
  }
  if (alreadyMigratedNow()) {
    // The DATA migration is done, but the boot RECONCILE still has to run on
    // every capable boot — it is INDEPENDENT of the migration marker (Task 16).
    // It heals a persisted private/restricted group whose OS user vanished on a
    // `docker rm`+recreate, and provisions the bootstrap admin's Personal group.
    // Regression guard: the pre-refactor boot path called `ensureGroupsProvisioned`
    // unconditionally via `.then()`; folding the migration into this helper must
    // NOT drop that call on an already-migrated instance (measured missing on the
    // mt373 test instance — no admin Personal group, no reprovision, after a plain
    // restart of a migrated instance).
    groupsMigrated = true;
    if (migrationState === "failed") {
      migrationState = "ok";
      broadcastAll(versionMessage());
    }
    await ensureGroupsProvisioned();
    return;
  }
  migrationInFlight = true;
  try {
    console.log(`migrate: running (${reason})`);
    await runGroupsMigration();
    await ensureGroupsProvisioned();
  } catch (e) {
    console.error(`migrate: ${reason} run error (ignored, boot/sign-in continues):`, (e as Error)?.message ?? e);
  } finally {
    migrationInFlight = false;
  }
}

// Create a group. A private/restricted group needs the privileged deployment:
// refuse CLEARLY in mono-tenant (capabilityRefusal) rather than create a group
// that cannot actually isolate. A public group provisions nothing (commons).
//
// BROWSER-ONLY (invariant 26, like `PUT /profiles`): this route provisions an
// OS user via `useradd` as root — an agent carries the bootstrap admin cookie
// and sends no `Origin`, so without this gate it could `curl` a privileged
// `useradd`. The flow (createGroupFlow) owns the guard order and the ordering.
app.post("/groups", async (req, res) => {
  const body = req.body ?? {};
  const nature: Nature =
    body.nature === "private" || body.nature === "restricted" || body.nature === "public" ? body.nature : "restricted";
  const r = await createGroupFlow(
    {
      fromBrowser: requestFromBrowser(req),
      instanceOk: channelWriteAllowed(instanceKey(), req.get("x-shadok-instance")),
      account: currentAccount(req),
      name: typeof body.name === "string" ? body.name : "",
      nature,
      mode: DEPLOYMENT_MODE,
    },
    {
      provision: (g) =>
        provisionGroupUser(g, {
          run: runPrivileged,
          seed: seedGroupHome,
          homeBase: GROUP_HOME_BASE,
          userExists: osUserExists,
          sharedPotPath: DEPLOYMENT_MODE === "multi-tenant" ? SHARED_POT_PATH : undefined,
        }).then(() => void 0),
      loadGroups,
      saveGroups,
      newId: randomUUID,
      now: Date.now,
    },
  );
  res.status(r.status).json(r.body);
});

// Delete a group: tear down its OS user and never strand its channels.
// BROWSER-ONLY for the same reason as POST (its mirror runs `userdel --remove`).
app.delete("/groups", async (req, res) => {
  const r = await deleteGroupFlow(
    {
      fromBrowser: requestFromBrowser(req),
      instanceOk: channelWriteAllowed(instanceKey(), req.get("x-shadok-instance")),
      account: currentAccount(req),
      id: String(req.query.id ?? body_id(req)),
      mode: DEPLOYMENT_MODE,
    },
    {
      loadGroups,
      saveGroups,
      loadChannels,
      teardown: (g) =>
        teardownGroupUser(g, {
          run: runPrivileged,
          homeBase: GROUP_HOME_BASE,
          killAgents: () => killGroupAgents(g.id),
        }),
    },
  );
  res.status(r.status).json(r.body);
});

/** The group id may arrive on the query string or in a JSON body. */
function body_id(req: { body?: any }): string {
  return typeof req.body?.id === "string" ? req.body.id : "";
}

// Central secret vault (per-group, stored 600 outside any repo). Values are
// NEVER returned — only names. A profile references names to inject them.
//
// ACL (T10): GET returns only the names the caller's groups resolve (own +
// shared-in + Main), each tagged by source; a WRITE lands in the caller's OWN
// group (identity-derived, never the body) and requires owner-group membership.
// Mono-tenant resolves everyone to Main, so this is byte-for-byte today.
app.get("/secrets", (req, res) => {
  const { viewer } = secretCaller(req);
  // A public non-Main group's secrets are visible to everyone who sees the group
  // (operator decision 2026-11-03: "public = commun") — `secretOwnGroupIds` adds
  // them to the member set, so a secret added to a public group no longer
  // vanishes from the panel. Member-only groups stay member-gated.
  const list = visibleSecrets(loadVault(), secretOwnGroupIds(loadGroups(), viewer));
  // `names` stays a string[] for the existing client; `secrets` carries the tags.
  res.json({ names: list.map((s) => s.name), secrets: list });
});
app.put("/secrets", (req, res) => {
  const { name, value, overwrite } = req.body ?? {};
  if (typeof name !== "string" || !name.trim() || typeof value !== "string")
    return res.status(400).json({ error: "name and value required" });
  const key = name.trim();
  // Reserved server-owned secrets are set only via setSecret() server-side,
  // never through this endpoint (the filtered listing would make them look new).
  if (RESERVED_SECRET_NAMES.has(key)) return res.status(403).json({ error: "reserved" });
  // HTTP is the ONLY way an agent can reach the vault — it is a separate
  // process, and Telegram's /secret calls setSecret() directly. So guarding
  // here guards exactly the machine path, and nothing a human does by hand.
  //
  // Owner-group gate (T9/T10 carry): resolve the target group from the caller's
  // IDENTITY (never the body) and refuse a write the caller may not make.
  const target = secretWriteTarget(req);
  if ("refused" in target) return res.status(403).json({ error: target.refused });
  const ownerGroup = target.ownerGroup;
  const verdict = secretWriteVerdict(secretNames(ownerGroup).includes(key), overwrite === true);
  if (verdict === "refused") return res.status(409).json({ error: "exists", name: key });
  // createdBy is STAMPED server-side (the agent's session or the account) — a
  // client-claimed owner/createdBy is ignored by construction.
  setSecret(key, value, ownerGroup, secretCreatedBy(req));
  recordSecretAudit({ action: verdict, secrets: [key], ...auditActorOf(req), instance: process.cwd() });
  // Remember WHO created it, so the agent can later attach it to its own
  // profile (`PUT /profiles/secret`). Only on a creation: recording an
  // overwrite too would let an agent clobber a human's secret to become its
  // "creator" and then claim the name.
  if (verdict === "created") {
    const { profile } = callerOf(req);
    if (profile) recordOrigin(key, profile);
  }
  res.json({ names: secretNames(ownerGroup), result: verdict });
});
// Edit a secret's SHARING (the groups it is lent to) — the name↔group link
// lives on the secrets side. Owner-group gated, like every vault write.
app.put("/secrets/share", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const sharedWith = Array.isArray(req.body?.sharedWith) ? req.body.sharedWith.map(String) : [];
  if (!name) return res.status(400).json({ error: "name required" });
  const target = secretWriteTarget(req);
  if ("refused" in target) return res.status(403).json({ error: target.refused });
  if (!setSecretSharing(name, target.ownerGroup, sharedWith))
    return res.status(404).json({ error: "no such secret in your group", name });
  res.json({ ok: true });
});
// Edit a secret's PROFILE binding (the profiles it is injected into). Same gate.
app.put("/secrets/profiles", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const profiles = Array.isArray(req.body?.profiles) ? req.body.profiles.map(String) : [];
  if (!name) return res.status(400).json({ error: "name required" });
  const target = secretWriteTarget(req);
  if ("refused" in target) return res.status(403).json({ error: target.refused });
  if (!setSecretProfiles(name, target.ownerGroup, profiles))
    return res.status(404).json({ error: "no such secret in your group", name });
  res.json({ ok: true });
});
// Who wrote, attached and RECEIVED which secret (names only). Admin only: it
// maps every credential to the agents and people that held it. See
// src/secret-audit.ts.
app.get("/secrets/audit", (req, res) => {
  if (currentAccount(req)?.role !== "admin") return res.status(403).json({ error: "admins only" });
  const q = req.query;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 5000);
  const since = Number(q.since) || undefined;
  res.json({
    rows: filterAudit(readSecretAudit(), {
      secret: str(q.secret),
      actor: str(q.actor),
      agent: str(q.agent),
      action: str(q.action),
      since,
      limit,
    }),
  });
});
app.delete("/secrets", (req, res) => {
  const name = String(req.query.name ?? req.body?.name ?? "").trim();
  // Owner-group gated, like PUT: you can only delete from your own group.
  const target = secretWriteTarget(req);
  if ("refused" in target) return res.status(403).json({ error: target.refused });
  const ownerGroup = target.ownerGroup;
  if (name && secretNames(ownerGroup).includes(name)) {
    deleteSecret(name, ownerGroup);
    recordSecretAudit({ action: "deleted", secrets: [name], ...auditActorOf(req), instance: process.cwd() });
  }
  res.json({ names: secretNames(ownerGroup) });
});

// Finish an OAuth sign-in whose redirect points at an agent's localhost port,
// unreachable from a browser on another machine (container, remote box). The
// person pastes the address that failed to load; we open it from here. Browser
// only: the address carries a one-time sign-in code. See src/oauth-relay.ts.
app.post("/oauth-relay", async (req, res) => {
  if (!requestFromBrowser(req)) return res.status(403).json({ ok: false, error: "web UI only" });
  const r = await relayOAuthCallback(req.body?.url);
  res.status(r.ok ? 200 : 400).json(r);
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
  /** What the 403 says the caller is not allowed to do. The guard is reused
   *  beyond accounts (e.g. the Telegram config), so the message names the act. */
  what = "manage accounts",
): { name: string; role: Role } | null {
  if (browserOnly && !requestFromBrowser(req)) {
    res.status(403).json({ error: "same-origin browser only" });
    return null;
  }
  // With two-factor on, only a PERSON manages accounts: an agent's session key
  // is the bootstrap admin, and must not be able to reset anyone.
  const me = twoFactorOn() ? cookieAccount(req) : currentAccount(req);
  if (me?.role !== "admin") {
    res.status(403).json({ error: `only an admin can ${what}` });
    return null;
  }
  return me;
}

/** Accounts are listed to admins only: a member has no use for the list, and
 *  the shortest surface wins. Hashes and live invitation tokens never leave. */
app.get("/users", (req, res) => {
  if (!accountAdmin(req, res, false)) return;
  settleRequests();
  res.json(
    loadAccounts().map((a) => ({
      name: a.name,
      role: a.role,
      pending: !a.passwordHash,
      passkeys: a.passkeys?.length ?? 0,
      expiresAt: a.invite?.expiresAt ?? null,
    })),
  );
});

// The roster a member-picker needs: NAMES ONLY. `GET /users` is admin-only and
// carries role/pending/passkeys; a group's members must be choosable by anyone
// who can see the group, so this exposes the one field that is not sensitive.
app.get("/accounts", (req, res) => {
  if (!currentAccount(req)) return res.status(401).json({ error: "sign in first" });
  const names = loadAccounts().map((a) => a.name);
  // The bootstrap admin is the password itself, not a stored account.
  if (GUI_PASSWORD && !names.includes(BOOTSTRAP_ADMIN)) names.unshift(BOOTSTRAP_ADMIN);
  res.json(names);
});

// Create AND issue the invitation in one step: an account with no way in is a
// dead row, and two calls would let one succeed without the other.
app.post("/users", async (req, res) => {
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
  if (!(await stepUpIfTwoFactor(req, res, me!))) return;
  const invite = newInvite(Date.now());
  saveAccounts([...loadAccounts(), { name, role, createdAt: Date.now(), invite }]);
  console.log(`users: ${me!.name} invited ${name} as ${role}`);
  recordEvent({ kind: "invited", actor: me!.name, target: name, detail: role });
  res.json({ ok: true, name, role, inviteUrl: `/invite/${invite.token}` });
});

app.delete("/users", async (req, res) => {
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
  const keep = keepsTwoAdminsVerdict(twoFactorOn(), list.filter((a) => a.name !== name));
  if (!keep.ok) return res.status(400).json({ error: keep.error });

  // Task 16 — deleting an account in multi-tenant CASCADES to its sealed private
  // group: OS user, HOME and running agents are destroyed, and the data is gone
  // for good (no break-glass — nobody, not even this admin, ever reads it). That
  // is irreversible, so demand an EXPLICIT confirmation before the destroy; the
  // body names what will be lost so the client can show "permanently destroys X's
  // private space, which cannot be inspected". Server-authoritative: a client that
  // does not pass `confirm` gets a 409 and must re-submit. A person with no private
  // group (or mono-tenant) is NOT gated — nothing irreversible happens.
  const priv = DEPLOYMENT_MODE === "multi-tenant" ? privateGroupFor(name, loadGroups()) : null;
  const confirmed =
    req.query.confirm === "1" || req.query.confirm === "true" || req.body?.confirm === true;
  if (priv && !confirmed) {
    return res.status(409).json({
      error: "confirmation required",
      confirmation: {
        account: name,
        group: priv.id,
        message: `Deleting ${name} permanently destroys ${name}'s private space, which cannot be inspected. This cannot be undone.`,
      },
    });
  }

  if (!(await stepUpIfTwoFactor(req, res, me!))) return;
  saveAccounts(loadAccounts().filter((a) => a.name !== name));
  console.log(`users: ${me!.name} removed ${name}`);
  recordEvent({ kind: "removed", actor: me!.name, target: name });

  // The cascade (multi-tenant only). `accountDeleteGroups` decides: tear down ONLY
  // this person's private group (its agents + OS user + HOME), and DROP them from
  // every restricted group they belonged to WITHOUT tearing those down.
  //
  // ORDERING IS LOAD-BEARING — the group row is REMOVED (and memberships dropped)
  // via `saveGroups` BEFORE the `await teardownGroupUser`, for two reasons:
  //  1. STALE-SAVE: the `userdel --remove` can take a while; persisting AFTER it
  //     would let a concurrent group edit during that wait be overwritten by the
  //     pre-await snapshot. So we re-read `loadGroups()` immediately before the
  //     save (invariant 6 — also covers the step-up await above, a passkey wait).
  //  2. OWNERLESS-ROW REUSE LEAK: if a crash interrupted the teardown with the row
  //     still on disk, it would be an OWNERLESS private-group row; re-inviting the
  //     SAME account name matches it via `privateGroupFor` (owner match) and would
  //     REUSE its `sk-<id>` user + HOME — handing the new person the deleted
  //     person's data. With the row gone FIRST, a re-invite always mints a FRESH
  //     private group (new id → new user) and can never reuse the old HOME; a
  //     teardown failure then leaves at worst an ORPHAN OS user/HOME (surfaced as a
  //     warning), never a reusable owner-matched row.
  // The teardown never throws, but its `userdel` warning is SURFACED to the admin
  // so an orphaned OS user/HOME does not go unnoticed.
  let warning: string | undefined;
  if (DEPLOYMENT_MODE === "multi-tenant") {
    const { torndown, groups } = accountDeleteGroups(name, loadGroups());
    saveGroups(groups); // row removed + memberships dropped BEFORE any await
    if (torndown) {
      const r = await teardownGroupUser(torndown, {
        run: runPrivileged,
        homeBase: GROUP_HOME_BASE,
        killAgents: () => killGroupAgents(torndown.id),
      });
      if (!r.ok) warning = r.warning;
    }
  }
  res.json(warning ? { ok: true, warning } : { ok: true });
});

app.post("/users/role", async (req, res) => {
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
  // With two-factor on, making or unmaking an admin needs a second admin: the
  // change becomes a request, approved from the Security panel.
  const current = list.find((a) => a.name === name);
  if (twoFactorOn() && current && current.role !== role && (role === "admin" || current.role === "admin")) {
    if (!(await stepUpOk(req, res, me!))) return;
    const a = askRequest(me!, role === "admin" ? "promote" : "demote", name);
    if (!a.ok) return res.status(400).json({ error: a.error });
    return res.json({ ok: true, pending: true, request: { ...a.r, text: describeRequest(a.r) } });
  }
  // A demotion ends the sessions that were opened as an admin: the role is
  // re-read on every request anyway, but a session that was ridden while it
  // was admin should not survive the decision to demote.
  const plan = (src: Account[]): Account[] => {
    const now = Date.now();
    return src.map((a) =>
      a.name === name ? { ...a, role, ...(a.role === "admin" && role === "member" ? { sessionsAfter: now } : {}) } : a,
    );
  };
  // The two-admin rule is checked TWICE on purpose: here, so a change that
  // cannot land never asks for a passkey, and again below on the list as it
  // stands at the moment of the write.
  const pre = keepsTwoAdminsVerdict(twoFactorOn(), plan(list));
  if (!pre.ok) return res.status(400).json({ error: pre.error });
  if (!(await stepUpIfTwoFactor(req, res, me!))) return;
  // Re-read AFTER the step-up. That await waits for a human to touch a
  // passkey, so an account added or removed meanwhile would be erased by a
  // snapshot taken before it — invariant 6, a write must never persist a
  // stale list. The three sibling routes that step up already re-read
  // (`/users/add`, `/users/remove`, `/2fa/reset`); this one did not.
  const after = plan(loadAccounts());
  const keep = keepsTwoAdminsVerdict(twoFactorOn(), after);
  if (!keep.ok) return res.status(400).json({ error: keep.error });
  saveAccounts(after);
  console.log(`users: ${me!.name} made ${name} ${role}`);
  recordEvent({ kind: "role-changed", actor: me!.name, target: name, detail: role });
  res.json({ ok: true });
});

// ── Two-factor management (behind the gate) ──────────────────────────────────
// Every route here is for a PERSON (`cookieAccount`), never an agent's key or a
// peer, and every write is browser-only — same CSRF rule as the account routes.

/** The signed-in person, or answers 403. Writes require a same-origin browser. */
function tfaPerson(req: express.Request, res: express.Response, write: boolean): { name: string; role: Role } | null {
  if (write && !requestFromBrowser(req)) {
    res.status(403).json({ error: "same-origin browser only" });
    return null;
  }
  const me = cookieAccount(req);
  if (!me) {
    res.status(403).json({ error: "sign in with your own account" });
    return null;
  }
  return me;
}

app.get("/2fa", (req, res) => {
  const me = tfaPerson(req, res, false);
  if (!me) return;
  const accounts = loadAccounts();
  const acct = accounts.find((a) => a.name === me.name);
  const verdict = twoFactorEnableVerdict({ passwordSet: !!GUI_PASSWORD, actor: me, accounts });
  res.json({
    enabled: twoFactorOn(),
    me: me.name,
    named: me.name !== BOOTSTRAP_ADMIN,
    passkeys: (acct?.passkeys ?? []).map(publicPasskey),
    canEnable: verdict.ok ? null : verdict.error,
    adminsReady: admins2fa(accounts).length,
  });
});

/** A challenge for a fresh passkey confirmation (see `stepUpOk`). */
app.post("/2fa/confirm/options", async (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  const rp = rpFor(req);
  const acct = loadAccounts().find((a) => a.name === me.name);
  if (!rp || !acct?.passkeys?.length) return res.status(400).json({ error: "you have no passkey on this account yet" });
  const options = await authenticationOptions(rp, acct);
  res.json({ options, challengeId: putChallenge(options.challenge, me.name, "stepup") });
});

/** Register a passkey on THIS device for the signed-in person. Allowed with 2FA
 *  off (setting up before switching on) and with a verified session. */
app.post("/2fa/register/options", async (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  if (me.name === BOOTSTRAP_ADMIN) return res.status(400).json({ error: "the instance password cannot hold a passkey — use your own named account" });
  const rp = rpFor(req);
  const acct = loadAccounts().find((a) => a.name === me.name);
  if (!rp || !acct) return res.status(400).json({ error: "no such account" });
  const options = await registrationOptions(rp, acct);
  res.json({ options, challengeId: putChallenge(options.challenge, me.name, "register") });
});

app.post("/2fa/register", async (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  const rp = rpFor(req);
  const challenge = takeChallenge(req.body?.challengeId, me.name, "register");
  if (!rp || !challenge) return res.status(400).json({ error: "start again" });
  const pk = await verifyRegistration(rp, challenge, req.body?.response, req.body?.label, Date.now());
  if (!pk) return res.status(400).json({ error: "the passkey could not be registered" });
  updateAccount(me.name, (a) => ({ ...a, passkeys: [...(a.passkeys ?? []), pk] }));
  console.log(`2fa: ${me.name} registered a passkey (${pk.label})`);
  recordEvent({ kind: "passkey-added", actor: me.name, target: me.name, detail: pk.label, passkeyId: pk.id });
  res.json({ ok: true, passkey: publicPasskey(pk) });
});

/** Remove one of your passkeys — or, as an admin with a fresh confirmation,
 *  someone else's (a lost device). */
app.post("/2fa/passkey/delete", async (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  const owner = String(req.body?.user ?? me.name);
  const id = String(req.body?.id ?? "");
  if (owner !== me.name) {
    if (me.role !== "admin") return res.status(403).json({ error: "only an admin can remove someone else's passkey" });
    if (!(await stepUpOk(req, res, me))) return;
  }
  const list = loadAccounts();
  // A removed passkey is usually a LOST device, and that device may still hold
  // a signed-in session: end them all. The person removing their own passkey
  // gets a fresh cookie, so the device they are using stays signed in.
  const now = Date.now();
  const after = list.map((a) =>
    a.name === owner ? { ...a, passkeys: (a.passkeys ?? []).filter((p) => p.id !== id), sessionsAfter: now } : a,
  );
  const keep = keepsTwoAdminsVerdict(twoFactorOn(), after);
  if (!keep.ok) return res.status(400).json({ error: keep.error });
  if (twoFactorOn() && owner === me.name && !after.find((a) => a.name === owner)?.passkeys?.length)
    return res.status(400).json({ error: "that is your last passkey — with two-factor on you could no longer sign in" });
  saveAccounts(after);
  if (owner === me.name) res.setHeader("Set-Cookie", sessionCookie(me.name, !!cookieSession(req)?.mfa));
  console.log(`2fa: ${me.name} removed a passkey of ${owner}`);
  recordEvent({ kind: "passkey-removed", actor: me.name, target: owner });
  res.json({ ok: true });
});

/**
 * An enrollment code — what lets ANOTHER device register a passkey while 2FA is
 * on. For yourself: your verified session is enough (you are adding your own
 * laptop from your phone). For someone else: an admin, with a fresh passkey
 * confirmation.
 */
app.post("/2fa/enroll-code", async (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  const target = String(req.body?.user ?? me.name);
  if (target === BOOTSTRAP_ADMIN) return res.status(400).json({ error: "the instance password cannot hold a passkey" });
  if (target !== me.name) {
    if (me.role !== "admin") return res.status(403).json({ error: "only an admin can issue a code for someone else" });
    // A first device for someone who never had one stays a one-admin act (v1
    // § 6). A NEW device for someone who has passkeys is a lost-passkey
    // recovery, and that needs a second admin.
    if (twoFactorOn() && loadAccounts().find((a) => a.name === target)?.passkeys?.length)
      return res.status(400).json({ error: `${target} already has a passkey — use Recover access → lost passkey (a second admin approves)` });
    if (!(await stepUpOk(req, res, me))) return;
  } else if (!loadAccounts().find((a) => a.name === me.name)?.passkeys?.length) {
    return res.status(400).json({ error: "register a passkey on this device first" });
  }
  if (!loadAccounts().some((a) => a.name === target)) return res.status(400).json({ error: `no such account: ${target}` });
  const enroll = newEnrollCode(Date.now(), me.name);
  updateAccount(target, (a) => ({ ...a, enroll }));
  console.log(`2fa: ${me.name} issued an enrollment code for ${target}`);
  recordEvent({ kind: "device-code", actor: me.name, target });
  res.json({ ok: true, user: target, code: enroll.code, expiresAt: enroll.expiresAt });
});

/**
 * Lost password or lost device: ANOTHER admin resets the person. Their password
 * and every passkey go; they get a fresh invitation link, which also authorises
 * registering a new passkey. Needs a fresh passkey confirmation from the admin.
 */
// ── Security panel (spec 2026-10-28 § 6): what was done to accounts, and
// "this wasn't me". Like the rest of /2fa, for a PERSON only.
app.get("/2fa/inbox", (req, res) => {
  const me = tfaPerson(req, res, false);
  if (!me) return;
  settleRequests();
  const inbox = inboxFor(me, loadEvents());
  const line = <T extends SecEvent>(e: T) => ({ ...e, text: describeEvent(e) });
  const now = Date.now();
  const reqs = requestsFor(me, loadRequests(), now);
  // A handover (reset link, device code) is shown to the two admins involved
  // and nobody else: it is a way into someone's account.
  const view = (r: AdminRequest) => {
    const { handover, ...rest } = r;
    const mayHand = handover && (me.name === r.by || me.name === r.approvedBy);
    return { ...rest, text: describeRequest(r), ...(mayHand ? { handover } : {}) };
  };
  res.json({
    aboutYou: inbox.aboutYou.map(line),
    log: inbox.log.map(line),
    waiting: reqs.waiting.map(view),
    mine: reqs.mine.map(view),
    badge: inbox.badge + reqs.waiting.length,
  });
});
app.post("/2fa/inbox/seen", (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  saveEvents(markSeen(loadEvents(), me));
  res.json({ ok: true });
});
/**
 * "This wasn't me", from the panel — so from the signed-in target themself. It
 * ends every OTHER session of the account (this one is re-issued), removes a
 * passkey nobody admits to adding, and flags it to every admin. It does not
 * lock the account: the person clicking is, by construction, signed in as its
 * owner.
 */
app.post("/2fa/not-me", (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  const events = loadEvents();
  const ev = events.find((e) => e.id === String(req.body?.id ?? ""));
  const v = notMeEffect(ev, me.name);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const now = Date.now();
  updateAccount(me.name, (a) => ({
    ...a,
    sessionsAfter: now,
    ...(v.removePasskey ? { passkeys: (a.passkeys ?? []).filter((p) => p.id !== v.removePasskey) } : {}),
  }));
  if (v.cancelRequest) closeRequest(v.cancelRequest, "cancelled", me.name);
  res.setHeader("Set-Cookie", sessionCookie(me.name, !!cookieSession(req)?.mfa));
  saveEvents(events.map((e) => (e.id === ev!.id ? { ...e, disowned: true } : e)));
  recordEvent({ kind: "not-me", actor: me.name, target: me.name, about: ev!.id, detail: describeEvent(ev!) });
  console.log(`2fa: ${me.name} reported "this wasn't me" on ${ev!.kind}`);
  res.json({ ok: true, removedPasskey: !!v.removePasskey });
});

// ── Two-admin requests and recovery levels (spec 2026-10-28 §§ 4–5) ──────────

/** Record what happened to a request, for its target and the log. */
function requestEvent(r: AdminRequest, actor: string, what: string): void {
  recordEvent({ kind: "request", actor, target: r.target, requestId: r.id, detail: `${what}: ${describeRequest(r)}` });
}

/** Close an open request (cancelled / refused). */
function closeRequest(id: string, outcome: "cancelled" | "refused", who: string): AdminRequest | null {
  const list = loadRequests();
  const r = list.find((x) => x.id === id);
  if (!r || !isOpen(r)) return null;
  const closed = { ...r, doneAt: Date.now(), outcome, closedBy: who };
  saveRequests(list.map((x) => (x.id === id ? closed : x)));
  requestEvent(closed, who, outcome);
  console.log(`2fa: ${who} ${outcome} the request ${r.kind} on ${r.target}`);
  return closed;
}

/**
 * Carry a request out. Returns an error (and changes nothing) when the state
 * no longer allows it — e.g. a demotion that would now leave fewer than two
 * admins with a passkey: the check is on the state at the moment of applying.
 */
function applyRequest(r: AdminRequest, approver: string | undefined): { ok: true; r: AdminRequest } | { ok: false; error: string } {
  const now = Date.now();
  const list = loadAccounts();
  const target = list.find((a) => a.name === r.target);
  if (!target) return { ok: false, error: `no such account: ${r.target}` };
  let accounts = list;
  let handover: AdminRequest["handover"];
  if (r.kind === "passkey-reset") {
    // A code that travels by hand gets 48 h, not the 10 min of a code typed
    // from one of your own devices to the other.
    const enroll = { ...newEnrollCode(now, r.by), expiresAt: now + REQUEST_TTL_MS };
    accounts = list.map((a) => (a.name === r.target ? { ...a, enroll, sessionsAfter: now } : a));
    handover = { kind: "code", value: enroll.code, expiresAt: enroll.expiresAt };
  } else if (r.kind === "full-reset") {
    const invite = newInvite(now);
    accounts = list.map((a) =>
      a.name === r.target ? { name: a.name, role: a.role, createdAt: a.createdAt, invite, sessionsAfter: now } : a,
    );
    handover = { kind: "link", value: `/invite/${invite.token}`, expiresAt: invite.expiresAt };
  } else {
    const role: Role = r.kind === "promote" ? "admin" : "member";
    accounts = list.map((a) =>
      a.name === r.target ? { ...a, role, ...(role === "member" ? { sessionsAfter: now } : {}) } : a,
    );
    const keep = keepsTwoAdminsVerdict(twoFactorOn(), accounts);
    if (!keep.ok) return { ok: false, error: keep.error };
  }
  saveAccounts(accounts);
  const done: AdminRequest = {
    ...r,
    ...(approver ? { approvedBy: approver } : {}),
    doneAt: now,
    outcome: "applied",
    ...(handover ? { handover } : {}),
  };
  saveRequests(loadRequests().map((x) => (x.id === r.id ? done : x)));
  requestEvent(done, approver ?? "the 24 h delay", "done");
  console.log(`2fa: request ${r.kind} on ${r.target} applied${approver ? ` (approved by ${approver})` : " (24 h elapsed)"}`);
  return { ok: true, r: done };
}

/** Expire what ran out, apply the full resets whose 24 h are over. Called by
 *  the reads that show requests — no timer to keep alive. */
function settleRequests(): void {
  const now = Date.now();
  const before = loadRequests();
  const after = expire(before, now);
  if (after.some((r, i) => r !== before[i])) saveRequests(after);
  for (const r of dueRequests(after, now)) applyRequest(r, undefined);
}

/** Ask for a two-admin request. */
function askRequest(me: { name: string; role: Role }, kind: RequestKind, target: string): { ok: true; r: AdminRequest } | { ok: false; error: string } {
  const v = askVerdict({ actor: me, kind, target, accounts: loadAccounts() });
  if (!v.ok) return v;
  const now = Date.now();
  const r = newRequest(kind, target, me.name, now);
  saveRequests(upsertRequest(loadRequests(), r, now));
  requestEvent(r, me.name, "asked");
  console.log(`2fa: ${me.name} asked for ${kind} on ${target}`);
  return { ok: true, r };
}

/**
 * Recover someone's access — the three levels.
 *  1 lost password, passkeys kept: one admin, a reset link at once.
 *  2 lost passkey, password known: two admins, then a device code.
 *  3 lost everything: a full reset, effective in 24 h or at a second admin's approval.
 * With two-factor OFF, levels 2 and 3 have nothing to protect and act at once
 * (a device code / the v1 reset), like before.
 */
app.post("/2fa/recover", async (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  const target = String(req.body?.user ?? "").trim();
  const level = Number(req.body?.level);
  if (![1, 2, 3].includes(level)) return res.status(400).json({ error: "level must be 1, 2 or 3" });
  const v = resetVerdict({ actor: me, target, accounts: loadAccounts() });
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (!(await stepUpOk(req, res, me))) return;
  const now = Date.now();
  if (level === 1) {
    if (!loadAccounts().find((a) => a.name === target)?.passwordHash)
      return res.status(400).json({ error: `${target} has no password yet — their invitation is still open` });
    const invite = { ...newInvite(now), reason: "password" as const };
    updateAccount(target, (a) => {
      const { passwordHash: _gone, ...rest } = a;
      return { ...rest, invite, sessionsAfter: now };
    });
    recordEvent({ kind: "access-reset", actor: me.name, target, detail: "password only — passkeys kept" });
    console.log(`2fa: ${me.name} reset the password of ${target} (passkeys kept)`);
    return res.json({ ok: true, level, handover: { kind: "link", value: `/invite/${invite.token}`, expiresAt: invite.expiresAt } });
  }
  if (!twoFactorOn()) {
    const r = applyRequest(newRequest(level === 2 ? "passkey-reset" : "full-reset", target, me.name, now), undefined);
    return r.ok ? res.json({ ok: true, level, handover: r.r.handover }) : res.status(400).json({ error: r.error });
  }
  const a = askRequest(me, level === 2 ? "passkey-reset" : "full-reset", target);
  if (!a.ok) return res.status(400).json({ error: a.error });
  res.json({ ok: true, level, pending: true, request: { ...a.r, text: describeRequest(a.r) } });
});

app.post("/2fa/requests/approve", async (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  settleRequests();
  const r = loadRequests().find((x) => x.id === String(req.body?.id ?? ""));
  const v = approveVerdict(r, me, Date.now());
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (!(await stepUpOk(req, res, me))) return;
  const done = applyRequest(r!, me.name);
  if (!done.ok) return res.status(400).json({ error: done.error });
  res.json({ ok: true, handover: done.r.handover ?? null });
});

/** Refuse (an admin who could approve) or cancel (the asker, any admin, or the
 *  person concerned). No passkey needed: stopping something is always safe. */
app.post("/2fa/requests/cancel", (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  const id = String(req.body?.id ?? "");
  const r = loadRequests().find((x) => x.id === id);
  const v = cancelVerdict(r, me);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const refused = me.name !== r!.by && me.name !== r!.target;
  closeRequest(id, refused ? "refused" : "cancelled", me.name);
  res.json({ ok: true });
});

app.post("/2fa/reset", async (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  // One admin wiping someone's second factor is exactly what v2 removed.
  if (twoFactorOn()) return res.status(400).json({ error: "with two-factor on, use Recover access (a full reset needs a second admin or 24 h)" });
  const target = String(req.body?.user ?? "").trim();
  const list = loadAccounts();
  const v = resetVerdict({ actor: me, target, accounts: list });
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (!(await stepUpOk(req, res, me))) return;
  const invite = newInvite(Date.now());
  saveAccounts(
    loadAccounts().map((a) =>
      a.name === target ? { name: a.name, role: a.role, createdAt: a.createdAt, invite, sessionsAfter: Date.now() } : a,
    ),
  );
  console.log(`2fa: ${me.name} reset the access of ${target}`);
  recordEvent({ kind: "access-reset", actor: me.name, target });
  res.json({ ok: true, user: target, inviteUrl: `/invite/${invite.token}` });
});

/** Switch two-factor on or off — an admin, with a fresh passkey confirmation. */
app.post("/2fa/enabled", async (req, res) => {
  const me = tfaPerson(req, res, true);
  if (!me) return;
  const on = req.body?.enabled === true;
  if (on) {
    const v = twoFactorEnableVerdict({ passwordSet: !!GUI_PASSWORD, actor: me, accounts: loadAccounts() });
    if (!v.ok) return res.status(400).json({ error: v.error });
  } else if (me.role !== "admin") {
    return res.status(403).json({ error: "only an admin can change two-factor sign-in" });
  }
  if (!(await stepUpOk(req, res, me))) return;
  setTwoFactorForCwd(loadConfig(), process.cwd(), on);
  console.log(`2fa: ${me.name} turned two-factor sign-in ${on ? "ON" : "off"}`);
  recordEvent({ kind: "two-factor", actor: me.name, target: "*", detail: on ? "on" : "off" });
  // Re-issue the actor's cookie with the second-factor flag: they just proved
  // it, and the switch would otherwise sign them out of their own tab.
  res.setHeader("Set-Cookie", sessionCookie(me.name, true));
  res.json({ ok: true, enabled: on });
});

// ── Peers: other instances/harnesses allowed to reach THIS one's agents ──────
// Admin-only, like /users — a peer credential is a grant of remote code
// execution on this machine (a peer can `spawn`), so it is deliberately made
// by an admin, named, and revocable. See src/peers.ts and the design spec.
app.get("/peers", (req, res) => {
  if (!accountAdmin(req, res, false)) return;
  res.json(
    loadPeers(peerFileFor()).map((p) => ({
      name: p.name,
      createdAt: p.createdAt,
      note: p.note ?? null,
      scope: peerScope(p),
      pending: !!p.invite,
    })),
  );
});
app.post("/peers", (req, res) => {
  const me = accountAdmin(req, res);
  if (!me) return;
  const name = normPeerName(req.body?.name);
  if (!name) return res.status(400).json({ error: "a peer name is required" });
  const note = typeof req.body?.note === "string" ? req.body.note.trim() || undefined : undefined;
  const brief = typeof req.body?.brief === "string" ? req.body.brief : "";
  // Scope: `restricted` (default — only the agents it spawns) or `member` (acts
  // like an invited user, sees and drives the whole cockpit). Anything but the
  // exact string "member" is restricted, so a stray value, an old client or a
  // body that forgot the key never hands out the whole cockpit by accident:
  // widening is always something a caller spelled out.
  const scope: "member" | "restricted" = req.body?.scope === "member" ? "member" : "restricted";
  const file = peerFileFor();
  const { peers, ticket } = newPeer(loadPeers(file), name, Date.now(), note, scope);
  savePeers(file, peers);
  console.log(`peers: ${me.name} invited peer ${name} (${scope})`);
  // What is handed out is a SINGLE-USE TICKET, not the credential — the peer
  // exchanges it at `POST /peers/enrol` for a durable token it then keeps. So the
  // long-lived credential never travels through this response, the invite prompt,
  // a chat, or the invitee's transcript; only a ticket that dies on first use
  // does. Exactly how a user's invitation link works (`/invite/:token`).
  // Re-inviting the same name re-rolls the salt, so any earlier token is dead.
  // The URL is the one the ADMIN is reaching us at (their browser origin), which
  // is the public URL an external agent would use too.
  const url = ((req.headers.origin as string | undefined)?.trim() || `http://${req.headers.host ?? "localhost"}`).replace(/\/+$/, "");
  res.json({ ok: true, name, ticket, scope, invitePrompt: agentInvitePrompt({ url, ticket, brief, scope }) });
});
app.delete("/peers", (req, res) => {
  const me = accountAdmin(req, res);
  if (!me) return;
  const name = normPeerName(req.query.name);
  if (!name) return res.status(400).json({ error: "a peer name is required" });
  const file = peerFileFor();
  savePeers(file, removePeer(loadPeers(file), name));
  // Revocation is immediate AND total: future auth fails (the registry check in
  // peerFromToken), and the peer's LIVE connections are dropped now — an open
  // pilotctl link must stop at once. The agents it spawned are LEFT for this
  // instance's admin to keep or stop (killing another party's in-flight work
  // silently is worse than orphaning it under local control).
  let dropped = 0;
  for (const c of wss.clients) {
    if ((c as WebSocket & { __peer?: string }).__peer === name) {
      try {
        c.terminate();
        dropped++;
      } catch {
        /* already gone */
      }
    }
  }
  console.log(`peers: ${me.name} revoked peer ${name} (${dropped} live connection(s) dropped)`);
  res.json({ ok: true, dropped });
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
    // Refused rather than stored: the CLI ignores an unknown --effort with a
    // warning, so a bad level saved here would run every agent of this role at
    // the default effort while the panel showed the one that was picked.
    effort: isEffortLevel(b.effort) ? b.effort : undefined,
  };
  if (b.effort !== undefined && b.effort !== "" && !isEffortLevel(b.effort))
    return res.status(400).json({ error: `unknown effort level: ${String(b.effort)}` });
  const mcp = mcpServersVerdict(b.mcpServers, Object.values(secretsFor(secretNames())));
  if (!mcp.ok) return res.status(400).json({ error: mcp.error });
  p.mcpServers = mcp.servers;
  const secretDiff = profileSecretDiff(getProfile(name)?.secrets, p.secrets);
  upsertProfile(p);
  auditProfileSecrets(req, name, secretDiff);
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
  const id = localSessionForKey(req, key);
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

/**
 * The second — and last — profile write an agent can make: attach to its OWN
 * profile a vault secret IT created, so the credential it obtained survives
 * into its next sessions instead of dying with this one.
 *
 * Everything dangerous about this is in `secretAttachVerdict`: the vault is
 * global, so attaching an arbitrary name would hand any agent every credential
 * on the machine. Only provenance is accepted, and the lead gets no exception.
 * Guardrails still cannot be reached — `deny`/`allow`/`model` are copied from
 * the stored profile, never read from the body.
 */
app.put("/profiles/secret", (req, res) => {
  const { profile: caller } = callerOf(req);
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const existing = caller ? getProfile(caller) : undefined;
  const verdict = secretAttachVerdict({
    caller,
    name,
    inVault: secretNames().includes(name),
    origin: originProfile(name),
  });
  if (!verdict.ok) return res.status(403).json({ error: verdict.error });
  if (!existing) return res.status(404).json({ error: `${caller} no longer exists` });
  // Start from the stored profile: guardrails survive by construction, not by
  // vigilance (same rule as /profiles/prompt).
  const secrets = [...new Set([...(existing.secrets ?? []), name])];
  upsertProfile({ ...existing, secrets });
  console.log(`profile-secret: ${caller} += ${name}`);
  if (!(existing.secrets ?? []).includes(name))
    recordSecretAudit({ action: "attached", secrets: [name], ...auditActorOf(req), profile: caller!, instance: process.cwd() });
  res.json({
    ok: true,
    profile: caller,
    secrets,
    note: "injected as an environment variable at your next reload, not in this process",
  });
});

// An agent reloads ITSELF (the `shadok-reload` skill) to pick up a changed pilot
// prompt or newly-seeded skills. Scoped by the per-session key, exactly like
// /profiles/prompt: the public session id proves nothing. Respond BEFORE the
// respawn — restartSession tears down the very process that made this call.
app.post("/reload", (req, res) => {
  const key = typeof req.body?.key === "string" ? req.body.key : "";
  const id = localSessionForKey(req, key);
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
  void restartSession(s, { actor: `agent ${id.slice(0, 8)}`, via: "agent" })
    .then(() => continueAfterReload(s.id))
    .catch(() => {});
});

app.delete("/profiles", (req, res) => {
  const name = String(req.query.name ?? req.body?.name ?? "").trim();
  if (name) {
    const before = getProfile(name)?.secrets;
    removeProfile(name);
    auditProfileSecrets(req, name, profileSecretDiff(before, []), "profile deleted");
  }
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
// The Telegram bot config is an instance-wide integration (one bot, one board,
// owned by whoever runs the cockpit), so reading or changing it is ADMIN-ONLY —
// a `member` has no business touching the bot token, the allowed chats or the
// on/off switch. GET is browserOnly:false (a same-origin read sends no Origin);
// PUT keeps the write-side CSRF guard.
app.get("/telegram", async (req, res) => {
  if (!accountAdmin(req, res, false, "view or change the Telegram configuration")) return;
  res.json(await telegramState());
});
app.put("/telegram", async (req, res) => {
  if (!accountAdmin(req, res, true, "view or change the Telegram configuration")) return;
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

// Pairing code for the bot (`src/tg-pairing.ts`): binding the board group or
// owning the DMs needs a code only this admin-only panel shows. POST issues a
// fresh one (revoking any previous code) and is the ONE response that carries
// it; GET reports whether one is live, never the code itself. Browser-only
// writes, like the rest of the Telegram config: an agent must not be able to
// mint a code and pair a Telegram account of its choosing.
app.get("/telegram/pairing", (req, res) => {
  if (!accountAdmin(req, res, false, "pair the Telegram bot")) return;
  res.json(pairingStatus());
});
app.post("/telegram/pairing", async (req, res) => {
  if (!accountAdmin(req, res, true, "pair the Telegram bot")) return;
  const p = issuePairingCode();
  const username = (await telegramState()).username;
  const bot = username ? String(username).replace(/^@/, "") : null;
  res.json({
    code: p.code,
    expiresAt: p.expiresAt,
    // Deep links: Telegram delivers `/start <code>` by itself, so one tap pairs.
    groupLink: bot ? `https://t.me/${bot}?startgroup=${p.code}` : null,
    dmLink: bot ? `https://t.me/${bot}?start=${p.code}` : null,
  });
});
app.delete("/telegram/pairing", (req, res) => {
  if (!accountAdmin(req, res, true, "pair the Telegram bot")) return;
  cancelPairingCode();
  res.json(pairingStatus());
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
  verifyClient: (info, cb) =>
    cb(requestOriginOk(info.req) && (requestAuthed(info.req) || peerName(info.req) !== null)),
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
// Shared-ledger reflex: ON by default. An explicit choice always wins — the
// config (GUI toggle / POST /ledger), or SHADOK_LEDGER, which can now force it
// EITHER way (`0`/`false` turns it off, not just `1` on). Only an instance that
// set neither falls through to the default, so a brand-new cockpit gets the
// ledger while any instance that already turned it off keeps that choice.
// Gates the pilot-prompt paragraph; a live agent picks it up at next respawn.
const ledgerEnv = (process.env.SHADOK_LEDGER ?? "").trim();
let ledgerEnabled: boolean =
  loadConfig().ledgerEnabled ?? (ledgerEnv ? /^(1|true|yes|on)$/i.test(ledgerEnv) : true);
// Most ledger changes to push ahead of one human prompt. It used to be 8 and
// the rest collapsed to a "+N more" line — i.e. a returning agent was told a
// number and not the rows, which is the silo this feature exists to close. The
// block is a LIST of pastes now, so what bounds it is the chunk ceiling in
// `formatLedgerChunks` (latency, not the paste wrapper) and no longer a count:
// this stays only as a second belt against a pathological table.
const LEDGER_PUSH_CAP = 40;
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
  return { current: OWN_VERSION, latest: latestKnown, autoUpdate, ledgerEnabled, permissionMode, updateChannel, mode: DEPLOYMENT_MODE, migrated: groupsMigrated, migrationState };
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
function restartAllSessions(ids?: string[], by: SpawnBy = SYSTEM_SPAWN): number {
  // A subset (e.g. only the agents flagged as needing a Claude Code reload) when
  // `ids` is given, all live sessions otherwise. Same one-at-a-time discipline.
  const wanted = ids && ids.length ? new Set(ids) : null;
  const live = [...sessions.values()].filter((s) => !wanted || wanted.has(s.id));
  void (async () => {
    for (const s of live) await restartSession(s, by).catch(() => {});
  })();
  return live.length;
}

// Restart agents from the GUI (they resume with history). Behind the same
// password gate as the other version-menu controls. Returns at once; the agents
// cycle one by one in the background. An optional `{sessions:[ids]}` body limits
// it to those agents — used by "Reload agents to apply update", which reloads only
// the ones flagged as running on the old Claude Code binary.
app.post("/restart-all", (req, res) => {
  const ids = Array.isArray(req.body?.sessions)
    ? (req.body.sessions as unknown[]).filter((x): x is string => typeof x === "string" && !!x)
    : undefined;
  const restarted = restartAllSessions(ids, auditActorOf(req));
  console.log(`restart-all: respawning ${restarted} agent(s)${ids ? " (filtered)" : ""}, one at a time`);
  res.json({ restarted });
});

// Download a file the agent delivered via SendUserFile. `session` + `path`.
//
// The path is NEVER trusted: it is served ONLY if it appears in that session's
// transcript as a sent attachment (`sentFilePaths`), so the endpoint can't be
// walked into an arbitrary file (/etc/passwd, another agent's secrets). And the
// response is neutralised for an agent-authored HTML/SVG: `attachment`
// disposition + `nosniff` + a `sandbox` CSP mean even navigating straight to it
// cannot run script in the cockpit's origin (which would reach the auth cookie).
// A raster image still renders in the chat's <img>, which ignores the
// disposition. Behind the password gate like everything else.
/**
 * An agent hands the user a file — shadok's own path, beside `SendUserFile`.
 *
 * It exists because the harness tool is NOT on every agent: a tmux agent keeps
 * the Claude Code binary it was spawned with, so one older than the tool never
 * sees it however the request is phrased. Authenticated by the per-session key
 * (invariant 33), which is derived and cannot age out — the cookie every agent
 * also carries expires after a week and nothing can refresh it in a running
 * process, which is precisely the failure this feature must not inherit.
 */
app.post("/files", (req, res) => {
  const key = String(req.headers["x-shadok-session-key"] ?? "");
  const id = localSessionForKey(req, key);
  if (!id) return res.status(403).json({ error: "unknown or missing session key" });
  const body = req.body ?? {};
  const raw = Array.isArray(body.paths) ? body.paths : body.path ? [body.path] : [];
  const paths = raw.filter((p: unknown): p is string => typeof p === "string" && !!p.trim());
  if (!paths.length) return res.status(400).json({ error: "give at least one path" });
  const caption = typeof body.caption === "string" ? body.caption : undefined;

  const file = filesFileFor(process.cwd());
  let rows = loadOffers(file);
  const accepted: OfferedFile[] = [];
  const refused: string[] = [];
  for (const p of paths) {
    const v = offerVerdict(id, p, statForOffer(p), Date.now(), caption);
    if (v.ok) { accepted.push(v.file); rows = withOffer(rows, v.file); }
    else refused.push(refusalMessage(v));
  }
  // Partial success is reported as such rather than collapsed either way: an
  // agent that sent three files and got one refused has to know WHICH.
  if (accepted.length) {
    saveOffers(file, rows);
    const s = sessions.get(id);
    if (s)
      broadcast(s, {
        type: "stream-tool",
        id: `file-${Date.now()}`,
        name: OFFER_TOOL,
        summary: caption?.trim() || accepted.map((f) => f.name).join(", "),
        files: accepted.map((f) => fileCard(f.path)),
      });
    console.log(`files: ${id.slice(0, 8)} offered ${accepted.map((f) => f.name).join(", ")}`);
  }
  if (!accepted.length) return res.status(400).json({ error: refused.join("; ") });
  res.json({ ok: true, sent: accepted.map((f) => ({ path: f.path, name: f.name, size: f.size })), refused });
});

/**
 * The session's history for the web, WITH the files it handed over via POST
 * /files (`ShadokFile`) merged back in as `file` turns.
 *
 * Those offers live in the offers REGISTRY, not the transcript — unlike
 * SendUserFile, which `loadHistory` already replays as `file` turns. So without
 * this a skill-delivered image showed once, LIVE, and then vanished on the next
 * reload (or when the agent's tab was reopened), while Telegram — which uploaded
 * the bytes — kept it. That mismatch is the reported "images show on Telegram but
 * not on the web". Interleaved by timestamp so a file lands where it was sent.
 */
function historyWithOffers(turns: HistoryTurn[], sessionId: string): HistoryTurn[] {
  const offers = loadOffers(filesFileFor(process.cwd())).filter((o) => o.sessionId === sessionId);
  if (!offers.length) return turns;
  const fileTurns: HistoryTurn[] = offers
    .slice()
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .map((o) => ({ role: "file", text: "", files: [fileCard(o.path)], ...(o.at ? { at: o.at } : {}) }));
  // Stable merge into the (chronological) transcript turns: an offer goes before
  // the first turn it does not predate; a turn with no timestamp keeps its place.
  const out: HistoryTurn[] = [];
  let oi = 0;
  for (const t of turns) {
    const tAt = t.at ?? Number.POSITIVE_INFINITY;
    while (oi < fileTurns.length && (fileTurns[oi].at ?? 0) <= tAt) out.push(fileTurns[oi++]);
    out.push(t);
  }
  while (oi < fileTurns.length) out.push(fileTurns[oi++]);
  return out;
}

// Stream a vetted file back to the browser, honouring a single `Range` so a
// <video> can seek and so Safari plays one at all (it demands a 206 before it
// will start). Images/PDF/etc. get the same path — Range is harmless there and
// helps a resumed download. A raster image or a video is served `inline` (the
// chat's <img>/<video> renders it, and opening the URL shows it); everything
// else — including SVG/HTML — downloads, under the same nosniff + sandbox CSP.
function serveStaticFile(
  req: express.Request, res: express.Response,
  filePath: string, stat: fs.Stats, name: string,
): void {
  const ct = contentTypeFor(name);
  const inline = (isImageFile(name) && ct !== "image/svg+xml") || isVideoFile(name);
  res.setHeader("Content-Type", ct);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${name.replace(/["\\]/g, "_")}"`);
  res.setHeader("Accept-Ranges", "bytes");
  const range = parseByteRange(req.headers.range, stat.size);
  if (range === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }
  const onErr = () => { if (!res.headersSent) res.status(500); res.end(); };
  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader("Content-Length", String(range.end - range.start + 1));
    fs.createReadStream(filePath, { start: range.start, end: range.end }).on("error", onErr).pipe(res);
    return;
  }
  res.setHeader("Content-Length", String(stat.size));
  fs.createReadStream(filePath).on("error", onErr).pipe(res);
}

app.get("/download", (req, res) => {
  const session = String(req.query.session ?? "");
  const wanted = String(req.query.path ?? "");
  if (!session || !wanted) return res.status(400).type("text").send("session and path required");
  const chan = loadChannels().find((c) => c.sessionId === session);
  if (!chan?.cwd) return res.status(404).type("text").send("unknown session");
  // TWO sources, one rule: a path is servable only if THIS session offered it,
  // through the harness tool (the transcript) or through POST /files (the
  // registry). Checking the registry FIRST costs one small JSON read and spares
  // the transcript read entirely for a skill-delivered file — which on a long
  // session is megabytes. A missing transcript is therefore no longer fatal:
  // an agent can hand over a file before it has written one.
  let allowed = offeredPaths(loadOffers(filesFileFor(process.cwd())), session).has(wanted);
  if (!allowed) {
    let raw: string;
    try { raw = fs.readFileSync(transcriptFilePath(chan.cwd, session, channelStateHome(chan)), "utf8"); }
    catch { return res.status(403).type("text").send("that file was not sent by this agent"); }
    allowed = sentFilePaths(raw).has(wanted);
  }
  if (!allowed) return res.status(403).type("text").send("that file was not sent by this agent");
  let stat: fs.Stats;
  try { stat = fs.statSync(wanted); if (!stat.isFile()) throw new Error("not a file"); }
  catch { return res.status(404).type("text").send("file no longer on disk"); }
  serveStaticFile(req, res, wanted, stat, path.basename(wanted));
});

// Serve a file the USER dropped / pasted (or a Telegram attachment) — they all
// land in MEDIA_DIR, referenced in the chat as `[Attached image: <path>]`. The
// web renders that inline instead of the raw path (both surfaces then SHOW the
// image). Scoped to MEDIA_DIR by BASENAME, so it can never be walked into another
// file: `path.basename` strips any directory, and the resolved path is checked to
// stay inside MEDIA_DIR. Behind the same password gate as everything else; the
// same `nosniff` + `sandbox` CSP as /download neutralises an SVG opened directly.
app.get("/media/:name", (req, res) => {
  const base = path.basename(String(req.params.name ?? ""));
  const dir = mediaDir();
  const file = path.join(dir, base);
  if (!file.startsWith(path.join(dir, path.sep)) && path.dirname(file) !== dir) {
    return res.status(400).type("text").send("bad name");
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(file); if (!stat.isFile()) throw new Error("not a file"); }
  catch { return res.status(404).type("text").send("no such media"); }
  serveStaticFile(req, res, file, stat, base);
});

// Install (or repair) the global Claude Code CLI on demand — `npm i -g
// @anthropic-ai/claude-code`. The cockpit shows this button when an agent's TUI
// footer reports "Auto-update failed"; running agents still need a reload
// afterwards to pick up the new binary (the client does that). BROWSER-ONLY: a
// deliberate operator action, not something an agent should trigger for the
// whole machine (cf. the profile-guardrail boundary). Single-flight so two
// clicks don't race two installs (ENOTEMPTY, see `rewriteInProgress`).
let claudeUpdateInFlight: Promise<void> | null = null;
app.post("/claude-update", async (req, res) => {
  if (!requestFromBrowser(req)) return res.status(403).json({ ok: false, error: "browser-only" });
  try {
    if (!claudeUpdateInFlight) {
      console.log("claude-update: installing @anthropic-ai/claude-code (npm i -g)…");
      claudeUpdateInFlight = installClaudeCli().finally(() => { claudeUpdateInFlight = null; });
    }
    await claudeUpdateInFlight;
    // The cached binary path rots on any reinstall (invariant 32): drop it so the
    // next spawn re-resolves the freshly installed launcher.
    claudeReady = null;
    rememberClaudeBin(null);
    console.log("claude-update: install ok");
    res.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.log(`claude-update: install FAILED — ${error}`);
    res.status(500).json({ ok: false, error });
  }
});

// The shared-ledger table — ONE per instance (keyed by the launch dir). Read by
// the GUI viewer (the version-menu / header button) AND by the `shadok-ledger`
// CLI's `check`/`list` (which run their own recall over these rows). Filtered by
// the CALLER's group, so another group's group-scoped rows never leak:
//  - an AGENT (its per-session key) → its CHANNEL's group ∪ public;
//  - a BROWSER → its member groups ∪ its commons home ∪ public (NO super-view,
//    so an admin sees no more than the groups they belong to).
// This replaces the old "return the Main file unfiltered" viewer, which showed
// Main-private rows to any authenticated member.
app.get("/ledger", (req, res) => {
  const rows = loadLedger(ledgerFileFor(process.cwd()));
  // The agent path FIRST: a session key makes `currentAccount` the bootstrap
  // admin, so reading the viewer's membership for an agent would hand it the
  // admin's whole reach instead of its own channel's group.
  const agentId = callerOf(req).id;
  const groupIds = agentId
    ? new Set([loadChannels().find((c) => c.sessionId === agentId)?.group ?? MAIN_GROUP_ID])
    : ledgerGroupsFor(loadGroups(), viewerFor(currentAccount(req)));
  const visible = scopeVisible(rows, groupIds, true);
  visible.sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
  // `kind` is DERIVED here, never stored (cf. the derived `crons` on /channels
  // and `origin` on /profiles): the rows recorded before kinds existed carry
  // none, and the inference belongs to the skill's core — one source, so the
  // client needs no copy of it.
  const entries = visible.map((r) => ({ ...r, kind: rowKind(r) }));
  res.json({ entries, enabled: ledgerEnabled });
});

// The ONE write path into the shared ledger. Agents never touch the file (it
// lives 0600 in the server HOME, unreadable to a privilege-dropped group user —
// the OS-user wall that the per-group-file `--public` mirror crashed on). The
// `shadok-ledger` CLI POSTs here with its `x-shadok-session-key`, exactly like
// the `shadok-secrets` skill reaches the vault. The authoring group is derived
// SERVER-SIDE from the caller's session→channel — never the body — and
// `recordIntoTable` scopes the upsert to that group, so a bare record can't
// delete another group's public row and an `--id` edit can't touch a row a
// different group authored.
app.post("/ledger/record", (req, res) => {
  const agentId = callerOf(req).id;
  if (!agentId) return res.status(403).json({ error: "ledger record requires an agent session key" });
  const group = loadChannels().find((c) => c.sessionId === agentId)?.group ?? null;
  const file = ledgerFileFor(process.cwd());
  const rows = loadLedger(file);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  try {
    const { rows: next, row } = recordIntoTable(
      rows,
      group,
      {
        id: str(b.id),
        entity: str(b.entity),
        status: str(b.status),
        kind: str(b.kind),
        note: str(b.note),
        source: str(b.source),
        verified: b.verified === true,
        public: b.public === true ? true : b.public === false ? false : undefined,
      },
      Date.now(),
      mintLedgerId(new Set(rows.map((r) => r.id).filter((x): x is string => !!x))),
    );
    saveLedger(file, next);
    res.json({ row });
  } catch (e) {
    // A bad id / missing entity / unknown kind is the agent's mistake, not ours.
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Resolve a stored group id to a `Group` for the talk ACL.
 *
 * A NULL id = the commons / group-less channel: synthesize a public Main group
 * so talk treats it as public (which is what the commons is), and mono-tenant —
 * where every channel is group-less — never trips the "cannot be verified" 403.
 * A NON-NULL id that does not resolve fails CLOSED (null), the twin of
 * `visibleChannels`/`canResumeAs`: never deliver a letter into a group we cannot
 * verify.
 */
function groupForTalk(gid: string | null): Group | null {
  if (!gid) {
    const groups = loadGroups();
    return (
      groups.find((g) => g.id === MAIN_GROUP_ID) ??
      groups.find((g) => g.nature === "public") ?? {
        id: MAIN_GROUP_ID,
        name: "Main",
        nature: "public",
        members: [],
        createdAt: 0,
      }
    );
  }
  return loadGroups().find((g) => g.id === gid) ?? null;
}

// Cross-group TALK: a narrow, consensual LETTER from one agent to another — the
// SANCTIONED, server-mediated channel that replaced native SendMessage. It is
// NOT a drive: the recipient reads the message in ITS OWN context under its own
// guardrails, and the sender NEVER receives the recipient's transcript/stream/
// files. Delivery is a server-side loopback (`driveChannel`), fully detached
// from the caller's HTTP request — the request only ever learns the letter was
// accepted and dispatched.
//
// The ACL is `talkVerdict`: a PUBLIC recipient is messageable freely; an agent
// in another RESTRICTED group only if the caller holds its HANDLE (an opaque
// token someone shared — there is no roster to enumerate); a PRIVATE recipient
// is sealed inbound with no break-glass. A PRIVATE sender may still write
// OUTWARD. The cross-group gate applies only in multi-tenant; mono-tenant is all
// Main/public, so talk is unrestricted (the verdict returns ok there anyway —
// public recipient — but the gate is explicit so the intent is readable).
//
// The SENDER's group is resolved SERVER-SIDE from its session→channel (never the
// body — a client could forge it). The RECIPIENT is resolved ONLY from a valid
// handle; a handle that does not verify, or verifies but names a channel that no
// longer exists, is ONE indistinguishable "unknown handle", so a caller cannot
// enumerate recipients by probing handles beyond a yes/no on one they already
// hold.
app.post("/talk", (req, res) => {
  const agentId = callerOf(req).id;
  if (!agentId) return res.status(403).json({ error: "talk requires an agent session key" });
  const b = (req.body ?? {}) as Record<string, unknown>;
  const handle = typeof b.handle === "string" ? b.handle.trim() : "";
  const message = typeof b.message === "string" ? b.message : "";
  if (!handle) return res.status(400).json({ error: "a recipient handle is required" });
  if (!message.trim()) return res.status(400).json({ error: "a message is required" });

  const recipientId = readTalkHandle(handle, signingSecret());
  const channels = loadChannels();
  const recipient = recipientId ? channels.find((c) => c.sessionId === recipientId) : undefined;
  if (!recipient) return res.status(404).json({ error: "unknown handle" });

  const senderGroupId = channels.find((c) => c.sessionId === agentId)?.group ?? null;
  const senderGroup = groupForTalk(senderGroupId);
  const recipientGroup = groupForTalk(recipient.group ?? null);
  if (!senderGroup || !recipientGroup)
    return res.status(403).json({ error: "that agent's group cannot be verified" });

  if (DEPLOYMENT_MODE === "multi-tenant") {
    // `hasHandle` is TRUE by construction: we only ever reach here with a handle
    // that verified to this recipient.
    const verdict = talkVerdict(senderGroup, recipientGroup, true);
    if (!verdict.ok) return res.status(403).json({ error: verdict.error });
  }

  // Deliver as a hidden agent-prompt LETTER over the SAME server-side loopback a
  // parent notification uses: the recipient's own context, its own guardrails,
  // and the SENDER's request is never wired to the recipient's output. Fire and
  // forget — awaiting would couple the sender to a turn that can run 30 minutes,
  // which is exactly what would make talk a drive.
  const letter = markAgentPrompt(talkLetter({ group: senderGroup.name }, message));
  const target = resolveSessionTarget(channels, recipient.sessionId, process.cwd());
  const tag = `talk: ${agentId.slice(0, 8)} → ${recipient.sessionId.slice(0, 8)}`;
  void driveChannel(recipient.sessionId, letter, target).then((r) => {
    console.log(r.ok ? `${tag} delivered` : `${tag} failed (${r.reason})`);
  });
  res.json({ ok: true, delivered: recipient.sessionId.slice(0, 8) });
});

// An agent's OWN talk handle — the minimal "here is a handle to me" exposure.
// Scoped by the caller's session key (`callerOf`), so an agent can mint a handle
// only to ITSELF: there is no route that lists or looks up another agent's
// handle, which is what keeps talk free of roster enumeration. HOW a handle then
// travels to a would-be sender is left OPEN (out of band — a human relays it, a
// shared note, a prompt); building a cross-group directory is explicitly out of
// scope for this task.
app.get("/talk/handle", (req, res) => {
  const agentId = callerOf(req).id;
  if (!agentId) return res.status(403).json({ error: "a talk handle requires an agent session key" });
  res.json({ handle: signTalkHandle(agentId, signingSecret()) });
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
  const restarted = changed ? restartAllSessions(undefined, auditActorOf(req)) : 0;
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

/**
 * What models this build offers, and which one is the machine-wide default.
 *
 * `families` is never empty and never depends on the scan: an alias always
 * works, so a binary that is mid-upgrade (invariant 32) costs discoverability
 * of exact versions, never the ability to choose a model at all.
 */
app.get("/models", (_req, res) => {
  res.json({
    families: MODEL_FAMILIES,
    models: availableModels(claudeCommand()),
    default: getDefaultModel(),
  });
});

// Writing it touches `~/.claude/settings.json`, which is MACHINE-wide, so this
// is browser-only for the same reason `PUT /profiles` is (invariant 26): an
// agent must not be able to move every other agent onto another model.
app.post("/models/default", (req, res) => {
  if (!requestFromBrowser(req)) return res.status(403).json({ error: "browser only" });
  const raw = req.body?.model;
  const model = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  // Accept an alias or a model this build actually knows — never free text.
  // A typo here would not fail loudly: the agent spawns and Claude Code picks
  // its own default, so the cockpit would show a pin that does nothing.
  const known = new Set<string>([...MODEL_FAMILIES, ...availableModels(claudeCommand())]);
  const bare = model?.replace(/\[1m\]$/i, "") ?? null;
  if (bare && !known.has(bare)) return res.status(400).json({ error: `unknown model: ${bare}` });
  if (!setDefaultModel(model)) return res.status(500).json({ error: "could not write settings.json" });
  console.log(`models: default is now ${model ?? "(none)"} — applies at each agent's next spawn`);
  res.json({ default: getDefaultModel() });
});

type ClientMessage =
  | {
      type: "start";
      /** NEW agent only: the target group; honoured iff the caller can see it. */
      group?: string;
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
      /** The model THIS agent runs on, overriding its profile's: an alias with
       *  an optional `[1m]` suffix (`public/model-choice.js` composes it).
       *  Omitted means the profile decides — the picker's default, and what
       *  every client that ignores this field keeps doing. */
      model?: string;
      /** How hard THIS agent thinks, overriding its profile's: one of
       *  `EFFORT_LEVELS`. Omitted means the profile decides — the picker's
       *  default, and what every client ignoring this field keeps doing. An
       *  unknown level is DROPPED rather than passed on: the CLI would only
       *  warn and run at the default. */
      effort?: string;
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
      /** The tab name to give a NEW agent (pilotctl `--name`). Applied only on a
       *  spawn — never on a resume, so it can't clobber a rename made in the UI.
       *  Omitted → the client derives a default from the profile/directory. */
      name?: string;
    }
  /** `force`: send despite a pace overrun. Applies to this message only. */
  /** `from`: display name of whoever typed it, when a client knows it (the
   *  Telegram bridge does). Echoed to the OTHER clients so the web can name the
   *  author instead of an anonymous "pilot (elsewhere)". */
  | {
      type: "prompt"; text: string; force?: boolean; from?: string;
      /** This text is the TRANSCRIPTION of a voice message, not something the
       *  human typed. Surfaced in the context header so the agent reads it as
       *  speech rather than as typing — see context/pilot-prompt.md. */
      voice?: boolean;
    }
  /** Run a one-line command in the pane's SHELL MODE on the human's behalf —
   *  a browser connection only (see src/bang.ts for why it cannot be a prompt,
   *  and why an agent must never reach it). */
  | { type: "run"; command: string }
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
  /** Change the MODEL this one agent runs on (an alias like `opus`, optionally
   *  `[1m]`-suffixed for the long window, or null to fall back to the profile's).
   *  Like `profile`, `model` is SERVER_OWNED on the channel, so this is the only
   *  legitimate path. A model is a spawn arg, so this ALWAYS respawns to apply. */
  | { type: "set-model"; model: string | null }
  | { type: "set-effort"; effort: string | null }
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
/** The backend an agent on this profile talks to — the same inputs
 *  `makePilot` hands the process, so the verdict cannot disagree with it. */
function sessionBackend(profileName?: string | null, groupId?: string | null): Backend {
  const profile = profileName ? getProfile(profileName) : undefined;
  const secretEnv = secretsForProfile(profileName, profile?.secrets, groupId ?? MAIN_GROUP_ID, commonsGroupIds());
  return backendFor({ ...backendEnv(instanceBackendSource(), secretEnv), ...secretEnv });
}

/** The profile a `start` will run with, known BEFORE the spawn resolves its
 *  id — only for the sign-in gate. Mirrors the later resolution: on a resume
 *  the channel's stored profile wins over the message's. */
function gateProfile(msg: { profile?: string | null; resume?: string }): string | null {
  if (msg.resume) {
    const found = resolveResumeId(loadChannels().map((c) => c.sessionId), msg.resume);
    if (found.ok) {
      const stored = loadChannels().find((c) => c.sessionId === found.id)?.profile;
      if (stored != null) return stored;
    }
  }
  return msg.profile ?? null;
}

function sessionModelSetting(profileName?: string | null, agentModel?: string | null): string | null {
  // The agent's own choice comes FIRST, and this is not cosmetic: the gauge
  // resolves its window from this string (`windowForModel`, invariant 22), so
  // reading the profile here would meter an agent that asked for `[1m]` against
  // the standard window — wrong for precisely the sessions that need the bar.
  const own = agentModel?.trim();
  if (own) return own;
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

/**
 * The exact preprompt a spawn would produce RIGHT NOW for a given profile —
 * every input read from current state (the profile definition, the vault, the
 * permission mode, the pilot prompt, the seeded skills). The ONE builder, so
 * the snapshot captured at spawn and the one recomputed to detect drift are
 * byte-identical: a difference always means the agent's context actually
 * changed, never that two code paths spelled it differently.
 */
function buildPreprompt(profileName?: string | null, groupId?: string | null): PrepromptPart[] {
  const profile = profileName ? getProfile(profileName) : undefined;
  const resolved = effectiveProfile(profile);
  return prepromptParts({
    profileName: profileName ?? null,
    role: resolved?.systemPrompt,
    model: resolved?.model,
    deny: resolved?.deny,
    allow: resolved?.allow,
    permissionMode,
    secretNames: secretNamesForProfile(loadVault(), groupId ?? MAIN_GROUP_ID, profileName ?? "", profile?.secrets, commonsGroupIds()),
    capabilities: installedCapabilities(),
    pilotPrompt: pilotPrompt() ?? undefined,
    ledgerReflex: ledgerEnabled ? ledgerReflex() : null,
  });
}

/**
 * The installed `claude` binary version, cached briefly. A real `claude
 * --version` spawn, so it is kept out of hot paths: captured once at spawn and
 * refreshed at most once a minute for the staleness sweep. Null when the probe
 * fails (e.g. the launcher is mid-rewrite, invariant 32) — treated as "unknown",
 * never as a change, so a transient failure never raises a false reload hint.
 */
let claudeVerCache: { at: number; v: string | null } | null = null;
function currentClaudeVersion(): string | null {
  const now = Date.now();
  if (claudeVerCache && now - claudeVerCache.at < 60_000) return claudeVerCache.v;
  let v: string | null = null;
  try {
    v = parseClaudeVersion(execFileSync(claudeCommand(), ["--version"], { encoding: "utf8", timeout: 5000 }));
  } catch {
    v = null;
  }
  claudeVerCache = { at: now, v };
  return v;
}

/**
 * Run a command AS a group's OS user, SYNCHRONOUSLY, for spawn-time HOME
 * seeding. Mirrors `runPrivileged`'s sudo-when-non-root rule, but sync (the seed
 * must land before the claude process reads its config) and able to pass stdin /
 * capture stdout. `runAsUser` builds the `runuser -u <user> -- …` wrapping shared
 * with the provisioning plans, so the privilege drop is byte-for-byte identical.
 */
function spawnAsUserSync(user: string, cmd: string, argv: string[], input?: string): { ok: boolean; stdout: string } {
  let [c, a] = runAsUser(user, cmd, argv);
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    a = ["-n", c, ...a];
    c = "sudo";
  }
  const r = spawnSync(c, a, { input, encoding: "utf8", timeout: 15_000 });
  return { ok: r.status === 0, stdout: typeof r.stdout === "string" ? r.stdout : "" };
}

/** Atomic write of `content` to `file`, performed AS `user` (tee to a temp then
 *  mv, both dropped to the user) so root never writes through a 0700 HOME it does
 *  not own — an agent could plant a symlink there otherwise (same TOCTOU rule as
 *  the provisioning plans' root/user split). */
function writeAsUserAtomic(user: string, file: string, content: string): void {
  const dir = file.slice(0, file.lastIndexOf("/"));
  const tmp = `${file}.shadok.tmp`;
  spawnAsUserSync(user, "mkdir", ["-p", dir]);
  if (!spawnAsUserSync(user, "tee", [tmp], content).ok) throw new Error(`tee ${tmp} failed`);
  if (!spawnAsUserSync(user, "mv", ["-f", tmp, file]).ok) throw new Error(`mv ${tmp} → ${file} failed`);
}

/** The SSH key store on the shadok-data VOLUME (survives a docker recreate, which
 *  wipes `/home`). The container's historical identity lives here (`id_ed25519`);
 *  per-group keys go under `groups/<os-user>/`. `/root` is 0700, so a dropped
 *  agent cannot read this — the server (root) copies the material into the
 *  agent's own HOME at spawn. Mirrors `ensureSshIdentity` (src/ssh.ts). */
const SHADOK_SSH_DIR = path.join(os.homedir(), ".shadok-ai", "ssh");
const SSH_AGENT_CONFIG =
  "# Managed by shadok-ai — SSH identity for this agent.\n" +
  "Host *\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile ~/.ssh/known_hosts\n  IdentityFile ~/.ssh/id_ed25519\n  IdentitiesOnly yes\n";

/**
 * Give a DROPPED agent a working `~/.ssh` (git-over-SSH, private clones).
 *
 * The source keypair lives on the VOLUME under `SHADOK_SSH_DIR` (persists a
 * recreate): the COMMONS (`main`) reuses the container's HISTORICAL key — the
 * identity already registered on the forge (operator: "récupère la clef
 * historique") — while each ISOLATED group has its OWN key under
 * `groups/<os-user>/` (operator decision: one key per group). A dropped user
 * cannot read the volume dir (it is under the 0700 `/root`), so the server
 * (root) reads/generates the keypair there and writes a COPY into the agent's
 * own HOME AS THE USER (never root writing through a 0700 HOME). Idempotent
 * (skips when the HOME key is already present — so a recreate re-copies the same
 * volume key, keeping the identity stable). Best-effort: SSH just stays
 * unavailable to that agent on failure, never a spawn failure.
 */
function ensureAgentSshKey(user: string, home: string): void {
  try {
    const ssh = `${home}/.ssh`;
    if (spawnAsUserSync(user, "test", ["-f", `${ssh}/id_ed25519`]).ok) return; // already wired
    const isCommons = user === COMMONS_USER;
    const srcDir = isCommons ? SHADOK_SSH_DIR : path.join(SHADOK_SSH_DIR, "groups", user);
    const srcKey = path.join(srcDir, "id_ed25519");
    if (!fs.existsSync(srcKey)) {
      // No historical key for the commons (a fresh instance), or a new group:
      // mint one on the VOLUME, as root. accept-new keys are registered later.
      fs.mkdirSync(srcDir, { recursive: true, mode: 0o700 });
      execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", srcKey, "-C", `shadok-${user}`]);
    }
    const priv = fs.readFileSync(srcKey, "utf8");
    const pub = fs.readFileSync(`${srcKey}.pub`, "utf8");
    spawnAsUserSync(user, "mkdir", ["-p", ssh]);
    spawnAsUserSync(user, "chmod", ["700", ssh]);
    writeAsUserAtomic(user, `${ssh}/id_ed25519`, priv);
    spawnAsUserSync(user, "chmod", ["600", `${ssh}/id_ed25519`]);
    writeAsUserAtomic(user, `${ssh}/id_ed25519.pub`, pub);
    writeAsUserAtomic(user, `${ssh}/config`, SSH_AGENT_CONFIG);
    spawnAsUserSync(user, "chmod", ["600", `${ssh}/config`]);
    console.log(`ssh: wired ${isCommons ? "historical" : "per-group"} key for ${user} — pub: ${pub.trim()}`);
  } catch (e) {
    console.log(`ssh: could not set up a key for ${user} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Seed Claude Code's first-run state into a DROPPED group agent's OWN HOME —
 * `<home>/.claude.json` (global onboarding + this worktree's trust) and
 * `<home>/.claude/settings.json`. An isolated-group agent runs as `sk-<id>` with
 * HOME `/home/sk-<id>` (not /root), so the boot-time `ensureClaudeHome` seeding of
 * the SERVER's HOME never reaches it: without this EVERY private/restricted agent
 * opened on Claude Code's theme picker + per-directory trust dialog and never
 * reached a prompt (the zombie shape of invariant 23).
 *
 * Runs AS THE GROUP USER (never root writing into a HOME it does not own),
 * SYNCHRONOUSLY (the files must exist before claude reads them) and ADDITIVELY
 * (reuses the pure `seedPlan`/`settingsPlan`, so a value the agent already set is
 * kept and other worktrees' trust survives). Best-effort: a failure is logged,
 * never fatal — a first-run screen beats a refused spawn. NB: this does NOT yet
 * seed the shadok SKILLS into the group HOME (they live only in the server's
 * ~/.claude/skills); that gap is tracked separately.
 */
function seedGroupAgentHome(user: string, home: string, cwd: string): void {
  const version = currentClaudeVersion() ?? "0.0.0";
  const readObj = (file: string): Record<string, unknown> | null => {
    const r = spawnAsUserSync(user, "cat", [file]);
    if (!r.ok || !r.stdout.trim()) return {}; // absent / empty → seed from scratch
    try {
      const p = JSON.parse(r.stdout);
      // Unreadable/!object → null: "leave it alone", never clobber (same rule as
      // claude-home's readHome).
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  try {
    const homeJson = `${home}/.claude.json`;
    const existing = readObj(homeJson);
    if (existing) {
      const plan = seedPlan(existing as ClaudeHome, { version, cwd });
      if (plan) writeAsUserAtomic(user, homeJson, JSON.stringify(plan, null, 2));
    } else {
      console.log(`claude-home: ${homeJson} unreadable — left alone, first-run screens may appear`);
    }
    const settingsJson = `${home}/.claude/settings.json`;
    const sExisting = readObj(settingsJson);
    if (sExisting) {
      const splan = settingsPlan(sExisting as ClaudeSettings);
      if (splan) writeAsUserAtomic(user, settingsJson, JSON.stringify(splan, null, 2));
    }
  } catch (e) {
    console.log(`claude-home: could not seed group HOME ${home} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

function makePilot(
  id: string,
  cwd: string,
  args: string[],
  profileName?: string | null,
  model?: string | null,
  effort?: string | null,
  /**
   * The OS user to drop this agent to (multi-tenant isolation, `src/osusers.ts`).
   * The multi-tenant gate lives at the call sites (the only place `DEPLOYMENT_MODE`
   * is known), so this is `null`/undefined on every mono-tenant spawn and the
   * pilots' spawn path stays byte-for-byte what it was.
   */
  user?: string | null,
  /**
   * The isolation GROUP this agent belongs to, so its profile's secrets resolve
   * by the agent's REAL group (own → shared-in → Main), not always Main. Null /
   * undefined on every mono-tenant (and group-less) spawn → Main, i.e. today.
   */
  group?: string | null,
): Pilot {
  // A worktree is a brand-new directory, so it carries a brand-new trust
  // dialog. Seed it before the process exists, not after it is stuck on it.
  ensureProjectTrusted(cwd);
  const profile = profileName ? getProfile(profileName) : undefined;
  // Env = the vault secrets the profile references (none without a profile).
  // Kept apart from the SHADOK_* plumbing below: only THESE are secrets, and
  // only these belong in the note. Announcing SHADOK_SESSION_ID as a "secret you
  // must never print" was noise that buried the real ones. Resolved by the
  // agent's own group (own → shared-in → Main); null/mono-tenant → Main.
  const secretEnv = secretsForProfile(profileName, profile?.secrets, group ?? MAIN_GROUP_ID, commonsGroupIds());
  // A custom model backend (a self-hosted open model, a gateway) first, then
  // the secrets: `backendEnv` carries shadok's own ANTHROPIC_* only when they
  // point off Anthropic, and maps the model aliases. See src/backend.ts.
  const env: Record<string, string> = { ...backendEnv(instanceBackendSource(), secretEnv), ...secretEnv };
  // Self-scheduling context: lets the shadok-scheduler skill register/list/remove
  // crons on THIS channel via the local API (so the user can set up monitoring in
  // plain language just by asking the agent).
  env.SHADOK_SESSION_ID = id;
  env.SHADOK_PORT = String(boundPort || START_PORT);
  if (GUI_PASSWORD) env.SHADOK_AUTH = adminCookie()!;
  // Proves WHO calls /profiles/prompt: without it "my own profile" means
  // nothing, since the session id is public.
  env.SHADOK_SESSION_KEY = sessionKeyFor(id);
  // The PER-INSTANCE ledger file (ONE table, keyed by the launch dir). On-server
  // the CLI writes it THROUGH the server (`POST /ledger/record`, session-key
  // auth), so group scoping and the OS-user wall are the server's problem, not
  // the file's. This path is only the hand-run / server-unreachable FALLBACK;
  // an agent's cwd is a worktree, so it still cannot derive the launch dir
  // itself. No per-group / commons path any more — the group is a per-row field.
  env.SHADOK_LEDGER_FILE = ledgerFileFor(process.cwd());
  // The PER-INSTANCE outbound-peers file (same reason): `pilotctl --peer <alias>`
  // reads it to reach another instance's agents. See src/peers.ts.
  env.SHADOK_PEERS_FILE = peersOutFileFor(process.cwd());
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
    ...profileArgs(effectiveProfile(profile), model, effort),
    ...(note ? ["--append-system-prompt", note] : []),
    ...(sp ? ["--append-system-prompt", sp] : []),
    ...(lr ? ["--append-system-prompt", lr] : []),
  ];
  // NAMES only: the values are in `env`, and never travel to a client. Built
  // through the shared `buildPreprompt`, so this spawn snapshot is comparable
  // byte-for-byte with the one the staleness check recomputes later.
  prepromptById.set(id, buildPreprompt(profileName, group));
  // Spawn the binary `claudeCommand` resolved, not the bare name `claude`. They
  // differ exactly when the npm launcher is the fallback placeholder: spawning
  // by name would then run the 500-byte stub, which exits 1 on stderr and looks
  // like an agent that died for no reason. With nothing resolvable it falls
  // back to the bare name, i.e. the historical behaviour.
  const claudePath = claudeCommand();
  // When we drop to an OS user, set its HOME too: setpriv changes the uid but not
  // $HOME, so without this the agent keeps the server's HOME=/root — un-traversable
  // (mode 700) — and never reaches its per-group ~/.claude (the skills
  // + settings Tasks 6/12 wired there), breaking auth and skills for
  // EVERY dropped agent. `homeForUser` is the SAME derivation the provisioning used
  // (`${GROUP_HOME_BASE}/<user>`: commons `main` → GROUP_HOME_BASE/main, a private
  // group → GROUP_HOME_BASE/sk-<id>), so the spawn's HOME is exactly where the
  // credential was provisioned. Undefined without a drop user → HOME left as today.
  const home = user ? homeForUser(user, GROUP_HOME_BASE) : undefined;
  // A dropped agent reads its OWN HOME, not the server's: seed the onboarding +
  // trust there too, or every isolated-group agent stalls on the theme picker and
  // the per-directory trust dialog. `ensureProjectTrusted(cwd)` above seeds the
  // SERVER's HOME (still needed for a commons/mono agent that runs as the server
  // user); this adds the same state to the group user's HOME, as that user.
  // Skills are machine-wide (the Enterprise tier, `seedSystemSkills`), so only
  // the per-HOME onboarding/trust state needs seeding into the group user's HOME.
  // The group also gets its OWN SSH identity (one key per group).
  if (user && home) {
    seedGroupAgentHome(user, home, cwd);
    ensureAgentSshKey(user, home);
  }
  // Isolated groups share the subscription token, injected in the forced-last
  // env layer — but ONLY in "token" auth mode. In "login" mode the server
  // injects NO token: `CLAUDE_CODE_OAUTH_TOKEN` outranks (and suppresses) a
  // subscription login, and that login is exactly what carries the claude.ai
  // connectors this mode exists for. The agent then authenticates from its own
  // home's `claude auth login` credential (one per OS user; see src/agent-login.ts
  // and the connectors-via-global-login design). Mono-tenant (no user) passes
  // nothing either way.
  const authMode = agentAuthForCwd(loadConfig(), process.cwd());
  const oauthToken =
    user && authMode === "token"
      ? secretsFor([MT_CLAUDE_OAUTH_TOKEN_NAME], MAIN_GROUP_ID)[MT_CLAUDE_OAUTH_TOKEN_NAME]
      : undefined;
  return USE_TMUX
    ? new TmuxPilot({ cwd, args: fullArgs, env, tmuxName: "sk-" + id, claudePath, user, home, oauthToken })
    : new PtyPilot({ cwd, args: fullArgs, env, claudePath, user, home, oauthToken });
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
  /** The HOME whose `.claude/projects` holds this agent's transcript: the
   *  server's own, EXCEPT a privilege-dropped group agent (multi-tenant) that
   *  writes under its own `/home/sk-<id>`. The content tail and `loadHistory`
   *  read from here — without it an isolated agent's reply never streams. */
  transcriptHome: string;
  /** The isolation group this agent runs in (null = commons / mono-tenant) —
   *  the scope its profile's secrets resolve from (own → shared-in → Main). */
  group: string | null;
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
  /** What the pane says is still running (its footer's counts). Live, never stored. */
  shells: number;
  monitors: number;
  /** The window this session's model setting asks for (see `windowForModel`). */
  contextWindow: number;
  /** Subscription or a custom backend, decided AT SPAWN from the same env the
   *  process got. A custom agent spends no subscription quota, so the pace
   *  guard must never hold it back. See src/backend.ts. */
  backend: Backend["kind"];
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
  /** The model this RUNNING process was given (see `Channel.model`). Kept on
   *  the Live so a restart respawns on the same one — `restartSession` rebuilds
   *  the pilot from these fields and nothing else. */
  model?: string | null;
  /** The profile the RUNNING process actually got. Differs from `profile` only
   *  between a stored change and the restart that applies it — that gap is what
   *  the UI shows as "(at next reload)". */
  appliedProfile?: string | null;
  /** The effort THIS agent runs at, overriding its profile's (`--effort`). */
  effort?: string;
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
  /**
   * True while a prompt is being TYPED into the TUI — paste, retry, Enter.
   *
   * `busy` covers that stretch too, which is why a second message arriving in
   * it is refused with `busy` and the Telegram bridge answers with an Escape
   * (it preempts the turn it believes is running). But nothing is running yet:
   * the Escape lands on a box being filled, where it deletes the text instead
   * of interrupting anything — and a box that then reads empty is exactly what
   * `submit` takes for "the prompt was sent", so the message is lost in
   * silence. The interrupt is therefore HELD here and pressed once the submit
   * has landed, where it does what it was meant to do.
   */
  submitting?: boolean;
  /** An interrupt key that arrived mid-submit, waiting for the submit to end. */
  pendingInterrupt?: "escape" | "ctrl-c";
  /** How long the last finished turn took, so a client attaching between
   *  turns can restore the frozen time instead of showing a blank timer. */
  lastTurnMs: number | null;
  /** Last staleness reasons broadcast for this session (serialised), so the
   *  periodic sweep only re-broadcasts when they actually change. */
  lastStaleSig?: string;
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
async function restartSession(s: Live, by: SpawnBy = SYSTEM_SPAWN): Promise<void> {
  // Fail-closed group check BEFORE any teardown. A restart re-derives the OS
  // user from the channel's stored group; if that group no longer resolves,
  // `resolveSpawnIsolation` would derive a null user and respawn a private agent
  // as the server's own (commons/root) user — a silent privilege DOWNGRADE that
  // keeps the foreign transcript running. Refuse instead (no people-membership
  // check: the session's entitlement was established at spawn, and no human
  // principal drives a restart — see `canRestartInto`). Mono-tenant has no group,
  // so this is a trivial pass and byte-for-byte today's behaviour.
  const restartGroupId = loadChannels().find((c) => c.sessionId === s.id)?.group ?? null;
  if (DEPLOYMENT_MODE === "multi-tenant" && !canRestartInto(restartGroupId, loadGroups())) {
    console.error(
      `[sk-${s.id}] restart refused — group ${restartGroupId} no longer resolves (would drop to commons/root)`,
    );
    broadcast(s, {
      type: "error",
      message: "restart refused: this agent's group no longer exists",
      code: "forbidden",
    });
    return;
  }
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
  // The respawn below resumes `s.id`, so Claude Code writes that transcript
  // again: any fork this session was following is now the dead one. Forget the
  // whole fork trail, or the tail keeps reading a file nothing appends to.
  s.tailId = undefined;
  s.tailSeen = undefined;
  s.rootId = undefined;
  broadcast(s, { type: "working", startedAt: Date.now(), elapsedMs: 0 });
  // Resume only if there's a transcript; a never-used session has
  // nothing to resume (claude --resume would exit) — re-create it.
  const hasTranscript = fs.existsSync(sessionFilePath(s.cwd, s.id, s.transcriptHome));
  // A restart respawns without passing through the `start` handler, so it is
  // its own chance to notice that the launcher has become the placeholder since
  // this session was created. Non-fatal: a restart that cannot re-resolve still
  // respawns on the last known path, which is what it did before.
  const claude = await ensureClaudeOnce();
  if (!claude.ok) console.error(`[sk-${s.id}] restart: ${claude.error}`);
  // A reload respawns a fresh process (for PtyPilot; TmuxPilot re-adopts the
  // live pane and keeps its original uid — invariant 25 / Task 15). It is a
  // resume, so it never reassigns the group: derive the OS user from the
  // channel's stored group so a private agent comes back under its own user,
  // not as root. Mono-tenant resolves to null — unchanged from before.
  const restartUser =
    resolveSpawnIsolation({
      mode: DEPLOYMENT_MODE,
      resumed: true,
      viewer: null,
      groups: loadGroups(),
      storedGroupId: restartGroupId,
    }).user ?? commonsOsUser({ migrated: groupsMigrated, mode: DEPLOYMENT_MODE });
  // Task 7 verify-first gate (same as the spawn path): a restart re-adopts the
  // HOME, so it is another moment the symlink could have been overwritten by a
  // rename refresh — warn LOUDLY rather than let auth break in silence.
  s.pilot = makePilot(
    s.id,
    s.cwd,
    hasTranscript ? ["--resume", s.id] : ["--session-id", s.id],
    s.profile,
    s.model,
    s.effort,
    restartUser,
    restartGroupId,
  );
  s.appliedProfile = s.profile;   // the new process carries the desired profile
  await attachPilot(s);
  s.restarting = false;
  // A restart spawns a brand-new process, so its anchor is current: re-record
  // it (clearing `legacy`), which is what makes the reload indicator go dark.
  recordSpawnFingerprint(s);
  recordSecretInjection(s, by, "restart");
  s.lastStaleSig = undefined;
  // `lastTurnMs`, like the connect-path `ready`: the transient "working" above
  // started the client's turn timer, and this "ready" is what stops it — without
  // the last turn's duration to freeze onto, the counter kept ticking after the
  // reload instead of pausing.
  broadcast(s, {
    type: "ready",
    // Which instance is answering this origin — the client compares it to the
    // launch dir stamped in its page and stops writing on a mismatch (swap).
    instanceKey: instanceKey(),
    sessionId: s.id,
    preprompt: prepromptById.get(s.id) ?? [],
    stale: sessionStaleness(s),
    cwd: s.cwd,
    branch: s.worktree?.branch ?? null,
    lastTurnMs: s.lastTurnMs,
  });
  broadcastProfile(s);            // the "at next reload" gap has just closed
  broadcast(s, { type: "screen", text: s.pilot.screen(), working: s.pilot.isWorking() });
}

/** Tells every attached client (other tabs, other devices) both the desired and
 *  the running profile — the pair is what lets the UI show "(at next reload)". */
/**
 * This agent's identity as the clients see it: the desired/in-force profile
 * pair, plus the two spawn settings the agent menu shows and changes.
 *
 * ONE builder, because the two connect-time `send`s used to spell this message
 * by hand and omitted `model` — so a reconnecting tab set its model back to
 * null and the menu showed "profile default" over an agent running on Opus,
 * until some unrelated change rebroadcast it. Adding a second such field would
 * have doubled that bug.
 */
function profileMessage(s: Live) {
  return {
    type: "profile" as const,
    profile: s.profile ?? null,
    applied: s.appliedProfile ?? null,
    // The model this agent runs on (an alias / `[1m]` setting / full name, or
    // null = the profile's), and how hard it thinks (`--effort`, null = the
    // profile's). Both are spawn args, hence both on the identity message.
    model: s.model ?? null,
    effort: s.effort ?? null,
  };
}

function broadcastProfile(s: Live) {
  broadcast(s, profileMessage(s));
}

// ── Reload indicator: is a running agent behind what a fresh spawn gives? ────
//
// The signal is version-INDEPENDENT (see `stalenessReasons`): it compares what
// the RUNNING process actually received against what shadok injects now. The
// anchor is DURABLE (the channel on disk, `spawnFp`/`spawnAt`/`spawnClaudeVer`)
// because the in-memory `prepromptById` snapshot is reset to "current" whenever
// a surviving tmux pane is re-adopted after a server restart — which is exactly
// the moment a shadok auto-update changes the prompt under a live agent, so an
// in-memory anchor would hide the very drift this detects.

/** Record this agent's spawn fingerprint — but ONLY for a process we actually
 *  spawned. An adopted pane is the OLD process: its stored fingerprint must be
 *  left alone (or seeded as `legacy` the first time, so a pre-feature agent
 *  reads as stale until reloaded). Called once after `attachPilot`. */
/** Who caused a spawn, for the secret audit log. */
type SpawnBy = { actor: string; via: SecretAuditVia };
const SYSTEM_SPAWN: SpawnBy = { actor: "system", via: "system" };

/**
 * Audit which vault secrets a FRESH process just received. An adopted tmux
 * pane got its env when it was first spawned (already logged then), so a
 * reattach records nothing — it hands no value to anyone.
 */
function recordSecretInjection(s: Live, by: SpawnBy, detail: string): void {
  if (s.pilot instanceof TmuxPilot && s.pilot.attached) return;
  const profile = s.profile ? getProfile(s.profile) : undefined;
  recordSecretAudit({
    action: "injected",
    secrets: Object.keys(secretsForProfile(s.profile, profile?.secrets, s.group ?? MAIN_GROUP_ID, commonsGroupIds())),
    ...by,
    agent: s.id,
    agentName: loadChannels().find((c) => c.sessionId === s.id)?.name,
    ...(s.profile ? { profile: s.profile } : {}),
    instance: process.cwd(),
    detail,
  });
}

function recordSpawnFingerprint(s: Live): void {
  const adopted = s.pilot instanceof TmuxPilot && s.pilot.attached;
  if (adopted) {
    const stored = loadChannels().find((c) => c.sessionId === s.id);
    if (stored && stored.spawnFp !== undefined) return; // old process, keep its anchor
    upsertChannel({ sessionId: s.id, spawnFp: LEGACY_FINGERPRINT, spawnAt: 0, spawnClaudeVer: null });
    return;
  }
  upsertChannel({
    sessionId: s.id,
    spawnFp: prepromptFingerprint(prepromptById.get(s.id) ?? []),
    spawnAt: Date.now(),
    spawnClaudeVer: currentClaudeVersion(),
  });
}

/** Why this agent should be reloaded, empty when up to date. Reads the durable
 *  anchor off the channel (optionally pre-loaded by the sweep to avoid N reads). */
function sessionStaleness(s: Live, channels?: Channel[]): StaleReason[] {
  const ch = (channels ?? loadChannels()).find((c) => c.sessionId === s.id);
  if (!ch || ch.spawnFp === undefined) return []; // no anchor yet (brand-new, pre-first-record)
  return stalenessReasons({
    spawnFp: ch.spawnFp,
    currentFp: prepromptFingerprint(buildPreprompt(s.profile, s.group)),
    hasPassword: !!GUI_PASSWORD,
    spawnedAt: ch.spawnAt ?? null,
    now: Date.now(),
    authTtlMs: SESSION_TTL_MS,
    spawnClaudeVersion: ch.spawnClaudeVer ?? null,
    currentClaudeVersion: currentClaudeVersion(),
  });
}

function staleMessage(s: Live, channels?: Channel[]) {
  return { type: "stale" as const, sessionId: s.id, reasons: sessionStaleness(s, channels) };
}

/** Broadcast the staleness reasons, but only when they changed. */
function broadcastStaleness(s: Live, channels?: Channel[]): void {
  const msg = staleMessage(s, channels);
  const sig = JSON.stringify(msg.reasons);
  if (sig === s.lastStaleSig) return;
  s.lastStaleSig = sig;
  broadcast(s, msg);
}

function destroySession(s: Live) {
  prepromptById.delete(s.id);
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
  clearTailPos(sessionFilePath(s.cwd, s.id, s.transcriptHome));
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
  // Resolve the worktree's home WHILE the session is still live (its own
  // `transcriptHome` is the exact home the spawn created it in); fall back to the
  // channel's group-derived home once it is gone. Prune must look in the same
  // place createWorktree wrote, or a dropped agent's checkout under /home/<user>
  // would never be cleaned.
  const worktreeHome = s?.transcriptHome ?? (ch ? channelStateHome(ch) : os.homedir());
  if (s) {
    broadcast(s, { type: "stopped" });
    await s.pilot.stop().catch(() => {});
    destroySession(s);
  }
  // Prune the worktree: remove it if clean (an agent that did nothing / already
  // merged), keep it if there's uncommitted or unmerged work. Stops the empty-
  // worktree pile-up while never discarding real work.
  if (repo && worktreeBranch) {
    const outcome = pruneWorktree(repo, worktreeBranch, worktreeHome);
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
    // Claude Code's auto-updater reinstalls the package in place; installing
    // over it is how a fresh instance's first agent died on ENOTEMPTY.
    installInProgress: claudeInstallInProgress,
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
  model: string | null = null,
  effort: string | null = null,
  by: SpawnBy = SYSTEM_SPAWN,
  /** Multi-tenant isolation: the OS user to drop the agent to (null = commons /
   *  mono-tenant, i.e. the server's own user). Resolved by the caller, which is
   *  where `DEPLOYMENT_MODE` and the channel's group are both known. */
  user: string | null = null,
  /** The isolation group the agent belongs to (null = commons / mono-tenant),
   *  so its profile's secrets resolve by the agent's REAL group, not always Main. */
  group: string | null = null,
): Promise<Live> {
  const pilot = makePilot(id, cwd, args, profile, model, effort, user, group);
  // A dropped group agent writes its transcript under ITS OWN home, not the
  // server's — so the content tail / history must read from there (invariant:
  // all content comes from the .jsonl). `agentStateHome` is the one answer.
  const transcriptHome = agentStateHome(user);
  // Resumed sessions start with what the transcript already consumed.
  const seededUsage = scanUsage(sessionFilePath(cwd, id, transcriptHome));
  const backend = sessionBackend(profile, group);
  // A custom backend's window is whatever its server was started with, which
  // no model name can tell us: SHADOK_CONTEXT_WINDOW says it, and without it
  // the usual assumption stands (and `effectiveWindow` still promotes on proof).
  const contextWindow =
    (backend.kind === "custom" ? backend.contextWindow : null) ??
    windowForModel(sessionModelSetting(profile, model));
  const s: Live = {
    id,
    cwd,
    transcriptHome,
    group,
    pilot,
    profile,
    appliedProfile: profile,   // the process we just spawned did receive it
    effort: effort ?? undefined,
    clients: new Set(),
    busy: false,
    lastPrompt: "",
    screenTimer: null,
    lastScreen: "",
    lastDialogKey: null,
    contextWindow,
    backend: backend.kind,
    // A reattached session must show its bar at once, not only after the next
    // turn writes a usage record — so seed from the transcript's last message.
    model,
    contextPct: pctFromUsage([...seededUsage.values()].pop(), contextWindow),
    shells: 0,
    monitors: 0,
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
  // Anchor what this process actually got, so the reload indicator can later
  // tell whether it drifted. No-op-safe for an adopted pane (keeps the old
  // anchor); seeds `legacy` the first time a pre-feature agent is adopted.
  recordSpawnFingerprint(s);
  recordSecretInjection(s, by, args.includes("--resume") ? "resume" : "spawn");
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
  s.stopTail = tailSession(sessionFilePath(cwd, tid(), s.transcriptHome), (e) => {
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
      broadcast(s, { type: "stream-text", text: e.text, at: e.at, afterInternal, ...(e.uuid ? { msgId: e.uuid } : {}) });
    } else if (e.kind === "prompt") {
      // The echoed prompt bubble learns its transcript id (see TailEvent).
      broadcast(s, { type: "prompt-id", msgId: e.uuid, text: e.text });
    } else if (e.kind === "tool")
      broadcast(s, {
        type: "stream-tool", id: e.id, name: e.name, summary: e.summary,
        // Files a SendUserFile delivered → the client renders a download / inline
        // card, Telegram uploads them. {path, name, image} so neither re-derives.
        ...(e.files?.length ? { files: e.files.map(fileCard) } : {}),
      });
    else if (e.kind === "bash")
      broadcast(s, {
        type: "stream-bash",
        ...(e.command !== undefined ? { command: e.command } : {}),
        ...(e.output !== undefined ? { output: e.output } : {}),
        ...(e.isError ? { isError: true } : {}),
        ...(e.at ? { at: e.at } : {}),
      });
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
    } else if (e.kind === "result")
      broadcast(s, {
        type: "stream-result",
        toolUseId: e.toolUseId,
        text: e.text,
        isError: e.isError,
      });
  }, 250, () => sessionFilePath(cwd, tid(), s.transcriptHome));
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
  const myFile = sessionFilePath(s.cwd, tailId, s.transcriptHome);
  // Lineage root: read once from the file we currently tail, then cache. The
  // original session's root is its own id, so `?? s.id` is the right fallback
  // when the file has no root record yet (a session that never took a turn).
  const myRoot = (s.rootId ??= rootIdOfFile(myFile) ?? s.id);
  const seen = (s.tailSeen ??= new Set([tailId]));
  // `s.id` is passed so the hunt can come HOME: every restart respawns with
  // `--resume <s.id>`, so the session's own transcript becomes the live file
  // again, and excluding it as a visited fork left the tail on a dead one for
  // good (see `detectFork`).
  const target = detectFork(myFile, tailId, myRoot, seen, s.id);
  if (!target) return;
  const home = target === s.id;
  console.log(
    home
      ? `[sk-${s.id.slice(0, 8)}] back on its own transcript (the fork ${tailId.slice(0, 8)} went quiet)`
      : `[sk-${s.id.slice(0, 8)}] transcript forked → following ${target.slice(0, 8)} (context overflow)`,
  );
  seen.add(tailId);
  s.tailId = target;
  // None of a FORK was ever shown in chat (it is a different transcript), so it
  // is replayed from the start. Coming home is the opposite case: that file has
  // a stored position and a history the chat already replayed, and seeding 0
  // would dump the whole transcript — 56 MB on the session this was found on —
  // into the chat. Let `startOffset` resume from the stored position instead.
  if (!home) seedTailPos(sessionFilePath(s.cwd, target, s.transcriptHome), 0);
  startContentTail(s);
  broadcast(s, {
    type: "stream-text",
    text: home
      ? "— reconnected to this agent's own session —"
      : "— the previous session was full; the chat reconnected to the agent's current one —",
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
  // Not `pilot.start()` directly: a claude-code upgrade rewrites a ~214 MB
  // binary in place, and a spawn landing in that window dies on ETXTBSY. It is
  // transient by construction, so it is waited out rather than reported as a
  // death — see `isBinaryBusyError`.
  await startWithBusyRetry(() => pilot.start(), {
    onRetry: (attempt, tries) =>
      console.log(`spawn ${id.slice(0, 8)}: claude binary busy (upgrade in flight), retry ${attempt}/${tries}`),
  });
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
      // Background shells, straight off the pane's own footer. Same shape as the
      // context gauge: recomputed here, broadcast only when it MOVES, and never
      // persisted — it describes a running process, not the channel.
      const bg = backgroundTasks(scr);
      if (bg.shells !== s.shells || bg.monitors !== s.monitors) {
        s.shells = bg.shells;
        s.monitors = bg.monitors;
        broadcast(s, { type: "background", shells: bg.shells, monitors: bg.monitors });
      }
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
  let screen: string;
  try {
    screen = await pilot.waitFor(isUp, { timeoutMs: 60_000 });
    if (/do you trust the files/i.test(screen)) {
      pilot.press("enter");
      screen = await pilot.waitFor(
        (scr) => screenShowsWork(scr) || scr.includes("❯"),
        { timeoutMs: 30_000 },
      );
    }
  } catch (e) {
    // The TUI never came up. This session is never registered, so nothing else
    // will ever tear down what was armed above — do it here, or each failed
    // start leaves a pane poller, a 300 ms screen timer and a tail running
    // until the server restarts. See `TmuxPilot.abandon`.
    s.pilotOff?.();
    if (s.screenTimer) clearInterval(s.screenTimer);
    s.screenTimer = null;
    s.stopTail?.();
    s.stopTail = null;
    pilot.abandon();
    throw e;
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

/**
 * What `waitForIdle` may settle on besides a still screen: a real question.
 *
 * A dialog IS a turn boundary, and a dialog can carry a per-second countdown
 * (Claude Code's auto-deny timer) that keeps the screen from ever holding still
 * for `stableMs` — so byte-stability alone never ended the wait, and the
 * question was auto-denied without anyone being asked. Keyed by `dialogKey`,
 * the dedup identity `publishDialog` already uses (question + labels): a ticking
 * clock or a cursor move is not a new dialog, and does not reset the hold.
 *
 * The multi-question recap page is left out on purpose: it is not a question
 * (invariant 30), and right after the Enter that confirms it the screen still
 * shows it for a moment — settling there would end the wait before the turn it
 * submits has even started. It carries no clock, so a still screen ends it.
 */
function dialogSettleKey(screen: string): string | null {
  const d = detectDialog(screen);
  return d && !SUBMIT_PAGE.test(screen) ? dialogKey(d) : null;
}

/**
 * Type a prompt into the TUI, holding any interrupt that arrives meanwhile.
 *
 * The window is small and it is exactly the one two fast Telegram messages fall
 * into: the first is still being pasted when the second is refused as `busy`,
 * and the bridge answers a refusal with an Escape. Pressed then, it deletes the
 * text being typed instead of stopping a turn — and an empty box is what
 * `submit` reads as "sent", so the first message disappears without a word.
 * Held until the prompt is really in, it does what it was asked to do.
 */
async function submitGuarded(s: Live, text: string, prelude?: string[]): Promise<void> {
  s.submitting = true;
  let sent = false;
  try {
    await s.pilot.submit(text, prelude);
    sent = true;
  } finally {
    s.submitting = false;
    const held = s.pendingInterrupt;
    s.pendingInterrupt = undefined;
    if (held) {
      // Only a submit that LANDED started a turn to interrupt. After one that
      // failed the key is still worth pressing — it clears the box someone is
      // waiting on — but claiming a turn was interrupted would hand the next
      // one `finishTurn`'s fast settle bar on no evidence at all.
      if (sent) s.interruptedAt = Date.now();
      try { s.pilot.press(held); } catch { /* pane gone */ }
    }
  }
}

async function finishTurn(s: Live) {
  s.busy = true;
  // Turn found already running (not started by us): typically after a server
  // restart, the tmux agent having carried on without it. `turnStartedAt` lives
  // in memory, so restarting from `now` reset the stopwatch while the agent had
  // been thinking for ten minutes; the transcript, though, survived.
  if (!s.turnStartedAt) s.turnStartedAt = resumedTurnStart(Date.now(), lastPromptAt(s.cwd, s.id, s.transcriptHome));
  s.errorsAtTurnStart = findTransientErrors(s.pilot.screen());
  broadcast(s, workingMessage(s));
  try {
    // Read on every poll, so an interrupt arriving mid-wait takes effect at
    // once instead of at the next turn.
    await s.pilot.waitForIdle({
      stableMs: () => (s.interruptedAt ? INTERRUPTED_STABLE_MS : 2000),
      timeoutMs: 900_000,
      settleOn: dialogSettleKey,
    });
    // A MULTI-QUESTION AskUserQuestion ends on a recap page ("Ready to submit
    // your answers? · Submit answers / Cancel"). That is NOT a real question —
    // every question was already answered one by one — and it mis-parses as a
    // multi-select dialog. Auto-confirm it (Enter defaults to "Submit answers")
    // instead of surfacing a redundant, mis-rendered dialog.
    if (detectDialog(s.pilot.screen()) && SUBMIT_PAGE.test(s.pilot.screen())) {
      s.pilot.press("enter");
      await s.pilot.waitForIdle({ stableMs: 1500, timeoutMs: 120_000, settleOn: dialogSettleKey }).catch(() => {});
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
 *
 * Not to be confused with `d.body`, which rides along in the spread: that one
 * is the dialog box's OWN text (a permission prompt's "This will read … via a
 * symlink", its `Read(…)` target), read by `detectDialog`, and both clients
 * render it — it is what the person approving judges the request by.
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
    // A custom backend spends no subscription quota, so it is never parked.
    const verdict =
      s.backend === "custom"
        ? paceBlock(null, Date.now())
        : paceBlock(await getUsage().catch(() => null), Date.now());
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
  // A PEER principal (a remote instance/harness via `x-shadok-peer`), resolved
  // ONCE at connect and stamped on the socket: revocation (`DELETE /peers`) drops
  // it, and the `start` handler tags what it spawns so a peer only ever touches
  // its own agents.
  const callerPeer = peerName(req);
  // Which AGENT is driving this socket, when one is — pilotctl connects with its
  // own `SHADOK_SESSION_KEY` and declares `origin: "agent"`. Resolved ONCE here,
  // from the key, for the same reason as `me` just above: what a frame says
  // about who is speaking is never what we believe.
  const callerAgent = agentCaller(req);
  // A RESTRICTED peer is boxed to its own agents (the ownership checks below);
  // a MEMBER peer acts as a web member (`currentAccount` above already returns
  // it as one) and those checks are skipped. The tag is still written for BOTH,
  // so the cockpit always shows which peer created what.
  const callerPeerRestricted = peerScopeFor(req) === "restricted";
  (ws as WebSocket & { __peer?: string | null }).__peer = callerPeer;
  // A same-origin browser, decided ONCE at connect from the upgrade's headers —
  // not from anything a frame says. `run` is gated on it: shell mode bypasses a
  // profile's `deny` (measured), so pilotctl and the agents, which connect with
  // no Origin at all (invariant 11), must not be able to reach it.
  const fromBrowser = requestFromBrowser(req);
  // Is this the SERVER driving one of its own channels? Decided ONCE at connect
  // from an unforgeable per-process secret on the upgrade headers (set by
  // `driveChannel`), compared in CONSTANT time with a length guard. A missing or
  // wrong header is simply `false`. This — and ONLY this — exempts a connection
  // from the per-group drive gate below: it must be the secret, never a
  // client-settable field like `origin` (a browser could forge that), so the
  // server's cron/notification/reload deliveries reach a restricted/private
  // group's own channel while an interactive human/agent stays group-gated.
  const isSystemDrive = ((): boolean => {
    const raw = req.headers["x-shadok-system-drive"];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header !== "string") return false;
    const a = Buffer.from(header);
    const b = Buffer.from(SYSTEM_DRIVE_SECRET);
    return a.length === b.length && timingSafeEqual(a, b);
  })();
  // Who a respawn asked from this socket is credited to in the secret audit
  // log. A function, not a value: `origin` is only known once `start` arrives.
  const wsBy = (): SpawnBy =>
    spawnActor({ account: me?.name, origin, peer: callerPeer, agent: callerAgent?.name });
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

  // ACL backstop on every per-turn DRIVE action (prompt, dialog answers, keys,
  // restart, set-*, stop): may THIS caller see/drive the session's group? The
  // spawn/resume path already gates with `canResumeAs`, but a socket attached to
  // a foreign session must not act on it either. See/drive = own + public.
  // Mono-tenant (and any group-less channel) resolves to no group → always true,
  // so this changes nothing outside the privileged deployment. A dangling group
  // id fails closed, the twin of `visibleChannels`.
  const mayDriveSession = (id: string | undefined): boolean => {
    if (!id || DEPLOYMENT_MODE !== "multi-tenant") return true;
    // The server driving a channel it manages (cron/notification/reload) is
    // authorized regardless of group — the delivery proved itself with the
    // system-drive secret at connect, which no client can forge.
    if (isSystemDrive) return true;
    const gid = loadChannels().find((c) => c.sessionId === id)?.group ?? null;
    if (!gid) return true; // commons / group-less
    const g = loadGroups().find((x) => x.id === gid);
    if (!g) return false; // unresolvable → fail closed
    return canSeeGroup(g, viewerFor(me));
  };

  // Announce the running version on connect. The client remembers the first
  // one it sees and reloads if a later (re)connect reports a different one —
  // so a server updated underneath it refreshes the page automatically.
  send(versionMessage());

  ws.on("close", () => {
    // Detach from the CURRENT Live for this id, not the closure's possibly
    // retired one: a handover ([5d8d]) moved this ws onto the new Live, so
    // detaching the old object would leak the ws in the live one's client set.
    if (session) detach(ws, sessions.get(session.id) ?? session);
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
      // This connection can outlive the Live it attached to: a resume that
      // supersedes an exited-but-watched session (see `supersedeSession`,
      // [5d8d]) moved this ws onto the NEW Live, but this closure still points
      // at the retired one. Re-point it so every handler below — and the
      // takeover/retry logic — acts on the single real Live for this id.
      if (session) {
        const current = sessions.get(session.id);
        if (current && current !== session) session = current;
      }
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
          // An agent on a custom backend authenticates with its own token and
          // never touches the subscription, so the instance's sign-in is not
          // its business. The profile is resolved early (and cheaply) for this
          // alone; a resume we cannot match falls back to the probe as before.
          if (sessionBackend(gateProfile(msg)).kind === "custom") {
            console.log(`auth: custom model backend, sign-in not required`);
          } else {
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
            // A truncated id must never reach `claude --resume`: see
            // `resolveResumeId` for the picker screen it lands on.
            const found = resolveResumeId(loadChannels().map((c) => c.sessionId), msg.resume);
            if (!found.ok)
              return fail(
                found.error === "ambiguous"
                  ? `resume: "${msg.resume}" matches ${found.matches} agents — give more of the id`
                  : `resume: no agent matches "${msg.resume}" — a shortened id only resolves against the agents this cockpit lists; pass the full session id`,
                "resume-refused",
              );
            id = found.id;
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

          // A peer only ever touches agents IT created: refuse a resume/continue
          // onto a channel it does not own (a fresh spawn below becomes its own).
          // This is the ownership boundary — without it a peer could attach to any
          // of B's live agents by naming its id (which `/live` publishes).
          if (callerPeer && callerPeerRestricted && resumed) {
            const ch = loadChannels().find((c) => c.sessionId === id);
            if (!ownedByPeer(ch, callerPeer))
              return fail("a restricted peer may only resume its own agents", "peer-scope");
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
          // MT-token guard, hoisted ABOVE `createWorktree`: a refusal must leave NO
          // worktree/branch behind (a token-less retry loop would otherwise pile up
          // empty checkouts). Keyed on the same `dropUser` the spawn will use; the
          // late call below re-checks the (resume / live-attach) paths unchanged.
          const mtRefusal = (dropUser: string | null | undefined): string | null => {
            const m = mtCredentialMessage(
              mtTokenNeeded(!!dropUser, sessionBackend(gateProfile(msg)).kind === "custom"),
              !!secretsFor([MT_CLAUDE_OAUTH_TOKEN_NAME], MAIN_GROUP_ID)[MT_CLAUDE_OAUTH_TOKEN_NAME],
            );
            if (m && !mtTokenWarned) {
              mtTokenWarned = true;
              console.error(`mt: ${m}`);
            }
            return m ?? null;
          };
          // The drop user a NEW spawn will run as — same inputs as the isolation
          // resolution further down. Hoisted out of the MT-token guard because the
          // worktree below must land in (and be owned by) this same user's home.
          let earlyUser: string | null = null;
          if (!resumed) {
            const earlyIso = resolveSpawnIsolation({
              mode: DEPLOYMENT_MODE,
              resumed,
              viewer: viewerFor(me),
              groups: loadGroups(),
              storedGroupId: null,
              requestedGroupId: typeof msg.group === "string" && msg.group.trim() ? msg.group.trim() : null,
            });
            earlyUser = earlyIso.user ?? commonsOsUser({ migrated: groupsMigrated, mode: DEPLOYMENT_MODE });
            const earlyMsg = mtRefusal(earlyUser);
            if (earlyMsg) return fail(earlyMsg);
          }
          if (msg.worktree && !resumed && isGitRepo(cwd)) {
            try {
              // Create the checkout under the DROP USER's own home (not the
              // server's `/root`, which that user cannot traverse) and hand it to
              // them, so a dropped agent — notably every Tweak agent — can
              // actually work in it instead of landing on the invalid-settings
              // screen. `agentStateHome(null)` is the server home, so mono-tenant
              // is byte-for-byte unchanged.
              worktree = createWorktree(cwd, id.slice(0, 8), agentStateHome(earlyUser));
              effectiveCwd = worktree.path;
              await chownAgentStateToDropUser(worktree.path, earlyUser);
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

          // People-boundary authorization on RESUME (security gate), hoisted
          // ABOVE the live-attach branch below. The stored group drives a
          // privilege drop to that group's OS user, so resuming a group's agent
          // is driving a process AS that group. A caller who cannot SEE the
          // stored group must be refused — never resumed under the commons user
          // either, which would still open someone else's transcript. This MUST
          // run before the `sessions.get(id)` attach: attaching to a CURRENTLY
          // LIVE foreign-group session would otherwise bypass the check entirely
          // and leak its history/screen/stream broadcasts to an unauthorized
          // client. Only matters in multi-tenant (mono-tenant writes no group and
          // drops to no user, so `canResumeAs` is a trivial pass; the mode gate
          // keeps a stray legacy group from ever producing a false refusal
          // there). `storedGroupId`/`groupsNow` are reused by the isolation
          // policy and `agentGroupId` below.
          const storedGroupId = resumed
            ? loadChannels().find((c) => c.sessionId === id)?.group ?? null
            : null;
          const groupsNow = loadGroups();
          if (
            resumed &&
            DEPLOYMENT_MODE === "multi-tenant" &&
            // The server resuming a channel it manages (every `driveChannel`
            // delivery is a resume) is authorized regardless of group — same
            // unforgeable secret-based exemption as `mayDriveSession`.
            !isSystemDrive &&
            !canResumeAs(storedGroupId, groupsNow, viewerFor(me))
          ) {
            console.log(
              `resume: ${id.slice(0, 8)} refused — ${me?.name ?? "anon"} is not entitled to group ${storedGroupId}`,
            );
            return fail(
              "you are not entitled to resume this agent — its group is not yours",
              "forbidden",
            );
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
            const turns = historyWithOffers(loadHistory(session.cwd, id, session.transcriptHome), id);
            if (turns.length) send({ type: "history", turns });
            send({
              type: "ready",
              instanceKey: instanceKey(),
              sessionId: id,
              preprompt: prepromptById.get(id) ?? [],
              stale: sessionStaleness(session),
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
            send(profileMessage(session));
            if (session.contextPct !== null) send({ type: "context", pct: session.contextPct });
            if (session.shells || session.monitors)
              send({ type: "background", shells: session.shells, monitors: session.monitors });
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
          // The model, resolved the same way and for the same reason: it is
          // applied at spawn, so a resume that forgot it would quietly move a
          // running agent onto another model — the registry has the last word
          // (invariant 1), never the client.
          let model: string | null = msg.model?.trim() || null;
          if (resumed) {
            const stored = loadChannels().find((c) => c.sessionId === id)?.model;
            if (stored != null) model = stored;
          }
          // The effort, resolved the same way and for the same reason as the
          // model: it is a spawn flag, so a resume that forgot it would quietly
          // drop a running agent back to the default effort. The registry has
          // the last word (invariant 1), never the client. An unrecognised
          // level is dropped and logged rather than refused — killing a spawn
          // over a thinking setting would be a worse outcome than one that runs
          // at the default, and the CLI itself would only have warned.
          let effort: string | null = msg.effort?.trim() || null;
          if (effort !== null && !isEffortLevel(effort)) {
            console.log(`agent: ${id.slice(0, 8)} effort ignored (unknown level: ${effort})`);
            effort = null;
          }
          if (resumed) {
            const stored = loadChannels().find((c) => c.sessionId === id)?.effort;
            if (stored != null) effort = stored;
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
          // The tab name for a NEW agent (pilotctl `--name`). Applied only on a
          // spawn — a resume must never overwrite a name the user changed in the
          // UI. Trimmed and capped; blank falls back to the client's derived
          // default. ASSERT-only in the upsert below, like `parent` (invariant 24).
          const initialName =
            !resumed && typeof msg.name === "string" && msg.name.trim()
              ? msg.name.trim().slice(0, 80)
              : undefined;
          // Isolation wall: the OS user to drop to, and the group a NEW agent is
          // born into — BOTH derived from the caller's own identity (`me`), never
          // from the caller's identity. A start msg MAY name its target group,
          // honoured only when `canSeeGroup` (public or member), else ignored: it
          // can place an agent in a group you belong to, never plant one in a
          // group you don't. A resume keeps the channel's stored group and runs as
          // that group's user. Mono-tenant resolves to no user / no group, so the
          // spawn and the channel record stay byte-for-byte today's.
          // `storedGroupId`/`groupsNow` and the resume people-boundary gate were
          // resolved ABOVE the live-attach branch (see CRIT1 note there).
          const requestedGroupId =
            !resumed && typeof msg.group === "string" && msg.group.trim() ? msg.group.trim() : null;
          const isolation = resolveSpawnIsolation({
            mode: DEPLOYMENT_MODE,
            resumed,
            viewer: viewerFor(me),
            groups: groupsNow,
            storedGroupId,
            requestedGroupId,
          });
          // The group this agent really belongs to: a resume keeps the channel's
          // stored group; a new spawn gets the one the isolation policy derived
          // from the caller's identity. Both null in mono-tenant → secrets = Main.
          const agentGroupId = resumed ? storedGroupId : isolation.groupPatch.group ?? null;
          // T15 carry: a COMMONS agent (no dedicated group user) must not run as
          // root post-migration — drop it to the non-root `main` once migration
          // has completed. Before migration (or mono-tenant) this is null and the
          // commons stays the server's own user, byte-for-byte today's.
          const dropUser = isolation.user ?? commonsOsUser({ migrated: groupsMigrated, mode: DEPLOYMENT_MODE });
          // Agents that drop to a non-root OS user have no keychain and authenticate
          // from the injected MT_CLAUDE_OAUTH_TOKEN (`makePilot` injects it exactly
          // when it has a user). Keyed on THIS spawn's `dropUser` — the same value
          // handed to makePilot — and skipped for a custom backend, which uses its
          // own key and never the subscription. Without the token, say so plainly
          // instead of letting the spawn die on a bare auth error.
          const mtMsg = mtRefusal(dropUser);
          if (mtMsg) return fail(mtMsg);
          session = await createSession(
            id, effectiveCwd, args, worktree, profile, model, effort,
            spawnActor({ account: me?.name, origin: msg.origin, peer: callerPeer, parent: parentAtStart, agent: callerAgent?.name }),
            dropUser,
            agentGroupId,
          );
          // One Live per agent (shared-ledger [5d8d]). We only reach here when
          // there was no live session to attach to — but `existing` may be a
          // RETIRED Live whose pilot has exited while viewers are still
          // attached (a web tab, a Telegram bridge). `createSession` has just
          // replaced it in the registry; without a handover those viewers are
          // orphaned on the old object — still fed the agent's answers by its
          // lingering tail, but cut off from every broadcast on the new Live
          // (the other interfaces' prompt echoes, dialogs, working/turn-done).
          // Move them onto the new Live and quiet the old one — without killing
          // the agent, which the new Live may now be driving on the same pane.
          if (existing && existing !== session) {
            const moved = supersedeSession(existing, session);
            if (moved)
              console.log(`session ${id.slice(0, 8)}: superseded a retired Live, moved ${moved} viewer(s)`);
          }
          session.clients.add(ws);
          if (resumed) {
            const turns = historyWithOffers(loadHistory(effectiveCwd, id, session.transcriptHome), id);
            if (turns.length) send({ type: "history", turns });
          }
          send({
            type: "ready",
            instanceKey: instanceKey(),
            sessionId: id,
            preprompt: prepromptById.get(id) ?? [],
            stale: sessionStaleness(session),
            cwd: effectiveCwd,
            branch: worktree?.branch ?? null,
          });
          // Mirroring drops an agent into the (admin-owned) Telegram board, so
          // only an admin may enable it. A non-admin's `true` is DROPPED (not a
          // spawn failure — same spirit as a refused parent link); an explicit
          // `false`, or an absent field, is left untouched. Agents authenticate
          // as the bootstrap admin (session key), so pilotctl-driven mirroring
          // is unaffected.
          const effMirror =
            typeof msg.mirror === "boolean" ? msg.mirror && me?.role === "admin" : undefined;
          if (msg.mirror === true && me?.role !== "admin")
            console.log(`mirror: refused for non-admin ${me?.name ?? "anon"} on ${id.slice(0, 8)}`);
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
            // profile is ASSERT-only too (invariant 1): a resume sends none, so
            // `msg.profile ?? null` resolves to null here and writing it ERASED
            // the channel's role. Keep the stored one unless the client chose
            // explicitly (a name, or null for "no profile"). This is exactly what
            // nine agents lost during the 2026-09-24 restart churn.
            ...profilePatch(profile, msg.profile !== undefined),
            // ASSERT-only, like `branch`, `repo` and `parent` (invariant 24): a
            // client that omits the field must never erase a model the channel
            // already carries. This line is the whole feature — `parent` was
            // typed, sent, unit-tested and silently DROPPED here, and only an
            // end-to-end run found it. `test/agent-model.test.ts` asserts the
            // value comes back out of the registry, not that it compiles.
            ...(model !== null ? { model } : {}),
            // ASSERT-only for the same reason, and the resume path above reads
            // it back: a spawn-time effort that was never stored would vanish
            // the first time the agent is reopened.
            ...(effort !== null ? { effort } : {}),
            // The form's choice, recorded as soon as we're `ready` — that's
            // where the Telegram loop reads it. Absent (a client that ignores
            // the field) → decide nothing, and `isMirrored` falls back to the
            // binding. Admin-gated just above (`effMirror`).
            ...(effMirror !== undefined ? { mirror: effMirror } : {}),
            // Who launched this agent, sent by pilotctl from its own
            // SHADOK_SESSION_ID. ASSERT-only, like `branch` and `repo`: a
            // client that omits the key must not erase a link that already
            // exists. Validated for the same reasons `set-parent` validates —
            // a cycle here would be just as expensive.
            ...(parentAtStart !== undefined ? { parent: parentAtStart } : {}),
            // The remote peer that created this agent — the ownership key. Set
            // whenever the caller is a peer (idempotent on its own resume); never
            // written for a local caller, so a plain agent has no owner. Like
            // `parent`, this is a field that must be PROVEN stored, not merely
            // accepted (invariant 24) — the e2e checks the channel carries it.
            ...(callerPeer ? { createdByPeer: callerPeer } : {}),
            // The spawn-time name (pilotctl `--name`). ASSERT-only and computed
            // above so it can never fire on a resume — a UI rename must win.
            ...(initialName ? { name: initialName } : {}),
            // The group a NEW agent is born into, set SERVER-SIDE from the
            // caller's own identity (never the client payload — `group` is
            // SERVER_OWNED, so a PUT /channels cannot touch it either). Empty on
            // a resume (the stored group is kept) and in mono-tenant (group-less
            // = commons, today's behaviour). A channel is never born with a
            // dangling group id: `spawnGroupFor` returns a real group or null.
            ...isolation.groupPatch,
          });
          send({ type: "tokens", tokens: tokenTotals(session) });
          send(profileMessage(session));
            if (session.contextPct !== null) send({ type: "context", pct: session.contextPct });
            if (session.shells || session.monitors)
              send({ type: "background", shells: session.shells, monitors: session.monitors });
          sendPendingDialog(session, send);
          break;
        }

        case "prompt": {
          if (!session) return fail("no session started");
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
          if (session.busy) return fail("a response is already in progress", "busy");
          const text = msg.text.trim();
          if (!text) return;
          // The Telegram bridge is trusted to name its sender — it knows it. A
          // browser is not: for a web client the SESSION decides, and whatever
          // `from` the frame carried is discarded. An agent is not trusted
          // either: its name comes from the key that signed the socket.
          const author = promptAuthor(origin, me?.name, msg.from, callerAgent?.name);
          // Above the ideal pace, a prompt needs an explicit second click. The
          // check lives here because this is the single door every user prompt
          // goes through — including the pilotctl thin client.
          // A custom backend spends no subscription quota: nothing to pace.
          if (!msg.force && session.backend !== "custom") {
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
            // A prompt from SOMEONE (web/telegram/cli, or a sibling agent) gets a
            // context header — platform, time, and sender when known — so the
            // agent knows who is talking and when. Only the TUI (and thus the
            // transcript) receives it; the echo above stays clean, and
            // loadHistory strips the header on replay.
            //
            // `agent` is in that list for the reason the others are: without it
            // an agent driving another through pilotctl arrived as a bare user
            // message, indistinguishable from the human's own — so the receiving
            // agent obeyed a peer believing it was the person who owns the
            // cockpit. The HIDDEN machine paths are the ones that get no header:
            // a cron fire and a parent notification carry their own mark, are
            // not "someone speaking", and reach the TUI through driveChannel
            // (`origin: "cron"`), so they never match here.
            let submitText = text;
            if (origin === "web" || origin === "telegram" || origin === "cli" || origin === "agent") {
              // A transcribed voice note says so IN the platform field rather than
              // through a different `origin`: the gate just above matches the origin
              // EXACTLY, so an origin of "telegram vocal" would drop the header
              // entirely — losing the time and the sender to gain one word.
              // `parsePromptMeta` reads the platform as the first field and the
              // sender as everything past the time, so this widens neither.
              const platform = msg.voice === true ? `${origin} vocal` : origin;
              // An agent header ends with the sender's REPLY ADDRESS — its short
              // session id — because a name is not an address: nothing makes tab
              // names unique and every tool takes an id, so naming the sender was
              // only half of telling the receiver who it is. Short because
              // `resolveResumeId` resolves a prefix (and refuses an ambiguous one
              // rather than guessing). It is stripped back out by
              // `parsePromptMeta`, so it never reaches the chat.
              const ref = origin === "agent" ? callerAgent?.id.slice(0, 8) : undefined;
              submitText = markPromptMeta(
                text,
                promptMetaHeader(platform, new Date(), author, defaultTimeZone(), ref),
              );
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
            // It goes in as its OWN paste, never concatenated into the message.
            // Claude Code keeps only the current paste inline (≤800 chars and
            // ≤2 newlines) and wraps everything else in `<pasted_content>` —
            // which its own system prompt says to act on only where the user's
            // message asks. Pasted as one blob, the HUMAN's words ended up
            // inside that wrapper and stopped being an instruction: an agent
            // answered a direct order with "I haven't acted on that line, since
            // it came from the pasted text". As a separate, earlier paste the
            // block is wrapped — which is correct, it IS injected context — and
            // the message stays outside it.
            let ledgerSeen: number | null = null;
            let ledgerPrelude: string[] | undefined;
            if (ledgerEnabled) {
              // The agent's group comes from its CHANNEL (server-side, never the
              // message). One table; `deltaSince`'s visibleScope keeps only this
              // group's own rows + the commons' public ones — another group's
              // group-scoped rows never reach it.
              const ledgerGroup = loadChannels().find((c) => c.sessionId === session!.id)?.group ?? null;
              const { rows, total } = deltaSince(
                loadLedger(ledgerFileFor(process.cwd())),
                session.ledgerSeenAt ?? 0,
                LEDGER_PUSH_CAP,
                { groupId: ledgerGroup ?? MAIN_GROUP_ID, includePublic: true },
              );
              ledgerSeen = Date.now();
              // One paste per chunk, and the threshold is applied per paste —
              // which is what lets the whole delta travel in the clear.
              if (rows.length) ledgerPrelude = formatLedgerChunks(rows, total);
            }
            await submitGuarded(session, submitText, ledgerPrelude);
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

        case "run": {
          if (!session) return fail("no session started");
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
          if (!fromBrowser) return fail("running a shell-mode command is reserved to the cockpit's browser");
          const refusal = runRefusal(msg.command);
          if (refusal) return fail(refusal);
          if (session.busy) return fail("a response is already in progress", "busy");
          const command = String(msg.command).trim();
          console.log(`run: ${session.id.slice(0, 8)} ${me?.name ?? "?"} → ${command.slice(0, 120)}`);
          session.busy = true;
          session.turnStartedAt = Date.now();
          broadcast(session, workingMessage(session));
          try {
            // `!` alone first, then WAIT for the pane to show shell mode — never
            // a fixed delay (invariant 3: a tmux screen is a mirror refreshed on a
            // poll, so a sleep races it). Only then does the robust `submit` type
            // the command: `inputText` already reads the "! …" line, so its
            // "did the text appear?" check holds in shell mode too.
            session.pilot.write("!");
            await session.pilot.waitFor(isShellMode, { timeoutMs: 5_000 });
            await submitGuarded(session, command);
          } catch (e) {
            // Leave no stray `!` behind: a half-entered shell mode would turn the
            // NEXT prompt into a command.
            try { session.pilot.press("escape"); } catch { /* pane gone */ }
            session.busy = false;
            return fail(`the command could not be run: ${e instanceof Error ? e.message : e}`);
          } finally {
            session.busy = false;
          }
          // The agent reacts to the output like to any turn; finishTurn settles it.
          await finishTurn(session);
          break;
        }

        case "choose": {
          // Single select. Preview-style dialogs ("Enter to select · ↑/↓ to
          // navigate") ignore digit keys, so navigate the ❯ cursor to the
          // target option with arrows, then Enter (works for all variants).
          if (!session) return fail("no session started");
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
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
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
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
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
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
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
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
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
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
              // ...but not while the prompt is still being typed: there the
              // key would delete the text rather than stop a turn. Hold it.
              if (session.submitting) {
                session.pendingInterrupt = msg.key as "escape" | "ctrl-c";
                break;
              }
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
          // SEE gate: the raw term-data stream carries the foreign agent's full
          // screen, so an attach is a cross-group content leak just like history.
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
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
          // DRIVE gate: raw keystrokes go straight to the pilot process.
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
          if (typeof msg.data === "string") session.pilot.sendRaw(Buffer.from(msg.data, "base64"));
          break;
        }
        case "term-resize": {
          // Fit the pane to the browser terminal so the full-screen view fills.
          // Original size is remembered and restored when the pipe detaches.
          if (!session || !(session.pilot instanceof TmuxPilot)) return;
          // DRIVE gate: resizing another group's pane perturbs its process.
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
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
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
          await finishTurn(session);
          break;
        }

        case "restart": {
          if (!session) return fail("no session started");
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
          await restartSession(session, wsBy());
          break;
        }
        case "set-profile": {
          // Changing what an agent IS (role, guardrails, secrets, model) after
          // the fact. `profile` is SERVER_OWNED on the channel, so a browser PUT
          // can't touch it — this is the only legitimate path.
          if (!session) return fail("no session started");
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
          const s = session;
          const name = msg.profile ?? null;
          // Refuse an unknown name rather than silently spawning bare: a typo
          // would strip the agent of its guardrails without anyone noticing.
          if (name !== null && !getProfile(name)) return fail(`unknown profile: ${name}`);
          s.profile = name;
          upsertChannel({ sessionId: s.id, profile: name });
          broadcastProfile(s);            // even without a restart: the gap shows everywhere
          if (msg.restart) await restartSession(s, wsBy());
          break;
        }
        case "set-model": {
          // Change what model this agent runs on. `--model` is a spawn arg, so a
          // running process can't switch mid-flight: this ALWAYS respawns (a
          // "set desired, apply later" would show a model as running that isn't).
          // The old process is cut short like Reload agent — catching an agent on
          // the wrong model is exactly the point.
          if (!session) return fail("no session started");
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
          const s = session;
          const model = msg.model?.trim() || null;
          s.model = model ?? undefined;
          upsertChannel({ sessionId: s.id, model });
          await restartSession(s, wsBy()); // respawns with the new --model (s.model)
          broadcastProfile(s);            // running == desired now
          break;
        }
        case "set-effort": {
          // How hard this agent thinks. `--effort` is a spawn arg, so like
          // `--model` a running process cannot change mid-flight: this ALWAYS
          // respawns rather than recording a wish, because an effort shown as
          // running while it is not is the failure this feature would be.
          if (!session) return fail("no session started");
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
          const s = session;
          const wanted = msg.effort?.trim() || null;
          // Refuse out loud. The CLI would merely warn and fall back to the
          // default, so a typo accepted here runs the agent at an effort nobody
          // chose while the picker shows the one they clicked.
          if (wanted !== null && !isEffortLevel(wanted))
            return fail(`unknown effort level: ${wanted}`);
          s.effort = wanted ?? undefined;
          upsertChannel({ sessionId: s.id, effort: wanted });
          await restartSession(s, wsBy()); // respawns with the new --effort
          broadcastProfile(s);            // running == desired now
          break;
        }
        case "set-parent": {
          // Attach this agent under another, or detach with null. `parent` is
          // SERVER_OWNED on the channel, so a browser PUT can't touch it —
          // this is the only legitimate path, exactly like `set-profile`.
          if (!session) return fail("no session started");
          if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");
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
          if (!mayDriveSession(id)) return fail("you are not entitled to drive this agent", "forbidden");
          // A RESTRICTED peer may only stop ITS OWN agents; a member peer stops
          // any (like a member). The guard is for an explicit `sessionId` naming
          // someone else's — the bound `session` is already its own.
          if (callerPeer && callerPeerRestricted) {
            const ch = loadChannels().find((c) => c.sessionId === id);
            if (!ownedByPeer(ch, callerPeer)) return fail("a restricted peer may only stop its own agents", "peer-scope");
          }
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

/**
 * The `shadok-files` skill — handing a file to the person driving the cockpit.
 *
 * Seeded like its siblings, and the seeding is the point: `copyFileSync` runs
 * at EVERY boot, so this reaches agents that already exist without a reload.
 * The pilot prompt cannot do that (it is fixed at spawn), which is exactly why
 * the capability lives in a skill and only its rationale lives in the prompt.
 */
function seedFilesSkill(): void {
  try {
    const src = path.join(__dirname, "..", "context", "files-skill");
    if (!fs.existsSync(path.join(src, "SKILL.md"))) return;
    const dst = path.join(os.homedir(), ".claude", "skills", "shadok-files");
    fs.mkdirSync(path.join(dst, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(src, "SKILL.md"), path.join(dst, "SKILL.md"));
    fs.copyFileSync(path.join(src, "scripts", "send.mjs"), path.join(dst, "scripts", "send.mjs"));
    fs.chmodSync(path.join(dst, "scripts", "send.mjs"), 0o755);
  } catch {
    /* best effort — a missing skill means paths get printed, not a broken boot */
  }
}
seedFilesSkill();

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

// Multi-tenant: also install every skill machine-wide (Enterprise tier), so the
// per-tenant `sk-*` agents — which run under their own HOME, not the server's —
// get them without a per-HOME copy. Mono-tenant/dev keeps the personal install
// above and never touches /etc.
if (DEPLOYMENT_MODE === "multi-tenant") seedSystemSkills();

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

// Task 15: on the first boot of a CAPABLE instance, move the running
// single-tenant instance into isolated groups (create the non-root commons user
// `main`, chown the tree to it, vault→Main, provision per-account private
// groups, label what exists public). Gated by a shadok-data-volume marker +
// DEPLOYMENT_MODE, fully fail-safe. Runs here — after the Claude home + SSH
// identity, BEFORE any spawn (reconcileOnBoot / startFirstAgent) — and
// fire-and-forget so a slow migration never hangs the boot. A spawn that races
// it uses the pre-migration (root) drop until `groupsMigrated` flips.
// `maybeRunGroupsMigration` owns the mono-tenant no-op (it sets `groupsMigrated`
// from the marker), the in-flight guard, and the post-migration reprovision
// (`ensureGroupsProvisioned`) — so the boot trigger and the post-sign-in retry
// (in `/auth/code`) share one code path.
void maybeRunGroupsMigration("boot");

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
  tgBridge = startTelegram(port, tgCookie(), DEPLOYMENT_MODE === "multi-tenant");
  if (GUI_PASSWORD) console.log("gui: password protection ON");
  // Cron scheduler: prime nextRun then tick every 30s (unref'd so it never
  // keeps the process alive on its own).
  primeCrons();
  const cronTimer = setInterval(cronTick, 30_000);
  cronTimer.unref();
  // Reload indicator: re-evaluate every live agent's staleness once a minute and
  // push it when it changed — this is how a profile edit, a newly-seeded skill or
  // a freshly-installed `claude` reaches an idle agent's tab without any traffic
  // on it. One `claude --version` per sweep at most (the version is cached).
  const staleTimer = setInterval(() => {
    const channels = loadChannels();
    for (const s of sessions.values()) if (!s.pilot.hasExited) broadcastStaleness(s, channels);
  }, 60_000);
  staleTimer.unref();
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
  // Announce here, not only inside the deferred call: the browser is opening
  // NOW and would otherwise be told there is nothing coming for a second and a
  // half — the whole window this status exists to fill.
  announceFirstAgent(countMainChannels(loadChannels()));
  setTimeout(() => void startFirstAgent(), 1500).unref?.();
});
