/**
 * A link to ONE message of an agent's conversation, for someone who already has
 * access to this cockpit. Pure, so the browser and test/deep-link.test.ts share
 * it. Design: docs/superpowers/specs/2026-10-21-message-deep-link-design.md.
 *
 * The state rides in the HASH, never the query: a fragment never reaches the
 * server, a proxy or its logs. The agent is named by its FULL session id — a
 * shortened one is not an id (invariant 36) — and the message by its transcript
 * uuid.
 */

// A session id and a transcript uuid are both UUIDs; anything else is refused
// rather than half-trusted, since the parsed values end up in a CSS selector.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `base` is origin + path (no hash); returns the shareable URL. */
export function buildMessageLink(base, sessionId, msgId) {
  if (!ID.test(String(sessionId ?? "")) || !ID.test(String(msgId ?? ""))) return null;
  const at = String(base ?? "").split("#")[0];
  return `${at}#agent=${sessionId.toLowerCase()}&msg=${msgId.toLowerCase()}`;
}

/** `location.hash` → `{ agent, msg }`, or null for anything else. Never throws. */
export function parseMessageLink(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (!raw) return null;
  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const agent = params.get("agent") ?? "";
  const msg = params.get("msg") ?? "";
  if (!ID.test(agent) || !ID.test(msg)) return null;
  return { agent: agent.toLowerCase(), msg: msg.toLowerCase() };
}

/** Does a prompt the transcript recorded match the bubble the client echoed?
 *  Whitespace-insensitive; a mismatch means "no link", never a wrong one. */
export function samePrompt(a, b) {
  const n = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  return n(a) !== "" && n(a) === n(b);
}
