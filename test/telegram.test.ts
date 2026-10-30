import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  promptFrame,
  pollSignal,
  floodWaitMs,
  withFloodControl,
  refusalReason,
  FLOOD_BUDGET_MS,
  shouldReattachBridge,
  senderName,
  replyContext,
  shouldPreempt,
  pasteExtension,
  pasteFileName,
  bindKey,
  chunk,
  parseCommand,
  dialogKeyboard,
  dialogText,
  parseCallback,
  makeTyping,
  mdToTelegramHtml,
  attachmentOf,
  mediaFileName,
  mediaExtension,
  attachmentPrompt,
  tooLargeNotice,
  tooBigFor,
  makeAlbumBuffer,
  migratedGroupId,
  prefaceMatches,
  isStalePreface,
  promptEchoLabel,
  dmGate,
  pairingCodeOf,
  makeSendQueue,
  nextToolsState,
  isFreetextOption,
  shouldAnnounceLoggedOut,
} from "../src/telegram.js";

test("migratedGroupId: follows the bound board group to its new supergroup id", () => {
  const msg = { chat: { id: -100 }, migrate_to_chat_id: -1009999 };
  assert.equal(migratedGroupId(msg, -100), -1009999);
});

test("migratedGroupId: ignores a migration of a group that isn't the bound one", () => {
  const msg = { chat: { id: -55 }, migrate_to_chat_id: -1009999 };
  assert.equal(migratedGroupId(msg, -100), null);
});

test("migratedGroupId: a plain message (no migrate field) yields null", () => {
  assert.equal(migratedGroupId({ chat: { id: -100 }, text: "hi" }, -100), null);
  assert.equal(migratedGroupId({ chat: { id: -100 }, migrate_to_chat_id: "x" }, -100), null);
  assert.equal(migratedGroupId({ chat: { id: -100 }, migrate_to_chat_id: -1 }, null), null);
});

test("bindKey: DM, group, and forum topic map to distinct keys", () => {
  assert.equal(bindKey({ id: 42, type: "private" }), "private:42");
  assert.equal(bindKey({ id: -100, type: "supergroup" }), "group:-100");
  assert.equal(bindKey({ id: -100, type: "supergroup" }, 7), "topic:-100:7");
});

test("chunk: short text is one piece", () => {
  assert.deepEqual(chunk("hello", 4000), ["hello"]);
});

test("chunk: long text splits under the limit, preferring newlines", () => {
  const line = "x".repeat(30);
  const text = Array.from({ length: 200 }, () => line).join("\n"); // ~6000 chars
  const parts = chunk(text, 4000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join("\n"), text); // lossless reassembly
});

test("chunk: a single very long line is hard-cut", () => {
  const parts = chunk("y".repeat(9000), 4000);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join(""), "y".repeat(9000));
});

test("parseCommand: recognizes commands, args, and @botname suffix", () => {
  assert.deepEqual(parseCommand("/new"), { cmd: "new", arg: "" });
  assert.deepEqual(parseCommand("/spawn my agent"), { cmd: "spawn", arg: "my agent" });
  assert.deepEqual(parseCommand("/list@shadokai_bot"), { cmd: "list", arg: "" });
});

test("nextToolsState: /tools alone toggles", () => {
  assert.equal(nextToolsState("", false), true);
  assert.equal(nextToolsState("", true), false);
});

test("nextToolsState: on/off force the state, whatever the current one", () => {
  assert.equal(nextToolsState("on", false), true);
  assert.equal(nextToolsState("ON", true), true);
  assert.equal(nextToolsState("off", true), false);
  assert.equal(nextToolsState(" Off ", false), false);
});

test("nextToolsState: an argument that is neither on nor off just toggles", () => {
  // The command must not become a syntax puzzle: /tools yes toggles.
  assert.equal(nextToolsState("yes", false), true);
  assert.equal(nextToolsState("wat", true), false);
});

test("promptEchoLabel: each origin has its mark", () => {
  assert.equal(promptEchoLabel("web"), "👤 web");
  assert.equal(promptEchoLabel("cron"), "⏰ cron");
  assert.equal(promptEchoLabel("cli"), "⌨️ cli");
});

test("promptEchoLabel: a named sender is named, not reduced to their origin", () => {
  // The server already puts the web account's name on the echo (promptAuthor);
  // only this label dropped it, so a colleague writing from the cockpit reached
  // Telegram as a bare "web" — the same anonymity the web side fixed months ago
  // with echoAuthor. Name first: who spoke matters more than which surface.
  assert.equal(promptEchoLabel("web", false, "alex"), "👤 alex · web");
  assert.equal(promptEchoLabel("cli", false, "alex"), "⌨️ alex · cli");
});

test("promptEchoLabel: an unknown origin keeps both the name and its own word", () => {
  assert.equal(promptEchoLabel("pilotctl", false, "alex"), "👤 alex · pilotctl");
});

test("promptEchoLabel: a name with no origin stands alone", () => {
  // No dangling separator, and no invented place.
  assert.equal(promptEchoLabel(undefined, false, "alex"), "👤 alex");
});

test("promptEchoLabel: a blank name is no name at all", () => {
  // A whitespace-only name would print "👤  · web": a separator with nothing
  // in front of it reads as a rendering bug.
  assert.equal(promptEchoLabel("web", false, "   "), "👤 web");
  assert.equal(promptEchoLabel("web", false, ""), "👤 web");
});

test("promptEchoLabel: the auto-resume is nobody, whatever name rode along", () => {
  assert.equal(promptEchoLabel("web", true, "alex"), "⚙️ auto-resumed");
});

test("promptEchoLabel: an unknown origin stays marked, without lying", () => {
  // Better "someone spoke" than a message that looks like it came from the agent.
  assert.equal(promptEchoLabel(undefined), "👤");
  assert.equal(promptEchoLabel("pilotctl"), "👤 pilotctl");
});

test("promptEchoLabel: the pace guard's auto-resume is not a human", () => {
  assert.equal(promptEchoLabel("web", true), "⚙️ auto-resumed");
  assert.equal(promptEchoLabel(undefined, true), "⚙️ auto-resumed");
});

test("dmGate: with no owner, a DM must pair — writing first no longer claims it", () => {
  assert.equal(dmGate(null, 4242), "pair");
});

