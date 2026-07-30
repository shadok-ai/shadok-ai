import type { Usage, Window } from "./usage.js";

/** Durée totale de chaque fenêtre glissante, en secondes. */
export const WINDOW_SEC = { fiveHour: 5 * 3600, sevenDay: 7 * 86400 } as const;

/**
 * Ajouté au rythme idéal au dénominateur. Sans lui, le rythme est quasi nul
 * juste après un reset et le moindre message ferait exploser le ratio.
 */
export const PACE_EPSILON = 2;

/** Au-delà de ce ratio (en % du rythme idéal), on bloque. En dur, par choix. */
const BLOCK_RATIO = 100;

const LABEL = { fiveHour: "5h", sevenDay: "7d" } as const;

export interface Pace {
  /** 0–100 : fraction de la fenêtre déjà écoulée. null si non calculable. */
  idealPacePct: number | null;
  /** Consommation rapportée au rythme idéal, en %. 100 = pile dans les temps. */
  ratioPct: number | null;
}

export interface PaceVerdict {
  blocked: boolean;
  reason: string | null;
}

/**
 * Rapporte la consommation d'une fenêtre au temps qui y est déjà passé.
 * Renvoie des null si la fenêtre est absente ou son reset inconnu — pas de
 * données ne vaut pas dépassement.
 */
export function computePace(w: Window | null, durationSec: number, nowMs: number): Pace {
  if (!w || w.resetsAt === null) return { idealPacePct: null, ratioPct: null };
  const remainingSec = w.resetsAt - nowMs / 1000;
  // Borné : une horloge en avance sur resetsAt ne doit pas produire de rythme
  // négatif, ni une fenêtre expirée un rythme supérieur à 100%.
  const idealPacePct = Math.min(100, Math.max(0, ((durationSec - remainingSec) / durationSec) * 100));
  return { idealPacePct, ratioPct: (w.usedPercentage / (idealPacePct + PACE_EPSILON)) * 100 };
}

/**
 * Bloque dès qu'UNE des deux fenêtres consomme plus vite que le temps ne passe.
 * La raison cite la fenêtre au ratio le plus élevé. Sans données, ne bloque pas :
 * l'indisponibilité de l'API ne doit pas verrouiller l'outil.
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
