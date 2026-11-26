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
  /**
   * The GUEST conversation this agent belongs to — a stranger's open DM — or
   * null for an ordinary agent. An agent that has one is boxed to ITSELF: see
   * `guestConversationOf` for why, and `Viewer.onlySession` for what the box
   * then refuses.
   */
  guest: string | null;
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
 * Is this channel a GUEST's conversation — someone who wrote to the instance's
 * Telegram bot or WhatsApp number — and if so, which one?
 *
 * Why the question has to exist. Every guest of one door lands in the SAME
 * group, because the group is shadok's isolation unit. An agent's membership of
 * a group is its channel's group (`viewerInGroup`), and every visibility
 * question delegates to it (`canSeeSession` -> `canSeeGroup`), so one guest's
 * agent is entitled to a SIBLING guest's session, diff, transcript and — where
 * the operator shared a connected account with that group — its provider token.
 * A guest carries its session key in its own environment, so reaching any of
 * that needs no filesystem access and no privilege: it needs a prompt, which is
 * the one thing a stranger controls. The per-conversation working directory
 * (`guestWorkDirName`) is a filesystem measure and never addressed this.
 *
 * Derived from the registry alone (`telegram` / `whatsapp` are both
 * SERVER_OWNED), never from a frame or a body, and deliberately NOT from the
 * door's configuration: an admin who re-points a door at another group must not
 * silently un-box the conversations that are already running.
 *
 *  - a WhatsApp binding is always a guest's. That transport has no owner and no
 *    operator side: "every DM is a guest's, including the admin's own".
 *  - a Telegram binding is a guest's when it is a DM (`threadId` absent and a
 *    POSITIVE `chatId` — a negative one is a group chat) and the sender is not
 *    the DM owner. `dmOwner` unknown means every DM is a guest's, which is the
 *    fail-closed direction: boxing the owner's own agent costs it the sight of
 *    its siblings, while un-boxing a stranger's costs the instance a wall.
 *  - anything else — a board topic, a group chat, a plain web agent — is not a
 *    guest's and is not boxed.
 *
 * The value is an opaque identity, only ever compared for equality and used as
 * the conversation's key once the external nature exists; the transport prefix
 * keeps a phone number and a Telegram id from ever colliding.
 */
export function guestConversationOf(
  ch: {
    telegram?: { chatId: number; threadId?: number } | null;
    whatsapp?: { account: string; id: string } | null;
  } | null | undefined,
  dmOwner: number | null,
): string | null {
  if (!ch) return null;
  if (ch.whatsapp) return `wa:${ch.whatsapp.account}:${ch.whatsapp.id}`;
  const tg = ch.telegram;
  if (!tg || tg.threadId != null || !(tg.chatId > 0)) return null;
  return dmOwner !== null && tg.chatId === dmOwner ? null : `tg:${tg.chatId}`;
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
    telegram?: { chatId: number; threadId?: number } | null;
    whatsapp?: { account: string; id: string } | null;
  }[],
  peerScope: (name: string) => "admin" | "member" | "restricted" | null,
  liveProfile?: string | null,
  /** The Telegram DM owner, for `guestConversationOf`. Omitted = unknown, which
   *  boxes every DM — the fail-closed direction. */
  dmOwner: number | null = null,
): AgentPrincipal {
  const ch = channels.find((c) => c.sessionId === sessionId);
  const tag = ch?.createdByPeer;
  // Boxed when the creator is restricted OR no longer listed. Spelled as the
  // two boxed answers rather than "anything but member": the day a third
  // unboxed scope appeared (`admin`), the negative form would have boxed every
  // agent that scope spawned.
  const s = tag ? peerScope(tag) : null;
  const peer = tag && (s === null || s === "restricted") ? tag : null;
  return {
    sessionId,
    group: ch?.group ?? null,
    profile: liveProfile ?? ch?.profile ?? null,
    createdBy: ch?.createdBy ?? null,
    peer,
    guest: guestConversationOf(ch, dmOwner),
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
