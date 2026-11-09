import { test } from "node:test";
import assert from "node:assert/strict";
import {
  osUserFor,
  dropArgv,
  dropEnv,
  homeForUser,
  resolveSpawnIsolation,
  provisionPlan,
  provisionGroupUser,
  teardownGroupUser,
  reconcileGroupProvisioning,
  groupDeleteVerdict,
  createGroupFlow,
  deleteGroupFlow,
  runAsUser,
  tierStateDir,
  tierStateDirAction,
  sharedPotWiring,
  sharedPotPlan,
  SHARED_POT_GROUP,
  DEFAULT_SHARED_POT_PATH,
} from "../src/osusers.js";
import { spawnGroupFor, MAIN_GROUP_ID, type Group } from "../src/groups.js";

const main: Group = { id: MAIN_GROUP_ID, name: "Main", nature: "public", members: [], createdAt: 0 };
const comex: Group = { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 1 };
const adaPriv: Group = { id: "ada-priv", name: "Ada", nature: "private", members: [], owner: "ada", createdAt: 2 };

// ── homeForUser / dropEnv (CRITICAL #4: setpriv keeps the server's HOME) ──────

test("homeForUser: <homeBase>/<user> — the SAME derivation provisionPlan/migration use", () => {
  assert.equal(homeForUser("main", "/home"), "/home/main");
  assert.equal(homeForUser("sk-comex", "/home"), "/home/sk-comex");
  // Matches provisionPlan's home so the spawn's HOME is where the credential was
  // provisioned (a mismatch would leave auth broken while provisioning "succeeded").
  assert.equal(provisionPlan(comex, "/home")!.home, homeForUser("sk-comex", "/home"));
});

test("dropEnv: a drop user sets HOME/USER/LOGNAME to that user's own", () => {
  assert.deepEqual(dropEnv("sk-comex", "/home/sk-comex"), {
    HOME: "/home/sk-comex",
    USER: "sk-comex",
    LOGNAME: "sk-comex",
    // The inherited GH_CONFIG_DIR points at the server's /root/.claude/gh, which
    // a dropped user cannot traverse (0700) — EVERY gh call then dies "permission
    // denied" reading config, before auth. Override it to the drop user's OWN
    // writable config dir; the token is injected separately (GH_TOKEN, forcedEnv).
    GH_CONFIG_DIR: "/home/sk-comex/.config/gh",
  });
});

test("dropEnv: GH_CONFIG_DIR is only set when there is a HOME to put it under", () => {
  // A drop user with no HOME cannot get a reachable config dir; don't invent one.
  assert.equal("GH_CONFIG_DIR" in dropEnv("sk-x", null), false);
});

test("dropEnv: NO user → {} (mono-tenant / commons-pre-migration: HOME left as today)", () => {
  assert.deepEqual(dropEnv(null, "/home/x"), {});
  assert.deepEqual(dropEnv(undefined, undefined), {});
});

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

test("resolveSpawnIsolation: a NEW agent launched by a parent is born into the PARENT's group, not the viewer's", () => {
  // The viewer here resolves to the commons (null), as an agent-driven spawn does
  // when the admin cookie's own group is ambiguous/absent. The launcher runs in
  // comex, so the child joins comex and drops to its user — this is the fix for
  // "a spawned agent lands in the admin's Personal group instead of its launcher's".
  const r = resolveSpawnIsolation({
    mode: "multi-tenant",
    resumed: false,
    viewer: null,
    groups: [main, comex],
    storedGroupId: null,
    parentGroupId: "comex",
  });
  assert.deepEqual(r, { user: "sk-comex", groupPatch: { group: "comex" } });
});

