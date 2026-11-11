import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

// server.ts is un-importable, so the route's SHAPE is locked by scan (like
// test/instance-context-routes.test.ts) while the decision itself is unit-tested
// for real in test/tg-guests.test.ts (`guestPatchFlow`).
const SRC = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
function route(sig: string): string {
  const i = SRC.indexOf(sig);
  assert.ok(i >= 0, `missing ${sig}`);
  return SRC.slice(i, SRC.indexOf("\n});", i));
}

test("PUT /telegram: the guest setup is an admin write, decided by the pure flow", () => {
  const r = route('app.put("/telegram",');
  assert.match(r, /accountAdmin\(req, res, true,/);
  assert.match(r, /guestPatchFlow\(/);
  // A refusal must return before anything is written.
  assert.match(r, /if \(!flow\.ok\) return res\.status\(flow\.status\)/);
  assert.match(r, /saveGroups\(flow\.groups\)/);
  assert.match(r, /setGuestSetupForCwd\(/);
});

test("PUT /telegram: the group and profile are never read from the body beyond the flow's judgement", () => {
  const r = route('app.put("/telegram",');
  // The body feeds `want`, which the flow validates; nothing else may reach a
  // spawn. The frame path is covered in test/tg-guests.test.ts.
  assert.match(r, /previous: guestSetupForCwd\(loadConfig\(\), cwd\)/);
  assert.match(r, /profileExists: \(n\) => !!getProfile\(n\)/);
  assert.match(r, /mode: DEPLOYMENT_MODE/);
});

test("PUT /telegram: a guests change restarts the bridge, which reads the setup at start", () => {
  const r = route('app.put("/telegram",');
  assert.match(r, /if \(hasConfigChange \|\| guestsChanged\) restartTelegram\(\)/);
});

test("GET /telegram: the picker's choices are resolved per caller, never instance-wide", () => {
  const r = route('app.get("/telegram",');
  assert.match(r, /telegramState\(viewerFor\(currentAccount\(req\)\)\)/);
  const st = SRC.slice(SRC.indexOf("async function telegramState("));
  const body = st.slice(0, st.indexOf("\n}\n"));
  assert.match(body, /guestGroupChoices\(loadGroups\(\), viewer\)/);
  // Still never the token (it is write-only), and never a group's member list.
  assert.doesNotMatch(body, /token:\s*tc\.token/);
  assert.match(body, /\{ id: g\.id, name: g\.name \}/);
});

// ── the WS `start` handler's guest branch ─────────────────────────────────
// The real observation (a guest's channel row carrying the configured group)
// is an end-to-end run on a free port, recorded in the PR; this locks the
// SHAPE so a refactor cannot quietly drop a condition.
const START = (() => {
  const i = SRC.indexOf('case "start": {');
  assert.ok(i >= 0, "start handler not found");
  const j = SRC.indexOf('case "prompt"', i);
  assert.ok(j > i, "end of the start handler not found");
  return SRC.slice(i, j);
})();

test("start: the guest decision is the pure plan, fed the proof and the config", () => {
  // The rules themselves (unproven marker ignored, resume ignored, shut door
  // refused) are tested for real in test/tg-guests.test.ts.
  assert.match(START, /guestSpawnPlan\(\{/);
  assert.match(START, /fromBridge: isTelegramBridge/);
  assert.match(START, /resuming: !!msg\.resume/);
  assert.match(START, /setup: msg\.guest === true \? guestSetupForCwd\(loadConfig\(\), process\.cwd\(\)\) : GUEST_SETUP_OFF/);
  assert.match(START, /if \(guestPlan\.kind === "refused"\) return fail\(guestPlan\.message, guestPlan\.code\)/);
});

test("start: a guest's group and profile come from the config, not from the frame", () => {
  // Both isolation resolutions (the early token pre-check and the real one)
  // must prefer the configured group, or they would disagree about the OS user.
  assert.equal((START.match(/guestGroupId \?\?/g) ?? []).length, 2);
  assert.match(START, /guestSetup \? guestSetup\.profile : msg\.profile \?\? null/);
});

test("start: a guest's agent lands in the configured group or nowhere (invariant 24)", () => {
  assert.match(START, /if \(guestSetup && agentGroupId !== guestSetup\.group\)/);
  assert.match(START, /"guest-group"/);
});

test("start: a guest gets no worktree, and runs in its group's own home", () => {
  assert.match(START, /if \(msg\.worktree && !resumed && !guestSetup && isGitRepo\(cwd\)\)/);
  assert.match(START, /if \(guestSetup\) effectiveCwd = agentStateHome\(earlyUser\)/);
});

// ── the bridge's call sites use those rules ───────────────────────────────
const TG = fs.readFileSync(new URL("../src/telegram.ts", import.meta.url), "utf8");

test("telegram: a guest's command is refused ABOVE the operator allowlist", () => {
  const i = TG.indexOf("if (guest && cmd) {");
  const j = TG.indexOf("if (cmd && commandRequiresOperator(");
  assert.ok(i >= 0 && j > i, "the guest refusal must come first");
  assert.match(TG.slice(i, j), /guestCommandRefusal\(cmd\.cmd\)/);
  assert.match(TG.slice(i, j), /guestCommandCarriesSecret\(cmd\.cmd\)/);
  assert.match(TG.slice(i, j), /deleteMessage/);
});

test("telegram: the DM callback gate asks guestCallbackAllowed, with the open-DM switch", () => {
  assert.match(TG, /guestCallbackAllowed\(dmGate\(loadTgOwner\(\), cq\.from\?\.id, guestsOn\), msg\.chat\?\.id, cq\.from\?\.id\)/);
});

test("telegram: a guest's DM is recognised by DERIVING it, not by storing a flag", () => {
  assert.match(TG, /const isGuestChat = \(chatId: number, threadId\?: number\) =>/);
  assert.match(TG, /guestsOn && threadId == null && chatId > 0 && chatId !== loadTgOwner\(\)/);
  assert.match(TG, /guest: isGuestChat\(chatId, threadId\)/);
});

test("telegram: every line the bridge authors ABOUT ITSELF goes through sendOps", () => {
  // The guard for the next one added: a bare `send(b, "⚠️ …")` would reach a
  // stranger in the cockpit's own words. The ONE exception is the mirrored
  // topic's backfill header, which cannot reach a DM at all — `b.backfill` is
  // set only when a web channel's topic is freshly created.
  const EXEMPT = [/^— history resumed/];
  const offenders = [...TG.matchAll(/\bsend\(b, (?:"|`)([^"`]*)/g)]
    .map((m) => m[1])
    .filter((text) => /⚠️|⏸️|♻️|🎬|^—/.test(text))
    .filter((text) => !EXEMPT.some((re) => re.test(text)));
  assert.deepEqual(offenders, []);
});

test("telegram: sendOps replaces the cockpit's wording for a guest, or says nothing", () => {
  const i = TG.indexOf("const sendOps = (b: Bridge");
  assert.ok(i >= 0, "sendOps not found");
  const body = TG.slice(i, TG.indexOf("\n  };", i));
  assert.match(body, /if \(!b\.guest\) return send\(b, text\)/);
  assert.match(body, /guestNotice\(kind\)/);
});
