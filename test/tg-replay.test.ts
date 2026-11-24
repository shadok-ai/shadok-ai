import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { advanceMark, replayHeader, replayPlan, REPLAY_CAP, type ReplayTurn } from "../src/tg-replay.js";

/** A transcript around one gap: two turns delivered before it, two inside. */
const T = (at: number, role: string, text: string, extra: Partial<ReplayTurn> = {}): ReplayTurn => ({
  role,
  text,
  at,
  ...extra,
});

const TURNS: ReplayTurn[] = [
  T(1000, "user", "before the gap"),
  T(2000, "assistant", "answered before the gap"),
  T(3000, "user", "written during the gap"),
  T(4000, "assistant", "answered during the gap"),
];

// ── The rule ────────────────────────────────────────────────────────────────

test("no mark replays nothing — a binding never delivered through is a NEW mirror", () => {
  assert.deepEqual(replayPlan(TURNS, null), { post: [], dropped: 0 });
  assert.deepEqual(replayPlan(TURNS, undefined), { post: [], dropped: 0 });
});

test("only what was written after the mark is replayed, oldest first", () => {
  const plan = replayPlan(TURNS, { at: 2000 });
  assert.deepEqual(
    plan.post.map((t) => t.text),
    ["written during the gap", "answered during the gap"],
  );
  assert.equal(plan.dropped, 0);
});

test("a turn exactly AT the mark is already delivered, never replayed", () => {
  assert.deepEqual(replayPlan(TURNS, { at: 4000 }), { post: [], dropped: 0 });
});

test("a turn with no timestamp is never replayed — it cannot be placed", () => {
  // An older transcript has no `at`. Posting it would re-spam history on every
  // reconnect, which is what `backfill` exists to prevent.
  const turns = [{ role: "assistant", text: "undateable" }, T(5000, "assistant", "dated")];
  assert.deepEqual(
    replayPlan(turns, { at: 1 }).post.map((t) => t.text),
    ["dated"],
  );
});

test("roles with no Telegram rendering are skipped", () => {
  const turns = [
    T(3000, "bash", "ls -la"),
    T(3100, "social-draft", "a LinkedIn card"),
    T(3200, "file", "report.pdf"),
    T(3300, "assistant", "the only one that posts"),
  ];
  assert.deepEqual(
    replayPlan(turns, { at: 1 }).post.map((t) => t.text),
    ["the only one that posts"],
  );
});

test("an empty or blank turn is skipped", () => {
  const turns = [T(3000, "assistant", "   "), T(3100, "assistant", "real")];
  assert.deepEqual(
    replayPlan(turns, { at: 1 }).post.map((t) => t.text),
    ["real"],
  );
});

// ── The echo the mark itself carries ────────────────────────────────────────

test("the prompt the mark was taken from is not posted twice", () => {
  // An echo is marked with OUR delivery instant; Claude Code stamps the same
  // prompt into the transcript a moment later, so it legitimately sits after
  // the mark. Recognising its text is what keeps the topic from showing the
  // operator's own sentence twice — and a duplicate there is permanent.
  const turns = [T(3000, "user", "coupons la pub"), T(4000, "assistant", "the answer")];
  const plan = replayPlan(turns, { at: 2999, text: "coupons la pub" });
  assert.deepEqual(
    plan.post.map((t) => t.text),
    ["the answer"],
  );
});

test("the comparison ignores surrounding whitespace", () => {
  const turns = [T(3000, "user", "  same words\n")];
  assert.deepEqual(replayPlan(turns, { at: 2999, text: "same words" }).post, []);
});

test("the SAME sentence sent again later is still replayed — only the head is dropped", () => {
  const turns = [T(3000, "user", "ping"), T(3100, "assistant", "pong"), T(3200, "user", "ping")];
  assert.deepEqual(
    replayPlan(turns, { at: 2999, text: "ping" }).post.map((t) => t.text),
    ["pong", "ping"],
  );
});

test("an assistant turn at the head is never dropped by the text rule", () => {
  // The rule exists for a prompt echo only: an agent block carries the
  // transcript's own clock, so it can never be ahead of its own mark.
  const turns = [T(3000, "assistant", "same words")];
  assert.deepEqual(
    replayPlan(turns, { at: 2999, text: "same words" }).post.map((t) => t.text),
    ["same words"],
  );
});

// ── The cap ─────────────────────────────────────────────────────────────────

