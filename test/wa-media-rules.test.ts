import { test } from "node:test";
import assert from "node:assert/strict";
import { inboundVerdict, replyAllowed, type WaInbound } from "../src/wa-guests.js";
import { dialogMessage, parseDialogReply, waMediaFileName } from "../src/wa-format.js";
import { guestNotice } from "../src/tg-guests.js";

const LID = "100000000000001@lid";
const msg = (o: Partial<WaInbound> = {}): WaInbound => ({ id: "M1", chat: LID, fromMe: false, live: true, unreadable: false, at: 1, ...o });

// ── inbound ─────────────────────────────────────────────────────────────────

test("a picture, a document, a voice note or a video is a medium, its caption riding along", () => {
  const v = inboundVerdict(msg({ media: { kind: "image", mime: "image/jpeg", size: 1000 }, text: "my receipt" }));
  assert.deepEqual(v, { kind: "media", lid: LID, pn: null, media: { kind: "image", mime: "image/jpeg", size: 1000 }, caption: "my receipt" });
  const voice = inboundVerdict(msg({ media: { kind: "audio", mime: "audio/ogg; codecs=opus", voice: true } }));
  assert.equal(voice.kind, "media");
  assert.equal((voice as { caption?: string }).caption, undefined);
});

test("a medium from a group, from the account itself, or replayed is still ignored", () => {
  for (const o of [{ chat: "1203@g.us" }, { fromMe: true }, { live: false }])
    assert.equal(inboundVerdict(msg({ ...o, media: { kind: "image" } })).kind, "ignore");
});

test("an unreadable message is its own verdict, with the address to answer — never a prompt", () => {
  assert.deepEqual(inboundVerdict(msg({ unreadable: true })), { kind: "unreadable", replyTo: LID });
  assert.equal(inboundVerdict(msg({ unreadable: true, fromMe: true })).kind, "ignore");
  assert.equal(inboundVerdict(msg({ unreadable: true, chat: "1203@g.us" })).kind, "ignore");
});

test("replyAllowed: only someone who wrote within the last minutes", () => {
  const recent = new Map([[LID, 1_000]]);
  assert.equal(replyAllowed(recent, LID, 1_000 + 60_000), true);
  assert.equal(replyAllowed(recent, "100000000000001:3@lid", 2_000), true, "a device suffix is the same person");
  assert.equal(replyAllowed(recent, LID, 1_000 + 11 * 60_000), false, "too long ago");
  assert.equal(replyAllowed(recent, "100000000000002@lid", 2_000), false, "never someone who did not write");
});

test("waMediaFileName is rebuilt from safe characters only", () => {
  assert.equal(waMediaFileName("3EB0A1", { kind: "image", mime: "image/jpeg" }), "wa-3EB0A1.jpg");
  assert.equal(waMediaFileName("3EB0A1", { kind: "audio", mime: "audio/ogg; codecs=opus", voice: true }), "wa-3EB0A1.ogg");
  assert.equal(waMediaFileName("3EB/../A1", { kind: "document", mime: "application/pdf", fileName: "../../etc/Price list.pdf" }), "wa-3EBA1-Price list.pdf");
  assert.equal(waMediaFileName("", { kind: "document" }), "wa-m");
});

// ── questions ───────────────────────────────────────────────────────────────

const single = { question: "Which day?", multi: false, options: [{ n: 1, label: "Monday" }, { n: 2, label: "Tuesday" }] };
const withText = { ...single, options: [...single.options, { n: 3, label: "Type something." }] };
const multi = {
  question: "Which extras?",
  multi: true,
  options: [{ n: 1, label: "Milk", checked: true }, { n: 2, label: "Sugar" }, { n: 3, label: "Lemon" }],
};

test("dialogMessage: the question as a numbered list, and how to answer", () => {
  const m = dialogMessage({ ...single, body: "Booking for Ada's shop" });
  assert.match(m, /Booking for Ada's shop\n\nWhich day\?\n\n1\. Monday\n2\. Tuesday\n\n/);
  assert.ok(m.endsWith(guestNotice("dialog-single")!));
  assert.ok(dialogMessage(multi).includes(guestNotice("dialog-multi")!));
  assert.match(dialogMessage(multi), /1\. ☑ Milk/);
  assert.ok(dialogMessage(withText).includes(guestNotice("dialog-text")!));
});

test("parseDialogReply, single choice: the number", () => {
  assert.deepEqual(parseDialogReply(single, "2"), { kind: "choose", n: 2 });
  assert.deepEqual(parseDialogReply(single, " 1. "), { kind: "choose", n: 1 });
  assert.deepEqual(parseDialogReply(single, "2 please"), { kind: "choose", n: 2 });
  assert.deepEqual(parseDialogReply(single, "7"), { kind: "invalid" });
  assert.deepEqual(parseDialogReply(single, "Tuesday"), { kind: "invalid" });
});

test("parseDialogReply, free text: number then text, the number alone, or a sentence when there is one such option", () => {
  assert.deepEqual(parseDialogReply(withText, "3 Thursday morning"), { kind: "freetext", n: 3, text: "Thursday morning" });
  assert.deepEqual(parseDialogReply(withText, "3"), { kind: "need-text", n: 3 });
  assert.deepEqual(parseDialogReply(withText, "Thursday morning"), { kind: "freetext", n: 3, text: "Thursday morning" });
  assert.deepEqual(parseDialogReply(withText, "1"), { kind: "choose", n: 1 });
});

test("parseDialogReply, multiple choice: exactly the toggles that turn what is checked into what was asked", () => {
  // Milk is already checked: "2 3" means Sugar and Lemon, and NOT milk.
  assert.deepEqual(parseDialogReply(multi, "2 3"), { kind: "toggles", toggles: [1, 2, 3] });
  assert.deepEqual(parseDialogReply(multi, "1, 3"), { kind: "toggles", toggles: [3] });
  assert.deepEqual(parseDialogReply(multi, "1"), { kind: "toggles", toggles: [] }, "as it is: just submit");
  assert.deepEqual(parseDialogReply(multi, "1 9"), { kind: "invalid" });
  assert.deepEqual(parseDialogReply(multi, "milk"), { kind: "invalid" });
});

test("the new guest notices name nothing of the cockpit", () => {
  for (const k of ["unreadable", "too-large", "media-failed", "voice-failed", "dialog-single", "dialog-multi", "dialog-text", "dialog-again", "need-text", "ended"] as const) {
    const line = guestNotice(k);
    assert.ok(line && line.length > 10, k);
    assert.doesNotMatch(line!, /pace|session|\/stop|cockpit|agent|web UI|Telegram/i, k);
  }
});
