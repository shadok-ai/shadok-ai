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
  secretChipPick,
  secretReceivers,
  plusReloadPlan,
  ANY_PROFILE,
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
  // Public first, then Personal, then the restricted groups.
  assert.deepEqual(panelGroupOptions(groups), [
    { value: PUBLIC_BUCKET, label: "Public" },
    // A private group is labelled "Personal", not its raw name — so it never
    // collides with a same-named restricted group and stays selectable.
    { value: "ada", label: "Personal" },
    { value: "comex", label: "COMEX" },
  ]);
  // A private group named the same as a restricted one gets a DISTINCT label.
  assert.deepEqual(
    panelGroupOptions([
      { id: "t1", name: "test", nature: "restricted" },
      { id: "t2", name: "test", nature: "private" },
    ]),
    [
      { value: PUBLIC_BUCKET, label: "Public" },
      { value: "t2", label: "Personal" },
      { value: "t1", label: "test" },
    ],
  );
  // Main alone is public: the bucket is always there (it holds Main's secrets).
  assert.deepEqual(panelGroupOptions([main, comex]), [{ value: PUBLIC_BUCKET, label: "Public" }, { value: "comex", label: "COMEX" }]);
  assert.deepEqual(panelGroupOptions(null), []);
});

test("publicWriteTarget: the first public non-Main group, else Main", () => {
  const groups = [
    { id: "main", name: "main", nature: "public" },
    { id: "pub1", name: "group 1", nature: "public" },
    { id: "pub2", name: "group 2", nature: "public" },
  ];
  assert.equal(publicWriteTarget(groups), "pub1");
  assert.equal(publicWriteTarget([main, { id: "comex", name: "C", nature: "restricted" }]), "main");
  assert.equal(publicWriteTarget(null), "main");
});

