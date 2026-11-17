import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GROUP_ICONS } from "../public/group-nav.js";
import { CHAN_OVERFLOW } from "../public/bar-overflow.js";
import { profileBadges } from "../public/profile-card.js";

// line-icons.js is a classic script: importing it runs it, and it hangs its API
// off globalThis (no document in node, so it skips the DOM hydration).
await import("../public/line-icons.js");
const LI = (globalThis as unknown as { LineIcons: {
  names: string[]; forEmoji(e: string): string | null; search(q: string): string[]; PICKER: string[]; svg(n: string, s?: number): string;
} }).LineIcons;

test("line icons: every icon a new group can draw has a line drawing", () => {
  for (const e of GROUP_ICONS) assert.ok(LI.forEmoji(e), `no line icon for ${e}`);
});

test("line icons: the emoji's text-presentation variant maps the same", () => {
  assert.equal(LI.forEmoji("🛡️"), "shield");
  assert.equal(LI.forEmoji("🛡"), "shield");
  assert.equal(LI.forEmoji("🦄"), null);
});

test("line icons: the picker offers only mapped icons, and search answers by word", () => {
  for (const e of LI.PICKER) assert.ok(LI.forEmoji(e));
  assert.deepEqual(LI.search("rock"), ["🚀"]);
  assert.ok(LI.search("bug").includes("🐛"));
  assert.deepEqual(LI.search("zzz"), []);
});

test("line icons: every name the UI asks for is drawn", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const asked = new Set<string>();
  for (const m of html.matchAll(/data-ico="([a-zA-Z]+)"/g)) asked.add(m[1]);
  for (const m of html.matchAll(/LineIcons\.(?:svg|el)\("([a-zA-Z]+)"/g)) asked.add(m[1]);
  for (const m of html.matchAll(/(?:menuIcon|menuSub|labelWithIcon\([^,]+,)\s*\(?"([a-zA-Z]+)"/g)) asked.add(m[1]);
  for (const m of html.matchAll(/icon: "([a-zA-Z]+)"/g)) asked.add(m[1]);
  for (const it of CHAN_OVERFLOW) { if (it.icon) asked.add(it.icon); if (it.iconOn) asked.add(it.iconOn); }
  for (const b of profileBadges({ name: "x", tools: "full" } as never)) if (b.icon) asked.add(b.icon);
  assert.ok(asked.size > 20, `the scan found the call sites (${asked.size})`);
  for (const n of asked) assert.ok(LI.names.includes(n), `"${n}" is not in line-icons.js`);
});