test("pairingCodeOf: /setup <code> and the deep link's /start <code> carry a code", () => {
  assert.equal(pairingCodeOf("/setup 12345678"), "12345678");
  assert.equal(pairingCodeOf("/setup@shadok_bot 1234 5678"), "1234 5678");
  assert.equal(pairingCodeOf("/start 12345678"), "12345678");
});

test("pairingCodeOf: a bare /setup, another command or plain text carries none", () => {
  // A bare /setup used to bind the group outright — it must now get nowhere.
  assert.equal(pairingCodeOf("/setup"), null);
  assert.equal(pairingCodeOf("/start"), null);
  assert.equal(pairingCodeOf("/spawn 12345678"), null);
  assert.equal(pairingCodeOf("12345678"), null);
  assert.equal(pairingCodeOf(undefined), null);
});

test("dmGate: the owner gets through, everyone else is refused", () => {
  assert.equal(dmGate(4242, 4242), "allow");
  assert.equal(dmGate(4242, 9999), "deny");
});

test("dmGate: a sender with no id is refused, even with no owner set", () => {
  // No id = nothing to claim and nobody to recognise: we do not open up.
  assert.equal(dmGate(null, undefined), "deny");
  assert.equal(dmGate(4242, undefined), "deny");
});

test("parseCommand: plain text is not a command", () => {
  assert.equal(parseCommand("hello there"), null);
  assert.equal(parseCommand("what is /usr/bin?"), null);
});

test("dialogKeyboard: single-select → one 'choose' button per option, no submit", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: false,
    options: [
      { n: 1, label: "Alpha" },
      { n: 2, label: "Beta" },
    ],
  });
  assert.equal(kb.inline_keyboard.length, 2);
  assert.deepEqual(kb.inline_keyboard[0][0], { text: "1. Alpha", callback_data: "d:1" });
  assert.deepEqual(kb.inline_keyboard[1][0], { text: "2. Beta", callback_data: "d:2" });
});

test("isFreetextOption: only the AskUserQuestion free-form entry", () => {
  // Same rule as the web (index.html): both clients must agree.
  assert.equal(isFreetextOption("Type something"), true);
  assert.equal(isFreetextOption("Type something else"), true);
  assert.equal(isFreetextOption("type something."), true);
  assert.equal(isFreetextOption("Chat about this"), false);
  assert.equal(isFreetextOption("Finish the /tools toggle"), false);
});

test("dialogKeyboard: the free-form option gets its own 'f:' callback", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: false,
    options: [
      { n: 1, label: "Alpha" },
      { n: 2, label: "Type something" },
    ],
  });
  assert.equal(kb.inline_keyboard[0][0].callback_data, "d:1");
  assert.equal(kb.inline_keyboard[1][0].callback_data, "f:2");
});

test("dialogKeyboard: a free-form option in a multi-select is still free-form", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: true,
    options: [
      { n: 1, label: "A", checked: false },
      { n: 2, label: "Type something", checked: false },
    ],
  });
  assert.equal(kb.inline_keyboard[0][0].callback_data, "t:1");
  assert.equal(kb.inline_keyboard[1][0].callback_data, "f:2");
  const last = kb.inline_keyboard[kb.inline_keyboard.length - 1][0];
  assert.equal(last.callback_data, "s");
});

test("dialogKeyboard: multi-select → toggle buttons with ☑/☐ + a Submit row", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: true,
    options: [
      { n: 1, label: "A", checked: true },
      { n: 2, label: "B", checked: false },
    ],
  });
  assert.match(kb.inline_keyboard[0][0].text, /^☑ 1\. A/);
  assert.equal(kb.inline_keyboard[0][0].callback_data, "t:1");
  assert.match(kb.inline_keyboard[1][0].text, /^☐ 2\. B/);
  const last = kb.inline_keyboard[kb.inline_keyboard.length - 1][0];
  assert.deepEqual(last, { text: "✅ Submit", callback_data: "s" });
});

test("makeTyping: start beats immediately, then on every interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let beats = 0;
  const typing = makeTyping(() => beats++, 4000);
  typing.start();
  assert.equal(beats, 1); // immediate first beat — no 4s wait for the indicator
  t.mock.timers.tick(4000);
  assert.equal(beats, 2);
  t.mock.timers.tick(8000);
  assert.equal(beats, 4);
  typing.stop();
});

test("makeTyping: start while already beating does not double the pulse", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let beats = 0;
  const typing = makeTyping(() => beats++, 4000);
  typing.start();
  typing.start(); // e.g. two "working" events in a row
  assert.equal(beats, 1);
  t.mock.timers.tick(4000);
  assert.equal(beats, 2);
  typing.stop();
});

test("makeTyping: stop halts the pulse and is idempotent; restart works", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let beats = 0;
  const typing = makeTyping(() => beats++, 4000);
  typing.start();
  typing.stop();
  typing.stop(); // turn-done then exited must not throw
  t.mock.timers.tick(20000);
  assert.equal(beats, 1); // only the immediate beat, nothing after stop
  typing.start(); // next turn
  assert.equal(beats, 2);
  typing.stop();
});

test("parseCallback: choose / toggle / confirm, and garbage → null", () => {
  assert.deepEqual(parseCallback("d:3"), { kind: "choose", n: 3 });
  assert.deepEqual(parseCallback("t:2"), { kind: "toggle", n: 2 });
  assert.deepEqual(parseCallback("s"), { kind: "confirm" });
  assert.deepEqual(parseCallback("f:4"), { kind: "freetext", n: 4 });
  assert.equal(parseCallback("x:1"), null);
  assert.equal(parseCallback("f:"), null);
  assert.equal(parseCallback(""), null);
});

test("mdToTelegramHtml: bold/italic/inline code, digits untouched", () => {
  assert.equal(
    mdToTelegramHtml("**b** and *i* and `c` and 3 files"),
    "<b>b</b> and <i>i</i> and <code>c</code> and 3 files",
  );
});

test("mdToTelegramHtml: heading → bold, bullets → •, links", () => {
  assert.equal(
    mdToTelegramHtml("# Title\n- a\n- b\n[t](https://x.com)"),
    '<b>Title</b>\n• a\n• b\n<a href="https://x.com">t</a>',
  );
});

