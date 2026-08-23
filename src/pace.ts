import type { Usage, Window } from "./usage.js";

/** Total length of each sliding window, in seconds. */
export const WINDOW_SEC = { fiveHour: 5 * 3600, sevenDay: 7 * 86400 } as const;

/**
 * Added to the ideal pace in the denominator. Without it the pace is near zero
 * right after a reset, and the smallest message would blow the ratio up.
 */
export const PACE_EPSILON = 2;

/** Above this ratio (as a % of the ideal pace), we block. Hardcoded, on purpose. */
const BLOCK_RATIO = 100;

const LABEL = { fiveHour: "5h", sevenDay: "7d" } as const;

export interface Pace {
  /** 0–100: fraction of the window already elapsed. null when not computable. */
  idealPacePct: number | null;
  /** Usage relative to the ideal pace, in %. 100 = exactly on schedule. */
  ratioPct: number | null;
}

export interface PaceVerdict {
  blocked: boolean;
  reason: string | null;
}

/**
 * Relates a window's usage to the time already spent in it. Returns nulls when
 * the window is missing or its reset unknown — no data does not mean overrun.
 */
export function computePace(w: Window | null, durationSec: number, nowMs: number): Pace {
  if (!w || w.resetsAt === null) return { idealPacePct: null, ratioPct: null };
  const remainingSec = w.resetsAt - nowMs / 1000;
  // Clamped: a clock ahead of resetsAt must not produce a negative pace, nor
  // an expired window a pace above 100%.
  const idealPacePct = Math.min(100, Math.max(0, ((durationSec - remainingSec) / durationSec) * 100));
  return { idealPacePct, ratioPct: (w.usedPercentage / (idealPacePct + PACE_EPSILON)) * 100 };
}

/**
 * Blocks as soon as ONE of the two windows burns faster than time passes. The
 * reason names the window with the highest ratio. With no data it does not
 * block: an unavailable API must not lock the tool.
 */
export function paceBlock(u: Usage | null, nowMs: number): PaceVerdict {
  if (!u) return { blocked: false, reason: null };
  let worst: { label: string; used: number; pace: number; ratio: number } | null = null;
  for (const key of ["fiveHour", "sevenDay"] as const) {
    const w = u[key];
    const { idealPacePct, ratioPct } = computePace(w, WINDOW_SEC[key], nowMs);
    if (!w || idealPacePct === null || ratioPct === null) continue;
    if (ratioPct <= BLOCK_RATIO) continue;
    if (!worst || ratioPct > worst.ratio) {
      worst = { label: LABEL[key], used: w.usedPercentage, pace: idealPacePct, ratio: ratioPct };
    }
  }
  if (!worst) return { blocked: false, reason: null };
  const r = Math.round;
  return {
    blocked: true,
    reason: `${worst.label}: ${r(worst.used)}% used vs ${r(worst.pace)}% ideal pace (${r(worst.ratio)}% of pace)`,
  };
}
