import assert from "node:assert/strict";
import test from "node:test";
import { isAgentPrompt, markAgentPrompt } from "../src/kinship.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectDialog,
  extractResponse,
  loadHistory,
  listSessions,
  findSessionId,
  userPromptText,
  lastPromptAt,
  resumedTurnStart,
  MAX_RESUMED_TURN_MS,
} from "../src/extract.js";

// ── detectDialog ─────────────────────────────────────────────────────────

test("single-select dialog: question + options, ❯ selector required", () => {
  const screen = [
    " □ Test",
    "Which option do you prefer?",
    "❯ 1. Option A",
    "    First option, nothing special.",
    "  2. Option B",
    "  3. Option C",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d, "should detect");
  assert.equal(d!.multi, false);
  assert.equal(d!.question, "Which option do you prefer?");
  assert.deepEqual(d!.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(d!.options[0].label, "Option A");
  assert.equal(d!.options[0].hint, "First option, nothing special.");
});

test("two-column dialog: the right-hand preview chart is stripped from labels", () => {
  const screen = [
    "Which visualisation style do you want?",
    "❯ 1. Horizontal bars              ┌─────────────────────────────────────┐",
    "    (Recommended)                 │ GAUGES — horizontal bars             │",
    "  2. Time sparklines              │   Session   ████████░░░░  67%         │",
    "  3. Dials / arcs                 │   Week      ██████░░░░░░  42%         │",
    "Enter to select · ↑/↓ to navigate",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d);
  assert.equal(d!.options[0].label, "Horizontal bars");
  assert.equal(d!.options[1].label, "Time sparklines");
  assert.equal(d!.options[2].label, "Dials / arcs");
  assert.equal(d!.question, "Which visualisation style do you want?");
});

test("preview dialog: footer chrome under the stripped column is not glued onto an option's hint", () => {
  // Real captured screen from an AskUserQuestion with per-option code previews.
  // The right-hand preview box is stripped (invariant 2); what remained was
  // "Notes: press n to add notes" and "Chat about this" — indented footer chrome
  // that used to be absorbed as option 2's hint ("…add notes Chat about this").
  const screen = [
    "────────────────────────────────────────────────────────────",
    " ☐ Naming",
    "",
    "Which naming style do you prefer?",
    "",
    "❯ 1. camelCase                    ┌──────────────────────────┐",
    "  2. snake_case                   │ const myVar = 1;         │",
    "                                  └──────────────────────────┘",
    "",
    "                                  Notes: press n to add notes",
    "",
    "────────────────────────────────────────────────────────────",
    "  Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d, "should detect");
  assert.equal(d!.multi, false);
  assert.equal(d!.question, "Which naming style do you prefer?");
  assert.deepEqual(d!.options.map((o) => o.label), ["camelCase", "snake_case"]);
  // The bug: option 2's hint carried the footer chrome. It must be empty now.
  assert.equal(d!.options[1].hint, "");
  for (const o of d!.options) {
    assert.ok(!/press n to add notes|Chat about this|Notes:/i.test(o.hint || ""), "no chrome in hint");
  }
});

test("multi-select dialog: checkboxes parsed with their state", () => {
  const screen = [
    "Which toppings?",
    "❯ 1. [✔] Mushrooms",
    "  2. [ ] Pepperoni",
    "  3. [✔] Mozzarella",
    "Enter to select · ↑/↓ to navigate",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d);
  assert.equal(d!.multi, true);
  assert.deepEqual(
    d!.options.map((o) => o.checked),
    [true, false, true],
  );
});

test("no ❯ selector → not a dialog", () => {
  const screen = ["Some text", "  1. thing", "  2. other"].join("\n");
  assert.equal(detectDialog(screen), null);
});

test("fewer than 2 options → not a dialog", () => {
  assert.equal(detectDialog("Q?\n❯ 1. only one"), null);
});

test("plain transcript text → not a dialog", () => {
  assert.equal(detectDialog("⏺ Here is the answer.\n\nAn ordinary paragraph."), null);
});

test("stacked dialogs: a previous dialog left in the scrollback is ignored — only the one carrying the ❯ cursor is parsed", () => {
  // A previous (already answered) multi-select dialog is still visible above the
  // current single-select one in the xterm buffer. detectDialog must isolate the
  // CURRENT dialog (the block carrying the ❯ cursor), not merge both option sets
  // (which corrupted the numbering, forced multi=true, and showed the wrong
  // question).
  const screen = [
    "Previous question — what to configure?",
    "  1. [✔] Bot token",
    "  2. [ ] Enable / disable",
    "  3. [✔] Status / diagnostics",
    "← ☐ ☐ ✔ Submit →",
    "",
    "How should the token be displayed?",
    "❯ 1. Write-only",
    "    The token is never shown again.",
    "  2. Revealable",
    "    Hidden by default, revealable.",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d);
  assert.equal(d!.options.length, 2);
  assert.equal(d!.multi, false);
  assert.deepEqual(
    d!.options.map((o) => o.label),
    ["Write-only", "Revealable"],
  );
  assert.match(d!.question, /How should the token/);
});

// ── extractResponse ──────────────────────────────────────────────────────

test("extractResponse takes the ⏺ answer after the prompt echo, dropping status", () => {
  const buffer = [
    "❯ Explain X",
    "⏺ Here is the explanation of X.",
    "  continued over two lines.",
    "✻ Cooked for 3s",
    "────────────────────────────────────────────",
    "❯ ",
  ].join("\n");
  const out = extractResponse(buffer, "Explain X");
  assert.match(out, /Here is the explanation of X/);
  assert.match(out, /continued over two lines/);
  assert.doesNotMatch(out, /Cooked for/);
  assert.doesNotMatch(out, /^❯/m);
});

// ── filesystem readers (loadHistory / listSessions / findSessionId) ───────
// Run against a throwaway HOME so we never touch the real ~/.claude.

function withTempHome(fn: (cwd: string, sid: string) => void) {
  const prevHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
  process.env.HOME = tmp;
  try {
    const cwd = "/tmp/some/project";
    const sid = "abc123-session";
    const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = path.join(tmp, ".claude", "projects", enc);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", isMeta: true, message: { content: "<system>" } }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-28T21:57:55.938Z",
        message: { content: "First request" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-28T21:58:10.000Z",
        message: { content: [{ type: "text", text: "Answer one." }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-28T21:59:30.000Z",
        message: { content: [{ type: "text", text: "Answer one, continued." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "NOTHING TO SHOW" }] },
      }),
      JSON.stringify({ type: "user", message: { content: "[Request interrupted…" } }),
      // A turn fired by a cron: the prompt is written into the transcript like
      // any other user message, but must never be rendered.
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-28T22:10:00.000Z",
        message: { content: "⏰ [cron] Monitoring output:\n3 kB of dump\n\nWrite the morning report." },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-28T22:10:30.000Z",
        message: { content: [{ type: "text", text: "Morning report." }] },
      }),
    ].join("\n");
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines);
    fn(cwd, sid);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("loadHistory: real turns only, consecutive assistant blocks merged, meta/interrupt skipped", () => {
  withTempHome((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    assert.deepEqual(
      turns.map((t) => t.role),
      ["user", "assistant"],
    );
    assert.equal(turns[0].text, "First request");
    assert.match(turns[1].text, /Answer one\.\n\nAnswer one, continued\./);
  });
});

test("loadHistory: a NOTHING TO SHOW block leaves no trace in the replayed history", () => {
  withTempHome((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    assert.equal(turns.length, 2); // no third turn born of the sentinel
    assert.doesNotMatch(turns[1].text, /NOTHING TO SHOW/);
  });
});

test("findSessionId returns the session's id; listSessions previews the first prompt", () => {
  withTempHome((cwd, sid) => {
    assert.equal(findSessionId(cwd), sid);
    const list = listSessions(cwd);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, sid);
    assert.equal(list[0].preview, "First request");
  });
});

