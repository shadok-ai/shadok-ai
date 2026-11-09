/**
 * The `/` commands the composer's autocomplete offers: the Skill Factory skills
 * the agent has (shared with it), and nothing else. They run as a plugin, so each is
 * called `<name>:<name>`. The machine's own skills, `.claude/commands` and the
 * built-ins still work when typed; they are left out of the menu so it shows
 * the skills shadok manages and does not drown them.
 */
export interface SlashCommand {
  name: string; // without the leading slash
  description: string;
}

/** Pure: the attached factory skills as commands, sorted by name. */
export function listCommands(factory: { name: string; description: string }[]): SlashCommand[] {
  return factory
    .map((f) => ({ name: `${f.name}:${f.name}`, description: f.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
