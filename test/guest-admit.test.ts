import assert from "node:assert/strict";
import test from "node:test";

import {
  GUEST_LIMITS,
  requestedLimits,
  GUEST_RATE_WINDOW_MS,
  guestAdmitVerdict,
  guestConversationKey,
  guestLimitsOf,
  liveGuestKeys,
} from "../src/guest-admit.js";
import { normalizeGuestSetup } from "../src/tg-guests.js";

// The door's admission ceiling — the cost the per-conversation wall creates
// (docs/superpowers/specs/2026-11-26-external-groups-per-conversation-isolation-design.md,
// decision 3). Both doors were uncapped: a stranger costs a `claude` process
// today and a Unix account tomorrow, so anyone who knows the number could make
// the instance provision until it fell over.

const tg = (chatId: number, group = "door") => ({ group, telegram: { chatId } });
const wa = (id: string, group = "door") => ({ group, whatsapp: { account: "33000@s.whatsapp.net", id } });

test("guestConversationKey: a conversation is named the way its folder is", () => {
  // Reused on purpose rather than invented: that name is already what makes a
  // person come back to their own directory, and two names for one person
  // would charge a returning guest as a new one.
  assert.equal(guestConversationKey(tg(4242)), "tg-4242");
  assert.equal(guestConversationKey(wa("33123456789@s.whatsapp.net")), "wa-33123456789");
  // The same person under their LID and under their phone address are two
  // addresses, and WhatsApp's own `findWaChannel` is what reconciles them —
  // here each resolves to a key, and neither resolves to the other's.
  assert.equal(guestConversationKey(wa("271828182845@lid")), "wa-271828182845");
});

test("guestConversationKey: what is not a guest's conversation has no key", () => {
  assert.equal(guestConversationKey(null), null);
  assert.equal(guestConversationKey(undefined), null);
  assert.equal(guestConversationKey({}), null);
  // A topic is a board agent, not a guest.
  assert.equal(guestConversationKey({ telegram: { chatId: 4242, threadId: 7 } }), null);
  // A negative id is a group chat.
  assert.equal(guestConversationKey({ telegram: { chatId: -1002345678 } }), null);
  assert.equal(guestConversationKey({ whatsapp: { id: "not-a-jid" } }), null);
});

test("liveGuestKeys: only this group's conversations, counted once each", () => {
  const keys = liveGuestKeys(
    [
      tg(1),
      tg(1), // the same person on two rows is ONE conversation
      wa("33111@s.whatsapp.net"),
      tg(2, "other-group"), // another group's guest never fills this door
      { group: "door", telegram: { chatId: 9, threadId: 3 } }, // a topic
      { group: "door" }, // an ordinary agent of the group
    ],
    "door",
  );
  assert.deepEqual([...keys].sort(), ["tg-1", "wa-33111"]);
});

test("liveGuestKeys: counted per GROUP, so two doors share one ceiling", () => {
  // The group is where a conversation costs a Unix user and a home. Counting a
  // door's own channels would let an operator double the ceiling by pointing a
  // second door at the same group.
  const list = [tg(1), wa("33111@s.whatsapp.net")];
  assert.equal(liveGuestKeys(list, "door").size, 2);
});

test("guestLimitsOf: absent means the defaults", () => {
  assert.deepEqual(guestLimitsOf({}), GUEST_LIMITS);
  assert.deepEqual(guestLimitsOf({ limits: {} }), GUEST_LIMITS);
  assert.deepEqual(guestLimitsOf({ limits: { live: 5 } }), { live: 5, perHour: GUEST_LIMITS.perHour });
  assert.deepEqual(guestLimitsOf({ limits: { live: 5, perHour: 2 } }), { live: 5, perHour: 2 });
});

test("guestLimitsOf: a malformed value reads as unset, never as a shut door", () => {
  // The config file is hand-editable (`normalizeTgMode` makes the same call):
  // a typo that silently shut the bot would be indistinguishable from a bot
  // that stopped working. Closing a door is what the MODE is for.
  for (const bad of [0, -1, 1.5, NaN, Infinity, "10", null, undefined, {}, []] as unknown[]) {
    assert.deepEqual(guestLimitsOf({ limits: { live: bad as number } }), GUEST_LIMITS, String(bad));
    assert.deepEqual(guestLimitsOf({ limits: { perHour: bad as number } }), GUEST_LIMITS, String(bad));
  }
});