test("mdToTelegramHtml: code fence content is escaped, not reformatted", () => {
  assert.equal(
    mdToTelegramHtml("```js\nconst x = 1 < 2 && *y*;\n```"),
    "<pre>const x = 1 &lt; 2 &amp;&amp; *y*;</pre>",
  );
});

test("mdToTelegramHtml: bare <>& are escaped so the HTML is well-formed", () => {
  assert.equal(mdToTelegramHtml("a <b> & c"), "a &lt;b&gt; &amp; c");
});

test("mdToTelegramHtml: a lone marker stays literal (no unbalanced tag)", () => {
  assert.equal(mdToTelegramHtml("2 * 3 = 6"), "2 * 3 = 6");
});

test("attachmentOf: photo → the largest size, kind image", () => {
  const att = attachmentOf({
    photo: [
      { file_id: "small", file_unique_id: "u1", file_size: 100 },
      { file_id: "big", file_unique_id: "u2", file_size: 5000 },
    ],
  });
  assert.deepEqual(att, { fileId: "big", fileUniqueId: "u2", kind: "image", fileSize: 5000 });
});

test("attachmentOf: document image/* → kind image, keeps the name", () => {
  const att = attachmentOf({
    document: { file_id: "f", file_unique_id: "u", file_name: "shot.png", mime_type: "image/png", file_size: 42 },
  });
  assert.deepEqual(att, {
    fileId: "f",
    fileUniqueId: "u",
    kind: "image",
    fileName: "shot.png",
    fileSize: 42,
    // Carried since videos needed it: the mime is what names a file that
    // arrives without one (a camera video has no file_name at all).
    mimeType: "image/png",
  });
});

test("attachmentOf: any other document → kind file", () => {
  const att = attachmentOf({
    document: { file_id: "f", file_unique_id: "u", file_name: "report.pdf", mime_type: "application/pdf" },
  });
  assert.equal(att?.kind, "file");
  assert.equal(att?.fileName, "report.pdf");
});

test("attachmentOf: a plain text message → null", () => {
  assert.equal(attachmentOf({ text: "hello" }), null);
});

test("mediaFileName: original name prefixed by the unique id, sanitised", () => {
  assert.equal(
    mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "file", fileName: "../é vil/final report.pdf" }),
    "AQAD-final report.pdf",
  );
});

test("mediaFileName: an unnamed photo → .jpg; an unnamed file → the bare id", () => {
  assert.equal(mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "image" }), "AQAD.jpg");
  assert.equal(mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "file" }), "AQAD");
});

test("attachmentPrompt: a lone image", () => {
  assert.equal(attachmentPrompt([{ path: "/m/a.jpg", kind: "image" }]), "[Attached image: /m/a.jpg]");
});

test("attachmentPrompt: file + caption", () => {
  assert.equal(
    attachmentPrompt([{ path: "/m/r.pdf", kind: "file" }], "summarise this doc"),
    "[Attached file: /m/r.pdf]\nsummarise this doc",
  );
});

test("attachmentPrompt: several attachments, an empty caption ignored", () => {
  assert.equal(
    attachmentPrompt(
      [
        { path: "/m/a.jpg", kind: "image" },
        { path: "/m/b.zip", kind: "file" },
      ],
      "  ",
    ),
    "[Attached image: /m/a.jpg]\n[Attached file: /m/b.zip]",
  );
});

test("makeAlbumBuffer: groups one album's items into a single flush", async () => {
  const flushed: [string, number[]][] = [];
  const buf = makeAlbumBuffer<number>((gid, items) => flushed.push([gid, items]), 30);
  buf.add("g1", 1);
  buf.add("g1", 2);
  buf.add("g1", 3);
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(flushed, [["g1", [1, 2, 3]]]);
});

test("makeAlbumBuffer: every add rearms the timer (no partial flush)", async () => {
  const flushed: number[][] = [];
  const buf = makeAlbumBuffer<number>((_gid, items) => flushed.push(items), 40);
  buf.add("g", 1);
  await new Promise((r) => setTimeout(r, 25)); // < the delay: not flushed yet
  buf.add("g", 2); // rearms
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(flushed.length, 0); // 50 ms after the 1st add but 25 ms after the 2nd
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(flushed, [[1, 2]]);
});

test("makeAlbumBuffer: two independent albums", async () => {
  const flushed = new Map<string, string[]>();
  const buf = makeAlbumBuffer<string>((gid, items) => flushed.set(gid, items), 20);
  buf.add("a", "x");
  buf.add("b", "y");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(flushed.get("a"), ["x"]);
  assert.deepEqual(flushed.get("b"), ["y"]);
});

// ── A dialog's preface (see docs/superpowers/specs/2026-07-28-telegram-dialog-preface-design.md)

test("prefaceMatches: the authoritative text contains the unwrapped preface", () => {
  // The screen wrapped the paragraph over 3 lines; extractLiveText joined them
  // with spaces. The .jsonl keeps the real line breaks.
  const preface = "Here is a fairly long introduction that explains the context before the question.";
  const authoritative = "Here is a fairly long introduction\nthat explains the context\nbefore the question.";
  assert.equal(prefaceMatches(preface, authoritative), true);
});

test("prefaceMatches: a preface truncated by scrolling = an inner fragment", () => {
  const authoritative = "A preamble that scrolled off the screen.\n\nThen the part still visible at the bottom.";
  assert.equal(prefaceMatches("Then the part still visible at the bottom.", authoritative), true);
});

test("isStalePreface: an already broadcast preface is stale", () => {
  // The reproduced case: the screen still shows the previous turn's answer when
  // the next question appears. Re-posting it would make a permanent duplicate.
  const recent = ["A first, unrelated block.", "UNIQUE-MARKER-42 is the answer expected here."];
  assert.equal(isStalePreface("UNIQUE-MARKER-42 is the answer expected here.", recent), true);
});

test("isStalePreface: the screen-rendered form is recognised as the same block", () => {
  // The screen flattens Markdown and wraps lines; only the alphanumeric
  // skeleton is common to both forms (see prefaceMatches).
  const authoritative = "Here is a fairly **long** introduction\nthat explains the context.";
  assert.equal(isStalePreface("Here is a fairly long introduction that explains the context.", [authoritative]), true);
});

