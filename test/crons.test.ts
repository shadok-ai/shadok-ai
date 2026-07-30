import assert from "node:assert/strict";
import test from "node:test";
import {
  CRON_MAX_RETRIES,
  CRON_RETRY_DELAY_MS,
  isTransient,
  isValidTimeZone,
  nextRunAfterFailure,
  nextRunFor,
  normalizeSchedule,
  resolveCronId,
  resolveCronTarget,
  scheduleLabel,
  type Cron,
} from "../src/crons.js";
import type { Channel } from "../src/channels.js";

test("nextRunFor: interval adds the step", () => {
  const from = 1_000_000_000_000;
  assert.equal(nextRunFor({ kind: "interval", everyMin: 15 }, from), from + 15 * 60_000);
  assert.equal(nextRunFor({ kind: "interval", everyMin: 1 }, from), from + 60_000);
  // guards against a zero/negative step
  assert.equal(nextRunFor({ kind: "interval", everyMin: 0 }, from), from + 60_000);
});

test("nextRunFor: daily lands on the next HH:MM strictly in the future", () => {
  const from = Date.now();
  const next = nextRunFor({ kind: "daily", hour: 9, minute: 30 }, from);
  assert.ok(next > from, "must be in the future");
  const d = new Date(next);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
  // within the next 24h
  assert.ok(next - from <= 24 * 60 * 60_000 + 1000);
});

test("normalizeSchedule: accepts valid, rejects invalid", () => {
  assert.deepEqual(normalizeSchedule({ kind: "interval", everyMin: 30 }), { kind: "interval", everyMin: 30 });
  assert.deepEqual(normalizeSchedule({ kind: "daily", hour: 9, minute: 0 }), { kind: "daily", hour: 9, minute: 0 });
  assert.equal(normalizeSchedule({ kind: "interval", everyMin: 0 }), null);
  assert.equal(normalizeSchedule({ kind: "daily", hour: 24, minute: 0 }), null);
  assert.equal(normalizeSchedule({ kind: "daily", hour: 9, minute: 60 }), null);
  assert.equal(normalizeSchedule({ kind: "nope" }), null);
  assert.equal(normalizeSchedule(null), null);
});

test("scheduleLabel: readable", () => {
  assert.equal(scheduleLabel({ kind: "interval", everyMin: 30 }), "every 30m");
  assert.equal(scheduleLabel({ kind: "interval", everyMin: 120 }), "every 2h");
  // Le fuseau fait partie du libellé : un « daily at 09:05 » nu ne dit pas 9h où.
  assert.equal(scheduleLabel({ kind: "daily", hour: 9, minute: 5 }, "Europe/Paris"), "daily at 09:05 (Europe/Paris)");
});

// ── Fuseau explicite ─────────────────────────────────────────────────────
// Ces tests n'assertent QUE sur l'instant UTC produit : ils valident donc le
// calcul quelle que soit la machine qui les exécute (CI en UTC, poste à Paris).

test("nextRunFor: un daily dans un fuseau explicite ignore celui de la machine", () => {
  // 09:00 à Paris en été (UTC+2) = 07:00 UTC.
  const from = Date.parse("2026-07-15T03:00:00Z");
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 0 }, from, "Europe/Paris");
  assert.equal(new Date(t).toISOString(), "2026-07-15T07:00:00.000Z");
});

test("nextRunFor: heure d'hiver — le même 09:00 local tombe une heure plus tard en UTC", () => {
  // 09:00 à Paris en hiver (UTC+1) = 08:00 UTC. Un offset figé se tromperait ici.
  const from = Date.parse("2026-01-15T03:00:00Z");
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 0 }, from, "Europe/Paris");
  assert.equal(new Date(t).toISOString(), "2026-01-15T08:00:00.000Z");
});

test("nextRunFor: l'heure du jour étant passée, on vise le lendemain (même heure locale)", () => {
  const from = Date.parse("2026-07-15T09:00:00Z"); // 11h à Paris, 9h est passé
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 0 }, from, "Europe/Paris");
  assert.equal(new Date(t).toISOString(), "2026-07-16T07:00:00.000Z");
});