test("a long gap posts the most RECENT messages and counts the rest", () => {
  const many = Array.from({ length: 30 }, (_, i) => T(1000 + i, "assistant", `m${i}`));
  const plan = replayPlan(many, { at: 0 }, 5);
  assert.deepEqual(
    plan.post.map((t) => t.text),
    ["m25", "m26", "m27", "m28", "m29"],
  );
  assert.equal(plan.dropped, 25);
});

test("the shipped cap is a recovery, not a second incident", () => {
  assert.ok(REPLAY_CAP > 0 && REPLAY_CAP <= 50, `REPLAY_CAP=${REPLAY_CAP}`);
});

// ── The mark only ever moves forward ────────────────────────────────────────

test("advanceMark never goes backwards — two clocks feed it", () => {
  // A delivery instant and a transcript timestamp are different sources, so a
  // later delivery can carry an earlier number. Taking it would reopen a gap
  // that is closed and post into the topic again.
  assert.deepEqual(advanceMark({ at: 5000 }, { at: 4000 }), { at: 5000 });
  assert.deepEqual(advanceMark({ at: 4000 }, { at: 5000 }), { at: 5000 });
  assert.deepEqual(advanceMark(null, { at: 7000 }), { at: 7000 });
});

test("advanceMark keeps the echo's text, and drops it for a non-echo delivery", () => {
  assert.deepEqual(advanceMark(null, { at: 1, text: "typed" }), { at: 1, text: "typed" });
  // An agent block replaces the echo as the last delivered item, so the text
  // must go with it: the head rule would otherwise keep eating a prompt.
  assert.deepEqual(advanceMark({ at: 1, text: "typed" }, { at: 2 }), { at: 2 });
});

test("the replay announces itself, and says what it gave up on", () => {
  assert.match(replayHeader(1, 0), /1 message missed/);
  assert.match(replayHeader(3, 0), /3 messages missed/);
  assert.match(replayHeader(20, 7), /\+7 older not shown/);
});

// ── Source scans: the wiring cannot be exercised without a real bot ─────────

const TG = fs.readFileSync(new URL("../src/telegram.ts", import.meta.url), "utf8");
const SRV = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

test("both delivered paths move the resume point", () => {
  // If either stops marking, the mark goes stale and a reconnect re-posts
  // messages that were delivered — the failure mode opposite to the one fixed.
  const echo = TG.slice(TG.indexOf('case "prompt-echo"'), TG.indexOf('case "stream-tool"'));
  assert.match(echo, /markDelivered\(b, \{ at: Date\.now\(\), text:/);
  const stream = TG.slice(TG.indexOf('case "stream-text"'), TG.indexOf('case "prompt-echo"'));
  assert.match(stream, /markDelivered\(b, \{ at: typeof m\.at === "number" \? m\.at : Date\.now\(\) \}\)/);
});

test("a reattach gets a resume point, a fresh topic does not", () => {
  // `backfill` is a fresh topic's own replay; handing it a mark as well would
  // post the gap twice.
  assert.match(TG, /opts\.resumeId && !opts\.backfill/);
  assert.match(TG, /loadTgDelivered\(\)\[key\] \?\? null/);
});

test("the first history frame consumes the mark, whatever it decides", () => {
  // A second `history` on the same bridge must not replay the same window.
  const hist = TG.slice(TG.indexOf('case "history"'), TG.indexOf('case "ready"'));
  assert.match(hist, /b\.replayFrom = null;[\s\S]*?if \(!mark\) break;/);
  assert.match(hist, /replayPlan\(all, mark\)/);
});

test("a bridge closing says so — that is what opens the gap", () => {
  assert.match(TG, /bridge closed; nothing reaches this chat until it is reattached/);
});

test("the bridge is recognised by its SECRET, never by a client-settable origin", () => {
  // A browser can send `origin: "telegram"`; believing it would silence the
  // warning for exactly the client that cannot carry the mirror.
  assert.match(SRV, /__tgBridge\?: boolean \}\)\.__tgBridge = isTelegramBridge;/);
  const fn = SRV.slice(SRV.indexOf("function telegramBridgeAttached"), SRV.indexOf("function warnMirrorGap"));
  assert.ok(!/origin/.test(fn), "telegramBridgeAttached must not consult `origin`");
});

test("a lost echo is named, and only for a channel that has a mirror to miss", () => {
  const fn = SRV.slice(SRV.indexOf("function warnMirrorGap"), SRV.indexOf("function warnMirrorGap") + 1400);
  assert.match(fn, /telegramBridgeAttached\(s\)\) return;/);
  assert.match(fn, /\?\.telegram\) return;/);
  assert.match(SRV, /if \(origin !== "telegram"\) warnMirrorGap\(session, origin\);/);
});
