import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldReattachBridge,
  senderName,
  pasteExtension,
  pasteFileName,
  bindKey,
  chunk,
  parseCommand,
  dialogKeyboard,
  parseCallback,
  makeTyping,
  mdToTelegramHtml,
  attachmentOf,
  mediaFileName,
  attachmentPrompt,
  makeAlbumBuffer,
  migratedGroupId,
  prefaceMatches,
  isStalePreface,
  promptEchoLabel,
  dmGate,
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

test("promptEchoLabel: chaque origine a sa marque", () => {
  assert.equal(promptEchoLabel("web"), "👤 web");
  assert.equal(promptEchoLabel("cron"), "⏰ cron");
  assert.equal(promptEchoLabel("cli"), "⌨️ cli");
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

test("dmGate: the first to write in a DM becomes the owner", () => {
  assert.equal(dmGate(null, 4242), "claim");
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
  assert.deepEqual(att, { fileId: "f", fileUniqueId: "u", kind: "image", fileName: "shot.png", fileSize: 42 });
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
