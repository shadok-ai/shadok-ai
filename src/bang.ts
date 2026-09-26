/**
 * Running a `!` command in an agent's pane on the HUMAN's behalf.
 *
 * Why this is its own door and not a prompt: shadok prepends a context header
 * (`⟦web · time · who⟧`) to every human prompt, so a `!` sent as a prompt is no
 * longer the first character — it reaches the MODEL as text. Measured on a
 * bench: the model then chose to run it through its own Bash tool, which means
 * a model turn, the profile's guardrails and the auto-mode classifier all stand
 * between the click and the command, and any of them may refuse or rewrite it.
 *
 * Shell mode is the opposite, and that is the second measured fact: it is NOT
 * the Bash tool, so a profile's `deny` does not apply. On a bench under
 * `Shadok-Boss`, whose profile denies `Bash(git commit:*)`, a shell-mode
 * `git commit` created the commit — and the agent's own reply was "You ran that
 * one yourself". That is exactly the escape hatch wanted (an agent asks you for
 * a `!` precisely when it cannot run the thing itself), and it is why this door
 * is for a HUMAN only, never for an agent or pilotctl.
 */

/** Longest command accepted. Shell mode takes one line; this bounds a paste. */
export const MAX_RUN_CHARS = 4000;

/**
 * Pure: why a command cannot be run, or null when it can.
 *
 * Multi-line is REFUSED, not joined: shell mode reads one line, and gluing
 * lines together would run something the human never saw written that way.
 */
export function runRefusal(command: unknown): string | null {
  if (typeof command !== "string") return "no command";
  const c = command.trim();
  if (!c) return "empty command";
  if (/[\r\n]/.test(c)) return "a shell-mode command is ONE line — multi-line commands are not run";
  if (c.length > MAX_RUN_CHARS) return `command too long (${c.length} > ${MAX_RUN_CHARS} characters)`;
  return null;
}

/**
 * Pure: is the pane in shell mode, waiting for a command?
 *
 * Read the same way `inputText` reads it: the input line is a `!` at COLUMN 0,
 * padded with a non-breaking space — `\s` matches it, a literal space would
 * not. The indented "  ! for shell mode" hint in the footer is excluded by the
 * column-0 requirement, so a hint alone never counts as the mode.
 */
export function isShellMode(screen: string): boolean {
  return String(screen ?? "")
    .split("\n")
    .some((l) => /^!\s/.test(l) || l === "!");
}

/** Most characters of a command's output kept for display. */
export const MAX_BASH_OUTPUT = 4000;

const unescape = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/**
 * Pure: a shell-mode exchange as Claude Code records it in the transcript, or
 * null for anything else.
 *
 * Two user messages, written by the TUI itself:
 *   `<bash-input>CMD</bash-input>`
 *   `<bash-stdout>OUT</bash-stdout><bash-stderr>ERR</bash-stderr>`
 *
 * `loadHistory` used to DROP both, since a user message starting with `<` is
 * taken for an injected system block — so a command run from the terminal view
 * vanished from the chat on reload, while the agent's comment on its output
 * stayed, answering a question the reader could no longer see. Reading them
 * here, in the transcript, keeps live and replay identical (content comes from
 * the transcript, never from the screen), and covers a command typed by hand in
 * the terminal as well as one sent through the cockpit's button.
 */
export function parseBashMessage(
  text: string,
): { command: string } | { output: string; isError: boolean } | null {
  const t = String(text ?? "").trim();
  const input = /^<bash-input>([\s\S]*?)<\/bash-input>$/.exec(t);
  if (input) return { command: unescape(input[1]).trim() };
  const out = /^<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?$/.exec(t);
  if (out) {
    const stdout = unescape(out[1] ?? "").trimEnd();
    const stderr = unescape(out[2] ?? "").trimEnd();
    const both = [stdout, stderr].filter(Boolean).join("\n");
    return {
      output: both.length > MAX_BASH_OUTPUT ? both.slice(0, MAX_BASH_OUTPUT) + "\n…" : both,
      // Stderr alone is not proof of failure (git prints progress there), but a
      // run with NOTHING on stdout and something on stderr reads as one.
      isError: !stdout && !!stderr,
    };
  }
  return null;
}

/** The plain text of a transcript user message, whatever its content shape. */
export function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
  return "";
}