test("isStalePreface: a brand-new preface gets through", () => {
  const recent = ["An already broadcast block, long enough to match."];
  assert.equal(isStalePreface("I am about to ask you a question about the next step.", recent), false);
});

test("isStalePreface: with no known block, nothing is stale", () => {
  assert.equal(isStalePreface("A perfectly legitimate and fairly long preface.", []), false);
});

test("isStalePreface: a SHORT answer already broadcast is stale too", () => {
  // prefaceMatches's floor (PREFACE_MIN) let "OK" and "PREFACE-SENTINEL-77"
  // back through: too short to match, hence re-posted at every question. Here
  // we do not apply it — see the comment in the code.
  assert.equal(isStalePreface("OK", ["OK"]), true);
  assert.equal(isStalePreface("SENTINELLE-PREFACE-77", ["SENTINELLE-PREFACE-77"]), true);
});

test("isStalePreface: an inner fragment of an already broadcast block is stale", () => {
  // A preface truncated by scrolling is only a piece of the block.
  assert.equal(isStalePreface("still visible at the bottom.", ["A preamble.\n\nThen the part still visible at the bottom."]), true);
});

test("isStalePreface: an empty preface stales nothing", () => {
  assert.equal(isStalePreface("", ["an already broadcast block"]), false);
  assert.equal(isStalePreface("   ", ["an already broadcast block"]), false);
});

test("prefaceMatches: an unrelated text does not match", () => {
  assert.equal(prefaceMatches("I am looking at the files involved.", "Nothing to do with the preface here."), false);
});

test("prefaceMatches: too short a preface never matches", () => {
  // Otherwise "Fine." would match any text containing it.
  assert.equal(prefaceMatches("Fine.", "Fine. And here is a long, unrelated continuation."), false);
});

test("prefaceMatches: empty or blank strings → false", () => {
  assert.equal(prefaceMatches("", "un texte quelconque et suffisamment long"), false);
  assert.equal(prefaceMatches("   \n  ", "un texte quelconque et suffisamment long"), false);
  assert.equal(prefaceMatches("a perfectly valid preface right here", ""), false);
});

test("makeSendQueue: serialises despite decreasing latencies", async () => {
  const q = makeSendQueue();
  const done: number[] = [];
  const slow = (n: number, ms: number) =>
    q(async () => {
      await new Promise((r) => setTimeout(r, ms));
      done.push(n);
    });
  // With no queue, the 3rd (1 ms) would finish before the 1st (40 ms): exactly
  // what made the keyboard arrive before the preface.
  const all = [slow(1, 40), slow(2, 20), slow(3, 1)];
  await Promise.all(all);
  assert.deepEqual(done, [1, 2, 3]);
});

test("makeSendQueue: a rejection does not block the rest of the queue", async () => {
  const q = makeSendQueue();
  const done: string[] = [];
  const failing = q(async () => {
    throw new Error("Telegram 400");
  });
  const after = q(async () => {
    done.push("after");
  });
  await assert.rejects(failing, /Telegram 400/);
  await after;
  assert.deepEqual(done, ["after"]);
});

test("makeSendQueue: two queues are independent", async () => {
  const a = makeSendQueue();
  const b = makeSendQueue();
  const order: string[] = [];
  const pa = a(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push("a");
  });
  const pb = b(async () => {
    order.push("b"); // must not wait for queue a
  });
  await Promise.all([pa, pb]);
  assert.deepEqual(order, ["b", "a"]);
});

test("prefaceMatches: the screen renders the Markdown, the transcript keeps the source", () => {
  // THE cause of the duplicate seen in production (v0.1.144): the .jsonl holds
  // the Markdown markers, the screen only shows the rendering (bold as ANSI).
  // Comparing the two literally failed, so the preface was never edited and the
  // authoritative text went out as a second message, after the question.
  const auth =
    "Here is the full-scale test. This paragraph is the preface text: if the fix " +
    "works, you must read it **before** the question's keyboard appears " +
    "below — and not after answering it.";
  const preface = auth.replace(/\*\*/g, ""); // what the screen gives
  assert.equal(prefaceMatches(preface, auth), true);
});

test("prefaceMatches: a late divergence (link, bullets) does not prevent a match", () => {
  const auth =
    "The server attaches the preface to the `dialog` message, read with the same function as the " +
    "web preview ([live-text.js](public/live-text.js)):\n\n- no copy\n- a single source";
  const preface =
    "The server attaches the preface to the dialog message, read with the same function as the " +
    "web preview (live-text.js): • no copy • a single source";
  assert.equal(prefaceMatches(preface, auth), true);
});

test("prefaceMatches: two blocks that diverge from the opening do not match", () => {
  // The flip side of the fingerprint: it must stay discriminating. Two texts
  // sharing only a few opening words are NOT the same block.
  const preface = "Here is the result of the analysis of the Telegram bridge and its send queue.";
  const auth = "Here is the plan for migrating the database to the new schema.";
  assert.equal(prefaceMatches(preface, auth), false);
});

test("a live agent whose bridge died is reattachable", () => {
  // The case that shipped this fix: a session restarted after a killed pane.
  // Its channel still carries the binding, but `ws.on("close")` had dropped the
  // bridge, and nothing outside `reconcileOnBoot` knew how to rebuild it — so
  // the topic went deaf in the agent → Telegram direction until an unrelated
  // server restart.
  assert.equal(shouldReattachBridge({ chatId: -100, hasBridge: false, sessionAlive: true }), true);
});

test("a dormant channel is NEVER revived just to fill a topic", () => {
  // The load-bearing guard: without it the 5s loop would respawn a `claude`
  // under every idle mirrored channel. Mirroring an idle channel is the topic's
  // job, not a live process's.
  assert.equal(shouldReattachBridge({ chatId: -100, hasBridge: false, sessionAlive: false }), false);
});

test("an already-bridged channel is left alone", () => {
  // Called every 5s: without this the loop would rebuild a working bridge over
  // and over, and each rebuild replays into the topic.
  assert.equal(shouldReattachBridge({ chatId: -100, hasBridge: true, sessionAlive: true }), false);
});

