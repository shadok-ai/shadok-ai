import { test } from "node:test";
import assert from "node:assert/strict";
import { guestSlicesOf, shareableTargets, visibleSecrets, longLivedTokenInfo, LONG_LIVED_TOKEN_TTL_MS, RESERVED_SECRET_NAMES, filterReserved, resolveSecretValues, secretNamesForProfile, ANY_PROFILE, agentOverwriteRefusal, secretNameRefusal, suggestSecretName, migrateFlatVault, normalizeVault, type Vault, type SecretEntry } from "../src/secrets.js";

const e = (value: string, ownerGroup: string, sharedWith: string[] = []): SecretEntry => ({
  value, ownerGroup, sharedWith, profiles: [], createdBy: "u", createdAt: 1, updatedAt: 1,
});

const eb = (value: string, ownerGroup: string, profiles: string[], sharedWith: string[] = []): SecretEntry => ({
  value, ownerGroup, sharedWith, profiles, createdBy: "u", createdAt: 1, updatedAt: 1,
});

test("secretNamesForProfile: binds on the SECRET side (entry.profiles), scoped to the agent's group", () => {
  const v: Vault = {
    g: { OWN: eb("x", "g", ["Dev"]), OTHER: eb("y", "g", ["QA"]) },      // OWN bound to Dev, OTHER to QA
    b: { SHARED: eb("s", "b", ["Dev"], ["g"]) },                           // shared with g, bound to Dev
    main: { COMMON: eb("m", "main", ["Dev"]) },                            // Main, bound to Dev
    x: { FOREIGN: eb("z", "x", ["Dev"]) },                                 // another group, NOT resolvable from g
  };
  // From group g: OWN + SHARED + COMMON bind Dev; OTHER binds QA; FOREIGN is not reachable.
  assert.deepEqual(secretNamesForProfile(v, "g", "Dev").sort(), ["COMMON", "OWN", "SHARED"]);
  assert.deepEqual(secretNamesForProfile(v, "g", "QA").sort(), ["OTHER"]);
  // Legacy profile.secrets are unioned in (flat / mono-tenant back-compat).
  assert.deepEqual(secretNamesForProfile(v, "g", "Dev", ["LEGACY"]).sort(), ["COMMON", "LEGACY", "OWN", "SHARED"]);
  // No profile name → only the legacy list, never the bindings.
  assert.deepEqual(secretNamesForProfile(v, "g", "", ["LEGACY"]), ["LEGACY"]);
});

test("secretNamesForProfile: ANY_PROFILE reaches every agent the secret resolves for — and no further", () => {
  const v: Vault = {
    g: { ANY: eb("a", "g", [ANY_PROFILE]), DEV: eb("d", "g", ["Dev"]) },
    x: { FOREIGN_ANY: eb("z", "x", [ANY_PROFILE]) }, // another group: still not reachable from g
  };
  assert.deepEqual(secretNamesForProfile(v, "g", "Dev").sort(), ["ANY", "DEV"]);
  assert.deepEqual(secretNamesForProfile(v, "g", "QA"), ["ANY"]);
  assert.deepEqual(secretNamesForProfile(v, "g", ""), ["ANY"], "an agent with no profile is 'any' too");
  assert.deepEqual(secretNamesForProfile(v, "x", "QA"), ["FOREIGN_ANY"]);
});

test("resolve: a PUBLIC group is a commons — its secret resolves for every group", () => {
  const v: Vault = {
    pub: { PK: eb("pv", "pub", ["Dev"]) },   // a public group's secret, bound to Dev
    main: { MK: e("mv", "main") },
    priv: { },                                // a private group with nothing of its own
  };
  const commons = ["main", "pub"]; // Main + the public group
  // An agent in the PRIVATE group resolves the public secret (commons), and Main.
  assert.deepEqual(resolveSecretValues(v, "priv", ["PK", "MK"], commons), { PK: "pv", MK: "mv" });
  // And its profile binding is honoured cross-group: Dev gets PK from the private group.
  assert.deepEqual(secretNamesForProfile(v, "priv", "Dev", [], commons), ["PK"]);
  // Without the public group in the commons list (default = Main only), it does NOT resolve.
  assert.deepEqual(resolveSecretValues(v, "priv", ["PK"]), {});
});

