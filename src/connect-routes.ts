/**
 * Pure halves of the Connect routes (LinkedIn, Google) (`server.ts`): what the return
 * hash says, whether a start request's origin is acceptable, which sentence and
 * status each outcome maps to, and what a freshly connected account looks like.
 * The routes stay thin mappers, the same split as `route-guards.ts`.
 * Design: docs/superpowers/specs/2026-11-08-connected-accounts-linkedin-design.md §2.
 */
import type { TokenPayload } from "./connect-crypto.js";
import { GOOGLE_AREAS, defaultGooglePolicies, defaultShare, type AccountProvider, type GoogleArea, type IncomingAccount } from "./connected-accounts.js";

export const DEFAULT_CONNECT_BROKER = "https://connect.shadok.ai";

export const CONNECT_PROVIDERS: readonly AccountProvider[] = ["linkedin", "google"];
export const isConnectProvider = (v: unknown): v is AccountProvider =>
  typeof v === "string" && (CONNECT_PROVIDERS as readonly string[]).includes(v);
export const PROVIDER_LABEL: Record<AccountProvider, string> = { linkedin: "LinkedIn", google: "Google" };

/** Where the broker hands the browser back: one fixed path per provider (the
 *  broker validates it, broker/src/core.ts `returnPathFor`). */
export const returnPathFor = (p: AccountProvider) => `/connect/${p}/done`;
export const RETURN_PATH = returnPathFor("linkedin");

/** While the Google app is in Testing a refresh token lasts 7 days (Google's rule). */
export const GOOGLE_TESTING_REFRESH_MS = 7 * 24 * 3600_000;

/**
 * The areas a Connect Google request ticks: a non-empty list of known names,
 * deduplicated, in table order. Null for anything else — the broker refuses
 * an unknown name too, but a refusal here is a sentence in the dialog rather
 * than a broker error page.
 */
export function parseAreas(raw: unknown): GoogleArea[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.some((x) => typeof x !== "string" || !(GOOGLE_AREAS as string[]).includes(x))) return null;
  return GOOGLE_AREAS.filter((k) => raw.includes(k));
}

/** `SHADOK_CONNECT_BROKER`, else the hosted broker; trailing slashes stripped. */
export function brokerBase(env: string | undefined): string {
  const v = (env ?? "").trim() || DEFAULT_CONNECT_BROKER;
  return v.replace(/\/+$/, "");
}

/** The broker page the browser is sent to. `origin` was checked by `startOriginOk`. */
export function brokerStartUrl(
  broker: string,
  origin: string,
  pub: string,
  nonce: string,
  provider: AccountProvider = "linkedin",
  areas: readonly GoogleArea[] = [],
): string {
  const q = new URLSearchParams({ return: `${origin}${returnPathFor(provider)}`, pub, nonce });
  if (provider === "google") q.set("areas", areas.join(","));
  return `${broker}/${provider}/start?${q.toString()}`;
}

/**
 * The origin the page sends must be a bare http(s) origin AND the request's own
 * `Origin` header: the return URL is the browser's `location.origin` (behind a
 * TLS proxy the server does not know its public name, invariant 20), and tying
 * it to the header stops a caller from pointing the token at another host.
 */
