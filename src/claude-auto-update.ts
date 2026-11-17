/**
 * Claude Code auto-install: when an agent's TUI footer says
 * "✗ Auto-update failed", install the update server-side, once, by itself.
 *
 * Claude Code updates its own binary, but on many instances it cannot: the
 * global npm directory belongs to root while a privilege-dropped agent runs as
 * its group's user, so its updater fails and the footer says so. The cockpit
 * already had the cure — the badge's "install then reload" button
 * (`POST /claude-update`) — but it waited for a human to notice the badge on
 * each agent. The server sees every agent's screen, so it can do it instead.
 *
 * The reload half needs nothing new: once the binary changes, every agent
 * spawned on the old one carries the `claude` staleness reason, and the
 * auto-reload sweep respawns them one at a time when each has nothing to lose
 * (`src/auto-reload.ts`).
 *
 * What this module decides is WHEN an install is worth starting, and the rule
 * is built so that it can never run twice at once nor loop:
 *  - one install at a time — in this process (`inFlight`, the same promise the
 *    button uses) and across processes (`externalInstall`: npm's reify dir or
 *    our lock file says someone else is installing);
 *  - only a footer on an agent RUNNING THE INSTALLED BINARY counts. An agent
 *    spawned on an older binary still shows the failed footer until it is
 *    reloaded, and the install already happened — that agent needs a reload,
 *    not a second install. Without this, every install would be followed by
 *    another for as long as one agent stayed un-reloaded;
 *  - after an install (or a check that found nothing newer) nothing is
 *    retried for `settleMs`, and after a failure for `failureBackoffMs`: a
 *    footer that survives the cure (an updater failing for another reason, a
 *    phrase an agent merely printed at the bottom of its answer) must not turn
 *    into an npm install every 30 seconds.
 */

export interface AutoInstallInput {
  /** `SHADOK_CLAUDE_AUTO_INSTALL` is not off. */
  enabled: boolean;
  /** Agents whose footer reads "Auto-update failed" AND that run the binary
   *  installed right now (spawn version == current version, or unknown). */
  failingOnCurrent: number;
  /** This process is installing already (button or a previous sweep). */
  inFlight: boolean;
  /** Another process is installing (npm reify dir, or our lock held). */
  externalInstall: boolean;
  /** ms since the last attempt that ended in success or "already latest". */
  sinceLastSettledMs: number;
  /** ms since the last failed attempt. */
  sinceLastFailureMs: number;
  settleMs: number;
  failureBackoffMs: number;
}

export type AutoInstallVerdict = { install: true } | { install: false; why: string };

/** Pure: should the server start a Claude Code install right now? */
export function autoInstallVerdict(i: AutoInstallInput): AutoInstallVerdict {
  const no = (why: string): AutoInstallVerdict => ({ install: false, why });
  if (!i.enabled) return no("disabled");
  if (i.failingOnCurrent <= 0) return no("no agent reports a failed update on the installed binary");
  if (i.inFlight) return no("an install is already running here");
  if (i.externalInstall) return no("another process is installing");
  if (i.sinceLastSettledMs < i.settleMs) return no("installed or checked recently");
  if (i.sinceLastFailureMs < i.failureBackoffMs) return no("last install failed recently");
  return { install: true };
}

/**
 * Pure: does this agent's failed footer call for an INSTALL? Only when it runs
 * the binary installed now — or when either version is unknown, since a failed
 * `--version` probe must not hide a real failure (the time gates still bound it).
 */
export function failingOnInstalled(spawnVersion: string | null | undefined, currentVersion: string | null): boolean {
  if (!spawnVersion || !currentVersion) return true;
  return spawnVersion === currentVersion;
}

/** Pure: is the published version newer than the installed one? Unknown → assume yes. */
export function newerPublished(installed: string | null, published: string | null): boolean {
  if (!installed || !published) return true;
  const a = installed.split(".").map(Number);
  const b = published.split(".").map(Number);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return installed !== published;
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const d = (b[k] ?? 0) - (a[k] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Pure: is a lock file (written with the time it was taken) still held? A
 * lock older than `staleMs` belongs to an install that died without releasing
 * it — an npm install never takes that long — so it no longer blocks anyone.
 * Age only, never a pid: in a container pids are handed out again (invariant 45).
 */
export function lockHeld(takenAtMs: number | null, now: number, staleMs: number): boolean {
  return takenAtMs !== null && now - takenAtMs < staleMs;
}

/** `SHADOK_CLAUDE_AUTO_INSTALL=0` turns it off; anything else (or unset) leaves it on. */
export function autoInstallEnabled(env: string | undefined): boolean {
  return env === undefined || !/^(0|false|off|no)$/i.test(env.trim());
}
