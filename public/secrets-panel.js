// Display decisions of the secret vault panel — pure, no DOM, no fetch.
//
// Loaded as is by the browser (ESM, bridged to window) and imported by the
// node/tsx tests, like public/profile-card.js.
//
// The SERVER decides who sees what (`GET /secrets` tags each name `own` /
// `shared` / `main`); this only decides how to lay that answer out. It never
// filters for security — a client-side filter would protect nothing.

const MAIN_ID = "main";

/** The synthetic selector value standing for ALL public non-Main groups at once:
 *  public = visible to everyone, so the panel shows them as ONE "Public groups"
 *  entry rather than listing each (operator decision 2026-11-03). */
export const PUBLIC_BUCKET = "__public__";

/** Public non-Main group ids (Main is the commons, surfaced on its own). */
function publicGroupIds(groups) {
  return (Array.isArray(groups) ? groups : [])
    .filter((g) => g && g.id != null && String(g.id) !== MAIN_ID && g.nature === "public")
    .map((g) => String(g.id));
}

/**
 * The group entries the panel's selector offers: each NON-public group
 * (restricted/private — a real per-group vault) individually, plus ONE
 * "Public groups" entry when any public non-Main group exists. Main is not an
 * entry — its secrets are the "Inherited from Main" section shown under every
 * view. Returns `{ value, label }[]`.
 */
export function panelGroupOptions(groups) {
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || g.id == null) continue;
    const id = String(g.id);
    if (id === MAIN_ID || g.nature === "public") continue; // public → the bucket; main → the commons
    // A private group is the owner's sealed "Personal" space — label it that way
    // (as the rail does), never its raw name, which otherwise collides with a
    // same-named restricted group and makes the private one unselectable.
    out.push({ value: id, label: g.nature === "private" ? "Personal" : g.name });
  }
  if (publicGroupIds(groups).length) out.push({ value: PUBLIC_BUCKET, label: "Public groups" });
  return out;
}

/** The concrete group a WRITE under "Public groups" lands in: the first public
 *  non-Main group (deterministic). They are all visible-to-all, so which one
 *  physically holds the value does not matter to any reader. Null when none. */
export function publicWriteTarget(groups) {
  return publicGroupIds(groups)[0] ?? null;
}

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
export function secretSections(secrets, selectedGroupId, groups) {
  const out = { own: [], sharedIn: [], inheritedMain: [] };
  if (!Array.isArray(secrets)) return out;
  const pubIds = new Set(publicGroupIds(groups));
  for (const s of secrets) {
    if (!s || typeof s.name !== "string") continue;
    if (s.source === "own") {
      const owner = String(s.ownerGroup);
      // The "Public groups" view aggregates every public group's own secrets;
      // a concrete group view scopes to that id; null shows all own secrets.
      const inBucket = selectedGroupId === PUBLIC_BUCKET && pubIds.has(owner);
      const inGroup =
        selectedGroupId != null && selectedGroupId !== PUBLIC_BUCKET && owner === String(selectedGroupId);
      if (selectedGroupId == null || inBucket || inGroup) out.own.push(s);
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

/** Groups a secret can be lent to: not its owner, and nothing already in the
 *  commons — not Main, and not a PUBLIC group. A public non-Main group is
 *  "public = commun" (operator decision 2026-11-03): every agent already
 *  resolves its tier, so offering to share a secret WITH it is as meaningless as
 *  offering Main. Only restricted/private groups are real sealed vaults to lend
 *  to. (Server-side resolution is unchanged; this is the UI's offer only.) */
export function shareTargets(groups, ownerGroupId) {
  return (Array.isArray(groups) ? groups : []).filter(
    (g) =>
      g && g.id != null && String(g.id) !== MAIN_ID && String(g.id) !== String(ownerGroupId) && g.nature !== "public",
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
