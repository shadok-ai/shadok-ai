// GitHub client for connected GitHub accounts (a GitHub App's user-to-server
// tokens): the token refresh through the broker — with the ROTATING refresh
// token GitHub issues — the identity and installation reads, the commit
// identity, the spawn env that names the git credential helper, and which
// account an agent's request means. Every network call goes through an
// injected fetch so tests never touch the network; a token only ever rides in
// an Authorization header or the broker's refresh body, never in an error.
// Design: docs/superpowers/specs/2026-11-15-connected-accounts-github-design.md.
import {
  accountLapsed,
  resolveAccountId,
  type ConnectedAccount,
  type GithubInfo,
  type GithubInstallation,
} from "./connected-accounts.js";

export type FetchFn = typeof fetch;

const TIMEOUT_MS = 20_000;
const deadline = () => AbortSignal.timeout(TIMEOUT_MS);
const API = "https://api.github.com";

/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** The hourly watch renews a refresh token with less than this left: every
 *  refresh issues a fresh ~6-month one, so a rarely used account never lapses. */
export const KEEPALIVE_BEFORE_MS = 14 * 24 * 3600_000;
/** A GitHub user token lasts 8 hours when the answer does not say. */
const DEFAULT_ACCESS_S = 8 * 3600;

export class GithubError extends Error {
  status: number;
  /** The grant is dead (`invalid_grant`): reconnect. */
  expired: boolean;
  constructor(message: string, status: number, expired = false) {
    super(message);
    this.name = "GithubError";
    this.status = status;
    this.expired = expired;
  }
}

export const RECONNECT_REASON = "GitHub no longer accepts this account's authorisation.";

export interface TokenStore {
  get(id: string): ConnectedAccount | undefined;
  /** MUST be durable when it returns (the rotated refresh token rides in it). */
  patch(id: string, patch: Partial<ConnectedAccount>): void;
}

export function needsRefresh(a: Pick<ConnectedAccount, "expiresAt">, now: number): boolean {
  return a.expiresAt - now < REFRESH_MARGIN_MS;
}

/** Should the hourly watch renew this account now (`KEEPALIVE_BEFORE_MS`)? */
export function needsKeepalive(a: Pick<ConnectedAccount, "provider" | "status" | "refreshToken" | "refreshExpiresAt" | "expiresAt">, now: number): boolean {
  if (a.provider !== "github" || a.status === "expired" || !a.refreshToken) return false;
  if (typeof a.refreshExpiresAt !== "number" || now >= a.refreshExpiresAt) return false;
  return a.refreshExpiresAt - now < KEEPALIVE_BEFORE_MS;
}

/**
 * The broker's refresh answer → the store patch, or why not. Pure, so the one
 * rule that matters is tested on its own: a ROTATED refresh token (GitHub
 * always sends one) replaces the stored one, with its new deadline. An answer
 * without one keeps the stored token (the broker strips nothing, but a
 * non-expiring app sends none).
 */
export function refreshPatch(
  j: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; refresh_token_expires_in?: unknown },
  now: number,
): Partial<ConnectedAccount> | null {
  if (typeof j.access_token !== "string" || !j.access_token) return null;
  const life = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : DEFAULT_ACCESS_S;
  const patch: Partial<ConnectedAccount> = { token: j.access_token, expiresAt: now + life * 1000, status: "ok" };
  if (typeof j.refresh_token === "string" && j.refresh_token) {
    patch.refreshToken = j.refresh_token;
    if (typeof j.refresh_token_expires_in === "number" && j.refresh_token_expires_in > 0) patch.refreshExpiresAt = now + j.refresh_token_expires_in * 1000;
  }
  return patch;
}

/**
 * A GitHub account's access token, refreshed through the broker when it has
 * under 5 minutes left (`POST /github/refresh`).
 *
 * The refresh token ROTATES: the one sent is dead the moment GitHub answers.
 * Hence the two rules this class exists for —
 *   - ONE refresh per account at a time: a second concurrent refresh would
 *     send the same (now dead) token, get `invalid_grant`, and mark a healthy
 *     account expired. Every caller meanwhile awaits the same promise.
 *   - the new refresh token is PERSISTED (`store.patch`, synchronous and
 *     atomic) BEFORE the access token is handed to anyone.
 * `invalid_grant` marks the account expired; a broker that cannot be reached
 * changes nothing.
 */
export class GithubTokens {
  private inflight = new Map<string, Promise<string>>();
  constructor(private deps: { broker: string; fetchFn: FetchFn; store: TokenStore; now: () => number; log?: (line: string) => void }) {}

