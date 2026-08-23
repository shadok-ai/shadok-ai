// Best-effort extraction of the in-flight assistant text block from the TUI
// screen (@xterm/headless) — see
// docs/superpowers/specs/2026-07-28-live-text-preview-design.md.
//
// Loaded as is by the browser (ESM) and imported by the node/tsx tests. The
// .jsonl transcript only writes a text block once FINISHED; the screen shows it
// as it is typed → the only token-granular source.
//
// An assistant text block = a "⏺ <prose>" line (U+23FA + space) at column 0,
// followed by continuations indented by 2 spaces. A tool_use renders as
// "⏺ Name(args)"; a tool result renders as "  ⎿ …".

const MARKER = "⏺ "; // "⏺ "

/** The last visible assistant text block, unwrapped; "" otherwise. */
export function extractLiveText(screen) {
  if (typeof screen !== "string" || !screen) return "";
  const lines = screen.split("\n");

  // Find the last "⏺ " block marker at column 0.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(MARKER)) { start = i; break; }
  }
  if (start < 0) return "";

  const head = lines[start].slice(MARKER.length).trim();
  // Exclude TOOL lines (not assistant text):
  //  - tool_use    : "⏺ Name(...)" — an identifier glued to a parenthesis;
  //  - running tool: "⏺ Running 1 shell command" / "⏺ Ran 1 shell command".
  // Without this, the tool line showed up as a text preview.
  if (/^[\w.-]+\(/.test(head) || /^(Running|Ran)\b/i.test(head)) return "";

  const parts = [head];
  const isToolLine = (t) => t.startsWith("⎿") || /^(Ran|Running)\b/.test(t);
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      // Blank line: a paragraph break WITHIN the block, or the end of it. We
      // keep the block open only when the next non-empty line is still an
      // indented continuation (not a tool summary nor the input box). Without
      // this, a long multi-paragraph text was truncated at its 1st paragraph:
      // the preview froze on the beginning and all the rest appeared only when
      // the block was finalised (the "weird streaming / you only see it at the
      // end").
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && lines[j].startsWith("  ") && !isToolLine(lines[j].trim())) continue;
      break;
    }
    if (!l.startsWith("  ")) break; // unindented → the end (spinner, box, next block)
    const t = l.trim();
    if (isToolLine(t)) break; // a tool's sub-line
    parts.push(t);
  }
  return parts.join(" ");
}
