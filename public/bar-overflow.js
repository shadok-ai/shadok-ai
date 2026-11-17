// Pure core of the phone header overflow: when a bar row does not fit, its
// icons go to that bar's ⋯ menu, one at a time, in a fixed order, until it fits.
// The DOM glue (measuring, moving) lives in index.html; this file only decides,
// so it is tested without a browser.

/**
 * Show every item, then hide them one by one, in `items` order, until `fits()`
 * says the row fits (or nothing is left to hide). Returns how many were hidden.
 * Starting from "all shown" every time is what makes it reversible: a wider
 * screen, a shorter agent name or a badge going away brings the icons back.
 */
export function shrinkToFit(items, { show, hide, fits }) {
  for (const it of items) show(it);
  let hidden = 0;
  for (const it of items) {
    if (fits()) break;
    hide(it);
    hidden++;
  }
  return hidden;
}

/**
 * Does a name that may ellipsize still read? It does when it is not cut at all,
 * or when it keeps at least `minPx` on screen (a long name cut after a dozen
 * letters is fine; "ca…" is not).
 */
export function nameReads({ clientWidth, scrollWidth }, minPx) {
  return scrollWidth <= clientWidth || clientWidth >= minPx;
}

/**
 * The agent bar's icons, in the order they leave the row: least used first,
 * the chat/terminal switch last. Schedule and Webhooks are already items of the
 * agent menu, so hiding them needs no extra entry (`menu: null`).
 */
export const CHAN_OVERFLOW = [
  { id: "chanWebhooks", menu: null },
  { id: "chanGallery", menu: "🖼 Media gallery" },
  { id: "chanCron", menu: null },
  { id: "chanInfo", menu: "ℹ About this agent" },
  { id: "chanTerm", menu: "⌨ Terminal", menuOn: "💬 Back to the chat" },
];

/** The agent bar's overflowable icon ids, in the order they leave the row. */
export function chanOverflowIds() {
  return CHAN_OVERFLOW.map((it) => it.id);
}

/**
 * The entries the agent menu gains for the icons hidden from the bar, in the
 * order they left it. `hidden` is the set of hidden ids, `on` the set of toggles currently
 * pressed (the terminal view).
 */
export function chanOverflowItems(hidden, on = new Set()) {
  const out = [];
  for (const it of CHAN_OVERFLOW) {
    if (!it.menu || !hidden.has(it.id)) continue;
    out.push({ id: it.id, label: on.has(it.id) && it.menuOn ? it.menuOn : it.menu });
  }
  return out;
}
