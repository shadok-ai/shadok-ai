import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes } from "node:crypto";

import { talkVerdict, talkLetter } from "../src/talk.js";
import { signTalkHandle, readTalkHandle, signSessionKey } from "../src/accounts.js";
import type { Group } from "../src/groups.js";

const g = (nature: Group["nature"], id = nature): Group => ({
  id,
  name: id.toUpperCase(),
  nature,
  members: [],
  createdAt: 0,
});

// ─── talkVerdict: the pure cross-group ACL ────────────────────────────────────

test("a PUBLIC recipient is messageable freely — no handle needed", () => {
  assert.deepEqual(talkVerdict(g("restricted", "comex"), g("public", "main"), false), { ok: true });
  assert.deepEqual(talkVerdict(g("public", "main"), g("public", "main"), false), { ok: true });
});

test("a RESTRICTED recipient needs a handle; refused without one", () => {
  const sender = g("public", "main");
  const recipient = g("restricted", "comex");
  assert.deepEqual(talkVerdict(sender, recipient, true), { ok: true });
  const refused = talkVerdict(sender, recipient, false);
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /handle/i);
});

test("a PRIVATE recipient is sealed inbound — refused with OR without a handle", () => {
  const recipient = g("private", "ada");
  assert.equal(talkVerdict(g("public", "main"), recipient, false).ok, false);
  // A handle must NOT break the private seal: no break-glass inbound.
  assert.equal(talkVerdict(g("restricted", "comex"), recipient, true).ok, false);
});

test("a PRIVATE sender may send OUTWARD to public and (with a handle) restricted", () => {
  const sender = g("private", "ada");
  assert.deepEqual(talkVerdict(sender, g("public", "main"), false), { ok: true });
  assert.deepEqual(talkVerdict(sender, g("restricted", "comex"), true), { ok: true });
  // …but a private sender to a private recipient is still sealed on the recipient side.
  assert.equal(talkVerdict(sender, g("private", "bob"), true).ok, false);
});

// ─── talkLetter: a letter, not a command ──────────────────────────────────────

test("talkLetter names the sender's group and carries the message verbatim", () => {
  const letter = talkLetter({ group: "COMEX" }, "please review PR 42");
  assert.match(letter, /COMEX/);
  assert.match(letter, /please review PR 42/);
  // It must read as a LETTER handled in the recipient's own context, not a drive.
  assert.match(letter, /letter|message/i);
});

test("talkLetter does not leak a reply handle / the sender's session id", () => {
  const letter = talkLetter({ group: "COMEX" }, "hi");
  assert.doesNotMatch(letter, /sess-|sessionId/i);
});

// ─── talk handle: an opaque, shareable, non-drive token ───────────────────────

test("a talk handle round-trips to its session id", () => {
  const secret = randomBytes(32);
  const handle = signTalkHandle("sess-abc", secret);
  assert.equal(readTalkHandle(handle, secret), "sess-abc");
});

test("a tampered or foreign-secret handle does not verify", () => {
  const secret = randomBytes(32);
  const other = randomBytes(32);
  const handle = signTalkHandle("sess-abc", secret);
  assert.equal(readTalkHandle(handle, other), null);
  assert.equal(readTalkHandle(handle + "x", secret), null);
  assert.equal(readTalkHandle("garbage", secret), null);
});

test("a talk handle is domain-separated from a session key — one is never the other", () => {
  const secret = randomBytes(32);
  const sessionKey = signSessionKey("sess-abc", secret);
  const handle = signTalkHandle("sess-abc", secret);
  // Different MACs for the same id: a handle cannot be presented as a session
  // key (which authenticates AS the agent and can DRIVE it), nor vice versa.
  assert.notEqual(sessionKey, handle);
  assert.equal(readTalkHandle(sessionKey, secret), null);
  // And the reverse direction is checked at the readSessionKey level.
  const wantSession = createHmac("sha256", secret).update(`session:${Buffer.from("sess-abc").toString("base64url")}`).digest("hex");
  assert.doesNotMatch(handle, new RegExp(wantSession + "$"));
});

// ─── server wiring: a source-scan lock (server.ts is un-importable) ───────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(HERE, "..", "src", "server.ts"), "utf8");

/** The source of one route handler: from its `app.<verb>("<path>"` marker to the
 *  next top-level `app.` registration (the route body is between them). Slicing
 *  on `});` is wrong — a route is full of inner `});` (`res.json({...});`). */
function routeSource(marker: string): string {
  const start = SERVER.indexOf(marker);
  assert.notEqual(start, -1, `no route matching ${marker}`);
  const after = SERVER.indexOf("\napp.", start + marker.length);
  return SERVER.slice(start, after === -1 ? undefined : after);
}

test("POST /talk resolves the SENDER server-side (callerOf), never from the body", () => {
  const body = routeSource('app.post("/talk"');
  assert.match(body, /callerOf\(req\)\.id/, "sender must come from the session key, not the body");
});

test("POST /talk resolves the recipient from a HANDLE (readTalkHandle), not a named session", () => {
  const body = routeSource('app.post("/talk"');
  assert.match(body, /readTalkHandle\(/, "recipient must be resolved from a handle");
  assert.match(body, /talkVerdict\(/, "the cross-group ACL must be checked");
});

test("POST /talk delivers a markAgentPrompt letter and does NOT subscribe the sender (fire-and-forget driveChannel)", () => {
  const body = routeSource('app.post("/talk"');
  assert.match(body, /markAgentPrompt\(/, "the letter must be a hidden agent prompt");
  assert.match(body, /talkLetter\(/, "the letter body must come from talkLetter");
  // Fire-and-forget: a bare `void driveChannel(...)` means the sender's HTTP
  // request is never wired to the recipient's stream — a letter, not a drive.
  assert.match(body, /void driveChannel\(/, "delivery must be a one-way, fire-and-forget loopback");
});

test("GET /talk/handle mints only the CALLER's own handle (callerOf + signTalkHandle)", () => {
  const body = routeSource('app.get("/talk/handle"');
  assert.match(body, /callerOf\(req\)\.id/);
  assert.match(body, /signTalkHandle\(/);
});