test("sections: an editable Main secret is own in Public groups, inherited elsewhere", () => {
  const secrets = [
    { name: "MW", source: "main", ownerGroup: "main", editable: true, profiles: [] },
    { name: "MR", source: "main" },
  ];
  const bucket = secretSections(secrets, PUBLIC_BUCKET, [main]);
  assert.deepEqual(bucket.own.map((x: { name: string }) => x.name), ["MW"]);
  assert.deepEqual(bucket.inheritedMain.map((x: { name: string }) => x.name), ["MR"]);
  const other = secretSections(secrets, "comex", [main]);
  assert.deepEqual(other.own, []);
  assert.deepEqual(other.inheritedMain.map((x: { name: string }) => x.name), ["MW", "MR"]);
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

test("shareTargets: a commons-owned secret (Main or a public group) offers no group to lend to", () => {
  const groups = [
    { id: "main", name: "main", nature: "public" },
    { id: "pub", name: "P", nature: "public" },
    { id: "comex", name: "C", nature: "restricted" },
  ];
  assert.deepEqual(shareTargets(groups, "main"), []);
  assert.deepEqual(shareTargets(groups, "pub"), []);
  assert.deepEqual(shareTargets(groups, "x").map((g: { id: string }) => g.id), ["comex"]);
});

// ── The chip rows write as they are ticked (no Save), so one click = one body ──

test("secretChipPick: a click adds or removes, sorted and deduplicated", () => {
  assert.deepEqual(secretChipPick(["b"], "a", true), ["a", "b"]);
  assert.deepEqual(secretChipPick(["a", "b"], "a", false), ["b"]);
  // Already there (a double event, a stale card): the body is the same set.
  assert.deepEqual(secretChipPick(["a", "b"], "a", true), ["a", "b"]);
  assert.deepEqual(secretChipPick(["a", "a", "b"], "c", true), ["a", "b", "c"]);
  assert.deepEqual(secretChipPick(undefined, "a", true), ["a"]);
  assert.deepEqual(secretChipPick(null, "a", false), []);
});

test("secretChipPick: a value with no chip is carried along, never dropped", () => {
  // The panel hides managed roles, and a secret can be bound to one (an agent
  // on that role attaching a secret it created). A click elsewhere must not
  // detach it — the row may only state what it shows.
  assert.deepEqual(secretChipPick(["Shadok-Tweak"], "dev", true), ["Shadok-Tweak", "dev"].sort());
  assert.deepEqual(secretChipPick(["Shadok-Tweak", "dev"], "dev", false), ["Shadok-Tweak"]);
});

test("secretChipPick: 'Any profile' is exclusive with the named profiles, both ways", () => {
  assert.deepEqual(secretChipPick(["dev", "ops"], ANY_PROFILE, true, ANY_PROFILE), ["*"]);
  assert.deepEqual(secretChipPick([ANY_PROFILE], "dev", true, ANY_PROFILE), ["dev"]);
  assert.deepEqual(secretChipPick([ANY_PROFILE], ANY_PROFILE, false, ANY_PROFILE), []);
  // The sharing row has no exclusive option: "*" would be an ordinary value.
  assert.deepEqual(secretChipPick(["g1"], "g2", true), ["g1", "g2"]);
});

// ── Who receives a secret, and what the "+" does once it is written ──────────

const PROFS = [
  { name: "Shadok-dev", secrets: ["OLD_TOKEN"] },
  { name: "Shadok-QA", secrets: [] },
];

test("secretReceivers: both ends of the link, merged", () => {
  // The profile side alone (what the flat form writes).
  assert.deepEqual(secretReceivers(PROFS, [], "OLD_TOKEN"), { profiles: ["Shadok-dev"], any: false });
  // The vault side alone — the binding the grouped panel writes. Reading only
  // the profile side here answered "nobody", which silenced the reload offer.
  const vault = [{ name: "NEW_TOKEN", source: "own", profiles: ["Shadok-QA"] }];
  assert.deepEqual(secretReceivers(PROFS, vault, "NEW_TOKEN"), { profiles: ["Shadok-QA"], any: false });
  // Both, deduplicated and sorted.
  const both = [{ name: "OLD_TOKEN", source: "own", profiles: ["Shadok-QA", "Shadok-dev"] }];
  assert.deepEqual(secretReceivers(PROFS, both, "OLD_TOKEN"), { profiles: ["Shadok-QA", "Shadok-dev"].sort(), any: false });
});

test("secretReceivers: ANY_PROFILE is not a profile name but a flag", () => {
  const vault = [{ name: "T", source: "own", profiles: [ANY_PROFILE, "Shadok-dev"] }];
  assert.deepEqual(secretReceivers([], vault, "T"), { profiles: ["Shadok-dev"], any: true });
  // A read-only tier arrives with no `profiles` at all: the profile side is all
  // we know, and an absent list is not an empty one.
  assert.deepEqual(secretReceivers(PROFS, [{ name: "OLD_TOKEN", source: "main" }], "OLD_TOKEN"),
    { profiles: ["Shadok-dev"], any: false });
  assert.deepEqual(secretReceivers(null, null, "T"), { profiles: [], any: false });
});

test("plusReloadPlan: the agent that asked is reloaded, but never mid-turn", () => {
  const recv = { profiles: ["Shadok-dev"], any: false };
  const dev = { profile: "Shadok-dev", live: true, busy: false };
  assert.equal(plusReloadPlan(dev, recv).action, "reload");
  assert.equal(plusReloadPlan({ ...dev, busy: true }, recv).action, "offer");
  assert.equal(plusReloadPlan({ ...dev, live: false }, recv).action, "none");
  // Nothing feeds it: a respawn would change nothing, so say so instead.
  assert.equal(plusReloadPlan({ ...dev, profile: "Shadok-QA" }, recv).action, "unbound");
  assert.equal(plusReloadPlan({ ...dev, profile: null }, recv).action, "unbound");
  // "unbound" outranks a dead agent: the binding is what the person can fix.
  assert.equal(plusReloadPlan({ profile: "Shadok-QA", live: false, busy: false }, recv).action, "unbound");
  // Any profile reaches an agent with no profile of its own.
  assert.equal(plusReloadPlan({ profile: null, live: true, busy: false }, { profiles: [], any: true }).action, "reload");
  // The panel opened by hand: a later Add never restarts a bystander.
  assert.equal(plusReloadPlan(null, recv).action, "none");
  assert.equal(plusReloadPlan(dev, undefined).action, "unbound");
});
