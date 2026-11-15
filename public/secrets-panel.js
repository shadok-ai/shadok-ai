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
 * "Public groups" entry — ALWAYS, since Main itself is public: it holds Main's
 * secrets (editable by whoever may write Main) and every other public group's.
 * Returns `{ value, label }[]`.
 */
export function panelGroupOptions(groups) {
  // Order: Public (all public groups, Main included, are one), Personal, then
  // each restricted group — the same order as a connected account's chips.
  if (!Array.isArray(groups) || !groups.length) return [];
  const personal = [];
  const restricted = [];
  for (const g of groups) {
    if (!g || g.id == null) continue;
    const id = String(g.id);
    if (id === MAIN_ID || g.nature === "public") continue; // public → the bucket; main → the commons
    // A private group is the owner's sealed "Personal" space — label it that way
    // (as the rail does), never its raw name, which otherwise collides with a
    // same-named restricted group and makes the private one unselectable.
    if (g.nature === "private") personal.push({ value: id, label: "Personal" });
    else restricted.push({ value: id, label: g.name });
  }
  return [{ value: PUBLIC_BUCKET, label: "Public" }, ...personal, ...restricted];
}

/** The concrete group a WRITE under "Public groups" lands in: the first public
 *  non-Main group (deterministic), else Main. They are all visible-to-all, so
 *  which one physically holds the value does not matter to any reader. */
export function publicWriteTarget(groups) {
  return publicGroupIds(groups)[0] ?? MAIN_ID;
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
    else if (s.source === "main") {
      // In "Public groups", a Main secret the caller may write is one of its
      // own (Main is public); everywhere else it is the inherited tier.
      if (selectedGroupId === PUBLIC_BUCKET && s.editable === true) out.own.push(s);
      else out.inheritedMain.push(s);
    }
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
  const list = Array.isArray(groups) ? groups : [];
  // A secret OWNED by the commons (Main, or a public group) already resolves for
  // every agent: lending it anywhere is meaningless, so nothing is offered.
  const owner = list.find((g) => g && String(g.id) === String(ownerGroupId));
  if (String(ownerGroupId) === MAIN_ID || (owner && owner.nature === "public")) return [];
  return list.filter(
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

/** The vault's "every profile" wildcard (`ANY_PROFILE`, src/secrets.ts). */
export const ANY_PROFILE = "*";

/**
 * The set a chip row holds after ONE click, from the set the server last
 * confirmed. Returned sorted and deduplicated, so two clicks that end on the
 * same selection produce the same body.
 *
 * `exclusive` names an option that cannot coexist with the others — the
 * profiles row passes `ANY_PROFILE`: "this secret goes to every agent" and "it
 * goes to these two profiles" are different statements, and a row showing both
 * would be lying about one of them. Ticking it clears the rest; ticking a named
 * one clears it.
 *
 * It takes the CONFIRMED set rather than reading the checkboxes because the
 * card writes as it is ticked: the body must say what the click meant, not what
 * the DOM happens to show while a previous write is still in flight.
 */
export function secretChipPick(current, key, on, exclusive = null) {
  const k = String(key ?? "");
  const kept = [...new Set((Array.isArray(current) ? current : []).map(String))].filter((v) => v !== k);
  if (!on) return kept.sort();
  if (exclusive != null && k === String(exclusive)) return [k];
  return [...(exclusive != null ? kept.filter((v) => v !== String(exclusive)) : kept), k].sort();
}

/**
 * The profiles that RECEIVE a secret, read from BOTH ends of the link — plus
 * `any`, the `ANY_PROFILE` wildcard, which reaches an agent whatever its
 * profile (even one with none).
 *
 * The link is writable from either side and stored on the side it was written:
 * a profile's `secrets` list (`PUT /profiles`, what the flat form writes) and a
 * secret's `profiles` list (`PUT /secrets/profiles`, what the panel's chips and
 * the grouped form write). `secretsForProfile` merges both server-side at spawn,
 * so anything that asks "who receives this secret" must merge both too — asking
 * one side alone answers "nobody" for every binding made from the other, and a
 * caller that treats an empty answer as "no one to tell" then says nothing at
 * all. That is exactly how the reload offer went silent on a grouped instance.
 *
 * The vault side is only known for a secret the caller may edit (`GET /secrets`
 * sends `profiles` for an own secret, and for Main's to whoever may write Main);
 * for a shared or read-only tier the profile side is all we have. And an own
 * secret SHADOWS a Main one of the same name per group, which this union
 * ignores: a receiver list is used to OFFER a reload, where naming one agent
 * too many costs a respawn that keeps its history.
 */
export function secretReceivers(profiles, vaultSecrets, name) {
  const out = new Set();
  let any = false;
  const n = String(name ?? "");
  for (const p of Array.isArray(profiles) ? profiles : [])
    if (p && typeof p.name === "string" && (p.secrets || []).includes(n)) out.add(p.name);
  for (const s of Array.isArray(vaultSecrets) ? vaultSecrets : []) {
    if (!s || s.name !== n || !Array.isArray(s.profiles)) continue;
    for (const p of s.profiles) {
      if (String(p) === ANY_PROFILE) any = true;
      else out.add(String(p));
    }
  }
  return { profiles: [...out].sort(), any };
}

/**
 * What the "+" beside an agent's `MISSING_TOKEN` should do once the secret is
 * written: `reload` the agent that asked, `offer` it instead, `unbound` (it
 * receives nothing, so there is nothing to pick up) or `none`.
 *
 * `agent` is `{ profile, live, busy }` — null when the panel was not opened by
 * a "+", which is why a later Add never restarts a bystander.
 *
 * Order is the point. "Does it receive it?" comes first: a reload cannot help
 * an agent no binding feeds, and saying so is more use than a respawn. A turn
 * in flight is never cut short on the cockpit's own initiative — `restart`
 * kills the process (invariant 23) and no `busy` check stands in its way — so a
 * working agent falls back to the offer, where a person decides. And a dead
 * agent needs nothing: it reads the vault at its next launch.
 */
export function plusReloadPlan(agent, receivers) {
  if (!agent) return { action: "none" };
  const r = receivers || {};
  const named = Array.isArray(r.profiles) ? r.profiles : [];
  if (!r.any && !(agent.profile && named.includes(agent.profile))) return { action: "unbound" };
  if (!agent.live) return { action: "none" };
  if (agent.busy) return { action: "offer" };
  return { action: "reload" };
}
