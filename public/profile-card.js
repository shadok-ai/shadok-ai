// Labels derived from a Profile for the "New agent" box's cards — see
// docs/superpowers/specs/2026-07-29-agent-creation-box-design.md.
//
// Loaded as is by the browser (ESM) and imported by the node/tsx tests, like
// public/live-text.js.
//
// Nothing is added to the Profile type: everything is derived from what is
// already there (systemPrompt, deny, model, secrets), so profiles already
// stored display with no migration and no form to fill in again.

/** Beyond this the card would turn into a wall of text: truncate. */
const MAX_BLURB = 90;

/**
 * A one-line pitch taken from the systemPrompt: its first sentence, without the
 * "You are <name>," opener — redundant with the card's title — and truncated on
 * a word boundary. "" when the profile has no prompt.
 */
export function profileBlurb(profile) {
  const raw = ((profile && profile.systemPrompt) || "").trim();
  if (!raw) return "";
  // First sentence: the first "." followed by a space or by the end.
  const m = raw.match(/^[\s\S]*?\.(?=\s|$)/);
  let s = (m ? m[0] : raw).trim();
  // The name can contain a hyphen (Shadok-dev): we only cut on "," or an em
  // dash, never on the name's own hyphen.
  s = s.replace(/^you are\s+[^,—]{1,40}?\s*[,—]\s*/i, "");
  if (s.length <= MAX_BLURB) return s;
  const cut = s.slice(0, MAX_BLURB);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[.,;:]$/, "") + "…";
}

/**
 * The profile's guardrails as short badges: git access (the only one that
 * really matters when choosing), forced model, number of injected secrets.
 */
export function profileBadges(profile) {
  const p = profile || {};
  const readonly = !!(p.deny && p.deny.length);
  const out = [
    readonly
      ? {
          label: "read-only",
          icon: "🔒",
          title:
            "Git writes blocked (commit / push / merge…). This profile reads and diagnoses, it does not change the code.",
        }
      : {
          label: "full access",
          icon: "✏️",
          title: "Can change and commit the code — no permission guardrail on this profile.",
        },
  ];
  if (p.model)
    out.push({ label: p.model, icon: "", title: "Model forced for this profile's sessions." });
  const n = (p.secrets || []).length;
  if (n)
    out.push({
      label: n + " secret" + (n > 1 ? "s" : ""),
      icon: "🔑",
      title: "Vault secret(s) injected as environment variables when the agent starts.",
    });
  return out;
}

/**
 * The name proposed for a new agent: its PROFILE's, because that is what tells
 * two agents launched on the same repo apart — the directory is the same for
 * all of them and produced whole columns of identically named tabs. With no
 * profile we fall back to the directory's name; as a last resort "agent", never
 * an empty string (an unnamed tab is unreadable).
 */
export function defaultAgentName(profileName, cwd) {
  const p = String(profileName ?? "").trim();
  if (p) return p;
  const dir = String(cwd ?? "").trim().replace(/[/\\]+$/, "");
  const base = dir.split(/[/\\]/).pop() || "";
  return base || "agent";
}

/**
 * Does the profile form's "read-only" checkbox reflect a genuinely read-only
 * profile? True only when the WHOLE preset is present: a half-applied preset
 * must not pretend to be in place.
 *
 * Deliberately stricter than the card's badge, which answers a different
 * question — "does this profile have guardrails?" — and lights up as soon as a
 * `deny` exists, custom or not.
 */
export function hasReadonlyPreset(deny, preset) {
  const have = new Set(deny || []);
  return (preset || []).length > 0 && preset.every((p) => have.has(p));
}

/**
 * Tick/untick the preset WITHOUT touching custom patterns: unticking removes
 * the preset's patterns and leaves the rest, ticking appends the missing ones.
 * The textarea stays the source of truth — it is never overwritten wholesale,
 * which is what the old handler did.
 */
export function applyReadonlyPreset(deny, on, preset) {
  const list = [...(deny || [])];
  const p = preset || [];
  if (!on) return list.filter((x) => !p.includes(x));
  const have = new Set(list);
  for (const x of p) if (!have.has(x)) list.push(x);
  return list;
}

/**
 * Roles driven by the SERVER, which have no business in a list where one PICKS a
 * profile. `Shadok-Tweak` takes its prompt from `context/tweak-prompt.md` at
 * every boot and has its own CTA: offering it as an ordinary role promises a
 * customisation the next restart will erase.
 */
export const MANAGED_PROFILES = ["Shadok-Tweak"];

export function isManagedProfile(name) {
  return MANAGED_PROFILES.includes(String(name ?? "").trim());
}

/**
 * What the Profiles panel must PUT when saving.
 *
 * A tracked role stores no prompt: the build resolves it at spawn, so every
 * later improvement reaches it. The panel still shows the text — you want to
 * read the role you are about to run — but showing it must not persist it:
 * sending `systemPrompt` back would pin today's wording and stop the tracking,
 * and sending an EMPTY field would leave the agent with no role at all. That is
 * how four starter prompts turned into empty strings.
 *
 * So the key is omitted unless the user deliberately forked the text. The server
 * already distinguishes an absent key (keep tracking) from a string (own it).
 */
export function profileSaveBody(form, state) {
  const body = {
    name: form.name,
    deny: form.deny ?? [],
    model: form.model ?? "",
    secrets: form.secrets ?? [],
  };
  if (!state.tracked || state.forked) body.systemPrompt = form.prompt ?? "";
  return body;
}

/**
 * Les profils qui injectent ce secret, triés par nom.
 *
 * Un secret ne sert à rien tant qu'aucun profil ne le référence — le panneau le
 * disait déjà, mais sans dire À QUI il sert quand il sert, ce qui obligeait à
 * ouvrir les profils un par un pour le savoir.
 *
 * Compte AUSSI les rôles que le panneau des profils masque (Shadok-Tweak) : ils
 * reçoivent bel et bien le secret, et les annoncer « inutilisés » serait faux.
 */
export function secretUsers(profiles, name) {
  return (Array.isArray(profiles) ? profiles : [])
    .filter((p) => p && typeof p.name === "string" && (p.secrets || []).includes(name))
    .map((p) => p.name)
    .sort();
}
