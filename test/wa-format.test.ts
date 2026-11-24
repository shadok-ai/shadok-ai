import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToWhatsApp, neutralizeCommand, stripAttachmentMarkers, waChunks } from "../src/wa-format.js";
import { isSlashCommand } from "../src/promptmeta.js";

test("emphasis becomes WhatsApp's own", () => {
  assert.equal(mdToWhatsApp("a **bold** b"), "a *bold* b");
  assert.equal(mdToWhatsApp("a __bold__ b"), "a *bold* b");
  assert.equal(mdToWhatsApp("an *italic* word"), "an _italic_ word");
  assert.equal(mdToWhatsApp("an _italic_ word"), "an _italic_ word");
  assert.equal(mdToWhatsApp("~~gone~~"), "~gone~");
  assert.equal(mdToWhatsApp("**bold** and *it*"), "*bold* and _it_");
  assert.equal(mdToWhatsApp("5 * 3 * 2 = 30"), "5 * 3 * 2 = 30", "arithmetic is not emphasis");
  assert.equal(mdToWhatsApp("snake_case_name"), "snake_case_name");
});

test("code: inline kept, fences kept with the language dropped, inside untouched", () => {
  assert.equal(mdToWhatsApp("run `npm test` now"), "run `npm test` now");
  assert.equal(mdToWhatsApp("`**not bold**`"), "`**not bold**`");
  assert.equal(mdToWhatsApp("```ts\nconst a = **1**;\n# not a heading\n```"), "```\nconst a = **1**;\n# not a heading\n```");
});

test("headings become bold lines, links text (url)", () => {
  assert.equal(mdToWhatsApp("## Next **steps**"), "*Next steps*");
  assert.equal(mdToWhatsApp("see [the docs](https://example.com/d)"), "see the docs (https://example.com/d)");
  assert.equal(mdToWhatsApp("[https://example.com](https://example.com)"), "https://example.com");
  assert.equal(mdToWhatsApp("![a chart](https://example.com/c.png)"), "a chart (https://example.com/c.png)");
});

test("lists and quotes are kept in WhatsApp's syntax", () => {
  assert.equal(mdToWhatsApp("* one\n* **two**\n  + three"), "- one\n- *two*\n  - three");
  assert.equal(mdToWhatsApp("1. first\n2. second"), "1. first\n2. second");
  assert.equal(mdToWhatsApp("> quoted *text*"), "> quoted _text_");
});

test("tables become plain lines, the rule row dropped", () => {
  const md = "| Item | Price |\n|---|:---:|\n| Tea | **2** |\n| Cake | 4 |";
  assert.equal(mdToWhatsApp(md), "Item · Price\nTea · *2*\nCake · 4");
});

test("no markup is produced: HTML stays literal text, and so does a rule", () => {
  assert.equal(mdToWhatsApp("<b>hi</b>"), "<b>hi</b>");
  assert.equal(mdToWhatsApp("a\n\n---\n\nb"), "a\n\n—\n\nb");
});

test("waChunks cuts long answers at paragraph boundaries", () => {
  const para = (c: string) => c.repeat(3000);
  const parts = waChunks(`${para("a")}\n\n${para("b")}\n\n${para("c")}`);
  assert.equal(parts.length, 3);
  assert.equal(parts[0], para("a"));
  assert.equal(parts[2], para("c"));
  assert.deepEqual(waChunks("short\n\nanswer"), ["short\n\nanswer"]);
  // One paragraph longer than the limit still goes, in pieces.
  assert.ok(waChunks("x".repeat(9000)).every((p) => p.length <= 4000));
  assert.deepEqual(waChunks("   "), []);
});

test("neutralizeCommand: a leading command name stops being a command", () => {
  for (const t of ["/clear", "/login now", "  /model opus", "/my-skill:my-skill go"]) {
    const n = neutralizeCommand(t);
    assert.equal(isSlashCommand(n.trim()), false, t);
    assert.ok(n.includes(t.trim()), "the words still reach the agent");
  }
  for (const t of ["/Users/ada/notes.txt", "hello /clear", "what does /clear do?"]) assert.equal(neutralizeCommand(t), t);
});

test("stripAttachmentMarkers: a server path never reaches a stranger", () => {
  assert.equal(
    stripAttachmentMarkers("look [Attached image: /root/.shadok-ai/media/g-x/a.png] here"),
    "look [image] here",
  );
  assert.equal(stripAttachmentMarkers("[Attached file: /tmp/x.pdf]\n[Attached video: /tmp/v.mp4]"), "[file]\n[video]");
  assert.equal(stripAttachmentMarkers("plain"), "plain");
});