test("no BINDING means nothing to reattach to", () => {
  // A web-only channel: the mirroring path creates its topic, this one must not
  // pretend it already has one. What disqualifies it is the absence of a bound
  // chat — not the absence of a topic (see the General below).
  assert.equal(shouldReattachBridge({ chatId: null, hasBridge: false, sessionAlive: true }), false);
  assert.equal(shouldReattachBridge({ hasBridge: false, sessionAlive: true }), false);
});

test("the group's General is bound too, even with no threadId", () => {
  // The bug this fixes: the main channel lives in the board group's General,
  // which by construction has NO threadId — that is how the code recognises it
  // (`mergeChannels` forces the name "general" on `telegram.threadId == null`).
  // Keying the guard on the topic instead of the binding meant its bridge was
  // never rebuilt once it died: the web channel kept working while Telegram
  // went silent, with no error anywhere.
  assert.equal(shouldReattachBridge({ chatId: -100, threadId: null, hasBridge: false, sessionAlive: true }), true);
});

test("a sign-out is announced once, not on every refused spawn", () => {
  // A five-minute cron would otherwise turn one sign-out into a flood, and a
  // channel that cries wolf gets muted long before the day it is right.
  assert.equal(shouldAnnounceLoggedOut(false, true), true);
  assert.equal(shouldAnnounceLoggedOut(true, true), false);
});

test("with nobody to speak to, the notice is NOT burnt", () => {
  // Telegram off or no board group bound: staying silent is right, but latching
  // the flag here would mean the REAL sign-out is never announced either.
  assert.equal(shouldAnnounceLoggedOut(false, false), false);
});

test("senderName: a human is named the way Telegram names them", () => {
  assert.equal(senderName({ first_name: "Alexandre", last_name: "Cognard" }), "Alexandre Cognard");
  assert.equal(senderName({ first_name: "Alexandre" }), "Alexandre");
  // No display name at all: the handle is still better than nothing.
  assert.equal(senderName({ username: "gnarco" }), "@gnarco");
});

test("senderName: nothing usable → undefined, never an empty label", () => {
  // The web falls back to its own wording; an empty string would print a blank
  // author above the bubble.
  assert.equal(senderName({}), undefined);
  assert.equal(senderName(undefined), undefined);
  assert.equal(senderName({ first_name: "   " }), undefined);
});

test("pasteExtension: the common paste types keep a truthful extension", () => {
  assert.equal(pasteExtension("image/png"), "png");
  assert.equal(pasteExtension("image/jpeg"), "jpg");
  assert.equal(pasteExtension("image/webp"), "webp");
  assert.equal(pasteExtension("image/gif"), "gif");
  assert.equal(pasteExtension("image/svg+xml"), "svg");
  // Now that any file can be pasted, the non-image types matter too — a PDF
  // must land on ".pdf" so the agent's Read tool treats it as a PDF.
  assert.equal(pasteExtension("application/pdf"), "pdf");
  assert.equal(pasteExtension("text/csv"), "csv");
  assert.equal(pasteExtension("application/json"), "json");
  // Browsers append parameters; they are not part of the type.
  assert.equal(pasteExtension("image/png; charset=binary"), "png");
  assert.equal(pasteExtension("IMAGE/PNG"), "png");
});

test("pasteExtension: anything unknown lands on a neutral extension", () => {
  // A whitelist, not a split on "/": the content-type is attacker-controlled and
  // ends up in a filename. "image/../../etc/passwd" must not become a path.
  assert.equal(pasteExtension("application/x-made-up"), "bin");
  assert.equal(pasteExtension("image/../../etc/passwd"), "bin");
  assert.equal(pasteExtension(""), "bin");
});

test("pasteFileName: keeps the original name and extension, uuid-prefixed", () => {
  assert.equal(pasteFileName("ID", "report.pdf", "application/pdf"), "paste-ID-report.pdf");
  assert.equal(pasteFileName("ID", "data.csv", ""), "paste-ID-data.csv");
});

test("pasteFileName: no name → uuid + extension from the content type", () => {
  assert.equal(pasteFileName("ID", "", "image/png"), "paste-ID.png");
  assert.equal(pasteFileName("ID", "", "application/pdf"), "paste-ID.pdf");
  assert.equal(pasteFileName("ID", "", ""), "paste-ID.bin");
});

test("pasteFileName: a name without extension gets one from the content type", () => {
  assert.equal(pasteFileName("ID", "screenshot", "image/png"), "paste-ID-screenshot.png");
});

test("pasteFileName: strips path-ish and shell-hostile characters", () => {
  // basename defeats traversal; the rest is sanitised, leading dots removed.
  assert.equal(pasteFileName("ID", "../../etc/passwd", "application/octet-stream"), "paste-ID-passwd.bin");
  assert.equal(pasteFileName("ID", ".bashrc", "text/plain"), "paste-ID-bashrc.txt"); // leading dot stripped, ext from type
  assert.ok(!/[/\\;]/.test(pasteFileName("ID", "a;b/c.txt", "text/plain")));
});

test("shouldPreempt: a busy refusal takes the hand and resends", () => {
  // The behaviour asked for: writing while the agent is mid-turn interrupts it
  // and sends the new message, instead of answering "a response is already in
  // progress" and dropping what was typed.
  assert.equal(shouldPreempt({ code: "busy", text: "nouveau message" }), true);
});

test("shouldPreempt: only a busy refusal — every other error is just shown", () => {
  // A link refusal, a logged-out spawn, a submit failure: interrupting the agent
  // would neither fix them nor be expected.
  assert.equal(shouldPreempt({ code: "link-refused", text: "x" }), false);
  assert.equal(shouldPreempt({ text: "x" }), false);
});

test("shouldPreempt: nothing to resend means nothing to interrupt for", () => {
  // The refusal can arrive with no prompt of ours in flight (another client's,
  // a stale echo). Killing a turn for a message we do not have would destroy
  // work and replace it with nothing.
  assert.equal(shouldPreempt({ code: "busy" }), false);
  assert.equal(shouldPreempt({ code: "busy", text: "   " }), false);
});

test("shouldPreempt: the same message is never interrupted for twice", () => {
  // The resend can itself be refused (another client claimed the session in
  // between). Retrying then would interrupt again, get refused again — a loop
  // that empties the quota and never delivers.
  assert.equal(shouldPreempt({ code: "busy", text: "same", lastRetried: "same" }), false);
  assert.equal(shouldPreempt({ code: "busy", text: "other", lastRetried: "same" }), true);
});

