import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore — plain ESM shared with the browser
import { buildMessageLink, parseMessageLink, samePrompt } from "../public/deep-link.js";

const S = "113f3745-0b5e-4c1a-9d2f-0123456789ab";
const M = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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

test("samePrompt: whitespace does not count, emptiness never matches", () => {
  assert.equal(samePrompt("hello\n world ", "hello world"), true);
  assert.equal(samePrompt("hello", "hello!"), false);
  assert.equal(samePrompt("", ""), false);
});