test("resolveSpawnIsolation: a RESUME ignores the parent group — the stored group is SERVER_OWNED", () => {
  const r = resolveSpawnIsolation({
    mode: "multi-tenant",
    resumed: true,
    viewer: { name: "ada", role: "member" },
    groups: [main, comex],
    storedGroupId: null,
    parentGroupId: "comex",
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
  // useradd creates+chowns HOME; chmod 700 then poses the people-wall (mode).
  assert.deepEqual(calls, [
    ["useradd", ["--create-home", "--home-dir", "/home/sk-comex", "sk-comex"]],
    ["chmod", ["700", "/home/sk-comex"]],
  ]);
  assert.equal(seededHome, "/home/sk-comex");
});

test("provisionGroupUser: chmod 700 is issued on HOME in BOTH the new and reused branch (private wall)", async () => {
  for (const exists of [false, true]) {
    const calls: Array<[string, string[]]> = [];
    await provisionGroupUser(comex, {
      run: async (cmd, argv) => void calls.push([cmd, argv]),
      seed: async () => {},
      homeBase: "/home",
      userExists: async () => exists,
    });
    // Exactly one chmod 700 of the HOME, whichever branch ran.
    const chmods = calls.filter(([c]) => c === "chmod");
    assert.deepEqual(chmods, [["chmod", ["700", "/home/sk-comex"]]]);
  }
});

test("provisionGroupUser: THROWS when chmod 700 fails (an un-private HOME is a broken wall)", async () => {
  await assert.rejects(
    provisionGroupUser(comex, {
      run: async (cmd) => {
        if (cmd === "chmod") throw new Error("chmod: operation not permitted");
      },
      seed: async () => {},
      homeBase: "/home",
      userExists: async () => false,
    }),
    /chmod 700 .* failed/,
  );
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
  assert.deepEqual(calls, [["chmod", ["700", "/home/sk-comex"]]]); // useradd skipped, HOME still made private
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

// ── runAsUser / provisioning without any shared-credential wiring ─────────────
// Agents authenticate through an injected token env var, so provisioning issues
// no credential group, symlink or reachability step: only useradd + HOME chmod.

test("runAsUser: wraps a command in `runuser -u <user> --` so root never writes through an agent path", () => {
  assert.deepEqual(runAsUser("sk-comex", "ln", ["-sfn", "/a", "/b"]), [
    "runuser",
    ["-u", "sk-comex", "--", "ln", "-sfn", "/a", "/b"],
  ]);
});

test("provisionGroupUser: a reused user issues only the HOME chmod — no credential wiring of any kind", async () => {
  const calls: Array<[string, string[]]> = [];
  await provisionGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    seed: async () => {},
    homeBase: "/home",
    userExists: async () => true,
  });
  assert.deepEqual(calls, [["chmod", ["700", "/home/sk-comex"]]]);
});

// ── teardownGroupUser (impure, best-effort, never throws) ─────────────────────

test("teardownGroupUser: a public group tears down nothing (null user), ok:true", async () => {
  let ran = 0;
  let killed = 0;
  const r = await teardownGroupUser(main, {
    run: async () => void ran++,
    homeBase: "/home",
    killAgents: async () => void killed++,
  });
  assert.equal(ran, 0);
  assert.equal(killed, 0);
  assert.deepEqual(r, { ok: true });
});

test("teardownGroupUser: a restricted group kills its agents then userdel --remove, ok:true", async () => {
  const calls: Array<[string, string[]]> = [];
  let killedFirst = false;
  const r = await teardownGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    homeBase: "/home",
    killAgents: async () => void (killedFirst = calls.length === 0),
  });
  assert.equal(killedFirst, true); // agents killed BEFORE userdel
  assert.deepEqual(calls, [["userdel", ["--remove", "sk-comex"]]]);
  assert.deepEqual(r, { ok: true });
});

test("teardownGroupUser: NEVER throws when userdel fails, and SURFACES a warning (ok:false)", async () => {
  let r!: { ok: boolean; warning?: string };
  await assert.doesNotReject(async () => {
    r = await teardownGroupUser(comex, {
      run: async () => {
        throw new Error("userdel: user is logged in");
      },
      homeBase: "/home",
    });
  });
  assert.equal(r.ok, false);
  assert.match(r.warning ?? "", /userdel --remove sk-comex failed/);
});

test("teardownGroupUser: a failing killAgents is swallowed, userdel still runs, warning surfaced", async () => {
  const calls: Array<[string, string[]]> = [];
  const r = await teardownGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    homeBase: "/home",
    killAgents: async () => {
      throw new Error("kill blew up");
    },
  });
  assert.deepEqual(calls, [["userdel", ["--remove", "sk-comex"]]]);
  assert.equal(r.ok, false);
  assert.match(r.warning ?? "", /killing sk-comex's agents failed/);
});

