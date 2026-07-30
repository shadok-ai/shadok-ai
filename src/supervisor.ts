/**
 * Supervisor: spawns the server child, watches its exit, and decides whether to
 * respawn (crash, with backoff), update (exit code 75), stop (0), or give up
 * (crash-looping). The decision is a pure function so it is unit-tested without
 * spawning anything; runSupervisor() wires it to real process/npm adapters.
 */

/** Sentinel exit code the server uses to ask the supervisor for an update. */
export const UPDATE_EXIT_CODE = 75;
/**
 * Sentinel exit code the server uses when it has ALREADY installed the update
 * itself (fetched in the background while still serving). The supervisor just
 * respawns — no install, no crash accounting — so the visible downtime is a
 * single process restart instead of a full npm install.
 */
export const RELOAD_EXIT_CODE = 76;

export interface BackoffOpts {
  windowMs: number; // rolling window for the crash cap
  cap: number; // max crashes in the window before giving up
  baseMs: number; // first backoff delay
  maxMs: number; // backoff ceiling
}

export const DEFAULT_BACKOFF: BackoffOpts = {
  windowMs: 60_000,
  cap: 5,
  baseMs: 1_000,
  maxMs: 30_000,
};

export type Action =
  | { kind: "stop" }
  | { kind: "update" }
  | { kind: "reload" }
  | { kind: "respawn"; delayMs: number }
  | { kind: "give-up"; reason: string };

/**
 * Map a child exit code to the next action. `recentCrashes` is the list of
 * timestamps (ms) of prior crash-respawns; `now` is the current time. Only
 * genuine crashes count toward the cap — a clean stop or an update do not.
 */
export function nextAction(
  code: number,
  recentCrashes: number[],
  now: number,
  opts: BackoffOpts = DEFAULT_BACKOFF,
): Action {
  if (code === 0) return { kind: "stop" };
  if (code === UPDATE_EXIT_CODE) return { kind: "update" };
  if (code === RELOAD_EXIT_CODE) return { kind: "reload" };
  const inWindow = recentCrashes.filter((t) => now - t < opts.windowMs);
  if (inWindow.length >= opts.cap) {
    return { kind: "give-up", reason: `${inWindow.length} crashes within ${opts.windowMs / 1000}s` };
  }
  const delayMs = Math.min(opts.maxMs, opts.baseMs * 2 ** inWindow.length);
  return { kind: "respawn", delayMs };
}

// ── Orchestration ──────────────────────────────────────────────────────────

export interface SupervisorDeps {
  /** Spawn the server child; resolves with its exit code when it exits. */
  spawnServer: () => Promise<number>;
  /** Fetch + install the latest server; returns the result to hand the child. */
  update: () => Promise<{ ok: true; version: string } | { ok: false; error: string }>;
  /** Persist the update result so the next server boot can announce it. */
  writeUpdateResult: (r: { ok: boolean; version?: string; error?: string }) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
}

/** Run the supervise loop until the child stops cleanly or we give up. */
export async function runSupervisor(deps: SupervisorDeps, opts: BackoffOpts = DEFAULT_BACKOFF): Promise<number> {
  const recentCrashes: number[] = [];
  for (;;) {
    const code = await deps.spawnServer();
    const action = nextAction(code, recentCrashes, deps.now(), opts);
    switch (action.kind) {
      case "stop":
        deps.log("server stopped cleanly");
        return 0;
      case "give-up":
        deps.log(`giving up: ${action.reason}`);
        return 1;
      case "update": {
        deps.log("update requested");
        const r = await deps.update();
        deps.writeUpdateResult(r);
        deps.log(r.ok ? `updated to v${r.version}` : `update failed: ${r.error}`);
        // Respawn immediately; a failed update just reruns the current version.
        break;
      }
      case "reload":
        // The server already installed the new version; just respawn it. Not a
        // crash, so it doesn't count toward the backoff cap.
        deps.log("reloading into the pre-installed update");
        break;
      case "respawn":
        recentCrashes.push(deps.now());
        deps.log(`server crashed (code ${code}); respawning in ${action.delayMs}ms`);
        await deps.sleep(action.delayMs);
        break;
    }
  }
}
