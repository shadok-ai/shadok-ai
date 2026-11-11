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
  // An unspelled mode is the CLASSIC one: a hand-made request must never open a
  // door by omitting a field.
  assert.match(r, /mode: normalizeTgMode\(g\.mode\)/);
  assert.match(r, /previous: guestSetupForCwd\(loadConfig\(\), cwd\)/);
  assert.match(r, /profileExists: \(n\) => !!getProfile\(n\)/);
  assert.match(r, /mode: DEPLOYMENT_MODE/);
  // The pairing prerequisite is read server-side, never taken from the body.
  assert.match(r, /hasOwner: loadTgOwner\(\) !== null/);
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

test("telegram: the DM callback gate asks guestCallbackAllowed, with the mode", () => {
  assert.match(
    TG,
    /guestCallbackAllowed\(dmGate\(loadTgOwner\(\), cq\.from\?\.id, guestsOn, dmOnlyMode\), msg\.chat\?\.id, cq\.from\?\.id\)/,
  );
});

test("telegram: a guest's DM is recognised by DERIVING it, not by storing a flag", () => {
  assert.match(TG, /const isGuestChat = \(chatId: number, threadId\?: number\) =>/);
  // In DM-only mode there is no owner to except — the operator's own DM included.
  assert.match(TG, /guestsOn && threadId == null && chatId > 0 && \(dmOnlyMode \|\| chatId !== loadTgOwner\(\)\)/);
  assert.match(TG, /guest: isGuestChat\(chatId, threadId\)/);
});

test("telegram: the mode is read ONCE at start, like the rest of the config", () => {
  // The panel restarts the bridge when it changes, so a read per message would
  // buy nothing and a stale copy is impossible.
  assert.match(TG, /const tgSetup = guestSetupForCwd\(loadConfig\(\), process\.cwd\(\)\);/);
  assert.match(TG, /const guestsOn = guestsOpen\(tgSetup\);/);
  assert.match(TG, /const dmOnlyMode = dmOnly\(tgSetup\);/);
});

test("telegram: DM-only turns a group away ABOVE the board logic, /setup included", () => {
  // A group bound BEFORE the switch must stop working too, or the mode's
  // guarantee would depend on when the instance was set up. Binding a board and
  // becoming an operator both live below that line.
  const i = TG.indexOf("const groupClosed = groupChatRefusal(tgSetup);");
  assert.ok(i >= 0, "the group refusal is missing");
  const board = TG.indexOf("// One board per instance: a group must be the bound group.");
  assert.ok(board > i, "the refusal must come before the board logic");
  assert.match(TG.slice(i, board), /if \(isGroup && groupClosed\)/);
  // A click in a group is gated the same way: no board means nothing to click in.
  assert.match(TG, /callbackChatAllowed\(msg\.chat, allowed, dmOnlyMode \? null : loadTgGroup\(\)\)/);
});

