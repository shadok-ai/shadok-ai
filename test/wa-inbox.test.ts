import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openInbox, waStateDir, type InboxEntry } from "../src/wa-inbox.js";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-inbox-")), "state", "inbox.json");
const entry = (id: string, o: Partial<InboxEntry> = {}): InboxEntry => ({
  id,
  sender: "100000000000001@lid",
  text: `text ${id}`,
  at: 1,
  ...o,
});

test("waStateDir sits beside the session directory, not inside it", () => {
  assert.equal(waStateDir("/home/x", "-srv"), path.join("/home/x", ".shadok-ai", "whatsapp-state", "-srv"));
});

test("add → pending, ack → gone; the file is 0600 in a 0700 directory", () => {
  const f = file();
  const box = openInbox(f);
  assert.equal(box.add(entry("A")), true);
  assert.deepEqual(box.pending().map((e) => e.id), ["A"]);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  box.ack("A");
  assert.deepEqual(box.pending(), []);
});

test("a restart keeps what was not acknowledged, and what was seen", () => {
  const f = file();
  const box = openInbox(f);
  box.add(entry("A"));
  box.add(entry("B", { name: "Grace", phone: "33611111111" }));
  box.ack("A");
  const again = openInbox(f);
  assert.deepEqual(again.pending(), [entry("B", { name: "Grace", phone: "33611111111" })]);
  // A redelivery of either, after the restart, is refused: one message, one prompt.
  assert.equal(again.add(entry("A")), false);
  assert.equal(again.add(entry("B")), false);
  assert.equal(again.seen("A"), true);
  assert.equal(again.seen("Z"), false);
});

test("the seen list is capped, and the cap never drops a pending entry", () => {
  const f = file();
  const box = openInbox(f, { seenCap: 3 });
  box.add(entry("P")); // stays pending
  for (const id of ["A", "B", "C", "D"]) {
    box.add(entry(id));
    box.ack(id);
  }
  const again = openInbox(f, { seenCap: 3 });
  assert.equal(again.seen("A"), false, "the oldest seen id fell off");
  assert.equal(again.seen("D"), true);
  assert.deepEqual(again.pending().map((e) => e.id), ["P"]);
  assert.equal(again.seen("P"), true, "pending is seen whatever the cap");
});

test("a corrupt file opens empty and says so, rather than throwing", () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{nope");
  const lines: string[] = [];
  const box = openInbox(f, { log: (l) => lines.push(l) });
  assert.deepEqual(box.pending(), []);
  assert.ok(lines.some((l) => /unreadable/.test(l)));
  assert.equal(box.add(entry("A")), true);
});

test("ack of an unknown id is harmless", () => {
  const box = openInbox(file());
  box.ack("nothing");
  assert.deepEqual(box.pending(), []);
});
