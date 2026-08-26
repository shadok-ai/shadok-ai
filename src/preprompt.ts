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
