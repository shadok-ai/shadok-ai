import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSecretValues, migrateFlatVault, normalizeVault, type Vault, type SecretEntry } from "../src/secrets.js";

const e = (value: string, ownerGroup: string, sharedWith: string[] = []): SecretEntry => ({
  value, ownerGroup, sharedWith, profiles: [], createdBy: "u", createdAt: 1, updatedAt: 1,
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
