import assert from "node:assert/strict";
import test from "node:test";
import { notifyState, BLINK_MS } from "../public/notify.js";

// `away` = you are not on the page: hidden tab OR unfocused window. v1 only
// looked at visibility, and therefore never blinked in the cockpit's real use —
// window on screen, user in their terminal. The caller (index.html) composes
// the two.
const needs = (extra = {}) => ({ mood: "needs-answer", muted: false, ...extra });
const unread = (extra = {}) => ({ mood: "unread", muted: false, ...extra });

test("blocked agent + you are elsewhere → blinks red", () => {
  const s = notifyState([needs()], { away: true, phase: 0 });
  assert.equal(s.blink, true);
  assert.equal(s.color, "#e07a6a");
  assert.equal(s.badge, "● ");
});

test("blocked agent but you are on the page → steady red, no blinking", () => {
  const s = notifyState([needs()], { away: false, phase: 1 });
  assert.equal(s.blink, false);
  assert.equal(s.color, "#e07a6a");
  assert.equal(s.badge, "● ");
});

test("muted channel → no global signal, even blocked and hidden", () => {
  const s = notifyState([needs({ muted: true })], { away: true, phase: 0 });
  assert.equal(s.blink, false);
  assert.equal(s.color, null);
  assert.equal(s.badge, "");
});

test("unread answer → steady amber, never blinking", () => {
  for (const hidden of [true, false]) {
    const s = notifyState([unread()], { away: hidden, phase: 0 });
    assert.equal(s.blink, false, "unread ne doit pas clignoter");
    assert.equal(s.color, "#f0a848");
  }
});

test("a muted blocked channel does not outrank an audible unread one", () => {
  const s = notifyState([needs({ muted: true }), unread()], { away: true, phase: 0 });
  assert.equal(s.color, "#f0a848");
  assert.equal(s.blink, false);
});

test("all muted → nothing at all", () => {
  const s = notifyState([needs({ muted: true }), unread({ muted: true })], {
    away: true,
    phase: 0,
  });
  assert.equal(s.color, null);
  assert.equal(s.blink, false);
});

test("a working channel → working mode, no pip and no blinking", () => {
  const s = notifyState([{ mood: "working" }, { mood: null }], { away: true, phase: 0 });
  assert.equal(s.color, null);   // no pip colour: the favicon is animated
  assert.equal(s.blink, false);
  assert.equal(s.mode, "working");
});

test("an idle channel asks for nothing", () => {
  const s = notifyState([{ mood: null }], { away: true, phase: 0 });
  assert.equal(s.mode, null);
  assert.equal(s.color, null);
});

test("priority: blocked > unread > working", () => {
  // blocked + working → blocked wins
  assert.equal(notifyState([{ mood: "working" }, needs()], { away: false, phase: 0 }).mode, "blocked");
  // non-lu + working → non-lu gagne
  assert.equal(notifyState([{ mood: "working" }, unread()], { away: false, phase: 0 }).mode, "unread");
});

// The invariant that protects against a browser-throttled timer: BOTH phases
// stay visible, so a frozen tick can never make the page look calm.
test("both blink phases stay visible", () => {
  const phases = [0, 1].map((phase) => notifyState([needs()], { away: true, phase }));
  for (const s of phases) {
    assert.ok(s.color, "a phase with no colour would leave the favicon bare");
    assert.ok(s.badge.trim(), "a phase with no badge would leave the title bare");
  }
  assert.notEqual(phases[0].color, phases[1].color, "sinon rien ne bouge");
  assert.notEqual(phases[0].badge, phases[1].badge);
});

test("the phase has no effect when we are not blinking", () => {
  const a = notifyState([unread()], { away: true, phase: 0 });
  const b = notifyState([unread()], { away: true, phase: 1 });
  assert.deepEqual(a, b);
});

test("no channel → neutral state", () => {
  const s = notifyState([], { away: true, phase: 0 });
  assert.deepEqual(s, { color: null, badge: "", blink: false, mode: null });
});

test("the tick is slow enough to survive hidden tabs' 1s clamp", () => {
  assert.ok(BLINK_MS >= 800, "below ~1s the browser swallows the ticks");
});
