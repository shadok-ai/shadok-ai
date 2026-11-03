import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleSecrets, longLivedTokenInfo, LONG_LIVED_TOKEN_TTL_MS, RESERVED_SECRET_NAMES, filterReserved, resolveSecretValues, secretNamesForProfile, migrateFlatVault, normalizeVault, type Vault, type SecretEntry } from "../src/secrets.js";

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