test("a voice message is recognised, and not as a file", () => {
  // It used to fall through to `null`: a voice note carries no photo and no
  // document, so the message was dropped IN SILENCE — you spoke and nothing
  // whatsoever happened. Its own kind is what stops an .ogg being handed to an
  // agent that cannot read audio; the transcription becomes the prompt instead.
  const att = attachmentOf({ voice: { file_id: "v1", file_unique_id: "u1", duration: 3, file_size: 4096 } });
  assert.ok(att, "a voice message must not be dropped");
  assert.equal(att!.kind, "voice");
  assert.equal(att!.fileId, "v1");
  assert.equal(att!.fileSize, 4096);
});

test("voice wins over nothing, and never shadows a real attachment", () => {
  // Order matters: a caption-bearing photo must stay a photo.
  const photo = attachmentOf({ photo: [{ file_id: "p", file_unique_id: "pu", file_size: 9 }] });
  assert.equal(photo!.kind, "image");
  const doc = attachmentOf({ document: { file_id: "d", file_unique_id: "du", mime_type: "application/pdf" } });
  assert.equal(doc!.kind, "file");
  // And a message with neither is still nothing to act on.
  assert.equal(attachmentOf({ text: "hello" }), null);
});

test("replyContext: a reply quotes who said what", () => {
  // The whole point: "fix that" answering a message from ten minutes ago is
  // unreadable without the thing it answers.
  const ctx = replyContext({
    reply_to_message: { text: "PR #227 is merged", from: { first_name: "Ada" } },
  });
  assert.equal(ctx, '⟦replying to Ada⟧ "PR #227 is merged"');
});

test("replyContext: the agent's own message is named as the agent", () => {
  // A bot has a first_name too ("shadok-ai-test"), and quoting it by that name
  // would read as a third participant in the conversation.
  const ctx = replyContext({
    reply_to_message: { text: "Done, 937 tests green.", from: { is_bot: true, first_name: "shadok" } },
  });
  assert.equal(ctx, '⟦replying to the agent⟧ "Done, 937 tests green."');
});

test("replyContext: a highlighted fragment beats the whole message", () => {
  // Telegram lets you select part of a message when replying (Bot API 7.0).
  // That selection IS the user pointing at something: honour it over the rest.
  const ctx = replyContext({
    quote: { text: "the 20 s timeout" },
    reply_to_message: { text: "a very long message about many other things", from: { first_name: "Ada" } },
  });
  assert.equal(ctx, '⟦replying to Ada⟧ "the 20 s timeout"');
});

test("replyContext: the topic's own creation message is NOT a reply", () => {
  // THE trap: in a forum topic every message carries reply_to_message pointing
  // at the topic's creation service message. Quoting it would staple a useless
  // line onto every single message in every topic.
  assert.equal(
    replyContext({ reply_to_message: { forum_topic_created: { name: "preempt" }, from: { first_name: "Ada" } } }),
    undefined,
  );
});

test("replyContext: no reply, nothing added", () => {
  assert.equal(replyContext({ text: "hello" }), undefined);
  assert.equal(replyContext({}), undefined);
});

test("replyContext: a media reply says what it is rather than quoting nothing", () => {
  // An empty quote ('⟦replying to Ada⟧ ""') reads as a bug; naming the medium
  // at least tells the agent what was pointed at.
  assert.equal(
    replyContext({ reply_to_message: { photo: [{}], from: { first_name: "Ada" } } }),
    "⟦replying to Ada⟧ [a photo]",
  );
  assert.equal(
    replyContext({ reply_to_message: { document: {}, caption: "the log", from: { first_name: "Ada" } } }),
    '⟦replying to Ada⟧ "the log"',
  );
});

test("replyContext: a long quote is cut, and says that it was", () => {
  // The quote rides on every prompt: unbounded, it would crowd out the message
  // it is supposed to contextualise.
  const long = "x".repeat(600);
  const ctx = replyContext({ reply_to_message: { text: long, from: { first_name: "Ada" } } })!;
  assert.ok(ctx.length < 420, `quote not bounded: ${ctx.length}`);
  assert.ok(ctx.endsWith('…"'), ctx.slice(-20));
});

test("replyContext: newlines in a quote stay on one line", () => {
  // The quote sits above the message; a multi-line one would be read as part of
  // what the human wrote.
  const ctx = replyContext({ reply_to_message: { text: "line one\nline two", from: { first_name: "Ada" } } });
  assert.equal(ctx, '⟦replying to Ada⟧ "line one line two"');
});

/**
 * The shapes that used to vanish. `handleMessage` drops a message with neither
 * text nor attachment, and a video carries NO `msg.text` — so every field
 * missing from `attachmentOf` was a message swallowed before any binding was
 * touched. That is what the user reported: "shadok doesn't see videos".
 */
test("attachmentOf: a video → kind video, with its length and mime", () => {
  const att = attachmentOf({
    caption: "look at the badge",
    video: { file_id: "v", file_unique_id: "uv", duration: 18, mime_type: "video/mp4", file_size: 1_200_000 },
  });
  assert.deepEqual(att, {
    fileId: "v",
    fileUniqueId: "uv",
    kind: "video",
    fileSize: 1_200_000,
    mimeType: "video/mp4",
    durationSec: 18,
  });
});

test("attachmentOf: a GIF stays a video, even though Telegram also sends `document`", () => {
  // Telegram fills BOTH fields for an animation. As a document it would lose
  // its duration and therefore its storyboard, so `animation` has to win.
  const att = attachmentOf({
    animation: { file_id: "a", file_unique_id: "ua", duration: 3, mime_type: "video/mp4" },
    document: { file_id: "a", file_unique_id: "ua", mime_type: "video/mp4", file_name: "giphy.mp4" },
  });
  assert.equal(att?.kind, "video");
  assert.equal(att?.durationSec, 3);
});

test("attachmentOf: a round video note is a video too", () => {
  const att = attachmentOf({ video_note: { file_id: "n", file_unique_id: "un", duration: 7 } });
  assert.equal(att?.kind, "video");
});