export function startOriginOk(bodyOrigin: unknown, headerOrigin: unknown): boolean {
  if (typeof bodyOrigin !== "string" || typeof headerOrigin !== "string") return false;
  if (bodyOrigin !== headerOrigin) return false;
  let u: URL;
  try {
    u = new URL(bodyOrigin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return u.origin === bodyOrigin;
}

export type ConnectHash =
  | { kind: "payload"; nonce: string; blob: string }
  | { kind: "error"; nonce: string | null; error: string }
  | { kind: "malformed" };

/** `#n=…&c=…` (success) or `#n=…&error=…` (refusal/cancel). Anything else is malformed. */
export function parseConnectHash(hash: unknown): ConnectHash {
  if (typeof hash !== "string") return { kind: "malformed" };
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const nonce = p.get("n") || null;
  const error = p.get("error");
  if (error) return { kind: "error", nonce, error };
  const blob = p.get("c");
  if (nonce && blob) return { kind: "payload", nonce, blob };
  return { kind: "malformed" };
}

export type ConnectOutcome =
  | "unknown"
  | "expired"
  | "wrong-person"
  | "cancelled"
  | "damaged"
  | "profile-failed"
  | "no-refresh"
  | { providerError: string };

export const expiredSentence = (p: AccountProvider) => `This connection attempt expired — click Connect ${PROVIDER_LABEL[p]} again.`;
export const damagedSentence = (p: AccountProvider) => `The connection data was damaged — click Connect ${PROVIDER_LABEL[p]} again.`;
export const profileFailedSentence = (p: AccountProvider) => `Connected, but ${PROVIDER_LABEL[p]} did not return your profile — try again.`;
export const EXPIRED_SENTENCE = expiredSentence("linkedin");
export const WRONG_PERSON_SENTENCE = "This connection was started by someone else.";
export const CANCELLED_SENTENCE = "Connection cancelled.";
export const DAMAGED_SENTENCE = damagedSentence("linkedin");
export const PROFILE_FAILED_SENTENCE = profileFailedSentence("linkedin");
/** Google returns a refresh token only with offline access + a fresh consent;
 *  without one the account would die within the hour, so it is not stored. */
export const NO_REFRESH_SENTENCE = "Google did not return a long-lived authorisation — click Connect Google again and accept the consent screen.";
/**
 * Google's `access_denied`. It is what a declined consent screen sends back,
 * and while the app is in Testing a Google account outside the test list is
 * refused too — the two are not told apart on the way back, so the sentence
 * names both rather than guess.
 */
export const GOOGLE_DENIED_SENTENCE =
  "Google did not grant access. If you did not decline it yourself: this Google account is not on the test list of the shadok app — ask the instance operator.";

const CANCEL_CODES = new Set(["user_cancelled_authorize", "cancelled"]);

/** A broker `error=` code as an outcome: a cancel is not a failure. */
export function errorOutcome(code: string): ConnectOutcome {
  return CANCEL_CODES.has(code) ? "cancelled" : { providerError: code };
}

/**
 * Every refusal as HTTP status + body. An unknown nonce is what an instance
 * restart (or a replayed link) produces, so it reads as "expired, click again"
 * with a 410 — never a 500.
 */
export function outcomeResponse(o: ConnectOutcome, provider: AccountProvider = "linkedin"): { status: number; body: Record<string, unknown> } {
  if (typeof o === "object") {
    // The code goes in a sentence; keep it to the broker's own alphabet.
    const code = o.providerError.replace(/[^\w.-]/g, "").slice(0, 64) || "unknown";
    if (provider === "google" && code === "access_denied") return { status: 403, body: { error: GOOGLE_DENIED_SENTENCE } };
    return { status: 502, body: { error: `${PROVIDER_LABEL[provider]} connection failed (${code}).` } };
  }
  switch (o) {
    case "unknown":
    case "expired":
      return { status: 410, body: { error: expiredSentence(provider) } };
    case "wrong-person":
      return { status: 403, body: { error: WRONG_PERSON_SENTENCE } };
    case "cancelled":
      return { status: 200, body: { cancelled: true, message: CANCELLED_SENTENCE } };
    case "damaged":
      return { status: 400, body: { error: damagedSentence(provider) } };
    case "profile-failed":
      return { status: 502, body: { error: profileFailedSentence(provider) } };
    case "no-refresh":
      return { status: 502, body: { error: NO_REFRESH_SENTENCE } };
  }
}

/** A short label for the one console line per outcome (never the token). */
export function outcomeLabel(o: ConnectOutcome): string {
  return typeof o === "object" ? `provider-error(${o.providerError.replace(/[^\w.-]/g, "").slice(0, 64)})` : o;
}

/** The account a successful connect stores; share/policy defaults are `upsertAccount`'s. */
export function connectedMember(
  person: string,
  member: { sub: string; name: string },
  payload: TokenPayload,
  now: number,
): IncomingAccount {
  const a: IncomingAccount = {
    provider: "linkedin",
    kind: "member",
    label: member.name || member.sub,
    externalId: `urn:li:person:${member.sub}`,
    owner: person,
    connectedVia: person,
    share: defaultShare(),
    policy: "approve",
    token: payload.access_token,
    expiresAt: now + payload.expires_in * 1000,
  };
  if (payload.refresh_token) a.refreshToken = payload.refresh_token;
  if (typeof payload.refresh_token_expires_in === "number" && payload.refresh_token_expires_in > 0)
    a.refreshExpiresAt = now + payload.refresh_token_expires_in * 1000;
  return a;
}

/**
 * The Google account a successful connect stores. The label is the EMAIL
 * (people hold several Google accounts; it is what tells them apart), the
 * identity the OIDC `sub`. `scopes` is what Google GRANTED (the token
 * response), never what was asked: a person may untick an area on the consent
 * screen. `expiresAt` is the access token's; the reconnect deadline is
 * `refreshExpiresAt` — Google's own figure when it sends one, else 7 days from
 * now while the broker says the app is in Testing, else unknown.
 */
export function connectedGoogle(
  person: string,
  user: { sub: string; email: string },
  payload: TokenPayload,
  now: number,
  testing: boolean,
): IncomingAccount {
  const a: IncomingAccount = {
    provider: "google",
    kind: "member",
    label: user.email || user.sub,
    externalId: user.sub,
    owner: person,
    connectedVia: person,
    share: defaultShare(),
    policy: "approve",
    policies: defaultGooglePolicies(),
    scopes: typeof payload.scope === "string" ? [...new Set(payload.scope.split(/\s+/).filter(Boolean))] : [],
    token: payload.access_token,
    expiresAt: now + payload.expires_in * 1000,
    refreshToken: payload.refresh_token,
  };
  if (typeof payload.refresh_token_expires_in === "number" && payload.refresh_token_expires_in > 0)
    a.refreshExpiresAt = now + payload.refresh_token_expires_in * 1000;
  else if (testing) a.refreshExpiresAt = now + GOOGLE_TESTING_REFRESH_MS;
  return a;
}

/**
 * Broker `/health` → which providers it offers, and which of them run a Testing
 * app (`testing: ["google"]`). A provider is offered only when listed: an
 * unreachable or older broker offers none of the ones it does not name.
 */
export function healthProviders(body: unknown): { linkedin: boolean; google: boolean; googleTesting: boolean } {
  const b = body as { providers?: unknown; testing?: unknown } | null;
  const providers = Array.isArray(b?.providers) ? b.providers : [];
  const testing = Array.isArray(b?.testing) ? b.testing : [];
  const google = providers.includes("google");
  return { linkedin: providers.includes("linkedin"), google, googleTesting: google && testing.includes("google") };
}

/** Broker `/health` answer → does it offer LinkedIn? */
export function healthOffersLinkedIn(body: unknown): boolean {
  const providers = (body as { providers?: unknown } | null)?.providers;
  return Array.isArray(providers) && providers.includes("linkedin");
}

/**
 * May this caller READ the connect state (`GET /connect/status`,
 * `GET /connected-accounts`)? Not `requestFromBrowser`: that requires an
 * `Origin`, and a browser sends none on a same-origin GET — both routes 403'd
 * in every real browser (the `/agent-login` trap). A read changes nothing, so
 * the CSRF layer has nothing to protect; what stays is "a person, not a
 * machine": an agent's key or a peer token refuses outright, the server's own
 * bridge cookie is not a person, and the resolved account must not be an agent.
 * The writes (POST/PUT/DELETE) keep the full `requestFromBrowser` gate.
 */
export function connectReadAllowed(o: {
  hasAgentKey: boolean;
  hasPeerToken: boolean;
  internalClient: boolean;
  account: { agent?: unknown } | null;
}): boolean {
  if (o.hasAgentKey || o.hasPeerToken || o.internalClient) return false;
  return o.account !== null && !o.account.agent;
}
