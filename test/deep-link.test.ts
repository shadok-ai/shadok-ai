import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
// @ts-ignore — plain ESM shared with the browser
import { buildMessageLink, buildRoomMessageLink, parseMessageLink, samePrompt } from "../public/deep-link.js";

const S = "113f3745-0b5e-4c1a-9d2f-0123456789ab";
const M = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const R = "r_0123456789abcdef";

test("link: the agent rides in the path, the message in the hash", () => {
  const url = buildMessageLink("https://cockpit.example/#agent=old", S, M);
  assert.equal(url, `https://cockpit.example/a/${S}#msg=${M}`);
  // Whatever path the page was on, the link starts from the origin.
  assert.equal(buildMessageLink("https://cockpit.example:8443/a/x", S, M), `https://cockpit.example:8443/a/${S}#msg=${M}`);
});

test("link: the page's head script turns /a/<id>#msg= back into the parsed hash form", () => {
  // The rewrite lives inline in index.html (it must run before any parsing);
  // replay its two regexes here on a built link.
  const url = new URL(buildMessageLink("https://cockpit.example/", S, M)!);
  const m = /^\/a\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(url.pathname);
  const msg = /(?:^#|&)msg=([0-9a-f-]{36})(?:&|$)/i.exec(url.hash);
  assert.ok(m && msg);
  assert.deepEqual(parseMessageLink(`#agent=${m![1]}&msg=${msg![1]}`), { agent: S, msg: M });
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(html.includes(String(/^\/a\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)), "index.html carries the same path pattern");
  assert.ok(html.includes(String(/(?:^#|&)msg=([0-9a-f-]{36})(?:&|$)/i)), "index.html carries the same msg pattern");
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
