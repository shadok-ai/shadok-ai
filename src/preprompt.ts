/**
 * What shadok itself adds to an agent's context, as labelled sections.
 *
 * Everything here is passed to `claude` at spawn — appended system prompts,
 * guardrails, the permission mode — and until now it was invisible: the agent
 * knew its role, the person reading the chat did not, and a surprising answer
 * had no explanation on screen.
 *
 * IT TAKES SECRET NAMES, NEVER VALUES. Values live in the child's environment
 * and never in its arguments; keeping them out of this function's signature
 * means they cannot leak through the panel by mistake, which is stronger than
 * a test that says they currently don't.
 *
 * This is shadok's half only. Claude Code adds its own context — CLAUDE.md,
 * skills, its built-in instructions — which shadok never sees, and the panel
 * says so rather than implying it shows everything.
 */

export interface PrepromptPart {
  /** Heading for the section. */
  label: string;
  /** Where it comes from, so a reader knows where to go and change it. */
  source: string;
  text: string;
}

export interface PrepromptInput {
  profileName?: string | null;
  /** The profile's role prompt, as resolved at spawn. */
  role?: string;
  model?: string;
  deny?: string[];
  allow?: string[];
  permissionMode?: string;
  /** NAMES of the variables injected — never their values. */
  secretNames?: string[];
  /** The cockpit's own prompt (context/pilot-prompt.md). */
  pilotPrompt?: string;
  /** The opt-in ledger reflex, when the instance has it on. */
  ledgerReflex?: string | null;
  /** The skills shadok installs, as read from disk at spawn. */
  capabilities?: { name: string; description: string }[];
  /** Skill Factory releases this AGENT runs (`--plugin-dir`), as resolved at spawn. */
  factorySkills?: { name: string; release: number; tree: string }[];
}

const bullets = (items: string[]): string => items.map((i) => `• ${i}`).join("\n");

/** Pure: the sections to show, in reading order, skipping what is absent. */
export function prepromptParts(input: PrepromptInput): PrepromptPart[] {
  const parts: PrepromptPart[] = [];

  if (input.role?.trim()) {
    parts.push({
      label: input.profileName ? `Role — ${input.profileName}` : "Role",
      source: "Profiles panel",
      text: input.role.trim(),
    });
  }

  const rails: string[] = [];
  if (input.model) rails.push(`model: ${input.model}`);
  if (input.deny?.length) rails.push(`denied: ${input.deny.join(", ")}`);
  if (input.allow?.length) rails.push(`allowed: ${input.allow.join(", ")}`);
  // The mode is the instance's, not the profile's, but it lands in the same
  // spawn and shapes the same thing: what this agent may do unattended.
  if (input.permissionMode) rails.push(`permission mode: ${input.permissionMode}`);
  if (rails.length) {
    parts.push({ label: "Guardrails", source: "Profiles panel · version badge", text: bullets(rails) });
  }

  if (input.secretNames?.length) {
    parts.push({
      label: "Injected variables",
      source: "Secret vault",
      // Names only — the values are in the environment, never here.
      text: bullets(input.secretNames) + "\n\nNames only; the values are never shown.",
    });
  }

  if (input.capabilities?.length) {
    parts.push({
      label: "Capabilities installed",
      source: "seeded to ~/.claude/skills",
      // Descriptions only, and the note says why: Claude Code loads a skill's
      // DESCRIPTION into context and reads its body only when it decides to use
      // it. Pasting five whole skills here would be both wrong and unreadable.
      text:
        bullets(input.capabilities.map((c) => `${c.name} — ${c.description}`)) +
        "\n\nOnly these descriptions are in context; each body is read on demand." +
        "\nInstalled for the whole machine, not this agent, and refreshed at every boot.",
    });
  }

  // Per agent, unlike the capabilities above. Part of the fingerprint on
  // purpose: attaching, updating or losing a release must light the reload
  // indicator, because a running process cannot gain or drop a plugin.
  if (input.factorySkills?.length) {
    parts.push({
      label: "Factory skills",
      source: "Skills panel",
      text:
        bullets(input.factorySkills.map((k) => `${k.name}:${k.name} — v${k.release} (${k.tree.slice(0, 8)})`)) +
        "\n\nLoaded with --plugin-dir for this agent only.",
    });
  }

  if (input.pilotPrompt?.trim()) {
    parts.push({
      label: "Cockpit context",
      source: "context/pilot-prompt.md",
      text: input.pilotPrompt.trim(),
    });
  }

  if (input.ledgerReflex?.trim()) {
    parts.push({ label: "Ledger reflex", source: "shared ledger", text: input.ledgerReflex.trim() });
  }

  return parts;
}

