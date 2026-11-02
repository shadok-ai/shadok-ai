import { test } from "node:test";
import assert from "node:assert/strict";
import {
  osUserFor,
  dropArgv,
  resolveSpawnIsolation,
  provisionPlan,
  provisionGroupUser,
  teardownGroupUser,
  groupDeleteVerdict,
} from "../src/osusers.js";
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

// ── provisionPlan (pure) ──────────────────────────────────────────────────────

test("provisionPlan: a public group provisions NOTHING (commons = the server's own user)", () => {
  assert.equal(provisionPlan(main, "/home"), null);
});

test("provisionPlan: a restricted group yields the exact useradd argv and HOME path", () => {
  assert.deepEqual(provisionPlan(comex, "/home"), {
    user: "sk-comex",
    home: "/home/sk-comex",
    useradd: ["useradd", "--create-home", "--home-dir", "/home/sk-comex", "sk-comex"],
    seedHome: true,
  });
});

test("provisionPlan: a private group gets its own user, HOME under the given base", () => {
  assert.deepEqual(provisionPlan(adaPriv, "/srv/homes"), {
    user: "sk-ada-priv",
    home: "/srv/homes/sk-ada-priv",
    useradd: ["useradd", "--create-home", "--home-dir", "/srv/homes/sk-ada-priv", "sk-ada-priv"],
    seedHome: true,
  });
});

// ── provisionGroupUser (impure, injected deps) ────────────────────────────────

test("provisionGroupUser: a public group provisions nothing (null; run/seed untouched)", async () => {
  let ran = 0;
  let seeded = 0;
  const r = await provisionGroupUser(main, {
    run: async () => void ran++,
    seed: async () => void seeded++,
    homeBase: "/home",
  });
  assert.equal(r, null);
  assert.equal(ran, 0);
  assert.equal(seeded, 0);
});

test("provisionGroupUser: a NEW user runs useradd then seeds HOME", async () => {
  const calls: Array<[string, string[]]> = [];
  let seededHome: string | null = null;
  const r = await provisionGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    seed: async (home) => void (seededHome = home),
    homeBase: "/home",
    userExists: async () => false,
  });
  assert.deepEqual(r, { osUser: "sk-comex", home: "/home/sk-comex" });
  assert.deepEqual(calls, [["useradd", ["--create-home", "--home-dir", "/home/sk-comex", "sk-comex"]]]);
  assert.equal(seededHome, "/home/sk-comex");
});

test("provisionGroupUser: an EXISTING user is reused — useradd is skipped, HOME still seeded (idempotent)", async () => {
  const calls: Array<[string, string[]]> = [];
  let seeded = 0;
  const r = await provisionGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    seed: async () => void seeded++,
    homeBase: "/home",
    userExists: async () => true,
  });
  assert.deepEqual(r, { osUser: "sk-comex", home: "/home/sk-comex" });
  assert.deepEqual(calls, []); // useradd never ran
  assert.equal(seeded, 1); // seeding is idempotent and always runs
});

test("provisionGroupUser: THROWS when useradd fails (T3 carry — a false-positive sudo probe must surface)", async () => {
  await assert.rejects(
    provisionGroupUser(comex, {
      run: async () => {
        throw new Error("useradd: Permission denied");
      },
      seed: async () => {},
      homeBase: "/home",
      userExists: async () => false,
    }),
    /useradd failed/,
  );
});

test("provisionGroupUser: THROWS when seeding HOME fails (never silently continue)", async () => {
  await assert.rejects(
    provisionGroupUser(comex, {
      run: async () => {},
      seed: async () => {
        throw new Error("disk full");
      },
      homeBase: "/home",
      userExists: async () => false,
    }),
    /seeding/,
  );
});

// ── teardownGroupUser (impure, best-effort, never throws) ─────────────────────

test("teardownGroupUser: a public group tears down nothing (null user)", async () => {
  let ran = 0;
  let killed = 0;
  await teardownGroupUser(main, {
    run: async () => void ran++,
    homeBase: "/home",
    killAgents: async () => void killed++,
  });
  assert.equal(ran, 0);
  assert.equal(killed, 0);
});

test("teardownGroupUser: a restricted group kills its agents then userdel --remove", async () => {
  const calls: Array<[string, string[]]> = [];
  let killedFirst = false;
  await teardownGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    homeBase: "/home",
    killAgents: async () => void (killedFirst = calls.length === 0),
  });
  assert.equal(killedFirst, true); // agents killed BEFORE userdel
  assert.deepEqual(calls, [["userdel", ["--remove", "sk-comex"]]]);
});

test("teardownGroupUser: NEVER throws when userdel fails (best-effort, swallow-and-log)", async () => {
  await assert.doesNotReject(
    teardownGroupUser(comex, {
      run: async () => {
        throw new Error("userdel: user is logged in");
      },
      homeBase: "/home",
    }),
  );
});

test("teardownGroupUser: a failing killAgents is swallowed and userdel still runs", async () => {
  const calls: Array<[string, string[]]> = [];
  await teardownGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    homeBase: "/home",
    killAgents: async () => {
      throw new Error("kill blew up");
    },
  });
  assert.deepEqual(calls, [["userdel", ["--remove", "sk-comex"]]]);
});

// ── groupDeleteVerdict (pure — the T4-carry anti-dangling rule) ───────────────

test("groupDeleteVerdict: a group with no channels is deletable", () => {
  assert.deepEqual(groupDeleteVerdict("comex", [{ group: "main" }, {}]), { ok: true });
});

test("groupDeleteVerdict: REFUSE while channels still reference the group (fail-closed, no dangling id)", () => {
  const v = groupDeleteVerdict("comex", [{ group: "comex" }, { group: "main" }, { group: "comex" }]);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /2 channel/);
});
