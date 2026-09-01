import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  announceFirstAgent,
  firstAgentStatus,
  settleFirstAgent,
} from "../src/first-agent.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = fs.readFileSync(path.join(HERE, "..", "public", "index.html"), "utf8");
const SRC = fs.readFileSync(path.join(HERE, "..", "src", "first-agent.ts"), "utf8");

// ── The status the browser asks for ─────────────────────────────────────────
//
// "A first agent is on its way" and "the user closed their last tab" are the
// same zero channels client-side (invariant 18). Only the server can tell them
// apart, and the wait it announces has to END in every direction — a signed-out
// cockpit reading "starting your first agent…" forever is worse than the empty
// state this replaces.

test("an instance that has channels is never pending", () => {
  announceFirstAgent(3);
  assert.equal(firstAgentStatus().pending, false);
  assert.equal(firstAgentStatus().reason, "channels-exist");
});

test("an instance with no channel announces the spawn before it happens", () => {
  // The boot path opens the browser, THEN defers the spawn a beat, and the auth
  // probe costs another ~850ms on top. Without this the page that the status
  // exists for loads inside that gap and is told there is nothing coming.
  announceFirstAgent(0);
  assert.deepEqual(firstAgentStatus(), { pending: true, reason: "starting" });
});

test("announcing is authoritative, not sticky", () => {
  announceFirstAgent(0);
  announceFirstAgent(1);
  assert.equal(firstAgentStatus().pending, false);
});

for (const reason of ["first-boot", "channels-exist", "not-signed-in"] as const) {
  test(`settling on "${reason}" ends the wait`, () => {
    announceFirstAgent(0);
    settleFirstAgent(reason);
    assert.equal(firstAgentStatus().pending, false, "every reason must clear pending");
    assert.equal(firstAgentStatus().reason, reason);
  });
}

test("the status handed out is a copy", () => {
  announceFirstAgent(0);
  const st = firstAgentStatus();
  st.pending = false;
  assert.equal(firstAgentStatus().pending, true, "a caller must not be able to edit the state");
});

test("every exit from the spawn settles the status", () => {
  // A scan, because the paths that must clear it are the ones no unit test can
  // drive: the socket erroring, `exited`, and the 60s guard. They all resolve
  // the same promise, so the `finally` is what covers them — and a refactor
  // that moved the clear into the success branch would restore the stuck flag.
  assert.match(
    SRC,
    /\} finally \{[^}]*settleFirstAgent\("first-boot"\);/s,
    "ensureFirstAgent must settle in a finally, not on the happy path only",
  );
  assert.match(
    SRC,
    /if \(!plan\.spawn\) \{\s*settleFirstAgent\(plan\.reason\);/,
    "a plan that spawns nothing (signed out, channels exist) must settle too",
  );
});

// ── The page ────────────────────────────────────────────────────────────────
//
// Scans, like csp.test.ts / ws-url.test.ts / tab-focus.test.ts: properties of a
// hand-written page with no build step, which no unit test can reach.

test("the channel sync runs immediately, not one interval late", () => {
  assert.doesNotMatch(
    INDEX,
    /setInterval\(syncChannels/,
    "a fixed interval means a channel the server ALREADY has waits out a full period",
  );
  assert.match(INDEX, /async function syncLoop\(\)/, "the poll is a self-rescheduling loop");
  assert.match(
    INDEX,
    /\n\s*syncLoop\(\);\n\s*\}\)\(\);/,
    "the loop must be kicked off at the end of the restore — syncChannels is a no-op while restoring",
  );
});

test("the loop speeds up only while a first agent is pending", () => {
  assert.match(INDEX, /const SYNC_IDLE_MS = 4000;/, "the steady-state poll stays 4s for everyone");
  assert.match(
    INDEX,
    /setTimeout\(syncLoop, firstAgentPending \? SYNC_STARTING_MS : SYNC_IDLE_MS\)/,
    "the faster cadence must be tied to the pending state and settle back on its own",
  );
});

test("a bad pass never ends the loop", () => {
  // A setInterval could not die. A self-rescheduling loop can, and losing it
  // would silently stop every channel discovery for the life of the page.
  assert.match(INDEX, /\} catch \{[\s\S]{0,400}?\}\s*setTimeout\(syncLoop,/);
});

test("the wait is read from the server, never guessed from the tab count", () => {
  assert.match(INDEX, /fetch\("\/first-agent"\)/, "the client must ask the side doing the spawning");
  assert.match(
    INDEX,
    /firstAgentPending = now;/,
    "the flag mirrors the server's answer rather than any local heuristic",
  );
  // Read in the load batch, so the very first paint of an empty cockpit already
  // knows which of the two panels it is — no flash of "No agent open" at someone
  // whose agent is two seconds away, and no second place a hang could hold the
  // first paint.
  assert.match(
    INDEX,
    /fetch\("\/first-agent"\)\.then\(\(r\) => r\.json\(\)\),/,
    "the initial answer must ride in the parallel load batch",
  );
});

test("the starting panel is a status, not a gate", () => {
  const panel = INDEX.match(/<div id="startingState">[\s\S]*?<\/div>/);
  assert.ok(panel, "the page must carry a #startingState panel");
  assert.doesNotMatch(panel![0], /<button/, "nothing to click: claude-home.ts exists to delete first-run screens");
  assert.doesNotMatch(panel![0], /onclick=/, "inline handlers are forbidden (invariant 12)");
});

test("the two no-agent panels are mutually exclusive", () => {
  assert.match(
    INDEX,
    /\$\("emptyState"\)\.classList\.toggle\("visible", !firstAgentPending\);\s*\n\s*\$\("startingState"\)\.classList\.toggle\("visible", firstAgentPending\);/,
    "inviting a new agent while one is being born is the bug this fixes",
  );
  assert.match(
    INDEX,
    /\$\("startingState"\)\.classList\.remove\("visible"\);/,
    "an active agent must clear the starting panel",
  );
});
