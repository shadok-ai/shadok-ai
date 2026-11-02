import { test } from "node:test";
import assert from "node:assert/strict";
import { osUserFor, dropArgv, resolveSpawnIsolation } from "../src/osusers.js";
import { spawnGroupFor, MAIN_GROUP_ID, type Group } from "../src/groups.js";

const main: Group = { id: MAIN_GROUP_ID, name: "Main", nature: "public", members: [], createdAt: 0 };
const comex: Group = { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 1 };
const adaPriv: Group = { id: "ada-priv", name: "Ada", nature: "private", members: [], owner: "ada", createdAt: 2 };

// ── osUserFor ────────────────────────────────────────────────────────────────

test("osUserFor: a public group has NO dedicated user (commons = the server's own)", () => {
  assert.equal(osUserFor(main), null);
});

test("osUserFor: a restricted/private group gets an sk-<id> OS user", () => {
  assert.equal(osUserFor(comex), "sk-comex");
  assert.equal(osUserFor(adaPriv), "sk-ada-priv");
});

test("osUserFor: the id is sanitized to a valid Linux username", () => {
  // spaces, punctuation and case are not valid in a username; strip/lower them.
  assert.equal(osUserFor({ ...comex, id: "Ada Team!" }), "sk-adateam");
  // a very long id is capped (so "sk-" + 28 stays well under the 32-char limit).
  const long = "a".repeat(80);
  const u = osUserFor({ ...comex, id: long })!;
  assert.equal(u.startsWith("sk-"), true);
  assert.equal(u.length <= "sk-".length + 28, true);
});

// ── dropArgv ─────────────────────────────────────────────────────────────────

test("dropArgv: builds the exact setpriv wrapper, binary and args after --", () => {
  assert.deepEqual(dropArgv("sk-comex", "claude", ["--resume", "abc"]), {
    cmd: "setpriv",
    argv: ["--reuid", "sk-comex", "--regid", "sk-comex", "--init-groups", "--", "claude", "--resume", "abc"],
  });
});

test("dropArgv: no args still yields a well-formed wrapper", () => {
  assert.deepEqual(dropArgv("sk-x", "/usr/bin/claude", []), {
    cmd: "setpriv",
    argv: ["--reuid", "sk-x", "--regid", "sk-x", "--init-groups", "--", "/usr/bin/claude"],
  });
});

// ── spawnGroupFor (the caller's own group, derived from identity only) ────────

test("spawnGroupFor: a member of exactly one non-public group spawns into it", () => {
  assert.equal(spawnGroupFor({ name: "ada", role: "member" }, [main, comex])?.id, "comex");
});

test("spawnGroupFor: a private group's owner counts as its member", () => {
  assert.equal(spawnGroupFor({ name: "ada", role: "member" }, [main, adaPriv])?.id, "ada-priv");
});

test("spawnGroupFor: a caller in no non-public group lands in the commons", () => {
  assert.equal(spawnGroupFor({ name: "zoe", role: "member" }, [main, comex])?.id, MAIN_GROUP_ID);
});

test("spawnGroupFor: ambiguous membership falls back to the commons (safe, not someone else's)", () => {
  const second: Group = { id: "sales", name: "Sales", nature: "restricted", members: ["ada"], createdAt: 3 };
  assert.equal(spawnGroupFor({ name: "ada", role: "member" }, [main, comex, second])?.id, MAIN_GROUP_ID);
});

test("spawnGroupFor: a null viewer gets the commons, never a private group", () => {
  assert.equal(spawnGroupFor(null, [main, adaPriv])?.id, MAIN_GROUP_ID);
});

// ── resolveSpawnIsolation (the whole start-path policy, pure) ─────────────────

test("resolveSpawnIsolation: mono-tenant is byte-for-byte today — no user, no group written", () => {
  const r = resolveSpawnIsolation({
    mode: "mono-tenant",
    resumed: false,
    viewer: { name: "ada", role: "member" },
    groups: [main, comex],
    storedGroupId: null,
  });
  assert.deepEqual(r, { user: null, groupPatch: {} });
});

test("resolveSpawnIsolation: a NEW agent is born into the caller's own group, with that group's user", () => {
  const r = resolveSpawnIsolation({
    mode: "multi-tenant",
    resumed: false,
    viewer: { name: "ada", role: "member" },
    groups: [main, comex],
    storedGroupId: null,
  });
  assert.deepEqual(r, { user: "sk-comex", groupPatch: { group: "comex" } });
});

test("resolveSpawnIsolation: the group comes from IDENTITY only — a client claim cannot reach it", () => {
  // The function has no slot for a client-supplied group: whatever a start
  // payload claims, the result is the caller's own group. Zoe is in no group,
  // so she is born in the commons no matter what any payload said.
  const r = resolveSpawnIsolation({
    mode: "multi-tenant",
    resumed: false,
    viewer: { name: "zoe", role: "member" },
    groups: [main, comex],
    storedGroupId: null,
  });
  assert.deepEqual(r, { user: null, groupPatch: { group: MAIN_GROUP_ID } });
});

test("resolveSpawnIsolation: a commons (public) agent drops to no dedicated user", () => {
  const r = resolveSpawnIsolation({
    mode: "multi-tenant",
    resumed: false,
    viewer: null,
    groups: [main, comex],
    storedGroupId: null,
  });
  assert.deepEqual(r, { user: null, groupPatch: { group: MAIN_GROUP_ID } });
});

test("resolveSpawnIsolation: a RESUME keeps the channel's stored group and runs as that group's user", () => {
  // Resume must never reassign group (it is SERVER_OWNED and already set), but a
  // private agent must still come back under its own user — not root.
  const r = resolveSpawnIsolation({
    mode: "multi-tenant",
    resumed: true,
    viewer: { name: "ada", role: "member" },
    groups: [main, comex],
    storedGroupId: "comex",
  });
  assert.deepEqual(r, { user: "sk-comex", groupPatch: {} });
});

test("resolveSpawnIsolation: a resume of a commons (group-less) agent stays on the commons user", () => {
  const r = resolveSpawnIsolation({
    mode: "multi-tenant",
    resumed: true,
    viewer: { name: "ada", role: "member" },
    groups: [main, comex],
    storedGroupId: null,
  });
  assert.deepEqual(r, { user: null, groupPatch: {} });
});
