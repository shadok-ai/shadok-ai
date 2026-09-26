// Which `!` commands an agent's message asks the human to run.
//
// Loaded as-is by the browser (ESM, bridged to window.bangCommands) and
// imported by the tests, like public/tour-steps.js. Kept pure because the
// decision it makes — "this is a command you can run with one click" — is
// the one that must never fire on prose: the button runs on the machine.

/** At most this many buttons under one message. More is a wall, not a help. */
export const MAX_BANG_PER_MESSAGE = 5;

/**
 * Pure: the `!` commands a message offers, in order, de-duplicated.
 *
 * Two shapes, both how an agent actually writes them:
 *   - inline code: `! ssh ubuntu@host 'docker exec …'`
 *   - a line of its own, usually inside a fenced block: `! claude --version`
 *
 * Deliberately NOT a bare `!` anywhere in prose ("Done!", "! important"): a
 * command is only recognised where an agent marks it as one — inline code, or a
 * line that is nothing but the command. And never across lines: shell mode
 * reads ONE line, so a multi-line block gets no button rather than a glued one.
 */
export function bangCommands(text) {
  const out = [];
  const add = (c) => {
    const cmd = String(c || "").trim();
    if (cmd && !out.includes(cmd) && out.length < MAX_BANG_PER_MESSAGE) out.push(cmd);
  };
  const src = String(text || "");
  // Inline code first: `! cmd`
  for (const m of src.matchAll(/`!\s+([^`\n]+)`/g)) add(m[1]);
  // Then whole lines: "! cmd" on its own line (fenced block or bare).
  for (const line of src.split("\n")) {
    const m = /^\s*!\s+(\S.*)$/.exec(line);
    if (m && !/^`/.test(line.trim())) add(m[1].replace(/`+$/, ""));
  }
  return out;
}