/**
 * Pure: a stable fingerprint of a preprompt, so two of them can be compared
 * cheaply and stored as one short string. Order-sensitive on purpose — a
 * reordering IS a change the agent would see. Not cryptographic; it only needs
 * to differ whenever any section's label/source/text differs.
 */
export function prepromptFingerprint(parts: PrepromptPart[]): string {
  let h = 5381;
  const s = parts.map((p) => `${p.label}\u0000${p.source}\u0000${p.text}`).join("\u0001");
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** One reason a running agent is behind what a fresh spawn would give it. */
export interface StaleReason {
  kind: "preprompt" | "auth" | "claude";
  label: string;
}

/** Marker stored for an agent adopted with no recorded fingerprint — it
 *  predates the fingerprinting, so it is treated as stale until reloaded. */
export const LEGACY_FINGERPRINT = "legacy";

export interface StalenessInput {
  /** The fingerprint recorded at the agent's last REAL spawn, or null when none
   *  was ever recorded (a brand-new agent before its first record). */
  spawnFp: string | null;
  /** The fingerprint a spawn right now would produce. */
  currentFp: string;
  /** Is a GUI password set? Only then is an auth cookie injected (invariant 33),
   *  so only then can it go stale. */
  hasPassword: boolean;
  /** When the agent was last really spawned (ms), or null when unknown. */
  spawnedAt: number | null;
  now: number;
  /** The injected cookie's lifetime; past it, calls to the own server 401. */
  authTtlMs: number;
  spawnClaudeVersion: string | null;
  currentClaudeVersion: string | null;
}

/**
 * Pure: why a running agent should be reloaded — empty when it is up to date.
 *
 * Version-INDEPENDENT by design (the fingerprint is content, not a number): a
 * shadok release that doesn't touch the prompt/guardrails/skills raises nothing,
 * and a profile edit that bumps no version still does. This is the detection the
 * cockpit's reload indicator reads.
 */
export function stalenessReasons(i: StalenessInput): StaleReason[] {
  const out: StaleReason[] = [];
  if (i.spawnFp !== null && i.spawnFp !== i.currentFp) {
    out.push({
      kind: "preprompt",
      label:
        i.spawnFp === LEGACY_FINGERPRINT
          ? "started before this cockpit version — reload to refresh its prompt, guardrails and skills"
          : "prompt, guardrails, skills or secrets changed since this agent started",
    });
  }
  if (i.hasPassword && i.spawnedAt !== null && i.now - i.spawnedAt > i.authTtlMs) {
    out.push({
      kind: "auth",
      label: "auth token past its one-week validity — reload to refresh it (invariant 33)",
    });
  }
  if (
    i.spawnClaudeVersion &&
    i.currentClaudeVersion &&
    i.spawnClaudeVersion !== i.currentClaudeVersion
  ) {
    out.push({
      kind: "claude",
      label: `Claude Code updated (${i.spawnClaudeVersion} → ${i.currentClaudeVersion}) — reload onto the new binary`,
    });
  }
  return out;
}

/**
 * Pure: a skill's name and one-line description, from its SKILL.md frontmatter.
 *
 * Tolerant on purpose — a skill whose header we cannot read is still installed,
 * and listing it without its description beats omitting a capability the agent
 * actually has.
 */
export function parseSkillMeta(md: string): { name?: string; description?: string } {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return {};
  const field = (k: string) => {
    const m = fm[1].match(new RegExp("^" + k + ":\\s*(.+)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: field("name"), description: field("description") };
}
