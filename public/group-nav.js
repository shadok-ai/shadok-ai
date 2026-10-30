/**
 * The two-column navigation: groups on the left (the "rail"), the selected
 * group's agents beside it. Pure, so the browser and test/group-nav.test.ts
 * share it.
 *
 * The rail is a VIEW over the agents column, never a second copy of the groups:
 * the order, names and membership still live in the agents column's DOM, which
 * is what `persistGroups` / `persistChannels` read. So nothing here owns state.
 */

/** Icons a new group draws from; any emoji can be typed in instead. */
export const GROUP_ICONS = [
  "📁", "🚀", "🧪", "🛠", "📦", "🎯", "🧭", "🔬", "🌱", "⚡",
  "🧩", "📊", "🔒", "🎨", "📣", "🐛", "🗂", "🛰", "🔥", "💡",
];

/** The view a group is selected under; the agents with no group have their own. */
export const UNGROUPED = "ungrouped";

/** A random icon from GROUP_ICONS. `rand` is injectable for the tests. */
export function randomGroupIcon(rand = Math.random) {
  const i = Math.floor(rand() * GROUP_ICONS.length);
  return GROUP_ICONS[Math.min(Math.max(i, 0), GROUP_ICONS.length - 1)];
}

/**
 * The view to show, from what was saved and the groups that exist now. A saved
 * group that was dissolved (here or on another device) falls back to the
 * ungrouped view rather than to an empty column.
 */
export function resolveGroupView(saved, groupIds) {
  const ids = (groupIds || []).map(String);
  return saved != null && ids.includes(String(saved)) ? String(saved) : UNGROUPED;
}

/**
 * One mood for a whole group, from its agents' moods — what the rail shows for
 * a group that is not on screen. Ordered by how much it needs you: a question
 * waiting beats an unread answer, which beats work in progress.
 */
export function groupMood(moods) {
  const set = new Set(moods || []);
  for (const m of ["needs-answer", "unread", "working"]) if (set.has(m)) return m;
  return null;
}

/**
 * A typed icon, trimmed and kept short: one emoji may be several code points
 * (a flag, a skin tone, a ZWJ family), so the cap is on graphemes when the
 * runtime can count them. Empty → null, so the caller keeps the old one.
 */
export function cleanGroupIcon(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)];
    return seg.slice(0, 2).map((x) => x.segment).join("");
  }
  return [...s].slice(0, 2).join("");
}

/**
 * Which group an agent should sit in after a /channels poll, and what this tab
 * now believes the server holds. `local` is where the tab shows it, `synced` the
 * group last agreed with the server (undefined = never agreed: a tab this page
 * just created), `server` what /channels says.
 *
 * A tab whose `local` differs from `synced` has a move of its own the server
 * has not confirmed yet — keep it, the push will land. Otherwise a different
 * `server` is a move made in ANOTHER tab or device, and this tab follows it:
 * without that, it kept the old group for ever and wrote it back on its next
 * push, which is how a dragged agent "went back" to where it was.
 */
export function reconcileTabGroup(local, synced, server) {
  const srv = server ?? null;
  if ((local ?? null) === srv) return { move: false, synced: srv };
  if (synced === undefined || (local ?? null) !== synced) return { move: false, synced };
  return { move: true, synced: srv };
}

/** Does this tab's push carry `group`? Only when it moved the agent itself —
 *  an omitted key leaves the server's value alone (mergeChannels). */
export function groupIsDirty(local, synced) {
  return synced === undefined || (local ?? null) !== synced;
}
