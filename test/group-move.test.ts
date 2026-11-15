import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAIN_GROUP_ID, groupMoveRefusal, type Group } from "../src/groups.js";
import { mergeChannels, type Channel } from "../src/channels.js";
import { groupMoveRefusal as clientRefusal } from "../public/group-nav.js";

const g = (id: string, nature: Group["nature"], members: string[] = []): Group =>
  ({ id, name: id, nature, members, createdAt: 0 }) as Group;
const main = g(MAIN_GROUP_ID, "public");
const pubA = g("pubA", "public");
const pubB = g("pubB", "public");
const priv = g("priv", "restricted", ["ada"]);
const other = g("other", "restricted", ["bob"]);
const personal = { ...g("pers", "private", ["ada"]), owner: "ada" } as Group;
const groups = [main, pubA, pubB, priv, other, personal];
const ada = { name: "ada", role: "member" as const };

test("groupMoveRefusal: public ↔ public and Main ↔ public move", () => {
  assert.equal(groupMoveRefusal("pubA", "pubB", groups, ada), null);
  assert.equal(groupMoveRefusal(MAIN_GROUP_ID, "pubA", groups, ada), null);
  assert.equal(groupMoveRefusal(null, "pubA", groups, ada), null); // group-less = commons
  assert.equal(groupMoveRefusal("pubA", null, groups, ada), null);
  assert.equal(groupMoveRefusal(null, MAIN_GROUP_ID, groups, ada), null); // same group, two spellings
});

test("groupMoveRefusal: nothing crosses a private/Personal wall, either way", () => {
  assert.match(groupMoveRefusal("priv", "pubA", groups, ada)!, /cannot leave/);
  assert.match(groupMoveRefusal("pers", MAIN_GROUP_ID, groups, ada)!, /cannot leave/);
  assert.match(groupMoveRefusal("pubA", "priv", groups, ada)!, /cannot be moved into/);
  assert.match(groupMoveRefusal(null, "pers", groups, ada)!, /cannot be moved into/);
  assert.match(groupMoveRefusal("priv", "pers", groups, ada)!, /cannot leave/);
});

test("groupMoveRefusal: never into a group the caller cannot see, nor one that is gone", () => {
  assert.match(groupMoveRefusal("pubA", "other", groups, ada)!, /not a member/);
  assert.match(groupMoveRefusal("pubA", "nope", groups, ada)!, /no longer exists/);
});

test("mergeChannels: a move goes through only where mayMove says so", () => {
  const stored: Channel[] = [{ sessionId: "a", cwd: "/r", group: "pubA" }];
  const allow = (_p: Channel, to: string | null) => groupMoveRefusal("pubA", to, groups, ada) === null;
  assert.equal(mergeChannels(stored, [{ sessionId: "a", cwd: "/r", group: "pubB" }], new Set(), undefined, allow)[0].group, "pubB");
  assert.equal(mergeChannels(stored, [{ sessionId: "a", cwd: "/r", group: "priv" }], new Set(), undefined, allow)[0].group, "pubA");
  // No predicate: still pinned (internal callers, the safe default).
  assert.equal(mergeChannels(stored, [{ sessionId: "a", cwd: "/r", group: "pubB" }], new Set())[0].group, "pubA");
  // An omitted key never moves anything.
  assert.equal(mergeChannels(stored, [{ sessionId: "a", cwd: "/r" }], new Set(), undefined, () => true)[0].group, "pubA");
  // A group-less row cannot be FILED into a refused group either.
  const bare: Channel[] = [{ sessionId: "b", cwd: "/r" }];
  const out = mergeChannels(bare, [{ sessionId: "b", cwd: "/r", group: "priv" }], new Set(), undefined, () => false)[0];
  assert.equal("group" in out, false);
});

test("the client's groupMoveRefusal agrees with the server's on every pair", () => {
  const all = [null, main, pubA, pubB, priv, personal];
  const idOf = (x: Group | null) => (x ? x.id : null);
  for (const from of all)
    for (const to of all) {
      // The client only ever offers visible groups; the commons is null there.
      const c = clientRefusal(from && from.id !== MAIN_GROUP_ID ? from : null, to && to.id !== MAIN_GROUP_ID ? to : null);
      const s = groupMoveRefusal(idOf(from), idOf(to), groups, ada);
      assert.equal(c === null, s === null, `${idOf(from)} → ${idOf(to)}: client ${c} vs server ${s}`);
    }
});

test("index.html: a refused drop is SAID, and the move rule is bridged with a stub", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /window\.groupMoveRefusal = groupMoveRefusal;/);
  assert.match(html, /groupMoveRefusal: \(\) => null,/);
  assert.match(html, /if \(why\) moveNotice\(why\);/);
  assert.match(html, /return window\.groupMoveRefusal\(zoneGroup\(dragTabHome\), zoneGroup\(zone\)\);/);
});