test("attachmentOf: a video sent as a FILE is still looked at as a video", () => {
  // No duration in this shape — the probe recovers it from ffmpeg.
  const att = attachmentOf({
    document: { file_id: "d", file_unique_id: "ud", mime_type: "video/quicktime", file_name: "demo.mov" },
  });
  assert.equal(att?.kind, "video");
  assert.equal(att?.durationSec, undefined);
});

test("attachmentOf: an audio file is handed over rather than dropped", () => {
  // Not transcribed (a 40-minute track would hold the turn hostage), but no
  // longer invisible.
  const att = attachmentOf({
    audio: { file_id: "m", file_unique_id: "um", duration: 190, mime_type: "audio/mpeg", file_name: "memo.mp3" },
  });
  assert.equal(att?.kind, "file");
  assert.equal(att?.fileName, "memo.mp3");
});

test("attachmentOf: a sticker is still nothing to act on — a decision, not a hole", () => {
  // A sticker is a reaction. Waking a whole agent turn for an emoji-equivalent
  // costs more than it tells anyone.
  assert.equal(attachmentOf({ sticker: { file_id: "s", file_unique_id: "us" } }), null);
});

test("mediaExtension: a camera video has no name, so the mime decides", () => {
  assert.equal(mediaExtension({ fileId: "v", fileUniqueId: "uv", kind: "video", mimeType: "video/mp4" }), "mp4");
  assert.equal(mediaExtension({ fileId: "v", fileUniqueId: "uv", kind: "video", mimeType: "video/quicktime" }), "mov");
  // Unknown mime, but a video Telegram transcoded itself is mp4 — an
  // extension-less file reads as "unknown binary".
  assert.equal(mediaExtension({ fileId: "v", fileUniqueId: "uv", kind: "video" }), "mp4");
  assert.equal(mediaExtension({ fileId: "f", fileUniqueId: "uf", kind: "file" }), null);
});

test("mediaFileName: an unnamed video lands as .mp4, not as a bare id", () => {
  assert.equal(
    mediaFileName({ fileId: "v", fileUniqueId: "AQAD", kind: "video", mimeType: "video/mp4" }),
    "AQAD.mp4",
  );
});

test("attachmentPrompt: a video comes with its stills AND the line that says to read them", () => {
  // Load-bearing wording: handed only a path and some images, a model answers
  // that it cannot watch videos and never opens the stills.
  const out = attachmentPrompt(
    [
      {
        path: "/m/AQAD.mp4",
        kind: "video",
        durationSec: 18,
        frames: [
          { path: "/m/AQAD-f1.jpg", atSec: 2.25 },
          { path: "/m/AQAD-f2.jpg", atSec: 6.75 },
        ],
        transcript: "watch the badge when I switch tabs",
      },
    ],
    "look at the badge",
  );
  assert.equal(
    out,
    [
      "[Attached video: /m/AQAD.mp4 (0:18)]",
      "Stills from it — read these images to see the video:",
      "[Attached image: /m/AQAD-f1.jpg] frame 1/2 at 0:02",
      "[Attached image: /m/AQAD-f2.jpg] frame 2/2 at 0:07",
      '⟦heard in the video⟧ "watch the badge when I switch tabs"',
      "look at the badge",
    ].join("\n"),
  );
});

test("attachmentPrompt: audio nobody listened to is NAMED, silence says nothing", () => {
  // An agent told nothing about the sound concludes there was none.
  const unheard = attachmentPrompt([
    { path: "/m/a.mp4", kind: "video", durationSec: 400, audioNote: "this clip has sound, not transcribed." },
  ]);
  assert.match(unheard, /⟦video audio⟧ this clip has sound, not transcribed\./);
  // A silent clip carries neither line.
  const silent = attachmentPrompt([{ path: "/m/b.mp4", kind: "video", durationSec: 5 }]);
  assert.equal(silent, "[Attached video: /m/b.mp4 (0:05)]");
});

test("attachmentPrompt: a photo and a file are untouched by all this", () => {
  assert.equal(
    attachmentPrompt([{ path: "/m/a.jpg", kind: "image" }, { path: "/m/b.zip", kind: "file" }]),
    "[Attached image: /m/a.jpg]\n[Attached file: /m/b.zip]",
  );
});

test("the 20 MB ceiling is named as a ceiling, not as a failure", () => {
  const att = { fileId: "v", fileUniqueId: "uv", kind: "video" as const, fileSize: 34_000_000 };
  assert.ok(tooBigFor(att, new Error("file too large (Telegram bot limit: 20 MB)")));
  // Telegram's own wording, for a file it never sized.
  assert.ok(tooBigFor({ fileId: "v", fileUniqueId: "uv", kind: "video" }, { message: "file is too big" }));
  // A real failure must keep its own message.
  assert.equal(tooBigFor({ fileId: "v", fileUniqueId: "uv", kind: "video" }, new Error("download HTTP 502")), false);
  const notice = tooLargeNotice(att);
  assert.match(notice, /20 MB/);
  assert.match(notice, /34\.0 MB/);
  assert.match(notice, /video/);
});


test("flood control is a delay, not a failure", () => {
  // The refusal that says the message is fine and the moment is wrong. A bot
  // trips it on ITSELF — a burst of four videos is enough — so the busiest
  // moment in a channel is exactly when its answers would start disappearing.
  const wait = floodWaitMs({ ok: false, error_code: 429, parameters: { retry_after: 7 } });
  assert.ok(wait !== null && wait >= 7000, String(wait));
  // Strictly more than asked: retry_after is a floor, and coming back one
  // millisecond early buys a second refusal.
  assert.ok((wait as number) > 7000);
});

test("only flood control is waited out", () => {
  assert.equal(floodWaitMs({ ok: true, result: { message_id: 1 } }), null);
  // A 400 is a real refusal: the message as written will never be accepted.
  assert.equal(floodWaitMs({ ok: false, error_code: 400, description: "can't parse entities" }), null);
  // `null` is "the call itself failed" — no stated delay to wait for, so
  // holding the serial queue on it would be waiting on nothing.
  assert.equal(floodWaitMs(null), null);
  assert.equal(floodWaitMs(undefined), null);
  // A 429 with no retry_after still waits: "too fast" must never be read as
  // "undeliverable" just because the delay was missing.
  assert.ok((floodWaitMs({ ok: false, error_code: 429 }) ?? 0) > 0);
});

