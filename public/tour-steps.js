// The guided tour: its step data and its geometry, with no DOM in sight.
//
// Loaded as-is by the browser (ESM, served by express.static) and imported by
// the node/tsx tests, like public/gauge-dial.js and public/notify.js. Keeping
// the arithmetic here is the point: bubble placement is what silently breaks on
// a screen size nobody tried, and that is exactly what a unit test can hold.
//
// See docs/superpowers/specs/2026-08-11-guided-tour-design.md.

/**
 * The tour, grouped on purpose: a spotlight frames a REGION, so some thirty
 * controls fit in ten stops. A step per button is a tour people abandon.
 *
 * It is also a set of CLAIMS about the page, and the page moves faster than
 * this file: it sat at six steps while the cockpit gained groups, rooms, the
 * Skill Factory, webhooks, a composer with three buttons, accounts and a
 * settings menu — none of which a first-time visitor was shown. So when a
 * landmark is added to the page, it is added to a step here (or gets its own),
 * in the same change. `test/tour-steps.test.ts` holds the list of what must be
 * named; it cannot notice a landmark nobody told it about.
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
    id: "groups",
    title: "Groups sort the work",
    // Says "can also be a wall" rather than listing private/restricted as
    // things to click: a single-tenant instance (the `npx` default) refuses to
    // create either, and a tour promising a control that answers "not here" is
    // the copy twin of a spotlight on empty space.
    body:
      "Agents are filed into groups — one per project, team or subject. Pick a group to " +
      "narrow the list to it. On a cockpit set up for several people a group can also be a " +
      "wall: restricted to a team or private to you, with its own secrets, and agents that " +
      "run apart from everyone else's.",
    // The rail is hidden when there is nothing to show in it, and a phone lists
    // the groups inside the closed agents sheet — both drop this step honestly.
    target: "#groupRail",
  },
  {
    id: "agents",
    title: "Your agents live here",
    body:
      "Every agent gets its own git worktree and branch, so several never collide. " +
      "Pick one here to follow it, and “＋ New agent” starts another. One of them is this " +
      "cockpit's home agent: the only one that cannot be closed. A room is the exception: " +
      "a conversation between people, with no agent behind it and no quota spent.",
    // The column on desktop, the agents-picker button on a phone — never both at
    // once. The phone's `#chanPicker` opens the SAME column as a bottom sheet, so
    // "＋ New agent" and Tweak are reachable there too now — but the spotlight
    // lands on the CLOSED button, whose contents aren't on screen yet. So this
    // body still says neither "at the top" nor "at the bottom" and still doesn't
    // point at "Tweak Shadok-AI": naming a control the reader cannot see at the
    // moment of the spotlight is the same failure as a spotlight on empty space.
    target: ["#tabbar", "#chanPicker"],
  },
  {
    id: "bar",
    title: "Look inside an agent",
    // A list of functions, not of icons in a row — see the toolbar step for
    // what "left to right" cost. Schedule and webhooks sit inside this frame
    // too and are deliberately NOT described here: they get their own stop.
    body:
      "The bar above the conversation is about the agent on screen. The gallery gathers " +
      "every photo and video exchanged with it, “About” lists the skills it uses and its " +
      "schedules, and the terminal shows the raw Claude Code screen — for the rare moment " +
      "the chat is not enough.",
    target: ["#chanGallery", "#chanCron", "#chanWebhooks", "#chanInfo", "#chanTerm"],
  },
  {
    id: "tab",
    title: "Each agent has its own menu",
    body:
      "This ⋯ holds an agent's controls: mute, reload, rename, change its profile, its model " +
      "or how hard it thinks, read its token stats, mirror it to a Telegram topic, or have " +
      "it report to another agent when it finishes. " +
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
    // It said "in that same ⋯ menu" and pointed at the menu, which stayed true
    // (the entries are still there) while the bar grew a button for each — so
    // the tour described a detour past the control in plain sight. It frames
    // the two buttons now, and the menu remains the fallback target for a
    // layout that would not render them.
    body:
      "A schedule pairs a recurring prompt with a shell check that runs without the model. " +
      "Silent check → nothing happened, the agent stays asleep at zero tokens. Otherwise it " +
      "wakes up holding the finding, and tells you here or on Telegram. A webhook is the " +
      "same idea from outside: an HTTP call from another system wakes the agent.",
    target: ["#chanCron", "#chanWebhooks"],
  },
  {
    id: "composer",
    title: "Talk to it — with more than text",
    body:
      "Write to the agent here. Attach a file, or paste or drop one in; add one of its " +
      "skills to the prompt; or dictate instead of typing. It works the other way too: " +
      "when an agent's result is a file, it arrives in the conversation as a download.",
    target: "#composer",
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
      "agents have already resolved, the Skill Factory where skills are written, released " +
      "and shared, and profiles (role, guardrails, model). Telegram and the notification " +
      "sound live under the ⋯ — which also holds the diff of an agent's work, the whole " +
      "instance's stats, light or dark mode, the palette, and this tour. On a narrow screen " +
      "the rest fold in there too.",
    // NOT `.hdr-tools`, which is `display: contents` on desktop and therefore
    // generates no box at all — its rect is all zeros, so the step would have
    // been dropped as "not visible" on the very layout where the toolbar is
    // most obvious. Framing the buttons themselves works on both layouts.
    //
    // Every tool is listed, including the ones `reflowHeaderTools` parks inside
    // the closed ⋯ menu — the width-driven ones on a phone, and `#telegramBtn` /
    // `#muteNotif` at every width: those measure {0,0,0,0} and `unionRect` drops
    // them, so the group frames exactly what is on screen. Listing only some of
    // them was the older bug in the other direction — `#usersBtn` sits left of
    // `#secretsBtn` and stayed outside the spotlight.
    target: [
      "#usersBtn",
      "#secretsBtn",
      "#ledgerBtn",
      "#factoryBtn",
      "#profilesBtn",
      "#securityBtn",
      "#reportsBtn",
      "#telegramBtn",
      "#muteNotif",
      "#moreBtn",
      "#starBtn",
    ],
  },
  {
    id: "people",
    title: "People, not only agents",
    // Its own step BECAUSE it is conditional: all three buttons start `hidden`
    // and which ones show depends on the role (`loadMe`). Folded into the
    // toolbar body they would be named to people who do not have them. Here the
    // step is dropped when none is rendered — the tour's one rule — and the
    // body says "depends on your role" for the partial case.
    //
    // It does NOT say "this instance has accounts": the lone admin of a
    // no-password instance sees all three, and has none.
    body:
      "A few buttons are about people rather than agents — which ones you see depends on " +
      "your role. Users is where people are invited and where you add a passkey for " +
      "two-factor sign-in, Reports is where a stuck agent asks an admin for help, and " +
      "Security shows what happened to your own account.",
    target: ["#securityBtn", "#reportsBtn", "#usersBtn"],
  },
  {
    id: "quota",
    title: "Watch your quota",
    body:
      "Your 5h and 7d subscription usage. Each bar fills with what you've spent, and the " +
      "white marker is the pace that would spend the window exactly on time — a fill past " +
      "the marker means you're burning faster. Past the pace, a new prompt is held back " +
      "unless you choose to send it anyway.",
    target: ["#quota5h", "#quota7d"],
  },
  {
    id: "settings",
    title: "The cockpit's own settings",
    // Was one trailing sentence of the quota step ("to the left… the version
    // beside it"), i.e. a position, on a control the spotlight was not on. The
    // menu behind the version has since become where an instance is configured,
    // which a clause could no longer carry.
    body:
      "The name tells this cockpit apart when you run several; an admin can change it. The " +
      "version opens this instance's settings, most of them an admin's: the Claude account " +
      "and when its sign-in expires, updates and their channel, the permission mode and " +
      "default model for new agents, and the instance context every agent here receives.",
    target: ["#brandName", "#verView", "#verChan"],
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
 *
 * BESIDE when neither fits, which is every full-height column. Flipping above
 * a target that starts near the top has nowhere to go, so the clamp dropped
 * the bubble ON the column it was describing: the groups step hid the very
 * group names it was pointing at, under a card explaining what groups are.
 * Clamped is "on screen", not "out of the way" — only a side placement is
 * both. When no side has room either (a phone), the old clamp still applies:
 * covering part of the target beats leaving the viewport.
 */
export function bubblePlacement({ target, bubble, viewport, gap = 12 }) {
  const below = target.top + target.height + gap;
  const fitsBelow = below + bubble.height + gap <= viewport.height;
  const above = target.top - bubble.height - gap;
  if (!fitsBelow && above < gap) {
    const right = target.left + target.width + gap;
    const left = target.left - bubble.width - gap;
    const beside =
      right + bubble.width + gap <= viewport.width ? right : left >= gap ? left : null;
    if (beside !== null) {
      return {
        side: beside === right ? "right" : "left",
        top: clamp(target.top, gap, viewport.height - bubble.height - gap),
        left: beside,
      };
    }
  }
  const side = fitsBelow ? "below" : "above";
  const rawTop = fitsBelow ? below : above;
  const rawLeft = target.left + target.width / 2 - bubble.width / 2;
  return {
    side,
    top: clamp(rawTop, gap, viewport.height - bubble.height - gap),
    left: clamp(rawLeft, gap, viewport.width - bubble.width - gap),
  };
}