test("resolve: own beats shared-in beats Main beats absent", () => {
  const v: Vault = {
    main: { K: e("main", "main"), M: e("m", "main") },
    a: { K: e("own", "a") },
    b: { K: e("shared", "b", ["a"]), S: e("s", "b", ["a"]) },
  };
  assert.deepEqual(resolveSecretValues(v, "a", ["K", "S", "M", "NOPE"]), { K: "own", S: "s", M: "m" });
  const v2: Vault = { main: { K: e("main", "main") }, b: { K: e("shared", "b", ["a"]) } };
  assert.equal(resolveSecretValues(v2, "a", ["K"]).K, "shared");
  assert.equal(resolveSecretValues({ main: v2.main }, "a", ["K"]).K, "main");
});

test("resolve: same name in two groups resolves independently", () => {
  const v: Vault = { a: { T: e("ta", "a") }, b: { T: e("tb", "b") } };
  assert.equal(resolveSecretValues(v, "a", ["T"]).T, "ta");
  assert.equal(resolveSecretValues(v, "b", ["T"]).T, "tb");
  assert.deepEqual(resolveSecretValues(v, "c", ["T"]), {});
});

test("resolve: shared-in does not leak to a third group", () => {
  const v: Vault = { b: { S: e("s", "b", ["a"]) } };
  assert.equal(resolveSecretValues(v, "a", ["S"]).S, "s");
  assert.deepEqual(resolveSecretValues(v, "c", ["S"]), {});
});

test("migrateFlatVault: every entry under Main", () => {
  const v = migrateFlatVault({ A: "1", B: "2" }, "main", "alice", 5);
  assert.deepEqual(Object.keys(v), ["main"]);
  assert.deepEqual(v.main.A, { value: "1", ownerGroup: "main", sharedWith: [], profiles: [], createdBy: "alice", createdAt: 5, updatedAt: 5 });
  assert.equal(v.main.B.value, "2");
});

test("normalizeVault: flat -> Main; nested passes through with defaults; junk -> {}", () => {
  assert.equal(normalizeVault({ A: "1" }, 9).main.A.createdAt, 9);
  const n = normalizeVault({ g: { X: { value: "v" }, Y: { value: "w", sharedWith: ["a"], ownerGroup: "g", createdAt: 3 } } }, 9);
  assert.deepEqual(n.g.X, { value: "v", ownerGroup: "g", sharedWith: [], profiles: [], createdBy: "", createdAt: 9, updatedAt: 9 });
  assert.deepEqual(n.g.Y.sharedWith, ["a"]);
  assert.equal(n.g.Y.createdAt, 3);
  assert.deepEqual(normalizeVault("x"), {});
  assert.deepEqual(normalizeVault([1]), {});
});

test("normalizeVault: mono-tenant legacy values resolve unchanged through Main", () => {
  const v = normalizeVault({ "/repo/a": { A: "1" }, B: "2" });
  assert.deepEqual(resolveSecretValues(v, "main", ["A", "B"]), { A: "1", B: "2" });
});

test("resolve: a prototype-key name the group does not own resolves ABSENT, never throws", () => {
  // `constructor` / `toString` are inherited from Object.prototype: a bare
  // `gv[name]` returns a function, which is truthy and has no `.sharedWith`.
  const v: Vault = { g: { A: e("a", "g") }, b: { X: e("x", "b") } };
  assert.doesNotThrow(() => resolveSecretValues(v, "g", ["constructor", "toString"]));
  assert.deepEqual(resolveSecretValues(v, "g", ["constructor", "toString"]), {});
  // A caller whose own group is absent still gets a clean answer: the
  // shared-in scan must not crash on the inherited `constructor` of group g.
  assert.doesNotThrow(() => resolveSecretValues(v, "nobody", ["constructor", "toString", "X"]));
  assert.deepEqual(resolveSecretValues(v, "nobody", ["constructor", "toString", "X"]), {});
});

test("resolve: prototype-key names do not disturb normal names in the same group", () => {
  const v: Vault = { g: { A: e("a", "g") }, b: { S: e("s", "b", ["g"]) }, main: { M: e("m", "main") } };
  assert.deepEqual(
    resolveSecretValues(v, "g", ["constructor", "A", "toString", "S", "M", "hasOwnProperty"]),
    { A: "a", S: "s", M: "m" },
  );
});