test("telegram: DM-only adopts no owner — the mode says the bot has none", () => {
  assert.match(TG, /if \(dmOnlyMode \|\| loadTgOwner\(\) !== null\) return;/);
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

test("telegram: DM bridges are reattached ABOVE the board-group gate, in both reconcilers", () => {
  // An instance that opened its DMs may never bind a board group; the gate used
  // to make every reconciler return before any DM was looked at.
  assert.match(TG, /const reattachDmBridges = \(\) => \{/);
  for (const fn of ["const reconcileWebChannels = async () => {", "const reconcileOnBoot = async () => {"]) {
    const i = TG.indexOf(fn);
    assert.ok(i >= 0, fn);
    const head = TG.slice(i, TG.indexOf("loadTgGroup()", i));
    assert.match(head, /reattachDmBridges\(\)/, fn);
  }
});

test("telegram: the owner is never adopted from a guest's DM, and a guest keeps its own name", () => {
  assert.match(TG, /ownerAdoptionCandidate\(c, guestGroup\)/);
  assert.match(TG, /const name = b\.guest \|\| b\.threadId \?/);
});

// ── the panel ─────────────────────────────────────────────────────────────
const HTML = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("panel: the mode picker exists, with its two solidary group/profile pickers", () => {
  for (const id of ["tgGuestsField", "tgMode", "tgGuestGroup", "tgGuestProfile", "tgGuestsNote"]) {
    assert.ok(HTML.includes(`id="${id}"`), id);
  }
  // The three modes, and the classic one FIRST — it is the default, and the
  // only one that changes nothing about an existing instance.
  const i = HTML.indexOf('id="tgMode"');
  const field = HTML.slice(i, HTML.indexOf("</select>", i));
  assert.match(field, /<option value="group">/);
  assert.match(field, /<option value="group\+dm">/);
  assert.match(field, /<option value="dm-only">/);
  assert.ok(field.indexOf('"group"') < field.indexOf('"group+dm"'), "the classic mode comes first");
  // Wired through addEventListener, never an inline handler (invariant 12).
  assert.match(HTML, /for \(const id of \["tgMode", "tgGuestGroup", "tgGuestProfile"\]\)/);
  assert.doesNotMatch(HTML.slice(HTML.indexOf('id="tgGuestsField"'), HTML.indexOf('id="tgGuestsField"') + 1200), /onchange=|onclick=/);
});

test("panel: a DM-only instance is never told to bind a group it cannot have", () => {
  // The status line, the pairing button and the guide all presented the board
  // group as a step everyone owes — on this mode it is refused on purpose.
  const i = HTML.indexOf("const dmOnlyMode = (s.guests && s.guests.mode) === \"dm-only\";");
  assert.ok(i >= 0, "renderTelegram does not know the mode");
  const body = HTML.slice(i, i + 1400);
  assert.match(body, /private messages only/);
  assert.match(body, /\$\("tgPair"\)\.hidden = dmOnlyMode;/);
  assert.match(body, /!\(s\.hasToken && \(s\.boundGroup \|\| dmOnlyMode\)\)/);
});

test("panel: a refused save re-reads the server's state, so the box cannot lie", () => {
  const i = HTML.indexOf("async function saveGuests()");
  assert.ok(i >= 0);
  const body = HTML.slice(i, HTML.indexOf("\n  }", i));
  // Whatever happens: the server is the authority on whether the door is open.
  assert.match(body, /loadTelegram\(\)/);
  assert.match(body, /if \(!r\.ok\) alert/);
});

test("panel: each prerequisite is stated on the option it blocks, not discovered by saving", () => {
  // An open mode needs a restricted group; `group+dm` also needs the DMs
  // paired, and `dm-only` is exempt because it removes the owner altogether.
  assert.match(
    HTML,
    /o\.disabled = \(o\.value !== "group" && !groups\.length\) \|\| \(o\.value === "group\+dm" && !s\.dmOwned\);/,
  );
  const i = HTML.indexOf('$("tgGuestsNote").textContent');
  const note = HTML.slice(i, i + 1600);
  assert.match(note, /Pair the bot's private messages first/);
  // …and the way out of that prerequisite is named, not left to be guessed.
  assert.match(note, /nobody pairs at all/);
  assert.match(note, /refused everywhere/);
});

test("panel: the note says what the group buys, and never claims a wall it has not", () => {
  const i = HTML.indexOf("const WALL =");
  assert.ok(i >= 0);
  const note = HTML.slice(i, i + 1600);
  assert.match(note, /own Unix user/);
  // Its members CAN read those conversations — said, not glossed (invariant 47).
  assert.match(note, /can read them/);
  assert.match(note, /privileged deployment/);
});

// ── a guest's /start, and an agent that was deleted ───────────────────────

test("telegram: a guest's /start never reaches the command dispatcher", () => {
  // `case "start"` prints the cockpit's help page — /spawn, /secret, /login —
  // which is the operator's vocabulary in a stranger's chat (invariant 65).
  const i = TG.indexOf("if (guest && cmd) {");
  const j = TG.indexOf("if (cmd && commandRequiresOperator(");
  assert.ok(i >= 0 && j > i);
  const block = TG.slice(i, j);
  assert.match(block, /guestOpening = true;/);
  assert.match(block, /cmd = null;/);
  // …and the raw "/start" is never forwarded either: a leading slash is a
  // command to the TUI, not a sentence.
  assert.match(TG, /if \(guestOpening\) \{\n\s+promptTo\(b, guestOpeningPrompt\(msg\.from\?\.language_code\), senderName\(msg\.from\)\);/);
  // The dispatcher is reached through `cmd`, so nulling it is what skips it.
  assert.match(TG, /let cmd = typeof msg\.text === "string" \? parseCommand\(msg\.text\) : null;/);
});

test("telegram: an agent that was ENDED takes its bridge with it", () => {
  // Otherwise the next message goes into a dead session and the person is told
  // "something went wrong" for ever, with no way out on their side.
  const i = TG.indexOf('case "stopped":');
  assert.ok(i >= 0, "the bridge ignores the stopped frame");
  const body = TG.slice(i, TG.indexOf("break;", i));
  assert.match(body, /ws\.close\(\)/);
  assert.match(body, /b\.typing\.stop\(\)/);
});

test("telegram: a bridge whose channel is gone is never reused", () => {
  // The registry is the authority on where a session lives (invariant 1) — a
  // live socket proves only that the server is up.
  const i = TG.indexOf("const bridgeFor = (key: string");
  const body = TG.slice(i, TG.indexOf("const saved = channelForTelegram", i));
  assert.match(body, /loadChannels\(\)\.some\(\(c\) => c\.sessionId === existing\.sessionId\)/);
  assert.match(body, /bridges\.delete\(key\)/);
  // A bridge that has not reached `ready` yet has no session to check against.
  assert.match(body, /!existing\.sessionId \|\|/);
});
