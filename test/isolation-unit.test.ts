import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationUnit,
  groupUnit,
  osUserForUnit,
  unitConversation,
  unitFor,
  unitGroup,
} from "../src/isolation-unit.js";

// The isolation unit: what shadok actually walls off. A group, as always — or,
// in an EXTERNAL group, ONE conversation inside it (design decisions 1 and 2).

test("a group's unit is its id, byte for byte", () => {
  // Load-bearing for every existing instance: the OS user, the HOME, the media
  // directory and the vault slice all keep keying on exactly this string.
  assert.equal(groupUnit("comex"), "comex");
  assert.equal(unitGroup(groupUnit("comex")), "comex");
  assert.equal(unitConversation(groupUnit("comex")), null);
});

test("a conversation's unit carries its group and its name", () => {
  const u = conversationUnit("door", "wa-33123");
  assert.equal(unitGroup(u), "door");
  assert.equal(unitConversation(u), "wa-33123");
});

test("unitFor: an ordinary group answers with the group, conversation or not", () => {
  const g = { id: "comex", nature: "restricted" as const };
  assert.deepEqual(unitFor(g, null), { ok: true, unit: "comex" });
  // A stray conversation must not move an ordinary group's agents off the
  // account they have always run as.
  assert.deepEqual(unitFor(g, "wa-33123"), { ok: true, unit: "comex" });
  assert.deepEqual(unitFor({ id: "main", nature: "public" as const }, "wa-1"), { ok: true, unit: "main" });
});

test("unitFor: an EXTERNAL group with no conversation REFUSES", () => {
  // Never a fallback. The two available answers are both wrong: the group's own
  // user puts two strangers in one account, the commons puts a stranger in the
  // shared one. So the resolution refuses to answer at all.
  const r = unitFor({ id: "door", nature: "external" as const }, null);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /isolates per conversation/);
  assert.equal(unitFor({ id: "door", nature: "external" as const }, "").ok, false);
});

test("osUserForUnit: a public group has no user, a group unit keeps sk-<id>", () => {
  assert.equal(osUserForUnit("main", "public"), null);
  assert.equal(osUserForUnit("comex", "restricted"), "sk-comex");
  assert.equal(osUserForUnit("ada-priv", "private"), "sk-ada-priv");
  // Sanitised and capped exactly as before.
  assert.equal(osUserForUnit("Ada Team!", "restricted"), "sk-adateam");
  assert.ok((osUserForUnit("a".repeat(80), "restricted") ?? "").length <= 31);
});

test("osUserForUnit: a conversation's account is hashed, marked and within 31 chars", () => {
  const u = osUserForUnit(conversationUnit("door", "wa-33123"), "external")!;
  // A username is capped at 32 and neither a UUID group id nor a phone number
  // fits beside the other — hence a hash, hence the registry
  // (src/external-users.ts), since a hash cannot be reversed.
  assert.match(u, /^sk-x[0-9a-f]{27}$/);
  assert.equal(u.length, 31);
  // `sk-x` tells it apart from a group's `sk-<id>` in /etc/passwd at a glance.
  assert.ok(u.startsWith("sk-x"));
});

test("osUserForUnit: one account per conversation, stable, never the group's", () => {
  const a = osUserForUnit(conversationUnit("door", "wa-33123"), "external");
  const b = osUserForUnit(conversationUnit("door", "wa-33999"), "external");
  const c = osUserForUnit(conversationUnit("other-door", "wa-33123"), "external");
  assert.notEqual(a, b, "two strangers, two accounts");
  assert.notEqual(a, c, "the same name in another group is another account");
  assert.equal(a, osUserForUnit(conversationUnit("door", "wa-33123"), "external"), "stable: they come back to their own");
  assert.notEqual(a, osUserForUnit("door", "restricted"));
});

test("a conversation's unit can never be read as a group id", () => {
  // The `/` is not legal in a username nor in a media directory name, so every
  // name built from it takes the HASHED path — which is what stops code written
  // before units existed from mistaking one for a group.
  const u = conversationUnit("door", "wa-1");
  assert.ok(u.includes("/"));
  assert.notEqual(unitGroup(u), u);
});