test("reserved: MT_CLAUDE_OAUTH_TOKEN is hidden from the listing but still resolves", () => {
  const v: Vault = { main: { MT_CLAUDE_OAUTH_TOKEN: e("tok", "main"), NORMAL: e("n", "main") } };
  assert.ok(RESERVED_SECRET_NAMES.has("MT_CLAUDE_OAUTH_TOKEN"));
  assert.deepEqual(visibleSecrets(v, new Set(["main"])).map((s) => s.name), ["NORMAL"]);
  assert.equal(resolveSecretValues(v, "main", ["MT_CLAUDE_OAUTH_TOKEN"]).MT_CLAUDE_OAUTH_TOKEN, "tok");
});

test("reserved: hidden in any group/source", () => {
  const v: Vault = { a: { MT_CLAUDE_OAUTH_TOKEN: e("x", "a", ["b"]) } };
  assert.deepEqual(visibleSecrets(v, new Set(["a"])), []);
  assert.deepEqual(visibleSecrets(v, new Set(["b"])), []);
});

test("longLivedTokenInfo: MT + token → updatedAt + 1 year; mono / absent → false", () => {
  const ent = { ...e("tok", "main"), updatedAt: 5_000 };
  const v: Vault = { main: { MT_CLAUDE_OAUTH_TOKEN: ent } };
  assert.deepEqual(longLivedTokenInfo(v, "multi-tenant"), { longLived: true, longLivedExpiresAt: 5_000 + LONG_LIVED_TOKEN_TTL_MS });
  assert.deepEqual(longLivedTokenInfo(v, "mono-tenant"), { longLived: false, longLivedExpiresAt: null });
  assert.deepEqual(longLivedTokenInfo({ main: {} }, "multi-tenant"), { longLived: false, longLivedExpiresAt: null });
  const bad: Vault = { main: { MT_CLAUDE_OAUTH_TOKEN: { ...ent, updatedAt: NaN } } };
  assert.deepEqual(longLivedTokenInfo(bad, "multi-tenant"), { longLived: true, longLivedExpiresAt: null });
});

test("filterReserved drops server-owned names and keeps the rest in order", () => {
  assert.deepEqual(filterReserved(["A", "MT_CLAUDE_OAUTH_TOKEN", "B"]), ["A", "B"]);
});

test("visibleSecrets: a Main secret carries its profiles only for a caller who may write Main", () => {
  const v: Vault = { main: { M: eb("m", "main", ["Dev"]) } };
  assert.deepEqual(visibleSecrets(v, new Set())[0], { name: "M", source: "main", createdBy: "u", createdAt: 1, updatedAt: 1 });
  const w = visibleSecrets(v, new Set(), true)[0];
  assert.equal(w.source, "main");
  assert.equal(w.editable, true);
  assert.equal(w.ownerGroup, "main");
  assert.deepEqual(w.profiles, ["Dev"]);
});

test("agentOverwriteRefusal: an agent may not replace an Any-profile secret; a person may, and other secrets stay as before", () => {
  assert.equal(typeof agentOverwriteRefusal({ profiles: [ANY_PROFILE] }, true), "string");
  assert.equal(agentOverwriteRefusal({ profiles: [ANY_PROFILE] }, false), null);
  assert.equal(agentOverwriteRefusal({ profiles: ["Dev"] }, true), null);
  assert.equal(agentOverwriteRefusal(undefined, true), null);
});

test("secretNameRefusal: a valid environment variable name passes", () => {
  for (const n of ["API_KEY", "x", "_TOKEN", "Key2"]) assert.equal(secretNameRefusal(n), null, n);
});

test("secretNameRefusal: a space, a dash or a leading digit is refused, saying why and suggesting a name", () => {
  const space = secretNameRefusal("my api key");
  assert.match(space ?? "", /contains a space/);
  assert.match(space ?? "", /MY_API_KEY/);
  assert.match(secretNameRefusal("API-KEY") ?? "", /other than letters, digits and _/);
  assert.match(secretNameRefusal("2FA_CODE") ?? "", /starts with a digit/);
  assert.equal(suggestSecretName("2fa code"), "_2FA_CODE");
  assert.equal(suggestSecretName("é"), "MY_SECRET");
});

// ── A guest conversation's own slice (external groups, step 4) ───────────
// The vault is keyed by the ISOLATION UNIT: a group id for every group but an
// external one, `"<group>/<conversation>"` there. These lock the two directions
// that matter — nothing resolves INTO a guest's slice, and nothing resolves OUT
// of it — plus the member-facing listing, which is names and never values.