  /** `force`: refresh even if the access token is still fresh (the keep-alive). */
  accessToken(accountId: string, force = false): Promise<string> {
    const running = this.inflight.get(accountId);
    if (running) return running;
    const a = this.deps.store.get(accountId);
    if (!a || a.provider !== "github") return Promise.reject(new GithubError("That GitHub account is no longer connected.", 410));
    if (a.status === "expired") return Promise.reject(new GithubError(RECONNECT_REASON, 401, true));
    if (!force && !needsRefresh(a, this.deps.now())) return Promise.resolve(a.token);
    const p = this.refresh(a).finally(() => this.inflight.delete(accountId));
    this.inflight.set(accountId, p);
    return p;
  }

  private async refresh(a: ConnectedAccount): Promise<string> {
    if (!a.refreshToken) {
      // A non-expiring app issues no refresh token and a token that lasts:
      // nothing to renew. A lapsed one is dead.
      if (a.expiresAt > this.deps.now()) return a.token;
      this.deps.store.patch(a.id, { status: "expired", updatedAt: this.deps.now() });
      throw new GithubError(RECONNECT_REASON, 401, true);
    }
    let res: Response;
    try {
      res = await this.deps.fetchFn(`${this.deps.broker}/github/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: a.refreshToken }),
        signal: deadline(),
      });
    } catch (e) {
      // Sent and unanswered: GitHub may have rotated on its side, in which case
      // the stored token is dead and the next refresh will say so. Nothing to
      // do about it but say it.
      this.deps.log?.(`github: refresh for account ${a.id} got no answer (${(e as Error)?.name ?? "error"})`);
      throw new GithubError("The connector could not be reached to renew GitHub access — try again in a moment.", 502);
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (j.error === "invalid_grant") {
        this.deps.store.patch(a.id, { status: "expired", updatedAt: this.deps.now() });
        throw new GithubError(RECONNECT_REASON, 401, true);
      }
      throw new GithubError(`GitHub access could not be renewed (${res.status}) — try again in a moment.`, 502);
    }
    const now = this.deps.now();
    const patch = refreshPatch(j, now);
    if (!patch) throw new GithubError("GitHub access could not be renewed — try again in a moment.", 502);
    // Durable first, then handed out.
    this.deps.store.patch(a.id, { ...patch, updatedAt: now });
    return patch.token as string;
  }
}

// ---- identity, installations ----------------------------------------------

const ghHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "shadok-ai",
});

async function getJson<T>(what: string, url: string, token: string, fetchFn: FetchFn): Promise<T> {
  const res = await fetchFn(url, { headers: ghHeaders(token), signal: deadline() });
  if (!res.ok) throw new GithubError(`GitHub ${what} failed (${res.status}).`, res.status, res.status === 401);
  return (await res.json()) as T;
}

/** The commit identity GitHub attributes to the person without exposing their email. */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

export async function fetchUser(token: string, fetchFn: FetchFn): Promise<{ id: number; login: string }> {
  const j = await getJson<{ id?: unknown; login?: unknown }>("profile lookup", `${API}/user`, token, fetchFn);
  if (typeof j.id !== "number" || typeof j.login !== "string" || !j.login) throw new GithubError("GitHub profile lookup returned no account.", 502);
  return { id: j.id, login: j.login };
}

/**
 * The installations this user token reaches (`GET /user/installations`), each
 * with its repository count (`total_count` of one page of one). Authorizing
 * the app grants none by itself: an empty list means "choose repositories".
 */
export async function fetchInstallations(token: string, fetchFn: FetchFn): Promise<GithubInstallation[]> {
  const j = await getJson<{ installations?: unknown }>("installations lookup", `${API}/user/installations?per_page=100`, token, fetchFn);
  const raw = Array.isArray(j.installations) ? j.installations : [];
  const out: GithubInstallation[] = [];
  for (const it of raw as Array<Record<string, unknown>>) {
    const id = typeof it?.id === "number" ? it.id : null;
    const acct = it?.account as { login?: unknown } | null | undefined;
    const login = typeof acct?.login === "string" ? acct.login : null;
    if (id === null || !login) continue;
    let repos: number | null = null;
    try {
      const r = await getJson<{ total_count?: unknown }>("repositories lookup", `${API}/user/installations/${id}/repositories?per_page=1`, token, fetchFn);
      repos = typeof r.total_count === "number" ? r.total_count : null;
    } catch {
      /* the count is a nicety: an installation without it is still one */
    }
    out.push({ id, account: login, selection: it.repository_selection === "all" ? "all" : "selected", repos });
  }
  return out;
}

/** Identity + installations, as stored on the account. */
export function githubInfo(user: { id: number; login: string }, installations: GithubInstallation[], now: number): GithubInfo {
  return { login: user.login, id: user.id, email: noreplyEmail(user.id, user.login), installations, checkedAt: now };
}

/** Can the agents do anything yet? No installation, or only empty ones = no. */
export function reachesRepositories(info: Pick<GithubInfo, "installations"> | undefined): boolean {
  return (info?.installations ?? []).some((i) => i.selection === "all" || i.repos === null || i.repos > 0);
}

// ---- the spawn env: the credential helper's NAME, never a token -----------

/** Where the skill's script lives for this instance (`SKILLS_BASE`). */
export const githubScriptPath = (skillsBase: string) => `${skillsBase.replace(/\/+$/, "")}/shadok-github/scripts/github.mjs`;

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The env a spawn adds so `git` asks the server for a GitHub credential at use
 * time: `credential.https://github.com.helper` through git's `GIT_CONFIG_*`
 * variables, APPENDED after any the env already carries (so a profile's own
 * config entries survive). Invariant 33: a token frozen into the env could not
 * be refreshed — so only the helper's path travels here.
 */
export function githubGitEnv(skillsBase: string, current: Record<string, string | undefined>): Record<string, string> {
  const raw = Number.parseInt(current.GIT_CONFIG_COUNT ?? "", 10);
  const n = Number.isFinite(raw) && raw > 0 ? raw : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "credential.https://github.com.helper",
    [`GIT_CONFIG_VALUE_${n}`]: `!node ${shQuote(githubScriptPath(skillsBase))} credential`,
  };
}

// ---- which account an agent's request means --------------------------------

export type GithubPick =
  | { ok: true; account: ConnectedAccount }
  | { ok: false; status: number; reason: string; accounts?: Array<{ id: string; login: string; owners: string[] }> };

const ownersOf = (a: ConnectedAccount) => (a.github?.installations ?? []).map((i) => i.account);
const listOf = (as: readonly ConnectedAccount[]) => as.map((a) => ({ id: a.id, login: a.github?.login ?? a.label, owners: ownersOf(a) }));

/** The repository owner a hint names: `owner`, `owner/repo`, a github URL. */
export function ownerOf(hint: unknown): string | null {
  if (typeof hint !== "string") return null;
  let s = hint.trim();
  const url = /^(?:https?:\/\/|git@)github\.com[/:](.+)$/i.exec(s);
  if (url) s = url[1];
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/|$)/.exec(s);
  return m ? m[1] : null;
}

/**
 * Which of the GitHub accounts this agent may use (`visible`, already filtered
 * by `accountVisible`) a request means:
 *   1. the one it names (`account`, a unique id prefix),
 *   2. the only usable one,
 *   3. the one whose installations cover the repository's owner,
 *   4. else a refusal listing them.
 * Lapsed accounts are skipped when another is usable; naming one, or holding
 * only lapsed ones, is told to reconnect.
 */
export function pickGithubAccount(
  visible: readonly ConnectedAccount[],
  req: { account?: unknown; owner?: unknown },
  now: number,
  expiredSentence: (a: ConnectedAccount) => string,
): GithubPick {
  const mine = visible.filter((a) => a.provider === "github");
  if (!mine.length) return { ok: false, status: 404, reason: "No GitHub account is shared with this agent. A person connects one in Secrets → Connected accounts." };
  const named = typeof req.account === "string" ? req.account.trim() : "";
  if (named) {
    const hit = resolveAccountId(mine, named);
    if (hit === "none") return { ok: false, status: 404, reason: `No GitHub account matches '${named}'.`, accounts: listOf(mine) };
    if (hit === "ambiguous") return { ok: false, status: 409, reason: `Several GitHub accounts match '${named}' — give more characters.`, accounts: listOf(mine) };
    if (accountLapsed(hit, now)) return { ok: false, status: 409, reason: expiredSentence(hit) };
    return { ok: true, account: hit };
  }
  const live = mine.filter((a) => !accountLapsed(a, now));
  if (!live.length) return { ok: false, status: 409, reason: expiredSentence(mine[0]) };
  if (live.length === 1) return { ok: true, account: live[0] };
  const owner = ownerOf(req.owner);
  if (owner) {
    const covering = live.filter((a) => ownersOf(a).some((o) => o.toLowerCase() === owner.toLowerCase()));
    if (covering.length === 1) return { ok: true, account: covering[0] };
  }
  return {
    ok: false,
    status: 409,
    reason: "Several GitHub accounts are shared with this agent — pick one with --account <id> (or `git config shadok.githubAccount <id>` in the repository).",
    accounts: listOf(live),
  };
}
