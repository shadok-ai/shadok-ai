import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ledgerFileFor,
  ledgerSeenFileFor,
  seenFor,
  recordSeen,
  pruneSeen,
  deltaSince,
} from "../src/ledger.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sk-seen-")), "seen.json");
}

test("ledgerSeenFileFor: per-instance, and never the ledger table itself", () => {
  const f = ledgerSeenFileFor("/home/x/proj");
  assert.equal(f, path.join(os.homedir(), ".shadok-ai", "ledger", "-home-x-proj-seen.json"));
  // distinct launch dirs → distinct watermarks, like the table they track
  assert.notEqual(ledgerSeenFileFor("/a"), ledgerSeenFileFor("/b"));
  // and it must never collide with the table: writing one would erase the other
  assert.notEqual(ledgerSeenFileFor("/home/x/proj"), ledgerFileFor("/home/x/proj"));
});

test("seenFor: an unknown session is UNDEFINED, not 0", () => {
  const f = tmpFile();
  // The caller distinguishes the two: no record → a NEW agent, anchored to now
  // (no history flood); 0 would mean "has seen nothing ever" and would replay
  // the whole table into a freshly spawned agent.
  assert.equal(seenFor(f, "s1"), undefined);
  // an unreadable / absent file is not a crash either
  assert.equal(seenFor(path.join(f, "nope", "x.json"), "s1"), undefined);
});

test("recordSeen → seenFor: the watermark survives the process that wrote it", () => {
  const f = tmpFile();
  recordSeen(f, "s1", 1000);
  recordSeen(f, "s2", 2000);
  assert.equal(seenFor(f, "s1"), 1000);
  assert.equal(seenFor(f, "s2"), 2000);
  // advancing overwrites in place
  recordSeen(f, "s1", 3000);
  assert.equal(seenFor(f, "s1"), 3000);
  assert.equal(seenFor(f, "s2"), 2000);
});

test("a restart no longer swallows the delta (the bug this fixes)", () => {
  // An agent prompted at t=1000; rows recorded by siblings at 1500 and 1800;
  // the server restarts (auto-update) and the agent is re-attached at 2000.
  const f = tmpFile();
  recordSeen(f, "agent", 1000);
  const rows = [
    { id: "a1", entity: "PR#187", status: "resolved", updatedAt: 1500 },
    { id: "b2", entity: "PR#189", status: "resolved", updatedAt: 1800 },
  ];
  // Before the fix the watermark was re-anchored to the attach instant (2000)
  // and the delta came back empty — silently, on every auto-update.
  assert.deepEqual(deltaSince(rows, 2000, 8).rows, []);
  // Now the attach reads the persisted watermark instead, so the backlog lands.
  const watermark = seenFor(f, "agent") ?? 2000;
  assert.equal(deltaSince(rows, watermark, 8).total, 2);
});

test("pruneSeen: drops closed agents, always keeps the one just written, caps", () => {
  const map = { a: 1, b: 2, c: 3 };
  // `keep` is the live channel list: a closed agent's watermark is dead weight.
  assert.deepEqual(pruneSeen(map, new Set(["a", "c"]), "a", 100), { a: 1, c: 3 });
  // the session being written is kept even when the channel list doesn't have it
  // yet (a spawn races its own upsert) — losing it would re-anchor to now.
  assert.deepEqual(pruneSeen({ z: 9 }, new Set(["a"]), "z", 100), { z: 9 });
  // no list to compare against (a failed read) → keep everything, capped newest-first
  const many: Record<string, number> = {};
  for (let i = 0; i < 10; i++) many["s" + i] = i;
  const capped = pruneSeen(many, undefined, "s0", 3);
  assert.deepEqual(Object.keys(capped).sort(), ["s0", "s8", "s9"]);
});