test("loadHistory: every turn carries the .jsonl time, a merged turn keeps the first", () => {
  withTempHome((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    assert.equal(turns[0].at, Date.parse("2026-07-28T21:57:55.938Z"));
    // Two merged assistant blocks: the time is that of the START of the
    // speaking turn, not that of the last block.
    assert.equal(turns[1].at, Date.parse("2026-07-28T21:58:10.000Z"));
  });
});

test("loadHistory: a transcript with no timestamp does not invent a time", () => {
  const prevHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
  process.env.HOME = tmp;
  try {
    const cwd = "/tmp/other/project";
    const sid = "no-ts-session";
    const dir = path.join(tmp, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, sid + ".jsonl"),
      JSON.stringify({ type: "user", message: { content: "no timestamp" } }),
    );
    assert.equal(loadHistory(cwd, sid)[0].at, undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadHistory on a missing transcript is empty, never throws", () => {
  assert.deepEqual(loadHistory("/nope/nowhere", "missing"), []);
});

// ── Origin of a turn found already running (after a restart) ─────────────

test("userPromptText: a real prompt yes, a technical line no", () => {
  assert.equal(userPromptText({ type: "user", message: { content: "salut" } }), "salut");
  assert.equal(
    userPromptText({ type: "user", message: { content: [{ type: "text", text: "  salut  " }] } }),
    "salut",
  );
  // A tool result arrives MID-turn: taking it for a prompt would date the
  // turn's origin a few seconds before now.
  assert.equal(userPromptText({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }), null);
  assert.equal(userPromptText({ type: "user", isMeta: true, message: { content: "salut" } }), null);
  assert.equal(userPromptText({ type: "user", message: { content: "<system-reminder>" } }), null);
  assert.equal(userPromptText({ type: "user", message: { content: "[Request interrupted…" } }), null);
  assert.equal(userPromptText({ type: "assistant", message: { content: [] } }), null);
  assert.equal(userPromptText(null), null);
});

test("lastPromptAt: the time of the LAST real prompt, not of a tool result", () => {
  const prevHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
  process.env.HOME = tmp;
  try {
    const cwd = "/tmp/turn/project";
    const sid = "turn-session";
    const dir = path.join(tmp, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, sid + ".jsonl"),
      [
        JSON.stringify({ type: "user", timestamp: "2026-07-30T08:00:00.000Z", message: { content: "vieux prompt" } }),
        JSON.stringify({ type: "user", timestamp: "2026-07-30T09:00:00.000Z", message: { content: "the turn's prompt" } }),
        // Written AFTER, during the turn: they must not become the origin.
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-30T09:00:05.000Z",
          message: { content: [{ type: "text", text: "je cherche" }] },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-30T09:09:00.000Z",
          message: { content: [{ type: "tool_result", content: "sortie de commande" }] },
        }),
      ].join("\n"),
    );
    assert.equal(lastPromptAt(cwd, sid), Date.parse("2026-07-30T09:00:00.000Z"));
    assert.equal(lastPromptAt(cwd, "aucune-session"), null);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resumedTurnStart: trusts the transcript, except when it is not believable", () => {
  const now = Date.parse("2026-07-30T09:10:00.000Z");
  const tenMinAgo = Date.parse("2026-07-30T09:00:00.000Z");
  // The useful case: the agent has been thinking for 10 min, the clock must say so.
  assert.equal(resumedTurnStart(now, tenMinAgo), tenMinAgo);
  // Pas de transcript exploitable → on repart de maintenant (0 s), pas de NaN.
  assert.equal(resumedTurnStart(now, null), now);
  // A timestamp in the future (the machine's clock changed): refused, otherwise
  // the displayed duration would be negative.
  assert.equal(resumedTurnStart(now, now + 60_000), now);
  // Too old: that prompt belongs to an already finished turn, we would display
  // its AGE and not a thinking duration.
  assert.equal(resumedTurnStart(now, now - MAX_RESUMED_TURN_MS - 1), now);
  assert.equal(resumedTurnStart(now, now - MAX_RESUMED_TURN_MS + 1), now - MAX_RESUMED_TURN_MS + 1);
});

test("loadHistory: a cron's prompt is never replayed, its answer is", () => {
  withTempHome((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    // No user turn carries the scheduled prompt…
    assert.equal(turns.some((t) => t.role === "user" && /\[cron\]/.test(t.text)), false);
    assert.equal(turns.some((t) => /dump/.test(t.text)), false);
    // …but what the agent answered stays, which is the whole point of the cron.
    assert.equal(turns.some((t) => t.role === "assistant" && /Morning report/.test(t.text)), true);
  });
});

test("loadHistory drops a parent notification, like a scheduled prompt", () => {
  // It reaches the transcript as an ordinary user message. Without the filter
  // it reads as something the human typed, and comes back on every web reload
  // and Telegram backfill — the bug CRON_PROMPT_MARK already exists to prevent.
  assert.equal(isAgentPrompt(markAgentPrompt('Agent "kid" finished its turn.')), true);
  assert.equal(isAgentPrompt("please review the diff"), false);
});
