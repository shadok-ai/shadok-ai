import assert from "node:assert/strict";
import test from "node:test";
import { notifyState, BLINK_MS } from "../public/notify.js";

// `away` = tu n'es pas sur la page : onglet caché OU fenêtre qui n'a pas le
// focus. La v1 ne regardait que la visibilité, et ne clignotait donc jamais
// dans l'usage réel du cockpit — fenêtre affichée, utilisateur dans son
// terminal. C'est l'appelant (index.html) qui compose les deux.
const needs = (extra = {}) => ({ mood: "needs-answer", muted: false, ...extra });
const unread = (extra = {}) => ({ mood: "unread", muted: false, ...extra });

test("agent bloqué + tu es ailleurs → clignote en rouge", () => {
  const s = notifyState([needs()], { away: true, phase: 0 });
  assert.equal(s.blink, true);
  assert.equal(s.color, "#e07a6a");
  assert.equal(s.badge, "● ");
});

test("agent bloqué mais tu es sur la page → rouge fixe, pas de clignotement", () => {
  const s = notifyState([needs()], { away: false, phase: 1 });
  assert.equal(s.blink, false);
  assert.equal(s.color, "#e07a6a");
  assert.equal(s.badge, "● ");
});

test("canal muté → aucun signal global, même bloqué et caché", () => {
  const s = notifyState([needs({ muted: true })], { away: true, phase: 0 });
  assert.equal(s.blink, false);
  assert.equal(s.color, null);
  assert.equal(s.badge, "");
});

test("réponse non lue → ambre fixe, jamais de clignotement", () => {
  for (const hidden of [true, false]) {
    const s = notifyState([unread()], { away: hidden, phase: 0 });
    assert.equal(s.blink, false, "unread ne doit pas clignoter");
    assert.equal(s.color, "#f0a848");
  }
});

test("un bloqué muté ne remonte pas devant un non-lu audible", () => {
  const s = notifyState([needs({ muted: true }), unread()], { away: true, phase: 0 });
  assert.equal(s.color, "#f0a848");
  assert.equal(s.blink, false);
});

test("tous mutés → rien du tout", () => {
  const s = notifyState([needs({ muted: true }), unread({ muted: true })], {
    away: true,
    phase: 0,
  });
  assert.equal(s.color, null);
  assert.equal(s.blink, false);
});

test("un canal qui travaille ou au repos ne réclame rien", () => {
  const s = notifyState([{ mood: "working" }, { mood: null }], { away: true, phase: 0 });
  assert.equal(s.color, null);
  assert.equal(s.blink, false);
});

// L'invariant qui protège du timer étranglé par le navigateur : les DEUX phases
// restent visibles, donc un tick gelé ne peut jamais rendre la page calme.
test("les deux phases du clignotement restent visibles", () => {
  const phases = [0, 1].map((phase) => notifyState([needs()], { away: true, phase }));
  for (const s of phases) {
    assert.ok(s.color, "une phase sans couleur laisserait le favicon nu");
    assert.ok(s.badge.trim(), "une phase sans badge laisserait le titre nu");
  }
  assert.notEqual(phases[0].color, phases[1].color, "sinon rien ne bouge");
  assert.notEqual(phases[0].badge, phases[1].badge);
});

test("la phase n'a aucun effet quand on ne clignote pas", () => {
  const a = notifyState([unread()], { away: true, phase: 0 });
  const b = notifyState([unread()], { away: true, phase: 1 });
  assert.deepEqual(a, b);
});

test("aucun canal → état neutre", () => {
  const s = notifyState([], { away: true, phase: 0 });
  assert.deepEqual(s, { color: null, badge: "", blink: false });
});

test("le tick est assez lent pour survivre au clamp 1s des onglets cachés", () => {
  assert.ok(BLINK_MS >= 800, "sous ~1s le navigateur ravale les ticks");
});