// ── reconcileGroupProvisioning (Task 16 Important #1 — boot self-heal) ─────────

test("reconcileGroupProvisioning: re-provisions a group whose OS user is MISSING, skips an existing one", async () => {
  const groups: Group[] = [
    main, // public → never touched (no dedicated user)
    comex, // restricted, sk-comex → user EXISTS, skip
    adaPriv, // private, sk-ada-priv → user MISSING, re-provision
  ];
  const provisioned: string[] = [];
  const probed: string[] = [];
  const r = await reconcileGroupProvisioning(groups, {
    userExists: async (u) => {
      probed.push(u);
      return u === "sk-comex"; // only comex's user exists
    },
    provision: async (g) => void provisioned.push(g.id),
    log: () => {},
  });
  // Public group was never probed (no dedicated user to reconcile).
  assert.deepEqual(probed.sort(), ["sk-ada-priv", "sk-comex"]);
  // Only the group with the MISSING user was (re)provisioned.
  assert.deepEqual(provisioned, ["ada-priv"]);
  assert.deepEqual(r.provisioned, ["ada-priv"]);
  assert.deepEqual(r.present, ["comex"]);
  assert.deepEqual(r.failed, []);
});

test("reconcileGroupProvisioning: best-effort — a per-group provision failure is logged, the loop continues, NEVER throws", async () => {
  const other: Group = { id: "rh", name: "RH", nature: "restricted", members: ["leo"], createdAt: 3 };
  const provisioned: string[] = [];
  let r!: { provisioned: string[]; present: string[]; failed: string[] };
  await assert.doesNotReject(async () => {
    r = await reconcileGroupProvisioning([adaPriv, other], {
      userExists: async () => false, // both missing
      provision: async (g) => {
        if (g.id === "ada-priv") throw new Error("useradd blew up");
        provisioned.push(g.id);
      },
      log: () => {},
    });
  });
  // The failure on ada-priv did NOT stop rh from being provisioned.
  assert.deepEqual(provisioned, ["rh"]);
  assert.deepEqual(r.failed, ["ada-priv"]);
  assert.deepEqual(r.provisioned, ["rh"]);
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

// ── createGroupFlow / deleteGroupFlow (route orchestration, injected spies) ────
// These exercise the /groups route ordering and guards without booting express:
// every effect (provision, teardown, load/save) is injected, so a spy proves
// WHEN it ran (e.g. provision strictly before saveGroups).

const createDeps = (over: Partial<Parameters<typeof createGroupFlow>[1]> = {}) => {
  const saved: Group[][] = [];
  const provisioned: Group[] = [];
  const deps = {
    provision: async (g: Group) => void provisioned.push(g),
    loadGroups: () => [] as Group[],
    saveGroups: (gs: Group[]) => void saved.push(gs),
    newId: () => "new-id",
    now: () => 123,
    ...over,
  };
  return { deps, saved, provisioned };
};

const okCreateInput = (over: Partial<Parameters<typeof createGroupFlow>[0]> = {}) => ({
  fromBrowser: true,
  instanceOk: true,
  account: { name: "ada" } as { name: string } | null,
  name: "COMEX",
  nature: "restricted" as const,
  mode: "multi-tenant" as const,
  ...over,
});

test("createGroupFlow: a non-browser (agent) request is 403 — the privileged route is web-UI only", async () => {
  const { deps, saved, provisioned } = createDeps();
  const r = await createGroupFlow(okCreateInput({ fromBrowser: false }), deps);
  assert.equal(r.status, 403);
  assert.equal(saved.length, 0); // nothing persisted
  assert.equal(provisioned.length, 0); // and nothing provisioned
});

test("createGroupFlow: mono-tenant REFUSES a restricted/private create via capabilityRefusal (never a fake wall)", async () => {
  const { deps, saved, provisioned } = createDeps();
  const r = await createGroupFlow(okCreateInput({ mode: "mono-tenant" }), deps);
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /isolation requires the privileged deployment/);
  assert.equal(saved.length, 0);
  assert.equal(provisioned.length, 0);
});

test("createGroupFlow: a provision THROW means NO saveGroups and a 500 (provision runs BEFORE persist)", async () => {
  let provisionedBeforeSave = true;
  const { deps, saved } = createDeps({
    provision: async () => {
      // if saveGroups had run, the order invariant is already broken
      provisionedBeforeSave = saved.length === 0;
      throw new Error("useradd: Permission denied");
    },
  });
  const r = await createGroupFlow(okCreateInput(), deps);
  assert.equal(r.status, 500);
  assert.equal(saved.length, 0); // the group is NEVER written on a provision failure
  assert.equal(provisionedBeforeSave, true);
});

test("createGroupFlow: a duplicate name is refused (409), case-insensitive, before any provision", async () => {
  const existing: Group = { id: "old", name: "comex", nature: "restricted", members: ["zoe"], createdAt: 0 };
  const { deps, saved, provisioned } = createDeps({ loadGroups: () => [existing] });
  const r = await createGroupFlow(okCreateInput({ name: "COMEX" }), deps); // differs only in case
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /already exists/);
  assert.equal(saved.length, 0);
  assert.equal(provisioned.length, 0);
});

