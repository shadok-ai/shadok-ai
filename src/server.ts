import { randomUUID, timingSafeEqual, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
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
  findSessionId,
  lastPromptAt,
  listSessions,
  loadHistory,
  resumedTurnStart,
  type TuiDialog,
} from "./extract.js";
// Même implémentation que la preview du client web (JS pur, chargé tel quel par
// le navigateur) : une seule source pour lire le texte en vol à l'écran.
import { extractLiveText } from "../public/live-text.js";
import { findTransientErrors, newTransientErrors, RETRY_DELAYS_MS } from "./retry.js";
import { screenShowsWork } from "./detect.js";
import { PtyPilot } from "./session.js";
import { ensureSshIdentity } from "./ssh.js";
import { TmuxPilot, tmuxAvailable, tmuxHasSession, tmuxPaneCwd } from "./tmux.js";
import { scanUsage, sessionFilePath, tailSession, clearTailPos, type TokenUsage } from "./tail.js";
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
} from "./channels.js";
import {
  startTelegram,
  renameTelegramTopic,
  closeTelegramTopic,
  probeToken,
  isStalePreface,
  type TelegramHandle,
} from "./telegram.js";
import { migrateTgBindings } from "./channels.js";
import {
  loadCrons,
  saveCrons,
  upsertCron,
  removeCron,
  resolveCronId,
  resolveCronTarget,
  nextRunFor,
  nextRunAfterFailure,
  isTransient,
  CRON_MAX_RETRIES,
  markCronPrompt,
  normalizeSchedule,
  scheduleLabel,
  cronTimeZone,
  defaultTimeZone,
  systemTimeZone,
  isValidTimeZone,
  type Cron,
  type CronTarget,
  type DriveReason,
} from "./crons.js";
import {
  loadConfig,
  saveConfig,
  telegramConfig,
  applyTelegramPatch,
  type TelegramPatch,
} from "./config.js";
import { secretsFor, secretNames, setSecret, deleteSecret } from "./secrets.js";
import {
  getProfile,
  profileArgs,
  permissionModeArgs,
  isPermissionMode,
  envVarsNote,
  seedDefaultProfiles,
  seedTweakProfile,
  loadProfiles,
  upsertProfile,
  removeProfile,
  type Profile,
} from "./profiles.js";
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
import { isNewer } from "./version.js";
import { RELOAD_EXIT_CODE } from "./supervisor.js";
import { acquireInstanceLock, releaseInstanceLock } from "./lock.js";
import { bindRefusal, originAllowed, parseOrigins, resolveHost } from "./net.js";
import { cspHeader, injectNonce, NONCE_PLACEHOLDER } from "./csp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_PORT = Number(process.env.PORT ?? 3789);
const MAX_PORT_TRIES = 20;
// Interface d'écoute : la loopback par défaut (le cockpit lance des commandes,
// il ne s'expose pas au réseau sans qu'on le demande). SHADOK_HOST=0.0.0.0 pour
// un conteneur — voir bindRefusal, qui exige alors un mot de passe.
const HOST = resolveHost(process.env);
// Origines navigateur acceptées en plus du same-origin (un reverse proxy qui
// réécrit le Host, typiquement).
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
const AUTH_TOKEN = GUI_PASSWORD
  ? createHmac("sha256", GUI_PASSWORD).update("shadok-ai-auth-v1").digest("hex")
  : "";

