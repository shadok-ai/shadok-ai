/**
 * Where the shadok skills' own scripts actually live, and the one rewrite that
 * keeps the shipped instructions pointing at them.
 *
 * Every shipped skill doc, the ledger reflex and the pilot prompt invoke their
 * scripts by the HOME-tier path `~/.claude/skills/<skill>/x.mjs`. That is right
 * mono-tenant — skills are seeded into the running user's own HOME. In
 * multi-tenant a privilege-dropped agent (`main`, or a private group's `sk-*`,
 * HOME `/home/<user>`) has NO skills under its HOME: they are installed ONCE in
 * the machine-wide Enterprise tier (`/etc/claude-code/.claude/skills`, read by
 * every OS user — see `seedSystemSkills`). The agent's Skill tool finds the skill
 * there, but the moment it follows the literal `~/.claude/skills/...` command it
 * hits a path that does not exist, and the script silently fails to run.
 *
 * So the base the docs/prompts name must be rewritten to where the skills were
 * actually installed for THIS instance. Pure and tiny so it is unit-testable;
 * the mode→base decision and the wiring live in `server.ts`.
 *
 * The other half of the rule is on the SHIPPED side, and it cannot be fixed
 * here: a command written `node scripts/x.mjs` names no base at all, so there
 * is nothing to rewrite — and the skill's directory is not the agent's cwd, so
 * the agent has to invent an absolute path. It invents the conventional
 * `~/.claude/skills/...`, which exists for the server user and for every
 * mono-tenant install, and NOT in a dropped group agent's HOME. Measured: a
 * group agent ran `node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs
 * list` and got a bare MODULE_NOT_FOUND, with nothing in it naming the tier it
 * should have read. Every shipped skill therefore spells the full
 * `~/.claude/skills/<skill>/...` path, and `test/skill-paths.test.ts` refuses
 * the next relative one.
 */

/** The literal base the shipped skill docs and prompts are written with. */
export const HOME_SKILLS_BASE = "~/.claude/skills";

/**
 * Retarget the shipped `~/.claude/skills` script base to `base`. Identity when
 * `base` is the home tier (mono-tenant) or falsy (never blank out a path). A
 * plain literal swap: `~/.claude/skills` only ever appears as that base, and the
 * skill-name + script suffix after it is preserved verbatim.
 */
export function rewriteSkillsBase(text: string, base: string): string {
  if (!base || base === HOME_SKILLS_BASE) return text;
  return text.split(HOME_SKILLS_BASE).join(base);
}
