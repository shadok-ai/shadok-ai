import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore — plain ESM shared with the browser
import { buildMessageLink, buildRoomMessageLink, parseMessageLink, samePrompt } from "../public/deep-link.js";

const S = "113f3745-0b5e-4c1a-9d2f-0123456789ab";
const M = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const R = "r_0123456789abcdef";

test("link: build → parse round trip, hash replaced not appended", () => {
  const url = buildMessageLink("https://cockpit.example/#agent=old", S, M);
  assert.equal(url, `https://cockpit.example/#agent=${S}&msg=${M}`);
  assert.deepEqual(parseMessageLink(new URL(url!).hash), { agent: S, msg: M });
});

test("link: a short or malformed id builds nothing", () => {
  assert.equal(buildMessageLink("http://x/", S.slice(0, 8), M), null);
  assert.equal(buildMessageLink("http://x/", S, ""), null);
  assert.equal(buildMessageLink("http://x/", S, undefined), null);
});

test("link: anything else in the hash is refused, never thrown on", () => {
  for (const h of ["", "#", "#agent=" + S, `#msg=${M}`, `#agent=${S.slice(0, 8)}&msg=${M}`, `#agent=${S}&msg="]`, "#%E0%A4%A", null, undefined])
    assert.equal(parseMessageLink(h as any), null, String(h));
  assert.deepEqual(parseMessageLink(`agent=${S.toUpperCase()}&msg=${M}`), { agent: S, msg: M });
});

test("room link: build → parse round trip, distinct from an agent link", () => {
  const url = buildRoomMessageLink("https://cockpit.example/#room=old", R, M);
  assert.equal(url, `https://cockpit.example/#room=${R}&msg=${M}`);
  assert.deepEqual(parseMessageLink(new URL(url!).hash), { room: R, msg: M });
});

test("room link: a non-room id or bad msg builds nothing", () => {
  assert.equal(buildRoomMessageLink("http://x/", S, M), null); // a session uuid is not a room id
  assert.equal(buildRoomMessageLink("http://x/", R, ""), null);
  assert.equal(buildRoomMessageLink("http://x/", "r_nothex", M), null);
  assert.equal(buildMessageLink("http://x/", R, M), null); // a room id is not a session id
});

test("room link: an agent= wins over a stray room=, a lone room= needs a valid msg", () => {
  assert.deepEqual(parseMessageLink(`#agent=${S}&room=${R}&msg=${M}`), { agent: S, msg: M });
  assert.equal(parseMessageLink(`#room=${R}`), null);
  assert.equal(parseMessageLink(`#room=r_short&msg=${M}`), null);
});

test("samePrompt: whitespace does not count, emptiness never matches", () => {
  assert.equal(samePrompt("hello\n world ", "hello world"), true);
  assert.equal(samePrompt("hello", "hello!"), false);
  assert.equal(samePrompt("", ""), false);
});
