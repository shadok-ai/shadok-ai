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

/**
 * What the cockpit is allowed to SAY while it has no agent to show.
 *
 * The browser cannot work this out on its own: "a first agent is on its way"
 * and "the user closed their last tab" are the same zero channels (invariant
 * 18, which is why `active` can be null). Guessing picks one of two wrong
 * answers — either a returning user is told forever that their first agent is
 * starting, or a brand-new one is invited to create a SECOND lead agent while
 * the first is being born. So the side doing the spawning says which it is.
 *
 * The state is deliberately hard to leave switched on. Every exit from
 * `ensureFirstAgent` goes through `settleFirstAgent`, including the ones that
 * spawn nothing (`not-signed-in`, `channels-exist`), the socket erroring and
 * the 60s guard — because a flag that could stick would leave a signed-out
 * cockpit reading "starting your first agent…" forever, which is a worse first
 * impression than the empty state this replaces.
 */
export interface FirstAgentStatus {
  /** Is a lead agent genuinely being started right now? */
  pending: boolean;
  /** Why — the plan's reason once one has been computed, before that "starting". */
  reason: FirstAgentPlan["reason"] | "starting" | "idle";
}

let status: FirstAgentStatus = { pending: false, reason: "idle" };

/** A copy, so no caller can hold a handle on the state and edit it. */
export function firstAgentStatus(): FirstAgentStatus {
  return { ...status };
}

/**
 * Say a spawn is coming, BEFORE the attempt itself.
 *
 * The boot path defers `ensureFirstAgent` a beat (so it dials a server already
 * accepting) and opens the browser first — so without this the very page this
 * status exists for loads during that gap and is told "idle", which is the bug.
 * The auth probe inside `ensureFirstAgent` costs another ~850ms on top.
 *
 * Authoritative, not sticky: called with channels present it CLEARS the flag
 * rather than leaving a stale one — an instance that has agents has nothing
 * pending by definition.
 */
export function announceFirstAgent(channelCount: number): void {
  status =
    channelCount > 0
      ? { pending: false, reason: "channels-exist" }
      : { pending: true, reason: "starting" };
}

/** The one way out of `pending`. Never conditional: every reason ends the wait. */
export function settleFirstAgent(reason: FirstAgentPlan["reason"]): void {
  status = { pending: false, reason };
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
  if (!plan.spawn) {
    settleFirstAgent(plan.reason);
    return plan.reason;
  }

  // The sign-in path reaches here without the boot path's announcement, and the
  // auth probe above has just spent ~850ms — say it now, so the window in which
  // the page could be told "idle" while a spawn is under way is closed at both
  // ends rather than only at boot.
  announceFirstAgent(0);
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
    // In the `finally` on purpose: the spawn resolves on `ready`, on `error`,
    // on `exited`, on a socket failure and on the 60s guard, and every one of
    // them has to end the "starting…" status. `onReady` has already written the
    // channel by now, so the client sees the tab and the cleared flag together.
    settleFirstAgent("first-boot");
  }
  return "first-boot";
}
