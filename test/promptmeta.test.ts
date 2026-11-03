import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWhen,
  promptMetaHeader,
  hasPromptMeta,
  markPromptMeta,
  stripPromptMeta,
  parsePromptMeta,
} from "../src/promptmeta.js";
import { classifyUserLine } from "../src/prompt-kind.js";

const AT = new Date("2026-08-25T14:30:00Z");

test("formatWhen: ISO-like in a given zone", () => {
  assert.equal(formatWhen(AT, "UTC"), "2026-08-25 14:30");
  assert.equal(formatWhen(AT, "Europe/Paris"), "2026-08-25 16:30"); // +2 in August
});

test("promptMetaHeader: platform + time, and who when given", () => {
  assert.equal(promptMetaHeader("web", AT, undefined, "UTC"), "⟦web · 2026-08-25 14:30⟧");
  assert.equal(promptMetaHeader("telegram", AT, "Alex", "UTC"), "⟦telegram · 2026-08-25 14:30 · Alex⟧");
  assert.equal(promptMetaHeader("", AT, "  ", "UTC"), "⟦web · 2026-08-25 14:30⟧"); // empties default/dropped
});

test("markPromptMeta: prepends the header as its own line, idempotent", () => {
  const h = promptMetaHeader("web", AT, undefined, "UTC");
  assert.equal(markPromptMeta("do the thing", h), "⟦web · 2026-08-25 14:30⟧\ndo the thing");
  // Re-marking an already-marked message does nothing.
  assert.equal(markPromptMeta(markPromptMeta("x", h), h), "⟦web · 2026-08-25 14:30⟧\nx");
});

test("stripPromptMeta: removes only the header line", () => {
  assert.equal(stripPromptMeta("⟦web · 2026-08-25 14:30⟧\nhello\nworld"), "hello\nworld");
  assert.equal(stripPromptMeta("⟦telegram · 2026-08-25 14:30 · Alex⟧\nhi"), "hi");
});

test("stripPromptMeta: leaves an ordinary message untouched", () => {
  assert.equal(stripPromptMeta("just a message"), "just a message");
  // A lone bracket line without the ' · ' separator is NOT a header.
  assert.equal(stripPromptMeta("⟦important⟧\ntext"), "⟦important⟧\ntext");
  // Brackets mid-message never strip.
  assert.equal(stripPromptMeta("see ⟦web · x⟧ below"), "see ⟦web · x⟧ below");
});

test("hasPromptMeta: strict — the header must open the message", () => {
  assert.equal(hasPromptMeta("⟦web · 2026-08-25 14:30⟧\nx"), true);
  assert.equal(hasPromptMeta("hi\n⟦web · x⟧"), false);
  assert.equal(hasPromptMeta("⟦no separator⟧\nx"), false);
});

test("parsePromptMeta: recovers platform and sender (Telegram), else who is empty", () => {
  assert.deepEqual(parsePromptMeta("⟦telegram · 2026-08-25 14:30 · Michael Chekroun⟧\nhi"), {
    platform: "telegram",
    who: "Michael Chekroun",
  });
  assert.deepEqual(parsePromptMeta("⟦web · 2026-08-25 14:30⟧\nhi"), { platform: "web", who: "" });
  assert.equal(parsePromptMeta("just a plain message"), null);
});

test("parsePromptMeta: round-trips promptMetaHeader, and a name with ' · ' survives", () => {
  assert.deepEqual(parsePromptMeta(promptMetaHeader("telegram", AT, "Alex", "UTC") + "\nx"), {
    platform: "telegram",
    who: "Alex",
  });
  // Everything past the time is the name, so a separator inside it is kept.
  assert.equal(parsePromptMeta("⟦telegram · 2026-08-25 14:30 · A · B⟧\nx")?.who, "A · B");
});

test("a voice note is marked in the PLATFORM, and parsing stays intact", () => {
  // The platform field carries it, not a different origin: the server only adds
  // a header when the origin is exactly web / telegram / cli, so an origin of
  // "telegram vocal" would have dropped the header — time and sender included.
  // What must hold: the sender still parses out whole, and the mark is visible.
  const h = promptMetaHeader("telegram vocal", new Date("2026-09-25T21:06:00Z"), "Alexandre", "Europe/Paris");
  assert.match(h, /telegram vocal/);
  const parsed = parsePromptMeta(markPromptMeta("ajoute un test", h));
  assert.equal(parsed?.platform, "telegram vocal");
  assert.equal(parsed?.who, "Alexandre", "the sender must survive the extra word");
  // And the display still strips it: the human sees their words, not the header.
  assert.equal(stripPromptMeta(markPromptMeta("ajoute un test", h)), "ajoute un test");
});

test("an agent header carries a reply address, and the chat never sees it", () => {
  // A name is not an address — nothing makes tab names unique — so the sender's
  // short session id rides at the END of an agent header.
  const h = promptMetaHeader("agent", AT, "Shadok-Boss", "UTC", "b1c347bc");
  assert.equal(h, "⟦agent · 2026-08-25 14:30 · Shadok-Boss · b1c347bc⟧");
  // Split back OUT of the name: `who` is what labels the bubble on reload, so an
  // address left inside it would be printed in the chat forever after.
  assert.deepEqual(parsePromptMeta(h + "\nva voir"), {
    platform: "agent",
    who: "Shadok-Boss",
    ref: "b1c347bc",
  });
});

test("the reply address never eats into a sender's name", () => {
  // `who` is "everything past the time" precisely so a name with " · " survives;
  // the split is narrow on purpose — agent platform, exact 8 hex, last field.
  assert.deepEqual(parsePromptMeta("⟦agent · 2026-08-25 14:30 · A · B · b1c347bc⟧\nx"), {
    platform: "agent",
    who: "A · B",
    ref: "b1c347bc",
  });
  // Not an id-shaped field: all name, no ref.
  assert.deepEqual(parsePromptMeta("⟦agent · 2026-08-25 14:30 · Ada · Lovelace⟧\nx"), {
    platform: "agent",
    who: "Ada · Lovelace",
  });
  // Another platform never splits, however id-shaped the last field looks.
  assert.deepEqual(parsePromptMeta("⟦telegram · 2026-08-25 14:30 · Alex · b1c347bc⟧\nx"), {
    platform: "telegram",
    who: "Alex · b1c347bc",
  });
});

test("a reply address with no sender is dropped rather than read as the name", () => {
  // It would land in the name's position and parse back as one.
  assert.equal(promptMetaHeader("agent", AT, undefined, "UTC", "b1c347bc"), "⟦agent · 2026-08-25 14:30⟧");
});

test("a replayed agent prompt is labelled with the name alone", () => {
  // The end of the chain the header exists for: `from` is what the client turns
  // into the bubble's label (`echoAuthor`), so this is where an address kept
  // inside the name would surface — in the chat, on every reload, forever.
  const line = {
    type: "user",
    message: { content: "⟦agent · 2026-11-02 15:40 · Shadok-Boss · b1c347bc⟧\nva voir" },
  };
  assert.deepEqual(classifyUserLine(line), {
    kind: "prompt",
    text: "va voir",
    from: "Shadok-Boss",
    origin: "agent",
  });
});