// The live Telegram bridge handle + the port we actually bound, so the
// /telegram endpoint can tear it down and recreate it hot (no server restart).
let tgBridge: TelegramHandle = {
  stop() {},
  running: () => false,
  status: () => ({ username: null, tokenError: null }),
};
let boundPort = 0;
const tgCookie = () => (GUI_PASSWORD ? `sk_auth=${AUTH_TOKEN}` : undefined);
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
function runCronCheck(c: Cron, target: CronTarget): Promise<CheckResult> {
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
  const target = resolveCronTarget(loadChannels(), c.sessionId, process.cwd());
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
    promptText = `Résultat du monitoring (traite-le, alerte si nécessaire) :\n${check.out}\n\n${c.prompt}`;
    checkNote = ` (check: ${(Buffer.byteLength(check.out) / 1000).toFixed(1)} kB)`;
  } else if (check.kind === "failed") {
    // A broken guard used to disable the cron in silence. Wake the agent so it
    // can raise the alarm — a monitoring job that dies quietly is the bug we're
    // fixing. It costs tokens every slot until the guard is repaired.
    promptText =
      `La commande de garde de ce cron a échoué (${check.detail}). Aucune donnée de monitoring n'a pu être collectée. ` +
      `Signale-le, et si tu peux, diagnostique la commande :\n\`\`\`\n${c.check}\n\`\`\`\n\n${c.prompt}`;
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
function driveChannel(sessionId: string, text: string, target: CronTarget): Promise<DriveOutcome> {
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
  // `nextRun` was already advanced to the next normal slot before firing.
  const slot = c.nextRun ?? nextRunFor(c.schedule, Date.now(), cronTimeZone(c));
  const r = nextRunAfterFailure(Date.now(), slot, c.retries ?? 0);
  c.nextRun = r.nextRun;
  c.retries = r.attempts;
  console.log(
    r.retrying
      ? `${cronTag(c)} skipped: ${reason}, retry in ${Math.round((r.nextRun - Date.now()) / 60_000)}m (${r.attempts}/${CRON_MAX_RETRIES})`
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
    c.nextRun = nextRunFor(c.schedule, now, cronTimeZone(c));
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
 * Un `nextRun` déjà stocké est RECALCULÉ s'il est dans le futur : sinon, poser
 * `timezone` sur un serveur en UTC ne prendrait effet qu'après un dernier tir à
 * la mauvaise heure. Un `nextRun` dans le PASSÉ est laissé tel quel — il est dû
 * (tir manqué pendant l'arrêt) et `cronTick` doit encore le rattraper.
 */
function primeCrons(): void {
  const now = Date.now();
  const list = loadCrons();
  let changed = false;
  for (const c of list) {
    if (!c.enabled) continue;
    if (c.nextRun != null && c.nextRun <= now) continue; // dû : on ne l'escamote pas
    // Un `interval` n'est recalculé que s'il MANQUE : le recalculer repousserait
    // l'échéance à chaque démarrage, et le serveur redémarre à chaque
    // auto-update — un cron de 30 min pourrait alors ne jamais tirer.
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
function requestAuthed(req: { headers: Record<string, unknown> }): boolean {
  if (!GUI_PASSWORD) return true;
  const tok = cookieToken(req.headers.cookie as string | undefined);
  if (!tok || tok.length !== AUTH_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(tok), Buffer.from(AUTH_TOKEN));
}
function passwordMatches(input: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(GUI_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}
// Le handler de soumission est un bloc <script> nonce-é, plus un `onsubmit=`
// inline : la CSP interdit les attributs de gestionnaire (c'est précisément ce
// qui neutralise un `<img onerror>` injecté ailleurs), et une page de login qui
// s'exempterait de sa propre politique serait un drôle de message.
const LOGIN_HTML = `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
<title>shadok-ai — login</title><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#14161a;color:#e8e8ea;font-family:system-ui}
form{background:#1b1d22;padding:28px;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.5);width:min(320px,90vw)}
h1{font-size:16px;margin:0 0 14px;color:#e0a44a}input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:7px;border:1px solid #333;background:#0d0f12;color:inherit;font-size:14px}
button{margin-top:12px;width:100%;padding:9px;border-radius:7px;border:none;background:#e0a44a;color:#14161a;font-weight:600;cursor:pointer}.err{color:#e26;font-size:12px;margin-top:8px;min-height:14px}</style>
<form id=f>
<h1>◆ shadok-ai</h1><input id=pw type=password placeholder="Password" autofocus autocomplete=current-password><button>Enter</button><div class=err></div></form>
<script nonce="${NONCE_PLACEHOLDER}">
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  fetch("/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }),
  }).then((r) => (r.ok ? location.reload() : (document.querySelector(".err").textContent = "Wrong password")));
});
</script>`;

/** Sert la page de login avec sa CSP et son nonce (elle sort du gate, donc elle
 *  ne passe pas par la route de l'index). */
function sendLogin(res: express.Response): void {
  const nonce = randomUUID();
  res.setHeader("Content-Security-Policy", cspHeader(nonce));
  res.status(401).type("html").send(injectNonce(LOGIN_HTML, nonce));
}

/** Le garde same-origin de ce serveur (cf. `originAllowed`). */
function requestOriginOk(req: { headers: Record<string, unknown> }): boolean {
  return originAllowed(
    req.headers.origin as string | undefined,
    req.headers.host as string | undefined,
    EXTRA_ORIGINS,
  );
}

// Un navigateur d'une autre origine n'a rien à faire ici — /login compris, sinon
// une page tierce peut essayer des mots de passe. Placé AVANT tout le reste.
app.use((req, res, next) => {
  if (requestOriginOk(req)) return next();
  res.status(403).json({ error: "cross-origin request refused" });
});

// Login endpoint (always reachable) — sets an HttpOnly session cookie.
app.post("/login", (req, res) => {
  if (!GUI_PASSWORD) return res.json({ ok: true });
  if (passwordMatches(String(req.body?.password ?? ""))) {
    res.setHeader(
      "Set-Cookie",
      `sk_auth=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`,
    );
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "wrong password" });
});
// Gate everything else behind the cookie when a password is set.
app.use((req, res, next) => {
  if (requestAuthed(req)) return next();
  if (req.method === "GET" && (req.headers.accept ?? "").includes("text/html"))
    return sendLogin(res);
  return res.status(401).json({ error: "unauthorized" });
});

// La page passe par ici AVANT express.static : elle doit recevoir le nonce de
// sa CSP, ce qu'un fichier servi tel quel ne peut pas faire.
//
// Relue à CHAQUE requête, comme le ferait express.static. La version d'avant la
// gardait en mémoire — « elle ne change pas en cours d'exécution » — et servait
// donc une page périmée dès qu'on éditait index.html : on recharge, rien ne
// bouge, on cherche le bug ailleurs. Un fichier de 170 Ko lu une fois par
// ouverture d'onglet ne se mesure pas ; le piège, si.
const INDEX_PATH = path.join(__dirname, "..", "public", "index.html");
app.get(["/", "/index.html"], (_req, res) => {
  let html: string;
  try {
    html = fs.readFileSync(INDEX_PATH, "utf8");
  } catch {
    return res.status(500).type("text").send("index.html introuvable");
  }
  const nonce = randomUUID();
  res.setHeader("Content-Security-Policy", cspHeader(nonce));
  res.type("html").send(injectNonce(html, nonce));
});

app.use(express.static(path.join(__dirname, "..", "public")));
// Markdown parser served locally (history rendering on the client).
// Résolu via require.resolve, pas un chemin en dur : dans l'install npm
// (~/.shadok-ai/app), marked est hoisté au-dessus de node_modules/shadok-ai
// et le chemin relatif à __dirname 404ait — le client retombait en texte brut.
const require = createRequire(import.meta.url);
const markedUmd = path.join(
  path.dirname(require.resolve("marked/package.json")),
  "lib",
  "marked.umd.js",
);
// `dotfiles: "allow"` est OBLIGATOIRE : l'app est installée sous ~/.shadok-ai/,
// donc le chemin absolu de marked contient un segment `.shadok-ai`. Express 5 /
// `send` traite tout segment commençant par `.` comme un dotfile et, avec le
// défaut `ignore`, renvoie 404 SANS jamais stat le fichier — le client retombait
// alors en texte brut (Markdown non rendu). (express.static plus haut n'est pas
// touché : quand un `root` est fixé, send ne teste que les segments RELATIFS.)
app.get("/vendor/marked.js", (_req, res) =>
  res.sendFile(markedUmd, { dotfiles: "allow" }),
);
// Sanitiseur HTML — le transcript rend du Markdown écrit par l'agent, donc
// dérivé de contenu non fiable (un README cloné, une page web, un message
// Telegram). On résout le build navigateur DIRECTEMENT : contrairement à
// marked, dompurify ne publie pas `./package.json` dans ses `exports`, donc le
// détour par le dossier du paquet lève ERR_PACKAGE_PATH_NOT_EXPORTED. Ce
// sous-chemin-ci, lui, est exporté.
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
  res.json(gitDiff(s.cwd, s.worktree?.baseSha ?? null));
});
// Past worktree sessions of a repo (for reopening unfinished work).
app.get("/recover", (req, res) => {
  const repo = String(req.query.repo ?? "").trim() || process.cwd();
  res.json(isGitRepo(repo) ? listPastSessions(repo) : []);
});
// Server-side defaults (the launch directory pre-fills the working dir field).
app.get("/defaults", (_req, res) => {
  res.json({ cwd: process.cwd() });
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
app.get("/version", (_req, res) =>
  res.json({ current: OWN_VERSION, latest: latestKnown, autoUpdate, permissionMode }),
);
// Channel list, persisted server-side per launch directory — survives a wiped
// browser, another device, a restart or a reboot.
/**
 * Le registre, enrichi de ce que le client ne peut pas déduire seul : les
 * horaires programmés de chaque canal (l'onglet en montre une ⏰).
 *
 * Dérivé à la lecture, jamais stocké : la browser PUT ne renvoie qu'une forme
 * fixe (cf. invariant 6), donc ce champ ne peut pas polluer le registre. Et
 * c'est ce qui évite un second poll — `/channels` est déjà relu toutes les 4 s.
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
  const schedule = normalizeSchedule(b.schedule);
  if (!sessionId || !prompt || !schedule) return res.status(400).json({ error: "sessionId, prompt and a valid schedule are required" });
  const existing = b.id ? loadCrons().find((c) => c.id === b.id) : undefined;
  const enabled = typeof b.enabled === "boolean" ? b.enabled : (existing?.enabled ?? true);
  const check = typeof b.check === "string" && b.check.trim() ? String(b.check).trim() : undefined;
  // Fuseau explicite : refusé s'il est invalide plutôt que silencieusement
  // ignoré — un « Europe/Pariss » qui retomberait sur le fuseau machine ferait
  // exactement le décalage muet qu'on cherche à supprimer.
  const rawTz = typeof b.tz === "string" ? b.tz.trim() : "";
  if (rawTz && !isValidTimeZone(rawTz)) return res.status(400).json({ error: `unknown timezone '${rawTz}'` });
  const tz = rawTz || existing?.tz;
  const cron: Cron = {
    id: existing?.id ?? randomUUID(),
    sessionId,
    prompt,
    schedule,
    enabled,
    ...(check ? { check } : {}),
    ...(tz ? { tz } : {}),
    lastRun: existing?.lastRun,
    nextRun: enabled ? nextRunFor(schedule, Date.now(), cronTimeZone({ tz })) : undefined,
  };
  upsertCron(cron);
  res.json({ ...cron, timezone: cronTimeZone(cron) });
});
// Fuseau par défaut des crons `daily`. GET renvoie aussi le fuseau machine, pour
// que l'appelant puisse montrer ce qui s'applique réellement s'il n'y a rien.
app.get("/timezone", (_req, res) =>
  res.json({ timezone: defaultTimeZone() ?? null, system: systemTimeZone() }),
);
app.post("/timezone", (req, res) => {
  const raw = String(req.body?.timezone ?? "").trim();
  if (raw && !isValidTimeZone(raw)) return res.status(400).json({ error: `unknown timezone '${raw}'` });
  const cfg = loadConfig();
  if (raw) cfg.timezone = raw;
  else delete cfg.timezone; // vide = revenir au fuseau de la machine
  saveConfig(cfg);
  // Les crons déjà programmés visent encore l'ancienne heure : on les réaligne
  // tout de suite, sinon le changement n'a l'air de rien faire jusqu'au premier
  // tir (à la mauvaise heure).
  primeCrons();
  res.json({ timezone: defaultTimeZone() ?? null, system: systemTimeZone() });
});
app.delete("/crons", (req, res) => {
  // Accepte un préfixe (c'est tout ce que les `list` affichent) et dit la
  // vérité : un `{ok:true}` inconditionnel faisait passer une suppression qui
  // n'avait rien supprimé pour un succès — le cron restait, et rien ne le disait.
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
  await endChannel(id);
  res.json({ ok: true });
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
  const { name, value } = req.body ?? {};
  if (typeof name !== "string" || !name.trim() || typeof value !== "string")
    return res.status(400).json({ error: "name and value required" });
  setSecret(name.trim(), value);
  res.json({ names: secretNames() });
});
app.delete("/secrets", (req, res) => {
  const name = String(req.query.name ?? req.body?.name ?? "").trim();
  if (name) deleteSecret(name);
  res.json({ names: secretNames() });
});

// Agent profiles (global): role + permission guardrails + referenced secrets,
// applied at spawn. `secrets` is a list of vault NAMES (not values).
app.get("/profiles", (_req, res) => res.json(loadProfiles()));
app.put("/profiles", (req, res) => {
  const b = req.body ?? {};
  if (typeof b.name !== "string" || !b.name.trim())
    return res.status(400).json({ error: "name required" });
  const p: Profile = {
    name: b.name.trim(),
    systemPrompt: typeof b.systemPrompt === "string" ? b.systemPrompt : undefined,
    deny: Array.isArray(b.deny) ? b.deny.filter((x: unknown) => typeof x === "string") : undefined,
    allow: Array.isArray(b.allow) ? b.allow.filter((x: unknown) => typeof x === "string") : undefined,
    secrets: Array.isArray(b.secrets) ? b.secrets.filter((x: unknown) => typeof x === "string") : undefined,
    model: typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined,
  };
  upsertProfile(p);
  res.json(loadProfiles());
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
  // Le contrôle d'origine compte AUTANT que le cookie : un WebSocket ignore la
  // same-origin policy, donc sans lui n'importe quelle page visitée par
  // l'utilisateur peut ouvrir une session et piloter un agent.
  verifyClient: (info, cb) => cb(requestOriginOk(info.req) && requestAuthed(info.req)),
});
// The ws server re-emits the http server's listen error; let the http server's
// own handler drive the port fallback instead of crashing on the re-emit.
wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") console.error(`ws server error: ${err.message}`);
});

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
function versionMessage(): object {
  return { type: "version", current: OWN_VERSION, latest: latestKnown, autoUpdate, permissionMode };
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
  const r = await update();
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
  const latest = await latestVersion();
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
      /** Qui pilote ce client : "web", "cron", "telegram", "cli"… Voyage avec
       *  l'écho de prompt pour que les autres clients puissent dire qui a parlé. */
      origin?: string;
      /** Should this channel be mirrored into Telegram? Chosen at creation
       *  (the form's checkbox); afterwards the channel menu decides. */
      mirror?: boolean;
    }
  /** `force`: envoyer malgré un dépassement du rythme. Vaut pour ce message seul. */
  | { type: "prompt"; text: string; force?: boolean }
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
const USE_TMUX = process.env.SHADOK_TMUX !== "0" && tmuxAvailable();

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

function makePilot(id: string, cwd: string, args: string[], profileName?: string | null): Pilot {
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
  if (GUI_PASSWORD) env.SHADOK_AUTH = `sk_auth=${AUTH_TOKEN}`;
  // Args = base + profile flags (role / guardrails / model) + a note listing the
  // injected env-var names (so the agent knows what it has) + the cockpit pilot
  // prompt. Profile flags first so a profile never overrides the cockpit context.
  // Les noms RÉSOLUS : un profil qui référence un secret absent du vault ne doit
  // pas faire promettre à l'agent une variable qui n'existe pas.
  const note = envVarsNote(Object.keys(secretEnv));
  const sp = pilotPrompt();
  const fullArgs = [
    ...args,
    ...permissionModeArgs(permissionMode),
    ...profileArgs(profile),
    ...(note ? ["--append-system-prompt", note] : []),
    ...(sp ? ["--append-system-prompt", sp] : []),
  ];
  return USE_TMUX
    ? new TmuxPilot({ cwd, args: fullArgs, env, tmuxName: "sk-" + id })
    : new PtyPilot({ cwd, args: fullArgs, env });
}

interface Live {
  id: string;
  cwd: string;
  pilot: Pilot;
  clients: Set<WebSocket>;
  busy: boolean;
  lastPrompt: string;
  screenTimer: ReturnType<typeof setInterval> | null;
  lastScreen: string;
  /** Context-window usage (%) parsed from the TUI footer, per session. */
  contextPct: number | null;
  /** Stops the .jsonl tail loop (content streaming). */
  stopTail: (() => void) | null;
  /** Les derniers blocs de texte DÉJÀ diffusés, pour ne pas les reproposer en
   *  préface d'une question (cf. `isStalePreface`). Borné : une préface ne peut
   *  décrire qu'un bloc encore visible à l'écran, donc récent — en garder plus
   *  ne ferait qu'augmenter le risque d'appariement à tort. */
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
  }
  s.busy = false;
  s.lastScreen = "";
  broadcast(s, { type: "working", startedAt: Date.now(), elapsedMs: 0 });
  // Resume only if there's a transcript; a never-used session has
  // nothing to resume (claude --resume would exit) — re-create it.
  const hasTranscript = fs.existsSync(sessionFilePath(s.cwd, s.id));
  s.pilot = makePilot(s.id, s.cwd, hasTranscript ? ["--resume", s.id] : ["--session-id", s.id], s.profile);
  s.appliedProfile = s.profile;   // le nouveau process porte le profil désiré
  await attachPilot(s);
  s.restarting = false;
  broadcast(s, { type: "ready", sessionId: s.id, cwd: s.cwd, branch: s.worktree?.branch ?? null });
  broadcastProfile(s);            // l'écart « au prochain reload » vient de se refermer
  broadcast(s, { type: "screen", text: s.pilot.screen(), working: s.pilot.isWorking() });
}

/** Tells every attached client (other tabs, other devices) both the desired and
 *  the running profile — the pair is what lets the UI show "(at next reload)". */
function broadcastProfile(s: Live) {
  broadcast(s, { type: "profile", profile: s.profile ?? null, applied: s.appliedProfile ?? null });
}

function destroySession(s: Live) {
  if (s.screenTimer) clearInterval(s.screenTimer);
  s.screenTimer = null;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = null;
  if (s.retryTimer) clearTimeout(s.retryTimer);
  s.retryTimer = null;
  s.stopTail?.();
  s.stopTail = null;
  // La session est finie : sa position de tail n'a plus rien à reprendre.
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
async function endChannel(sessionId: string) {
  const ch = loadChannels().find((c) => c.sessionId === sessionId);
  // The main channel — a GROUP's General topic (chatId < 0, no threadId) — is
  // the environment's home base; never delete it. A DM binding also has no
  // threadId (positive chatId) but is an ordinary channel that MUST stay
  // closable, so gate on chatId < 0.
  if (ch?.telegram && ch.telegram.threadId == null && ch.telegram.chatId < 0) return;
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

async function createSession(
  id: string,
  cwd: string,
  args: string[],
  worktree: Worktree | null = null,
  profile: string | null = null,
): Promise<Live> {
  const pilot = makePilot(id, cwd, args, profile);
  const s: Live = {
    id,
    cwd,
    pilot,
    profile,
    appliedProfile: profile,   // le process qu'on vient de lancer l'a bien reçu
    clients: new Set(),
    busy: false,
    lastPrompt: "",
    screenTimer: null,
    lastScreen: "",
    contextPct: null,
    stopTail: null,
    recentTexts: [],
    worktree,
    idleTimer: null,
    // Resumed sessions start with what the transcript already consumed.
    usage: scanUsage(sessionFilePath(cwd, id)),
    retryTimer: null,
    retryCount: 0,
    errorsAtTurnStart: [],
    turnStartedAt: null,
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
async function attachPilot(s: Live): Promise<void> {
  const pilot = s.pilot;
  const { id, cwd } = s;
  s.pilotOff = pilot.onExit((code) => {
    if (s.restarting) return; // a restart is swapping the pilot; don't tear down
    broadcast(s, { type: "exited", code });
    destroySession(s);
  });
  pilot.start();
  // Stream authoritative content from the session transcript: each assistant
  // text/tool block is broadcast as soon as Claude Code writes it — complete,
  // never truncated, at message granularity.
  s.stopTail = tailSession(sessionFilePath(cwd, id), (e) => {
    if (e.kind === "text") {
      // Mémoriser AVANT de diffuser : une question peut suivre immédiatement,
      // et sa préface ne doit pas répéter ce bloc.
      s.recentTexts.push(e.text);
      if (s.recentTexts.length > 8) s.recentTexts.shift();
      // `at` = heure d'ÉCRITURE du bloc, pas de sa lecture (cf. TailEvent) : le
      // client l'affiche telle quelle au lieu de dater tout à la réception.
      broadcast(s, { type: "stream-text", text: e.text, at: e.at });
    }
    else if (e.kind === "tool")
      broadcast(s, { type: "stream-tool", id: e.id, name: e.name, summary: e.summary });
    else if (e.kind === "usage") {
      s.usage.set(e.messageId, e.usage);
      broadcast(s, { type: "tokens", tokens: tokenTotals(s) });
    } else
      broadcast(s, {
        type: "stream-result",
        toolUseId: e.toolUseId,
        text: e.text,
        isError: e.isError,
      });
  }, 250, () => sessionFilePath(cwd, id));
  let settled = false;
  s.screenTimer = setInterval(() => {
    if (pilot.hasExited) return;
    const scr = pilot.screen();
    if (scr !== s.lastScreen) {
      s.lastScreen = scr;
      broadcast(s, { type: "screen", text: scr, working: pilot.isWorking() });
      // Context-window usage from the TUI footer ("… ctx:37% …"), per session.
      const m = scr.match(/ctx:\s*(\d+)\s*%/i);
      const pct = m ? Number(m[1]) : s.contextPct;
      if (pct !== s.contextPct) {
        s.contextPct = pct;
        broadcast(s, { type: "context", pct });
      }
    }
    // Spontaneous resume: work restarting without a client prompt (e.g. a
    // background agent completing and waking the model). No handler called
    // finishTurn, so watch for it here and signal the turn like any other.
    if (settled && !s.busy && pilot.isWorking()) finishTurn(s).catch(() => {});
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
 * Le message « working ».
 *
 * Il porte `elapsedMs` — depuis COMBIEN DE TEMPS le tour tourne — en plus de
 * `startedAt`. Le client s'ancre sur la durée, jamais sur l'instant : comparer un
 * horodatage SERVEUR à un `Date.now()` de NAVIGATEUR décalait l'affichage de tout
 * l'écart entre les deux horloges, et le cockpit se regarde souvent depuis un
 * autre appareil que celui qui héberge le serveur (téléphone, second portable).
 * Un navigateur en retard pouvait même afficher une durée négative.
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
async function finishTurn(s: Live) {
  s.busy = true;
  // Tour retrouvé en cours (pas lancé par nous) : typiquement après un
  // redémarrage du serveur, l'agent tmux ayant continué sans lui. `turnStartedAt`
  // vit en mémoire, donc repartir de `now` remettait le chrono à zéro alors que
  // l'agent réfléchissait depuis dix minutes ; le transcript a survécu, lui.
  if (!s.turnStartedAt) s.turnStartedAt = resumedTurnStart(Date.now(), lastPromptAt(s.cwd, s.id));
  s.errorsAtTurnStart = findTransientErrors(s.pilot.screen());
  broadcast(s, workingMessage(s));
  try {
    await s.pilot.waitForIdle({ stableMs: 2000, timeoutMs: 900_000 });
    const dialog = detectDialog(s.pilot.screen());
    if (dialog) broadcast(s, dialogMessage(s, dialog));
    else {
      broadcast(s, { type: "turn-done", sessionId: s.id });
      maybeScheduleRetry(s);
    }
  } finally {
    s.busy = false;
    // Remember how long it took: a dialog suspends the turn and a completion
    // ends it, but both freeze the client's timer, so both are worth keeping.
    if (s.turnStartedAt) s.lastTurnMs = Date.now() - s.turnStartedAt;
    s.turnStartedAt = null;
  }
}

/** The option number the ❯ cursor is currently on, or null. */
function selectedOptionN(screen: string): number | null {
  for (const l of screen.split("\n")) {
    const m = l.match(/^\s*❯\s*(\d+)\.\s/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Selects option `n` in a single-select dialog by moving the ❯ cursor with
 * arrow keys, then Enter — the only reliable way for preview-style dialogs
 * that ignore digit keys. Falls back to typing the digit if the cursor can't
 * be read.
 */
async function moveToOption(pilot: Pilot, n: number): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    const cur = selectedOptionN(pilot.screen());
    if (cur === null) return false; // curseur illisible : à l'appelant de gérer
    if (cur === n) return true;
    pilot.press(cur < n ? "down" : "up");
    await new Promise((r) => setTimeout(r, 160));
  }
  return false;
}

async function selectOption(pilot: Pilot, n: number): Promise<void> {
  if (await moveToOption(pilot, n)) {
    pilot.press("enter");
    return;
  }
  pilot.write(String(n)); // fallback: older digit-selectable dialogs
}

/**
 * Coche/décoche l'option `n` d'un dialog multi-select.
 *
 * On NE tape PAS le chiffre : ces dialogs l'ignorent complètement (vérifié à
 * l'écran — la case restait `[ ]` et le curseur ne bougeait pas). Leur pied de
 * page annonce « Enter to select · ↑/↓ to navigate », mais Enter ne coche rien
 * non plus : c'est l'ESPACE qui bascule la case, une fois le curseur amené
 * dessus aux flèches. Un `toggle` par chiffre ne faisait donc rien, et le
 * Submit qui suivait partait avec zéro case cochée — d'où un « aucune réponse ».
 */
async function toggleOption(pilot: Pilot, n: number): Promise<void> {
  if (await moveToOption(pilot, n)) pilot.write(" ");
}

/** Motif de la page de récapitulatif atteinte par Tab depuis un multi-select. */
const SUBMIT_PAGE = /ready to submit|submit answers/i;

/**
 * Le message `dialog` diffusé aux clients, avec sa **préface** : le texte que
 * l'agent a écrit juste avant de poser sa question.
 *
 * Pourquoi le lire à l'écran plutôt que dans le transcript : le .jsonl n'écrit
 * un message assistant que TERMINÉ, donc son `tool_use` résolu — et
 * `AskUserQuestion` ne se résout qu'à la réponse de l'utilisateur. Le texte qui
 * précède la question arriverait donc APRÈS elle. L'écran, lui, l'a déjà.
 *
 * Provisoire par construction (dé-wrappé, tronqué si l'écran a défilé) : le
 * client la remplace par le bloc autoritatif du tail. Le web l'ignore, il a
 * déjà sa bulle grise ; c'est le bridge Telegram qui s'en sert.
 */
function dialogMessage(s: Live, d: TuiDialog): object {
  const preface = extractLiveText(s.pilot.screen());
  // L'écran garde la réponse du tour précédent tant que le nouveau tour n'a
  // rien écrit : sans ce filtre, chaque question était précédée d'un doublon
  // de la réponse d'avant, que rien ne venait ensuite réparer.
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
  if (d && d.options.some((o) => /full session/i.test(o.label)) && /resum|summary/i.test(d.question))
    return;
  if (d) send(dialogMessage(s, d));
}

/** Cancels a pending auto-retry (user took over, or session ends). */
function clearRetry(s: Live, notify = false) {
  if (!s.retryTimer) return;
  clearTimeout(s.retryTimer);
  s.retryTimer = null;
  if (notify) broadcast(s, { type: "auto-retry-cancelled" });
}

/**
 * Pas de re-test du rythme pendant une pause. Aligné sur le TTL du cache de
 * usage.ts : la boucle d'attente n'émet aucune requête vers l'API.
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

wss.on("connection", (ws: WebSocket) => {
  let session: Live | null = null;
  // D'où vient ce client ? Déclaré au `start` (web, cron, telegram, cli…), il
  // voyage avec l'écho de prompt : les autres clients doivent pouvoir DIRE qui
  // a parlé. Sans ça, un cron qui se déclenche ressemble à un message humain.
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
          let effectiveCwd = cwd;
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
          if (resumed && msg.branch && msg.repo && !fs.existsSync(effectiveCwd)) {
            ensureWorktreeCheckout(msg.repo, msg.branch, effectiveCwd);
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
          session = await createSession(id, effectiveCwd, args, worktree, profile);
          session.clients.add(ws);
          if (resumed) {
            const turns = loadHistory(effectiveCwd, id);
            if (turns.length) send({ type: "history", turns });
          }
          send({
            type: "ready",
            sessionId: id,
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
          // The session's other clients see the prompt arrive — sauf un cron :
          // ce n'est pas quelqu'un qui parle, et son texte (le prompt PLUS le
          // dump de sa garde) noyait la réponse dans les deux interfaces. La
          // marque dans le contenu assure le même masquage à la relecture.
          if (origin !== "cron")
            broadcast(session, { type: "prompt-echo", text, ...(origin ? { origin } : {}) }, ws);
          session.busy = true;
          session.turnStartedAt = Date.now();
          broadcast(session, workingMessage(session));
          try {
            await session.pilot.submit(text);
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
          // Multi-select: Tab → "Submit answers" page → Enter.
          if (!session) return fail("no session started");
          if (!detectDialog(session.pilot.screen()))
            return fail(session.busy ? "a response is already in progress" : "this dialog is no longer active");
          // Tab ouvre une page de récapitulatif ("Ready to submit your answers?")
          // dont le rendu n'est pas instantané. L'Enter partait après un délai
          // fixe de 600 ms et pouvait arriver AVANT elle — la page restait
          // alors affichée, réponses non soumises. On attend la page elle-même.
          session.pilot.press("tab");
          await session.pilot
            .waitFor((scr) => SUBMIT_PAGE.test(scr), { timeoutMs: 5000 })
            .catch(() => {}); // pas de page de récap : on tente l'Enter quand même
          session.pilot.press("enter");
          await sleep(400);
          await finishTurn(session);
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
          broadcastProfile(s);            // même sans restart : l'écart est visible partout
          if (msg.restart) await restartSession(s);
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
seedDefaultProfiles();
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
    fs.copyFileSync(path.join(src, "scripts", "schedule.py"), path.join(dst, "scripts", "schedule.py"));
    fs.chmodSync(path.join(dst, "scripts", "schedule.py"), 0o755);
  } catch {
    /* best effort — scheduling still works via the GUI/Telegram/API */
  }
}
seedSchedulerSkill();

// Fail-closed AVANT d'écouter : exposer le cockpit au réseau sans mot de passe
// donne l'exécution de commandes à quiconque l'atteint. Mieux vaut ne pas
// démarrer que démarrer grand ouvert.
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
});
