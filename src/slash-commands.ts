import fs from "node:fs";
import path from "node:path";
import { parseSkillMeta } from "./preprompt.js";

/**
 * The `/` commands an agent can run, for the composer's autocomplete.
 *
 * Claude Code has no command that lists them, so they are read from where it
 * reads them: skills (`<dir>/.claude/skills/<name>/SKILL.md`) and commands
 * (`<dir>/.claude/commands/<name>.md`), in the home directory and in the
 * agent's own directory, plus the factory skills attached to it, which run as a
 * plugin and are therefore called `<name>:<name>`. Built-ins are a short,
 * hand-picked list: the ones that make sense from a chat.
 */
export interface SlashCommand {
  name: string; // without the leading slash
  description: string;
  source: "built-in" | "skill" | "command" | "factory";
}

export const BUILT_IN_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Summarise the conversation to free up context", source: "built-in" },
  { name: "clear", description: "Start the conversation over (history is cleared)", source: "built-in" },
  { name: "context", description: "Show what fills the context window", source: "built-in" },
  { name: "cost", description: "Show what this session has used", source: "built-in" },
  { name: "review", description: "Review a pull request", source: "built-in" },
];

/** Reads one `.claude` directory. Unreadable entries are skipped, never thrown. */
export function readClaudeDir(dir: string): SlashCommand[] {
  const out: SlashCommand[] = [];
  const skills = path.join(dir, "skills");
  for (const name of safeList(skills)) {
    const md = safeRead(path.join(skills, name, "SKILL.md"));
    if (md === null) continue;
    const meta = parseSkillMeta(md);
    out.push({ name: meta.name || name, description: meta.description ?? "", source: "skill" });
  }
  const commands = path.join(dir, "commands");
  for (const file of safeList(commands)) {
    if (!file.endsWith(".md")) continue;
    const md = safeRead(path.join(commands, file)) ?? "";
    out.push({ name: file.slice(0, -3), description: parseSkillMeta(md).description ?? firstLine(md), source: "command" });
  }
  return out;
}

/** Pure: merge the sources, first one wins on a name, sorted by name. */
export function mergeCommands(...lists: SlashCommand[][]): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();
  for (const list of lists) for (const c of list) if (c.name && !seen.has(c.name)) seen.set(c.name, c);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listCommands(opts: { home: string; cwd?: string | null; factory: { name: string; description: string }[] }): SlashCommand[] {
  const factory = opts.factory.map((f) => ({ name: `${f.name}:${f.name}`, description: f.description, source: "factory" as const }));
  const project = opts.cwd ? readClaudeDir(path.join(opts.cwd, ".claude")) : [];
  return mergeCommands(factory, project, readClaudeDir(path.join(opts.home, ".claude")), BUILT_IN_COMMANDS);
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function safeRead(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}
function firstLine(md: string): string {
  return md.replace(/^---[\s\S]*?---/, "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? "";
}