test("nextRunFor: la veille d'une bascule d'heure d'été, l'échéance reste à 09:00 local", () => {
  // 2026-10-25 : Paris repasse à UTC+1. Depuis la veille, le prochain 09:00
  // local est à 08:00 UTC — et non 07:00 (ce que donnerait un simple +24h).
  const from = Date.parse("2026-10-24T09:00:00Z");
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 0 }, from, "Europe/Paris");
  assert.equal(new Date(t).toISOString(), "2026-10-25T08:00:00.000Z");
});

test("nextRunFor: un fuseau inconnu retombe sur la machine au lieu de planter", () => {
  const from = Date.now();
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 30 }, from, "Europe/Pariss");
  const d = new Date(t);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
});

test("nextRunFor: un intervalle n'a pas de fuseau (c'est une durée)", () => {
  const from = Date.parse("2026-07-15T09:00:00Z");
  assert.equal(nextRunFor({ kind: "interval", everyMin: 30 }, from, "Asia/Tokyo"), from + 30 * 60_000);
});

test("isValidTimeZone: accepte l'IANA, refuse le reste", () => {
  assert.equal(isValidTimeZone("Europe/Paris"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Europe/Pariss"), false);
  assert.equal(isValidTimeZone(""), false);
});

const NOW = 1_000_000_000_000;
const TOMORROW = NOW + 24 * 60 * 60_000; // a daily cron's next normal slot

test("nextRunAfterFailure: replays shortly when the next slot is far away", () => {
  const r = nextRunAfterFailure(NOW, TOMORROW, 0);
  assert.deepEqual(r, { nextRun: NOW + CRON_RETRY_DELAY_MS, retrying: true, attempts: 1 });
  // the rescheduled run is always in the future — that's what keeps a turn
  // still in flight from being re-triggered by the next tick
  assert.ok(r.nextRun > NOW);
});

test("nextRunAfterFailure: gives up after the attempt cap and resets the counter", () => {
  // the last allowed retry still goes through…
  const last = nextRunAfterFailure(NOW, TOMORROW, CRON_MAX_RETRIES - 1);
  assert.equal(last.retrying, true);
  assert.equal(last.attempts, CRON_MAX_RETRIES);
  // …and the one after falls back to the normal slot
  const capped = nextRunAfterFailure(NOW, TOMORROW, CRON_MAX_RETRIES);
  assert.deepEqual(capped, { nextRun: TOMORROW, retrying: false, attempts: 0 });
  // way over the cap too (a counter that somehow drifted)
  assert.deepEqual(nextRunAfterFailure(NOW, TOMORROW, 99), { nextRun: TOMORROW, retrying: false, attempts: 0 });
});

test("nextRunAfterFailure: never pushes a run past its own next slot", () => {
  // a 5-minute interval cron: the normal tick comes before any retry would
  const soon = NOW + 5 * 60_000;
  assert.deepEqual(nextRunAfterFailure(NOW, soon, 0), { nextRun: soon, retrying: false, attempts: 0 });
  // exactly on the boundary: prefer the normal slot, no extra fire
  const boundary = NOW + CRON_RETRY_DELAY_MS;
  assert.deepEqual(nextRunAfterFailure(NOW, boundary, 0), { nextRun: boundary, retrying: false, attempts: 0 });
  // one millisecond further out and the retry is worth it
  assert.equal(nextRunAfterFailure(NOW, boundary + 1, 0).retrying, true);
});

test("isTransient: only replays failures where nothing reached the agent", () => {
  for (const r of ["pace-blocked", "busy", "ws-error", "exited"] as const) {
    assert.equal(isTransient(r), true, `${r} should be replayed`);
  }
  // an application-level refusal won't evaporate in 10 min, and a timeout means
  // the turn is STILL running — replaying it would stack two prompts
  assert.equal(isTransient("error"), false);
  assert.equal(isTransient("timeout"), false);
  // a vanished directory won't come back in 10 min — and the resume already
  // tried to recreate a reclaimed worktree checkout before reporting it
  assert.equal(isTransient("gone"), false);
});

// ── Where does a cron run? ────────────────────────────────────────────────
// The guard and the session resume must agree: resuming a worktree session with
// the repo root loads NO history (invariant nº 1).

const chan = (sessionId: string, extra: Partial<Channel> = {}): Channel =>
  ({ sessionId, cwd: "/repo", ...extra });

test("resolveCronTarget: a worktree channel resolves to its OWN directory", () => {
  const list = [
    chan("root-session"),
    chan("wt-session", {
      cwd: "/home/u/.shadok-ai/worktrees/shadok-ai-wt",
      branch: "shadok-ai/wt",
      repo: "/repo",
      profile: "reviewer",
    }),
  ];
  assert.deepEqual(resolveCronTarget(list, "wt-session", "/server-cwd"), {
    cwd: "/home/u/.shadok-ai/worktrees/shadok-ai-wt",
    profile: "reviewer",
    branch: "shadok-ai/wt",
    repo: "/repo",
    known: true,
  });
});

test("resolveCronTarget: an unknown session falls back to the server cwd", () => {
  // Not a failure: a channel whose registry entry was lost should still fire,
  // and the repo root is right for the common root-directory channel.
  assert.deepEqual(resolveCronTarget([chan("other")], "ghost", "/server-cwd"), {
    cwd: "/server-cwd",
    profile: null,
    branch: null,
    repo: null,
    known: false,
  });
});

test("resolveCronTarget: missing fields normalize to null, blank cwd falls back", () => {
  const t = resolveCronTarget([chan("s", { cwd: "  " })], "s", "/server-cwd");
  assert.equal(t.cwd, "/server-cwd");
  assert.equal(t.branch, null);
  assert.equal(t.repo, null);
  assert.equal(t.profile, null);
  assert.equal(t.known, true); // the channel exists — only its cwd was unusable
});

test("resolveCronTarget: matches on sessionId, not on cwd", () => {
  // Several channels can share a directory; picking by cwd would converge them.
  const list = [chan("a", { profile: "pa" }), chan("b", { profile: "pb" })];
  assert.equal(resolveCronTarget(list, "b", "/x").profile, "pb");
});

// ── Désigner un cron ──────────────────────────────────────────────────────
// Tous les `list` (web, skill, Telegram) n'affichent que 8 caractères de l'id :
// si le préfixe ne résout pas, on ne peut désigner aucun cron.

const cron = (id: string): Cron =>
  ({ id, sessionId: "s", prompt: "p", schedule: { kind: "interval", everyMin: 5 }, enabled: true });
const LIST = [cron("27db3cb3-f26a-460c-8f95-cc130fedfbaf"), cron("27db9999-0000-4000-8000-000000000000")];

test("resolveCronId: un id complet résout", () => {
  assert.deepEqual(resolveCronId(LIST, LIST[0].id), { ok: true, id: LIST[0].id });
});

test("resolveCronId: un préfixe non ambigu résout — c'est ce que `list` affiche", () => {
  assert.deepEqual(resolveCronId(LIST, "27db3cb3"), { ok: true, id: LIST[0].id });
  assert.deepEqual(resolveCronId(LIST, "27db9"), { ok: true, id: LIST[1].id });
});

test("resolveCronId: un préfixe ambigu est refusé, pas tranché au hasard", () => {
  assert.deepEqual(resolveCronId(LIST, "27db"), { ok: false, error: "ambiguous", matches: 2 });
});

test("resolveCronId: un préfixe vide ne matche PAS le premier", () => {
  // `/cron del` sans argument supprimait un cron au hasard.
  assert.deepEqual(resolveCronId(LIST, ""), { ok: false, error: "empty", matches: 0 });
  assert.deepEqual(resolveCronId(LIST, "   "), { ok: false, error: "empty", matches: 0 });
});

test("resolveCronId: rien ne matche → not-found (et non un faux succès)", () => {
  assert.deepEqual(resolveCronId(LIST, "deadbeef"), { ok: false, error: "not-found", matches: 0 });
  assert.deepEqual(resolveCronId([], "27db3cb3"), { ok: false, error: "not-found", matches: 0 });
});

test("resolveCronId: un id complet gagne même s'il préfixe un autre id", () => {
  const nested = [cron("abc"), cron("abcdef")];
  assert.deepEqual(resolveCronId(nested, "abc"), { ok: true, id: "abc" });
});
