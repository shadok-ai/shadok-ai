import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { TOUR_STEPS, bubblePlacement, unionRect, visibleSteps } from "../public/tour-steps.js";

const VIEW = { width: 1280, height: 900 };
const BUBBLE = { width: 340, height: 160 };

test("the welcome step has no target, every other step has one", () => {
  // The welcome step is the centred card; it must never be filtered out, which
  // is what a null target buys.
  assert.equal(TOUR_STEPS[0].target, null);
  assert.ok(TOUR_STEPS.slice(1).every((s) => s.target !== null));
  assert.ok(TOUR_STEPS.every((s) => s.id && s.title && s.body));
});

test("a step whose target is absent is dropped, never faked", () => {
  // THE rule of the feature: on a phone there is no agents column, on an empty
  // cockpit there is no active tab. A spotlight on empty space is worse than
  // no tour at all.
  const steps = [
    { id: "a", title: "A", body: "…", target: null },
    { id: "b", title: "B", body: "…", target: "#gone" },
    { id: "c", title: "C", body: "…", target: "#here" },
  ];
  const kept = visibleSteps(steps, (t) => t === "#here");
  assert.deepEqual(
    kept.map((s) => s.id),
    ["a", "c"],
  );
});

test("visibleSteps asks about an array target as a whole", () => {
  // The two dials are separate siblings; the step is kept when the group is.
  const steps = [{ id: "d", title: "D", body: "…", target: ["#x", "#y"] }];
  assert.equal(visibleSteps(steps, (t) => Array.isArray(t)).length, 1);
  assert.equal(visibleSteps(steps, () => false).length, 0);
});

test("unionRect encloses adjacent rects", () => {
  const a = { top: 10, left: 100, width: 40, height: 30 };
  const b = { top: 14, left: 150, width: 40, height: 30 };
  assert.deepEqual(unionRect([a, b]), { top: 10, left: 100, width: 90, height: 34 });
});

test("unionRect: one rect passes through, none yields null", () => {
  const a = { top: 1, left: 2, width: 3, height: 4 };
  assert.deepEqual(unionRect([a]), a);
  // null, not {0,0,0,0}: the caller must skip the step rather than frame the
  // top-left corner of the page.
  assert.equal(unionRect([]), null);
});

test("the bubble sits below the target and is centred on it", () => {
  const target = { top: 100, left: 500, width: 100, height: 40 };
  const p = bubblePlacement({ target, bubble: BUBBLE, viewport: VIEW, gap: 12 });
  assert.equal(p.side, "below");
  assert.equal(p.top, 152); // 100 + 40 + 12
  assert.equal(p.left, 380); // 500 + 50 - 170
});

test("a target near the bottom flips the bubble above it", () => {
  const target = { top: 820, left: 500, width: 100, height: 40 };
  const p = bubblePlacement({ target, bubble: BUBBLE, viewport: VIEW, gap: 12 });
  assert.equal(p.side, "above");
  assert.equal(p.top, 648); // 820 - 160 - 12
});

test("the bubble is clamped inside the viewport on both edges", () => {
  const left = bubblePlacement({
    target: { top: 100, left: 0, width: 40, height: 40 },
    bubble: BUBBLE,
    viewport: VIEW,
    gap: 12,
  });
  assert.equal(left.left, 12);
  const right = bubblePlacement({
    target: { top: 100, left: 1240, width: 40, height: 40 },
    bubble: BUBBLE,
    viewport: VIEW,
    gap: 12,
  });
  assert.equal(right.left, 928); // 1280 - 340 - 12
});

test("a bubble taller than the viewport still lands on screen", () => {
  // A phone in landscape with a big step: clamping must not produce a negative
  // top, which would put the text above the fold with no way to scroll to it.
  const p = bubblePlacement({
    target: { top: 10, left: 10, width: 40, height: 40 },
    bubble: { width: 340, height: 2000 },
    viewport: { width: 390, height: 400 },
    gap: 12,
  });
  assert.equal(p.top, 12);
  assert.equal(p.left, 12);
});

test("the tour shows the scheduled-prompt guard, and shows it on its own", () => {
  // The one capability no competing cockpit has. It used to be the sixth clause
  // of the toolbar step, which is the same as not being in the tour: a
  // first-time visitor met agents, a menu, a toolbar and a gauge — all of them
  // things other tools also have — and left without meeting this one.
  const step = TOUR_STEPS.find((s) => s.id === "schedule");
  assert.ok(step, "the tour must carry a step about scheduled prompts");
  // The claim, not just the word: a schedule is unremarkable, a schedule that
  // costs nothing when there is nothing to report is the whole point.
  assert.match(step.body, /zero tokens/i);
  assert.match(step.body, /without the model/i);
});

