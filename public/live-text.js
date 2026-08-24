// Best-effort extraction of the in-flight assistant text block from the TUI
// screen (@xterm/headless) — see
// docs/superpowers/specs/2026-07-28-live-text-preview-design.md.
//
// Loaded as is by the browser (ESM) and imported by the node/tsx tests. The
// .jsonl transcript only writes a text block once FINISHED; the screen shows it
// as it is typed → the only token-granular source.
//
// An assistant text block = a "<bullet> <prose>" line at column 0, followed by
// continuations indented by 2 spaces. A tool_use renders as
// "<bullet> Name(args)"; a tool result renders as "  ⎿ …".
//
// TWO bullets, and both are load-bearing: Claude Code used "⏺" (U+23FA) and
// switched to "●" (U+25CF) in 2.1. Matching only one makes `extractLiveText`
// find nothing at all — the web live preview goes dark with no error anywhere,
// on every session running that version. Support for "●" was added once,
// removed by a translation pass that also deleted its tests (so CI stayed
// green), and restored here. Do not "simplify" this back to a single marker.

const MARKERS = ["⏺ ", "● "];
const markerOf = (line) => MARKERS.find((m) => line.startsWith(m)) ?? null;

/** The last visible assistant text block, unwrapped; "" otherwise. */
export function extractLiveText(screen) {
  if (typeof screen !== "string" || !screen) return "";
  const lines = screen.split("\n");

  // Find the last block marker at column 0, whichever bullet it uses.
  let start = -1;
  let marker = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = markerOf(lines[i]);
    if (m) { start = i; marker = m; break; }
  }
  if (start < 0) return "";

  const head = lines[start].slice(marker.length).trim();
  // Exclude TOOL lines (not assistant text):
  //  - tool_use    : "⏺ Name(...)" — an identifier glued to a parenthesis;
  //  - running tool: "⏺ Running 1 shell command" / "⏺ Ran 1 shell command".
  // Without this, the tool line showed up as a text preview.
  if (/^[\w.-]+\(/.test(head) || /^(Running|Ran)\b/i.test(head)) return "";
  // Is the next non-empty line after `idx` a "⎿" (tool-result marker)? If so, the
  // line at `idx` is a running tool's STATUS ("Sleeping for 6 seconds\n  ⎿ $ sleep
  // 6"), not assistant text. Claude Code flips that status line's leading bullet
  // on and off between redraws, so read as text it made the preview oscillate
  // between the tool status and the real block above it — and glued the status
  // onto the text when the bullet was absent.
  const nextIsToolDetail = (idx) => {
    for (let k = idx + 1; k < lines.length; k++) {
      const t = lines[k].trim();
      if (t === "") continue;
      return t.startsWith("⎿");
    }
    return false;
  };
  if (nextIsToolDetail(start)) return ""; // the head itself is a tool status

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
    if (nextIsToolDetail(i)) break; // an indented tool STATUS ("… \n ⎿ $ cmd") — stop before it
    parts.push(t);
  }
  return parts.join(" ");
}

/**
 * What to do with the grey live-preview bubble for a freshly extracted block —
 * pure so the anti-flicker rule is testable; the DOM effect stays in the caller.
 *
 * `isBaseline` = the extracted block equals the PREVIOUS turn's answer, captured
 * at turn start and still (or transiently again) on the screen. `isFinalized` =
 * it is a block already streamed as authoritative this turn. `showing` = a
 * preview bubble is currently up.
 *
 * The flicker this fixes: while the model writes, a redraw frame can briefly make
 * the OLD block the last one on screen. Once new text has shown, that must be
 * HELD (keep), not flipped back to the old text — the old "clear on baseline /
 * drop the baseline once new text appears" oscillated new↔old every few frames.
 *
 * @returns {"show"|"keep"|"clear"}
 */
export function livePreviewDecision({ isBaseline, isFinalized, showing }) {
  if (isBaseline) return showing ? "keep" : "clear";
  if (isFinalized) return "clear";
  return "show";
}
