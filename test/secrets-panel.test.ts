import assert from "node:assert/strict";
import test from "node:test";
import {
  secretsPanelMode,
  secretSections,
  keyGroups,
  shareTargets,
  auditLine,
  panelGroupOptions,
  publicWriteTarget,
  PUBLIC_BUCKET,
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

test("panelGroupOptions: restricted/private listed individually, public groups collapsed into one bucket, Main dropped", () => {
  const groups = [
    { id: "main", name: "main", nature: "public" },
    { id: "pub1", name: "group 1", nature: "public" },
    { id: "pub2", name: "group 2", nature: "public" },
    { id: "comex", name: "COMEX", nature: "restricted" },
    { id: "ada", name: "Ada", nature: "private" },
  ];
  assert.deepEqual(panelGroupOptions(groups), [
    { value: "comex", label: "COMEX" },
    // A private group is labelled "Personal", not its raw name — so it never
    // collides with a same-named restricted group and stays selectable.
    { value: "ada", label: "Personal" },
    { value: PUBLIC_BUCKET, label: "Public groups" },
  ]);
  // A private group named the same as a restricted one gets a DISTINCT label.
  assert.deepEqual(
    panelGroupOptions([
      { id: "t1", name: "test", nature: "restricted" },
      { id: "t2", name: "test", nature: "private" },
    ]),
    [
      { value: "t1", label: "test" },
      { value: "t2", label: "Personal" },
    ],
  );
  // No public non-Main group → no bucket entry.
  assert.deepEqual(panelGroupOptions([main, comex]), [{ value: "comex", label: "COMEX" }]);
  assert.deepEqual(panelGroupOptions(null), []);
});

test("publicWriteTarget: the first public non-Main group, or null", () => {
  const groups = [
    { id: "main", name: "main", nature: "public" },
    { id: "pub1", name: "group 1", nature: "public" },
    { id: "pub2", name: "group 2", nature: "public" },
  ];
  assert.equal(publicWriteTarget(groups), "pub1");
  assert.equal(publicWriteTarget([main, { id: "comex", name: "C", nature: "restricted" }]), null);
  assert.equal(publicWriteTarget(null), null);
});

test("sections: the Public-groups bucket aggregates every public group's own secrets", () => {
  const groups = [
    { id: "main", name: "main", nature: "public" },
    { id: "pub1", name: "group 1", nature: "public" },
    { id: "pub2", name: "group 2", nature: "public" },
    { id: "comex", name: "COMEX", nature: "restricted" },
  ];
  const secrets = [
    { name: "A", source: "main" },
    { name: "P1", source: "own", ownerGroup: "pub1" },
    { name: "P2", source: "own", ownerGroup: "pub2" },
    { name: "X", source: "own", ownerGroup: "comex" },
  ];
  // The bucket gathers pub1 + pub2, never the restricted group.
  assert.deepEqual(secretSections(secrets, PUBLIC_BUCKET, groups).own.map((x) => x.name).sort(), ["P1", "P2"]);
  // A concrete restricted group still scopes to itself.
  assert.deepEqual(secretSections(secrets, "comex", groups).own.map((x) => x.name), ["X"]);
});

test("keyGroups: one key per group, Main last-resort only when it is all there is", () => {
  assert.deepEqual(keyGroups([main, comex, sales]).map((g) => g.id), ["comex", "sales"]);
  assert.deepEqual(keyGroups([main]).map((g) => g.id), ["main"]);
});

test("shareTargets: every group except the owner and Main (Main already sees its own)", () => {
  assert.deepEqual(shareTargets([main, comex, sales], "comex").map((g) => g.id), ["sales"]);
});

test("shareTargets: public groups are NOT offered (public = commons, already read by all)", () => {
  // A public non-Main group is part of the commons: every agent already
  // resolves its tier, so lending a secret TO it is as meaningless as lending
  // to Main. Restricted/private groups stay — they are real sealed vaults.
  const pub = { id: "pub", name: "Public", nature: "public" };
  const perso = { id: "perso", name: "Perso", nature: "private" };
  const restr = { id: "restr", name: "Restricted", nature: "restricted" };
  assert.deepEqual(
    shareTargets([main, comex, pub, perso, restr], "comex").map((g) => g.id),
    ["perso", "restr"],
  );
});

test("auditLine: who and when, tolerant of missing fields", () => {
  const t = Date.UTC(2026, 9, 1, 12, 0, 0);
  assert.match(auditLine({ createdBy: "ada", createdAt: t, updatedAt: t }), /^created by ada · /);
  assert.match(auditLine({ createdBy: "ada", createdAt: t, updatedAt: t + 86400000 }), /updated /);
  assert.equal(auditLine({}), "");
  assert.match(auditLine({ createdBy: "agent:abcdef123456", createdAt: t }), /agent abcdef12/);
});
