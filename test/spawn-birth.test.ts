import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { spawnStepStates } from "../public/spawn-steps.js";
import {
  announceFirstAgent,
  endFirstAgentGreeting,
  firstAgentStatus,
  greetFirstAgent,
  settleAfterSpawn,
  settleFirstAgent,
} from "../src/first-agent.js";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const firstAgentSrc = fs.readFileSync(new URL("../src/first-agent.ts", import.meta.url), "utf8");
const states = (cur: unknown, o?: { hello?: boolean }) => spawnStepStates(cur, o).map((s) => s.state);

test("an ordinary spawn has three steps; the first agent adds 'Saying hello'", () => {
  assert.equal(spawnStepStates(null).length, 3);
  assert.deepEqual(states("claude", { hello: true }), ["done", "done", "on", "todo"]);
  assert.deepEqual(states("hello", { hello: true }), ["done", "done", "done", "on"]);
  assert.equal(spawnStepStates("hello", { hello: true })[3].label, "Saying hello");
  // Without the option, "hello" is not a step of this spawn: it reads as the start.
  assert.deepEqual(states("hello"), ["on", "todo", "todo"]);
});

test("the greeting keeps the first-agent wait open until that session's turn ends", () => {
  announceFirstAgent(0);
  greetFirstAgent("abc");
  assert.deepEqual(firstAgentStatus(), { pending: true, reason: "starting", step: "hello", greeting: "abc" });
  // The spawn's own exit must not end a wait the greeting now owns.
  settleAfterSpawn();
  assert.equal(firstAgentStatus().pending, true);
  endFirstAgentGreeting("someone-else");
  assert.equal(firstAgentStatus().pending, true);
  endFirstAgentGreeting("abc");
  assert.deepEqual(firstAgentStatus(), { pending: false, reason: "first-boot", step: null, greeting: null });
});

test("with no greeting, the spawn's exit settles the wait as before", () => {
  announceFirstAgent(0);
  settleAfterSpawn();
  assert.equal(firstAgentStatus().pending, false);
  // A greeting cannot reopen a settled wait.
  greetFirstAgent("late");
  assert.equal(firstAgentStatus().pending, false);
  settleFirstAgent("first-boot");
});

test("ensureFirstAgent's finally goes through settleAfterSpawn", () => {
  const fin = firstAgentSrc.slice(firstAgentSrc.indexOf("} finally {", firstAgentSrc.indexOf("export async function ensureFirstAgent")));
  assert.match(fin.slice(0, 900), /settleAfterSpawn\(\)/);
});

test("the server holds the wait for the greeting, ends it on delivery, and has a guard", () => {
  const g = server.slice(server.indexOf("function greetHomeAgent"), server.indexOf("async function startFirstAgent"));
  assert.ok(g.indexOf("greetFirstAgent(id)") > g.indexOf("homeGreetingBrief("), "hold only once the brief is built");
  // A delivery that FAILED ends the wait; a "delivered" one does not — its
  // turn-done can be a false early end (measured: ~3s after the prompt, while the
  // lead was still thinking for 28s). The first TEXT ends it instead (below).
  assert.match(g, /\.then\(\(res\) => \{(?:\s*\/\/[^\n]*)*\s*if \(!res\.ok\) endFirstAgentGreeting\(id\);/);
  assert.match(g, /setTimeout\(\(\) => endFirstAgentGreeting\(id\), GREETING_WAIT_MAX_MS\)/);
});

test("the page shows the loader at once, before the socket opens", () => {
  const lt = html.slice(html.indexOf("function launchTab(t, msg) {"), html.indexOf("function openLink(t) {"));
  assert.ok(lt.indexOf("showSpawnLoader(t)") >= 0 && lt.indexOf("showSpawnLoader(t)") < lt.indexOf("openLink(t)"));
});

test("the lead's tab stays on the loader until it has answered", () => {
  // Born in birth mode when the sync discovers it while the first agent is pending.
  assert.match(html, /if \(isMain\(c\) && firstAgentPending\) startBirth\(nt\);/);
  // `ready` (a resume) must not drop a birth loader…
  const ready = html.indexOf('      case "ready":');
  assert.match(html.slice(ready, ready + 300), /if \(!t\.birth\) clearSpawnLoader\(t\);/);
  // …the first answer does…
  const st = html.indexOf('      case "stream-text":');
  assert.match(html.slice(st, st + 200), /endBirth\(t\);/);
  // …and so does the wait ending, whatever the reason.
  const sf = html.slice(html.indexOf("async function syncFirstAgent()"), html.indexOf("const SYNC_IDLE_MS"));
  assert.match(sf, /endBirth\(/);
  assert.match(sf, /startBirth\(/);
  // While it is up, the transcript underneath (history, the system line) is hidden.
  assert.match(html, /\.transcript\.birth > :not\(\.spawn-loader\) \{ display: none; \}/);
});

test("the lead's first text block is what ends the greeting wait", () => {
  const i = server.indexOf('broadcast(s, { type: "stream-text", text: e.text');
  assert.ok(i > 0);
  assert.match(server.slice(i, i + 400), /endFirstAgentGreeting\(s\.id\)/);
});

test("the page asks about the first agent BEFORE it builds tabs on its first pass", () => {
  const loop = html.slice(html.indexOf("async function syncLoop()"), html.indexOf("async function syncLoop()") + 900);
  assert.ok(loop.indexOf("syncFirstAgent()") < loop.indexOf("await syncChannels()"), "a lead discovered on the first pass must be born in birth mode");
});
