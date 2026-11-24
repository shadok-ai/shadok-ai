import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOTSTRAP_ADMIN } from "../src/accounts.js";
import { guestPatchFlow, type GuestSetup } from "../src/tg-guests.js";
import { applyWaGuestSetup, waGuestSetupForCwd, type Config } from "../src/config.js";
import type { Group } from "../src/groups.js";

// The instance's membership of a guest group is SHARED by the Telegram and the
// WhatsApp door (design constraint 6): it may leave a group only when neither
// setup still targets it. Telegram's own test file is left untouched; this one
// covers the second bridge.

const G = (members: string[] = ["ada"]): Group => ({ id: "g1", name: "Support", nature: "restricted", members }) as Group;
const OPEN_TG: GuestSetup = { mode: "dm-only", group: "g1", profile: "Support", joined: true };
const OPEN_WA: GuestSetup = { mode: "dm-only", group: "g1", profile: "Support" };
const SHUT: GuestSetup = { mode: "group", group: "g1", profile: "Support" };
const base = { mode: "multi-tenant" as const, profileExists: () => true, hasOwner: false };

test("closing one door while the other targets the group keeps the instance in it, and hands the membership over", () => {
  const r = guestPatchFlow({ ...base, previous: OPEN_TG, want: SHUT, groups: [G(["ada", BOOTSTRAP_ADMIN])], other: OPEN_WA });
  assert.ok(r.ok);
  assert.ok(r.groups[0].members.includes(BOOTSTRAP_ADMIN));
  assert.equal(r.handOver, true);
});

test("closing the last door that targets it takes the membership back", () => {
  const r = guestPatchFlow({
    ...base,
    previous: { ...OPEN_WA, joined: true },
    want: SHUT,
    groups: [G(["ada", BOOTSTRAP_ADMIN])],
    other: SHUT,
  });
  assert.ok(r.ok);
  assert.ok(!r.groups[0].members.includes(BOOTSTRAP_ADMIN));
  assert.equal(r.handOver, undefined);
});

test("opening a door on a group the other already put the instance in does not claim it", () => {
  const r = guestPatchFlow({ ...base, previous: SHUT, want: OPEN_WA, groups: [G(["ada", BOOTSTRAP_ADMIN])], other: OPEN_TG });
  assert.ok(r.ok);
  assert.equal(r.setup.joined, undefined);
});

test("with no other door, the flow is exactly Telegram's", () => {
  const groups = [G(["ada"])];
  const a = guestPatchFlow({ ...base, previous: SHUT, want: OPEN_WA, groups });
  const b = guestPatchFlow({ ...base, previous: SHUT, want: OPEN_WA, groups, other: undefined });
  assert.deepEqual(a, b);
  assert.ok(a.ok && a.setup.joined === true);
});

test("the WhatsApp setup is stored under its own key, open or shut only", () => {
  const cfg: Config = {};
  applyWaGuestSetup(cfg, "/srv", OPEN_WA);
  assert.deepEqual(waGuestSetupForCwd(cfg, "/srv"), OPEN_WA);
  assert.equal(cfg.telegramGuests, undefined, "never Telegram's");
  applyWaGuestSetup(cfg, "/srv", { mode: "group+dm", group: "g1", profile: "Support" });
  assert.equal(waGuestSetupForCwd(cfg, "/srv").mode, "group");
  assert.equal(waGuestSetupForCwd({}, "/srv").mode, "group");
});