const CONV = "ext/tg-55";
const CONV2 = "ext/tg-66";

const guestVault = (): Vault => ({
  main: { TOKEN: e("commons-value", "main"), ONLY_MAIN: e("m", "main") },
  lender: { LENT: e("l", "lender", ["ext", CONV]) },
  [CONV]: { TOKEN: e("the-guest-own", CONV), MINE: e("x", CONV) },
  [CONV2]: { TOKEN: e("another-guest", CONV2) },
});

test("guest slice: resolves to ITSELF and nothing else — no shared-in, no commons, no Main", () => {
  const v = guestVault();
  // Its own names, with its own values.
  assert.deepEqual(resolveSecretValues(v, CONV, ["TOKEN", "MINE"]), { TOKEN: "the-guest-own", MINE: "x" });
  // Main's commons name: absent, NOT the commons value. This is the whole of
  // design decision 4 — "its own slice and nothing else".
  assert.deepEqual(resolveSecretValues(v, CONV, ["ONLY_MAIN"]), {});
  // A secret explicitly lent TO this conversation is still refused: a `sharedWith`
  // naming it would otherwise be a way back in, from outside.
  assert.deepEqual(resolveSecretValues(v, CONV, ["LENT"]), {});
  // And a sibling conversation's value never appears, same name or not.
  assert.equal(resolveSecretValues(v, CONV, ["TOKEN"]).TOKEN, "the-guest-own");
  assert.equal(resolveSecretValues(v, CONV2, ["TOKEN"]).TOKEN, "another-guest");
});

test("guest slice: a GROUP unit still resolves exactly as before — nothing about an existing instance changes", () => {
  const v = guestVault();
  assert.equal(resolveSecretValues(v, "ext", ["ONLY_MAIN"]).ONLY_MAIN, "m");
  assert.equal(resolveSecretValues(v, "ext", ["LENT"]).LENT, "l");
  // This external GROUP holds no slice of its own here, so its name resolves
  // from the commons, as for any group.
  assert.equal(resolveSecretValues(v, "ext", ["TOKEN"]).TOKEN, "commons-value");
});

// The external GROUP's own slice: the door's group secrets (2026-11-28).
const withGroupSecrets = (): Vault => ({
  ...guestVault(),
  ext: { SERVICE_KEY: e("for-every-guest", "ext"), TOKEN: e("group-token", "ext") },
});

test("guest slice: its external GROUP's own secrets reach every conversation — and only those", () => {
  const v = withGroupSecrets();
  for (const conv of [CONV, CONV2]) assert.equal(resolveSecretValues(v, conv, ["SERVICE_KEY"]).SERVICE_KEY, "for-every-guest");
  // A conversation's own entry wins the same name.
  assert.equal(resolveSecretValues(v, CONV, ["TOKEN"]).TOKEN, "the-guest-own");
  // The rest of the chain stays shut: no commons, nothing lent.
  assert.deepEqual(resolveSecretValues(v, CONV, ["ONLY_MAIN", "LENT"]), {});
  // Another external group's secrets never reach this door.
  const other: Vault = { ...v, ext2: { ELSEWHERE: e("no", "ext2") } };
  assert.deepEqual(resolveSecretValues(other, CONV, ["ELSEWHERE"]), {});
});

test("guest slice: the group's secrets are injected with no profile binding, beside its own", () => {
  const v = withGroupSecrets();
  assert.deepEqual(secretNamesForProfile(v, CONV, "Dev").sort(), ["MINE", "SERVICE_KEY", "TOKEN"]);
  assert.deepEqual(secretNamesForProfile(v, CONV2, "").sort(), ["SERVICE_KEY", "TOKEN"]);
});

test("visibleSecrets: a guest lists its group's secrets as lent to it, its own winning a shared name", () => {
  const list = visibleSecrets(withGroupSecrets(), new Set(["ext"]), false, CONV);
  assert.deepEqual(list.map((s) => [s.name, s.source, s.ownerGroup]), [
    ["MINE", "own", CONV],
    ["SERVICE_KEY", "shared", "ext"],
    ["TOKEN", "own", CONV],
  ]);
  // A sibling conversation's names still never appear.
  assert.equal(visibleSecrets(withGroupSecrets(), new Set(["ext"]), false, CONV).some((s) => s.ownerGroup === CONV2), false);
});