test("it follows the step that introduced the menu it lives in", () => {
  // "Schedule" is inside an agent's ⋯ menu, so it only makes sense once that
  // menu has been pointed at. Order is the only thing that carries that here.
  const ids = TOUR_STEPS.map((s) => s.id);
  assert.equal(ids.indexOf("schedule"), ids.indexOf("tab") + 1);
});

test("the toolbar step no longer repeats it", () => {
  // Left in both places, the tour says it twice and leads with neither.
  const tools = TOUR_STEPS.find((s) => s.id === "tools");
  assert.doesNotMatch(tools.body, /scheduled prompts/i);
});

test("an empty rect is dropped, not treated as a point at the origin", () => {
  // What broke the toolbar step on every phone. `reflowHeaderTools` parks five
  // of the eight tool buttons inside the CLOSED ⋯ menu below 640px, and a
  // hidden element measures {0,0,0,0} — so `Math.min` pinned the union to the
  // viewport's corner and the spotlight stretched across the whole header,
  // framing the brand and the gauges while the body described buttons that
  // were not on screen. Measured before the fix: top -6px, left -6px, 367x51.
  const real = { top: 12, left: 286, width: 31, height: 28 };
  const parked = { top: 0, left: 0, width: 0, height: 0 };
  assert.deepEqual(unionRect([parked, real, parked]), real);
});

test("a group whose members are all off screen still yields null", () => {
  // The other half: dropping empties must not turn "nothing is rendered" into
  // a rect. Null is what makes the caller skip the step.
  assert.equal(unionRect([{ top: 0, left: 0, width: 0, height: 0 }]), null);
  assert.equal(unionRect([{ top: 5, left: 5, width: 10, height: 0 }]), null);
});

test("every selector the tour points at exists in the page", () => {
  // The cheap half of "the tour drifts": a renamed or removed id makes a step
  // vanish in silence, exactly like the `.hdr-tools` zero-rect trap. Same
  // spirit as test/csp.test.ts locking the nonce — the page is the source of
  // truth and this file is a set of claims about it.
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const targets = TOUR_STEPS.flatMap((s) =>
    s.target === null ? [] : Array.isArray(s.target) ? s.target : [s.target],
  );
  assert.ok(targets.length > 0);
  for (const sel of targets) {
    // Ids only, deliberately: a class target (`.tab.active`) is one that exists
    // on a single layout, which is how the agent steps disappeared on a phone.
    assert.match(sel, /^#[A-Za-z][\w-]*$/, `${sel} should be an id selector`);
    assert.ok(html.includes(`id="${sel.slice(1)}"`), `${sel} is not in index.html`);
  }
});

test("the toolbar step names the ledger and promises no order", () => {
  // "Left to right: secrets, profiles, Telegram…" was true until the ledger was
  // inserted between the first two, after which a reader counting along the row
  // was told the ledger button was "profiles". An order is a claim about the
  // DOM that nothing here can hold; the functions are not.
  const tools = TOUR_STEPS.find((s) => s.id === "tools");
  assert.match(tools.body, /ledger/i);
  assert.doesNotMatch(tools.body, /left to right/i);
});

test("the agent menu step mentions what shadok itself put in the agent", () => {
  // "Context sent" is the one entry in that menu a newcomer cannot guess the
  // purpose of, and the only place the cockpit shows its own half of the
  // prompt. It went unmentioned for as long as it existed.
  const tab = TOUR_STEPS.find((s) => s.id === "tab");
  assert.match(tab.body, /context sent/i);
});

test("no step describes a landmark by where it sits on the page", () => {
  // The phone and the desktop lay the same landmarks out differently: the
  // agents column becomes a `<select>` holding one option per agent and
  // "＋ New agent" — no top, no bottom, and no "Tweak Shadok-AI" at all. A body
  // saying "at the bottom" is therefore true on one layout and false on the
  // other, which is the copy half of the same bug as a spotlight framing empty
  // space, and much harder to spot because the tour still looks fine.
  for (const s of TOUR_STEPS) {
    assert.doesNotMatch(s.body, /at the (top|bottom)\b/i, `${s.id} points at a position`);
  }
});
