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
      "Start one with “new agent”, and group them once there are a few. " +
      "At the bottom, “Tweak Shadok-AI” starts an agent on the cockpit's own source — " +
      "it delivers its work as a pull request.",
    target: "#tabbar",
  },
  {
    id: "tab",
    title: "Each agent has its own menu",
    body:
      "The ⋯ on an agent's tab is where its controls live: mute it, reload it, " +
      "rename it, change its profile, mirror it to Telegram, or close it.",
    target: ".tab.active",
  },
  {
    id: "tools",
    title: "The toolbar",
    body:
      "🔑 secrets injected into agents that need them · 👤 profiles (role, guardrails, model) · " +
      "⏰ scheduled prompts for monitoring · Telegram settings · 🔔 notifications · " +
      "⋯ for the diff of what an agent changed.",
    // NOT `.hdr-tools`, which is `display: contents` on desktop and therefore
    // generates no box at all — its rect is all zeros, so the step would have
    // been dropped as "not visible" on the very layout where the toolbar is
    // most obvious. Framing the buttons themselves works on both layouts.
    target: ["#secretsBtn", "#profilesBtn", "#cronBtn", "#telegramBtn", "#muteNotif", "#moreBtn"],
  },
  {
    id: "quota",
    title: "Watch your quota",
    body:
      "Your 5h and 7d subscription usage. The needle's centre is the pace that would " +
      "spend the window exactly on time, so leaning right means you're burning faster. " +
      "The version number next to the cockpit's name opens updates and the permission mode.",
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
 */
export function unionRect(rects) {
  if (!rects || !rects.length) return null;
  const top = Math.min(...rects.map((r) => r.top));
  const left = Math.min(...rects.map((r) => r.left));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  const right = Math.max(...rects.map((r) => r.left + r.width));
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
