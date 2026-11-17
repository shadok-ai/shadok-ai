/**
 * A link to ONE message of a conversation — an agent's or a room's — for someone
 * who already has access to this cockpit. Pure, so the browser and
 * test/deep-link.test.ts share it. Design:
 * docs/superpowers/specs/2026-10-21-message-deep-link-design.md.
 *
 * The message rides in the HASH, never the query: a fragment never reaches the
 * server, a proxy or its logs. An agent link carries the agent's id in the PATH
 * (`/a/<id>`) so its preview can name it — the id only, never the message. The conversation is named by its FULL id — an
 * agent by its session uuid (a shortened one is not an id, invariant 36), a room
 * by its `r_…` id — and the message by its uuid (a transcript uuid for an agent,
 * the message's own uuid for a room).
 */

// A session id and a message uuid are both UUIDs; anything else is refused
// rather than half-trusted, since the parsed values end up in a CSS selector.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A room id (ROOM_ID_RE in src/rooms.ts): `r_` + 16 hex, never UUID-shaped, so
// `agent=` and `room=` can never be confused for one another.
const ROOM = /^r_[0-9a-f]{16}$/i;

/** `base` is origin + path (no hash); returns the shareable URL to an AGENT's
 *  message, or null.
 *
 *  `/a/<session>#msg=<uuid>`: the agent rides in the PATH so the server — and a
 *  chat app's preview bot, which has no session — can name it in the link
 *  preview; the message stays in the hash, never sent anywhere. The page moves
 *  the id back into the hash on load (index.html's head script), so a link
 *  opens exactly like the `#agent=…&msg=…` form, which still works. */
export function buildMessageLink(base, sessionId, msgId) {
  if (!ID.test(String(sessionId ?? "")) || !ID.test(String(msgId ?? ""))) return null;
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/#?]+/i.exec(String(base ?? ""))?.[0] ?? "";
  return `${origin}/a/${sessionId.toLowerCase()}#msg=${msgId.toLowerCase()}`;
}

/** `base` is origin + path (no hash); returns the shareable URL to a ROOM's
 *  message, or null. */
export function buildRoomMessageLink(base, roomId, msgId) {
  if (!ROOM.test(String(roomId ?? "")) || !ID.test(String(msgId ?? ""))) return null;
  const at = String(base ?? "").split("#")[0];
  return `${at}#room=${roomId.toLowerCase()}&msg=${msgId.toLowerCase()}`;
}

/** `location.hash` → `{ agent, msg }` or `{ room, msg }`, or null for anything
 *  else. Never throws. `agent=` wins if both are somehow present. */
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
  const room = params.get("room") ?? "";
  const msg = params.get("msg") ?? "";
  if (!ID.test(msg)) return null;
  if (ID.test(agent)) return { agent: agent.toLowerCase(), msg: msg.toLowerCase() };
  if (ROOM.test(room)) return { room: room.toLowerCase(), msg: msg.toLowerCase() };
  return null;
}

/** Does a prompt the transcript recorded match the bubble the client echoed?
 *  Whitespace-insensitive; a mismatch means "no link", never a wrong one. */
export function samePrompt(a, b) {
  const n = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  return n(a) !== "" && n(a) === n(b);
}
