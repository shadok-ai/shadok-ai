// The guided tour: its step data and its geometry, with no DOM in sight.
//
// Loaded as-is by the browser (ESM, served by express.static) and imported by
// the node/tsx tests, like public/gauge-dial.js and public/notify.js. Keeping
// the arithmetic here is the point: bubble placement is what silently breaks on
// a screen size nobody tried, and that is exactly what a unit test can hold.
//
// See docs/superpowers/specs/2026-08-11-guided-tour-design.md.

/**
 * The tour, grouped on purpose: a spotlight frames a REGION, so nine landmarks
 * fit in four stops. A step per button is a tour people abandon.
 *
 * `target` is a CSS selector, an array of them (framed as one rectangle), or
 * null for the centred welcome card.
 *
 * An array is also how a step survives BOTH layouts: the phone and the desktop
 * put the same landmark in different elements (the agents column becomes a
 * `<select>`), and only one of the two is ever on screen. `unionRect` drops the
 * absent one, so the group frames whichever exists. Before that, three of the
 * six steps were silently filtered out on a phone — including every step that
 * mentioned agents at all, i.e. the subject of the product.
 */
export const TOUR_STEPS = [
  {
    id: "welcome",
    title: "Welcome to shadok-ai",
    body:
      "Every agent here is a real Claude Code session, running in its own directory " +
      "and its own git branch, so several can work at once without colliding. " +
      "You drive them from this page — or from Telegram, where one topic is one agent.",
    target: null,
  },
  {
    id: "agents",
    title: "Your agents live here",
    body:
      "Every agent gets its own git worktree and branch, so several never collide. " +
      "Pick one here to follow it, and “＋ New agent” starts another. One of them is this " +
      "cockpit's home agent: the only one that cannot be closed.",
    // The column on desktop, the channel picker on a phone — never both at once.
    //
    // Which is also why this body says neither "at the top" nor "at the bottom",
    // and no longer points at "Tweak Shadok-AI": those describe the COLUMN, and
    // the phone's `<select>` holds one option per agent plus "＋ New agent" and
    // nothing else. A tour that names a control the reader cannot find is the
    // same failure as a spotlight on empty space, just harder to notice.
    // (That Tweak is unreachable on a phone at all is a real gap — in the UI,
    // not in the tour.)
    target: ["#tabbar", "#chanSelect"],
  },
  {
    id: "tab",
    title: "Each agent has its own menu",
    body:
      "This ⋯ holds an agent's controls: mute, reload, rename, change its profile, mirror it " +
      "to a Telegram topic, or have it report to another agent when it finishes. " +
      "“Context sent” shows exactly what shadok told it at spawn — and, except for the home " +
      "agent, this is where you close it.",
    // `#chanMenu`, NOT `.tab.active`. Two reasons, and the second is why it
    // changed: it is literally the button this body tells you to press (the
    // tab's own ⋯ opens the same menu), and it exists on BOTH layouts, whereas
    // a phone has no `.tab` at all — so this step, and the schedule step below
    // it, simply did not happen there.
    target: "#chanMenu",
  },
  {
    // Deliberately its own stop, against this file's own "group landmarks"
    // rule: a schedule is not a landmark, it is the reason to open the cockpit
    // again tomorrow. It used to be the last clause of the toolbar step, sixth
    // in a list of six — so the one capability no other tool has was the least
    // prominent thing in the tour, and a first-time visitor never met it.
    id: "schedule",
    title: "They can work while you're away",
    body:
      "“Schedule”, in that same ⋯ menu, pairs a recurring prompt with a shell check that runs " +
      "without the model. Silent check → nothing happened, the agent stays asleep at zero " +
      "tokens. Otherwise it wakes up holding the finding, and tells you here or on Telegram.",
    target: "#chanMenu",
  },
  {
    id: "tools",
    title: "The toolbar",
    // Not drawn as glyphs: this body is set with textContent, so an inline SVG
    // icon would show as raw markup — and spelling the buttons out as emoji
    // (🔑/👤/🔔) drifted the moment those buttons stopped being emoji.
    //
    // And no longer "left to right" either, which drifted the same way for the
    // same reason: adding the ledger between secrets and profiles shifted every
    // later name onto the wrong icon, so a reader counting along the row was
    // told the ledger was "profiles". An order is a claim about the DOM that
    // no test here can hold; a list of functions is not.
    body:
      "The secret vault injected into agents that need it, the shared ledger of what your " +
      "agents have already resolved, profiles (role, guardrails, model), Telegram, and the " +
      "notification sound. On a narrow screen they fold into the ⋯ — which also holds the " +
      "diff of an agent's work, the palette, and replays this tour.",
    // NOT `.hdr-tools`, which is `display: contents` on desktop and therefore
    // generates no box at all — its rect is all zeros, so the step would have
    // been dropped as "not visible" on the very layout where the toolbar is
    // most obvious. Framing the buttons themselves works on both layouts.
    //
    // Every tool is listed, including the ones `reflowHeaderTools` parks inside
    // the closed ⋯ menu on a phone: those measure {0,0,0,0} and `unionRect`
    // now drops them, so the group frames exactly what is on screen. Listing
    // only some of them was the older bug in the other direction — `#usersBtn`
    // sits left of `#secretsBtn` and stayed outside the spotlight.
    target: [
      "#usersBtn",
      "#secretsBtn",
      "#ledgerBtn",
      "#profilesBtn",
      "#telegramBtn",
      "#muteNotif",
      "#moreBtn",
      "#starBtn",
    ],
  },
  {
    id: "quota",
    title: "Watch your quota",
    body:
      "Your 5h and 7d subscription usage. The needle's centre is the pace that would " +
      "spend the window exactly on time, so leaning right means you're burning faster. " +
      "To the left, the cockpit's name is yours to change, and the version beside it opens " +
      "updates and the permission mode.",
    target: ["#quota5h", "#quota7d"],
  },
];

