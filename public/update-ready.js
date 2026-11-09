// Claude Code manages its OWN binary and reports the outcome in its TUI footer.
// Two states matter to a running agent, both captured from the real TUI (the
// user's screenshots):
//   "restart" — "✓ Update installed · Restart to apply": the new binary is in,
//               the agent just needs to reload to run it.
//   "failed"  — "✗ Auto-update failed · Try claude doctor or npm i -g …": the
//               auto-update could not install; the cockpit installs it, then the
//               agent reloads.
// The screen is the control plane the client already has (t.screenText), so this
// reads from it — no server push needed to detect the state.
//
// Pure, so the browser and test/update-ready.test.ts share the exact same rule.
// ESM: bridged to window.claudeUpdateState AND imported by the test.

// The footer sits at the BOTTOM of the render, just above the composer. Scanning
// only the tail keeps an AGENT that merely PRINTS "restart to apply" in its
// answer (scrolled up) from tripping the badge — the same class of false
// positive that made screenShowsWork ignore a quoted "esc to interrupt"
// (invariant 2). A handful of lines covers the footer plus the input box.
const TAIL_LINES = 8;

function tail(screen) {
  return screen.split("\n").filter((l) => l.trim()).slice(-TAIL_LINES).join("\n");
}

/**
 * Classify a rendered TUI screen's Claude Code update footer.
 * @returns {"restart" | "failed" | null}
 */
export function claudeUpdateState(screen) {
  if (typeof screen !== "string" || !screen) return null;
  const foot = tail(screen);
  // Order matters: a failed auto-update is the more urgent, more specific line.
  if (/auto-update failed/i.test(foot)) return "failed";
  if (/\brestart to apply\b/i.test(foot)) return "restart";
  return null;
}
