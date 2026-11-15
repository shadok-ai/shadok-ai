/**
 * The steps a FRESH spawn announces to its client (`{type:"starting", step}`),
 * in the order the `start` handler crosses them — each sent just before the work
 * it names, so the page's loader (public/spawn-steps.js, same keys, kept in step
 * by a test) shows real progress rather than a timer.
 */
export const SPAWN_STEP_KEYS = ["connect", "workspace", "claude"] as const;
export type SpawnStep = (typeof SPAWN_STEP_KEYS)[number];

export function isSpawnStep(x: unknown): x is SpawnStep {
  return typeof x === "string" && (SPAWN_STEP_KEYS as readonly string[]).includes(x);
}
