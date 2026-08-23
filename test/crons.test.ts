import assert from "node:assert/strict";
import test from "node:test";
import {
  CRON_PROMPT_MARK,
  markCronPrompt,
  isCronPrompt,
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
  // The zone is part of the label: a bare "daily at 09:05" does not say 09:05 where.
  assert.equal(scheduleLabel({ kind: "daily", hour: 9, minute: 5 }, "Europe/Paris"), "daily at 09:05 (Europe/Paris)");
});

// ── Fuseau explicite ─────────────────────────────────────────────────────
// These tests only assert on the UTC instant produced: they therefore validate
// the computation whatever machine runs them (CI in UTC, a laptop in Paris).

test("nextRunFor: a daily in an explicit zone ignores the machine's", () => {
  // 09:00 in Paris in summer (UTC+2) = 07:00 UTC.
  const from = Date.parse("2026-07-15T03:00:00Z");
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 0 }, from, "Europe/Paris");
  assert.equal(new Date(t).toISOString(), "2026-07-15T07:00:00.000Z");
});

test("nextRunFor: winter time — the same local 09:00 falls an hour later in UTC", () => {
  // 09:00 in Paris in winter (UTC+1) = 08:00 UTC. A frozen offset gets this wrong.
  const from = Date.parse("2026-01-15T03:00:00Z");
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 0 }, from, "Europe/Paris");
  assert.equal(new Date(t).toISOString(), "2026-01-15T08:00:00.000Z");
});

test("nextRunFor: today's time having passed, we aim at tomorrow (same local time)", () => {
  const from = Date.parse("2026-07-15T09:00:00Z"); // 11:00 in Paris, 09:00 is past
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 0 }, from, "Europe/Paris");
  assert.equal(new Date(t).toISOString(), "2026-07-16T07:00:00.000Z");
});

test("nextRunFor: the day before a DST switch, the deadline stays at 09:00 local", () => {
  // 2026-10-25: Paris goes back to UTC+1. From the day before, the next local
  // 09:00 is at 08:00 UTC — not 07:00 (which a plain +24h would give).
  const from = Date.parse("2026-10-24T09:00:00Z");
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 0 }, from, "Europe/Paris");
  assert.equal(new Date(t).toISOString(), "2026-10-25T08:00:00.000Z");
});

test("nextRunFor: an unknown zone falls back to the machine instead of throwing", () => {
  const from = Date.now();
  const t = nextRunFor({ kind: "daily", hour: 9, minute: 30 }, from, "Europe/Pariss");
  const d = new Date(t);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
});

test("nextRunFor: an interval has no zone (it is a duration)", () => {
  const from = Date.parse("2026-07-15T09:00:00Z");
  assert.equal(nextRunFor({ kind: "interval", everyMin: 30 }, from, "Asia/Tokyo"), from + 30 * 60_000);
});

test("isValidTimeZone: accepts IANA, refuses the rest", () => {
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

// ── Naming a cron ────────────────────────────────────────────────────────
// Every `list` (web, skill, Telegram) shows only 8 characters of the id: if the
// prefix does not resolve, no cron can be named at all.

const cron = (id: string): Cron =>
  ({ id, sessionId: "s", prompt: "p", schedule: { kind: "interval", everyMin: 5 }, enabled: true });
const LIST = [cron("27db3cb3-f26a-460c-8f95-cc130fedfbaf"), cron("27db9999-0000-4000-8000-000000000000")];

test("resolveCronId: a full id resolves", () => {
  assert.deepEqual(resolveCronId(LIST, LIST[0].id), { ok: true, id: LIST[0].id });
});

test("resolveCronId: an unambiguous prefix resolves — that is what `list` shows", () => {
  assert.deepEqual(resolveCronId(LIST, "27db3cb3"), { ok: true, id: LIST[0].id });
  assert.deepEqual(resolveCronId(LIST, "27db9"), { ok: true, id: LIST[1].id });
});

test("resolveCronId: an ambiguous prefix is refused, not guessed at random", () => {
  assert.deepEqual(resolveCronId(LIST, "27db"), { ok: false, error: "ambiguous", matches: 2 });
});

test("resolveCronId: an empty prefix does NOT match the first one", () => {
  // A bare `/cron del` used to delete a cron at random.
  assert.deepEqual(resolveCronId(LIST, ""), { ok: false, error: "empty", matches: 0 });
  assert.deepEqual(resolveCronId(LIST, "   "), { ok: false, error: "empty", matches: 0 });
});

test("resolveCronId: nothing matches → not-found (and not a false success)", () => {
  assert.deepEqual(resolveCronId(LIST, "deadbeef"), { ok: false, error: "not-found", matches: 0 });
  assert.deepEqual(resolveCronId([], "27db3cb3"), { ok: false, error: "not-found", matches: 0 });
});

test("resolveCronId: a full id wins even when it prefixes another id", () => {
  const nested = [cron("abc"), cron("abcdef")];
  assert.deepEqual(resolveCronId(nested, "abc"), { ok: true, id: "abc" });
});

test("markCronPrompt: marks, and does not double the mark", () => {
  const marked = markCronPrompt("Write the morning report.");
  assert.ok(marked.startsWith(CRON_PROMPT_MARK));
  assert.ok(marked.endsWith("Write the morning report."));
  // Idempotent: a replayed cron (a retry after a failed delivery) must not
  // stack marks in the text the agent reads.
  assert.equal(markCronPrompt(marked), marked);
});

test("isCronPrompt: strict — the mark must OPEN the message", () => {
  assert.equal(isCronPrompt(markCronPrompt("x")), true);
  assert.equal(isCronPrompt("  " + CRON_PROMPT_MARK + " x"), true);
  // Someone TALKING about the mark does not get muzzled (see invariant 2: an
  // over-broad heuristic has already cost dearly here).
  assert.equal(isCronPrompt("how does " + CRON_PROMPT_MARK + " work?"), false);
  assert.equal(isCronPrompt("Write the morning report."), false);
  assert.equal(isCronPrompt(""), false);
});
