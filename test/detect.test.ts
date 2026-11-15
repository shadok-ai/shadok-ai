import assert from "node:assert/strict";
import test from "node:test";
import { idleStep, screenShowsWork, inputHasProbe, inputText, boxText, boxRaw, shouldHardClear, describeStuckScreen, nextScreenDelay, SCREEN_FAST_MS, SCREEN_SLOW_MS, typeIntoBox } from "../src/detect.js";

const idle = [
  "⏺ Done.",
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  10:59:45  elapsed:2m  ctx:17%  ~$0,144  5h:5%",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

test("idle input line is not working", () => {
  assert.equal(screenShowsWork(idle), false);
});

test("empty / blank screen is not working", () => {
  assert.equal(screenShowsWork(""), false);
  assert.equal(screenShowsWork("\n\n  \n"), false);
});

test("a live spinner with (elapsed first · …) is working", () => {
  assert.equal(screenShowsWork("✽ Jitterbugging… (4m 26s · ↓ 7.1k tokens · esc to interrupt)"), true);
  assert.equal(screenShowsWork("✶ Gallivanting… (16s · ↓ 136 tokens)"), true);
  assert.equal(screenShowsWork("✻ Crunched… (1h 2m 3s · ↑ 40 tokens)"), true);
});

test("a finished turn (past tense, no parens) is NOT working", () => {
  assert.equal(screenShowsWork("✻ Baked for 8m 20s"), false);
  assert.equal(screenShowsWork("✻ Cooked for 6s"), false);
});

test("a completion line with the elapsed LAST is NOT working", () => {
  assert.equal(screenShowsWork("Done (12 files · 5m 40s)"), false);
});

test("genuine unquoted 'esc to interrupt' status is working", () => {
  assert.equal(screenShowsWork("  · esc to interrupt"), true);
  assert.equal(screenShowsWork("(esc to interrupt)"), true);
});

test("a QUOTED 'esc to interrupt' in prose is NOT working (the self-reference bug)", () => {
  // Claude explaining shadok-ai's own detection must not trip it.
  assert.equal(
    screenShowsWork('the end of a turn is detected (no more "esc to interrupt" + a stable screen).'),
    false,
  );
  assert.equal(screenShowsWork("uses the “esc to interrupt” marker"), false);
  assert.equal(screenShowsWork("the 'esc to interrupt' marker is gone"), false);
});

test("the ctx:/cost footer alone is not working", () => {
  assert.equal(screenShowsWork("  11:08:13  elapsed:34h05m41s  ctx:4%  ~$0,144"), false);
});

test("inputHasProbe: true while typed text sits in the input box", () => {
  const screen = "some history\n\n❯ Refactor the pars\n\n  auto mode on";
  assert.equal(inputHasProbe(screen, "Refactor the par"), true);
});

test("inputHasProbe: false once the box cleared after Enter (even if echo scrolled away)", () => {
  // The prompt was sent; the input box is empty and the echo is gone.
  const cleared = "✻ Baked for 3s\n\n❯ \n\n  auto mode on";
  assert.equal(inputHasProbe(cleared, "Refactor the par"), false);
});

test("inputHasProbe: false when the probe is only in scrollback, not the input line", () => {
  // A fast turn: the echo is still visible above but the box is empty.
  const scrolled = "❯ Refactor the parser now\n⏺ done.\n\n❯ \n";
  assert.equal(inputHasProbe(scrolled, "Refactor the par"), false);
});

test("inputText: reads the ❯ input box and strips the prompt", () => {
  assert.equal(inputText("history\n❯ hello world\n\n  footer"), "hello world");
  assert.equal(inputText("❯ "), "");
});

test("inputText: shell mode — the '!' box padded with a non-breaking space", () => {
  // The TUI pads the shell prompt with U+00A0, not a regular space.
  assert.equal(inputText("────\n!  echo hi\n────\n  ! for shell mode"), "echo hi");
  assert.equal(inputText("! \n────\n  ! for shell mode"), ""); // empty shell box
});

// ── idleStep: when is a turn over? ──────────────────────────────────────────

const WORKING = "✻ Jitterbugging… (4m 26s · ↓ 7.1k tokens)";
const IDLE = "❯ \n  ? for shortcuts";

test("idleStep: a screen that keeps changing never settles", () => {
  let st = { stableSince: 0, lastScreen: "" };
  for (let t = 0; t < 10_000; t += 160) {
    st = idleStep(IDLE + t, st.lastScreen, st.stableSince, t, 2000);
    assert.equal(st.done, false, `settled at ${t}ms on a moving screen`);
  }
});

test("idleStep: settles only once the window has fully elapsed", () => {
  // First sighting starts the clock but never settles on the spot.
  let st = idleStep(IDLE, IDLE, 0, 1000, 2000);
  assert.equal(st.done, false);
  assert.equal(st.stableSince, 1000, "the clock starts at the first stable poll");
  assert.equal(idleStep(IDLE, IDLE, 1000, 2999, 2000).done, false, "one ms short is not settled");
  assert.equal(idleStep(IDLE, IDLE, 1000, 3000, 2000).done, true, "exactly the window settles");
});

test("idleStep: a working screen never settles, however still it is", () => {
  // Byte-identical for a minute, but the spinner says otherwise.
  assert.equal(idleStep(WORKING, WORKING, 1000, 61_000, 2000).done, false);
  // …and it resets the clock, so calm afterwards is measured from scratch.
  assert.equal(idleStep(WORKING, WORKING, 1000, 61_000, 2000).stableSince, 0);
});

test("idleStep: a shorter window settles sooner, on the same screen", () => {
  // The point of the interrupt path: same evidence, lower bar. 400ms is enough
  // once the user has explicitly asked the turn to stop.
  assert.equal(idleStep(IDLE, IDLE, 1000, 1400, 2000).done, false, "the normal window still waits");
  assert.equal(idleStep(IDLE, IDLE, 1000, 1400, 400).done, true, "the short window is done");
  // But a shorter window must NOT excuse a screen that is still working.
  assert.equal(idleStep(WORKING, WORKING, 1000, 61_000, 400).done, false);
});

test("nextScreenDelay: a moving screen is polled fast", () => {
  assert.equal(nextScreenDelay(0, false), SCREEN_FAST_MS);
  assert.equal(nextScreenDelay(2, false), SCREEN_FAST_MS);
});

test("nextScreenDelay: stillness backs off, and is capped", () => {
  // Geometric, so a session that has been quiet for hours costs almost nothing,
  // while one that just went quiet is still nearly live.
  assert.equal(nextScreenDelay(3, false), 600);
  assert.equal(nextScreenDelay(4, false), 1200);
  assert.equal(nextScreenDelay(5, false), SCREEN_SLOW_MS);
  assert.equal(nextScreenDelay(500, false), SCREEN_SLOW_MS);
});

test("nextScreenDelay: a busy session is never slowed", () => {
  // A running turn is when the screen moves most — and there are only ever a
  // handful of busy sessions, so the cost stays bounded.
  assert.equal(nextScreenDelay(999, true), SCREEN_FAST_MS);
});

test("nextScreenDelay: the delay never shrinks as stillness grows", () => {
  let prev = 0;
  for (let n = 0; n <= 12; n++) {
    const d = nextScreenDelay(n, false);
    assert.ok(d >= prev, `streak ${n}: ${d} < ${prev}`);
    assert.ok(d >= SCREEN_FAST_MS && d <= SCREEN_SLOW_MS);
    prev = d;
  }
});

// A fake input box for typeIntoBox: `paste` may land LATE (per-call delay, to
// model a slow/freshly-respawned pane) or never (`null`, a paste the TUI
// flushed), `clearInput` empties it, and `waitFor` polls a rendered "❯ <box>"
// screen — exactly what inputText reads. `rest` is what the box DISPLAYS while
// empty: Claude Code 2.1.285 shows a rotating example there before the first
// prompt of a session (`❯ Try "refactor <filepath>"`), and puts it back after a
// Ctrl-U. `restAfterClear` models it coming back as a DIFFERENT example.
function fakeBox(landDelays: (number | null)[], { rest = "", restAfterClear }: { rest?: string; restAfterClear?: string } = {}) {
  const st = { box: "", rest, pastes: 0, clears: 0 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const render = () => "❯ " + (st.box || st.rest);
  return {
    st,
    paste(text: string) {
      const d = st.pastes < landDelays.length ? landDelays[st.pastes] : 0;
      st.pastes++;
      if (d === null) return;
      if (d <= 0) st.box += text;
      else setTimeout(() => (st.box += text), d);
    },
    clearInput() {
      st.box = "";
      st.clears++;
      if (restAfterClear !== undefined) st.rest = restAfterClear;
    },
    hardClear() {
      st.box = "";
    },
    screen: render,
    async waitFor(pred: (s: string) => boolean, opts?: { timeoutMs?: number }) {
      const deadline = Date.now() + (opts?.timeoutMs ?? 1000);
      while (Date.now() < deadline) {
        const screen = render();
        if (pred(screen)) return screen;
        await sleep(2);
      }
      throw new Error("timeout");
    },
  };
}

test("typeIntoBox: a SLOW first paste is not doubled (the reload-nudge bug)", async () => {
  // Paste 1 lands at ~30ms — AFTER the 15ms appear check, so that attempt times
  // out; paste 2 lands at once. The old recovery (immediate Ctrl-U) cleared an
  // empty box, the late paste arrived, and attempt 2 pasted on top → "XX".
  const p = fakeBox([30, 0]);
  const ok = await typeIntoBox(p, "HELLO", { appearMs: 15, settleMs: 45, clearMs: 45 });
  assert.equal(ok, true);
  assert.equal(p.st.box, "HELLO"); // exactly ONE copy — not "HELLOHELLO"
});

test("typeIntoBox: a prompt that appears at once is typed exactly once", async () => {
  const p = fakeBox([0]);
  const ok = await typeIntoBox(p, "HI", { appearMs: 50 });
  assert.equal(ok, true);
  assert.equal(p.st.box, "HI");
  assert.equal(p.st.pastes, 1); // no needless retry on the happy path
});

const HINT = 'Try "refactor <filepath>"';
const FAST = { appearMs: 15, settleMs: 10, clearMs: 20 };

test("typeIntoBox: a paste that never lands is reported, even when the box shows a hint", async () => {
  // The pinned bug: the box read `Try "…"` BEFORE anything was pasted, the old
  // "box is non-empty" check took that for the paste, and Enter was pressed on
  // a box holding nothing — the agent received nothing, in silence.
  const p = fakeBox([null, null, null], { rest: HINT });
  const ok = await typeIntoBox(p, "HELLO", { ...FAST, attempts: 3 });
  assert.equal(ok, false);
  assert.equal(p.st.pastes, 3); // every attempt was really made
});

test("typeIntoBox: a paste that never lands into an EMPTY box is reported", async () => {
  const p = fakeBox([null, null], { rest: "" });
  assert.equal(await typeIntoBox(p, "HELLO", { ...FAST, attempts: 2 }), false);
});

test("typeIntoBox: a paste replacing the hint is recognised at once", async () => {
  const p = fakeBox([0], { rest: HINT });
  assert.equal(await typeIntoBox(p, "HELLO", FAST), true);
  assert.equal(p.st.box, "HELLO");
  assert.equal(p.st.pastes, 1); // no needless retry
  // And nothing was cleared on the way: a box showing only a suggestion costs
  // the ordinary message nothing at all. That is the whole reason the dirty-box
  // case is detected AFTER the paste rather than guarded before it.
  assert.equal(p.st.clears, 0);
});

test("typeIntoBox: a SLOW paste into a hinted box lands on the 2nd attempt, once", async () => {
  // Paste 1 lands after its appear window; the recovery must let it land,
  // clear it — and accept the hint coming back as "cleared" — then paste
  // again. The same text pasted twice must still read as "landed".
  const p = fakeBox([30, 0], { rest: HINT });
  const ok = await typeIntoBox(p, "HELLO", { appearMs: 15, settleMs: 45, clearMs: 45, attempts: 3 });
  assert.equal(ok, true);
  assert.equal(p.st.box, "HELLO"); // one copy, not "HELLOHELLO"
  assert.equal(p.st.pastes, 2);
  // Bounded, not counted to the press: what matters is that the late paste was
  // removed before the retry (hence exactly one copy above), and that a box
  // showing only the example is not hammered. The exact number moves with the
  // tolerance for a press whose effect renders slowly.
  assert.ok(p.st.clears >= 1 && p.st.clears <= 6, `clears=${p.st.clears}`);
});

test("typeIntoBox: a hint that changes across a clear is not mistaken for the paste", async () => {
  // Not observed (the example stayed put across a Ctrl-U on 2.1.285), but the
  // baseline is re-read on every attempt so that it cannot matter.
  const p = fakeBox([null, null], { rest: HINT, restAfterClear: 'Try "how does <filepath> work?"' });
  assert.equal(await typeIntoBox(p, "HELLO", { ...FAST, attempts: 2 }), false);
});

// Claude Code's Ctrl-U clears ONE line (seen on 2.1.296): the text of the line
// the cursor is on, then — pressed again on an empty line — the newline above.
function lineBox(landDelays: number[], initial = "") {
  const st = { box: initial, pastes: 0, clears: 0 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const render = () => "❯ " + st.box.split("\n").join("\n  ");
  return {
    st,
    paste(text: string) {
      const d = landDelays[st.pastes++] ?? 0;
      if (d <= 0) st.box += text;
      else setTimeout(() => (st.box += text), d);
    },
    clearInput() {
      st.clears++;
      const nl = st.box.lastIndexOf("\n");
      st.box = nl === st.box.length - 1 ? st.box.slice(0, -1) : st.box.slice(0, nl + 1);
    },
    hardClear() {
      st.box = "";
    },
    screen: render,
    async waitFor(pred: (s: string) => boolean, opts?: { timeoutMs?: number }) {
      const deadline = Date.now() + (opts?.timeoutMs ?? 1000);
      while (Date.now() < deadline) {
        if (pred(render())) return render();
        await sleep(2);
      }
      throw new Error("timeout");
    },
  };
}

/*
 * The pane as the TUI really behaves, read through a POLLER'S MIRROR.
 *
 * `lineBox` above is a perfect oracle: `waitFor` sees every keypress the
 * instant it happens. TmuxPilot is not — `waitFor` polls a mirror refreshed by
 * a timer (`SCREEN_FAST_MS`), while `screen()` is a capture of its own. That
 * gap is the whole bug this models: it is invisible to a fake where the two are
 * the same string, which is why the first fix shipped and the box still filled
 * up in production.
 *
 * `rest` is what an EMPTY box displays — Claude Code's rotating example — so an
 * empty box reads non-blank here exactly as it does on a pane.
 */
function mirroredLineBox(
  landDelays: number[],
  { initial = "", rest = "", clearWorks = true, working = false, stalledClears = [] as number[] } = {},
) {
  const st = { box: initial, pastes: 0, clears: 0, hardClears: 0 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const render = () =>
    "❯ " + (st.box ? st.box.split("\n").join("\n  ") : rest) + (working ? "\n──────────\n  ⏵⏵ auto mode on · esc to interrupt" : "");
  // The mirror normally keeps up. `stalledClears` names the presses during
  // which the poller does not run at all — the server's event loop blocked by
  // twenty synchronous captures — so `waitFor` keeps being handed the screen as
  // it was BEFORE that press, for the whole window it is given.
  let frozen: string | null = null;
  const readMirror = () => frozen ?? render();
  return {
    st,
    paste(text: string) {
      const d = landDelays[st.pastes++] ?? 0;
      frozen = null;
      if (d === 0) st.box += text;
      // A paste the TUI flushed: `NEVER` models it without a timer the test
      // runner would then wait on.
      else if (d !== NEVER) setTimeout(() => (st.box += text), d);
    },
    clearInput() {
      st.clears++;
      const before = render();
      if (clearWorks) {
        const nl = st.box.lastIndexOf("\n");
        st.box = nl === st.box.length - 1 ? st.box.slice(0, -1) : st.box.slice(0, nl + 1);
      }
      frozen = stalledClears.includes(st.clears) ? before : null;
    },
    hardClear() {
      st.hardClears++;
      st.box = "";
      frozen = null;
    },
    screen: render,
    async waitFor(pred: (s: string) => boolean, opts?: { timeoutMs?: number }) {
      const deadline = Date.now() + (opts?.timeoutMs ?? 1000);
      while (Date.now() < deadline) {
        const screen = readMirror();
        if (pred(screen)) return screen;
        await sleep(2);
      }
      throw new Error("timeout");
    },
  };
}

const HEADER = "⟦telegram · 2026-10-26 21:27 · Alexandre Cognard⟧";
/** A paste that never lands at all. */
const NEVER = -1;

test("boxRaw keeps the blank line boxText trims away", () => {
  // The middle Ctrl-U of a two-line clear removes the now-empty second line.
  // Trimmed, that press is a no-op on screen — and `emptyBox` gives up after
  // two of those.
  const withBlank = "❯ ⟦hdr⟧\n  \n──────────\n  ⏵⏵ auto mode on";
  const without = "❯ ⟦hdr⟧\n──────────\n  ⏵⏵ auto mode on";
  assert.equal(boxText(withBlank), boxText(without)); // the blind spot
  assert.notEqual(boxRaw(withBlank), boxRaw(without)); // and what sees through it
  assert.equal(boxRaw(without), "⟦hdr⟧");
  assert.equal(boxRaw("❯ \n──────────"), ""); // an empty box is still empty
});

test("typeIntoBox: the invisible middle press no longer ends the clear", async () => {
  // The production failure of 2026-10-26, which survived the previous fix.
  //
  // Clearing a two-line box takes three Ctrl-U, and the MIDDLE one only removes
  // the already-empty second line: trimmed, it changes nothing on screen. That
  // is one of the two strikes `emptyBox` needs, handed to it for free on every
  // multi-line prompt. The other was a timing miss — the clear window (400 ms)
  // sits barely above the tmux mirror's refresh (300 ms) — and under load that
  // one came cheap too.
  //
  // What made a single miss permanent is this starting state: the box already
  // holds the header a discarded attempt left behind, and that header is a
  // PREFIX of the text about to be pasted. `survives` therefore answers true
  // for every remaining attempt, each is thrown away, and each leaves one more
  // header. The live box held six copies of the header and none of the message.
  // The poller is starved for the whole submit — a blocked event loop does not
  // starve one press — so every clear reads a screen from before it. Pre-fix
  // this reproduced the live box exactly: six pastes, zero message, and the
  // header stacked once per attempt.
  const text = `${HEADER}\nTest`;
  const stalled = Array.from({ length: 20 }, (_, i) => i + 1);
  const p = mirroredLineBox([0, 0], { initial: HEADER, stalledClears: stalled });
  const ok = await typeIntoBox(p, text, { appearMs: 200, settleMs: 20, clearMs: 40, attempts: 6 });
  assert.equal(ok, true);
  assert.equal(p.st.box, text); // ONE copy, and the message is in it
  assert.equal(p.st.pastes, 2); // the leftover costs one attempt, not all six
  assert.equal(p.st.hardClears, 0); // Ctrl-U was enough; no need for the hammer
});

test("typeIntoBox: a box Ctrl-U cannot empty gets ONE Ctrl-C, and recovers", async () => {
  // A pane where Ctrl-U does nothing at all. Without a way out, the attempts
  // stack copies of the header and the submit fails; the human then has to
  // clear the box from a terminal, which is how this was found.
  const text = `${HEADER}\nTest`;
  // The box already holds the header a previous attempt left behind, which is
  // the self-locking state: it is a prefix of what we are about to paste, so
  // `survives` keeps answering true and every attempt is thrown away.
  const p = mirroredLineBox([0, 0], { clearWorks: false, initial: HEADER });
  const ok = await typeIntoBox(p, text, { appearMs: 60, settleMs: 20, clearMs: 20, attempts: 6 });
  assert.equal(ok, true);
  assert.equal(p.st.box, text);
  assert.equal(p.st.hardClears, 1); // exactly once — twice in a row exits Claude Code
});

test("typeIntoBox: the resting example is never worth a Ctrl-C", async () => {
  // An empty box displays an example. It reads non-blank, Ctrl-U leaves it
  // alone, and firing Ctrl-C at it would be a keystroke the TUI never needed —
  // the one that, repeated, quits.
  const p = mirroredLineBox([NEVER, NEVER], { clearWorks: false, rest: 'Try "edit <filepath> to..."' });
  const ok = await typeIntoBox(p, "hello", { appearMs: 30, settleMs: 10, clearMs: 10, attempts: 2 });
  assert.equal(ok, false); // nothing landed, and that is reported
  assert.equal(p.st.hardClears, 0); // but the example was never mistaken for ours
});

test("typeIntoBox: a running turn is never interrupted to clear the box", async () => {
  // Ctrl-C is also the interrupt. A box that will not clear while a turn is
  // running is not the state this rescues, and stopping the turn would be a
  // far worse outcome than a failed submit.
  const p = mirroredLineBox([0, 0], { clearWorks: false, working: true, initial: HEADER });
  await typeIntoBox(p, `${HEADER}\nTest`, { appearMs: 30, settleMs: 10, clearMs: 10, attempts: 2 });
  assert.equal(p.st.hardClears, 0);
});

test("shouldHardClear: only what is ours", () => {
  const text = `${HEADER}\nTest`;
  assert.equal(shouldHardClear("", text), false);
  assert.equal(shouldHardClear("   ", text), false);
  // The TUI's own furniture: one line, none of our words.
  assert.equal(shouldHardClear('Try "edit <filepath> to..."', text), false);
  // More than one line cannot be the example.
  assert.equal(shouldHardClear("⟦hdr⟧\nleftover", text), true);
  // A single leftover header IS ours — that is the shape that ratchets.
  assert.equal(shouldHardClear(HEADER, text), true);
  assert.equal(shouldHardClear(HEADER + HEADER, text), true);
  // A text with nothing to match on never justifies the keystroke.
  assert.equal(shouldHardClear("something else", "   \n   "), false);
});

test("typeIntoBox: a slow MULTI-LINE paste is cleared whole before the retry", async () => {
  // The 2026-10-12 outage: a saturated server read every paste as late, the
  // recovery pressed Ctrl-U twice, the header line survived, and the retry
  // pasted after it — "⟦header⟧⟦header⟧" reached the agent, the text did not.
  const text = "⟦web · 2026-10-12 17:36 · admin⟧\ntu es la ?\nsecond line";
  const p = lineBox([30, 0]);
  const ok = await typeIntoBox(p, text, { appearMs: 15, settleMs: 45, clearMs: 20, attempts: 3 });
  assert.equal(ok, true);
  assert.equal(p.st.box, text); // one copy, nothing left over from the first
});

/* ------------------------------------------------------------------ *
 * The prelude: injected context goes in as its OWN paste, before the
 * message. Claude Code keeps only the CURRENT paste inline and wraps every
 * earlier one in `<pasted_content>` — material its own system prompt says to
 * act on only where the user's message asks. Pasted as one blob, the HUMAN's
 * words landed inside that wrapper and stopped being an instruction.
 * Spec: docs/superpowers/specs/2026-10-13-ledger-prelude-paste.md
 * ------------------------------------------------------------------ */

/** A box that WRAPS, which the plain fake does not. `inputText` reads the `❯`
 *  line alone, so once the first visual line is full everything after it is
 *  invisible to it — the exact shape that broke the first version of this. */
function wrappingBox(cols: number, landDelays: number[] = []) {
  const st = { box: "", pastes: [] as string[], clears: 0 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const render = () => {
    const head = st.box.slice(0, cols);
    const tail = st.box.slice(cols);
    const rest = tail.match(new RegExp(`.{1,${cols}}`, "g")) ?? [];
    return ["⏺ Done.", "❯ " + head, ...rest].join("\n");
  };
  return {
    st,
    paste(text: string) {
      const d = landDelays[st.pastes.length] ?? 0;
      st.pastes.push(text);
      if (d <= 0) st.box += text;
      else setTimeout(() => (st.box += text), d);
    },
    clearInput() {
      st.box = "";
      st.clears++;
    },
    screen: render,
    async waitFor(pred: (s: string) => boolean, opts?: { timeoutMs?: number }) {
      const deadline = Date.now() + (opts?.timeoutMs ?? 1000);
      while (Date.now() < deadline) {
        const screen = render();
        if (pred(screen)) return screen;
        await sleep(2);
      }
      throw new Error("timeout");
    },
  };
}

test("typeIntoBox: a prelude is a SEPARATE paste, and the MESSAGE is the last one", async () => {
  // The order is the whole mechanism: only the last paste stays inline, so the
  // message has to be it. Reversed, the fix would do nothing at all.
  const p = wrappingBox(200);
  const ok = await typeIntoBox(p, "the user's words", { appearMs: 60, prelude: "⟦ledger · 1 update⟧ • [a1b2] x — resolved" });
  assert.equal(ok, true);
  assert.equal(p.st.pastes.length, 2);
  assert.match(p.st.pastes[0], /^⟦ledger/);
  assert.equal(p.st.pastes[1], "the user's words");
  assert.equal(p.st.clears, 0); // no retry on the happy path
});

test("typeIntoBox: a prelude landing first must not be mistaken for the message", async () => {
  // Two ways to get this wrong, and the fix has to miss both.
  //
  // Watch the `❯` line for a change AFTER the prelude and you wait forever: it
  // reads that line alone, so once a prelude has saturated it the appended
  // message moves nothing there. Six attempts, six Ctrl-U, "the text never
  // appeared in the input box" — on a live agent, on a paste that had arrived.
  //
  // Watch it against the PRE-prelude baseline instead and the prelude alone
  // satisfies it: `typeIntoBox` returns while the message is still in flight,
  // the caller presses Enter, and the agent is sent the ledger block with no
  // message under it. Silent, and the user's prompt is simply gone.
  const prelude = "⟦ledger · 1 update⟧ • [a1b2] a long entity — resolved (PR#1)";
  const p = wrappingBox(20, [0, 40]); // line full at once; message lands later
  const ok = await typeIntoBox(p, "ALPHA", { appearMs: 300, settleMs: 5, clearMs: 10, prelude });
  assert.equal(ok, true);
  assert.equal(p.st.clears, 0); // recognised, not retried
  // the message is REALLY there when the caller is told it is
  assert.equal(p.st.box, prelude + "ALPHA");
});

test("typeIntoBox: with NO prelude the behaviour is byte-for-byte what it was", async () => {
  const p = wrappingBox(20);
  const ok = await typeIntoBox(p, "HELLO", { appearMs: 60 });
  assert.equal(ok, true);
  assert.deepEqual(p.st.pastes, ["HELLO"]);
});

test("typeIntoBox: a prelude that never lands must not take the message with it", async () => {
  // Losing the injected context is survivable; losing the user's message is not.
  const p = wrappingBox(200);
  const dropped = { ...p, paste: (t: string) => { if (t.startsWith("⟦ledger")) { p.st.pastes.push(t); return; } p.paste(t); } };
  const ok = await typeIntoBox(dropped as any, "ALPHA", { appearMs: 30, prelude: "⟦ledger · 1 update⟧ • [a1b2] x — resolved" });
  assert.equal(ok, true);
  assert.equal(p.st.box, "ALPHA"); // the message got through on its own
});

test("typeIntoBox: several prelude chunks are several PASTES, and the message is still last", async () => {
  // The paste rule (800 chars, 2 newlines) is applied PER PASTE and decided as
  // each one is made, so N small pastes carry what one large one cannot: eight
  // chunks and a message put 1272 characters over nine lines into a live agent
  // with nothing wrapped. The contract here is only that they really are N
  // pastes, in order, with the message last — fired back to back without the
  // wait they reach the pane as ONE paste event, which undoes the whole split.
  const p = wrappingBox(80, [6, 6, 6, 0]);
  const chunks = ["⟦ledger · 6 updates⟧ • [a1b2] one — resolved\n", " • [c3d4] two — open\n", " • [e5f6] three — open\n"];
  const ok = await typeIntoBox(p as any, "the user's words", { appearMs: 300, settleMs: 5, clearMs: 10, prelude: chunks });
  assert.equal(ok, true);
  assert.deepEqual(p.st.pastes, [...chunks, "the user's words"]);
  assert.equal(p.st.box, chunks.join("") + "the user's words");
  assert.equal(p.st.clears, 0, "nothing had to be recovered");
});

test("typeIntoBox: a prelude CHUNK that never lands must not take the message with it", async () => {
  // Same rule as the single prelude, now with more places to lose one: losing
  // the injected context is survivable, losing the user's message is not.
  const p = wrappingBox(80);
  let n = 0;
  const dropped = { ...p, paste(t: string) { if (++n === 2) return; p.paste(t); } };
  const ok = await typeIntoBox(dropped as any, "ALPHA", {
    appearMs: 30,
    settleMs: 5,
    clearMs: 10,
    prelude: ["⟦ledger · 2 updates⟧ • [a1b2] one — resolved\n", " • [c3d4] two — open\n"],
  });
  assert.equal(ok, true);
  assert.ok(p.st.box.endsWith("ALPHA"), `box was ${JSON.stringify(p.st.box)}`);
});

/* ------------------------------------------------------------------ *
 * The whole input box. Captured from a live pane (2.1.301): the composer is
 * framed by two border lines, the ❯ carries a NON-BREAKING space, and a
 * prompt that wraps continues on lines that carry no marker at all.
 * ------------------------------------------------------------------ */
const BORDER = "─".repeat(100);
const screenWith = (...boxLines: string[]) =>
  ["● ALPHA", "", "✻ Cogitated for 1s · done 12:14 PM", BORDER, ...boxLines, BORDER, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");

test("boxText: an empty box reads empty, marker and all", () => {
  // The TUI pads the ❯ with U+00A0, not a space.
  assert.equal(boxText(screenWith("❯\u00a0")), "");
  assert.equal(boxText(screenWith("❯ ")), "");
});

test("boxText: a wrapped prompt includes the lines inputText cannot see", () => {
  const screen = screenWith("❯ ⟦telegram · 2026-10-22 12:14 · Alexandre⟧", "  R4-A: answer with the single word ALPHA");
  // What the old check watched: the ❯ line alone.
  assert.equal(inputText(screen), "⟦telegram · 2026-10-22 12:14 · Alexandre⟧");
  // What the box actually holds.
  assert.equal(
    boxText(screen),
    "⟦telegram · 2026-10-22 12:14 · Alexandre⟧\n  R4-A: answer with the single word ALPHA",
  );
});

test("boxText: the box stops at its border, not at the end of the screen", () => {
  // The footer ("⏵⏵ auto mode on · 1 shell · ↓ to manage") changes on its own
  // as background shells come and go. Swallowed into the box, it would read as
  // the box changing — i.e. as a paste that landed.
  const a = screenWith("❯ hello");
  const b = a.replace("auto mode on (shift+tab to cycle)", "auto mode on · 1 shell · ↓ to manage");
  assert.equal(boxText(a), "hello");
  assert.equal(boxText(b), "hello");
});

test("boxText: shell mode and a screen with no box at all", () => {
  assert.equal(boxText(screenWith("! npm test")), "npm test");
  assert.equal(boxText("just some output\nno composer here"), "");
});

test("typeIntoBox: a box still holding an interrupted prompt is emptied, never appended to", async () => {
  // The reported bug, start to finish. Two Telegram messages a second apart:
  // the first is submitted and running, the bridge preempts it with an Escape
  // for the second — and Claude Code PUTS THE INTERRUPTED PROMPT BACK in the
  // box (observed on a live pane, 300 ms after the Escape). The resend then
  // pasted under text that was already there. Watching the ❯ line alone, the
  // paste was invisible and the "is it clear?" check answered yes without
  // clearing anything, so six attempts stacked six headers in the box and the
  // submit failed with "the text never appeared in the input box".
  const leftover = "⟦telegram · 2026-10-22 12:19 · Alexandre⟧\nMSG-ONE: count slowly from 1 to 30";
  const message = "⟦telegram · 2026-10-22 12:19 · Alexandre⟧\nMSG-TWO: answer with the single word TWO";
  const p = lineBox([0, 0], leftover);
  const ok = await typeIntoBox(p, message, { appearMs: 60, settleMs: 20, clearMs: 40, attempts: 3 });
  assert.equal(ok, true);
  assert.equal(p.st.box, message); // the message alone — no leftover glued in front
  // Two pastes: the first LANDED, and was thrown away precisely because what
  // the box held survived it. That is the signal a plain capture gives us —
  // real text and a greyed-out suggestion read exactly alike.
  assert.equal(p.st.pastes, 2);
});

test("typeIntoBox: the previous message offered as a ghost is simply replaced", async () => {
  // The common case, and it must stay free: at rest Claude Code shows the last
  // message as a suggestion. A paste wipes it out, so nothing survives and the
  // first attempt is accepted — no clearing, no second paste.
  const p = lineBox([0], "");
  const ghost = { ...p, screen: () => (p.st.box ? p.screen() : "❯ answer with the single word BETA") };
  const ok = await typeIntoBox(ghost, "and now ALPHA", { appearMs: 60, settleMs: 20, clearMs: 40 });
  assert.equal(ok, true);
  assert.equal(p.st.box, "and now ALPHA");
  assert.equal(p.st.pastes, 1);
  assert.equal(p.st.clears, 0);
});

test("describeStuckScreen: a full input box is named, instead of pointing at the box as if it were empty", () => {
  const screen = screenWith("❯ ⟦telegram · 2026-10-22 12:19 · Alexandre⟧", "  MSG-ONE: count slowly from 1 to 30");
  const why = describeStuckScreen(screen);
  assert.match(String(why), /input box was not empty/);
  assert.match(String(why), /interrupted/); // where that text comes from
  // An empty box is not a diagnosis — and neither is the one-line suggestion
  // the box shows at rest, which looks exactly like text in a capture.
  assert.equal(describeStuckScreen(screenWith("❯ ")), null);
  assert.equal(describeStuckScreen(screenWith("❯ R4-B: answer with the single word BETA")), null);
});