test("normalizeGuestSetup carries the ceiling through", () => {
  // A normalizer that dropped it would reset the operator's numbers on the
  // next panel save, with nothing to show for it (invariant 6's family).
  const s = normalizeGuestSetup({ mode: "dm-only", group: "door", profile: "p", limits: { live: 7 } });
  assert.deepEqual(s.limits, { live: 7 });
  assert.equal(normalizeGuestSetup({ mode: "group", group: null, profile: null }).limits, undefined);
});

const NOW = 1_700_000_000_000;
const limits = { live: 3, perHour: 2 };
const keys = (...k: string[]) => new Set(k);

test("guestAdmitVerdict: room, so a new stranger comes in", () => {
  const v = guestAdmitVerdict({ limits, live: keys("tg-1"), key: "tg-2", recent: [], now: NOW });
  assert.deepEqual(v, { ok: true, returning: false });
});

test("guestAdmitVerdict: a RETURNING conversation is never capped or rated", () => {
  // The load-bearing half: the ceiling bounds new strangers and must never cut
  // off someone the instance is already talking to — including a guest whose
  // agent the operator deleted, who comes back through this very path.
  const full = keys("tg-1", "tg-2", "tg-3");
  const v = guestAdmitVerdict({
    limits,
    live: full,
    key: "tg-2",
    recent: [NOW, NOW, NOW, NOW],
    now: NOW,
  });
  assert.deepEqual(v, { ok: true, returning: true });
});

test("guestAdmitVerdict: the door is full", () => {
  const v = guestAdmitVerdict({ limits, live: keys("tg-1", "tg-2", "tg-3"), key: "tg-9", recent: [], now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.why, "full");
  assert.match(v.ok === false ? v.message : "", /maximum of 3 guest conversations/);
});

test("guestAdmitVerdict: the hourly rate stops a burst", () => {
  const v = guestAdmitVerdict({ limits, live: keys(), key: "tg-9", recent: [NOW - 10, NOW - 20], now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.why, "rate");
  assert.match(v.ok === false ? v.message : "", /maximum of 2 new guest conversations/);
});

test("guestAdmitVerdict: an admission outside the window does not count", () => {
  const old = NOW - GUEST_RATE_WINDOW_MS - 1;
  const v = guestAdmitVerdict({ limits, live: keys(), key: "tg-9", recent: [old, old], now: NOW });
  assert.deepEqual(v, { ok: true, returning: false });
});

test("guestAdmitVerdict: the cap is asked before the rate", () => {
  // Both would refuse; the durable reason is the one worth logging, since the
  // rate window clears itself and the cap does not.
  const v = guestAdmitVerdict({
    limits,
    live: keys("tg-1", "tg-2", "tg-3"),
    key: "tg-9",
    recent: [NOW, NOW],
    now: NOW,
  });
  assert.equal(v.ok === false && v.why, "full");
});

test("guestAdmitVerdict: the defaults let an ordinary instance through", () => {
  // 200 live / 30 per hour, settled with the operator: an ordinary flow never
  // meets them. The point of the ceiling is that the 201st is a refusal and
  // not a crash.
  const live = new Set(Array.from({ length: 199 }, (_, i) => `tg-${i}`));
  assert.equal(
    guestAdmitVerdict({ limits: GUEST_LIMITS, live, key: "tg-new", recent: [], now: NOW }).ok,
    true,
  );
  const atCap = new Set(Array.from({ length: GUEST_LIMITS.live }, (_, i) => `tg-${i}`));
  assert.equal(
    guestAdmitVerdict({ limits: GUEST_LIMITS, live: atCap, key: "tg-new", recent: [], now: NOW }).ok,
    false,
  );
});

test("requestedLimits: a request that names no ceiling names none", () => {
  // Not "the defaults": a patch that does not mention the ceiling must leave
  // the operator's numbers alone, and the panel does not mention it.
  assert.equal(requestedLimits({}), undefined);
  assert.equal(requestedLimits({ on: true, group: "g1" }), undefined);
});

test("requestedLimits: an EMPTY ceiling is the way back to the defaults", () => {
  assert.deepEqual(requestedLimits({ limits: {} }), {});
  assert.deepEqual(requestedLimits({ limits: null }), {});
  // …and so is one whose every number is unusable: nothing is stored, so
  // `guestLimitsOf` answers with the defaults.
  assert.deepEqual(requestedLimits({ limits: { live: 0, perHour: "many" } }), {});
});

test("requestedLimits: only positive integers come through", () => {
  assert.deepEqual(requestedLimits({ limits: { live: 12, perHour: 4 } }), { live: 12, perHour: 4 });
  assert.deepEqual(requestedLimits({ limits: { live: 12, perHour: -4 } }), { live: 12 });
  assert.deepEqual(requestedLimits({ limits: { live: 1.5 } }), {});
});
