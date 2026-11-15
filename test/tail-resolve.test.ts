import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RESOLVE_MAX_TICKS,
  RESOLVE_MIN_TICKS,
  newestTranscriptById,
  resolveStep,
  tailSession,
  type ResolveCadence,
  type TranscriptSeen,
} from "../src/tail.js";

/**
 * The tail re-resolves a transcript's path to follow it when an agent switches
 * worktree. That search lists ~/.claude/projects and stats the session's file in
 * every directory, so its cost is AGENTS × DIRECTORIES — and on the instance that
 * develops shadok (61 agents, 224 directories) it was ~24% of a CPU core, half of
 * the server's use, run once per second per agent whatever the agent was doing.
 */

/** Drive `resolveStep` for `ticks` ticks under a fixed observation; count resolves. */
function run(ticks: number, seen: (t: number) => TranscriptSeen, start: ResolveCadence = { gap: RESOLVE_MIN_TICKS, next: 0 }) {
  let c = start;
  const at: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const s = resolveStep(c, t, seen(t));
    c = s.cadence;
    if (s.resolve) at.push(t);
  }
  return at;
}

test("a transcript that keeps growing is never searched — it cannot have moved", () => {
  assert.deepEqual(run(400, () => "grew"), []);
});

test("a missing transcript keeps the old fast cadence — finding where it lands is the point", () => {
  const at = run(40, () => "missing");
  assert.deepEqual(at, [0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
});

test("a silent transcript backs off, and the gap is capped", () => {
  const at = run(240, () => "silent"); // ~60 s at 250 ms
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  assert.ok(at.length <= 9, `idle agent searched ${at.length} times in a minute (was 60)`);
  assert.ok(gaps.every((g) => g <= RESOLVE_MAX_TICKS), `a gap exceeded the cap: ${gaps}`);
  assert.equal(gaps.at(-1), RESOLVE_MAX_TICKS, "a long silence settles on the cap");
});

test("a move right after activity is still caught within ~1s, as before", () => {
  // Growing until tick 100, then silent: the old file went quiet because the
  // agent's transcript now grows elsewhere. The first search must come fast.
  const at = run(140, (t) => (t < 100 ? "grew" : "silent"));
  assert.ok(at.length > 0 && at[0] - 100 <= RESOLVE_MIN_TICKS, `first search at ${at[0]}, activity stopped at 100`);
});

test("the very first tick searches, exactly like the old `tick % 4 === 0`", () => {
  assert.equal(run(1, () => "silent")[0], 0);
});

// --- the search itself ------------------------------------------------------

function withHome<T>(fn: (projects: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shadok-home-"));
  const projects = path.join(home, ".claude", "projects");
  fs.mkdirSync(projects, { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(projects);
  } finally {
    process.env.HOME = prev;
  }
}

test("newestTranscriptById finds the file among many directories and picks the newest", () => {
  withHome((projects) => {
    for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(projects, `-dir-${i}`));
    const old = path.join(projects, "-dir-7", "sess.jsonl");
    const fresh = path.join(projects, "-dir-31", "sess.jsonl");
    fs.writeFileSync(old, "a\n");
    fs.writeFileSync(fresh, "b\n");
    fs.utimesSync(old, new Date(1_000_000), new Date(1_000_000));
    assert.equal(newestTranscriptById("sess"), fresh);
  });
});

test("newestTranscriptById: absent everywhere is null, and a stray FILE among the dirs is harmless", () => {
  withHome((projects) => {
    for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(projects, `-dir-${i}`));
    fs.writeFileSync(path.join(projects, "not-a-dir"), "x");
    assert.equal(newestTranscriptById("nowhere"), null);
  });
});

// --- wiring: the tail still follows a moved transcript ----------------------

test("the tail still FOLLOWS a transcript that moved after a silence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadok-tail-"));
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl");
  const line = (text: string) =>
    JSON.stringify({ type: "assistant", message: { id: text, content: [{ type: "text", text }] } }) + "\n";
  fs.writeFileSync(a, line("before"));
  let target = a;
  let resolves = 0;
  const texts: string[] = [];
  const stop = tailSession(a, (e) => { if (e.kind === "text") texts.push(e.text); }, 2, () => { resolves++; return target; });
  try {
    await new Promise((r) => setTimeout(r, 150)); // silent: the cadence backs off
    // The agent switched worktree: Claude Code re-homes the transcript (same
    // content, longer) and keeps appending there.
    fs.writeFileSync(b, line("before") + line("after the move"));
    target = b;
    const deadline = Date.now() + 3000;
    while (!texts.includes("after the move") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(texts.includes("after the move"), "the moved transcript's new content never streamed");
  } finally {
    stop();
  }
  // ~75 ticks of silence would have meant ~19 searches with the old cadence.
  assert.ok(resolves < 19, `searched ${resolves} times during a silence`);
});
