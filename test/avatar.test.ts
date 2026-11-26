import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { avatarFor, initials, colorFor, speakerName, AVATAR_COLORS } from "../public/avatar.js";

test("initials: first and last word, letters only, upper-cased", () => {
  assert.equal(initials("Alexandre Cognard"), "AC");
  assert.equal(initials("ada"), "A");
  assert.equal(initials("Jean-Pierre de la Fontaine"), "JF");
  assert.equal(initials("élodie martin"), "ÉM");
  assert.equal(initials("ana@example.org"), "A", "an email-like name is one person, not three words");
  assert.equal(initials("🚀 42"), "?");
  assert.equal(initials(""), "?");
});

test("speakerName drops the platform echoAuthor appends", () => {
  assert.equal(speakerName("Ada Lovelace · telegram"), "Ada Lovelace");
  assert.equal(speakerName("you · shell"), "you");
  assert.equal(speakerName("claude"), "claude");
});

test("colorFor is stable and drawn from the tabs' palette", () => {
  assert.equal(colorFor("Ada"), colorFor("Ada"));
  assert.ok(AVATAR_COLORS.includes(colorFor("Ada")));
  assert.ok(AVATAR_COLORS.includes(colorFor("")));
});

test("the palette is the very one the agent tabs paint with", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const m = html.match(/const AVATAR_COLORS = (\[[^\]]*\]);/);
  assert.ok(m);
  assert.deepEqual(JSON.parse(m[1]), AVATAR_COLORS);
});

test("avatarFor: the agent and the server's own voices are the Shadok", () => {
  for (const who of ["claude", "shadok-ai", "auto-retry", "cron"]) assert.deepEqual(avatarFor(who), { kind: "shadok" }, who);
  assert.deepEqual(avatarFor("anything", { role: "claude" }), { kind: "shadok" });
});

test("avatarFor: a named sender gets their initials, platform ignored", () => {
  assert.deepEqual(avatarFor("Ada Lovelace · telegram"), { kind: "initials", text: "AL", color: colorFor("Ada Lovelace") });
});

test("avatarFor: 'you' is the signed-in account, or a silhouette when unknown", () => {
  assert.deepEqual(avatarFor("you", { me: "Bob Martin" }), { kind: "initials", text: "BM", color: colorFor("Bob Martin") });
  assert.deepEqual(avatarFor("you · shell", { me: "Bob Martin" }).kind, "initials");
  assert.deepEqual(avatarFor("you"), { kind: "you" });
  assert.deepEqual(avatarFor("you", { me: null }), { kind: "you" });
});
