import assert from "node:assert/strict";
import test from "node:test";

import { BOOTSTRAP_ADMIN } from "../src/accounts.js";
import { applyGuestSetup, guestSetupForCwd, type Config } from "../src/config.js";
import type { Group } from "../src/groups.js";
import { guestEnableRefusal, guestGroupChoices, withInstanceMember } from "../src/tg-guests.js";

const CWD = "/srv/one";
const group = (over: Partial<Group> & Pick<Group, "id" | "nature">): Group => ({
  name: over.id,
  members: [],
  osUser: null,
  createdAt: 0,
  ...over,
});

const GUESTS = group({ id: "g1", nature: "restricted", name: "Guests", members: ["ada"], osUser: "sk-g1" });
const MAIN = group({ id: "main", nature: "public", name: "main" });
const PERSONAL = group({ id: "p1", nature: "private", name: "Ada", owner: "ada", members: ["ada"], osUser: "sk-p1" });
const GROUPS = [MAIN, GUESTS, PERSONAL];

const refusal = (over: Partial<Parameters<typeof guestEnableRefusal>[0]> = {}) =>
  guestEnableRefusal({
    mode: "multi-tenant",
    want: { on: true, group: "g1", profile: "Support" },
    groups: GROUPS,
    profileExists: (n) => n === "Support",
    ...over,
  });

test("guestEnableRefusal: a restricted group and a known profile is allowed", () => {
  assert.equal(refusal(), null);
});

test("guestEnableRefusal: turning it OFF is always allowed, even with nothing named", () => {
  // The way out must never be blocked by the same checks as the way in — an
  // operator closing their bot cannot be asked to fix a stale group first.
  assert.equal(refusal({ want: { on: false, group: null, profile: null } }), null);
  assert.equal(refusal({ want: { on: false, group: null, profile: null }, mode: "mono-tenant" }), null);
});

test("guestEnableRefusal: both fields are required to enable", () => {
  assert.match(String(refusal({ want: { on: true, group: null, profile: "Support" } })), /group/i);
  assert.match(String(refusal({ want: { on: true, group: "g1", profile: null } })), /profile/i);
  assert.match(String(refusal({ want: { on: true, group: "g1", profile: "   " } })), /profile/i);
});

test("guestEnableRefusal: outside multi-tenant there is no group that could hold guests", () => {
  const r = refusal({ mode: "mono-tenant" });
  assert.equal(r, "isolation requires the privileged deployment");
});

test("guestEnableRefusal: an unknown group, a public one and a personal one are all refused", () => {
  assert.match(String(refusal({ want: { on: true, group: "nope", profile: "Support" } })), /no such group/i);
  assert.match(String(refusal({ want: { on: true, group: "main", profile: "Support" } })), /restricted/i);
  // A personal group is sealed and the bridge could never be a member of it.
  assert.match(String(refusal({ want: { on: true, group: "p1", profile: "Support" } })), /personal/i);
});

test("guestEnableRefusal: an unknown profile is refused by name", () => {
  const r = String(refusal({ want: { on: true, group: "g1", profile: "Ghost" } }));
  assert.match(r, /Ghost/);
});

test("guestGroupChoices: restricted groups the viewer belongs to, and nothing else", () => {
  const ada = guestGroupChoices(GROUPS, { name: "ada", role: "member" });
  assert.deepEqual(ada.map((g) => g.id), ["g1"]);
  // Not a member: the group is not offered (and a public/personal one never is).
  assert.deepEqual(guestGroupChoices(GROUPS, { name: "bob", role: "admin" }).map((g) => g.id), []);
  assert.deepEqual(guestGroupChoices(GROUPS, null).map((g) => g.id), []);
  // An AGENT principal is judged on its own channel's group, never by name.
  assert.deepEqual(guestGroupChoices(GROUPS, { name: "ada", role: "admin", agentGroup: "g1" }).map((g) => g.id), ["g1"]);
});

test("withInstanceMember: adds the instance once, removes it, and leaves every other group alone", () => {
  const added = withInstanceMember(GROUPS, "g1", true);
  assert.deepEqual(added.find((g) => g.id === "g1")!.members, ["ada", BOOTSTRAP_ADMIN]);
  // Idempotent: enabling twice must not duplicate the member.
  assert.deepEqual(withInstanceMember(added, "g1", true).find((g) => g.id === "g1")!.members, ["ada", BOOTSTRAP_ADMIN]);
  const removed = withInstanceMember(added, "g1", false);
  assert.deepEqual(removed.find((g) => g.id === "g1")!.members, ["ada"]);
  // Other rows are untouched, and the input array is not mutated.
  assert.deepEqual(added.find((g) => g.id === "main")!.members, []);
  assert.deepEqual(GUESTS.members, ["ada"]);
});

test("withInstanceMember: an unknown group id changes nothing", () => {
  assert.deepEqual(withInstanceMember(GROUPS, "nope", true), GROUPS);
});

test("guest setup: stored per launch dir, two directories independent", () => {
  let cfg: Config = {};
  assert.deepEqual(guestSetupForCwd(cfg, CWD), { on: false, group: null, profile: null });
  cfg = applyGuestSetup(cfg, CWD, { on: true, group: "g1", profile: "Support" });
  cfg = applyGuestSetup(cfg, "/srv/two", { on: true, group: "g9", profile: "Other" });
  assert.deepEqual(guestSetupForCwd(cfg, CWD), { on: true, group: "g1", profile: "Support" });
  assert.deepEqual(guestSetupForCwd(cfg, "/srv/two"), { on: true, group: "g9", profile: "Other" });
});

test("guest setup: turning it off KEEPS the group and profile, so re-enabling needs no retyping", () => {
  let cfg: Config = applyGuestSetup({}, CWD, { on: true, group: "g1", profile: "Support" });
  cfg = applyGuestSetup(cfg, CWD, { on: false, group: "g1", profile: "Support" });
  assert.deepEqual(guestSetupForCwd(cfg, CWD), { on: false, group: "g1", profile: "Support" });
});

test("guest setup: a malformed stored row reads as OFF rather than throwing", () => {
  // The file is hand-editable; a half-written row must never open the door.
  const cfg = { telegramGuests: { [CWD]: { on: true, group: 42, profile: null } } } as unknown as Config;
  assert.deepEqual(guestSetupForCwd(cfg, CWD), { on: false, group: null, profile: null });
});
