/**
 * Can THIS agent authenticate to Claude? — the one question every spawn gate
 * asks, answered from facts the caller gathers (pure, tested).
 *
 * It used to be two unrelated gates: every spawn required the instance's own
 * (root) `claude auth login`, and a privilege-dropped agent additionally
 * required the long-lived token. On a multi-tenant instance the dropped agent
 * uses neither the root login nor, in "login" auth mode, the token — so a fresh
 * hosted instance demanded TWO OAuth round-trips before its first agent, and a
 * login-mode agent was refused for a token it would never use. The gate now
 * checks only the credential the agent will actually run on:
 *
 *   - custom model backend → nothing to check;
 *   - the server's own user (mono-tenant, or a commons not yet migrated) → the
 *     root sign-in;
 *   - a dropped user in "token" mode → the token;
 *   - a dropped user in "login" mode → that user's own login.
 *
 * Only an OBSERVED absence refuses (invariant 27): an unknown root state or an
 * unread login lets the spawn through. Messages never carry a credential.
 */

export type Connected = "yes" | "no" | "unknown";

export interface ConnectFacts {
  multiTenant: boolean;
  customBackend: boolean;
  /** The OS user the agent will run as; null = the server's own user. */
  dropUser: string | null;
  agentAuth: "token" | "login";
  /** MT_CLAUDE_OAUTH_TOKEN present in Main. */
  hasToken: boolean;
  rootAuth: "signed-in" | "signed-out" | "unknown";
  /** `agentLoginInfo(home).loggedIn` for `dropUser`; null = not looked up. */
  userLoggedIn: boolean | null;
}

export type ConnectVerdict =
  | { ok: true }
  | { ok: false; code: "logged-out" | "space-not-connected"; user: string | null; message: string };

export const LOGGED_OUT_MESSAGE =
  "this shadok-ai instance is not signed in to Claude — sign in from the cockpit";
export const SPACE_NOT_CONNECTED_MESSAGE =
  "This space isn't connected to Claude yet — an admin can connect it from the cockpit.";

export function connectVerdict(f: ConnectFacts): ConnectVerdict {
  if (f.customBackend) return { ok: true };
  if (f.dropUser === null) {
    return f.rootAuth === "signed-out"
      ? { ok: false, code: "logged-out", user: null, message: LOGGED_OUT_MESSAGE }
      : { ok: true };
  }
  const missing = f.agentAuth === "token" ? !f.hasToken : f.userLoggedIn === false;
  return missing
    ? { ok: false, code: "space-not-connected", user: f.dropUser, message: SPACE_NOT_CONNECTED_MESSAGE }
    : { ok: true };
}

/** The verdict as a three-valued state: "unknown" when the deciding fact was not observed. */
export function connectedState(f: ConnectFacts): Connected {
  if (!connectVerdict(f).ok) return "no";
  if (f.customBackend) return "yes";
  if (f.dropUser === null) return f.rootAuth === "unknown" ? "unknown" : "yes";
  if (f.agentAuth === "login" && f.userLoggedIn === null) return "unknown";
  return "yes";
}
