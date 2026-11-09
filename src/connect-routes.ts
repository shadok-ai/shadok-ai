/**
 * Pure halves of the Connect LinkedIn routes (`server.ts`): what the return
 * hash says, whether a start request's origin is acceptable, which sentence and
 * status each outcome maps to, and what a freshly connected account looks like.
 * The routes stay thin mappers, the same split as `route-guards.ts`.
 * Design: docs/superpowers/specs/2026-11-08-connected-accounts-linkedin-design.md §2.
 */
import type { TokenPayload } from "./connect-crypto.js";
import { DEFAULT_SHARE, type IncomingAccount } from "./connected-accounts.js";

export const DEFAULT_CONNECT_BROKER = "https://connect.shadok.ai";
export const RETURN_PATH = "/connect/linkedin/done";

/** `SHADOK_CONNECT_BROKER`, else the hosted broker; trailing slashes stripped. */
export function brokerBase(env: string | undefined): string {
  const v = (env ?? "").trim() || DEFAULT_CONNECT_BROKER;
  return v.replace(/\/+$/, "");
}

/** The broker page the browser is sent to. `origin` was checked by `startOriginOk`. */
export function brokerStartUrl(broker: string, origin: string, pub: string, nonce: string): string {
  const q = new URLSearchParams({ return: `${origin}${RETURN_PATH}`, pub, nonce });
  return `${broker}/linkedin/start?${q.toString()}`;
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
  | { providerError: string };

export const EXPIRED_SENTENCE = "This connection attempt expired — click Connect LinkedIn again.";
export const WRONG_PERSON_SENTENCE = "This connection was started by someone else.";
export const CANCELLED_SENTENCE = "Connection cancelled.";
export const DAMAGED_SENTENCE = "The connection data was damaged — click Connect LinkedIn again.";
export const PROFILE_FAILED_SENTENCE = "Connected, but LinkedIn did not return your profile — try again.";

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
export function outcomeResponse(o: ConnectOutcome): { status: number; body: Record<string, unknown> } {
  if (typeof o === "object") {
    // The code goes in a sentence; keep it to the broker's own alphabet.
    const code = o.providerError.replace(/[^\w.-]/g, "").slice(0, 64) || "unknown";
    return { status: 502, body: { error: `LinkedIn connection failed (${code}).` } };
  }
  switch (o) {
    case "unknown":
    case "expired":
      return { status: 410, body: { error: EXPIRED_SENTENCE } };
    case "wrong-person":
      return { status: 403, body: { error: WRONG_PERSON_SENTENCE } };
    case "cancelled":
      return { status: 200, body: { cancelled: true, message: CANCELLED_SENTENCE } };
    case "damaged":
      return { status: 400, body: { error: DAMAGED_SENTENCE } };
    case "profile-failed":
      return { status: 502, body: { error: PROFILE_FAILED_SENTENCE } };
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
    share: { ...DEFAULT_SHARE },
    policy: "approve",
    token: payload.access_token,
    expiresAt: now + payload.expires_in * 1000,
  };
  if (payload.refresh_token) a.refreshToken = payload.refresh_token;
  if (typeof payload.refresh_token_expires_in === "number" && payload.refresh_token_expires_in > 0)
    a.refreshExpiresAt = now + payload.refresh_token_expires_in * 1000;
  return a;
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
