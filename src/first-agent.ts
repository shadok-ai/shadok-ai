import WebSocket from "ws";
import { loadChannels } from "./channels.js";
import { authStatus, type AuthState } from "./claude-auth.js";
import { BOSS_PROFILE_NAME } from "./profiles.js";

/**
 * The lead agent an instance starts life with.
 *
 * A fresh cockpit shows "no agent open" and leaves the newcomer to guess. This
 * creates one channel — `general`, running the `Shadok-Boss` profile, which is
 * written to be the one the user talks to first.
 *
 * It spawns through a WebSocket to our OWN server, like the Telegram bridge,
 * the cron driver and `pilotctl`. That is not a stylistic choice: there is no
 * server-side path that opens a session without a client, and inventing one
 * would be a second way to start an agent, drifting from the first.
 */

/** The name every instance's first channel carries. */
export const FIRST_AGENT_NAME = "general";

export interface FirstAgentPlan {
  spawn: boolean;
  reason: "first-boot" | "channels-exist" | "not-signed-in";
  name?: string;
  profile?: string;
}

/**
 * Pure: should this instance start its lead agent?
 *
 * The channel check comes first on purpose. A cockpit in use must never be
 * skipped "because it is not signed in" — this decision is only ever visible in
 * a log line, so the reason has to be the true one.
 */
export function firstAgentPlan(input: {
  channelCount: number;
  authState: AuthState;
}): FirstAgentPlan {
  if (input.channelCount > 0) return { spawn: false, reason: "channels-exist" };
  // "unknown" is not "signed in": the probe failed. Waiting costs one boot,
  // guessing costs an agent with no credentials — the zombie shape (invariant 27).
  if (input.authState !== "signed-in") return { spawn: false, reason: "not-signed-in" };
  return { spawn: true, reason: "first-boot", name: FIRST_AGENT_NAME, profile: BOSS_PROFILE_NAME };
}

/** Guards the two callers (boot, sign-in) against firing at the same moment. */
let inFlight = false;

/**
 * Start the lead agent if this instance has none. Idempotent by construction:
 * the condition is "no channel at all", so both callers can call it freely.
 *
 * Never throws and never blocks its caller's own work — a cockpit that starts
 * without its lead agent is a smaller problem than a boot that fails.
 */
export async function ensureFirstAgent(deps: {
  port: number;
  cookie?: string;
  cwd: string;
  /** Called with the new session id once the server reports it ready. */
  onReady: (sessionId: string, name: string) => void;
}): Promise<FirstAgentPlan["reason"]> {
  if (inFlight) return "channels-exist";
  const plan = firstAgentPlan({
    channelCount: loadChannels().length,
    authState: (await authStatus()).state,
  });
  if (!plan.spawn) return plan.reason;

  inFlight = true;
  try {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${deps.port}/ws`,
        deps.cookie ? { headers: { cookie: deps.cookie } } : {},
      );
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        // Closing our socket does NOT stop the agent: sessions outlive their
        // clients, which is the whole point of the registry.
        try { ws.close(); } catch { /* already closing */ }
        resolve();
      };
      const guard = setTimeout(finish, 60_000);
      guard.unref?.();
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "start",
            // The launch directory, and no worktree: this is the main channel,
            // not one of the isolated agents it will go on to spawn.
            cwd: deps.cwd,
            profile: plan.profile,
            origin: "boot",
          }),
        ),
      );
      ws.on("message", (raw) => {
        let m: { type?: string; sessionId?: string };
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === "ready" && m.sessionId) {
          deps.onReady(m.sessionId, plan.name!);
          finish();
        } else if (m.type === "error" || m.type === "exited") {
          finish();
        }
      });
      ws.on("error", finish);
      ws.on("close", finish);
    });
  } finally {
    inFlight = false;
  }
  return "first-boot";
}