test("createGroupFlow: a name equal to a PRIVATE group's (auto-named) is allowed", async () => {
  const perso: Group = { id: "p", name: "COMEX", nature: "private", members: ["ada"], owner: "ada", createdAt: 0 };
  const { deps, saved } = createDeps({ loadGroups: () => [perso] });
  const r = await createGroupFlow(okCreateInput({ name: "COMEX" }), deps);
  assert.equal(r.status, 200); // private groups are excluded from the name space
  assert.equal(saved.length, 1);
});

test("createGroupFlow: a PUBLIC group provisions nothing yet is still persisted", async () => {
  const { deps, saved, provisioned } = createDeps();
  const r = await createGroupFlow(okCreateInput({ nature: "public" }), deps);
  assert.equal(r.status, 200);
  assert.equal(provisioned.length, 0);
  assert.equal(saved.length, 1);
});

test("createGroupFlow: the happy path provisions THEN persists", async () => {
  const order: string[] = [];
  const { deps } = createDeps({
    provision: async () => void order.push("provision"),
    saveGroups: () => void order.push("save"),
  });
  const r = await createGroupFlow(okCreateInput(), deps);
  assert.equal(r.status, 200);
  assert.deepEqual(order, ["provision", "save"]);
});

const deleteDeps = (over: Partial<Parameters<typeof deleteGroupFlow>[1]> = {}) => {
  const saved: Group[][] = [];
  const tore: Group[] = [];
  const deps = {
    loadGroups: () => [comex] as Group[],
    saveGroups: (gs: Group[]) => void saved.push(gs),
    loadChannels: () => [] as { group?: string | null }[],
    teardown: async (g: Group) => {
      tore.push(g);
      return { ok: true as boolean, warning: undefined as string | undefined };
    },
    ...over,
  };
  return { deps, saved, tore };
};

const okDeleteInput = (over: Partial<Parameters<typeof deleteGroupFlow>[0]> = {}) => ({
  fromBrowser: true,
  instanceOk: true,
  account: { name: "ada" } as { name: string } | null,
  id: "comex",
  mode: "multi-tenant" as const,
  ...over,
});

test("deleteGroupFlow: a non-browser (agent) request is 403 (userdel must not be curl-reachable)", async () => {
  const { deps, saved, tore } = deleteDeps();
  const r = await deleteGroupFlow(okDeleteInput({ fromBrowser: false }), deps);
  assert.equal(r.status, 403);
  assert.equal(saved.length, 0);
  assert.equal(tore.length, 0);
});

test("deleteGroupFlow: the MAIN group delete is refused (409), before any teardown", async () => {
  const { deps, saved, tore } = deleteDeps({ loadGroups: () => [main] });
  const r = await deleteGroupFlow(okDeleteInput({ id: MAIN_GROUP_ID }), deps);
  assert.equal(r.status, 409);
  assert.equal(tore.length, 0);
  assert.equal(saved.length, 0);
});

test("deleteGroupFlow: teardown runs BEFORE the row is removed", async () => {
  const order: string[] = [];
  const { deps } = deleteDeps({
    teardown: async () => {
      order.push("teardown");
      return { ok: true };
    },
    saveGroups: () => void order.push("save"),
  });
  const r = await deleteGroupFlow(okDeleteInput(), deps);
  assert.equal(r.status, 200);
  assert.deepEqual(order, ["teardown", "save"]);
});