test("guest slice: every own name is injected, with no profile binding and no legacy profile list", () => {
  const v = guestVault();
  // No `profiles` on any entry, and no profile name passed: a group would get
  // nothing here. A conversation gets all of its own.
  assert.deepEqual(secretNamesForProfile(v, CONV, "Dev").sort(), ["MINE", "TOKEN"]);
  assert.deepEqual(secretNamesForProfile(v, CONV, "").sort(), ["MINE", "TOKEN"]);
  // The legacy `profile.secrets` list is DROPPED, not unioned: that list is
  // shared by every stranger on the door, so a name on it would resolve the
  // same way for all of them.
  assert.deepEqual(secretNamesForProfile(v, CONV, "Dev", ["ONLY_MAIN"]).sort(), ["MINE", "TOKEN"]);
});

test("visibleSecrets: a member of the group sees a guest's NAMES, tagged with the conversation", () => {
  const list = visibleSecrets(guestVault(), new Set(["ext", "lender"]));
  const guests = list.filter((s) => s.source === "guest");
  assert.deepEqual(
    guests.map((s) => [s.conversation, s.name, s.unit, s.ownerGroup]),
    [["tg-55", "MINE", CONV, "ext"], ["tg-55", "TOKEN", CONV, "ext"], ["tg-66", "TOKEN", CONV2, "ext"]],
  );
  // Never a value, on any row — the vault's existing rule, and the reason a
  // stranger's slice can be shown to a member at all.
  for (const row of list) assert.equal((row as Record<string, unknown>).value, undefined);
});

test("visibleSecrets: a guest's NAME never displaces the group's own secret of the same name", () => {
  const v: Vault = { ext: { TOKEN: e("group-own", "ext") }, [CONV]: { TOKEN: e("guest-own", CONV) } };
  const list = visibleSecrets(v, new Set(["ext"]));
  assert.deepEqual(list.map((s) => s.source), ["own", "guest"]);
});

test("visibleSecrets: a guest sees its OWN slice only — never another conversation's", () => {
  const list = visibleSecrets(guestVault(), new Set(["ext"]), false, CONV);
  assert.deepEqual(list.map((s) => s.name), ["MINE", "TOKEN"]);
  assert.deepEqual([...new Set(list.map((s) => s.ownerGroup))], [CONV]);
});

test("visibleSecrets: a member of ANOTHER group sees no guest row at all", () => {
  const list = visibleSecrets(guestVault(), new Set(["lender"]));
  assert.deepEqual(list.filter((s) => s.source === "guest"), []);
});

test("guestSlicesOf: every conversation slice of a group, names only and sorted", () => {
  const v = guestVault();
  assert.deepEqual(guestSlicesOf(v, "ext"), [
    { unit: CONV, conversation: "tg-55", names: ["MINE", "TOKEN"] },
    { unit: CONV2, conversation: "tg-66", names: ["TOKEN"] },
  ]);
  // The GROUP's own slice is not one of them, and neither is another group's.
  assert.deepEqual(guestSlicesOf(v, "lender"), []);
  assert.deepEqual(guestSlicesOf(v, "main"), []);
});

test("guestSlicesOf: a group whose id is a PREFIX of another's claims nothing of it", () => {
  // `unitGroup` splits on the separator rather than matching a prefix, which is
  // what keeps a teardown of `ext` from wiping `extra`'s conversations.
  const v: Vault = { "ext/a": { A: e("1", "ext/a") }, "extra/b": { B: e("2", "extra/b") } };
  assert.deepEqual(guestSlicesOf(v, "ext").map((s) => s.unit), ["ext/a"]);
  assert.deepEqual(guestSlicesOf(v, "extra").map((s) => s.unit), ["extra/b"]);
});

test("shareableTargets: a GUEST CONVERSATION is never a share target, nor is the owner itself", () => {
  // A conversation's slice resolves to ITSELF only, so a row lending a secret to
  // one would be stored, listed as shared, and reach nobody — a grant that reads
  // as real and is not. In the data's own rule and not just the UI, because the
  // panel cannot offer it: only a hand-made call gets here.
  assert.deepEqual(shareableTargets(["comex", "door/tg-77", "", null, 7, "comex"], "mine"), ["comex"]);
  assert.deepEqual(shareableTargets(["mine", "door"], "mine"), ["door"]);
});
