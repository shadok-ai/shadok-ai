import assert from "node:assert/strict";
import test from "node:test";
import { computePace, paceBlock, PACE_EPSILON, WINDOW_SEC } from "../src/pace.js";
import type { Usage, Window } from "../src/usage.js";

/** Horloge figée : les tests ne doivent jamais dépendre de l'heure réelle. */
const NOW = 1_700_000_000_000;

/** Fenêtre dont le reset tombe dans `remainingSec` secondes. */
const win = (usedPercentage: number, remainingSec: number): Window => ({
  usedPercentage,
  resetsAt: NOW / 1000 + remainingSec,
});

const usage = (fiveHour: Window | null, sevenDay: Window | null): Usage => ({
  fiveHour,
  sevenDay,
  fetchedAt: NOW,
});

const round = (n: number | null) => (n === null ? null : Math.round(n));

/** Expected ideal pace / ratio from first principles — derived from the same
 *  inputs AND from PACE_EPSILON, so these tests stay correct if epsilon is
 *  retuned. They still pin the clamps and the block boundary independently. */
const idealOf = (remainingSec: number, windowSec: number) =>
  Math.min(100, Math.max(0, ((windowSec - remainingSec) / windowSec) * 100));
const ratioOf = (used: number, remainingSec: number, windowSec: number) =>
  (used / (idealOf(remainingSec, windowSec) + PACE_EPSILON)) * 100;

test("5h : 90% consommé avec 10 min restantes suit le rythme", () => {
  const p = computePace(win(90, 600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 97);
  assert.equal(round(p.ratioPct), round(ratioOf(90, 600, WINDOW_SEC.fiveHour)));
});

test("5h : 3% consommé 5 min après le reset ne déclenche pas l'epsilon", () => {
  const p = computePace(win(3, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 2);
  assert.equal(round(p.ratioPct), round(ratioOf(3, 17_700, WINDOW_SEC.fiveHour)));
});

test("5h : 15% consommé 5 min après le reset dépasse le seuil", () => {
  const p = computePace(win(15, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.ok(p.ratioPct! > 100);
  assert.equal(round(p.ratioPct), round(ratioOf(15, 17_700, WINDOW_SEC.fiveHour)));
});

test("7d : 55% consommé avec 6 jours restants dépasse largement", () => {
  const p = computePace(win(55, 6 * 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 14);
  assert.ok(p.ratioPct! > 100);
  assert.equal(round(p.ratioPct), round(ratioOf(55, 6 * 86_400, WINDOW_SEC.sevenDay)));
});

test("7d : 80% consommé avec 1 jour restant suit le rythme", () => {
  const p = computePace(win(80, 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 86);
  assert.equal(round(p.ratioPct), round(ratioOf(80, 86_400, WINDOW_SEC.sevenDay)));
});

test("resetsAt absent : pas de rythme calculable", () => {
  const p = computePace({ usedPercentage: 99, resetsAt: null }, WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, null);
  assert.equal(p.ratioPct, null);
});

test("fenêtre expirée : le rythme idéal est borné à 100%", () => {
  const p = computePace(win(50, -3_600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 100);
  assert.equal(round(p.ratioPct), round(ratioOf(50, -3_600, WINDOW_SEC.fiveHour)));
});

// Borne basse : un resetsAt plus lointain que la durée de la fenêtre (dérive
// d'horloge) donne un temps écoulé négatif, borné à 0. Sans le clamp, le
// dénominateur (0 + epsilon) resterait sain mais idealPacePct serait négatif.
test("resetsAt au-delà de la durée de la fenêtre : le rythme idéal est borné à 0%", () => {
  const p = computePace(win(50, WINDOW_SEC.fiveHour + 3_600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 0);
  assert.equal(round(p.ratioPct), round((50 / PACE_EPSILON) * 100)); // ideal=0
});

// Frontière exacte du seuil unique (BLOCK_RATIO = 100), posée par arithmétique.
// À mi-fenêtre idealPacePct = 50 (exact en binaire). ratio = 100 ⟺
// used = 50 + PACE_EPSILON. Pile sur la limite ne bloque pas ; un cran au-dessus
// bloque.
const MID = WINDOW_SEC.fiveHour / 2;
const BOUNDARY_USED = 50 + PACE_EPSILON; // ratio exactement 100

test("computePace : used = ideal + epsilon à mi-fenêtre donne un ratio de 100 pile", () => {
  const p = computePace(win(BOUNDARY_USED, MID), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 50);
  assert.equal(p.ratioPct, 100); // égalité stricte, pas d'arrondi
});

test("paceBlock : un ratio de 100 pile ne bloque pas", () => {
  const v = paceBlock(usage(win(BOUNDARY_USED, MID), null), NOW);
  assert.equal(v.blocked, false);
  assert.equal(v.reason, null);
});

test("paceBlock : juste au-dessus de 100 bloque", () => {
  const w = win(BOUNDARY_USED + 1, MID);
  assert.ok(computePace(w, WINDOW_SEC.fiveHour, NOW).ratioPct! > 100);
  const v = paceBlock(usage(w, null), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^5h:/);
});

test("paceBlock : une seule fenêtre au-dessus du seuil suffit", () => {
  const v = paceBlock(usage(win(90, 600), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d:/);
});

test("paceBlock : les deux dans les clous ne bloque pas", () => {
  const v = paceBlock(usage(win(90, 600), win(80, 86_400)), NOW);
  assert.equal(v.blocked, false);
  assert.equal(v.reason, null);
});

test("paceBlock : la raison cite la fenêtre au ratio le plus élevé", () => {
  // 7d à 55%/6j reste bien au-dessus de 5h à 15%/5min quel que soit epsilon.
  const v = paceBlock(usage(win(15, 17_700), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  const r5 = ratioOf(15, 17_700, WINDOW_SEC.fiveHour);
  const r7 = ratioOf(55, 6 * 86_400, WINDOW_SEC.sevenDay);
  assert.match(v.reason ?? "", r7 > r5 ? /^7d:/ : /^5h:/);
});

test("paceBlock : la raison porte les trois chiffres (used, ideal, ratio)", () => {
  const v = paceBlock(usage(null, win(55, 6 * 86_400)), NOW);
  const ideal = round(idealOf(6 * 86_400, WINDOW_SEC.sevenDay));
  const ratio = round(ratioOf(55, 6 * 86_400, WINDOW_SEC.sevenDay));
  assert.equal(v.reason, `7d: 55% used vs ${ideal}% ideal pace (${ratio}% of pace)`);
});

test("paceBlock : usage absent ne bloque jamais", () => {
  assert.deepEqual(paceBlock(null, NOW), { blocked: false, reason: null });
});

test("paceBlock : resetsAt absent ne bloque jamais", () => {
  const v = paceBlock(usage(null, { usedPercentage: 99, resetsAt: null }), NOW);
  assert.equal(v.blocked, false);
});