test("deleteGroupFlow: a teardown warning is surfaced in the response, yet the row is still removed", async () => {
  const { deps, saved } = deleteDeps({
    teardown: async () => ({ ok: false, warning: "userdel --remove sk-comex failed: user is logged in" }),
  });
  const r = await deleteGroupFlow(okDeleteInput(), deps);
  assert.equal(r.status, 200);
  assert.match(String(r.body.warning), /userdel --remove sk-comex failed/);
  assert.equal(saved.length, 1); // the group row is removed even when the OS user may be orphaned
});

test("Review Focus #1: mono-tenant restricted create is 400 'isolation requires the privileged deployment', no OS user, nothing saved", async () => {
  const { isolationRefusal } = await import("../src/capability.js");
  const { deps, saved, provisioned } = createDeps({ isolationRefusal });
  for (const nature of ["restricted"] as const) {
    const r = await createGroupFlow(okCreateInput({ mode: "mono-tenant", nature }), deps);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "isolation requires the privileged deployment");
  }
  assert.equal(provisioned.length, 0);
  assert.equal(saved.length, 0);
});

test("Review Focus #1: mono-tenant PUBLIC create is allowed — a label, provisions nothing", async () => {
  const { isolationRefusal } = await import("../src/capability.js");
  const { deps, saved, provisioned } = createDeps({ isolationRefusal });
  const r = await createGroupFlow(okCreateInput({ mode: "mono-tenant", nature: "public" }), deps);
  assert.equal(r.status, 200);
  assert.equal(provisioned.length, 0);
  assert.equal(saved.length, 1);
});

// ── Shared pot (Task 12) ──────────────────────────────────────────────────────

test("sharedPotWiring: <home>/shared -> the one shared base (same for any HOME)", () => {
  assert.deepEqual(sharedPotWiring("/home/sk-comex", "/var/lib/shadok-ai/shared"), {
    link: "/home/sk-comex/shared",
    target: "/var/lib/shadok-ai/shared",
  });
  assert.equal(sharedPotWiring("/home/sk-ada", "/srv/pot").target, "/srv/pot");
});

test("DEFAULT_SHARED_POT_PATH: neutral, never under a HOME or /root", () => {
  assert.equal(DEFAULT_SHARED_POT_PATH, "/var/lib/shadok-ai/shared");
});

test("sharedPotPlan: root sets up a setgid group-writable base; the symlink runs as the user", () => {
  const p = sharedPotPlan("sk-comex", "/home/sk-comex", "/var/lib/shadok-ai/shared");
  assert.deepEqual(p.rootCmds, [
    ["groupadd", ["-f", SHARED_POT_GROUP]],
    ["install", ["-d", "-o", "root", "-g", SHARED_POT_GROUP, "-m", "2770", "/var/lib/shadok-ai/shared"]],
    ["chmod", ["2770", "/var/lib/shadok-ai/shared"]],
    ["usermod", ["-aG", SHARED_POT_GROUP, "sk-comex"]],
  ]);
  assert.deepEqual(p.userCmds, [["ln", ["-sfn", "/var/lib/shadok-ai/shared", "/home/sk-comex/shared"]]]);
});

test("provisionGroupUser: WITH sharedPotPath, root setup then runuser symlink, after HOME chmod", async () => {
  const calls: Array<[string, string[]]> = [];
  await provisionGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    seed: async () => {},
    homeBase: "/home",
    userExists: async () => true,
    sharedPotPath: "/var/lib/shadok-ai/shared",
  });
  const p = sharedPotPlan("sk-comex", "/home/sk-comex", "/var/lib/shadok-ai/shared");
  assert.deepEqual(calls, [
    ["chmod", ["700", "/home/sk-comex"]],
    ...p.rootCmds,
    ...p.userCmds.map(([c, a]) => runAsUser("sk-comex", c, a)),
  ]);
});

