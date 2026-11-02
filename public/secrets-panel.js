// Display decisions of the secret vault panel — pure, no DOM, no fetch.
//
// Loaded as is by the browser (ESM, bridged to window) and imported by the
// node/tsx tests, like public/profile-card.js.
//
// The SERVER decides who sees what (`GET /secrets` tags each name `own` /
// `shared` / `main`); this only decides how to lay that answer out. It never
// filters for security — a client-side filter would protect nothing.

const MAIN_ID = "main";

/**
 * "flat" when only Main exists (today's look: one list, no group header, no
 * sections) — the common case, and the degradation rule. "grouped" as soon as
 * a non-Main group exists. A failed /groups fetch reads as flat: showing the
 * plain list is safe, a half-drawn group layout is not.
 */
export function secretsPanelMode(groups) {
  if (!Array.isArray(groups)) return "flat";
  return groups.some((g) => g && g.id != null && String(g.id) !== MAIN_ID) ? "grouped" : "flat";
}

/**
 * Partition the server's tagged list into the three sections. `selectedGroupId`
 * scopes the OWN section to one group (null = every own secret). Unknown or
 * malformed rows are dropped rather than guessed into a section.
 */
export function secretSections(secrets, selectedGroupId) {
  const out = { own: [], sharedIn: [], inheritedMain: [] };
  if (!Array.isArray(secrets)) return out;
  for (const s of secrets) {
    if (!s || typeof s.name !== "string") continue;
    if (s.source === "own") {
      if (selectedGroupId == null || String(s.ownerGroup) === String(selectedGroupId)) out.own.push(s);
    } else if (s.source === "shared") out.sharedIn.push(s);
    else if (s.source === "main") out.inheritedMain.push(s);
  }
  return out;
}

/**
 * The groups that get a 🔑 in the groups bar. Main is not a bar entry when
 * other groups exist (it is the commons, reached from the header button); when
 * it is all there is, it keeps its key so the entry point never vanishes.
 */
export function keyGroups(groups) {
  const list = Array.isArray(groups) ? groups.filter((g) => g && g.id != null) : [];
  const others = list.filter((g) => String(g.id) !== MAIN_ID);
  return others.length ? others : list.filter((g) => String(g.id) === MAIN_ID);
}

/** Groups a secret can be lent to: not its owner, not Main (Main is already read by all). */
export function shareTargets(groups, ownerGroupId) {
  return (Array.isArray(groups) ? groups : []).filter(
    (g) => g && g.id != null && String(g.id) !== MAIN_ID && String(g.id) !== String(ownerGroupId),
  );
}

/** "created by ada · 1 Oct 2026 · updated 2 Oct 2026" — "" when nothing is known. */
export function auditLine(s) {
  if (!s) return "";
  const date = (t) => (typeof t === "number" && t > 0 ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
  const who = typeof s.createdBy === "string" && s.createdBy
    ? s.createdBy.startsWith("agent:") ? "agent " + s.createdBy.slice(6, 14) : s.createdBy
    : "";
  const parts = [];
  if (who || date(s.createdAt)) parts.push(["created", who && "by " + who].filter(Boolean).join(" "));
  if (date(s.createdAt)) parts.push(date(s.createdAt));
  if (typeof s.updatedAt === "number" && s.updatedAt > (s.createdAt || 0) + 1000 && date(s.updatedAt)) parts.push("updated " + date(s.updatedAt));
  return parts.length > 1 || who ? parts.join(" · ") : "";
}
