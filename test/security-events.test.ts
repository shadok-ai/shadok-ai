import assert from "node:assert/strict";
import test from "node:test";
import {
  appendEvent, aboutYou, inboxFor, markSeen, notMeEffect, describeEvent,
  MAX_EVENTS, MAX_AGE_MS, type SecEvent,
} from "../src/security-events.js";

const ev = (over: Partial<SecEvent>): SecEvent => ({ id: "e", at: 1, kind: "role-changed", actor: "ada", target: "bob", ...over });

test("events: appended with an id and a time, bounded in count and age", () => {
  let list: SecEvent[] = [];
  list = appendEvent(list, { kind: "invited", actor: "ada", target: "bob" }, 10, "x");
  assert.deepEqual(list, [{ id: "x", at: 10, kind: "invited", actor: "ada", target: "bob" }]);
  const many = Array.from({ length: MAX_EVENTS }, (_, i) => ev({ id: "m" + i, at: 100 }));
  assert.equal(appendEvent(many, { kind: "removed", actor: "a", target: "b" }, 100).length, MAX_EVENTS);
  const old = [ev({ id: "old", at: 0 })];
  assert.equal(appendEvent(old, { kind: "removed", actor: "a", target: "b" }, MAX_AGE_MS + 1).some((e) => e.id === "old"), false);
});

test("about you: what others did to you, and every passkey change even 'by you'", () => {
  assert.equal(aboutYou(ev({ actor: "ada", target: "bob" }), "bob"), true);
  assert.equal(aboutYou(ev({ actor: "bob", target: "bob", kind: "invite-redeemed" }), "bob"), false);
  // Whoever holds bob's password and a code IS bob to the server: that is the case to show.
  assert.equal(aboutYou(ev({ actor: "bob", target: "bob", kind: "passkey-added" }), "bob"), true);
  assert.equal(aboutYou(ev({ actor: "ada", target: "carol" }), "bob"), false);
  assert.equal(aboutYou(ev({ kind: "not-me", actor: "bob", target: "bob" }), "bob"), false);
});

test("inbox: a member sees only what concerns them; an admin also gets the whole log", () => {
  const events = [
    ev({ id: "1", at: 1, target: "bob" }),
    ev({ id: "2", at: 2, target: "carol" }),
    ev({ id: "3", at: 3, kind: "not-me", actor: "carol", target: "carol" }),
  ];
  const bob = inboxFor({ name: "bob", role: "member" }, events);
  assert.deepEqual(bob.aboutYou.map((e) => e.id), ["1"]);
  assert.deepEqual(bob.log, []);
  assert.equal(bob.badge, 1);
  const ada = inboxFor({ name: "ada", role: "admin" }, events);
  assert.deepEqual(ada.log.map((e) => e.id), ["3", "2", "1"]); // newest first
  assert.equal(ada.badge, 1); // the unread "this wasn't me" flag
});

test("inbox: seen is per viewer", () => {
  const events = [ev({ id: "1", target: "bob" }), ev({ id: "2", kind: "not-me", actor: "carol", target: "carol" })];
  const seen = markSeen(events, { name: "bob", role: "member" });
  assert.equal(inboxFor({ name: "bob", role: "member" }, seen).badge, 0);
  // Bob opening his panel does not mark anything read for an admin.
  assert.equal(inboxFor({ name: "ada", role: "admin" }, seen).badge, 1);
  // A member cannot mark what they cannot see.
  assert.deepEqual(seen.find((e) => e.id === "2")!.seenBy, undefined);
});

test("this wasn't me: only the target, once; a passkey nobody admits to is removed", () => {
  const added = ev({ id: "p", kind: "passkey-added", actor: "bob", target: "bob", passkeyId: "pk1" });
  assert.deepEqual(notMeEffect(added, "bob"), { ok: true, removePasskey: "pk1" });
  assert.deepEqual(notMeEffect(ev({ kind: "role-changed" }), "bob"), { ok: true });
  assert.equal(notMeEffect(added, "ada").ok, false);
  assert.equal(notMeEffect({ ...added, disowned: true }, "bob").ok, false);
  assert.equal(notMeEffect(undefined, "bob").ok, false);
});

test("describe: one readable line per kind", () => {
  assert.equal(describeEvent(ev({ detail: "admin" })), "ada made bob admin");
  assert.match(describeEvent(ev({ kind: "passkey-added", actor: "bob", target: "bob", detail: "iPhone" })), /“iPhone”.*by you/);
  assert.match(describeEvent(ev({ kind: "access-reset" })), /reset bob's access/);
});