test("a rate-limited message is held and then sent, not dropped", async () => {
  const slept: number[] = [];
  let calls = 0;
  const res = await withFloodControl(
    async () => {
      calls++;
      return calls < 3
        ? { ok: false, error_code: 429, parameters: { retry_after: 2 } }
        : { ok: true, result: { message_id: 42 } };
    },
    { sleep: async (ms) => void slept.push(ms) },
  );
  assert.deepEqual(res, { ok: true, result: { message_id: 42 } });
  assert.equal(calls, 3);
  assert.equal(slept.length, 2);
  assert.ok(slept.every((ms) => ms >= 2000));
});

test("the wait is bounded, and the last refusal comes back so it can be reported", async () => {
  // An answer held for ten minutes is no longer an answer. What must NOT
  // happen is swallowing the refusal on the way out: the caller has to be able
  // to say the message was lost.
  let calls = 0;
  const forever = { ok: false, error_code: 429, parameters: { retry_after: 600 } };
  const res = await withFloodControl(
    async () => {
      calls++;
      return forever;
    },
    { sleep: async () => {}, budgetMs: FLOOD_BUDGET_MS },
  );
  assert.deepEqual(res, forever);
  assert.equal(calls, 1, "a delay longer than the whole budget is not even waited once");
});

test("a refusal and an unreachable API do not read the same", () => {
  // Two different facts: Telegram said no (and why), or we never heard back.
  assert.match(refusalReason({ ok: false, error_code: 400, description: "TOPIC_CLOSED" }), /400 TOPIC_CLOSED/);
  assert.match(refusalReason(null), /no answer/i);
  assert.match(refusalReason({ ok: false }), /no reason given/i);
});

test("the long-poll's signal keeps the manual abort AND gains a deadline", async () => {
  // Both halves matter. Without the abort, `stop()` cannot free an in-flight
  // request and a restart meets Telegram's 409 (two getUpdates on one bot).
  // Without the deadline, a request that never settles ends the poll loop for
  // ever — the loop reschedules from the END of each call, so the bridge goes
  // deaf with nothing logged and only a restart brings it back.
  const manual = new AbortController();
  const sig = pollSignal(manual.signal, 60_000);
  assert.equal(sig.aborted, false);
  manual.abort(new Error("stop() pulled it"));
  assert.equal(sig.aborted, true, "the manual abort must still reach the request");

  const fresh = new AbortController();
  const quick = pollSignal(fresh.signal, 20);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(quick.aborted, true, "a request nobody answers must be abandoned");
  assert.equal(fresh.signal.aborted, false, "the deadline fires on its own, not through the controller");
});

test("no call to Telegram may be unbounded", () => {
  // The scan is the test, like the CSP nonce and the WS scheme: nothing in the
  // type system says a `fetch` has a deadline, and every unbounded one found so
  // far cost a bridge that went silent — mute (the serial send queue held
  // behind one call) or deaf (the long-poll never coming back). Both failures
  // left no log line at all, which is why they were measured in production
  // rather than noticed in review.
  const src = fs.readFileSync(new URL("../src/telegram.ts", import.meta.url), "utf8");
  const spans: string[] = [];
  for (let i = src.indexOf("fetch("); i >= 0; i = src.indexOf("fetch(", i + 1)) {
    // The call's own argument list, by balanced parentheses.
    let depth = 0;
    const from = src.indexOf("(", i);
    let j = from;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    spans.push(src.slice(from, j + 1));
  }
  assert.ok(spans.length >= 4, `expected to find the fetch calls, found ${spans.length}`);
  // The long-poll is the ONE caller that brings its own signal, which is also
  // how it opts out of `tg`'s default deadline — so the deadline has to be in
  // the signal it brings, and a scan over `fetch` alone cannot see that.
  assert.match(
    src,
    /pollSignal\(pollAbort\.signal, POLL_DEADLINE_MS\)/,
    "the long-poll must carry its own deadline, not just its abort",
  );
  for (const span of spans) {
    assert.match(
      span.replace(/\s+/g, " "),
      /signal/,
      `a fetch to Telegram with no signal: ${span.replace(/\s+/g, " ").slice(0, 90)}`,
    );
  }
});

test("a prompt queued before the socket is ready arrives exactly like a live one", () => {
  // `pending` used to hold the bare text, so the FIRST message of any new DM or
  // topic — the one that cannot find a ready socket, by construction — reached
  // the server with no author and no voice flag. The server builds the
  // ⟦telegram · date · who⟧ header the AGENT reads out of those two fields, so
  // "hello" from someone it has never heard from was the one message delivered
  // anonymous, and a first voice note read as typed text. One builder, used by
  // both paths, is what makes that impossible — and `PromptFrame` means pushing
  // a bare string no longer compiles.
  assert.deepEqual(promptFrame("hello", "Ada", true), { type: "prompt", text: "hello", from: "Ada", voice: true });
  assert.deepEqual(promptFrame("hello", "Ada"), { type: "prompt", text: "hello", from: "Ada" });
  // Absent, not null: the server tells "nobody said who" from "the author is
  // the empty string", and an explicit `voice: false` would read as a typed
  // message that bothered to say so.
  assert.deepEqual(promptFrame("hello"), { type: "prompt", text: "hello" });
  assert.deepEqual(promptFrame("hi", "", false), { type: "prompt", text: "hi" });
});

test("dialogText: the box's body comes first, then the question — as the TUI draws it", () => {
  const body = "Read file\nThis will read /x/outside/note.txt (outside working directory) via a symlink\nRead(/x/cwd/link)";
  assert.equal(dialogText({ question: "Do you want to proceed?", body }), body + "\n\nDo you want to proceed?");
});

test("dialogText: no body → the question alone, as before", () => {
  assert.equal(dialogText({ question: "Pick one?" }), "Pick one?");
  assert.equal(dialogText({ question: "", body: "  " }), "Choose:");
});

test("dialogText: an oversized body is cut, never the question the buttons answer", () => {
  const t = dialogText({ question: "Do you want to proceed?", body: "x".repeat(5000) }, 100);
  assert.ok(t.length <= 100, String(t.length));
  assert.ok(t.endsWith("…\n\nDo you want to proceed?"), t);
});
