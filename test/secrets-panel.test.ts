import assert from "node:assert/strict";
import test from "node:test";
import {
  secretsPanelMode,
  secretSections,
  keyGroups,
  shareTargets,
  auditLine,
} from "../public/secrets-panel.js";

const main = { id: "main", name: "main" };
const comex = { id: "comex", name: "COMEX" };
const sales = { id: "sales", name: "Sales" };

test("mode: only Main (or nothing, or a failed fetch) degrades to the flat list", () => {
  assert.equal(secretsPanelMode([main]), "flat");
  assert.equal(secretsPanelMode([]), "flat");
  assert.equal(secretsPanelMode(null), "flat");
  assert.equal(secretsPanelMode(undefined), "flat");
});

test("mode: any non-Main group makes it grouped", () => {
  assert.equal(secretsPanelMode([main, comex]), "grouped");
  assert.equal(secretsPanelMode([comex]), "grouped");
});

test("sections: partition by the server's source tag, scoped to the selected group", () => {
  const secrets = [
    { name: "A", source: "main" },
    { name: "B", source: "own", ownerGroup: "comex" },
    { name: "C", source: "own", ownerGroup: "sales" },
    { name: "D", source: "shared", ownerGroup: "rh" },
  ];
  const s = secretSections(secrets, "comex");
  assert.deepEqual(s.own.map((x) => x.name), ["B"]);
  assert.deepEqual(s.sharedIn.map((x) => x.name), ["D"]);
  assert.deepEqual(s.inheritedMain.map((x) => x.name), ["A"]);
});

test("sections: shared-in is shown to the group it was lent to only when the group is a recipient", () => {
  const secrets = [{ name: "D", source: "shared", ownerGroup: "rh", sharedWith: ["sales"] }];
  assert.equal(secretSections(secrets, "comex").sharedIn.length, 1); // server already filtered
  assert.equal(secretSections(secrets, null).sharedIn.length, 1);
});

test("sections: no selected group shows every own secret", () => {
  const secrets = [
    { name: "B", source: "own", ownerGroup: "comex" },
    { name: "C", source: "own", ownerGroup: "sales" },
  ];
  assert.equal(secretSections(secrets, null).own.length, 2);
});

test("sections: garbage in gives empty sections, never a throw", () => {
  const s = secretSections(undefined, "x");
  assert.deepEqual(s, { own: [], sharedIn: [], inheritedMain: [] });
  assert.deepEqual(secretSections([null, { name: "Z", source: "weird" }], "x"), { own: [], sharedIn: [], inheritedMain: [] });
});

test("keyGroups: one key per group, Main last-resort only when it is all there is", () => {
  assert.deepEqual(keyGroups([main, comex, sales]).map((g) => g.id), ["comex", "sales"]);
  assert.deepEqual(keyGroups([main]).map((g) => g.id), ["main"]);
});

test("shareTargets: every group except the owner and Main (Main already sees its own)", () => {
  assert.deepEqual(shareTargets([main, comex, sales], "comex").map((g) => g.id), ["sales"]);
});

test("auditLine: who and when, tolerant of missing fields", () => {
  const t = Date.UTC(2026, 9, 1, 12, 0, 0);
  assert.match(auditLine({ createdBy: "ada", createdAt: t, updatedAt: t }), /^created by ada · /);
  assert.match(auditLine({ createdBy: "ada", createdAt: t, updatedAt: t + 86400000 }), /updated /);
  assert.equal(auditLine({}), "");
  assert.match(auditLine({ createdBy: "agent:abcdef123456", createdAt: t }), /agent abcdef12/);
});
