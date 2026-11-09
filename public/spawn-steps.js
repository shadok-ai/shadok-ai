// What a person sees while an agent is being born: a few REAL steps, each
// announced by the server (`{type:"starting", step}`) just before it does the
// work it names (src/spawn-steps.ts holds the same keys, a test keeps them in
// step). Never a timer pretending to know: a step the server has not reached is
// "todo", and the loader ends on `ready` or on the refusal that replaces it.
// Pure, so the step logic is tested without a browser.

/** The steps, in the order the start handler crosses them. */
export const SPAWN_STEPS = [
  { key: "connect", label: "Checking its access to Claude" },
  { key: "workspace", label: "Preparing its workspace" },
  { key: "claude", label: "Starting Claude Code" },
];

/** One line under the title: what is actually happening, in plain words. */
export const SPAWN_HINT =
  "A real Claude Code session is starting in its own directory, with its role and this instance's context. A few seconds, then it says hello.";

/** Each step's state for the step the server last announced. An unknown or
 *  missing step reads as the very start — never as a skip. */
export function spawnStepStates(current) {
  const at = Math.max(0, SPAWN_STEPS.findIndex((s) => s.key === current));
  return SPAWN_STEPS.map((s, i) => ({ ...s, state: i < at ? "done" : i === at ? "on" : "todo" }));
}

/** "<name> is waking up…", or a generic subject when the name is not known yet. */
export function spawnLoaderTitle(name) {
  const n = typeof name === "string" ? name.trim() : "";
  return `${n || "Your agent"} is waking up…`;
}
