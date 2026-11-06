/**
 * The AGENT as a principal of its own — not the bootstrap admin.
 *
 * Every agent carries `SHADOK_SESSION_KEY` (`src/accounts.ts`), and the server
 * used to resolve a valid key to `{name: BOOTSTRAP_ADMIN, role: "admin"}`. That
 * made every agent — including a multi-tenant agent running as an unprivileged
 * OS user precisely so it could NOT reach other groups — a full admin of the
 * API: mint an admin invitation, rewrite the model backend, restart every
 * agent, see and drive every group's agents. The OS-user wall was moot.
 *
 * A key now resolves to THE AGENT: its session id, the group its channel was
 * born into, its profile, the person it was created for, and the restricted
 * peer it was spawned by, if any. As an account it is a `member` (never an
 * admin), named `agent:<sessionId>` so it can never collide with a person's
 * name, and its group membership is exactly its channel's group — nothing a
 * frame or a body says. Pure, so the rules are tested without a server.
 */

import type { Role } from "./accounts.js";

/** Who an agent is, as far as authorization goes. */
export interface AgentPrincipal {
  sessionId: string;
  /** The group its channel was born into; null = the commons. */
  group: string | null;
  profile: string | null;
  /** The person this agent ultimately works for (`Channel.createdBy`). */
  createdBy: string | null;
  /**
   * The RESTRICTED peer whose box this agent lives in, when a restricted peer
   * spawned it (directly or through an ancestor that carried the tag). Such an
   * agent inherits the box: it sees and drives only that peer's agents. null
   * for an agent no restricted peer owns.
   */
  peer: string | null;
}

/** The account-shaped view of an agent: a member, never an admin. */
export interface AgentAccount {
  name: string;
  role: Role;
  agent: AgentPrincipal;
}

/** Prefix of an agent's account name. Reserved: `userWriteVerdict` refuses a
 *  person account named with it. Nothing authorizes on the NAME anyway — an
 *  agent is recognised by the `agent` field, which only the key resolution sets. */
export const AGENT_ACCOUNT_PREFIX = "agent:";

export function agentAccountName(sessionId: string): string {
  return `${AGENT_ACCOUNT_PREFIX}${sessionId}`;
}

/**
 * Resolve the principal behind a VERIFIED session id (the caller has already
 * checked the key's MAC and that it came from this machine). The channel
 * registry is the authority (invariant 1): the group, profile and creator are
 * read from the row, never from the request.
 *
 * `peerScope` answers the scope of a peer by name, or null when that peer is no
 * longer listed. A `createdByPeer` tag on the channel puts the agent in that
 * peer's box when the peer is restricted — AND when it has been revoked: an
 * unknown peer can no longer be proven to be a member, and the box is the
 * fail-closed direction.
 */
export function resolveAgentPrincipal(
  sessionId: string,
  channels: readonly {
    sessionId: string;
    group?: string | null;
    profile?: string | null;
    createdBy?: string | null;
    createdByPeer?: string;
  }[],
  peerScope: (name: string) => "member" | "restricted" | null,
  liveProfile?: string | null,
): AgentPrincipal {
  const ch = channels.find((c) => c.sessionId === sessionId);
  const tag = ch?.createdByPeer;
  const peer = tag && peerScope(tag) !== "member" ? tag : null;
  return {
    sessionId,
    group: ch?.group ?? null,
    profile: liveProfile ?? ch?.profile ?? null,
    createdBy: ch?.createdBy ?? null,
    peer,
  };
}

export function agentAccount(p: AgentPrincipal): AgentAccount {
  return { name: agentAccountName(p.sessionId), role: "member", agent: p };
}

/**
 * Credentials that must NEVER reach an agent's environment.
 *
 * `SHADOK_AUTH` was the bootstrap admin's cookie, injected into every agent and
 * valid from the network for a week. `SHADOK_GUI_PASSWORD` is the instance
 * password, which IS the bootstrap admin: the supervisor hands it to the server
 * through the env, and every child the server spawned inherited it — node-pty
 * copies `process.env`, a tmux pane inherits the tmux SERVER's global
 * environment (captured whenever that server first started, possibly by an
 * older shadok), and `setpriv` keeps the env across the uid drop. Either one
 * let an agent `POST /login` or present a cookie as the admin, from anywhere.
 *
 * The agent's own credential is `SHADOK_SESSION_KEY`, which proves "I am this
 * agent" and nothing more.
 */
export const AGENT_CREDENTIAL_VARS: readonly string[] = ["SHADOK_AUTH", "SHADOK_GUI_PASSWORD"];

export function isAgentCredentialVar(name: string): boolean {
  return AGENT_CREDENTIAL_VARS.includes(name);
}

/** A copy of `env` without the credential variables. */
export function withoutAgentCredentials<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const k of AGENT_CREDENTIAL_VARS) delete out[k];
  return out;
}

/**
 * Is this request a PERSON in a browser on our own origin — the only caller the
 * "browser-only" routes (guardrails, accounts, shell mode, uploads…) accept?
 *
 * `Origin` alone proved nothing: any process can send `Origin: http://<host>`,
 * so an agent's `curl -H Origin:…` passed every one of those gates. Now:
 *  - a request carrying an agent's session key or a peer token is a MACHINE,
 *    whatever else it carries — a browser never sends either header;
 *  - with a password set, it must also carry a PERSON's session cookie;
 *  - and the same-origin `Origin` check stays, as the CSRF layer it always was.
 * With no password there is no cookie to ask for (local single-user default),
 * so the Origin check and the machine-header refusal are what remain.
 */
export function isBrowserPerson(o: {
  hasAgentKey: boolean;
  hasPeerToken: boolean;
  passwordSet: boolean;
  personCookie: boolean;
  sameOrigin: boolean;
}): boolean {
  if (o.hasAgentKey || o.hasPeerToken) return false;
  if (o.passwordSet && !o.personCookie) return false;
  return o.sameOrigin;
}

/** Was a header sent at all (any non-empty value)? Presence is what makes a
 *  request a machine's — a browser never sets these, valid or not. */
export function headerPresent(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => typeof x === "string" && x.length > 0);
  return typeof v === "string" && v.length > 0;
}
