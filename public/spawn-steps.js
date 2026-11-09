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

/** The first agent's extra step: it stays on the loader until it has greeted
 *  the person (src/first-agent.ts `greetFirstAgent`). Never an ordinary spawn's. */
export const HELLO_STEP = { key: "hello", label: "Saying hello" };

/** Each step's state for the step the server last announced. An unknown or
 *  missing step reads as the very start — never as a skip. `hello` adds the
 *  first agent's greeting step at the end. */
export function spawnStepStates(current, { hello = false } = {}) {
  const steps = hello ? [...SPAWN_STEPS, HELLO_STEP] : SPAWN_STEPS;
  const at = Math.max(0, steps.findIndex((s) => s.key === current));
  return steps.map((s, i) => ({ ...s, state: i < at ? "done" : i === at ? "on" : "todo" }));
}

/** "<name> is waking up…", or a generic subject when the name is not known yet. */
export function spawnLoaderTitle(name) {
  const n = typeof name === "string" ? name.trim() : "";
  return `${n || "Your agent"} is waking up…`;
}