test("provisionGroupUser: WITHOUT sharedPotPath, no pot wiring (mono-tenant)", async () => {
  const calls: Array<[string, string[]]> = [];
  await provisionGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    seed: async () => {},
    homeBase: "/home",
    userExists: async () => true,
  });
  assert.deepEqual(calls, [["chmod", ["700", "/home/sk-comex"]]]);
});

test("provisionGroupUser: THROWS when pot wiring fails", async () => {
  await assert.rejects(
    provisionGroupUser(comex, {
      run: async (cmd) => {
        if (cmd === "groupadd") throw new Error("boom");
      },
      seed: async () => {},
      homeBase: "/home",
      userExists: async () => true,
      sharedPotPath: "/x",
    }),
    /shared pot wiring.*boom/,
  );
});

// ── deleteGroupFlow per-nature authorization / createGroupFlow Personal seal ──
const natured = (nature: "public" | "restricted" | "private", members: string[] = []): Group =>
  ({ id: "g1", name: "G", nature, members, createdAt: 1, osUser: null, ...(nature === "private" ? { owner: "ada" } : {}) }) as Group;
const delAs = async (g: Group, name: string, role: "admin" | "member") => {
  const { deps, saved, tore } = deleteDeps({ loadGroups: () => [g] });
  const r = await deleteGroupFlow(okDeleteInput({ id: "g1", account: { name, role } } as never), deps);
  return { r, saved, tore };
};

test("deleteGroupFlow: a private (Personal) group is refused 403 even for its owner and an admin", async () => {
  for (const [n, role] of [["ada", "member"], ["root", "admin"]] as const) {
    const { r, saved, tore } = await delAs(natured("private"), n, role);
    assert.equal(r.status, 403);
    assert.equal((r.body as { error: string }).error, "a personal group cannot be deleted");
    assert.equal(saved.length, 0);
    assert.equal(tore.length, 0);
  }
});

test("deleteGroupFlow: a restricted group is refused for a non-member and a non-member admin", async () => {
  for (const [n, role] of [["eve", "member"], ["root", "admin"]] as const) {
    const { r, saved, tore } = await delAs(natured("restricted", ["bob"]), n, role);
    assert.equal(r.status, 403);
    assert.equal((r.body as { error: string }).error, "only a member can delete this group");
    assert.equal(saved.length + tore.length, 0);
  }
});

test("deleteGroupFlow: a restricted group is deletable by a member (an admin member too)", async () => {
  assert.equal((await delAs(natured("restricted", ["bob"]), "bob", "member")).r.status, 200);
  assert.equal((await delAs(natured("restricted", ["bob", "root"]), "root", "admin")).r.status, 200);
});

test("deleteGroupFlow: a public group stays deletable by a signed-in non-admin", async () => {
  assert.equal((await delAs(natured("public"), "eve", "member")).r.status, 200);
});

test("createGroupFlow: nature private is refused 400 (Personal is auto-provisioned), nothing provisioned", async () => {
  const { deps, saved, provisioned } = createDeps();
  const r = await createGroupFlow(okCreateInput({ nature: "private" }), deps);
  assert.equal(r.status, 400);
  assert.equal((r.body as { error: string }).error, "a personal group is created automatically, not here");
  assert.equal(saved.length + provisioned.length, 0);
});

test("tierStateDir: the agent's state parent sits inside its own tier HOME", () => {
  assert.equal(tierStateDir("/home/main"), "/home/main/.shadok-ai");
  assert.equal(tierStateDir("/home/sk-comex"), "/home/sk-comex/.shadok-ai");
});

test("tierStateDirAction: absent → create it AS the user, so it is born owned by them", () => {
  assert.equal(tierStateDirAction({ exists: false, writableByUser: false }), "create");
});

test("tierStateDirAction: already the user's → null, the pre-spawn path stays free", () => {
  assert.equal(tierStateDirAction({ exists: true, writableByUser: true }), null);
});

test("tierStateDirAction: present but not writable → chown, the repair an existing instance needs", () => {
  // The case measured on correctsms: the server (root) created
  // /home/main/.shadok-ai with `recursive: true` on its way to the self-clone,
  // and `pilotctl` then died on EACCES inside a home `main` otherwise owns. A
  // create is a silent no-op here, which is why this is not a two-way answer.
  assert.equal(tierStateDirAction({ exists: true, writableByUser: false }), "chown");
});