/** Pure: the steps whose target is on screen, in order. */
export function visibleSteps(steps, isVisible) {
  return steps.filter((s) => s.target === null || isVisible(s.target));
}

/**
 * Pure: the rectangle enclosing them all, or null when there are none.
 *
 * Null rather than a zero rect: a caller that framed {0,0,0,0} would put the
 * spotlight on the page's top-left corner instead of skipping the step.
 *
 * EMPTY RECTS ARE NOT POINTS AT THE ORIGIN, and treating them as such is what
 * broke the toolbar step on every phone. `reflowHeaderTools` moves five of the
 * eight tool buttons into the closed ⋯ menu below 640px; a hidden element
 * measures {0,0,0,0}, so the union's `Math.min` pinned top and left to zero and
 * the spotlight stretched from the viewport's corner across the header —
 * framing the brand, the version and both gauges while the body described
 * buttons that were not on screen at all. Same family as the `.hdr-tools`
 * zero-rect trap noted above, except that one dropped the step honestly and
 * this one kept it and lied. Dropping the empty ones here means a group target
 * frames whatever part of it is actually rendered, and yields null — hence a
 * skipped step — only when none of it is.
 */
export function unionRect(rects) {
  const real = (rects ?? []).filter((r) => r && r.width > 0 && r.height > 0);
  if (!real.length) return null;
  const top = Math.min(...real.map((r) => r.top));
  const left = Math.min(...real.map((r) => r.left));
  const bottom = Math.max(...real.map((r) => r.top + r.height));
  const right = Math.max(...real.map((r) => r.left + r.width));
  return { top, left, width: right - left, height: bottom - top };
}

/** Keeps `v` within [lo, hi]; when hi < lo (a bubble bigger than the screen), lo wins. */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/**
 * Pure: where to put the bubble for a given target.
 *
 * Below by default, flipped above when it would overflow the bottom, and
 * clamped to the viewport on both axes so it is never partly off screen.
 */
export function bubblePlacement({ target, bubble, viewport, gap = 12 }) {
  const below = target.top + target.height + gap;
  const fitsBelow = below + bubble.height + gap <= viewport.height;
  const side = fitsBelow ? "below" : "above";
  const rawTop = fitsBelow ? below : target.top - bubble.height - gap;
  const rawLeft = target.left + target.width / 2 - bubble.width / 2;
  return {
    side,
    top: clamp(rawTop, gap, viewport.height - bubble.height - gap),
    left: clamp(rawLeft, gap, viewport.width - bubble.width - gap),
  };
}
