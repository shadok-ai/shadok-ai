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
  groupDeleteVerdict,
  createGroupFlow,
  deleteGroupFlow,
  credentialWiring,
  credentialWiringPlan,
  runAsUser,
  reachableFromInspection,
  classifyCredentialLink,
  checkCredentialDivergence,
  SHARED_CRED_GROUP,
  DEFAULT_SHARED_CREDENTIAL_PATH,
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
  });
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

// ── credentialWiring / credentialWiringPlan (Task 7 — shared Claude credential) ─
// The ONE Claude OAuth credential is shared across groups: each HOME's
// ~/.claude/.credentials.json is a SYMLINK to a NEUTRAL, group-traversable
// canonical path (NOT under /root — a group user cannot traverse /root; the old
// path was a silent no-credential break), and a shared unix group makes the
// single file readable+writable by every group's sk-<id> user so an in-place
// `claude` refresh stays readable by all. The neutral file itself is SEEDED by
// the migration task (T15); Task 7 only USES the path and wires traversable perms.

const SHARED_CRED = DEFAULT_SHARED_CREDENTIAL_PATH; // /var/lib/shadok-ai/credentials/.credentials.json
const SHARED_DIR = "/var/lib/shadok-ai/credentials";

test("DEFAULT_SHARED_CREDENTIAL_PATH: a neutral, group-traversable path, never under /root", () => {
  assert.equal(SHARED_CRED, "/var/lib/shadok-ai/credentials/.credentials.json");
  assert.ok(!SHARED_CRED.startsWith("/root/"), "must not live under /root (mode 700, not group-traversable)");
});

test("credentialWiring: the HOME link and the shared target, verbatim", () => {
  assert.deepEqual(credentialWiring("/home/sk-comex", SHARED_CRED), {
    link: "/home/sk-comex/.claude/.credentials.json",
    target: SHARED_CRED,
  });
});

const LINK = "/home/sk-comex/.claude/.credentials.json";
const CLAUDE_DIR = "/home/sk-comex/.claude";

test("credentialWiringPlan: ROOT does ONLY the shared-side — the group, the group-traversable shared DIR, membership, and the shared file's group+mode (never anything inside the HOME)", () => {
  const plan = credentialWiringPlan("sk-comex", "/home/sk-comex", SHARED_CRED);
  assert.deepEqual(plan.rootCmds, [
    ["groupadd", ["-f", SHARED_CRED_GROUP]],
    // The directory CHAIN to the shared file must be traversable by the group,
    // owned root:shadok-cred mode 0750 (group execute = traverse).
    ["install", ["-d", "-o", "root", "-g", SHARED_CRED_GROUP, "-m", "0750", SHARED_DIR]],
    ["usermod", ["-aG", SHARED_CRED_GROUP, "sk-comex"]],
    ["chgrp", [SHARED_CRED_GROUP, SHARED_CRED]],
    ["chmod", ["660", SHARED_CRED]],
  ]);
  // No root command may touch anything inside the agent-owned HOME (TOCTOU).
  for (const [, argv] of plan.rootCmds) {
    for (const a of argv) assert.ok(!a.startsWith("/home/"), `root command must not touch the HOME: ${a}`);
  }
});

test("credentialWiringPlan: the HOME-side (create private ~/.claude + pose the symlink) is run AS THE GROUP USER, not root — closes the TOCTOU", () => {
  const plan = credentialWiringPlan("sk-comex", "/home/sk-comex", SHARED_CRED);
  // The raw HOME-side commands: create ~/.claude mode 700 (user owns it, so no
  // -o/-g) and the symlink. No root `chown -h` — the user owns what it created.
  assert.deepEqual(plan.userCmds, [
    ["install", ["-d", "-m", "700", CLAUDE_DIR]],
    ["ln", ["-sfn", SHARED_CRED, LINK]],
  ]);
  // Each one, as actually dispatched, runs through `runuser -u <user> --`.
  assert.deepEqual(
    plan.userCmds.map(([c, a]) => runAsUser("sk-comex", c, a)),
    [
      ["runuser", ["-u", "sk-comex", "--", "install", "-d", "-m", "700", CLAUDE_DIR]],
      ["runuser", ["-u", "sk-comex", "--", "ln", "-sfn", SHARED_CRED, LINK]],
    ],
  );
});

test("credentialWiringPlan: whitelist — group/mode/owner changes touch ONLY the shared file, the shared dir, ~/.claude and the link", () => {
  const plan = credentialWiringPlan("sk-comex", "/home/sk-comex", SHARED_CRED);
  const allowed = new Set([SHARED_CRED, SHARED_DIR, CLAUDE_DIR, LINK]);
  // Every command that changes ownership or mode (install -o/-g/-m, chown, chgrp,
  // chmod) must target a whitelisted path — nothing ELSE on the filesystem gets
  // its group or mode touched by the wiring.
  for (const [cmd, argv] of [...plan.rootCmds, ...plan.userCmds]) {
    if (cmd === "install") {
      assert.ok(allowed.has(argv[argv.length - 1]), `install target ${argv[argv.length - 1]} not whitelisted`);
    } else if (cmd === "chown" || cmd === "chgrp" || cmd === "chmod") {
      assert.ok(allowed.has(argv[argv.length - 1]), `${cmd} target ${argv[argv.length - 1]} not whitelisted`);
    }
  }
});

// ── provisionGroupUser: credential wiring (Task 7) ────────────────────────────

/** The guard probes provisionGroupUser needs in the credential branch: a safe
 *  (real-directory) ~/.claude, an existing shared file, and a reachable target. */
const okCredProbes = {
  claudeDirStat: (_d: string) => ({ exists: true, isSymlink: false, isDir: true }),
  sharedCredentialExists: (_p: string) => true,
  reachable: async (_u: string, _l: string) => ({ ok: true }),
};

/** The flat command sequence the credential wiring issues through `run`: the
 *  root-side commands verbatim, then each HOME-side command wrapped in
 *  `runuser -u <user> --` (the TOCTOU-safe split). */
const expectedWiring = (user: string, home: string, shared: string): Array<[string, string[]]> => {
  const p = credentialWiringPlan(user, home, shared);
  return [...p.rootCmds, ...p.userCmds.map(([c, a]) => runAsUser(user, c, a))];
};

test("provisionGroupUser: WITH sharedCredentialPath, issues the symlink + shared-group wiring after the HOME chmod", async () => {
  const calls: Array<[string, string[]]> = [];
  const r = await provisionGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    seed: async () => {},
    homeBase: "/home",
    userExists: async () => false,
    sharedCredentialPath: SHARED_CRED,
    ...okCredProbes,
  });
  assert.deepEqual(r, { osUser: "sk-comex", home: "/home/sk-comex" });
  assert.deepEqual(calls, [
    ["useradd", ["--create-home", "--home-dir", "/home/sk-comex", "sk-comex"]],
    ["chmod", ["700", "/home/sk-comex"]],
    ...expectedWiring("sk-comex", "/home/sk-comex", SHARED_CRED),
  ]);
  // Every command that touches a path INSIDE the agent-owned HOME's ~/.claude
  // must run via runuser (as the user), never as root — that is the TOCTOU fix.
  // (The `chmod 700` on the HOME dir itself is root's Task-6 wall and is fine:
  //  the dir is root-controlled at useradd time, before any agent can plant.)
  const insideClaudeRanAsUser = calls
    .filter(([c, a]) => a.some((x) => x.includes("/.claude")))
    .every(([c]) => c === "runuser");
  assert.ok(insideClaudeRanAsUser, "every ~/.claude command must run via runuser, never as root");
});

test("provisionGroupUser: re-provision is idempotent — running the wiring twice is safe (same idempotent commands, no throw)", async () => {
  const run = async () => {
    const calls: Array<[string, string[]]> = [];
    await provisionGroupUser(comex, {
      run: async (cmd, argv) => void calls.push([cmd, argv]),
      seed: async () => {},
      homeBase: "/home",
      userExists: async () => true, // reused user: useradd skipped
      sharedCredentialPath: SHARED_CRED,
      ...okCredProbes,
    });
    return calls;
  };
  const first = await run();
  const second = await run();
  // Identical on re-provision, and every wiring command is idempotent by design
  // (groupadd -f, install -d, ln -sfn, chgrp/chmod).
  assert.deepEqual(first, second);
  assert.deepEqual(second, [
    ["chmod", ["700", "/home/sk-comex"]],
    ...expectedWiring("sk-comex", "/home/sk-comex", SHARED_CRED),
  ]);
});

test("provisionGroupUser: WITHOUT sharedCredentialPath, no credential wiring runs (mono-tenant / unchanged)", async () => {
  const calls: Array<[string, string[]]> = [];
  await provisionGroupUser(comex, {
    run: async (cmd, argv) => void calls.push([cmd, argv]),
    seed: async () => {},
    homeBase: "/home",
    userExists: async () => true,
  });
  // reused user: only the HOME chmod, no ln/groupadd/usermod/chgrp.
  assert.deepEqual(calls, [["chmod", ["700", "/home/sk-comex"]]]);
});

test("provisionGroupUser: THROWS when credential wiring fails (an un-credentialed agent is a broken wall)", async () => {
  await assert.rejects(
    provisionGroupUser(comex, {
      // `ln` now runs through `runuser -u <user> -- ln ...`, so match on the
      // wrapped argv, not the bare command.
      run: async (cmd, argv) => {
        if (cmd === "ln" || argv.includes("ln")) throw new Error("ln: permission denied");
      },
      seed: async () => {},
      homeBase: "/home",
      userExists: async () => false,
      sharedCredentialPath: SHARED_CRED,
      ...okCredProbes,
    }),
    /credential wiring .* failed/,
  );
});

test("provisionGroupUser: REFUSES to wire when ~/.claude is a symlink (root must not chown/chmod through an agent-planted link)", async () => {
  const calls: Array<[string, string[]]> = [];
  await assert.rejects(
    provisionGroupUser(comex, {
      run: async (cmd, argv) => void calls.push([cmd, argv]),
      seed: async () => {},
      homeBase: "/home",
      userExists: async () => false,
      sharedCredentialPath: SHARED_CRED,
      ...okCredProbes,
      claudeDirStat: (_d) => ({ exists: true, isSymlink: true, isDir: false }),
    }),
    /symlink|not a directory/i,
  );
  // It refused BEFORE issuing any credential wiring (no chgrp root-side, no
  // runuser HOME-side, no ln anywhere).
  assert.ok(
    !calls.some(([c, a]) => c === "chgrp" || c === "runuser" || c === "ln" || a.includes("ln")),
    "wiring must not run once refused",
  );
});

test("provisionGroupUser: REFUSES with a clear cause when the shared credential file is absent (instance not signed in / T15 not run)", async () => {
  await assert.rejects(
    provisionGroupUser(comex, {
      run: async () => {},
      seed: async () => {},
      homeBase: "/home",
      userExists: async () => false,
      sharedCredentialPath: SHARED_CRED,
      ...okCredProbes,
      sharedCredentialExists: (_p) => false,
    }),
    /not found.*signed in to Claude/i,
  );
});

test("provisionGroupUser: THROWS when the wired credential is NOT reachable by the group user (never spawn credential-less in silence)", async () => {
  await assert.rejects(
    provisionGroupUser(comex, {
      run: async () => {},
      seed: async () => {},
      homeBase: "/home",
      userExists: async () => false,
      sharedCredentialPath: SHARED_CRED,
      ...okCredProbes,
      reachable: async (_u, _l) => ({ ok: false, detail: "sk-comex cannot read the shared credential" }),
    }),
    /not reachable|cannot read/i,
  );
});

// Change A — the three guard deps are REQUIRED once sharedCredentialPath is set.
// A future multi-tenant caller that sets the path but omits one would SILENTLY
// skip the symlink-safety / sign-in / reachability guard; that is a programmer
// error, so provisioning throws loudly rather than degrade the wall.
for (const omit of ["claudeDirStat", "sharedCredentialExists", "reachable"] as const) {
  test(`provisionGroupUser: THROWS when sharedCredentialPath is set but '${omit}' is omitted (guard deps are required in multi-tenant)`, async () => {
    const probes: Record<string, unknown> = { ...okCredProbes };
    delete probes[omit];
    await assert.rejects(
      provisionGroupUser(comex, {
        run: async () => {},
        seed: async () => {},
        homeBase: "/home",
        userExists: async () => false,
        sharedCredentialPath: SHARED_CRED,
        ...(probes as typeof okCredProbes),
      }),
      new RegExp(`required guard dep is missing|${omit}`),
    );
  });
}

// ── reachableFromInspection (the /root-trap DECISION, pure) ───────────────────
// The real server probe gathers stats and calls this; extracting the decision is
// what finally makes the mode/owner reachability logic testable on its own.

const OK_ANCESTORS = [
  { mode: 0o750, group: SHARED_CRED_GROUP }, // /var/lib/shadok-ai/credentials
  { mode: 0o755 }, // /var/lib/shadok-ai
  { mode: 0o755 }, // /var/lib
  { mode: 0o755 }, // /var
  { mode: 0o755 }, // /
];

test("reachableFromInspection: a proper chain (0750 root:shadok-cred dir + 0660 shadok-cred file) is reachable", () => {
  assert.equal(
    reachableFromInspection({ fileOwnerGroup: SHARED_CRED_GROUP, fileGroupReadable: true, ancestors: OK_ANCESTORS }),
    true,
  );
});

test("reachableFromInspection: a mode-700 ancestor (the /root trap) is NOT reachable", () => {
  assert.equal(
    reachableFromInspection({
      fileOwnerGroup: SHARED_CRED_GROUP,
      fileGroupReadable: true,
      // A 0700 root:root dir: no other-x and no group-x for shadok-cred → wall.
      ancestors: [{ mode: 0o660, group: SHARED_CRED_GROUP }, { mode: 0o700 }, { mode: 0o755 }],
    }),
    false,
  );
});

test("reachableFromInspection: a world-traversable (0755) ancestor passes on other-execute alone", () => {
  assert.equal(
    reachableFromInspection({
      fileOwnerGroup: SHARED_CRED_GROUP,
      fileGroupReadable: true,
      ancestors: [{ mode: 0o755 }], // other-x, no group needed
    }),
    true,
  );
});

test("reachableFromInspection: a group-execute (0710) ancestor passes ONLY when group-owned by shadok-cred", () => {
  assert.equal(
    reachableFromInspection({
      fileOwnerGroup: SHARED_CRED_GROUP,
      fileGroupReadable: true,
      ancestors: [{ mode: 0o710, group: SHARED_CRED_GROUP }],
    }),
    true,
  );
  // Same 0710 mode but owned by a different group → not traversable by us.
  assert.equal(
    reachableFromInspection({
      fileOwnerGroup: SHARED_CRED_GROUP,
      fileGroupReadable: true,
      ancestors: [{ mode: 0o710, group: "other" }],
    }),
    false,
  );
});

test("reachableFromInspection: a file NOT group-readable is unreachable (the 660 bit is load-bearing)", () => {
  assert.equal(
    reachableFromInspection({ fileOwnerGroup: SHARED_CRED_GROUP, fileGroupReadable: false, ancestors: OK_ANCESTORS }),
    false,
  );
});

test("reachableFromInspection: a file NOT group-owned by shadok-cred is unreachable", () => {
  assert.equal(
    reachableFromInspection({ fileOwnerGroup: "other", fileGroupReadable: true, ancestors: OK_ANCESTORS }),
    false,
  );
});

// ── classifyCredentialLink / checkCredentialDivergence (the verify-first gate) ─
// Classifies the HOME's .credentials.json into FOUR distinct facts, because a
// permission error (non-root server can't lstat a 700 HOME) must NOT be read as
// the rename signal. Only a REAL FILE is the write-new-then-rename divergence.

test("classifyCredentialLink: an intact symlink to the shared file is symlink-ok", () => {
  assert.equal(classifyCredentialLink(SHARED_CRED, { state: "symlink", target: SHARED_CRED }), "symlink-ok");
});

test("classifyCredentialLink: a MISSING link (pre-Task-7 HOME / not yet wired) is distinct from a real file", () => {
  assert.equal(classifyCredentialLink(SHARED_CRED, { state: "missing" }), "missing");
});

test("classifyCredentialLink: a symlink to the WRONG target is wrong-target, not a rename", () => {
  assert.equal(classifyCredentialLink(SHARED_CRED, { state: "symlink", target: "/somewhere/else" }), "wrong-target");
});

test("classifyCredentialLink: a REAL file where the symlink should be is the rename signal (real-file)", () => {
  assert.equal(classifyCredentialLink(SHARED_CRED, { state: "file" }), "real-file");
});

test("classifyCredentialLink: a permission error (EACCES) is cannot-stat — NOT a rename claim", () => {
  assert.equal(classifyCredentialLink(SHARED_CRED, { state: "cannot-stat" }), "cannot-stat");
});

test("checkCredentialDivergence: WARNS (naming the group + the broker gate + rename) ONLY on a REAL file", () => {
  const warnings: string[] = [];
  const state = checkCredentialDivergence(
    { id: "comex", home: "/home/sk-comex" },
    SHARED_CRED,
    { probe: () => ({ state: "file" }), warn: (m) => void warnings.push(m) },
  );
  assert.equal(state, "real-file");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /comex/);
  assert.match(warnings[0], /broker/i);
  assert.match(warnings[0], /rename/i);
});

test("checkCredentialDivergence: SILENT for an intact symlink", () => {
  const warnings: string[] = [];
  const state = checkCredentialDivergence(
    { id: "comex", home: "/home/sk-comex" },
    SHARED_CRED,
    { probe: () => ({ state: "symlink", target: SHARED_CRED }), warn: (m) => void warnings.push(m) },
  );
  assert.equal(state, "symlink-ok");
  assert.equal(warnings.length, 0);
});

test("checkCredentialDivergence: SILENT on a permission error — no false 'rename divergence' when the server cannot stat a 700 HOME", () => {
  const warnings: string[] = [];
  const state = checkCredentialDivergence(
    { id: "comex", home: "/home/sk-comex" },
    SHARED_CRED,
    { probe: () => ({ state: "cannot-stat" }), warn: (m) => void warnings.push(m) },
  );
  assert.equal(state, "cannot-stat");
  assert.equal(warnings.length, 0);
});

test("checkCredentialDivergence: SILENT on a missing link (not yet wired) — missing is not the rename signal", () => {
  const warnings: string[] = [];
  const state = checkCredentialDivergence(
    { id: "comex", home: "/home/sk-comex" },
    SHARED_CRED,
    { probe: () => ({ state: "missing" }), warn: (m) => void warnings.push(m) },
  );
  assert.equal(state, "missing");
  assert.equal(warnings.length, 0);
});

// Per-group dedupe: the server warns at most ONCE per group id (a real-file
// divergence recurs on every spawn/restart otherwise). `checkCredentialDivergence`
// is stateless and returns the category so the CALLER can record it and pass a
// no-op `warn` on subsequent calls. This test exercises that exact contract — the
// warn-once-per-group pattern `warnIfCredentialDiverged` (server.ts) implements.
test("checkCredentialDivergence: supports per-group dedupe — the returned category lets a caller warn ONCE per group", () => {
  const warned = new Set<string>();
  const warnings: Array<[string, string]> = [];
  const run = (id: string) =>
    checkCredentialDivergence(
      { id, home: `/home/sk-${id}` },
      SHARED_CRED,
      {
        probe: () => ({ state: "file" }),
        // The server's dedupe: a no-op sink once this group has already warned.
        warn: warned.has(id) ? () => {} : (m) => void warnings.push([id, m]),
      },
    ) === "real-file"
      ? warned.add(id)
      : undefined;

  run("comex"); // fires
  run("comex"); // deduped (no-op warn)
  run("sales"); // a DIFFERENT group still fires

  assert.deepEqual(
    warnings.map(([id]) => id),
    ["comex", "sales"],
    "each group warns exactly once; the second comex call is suppressed",
  );
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
  for (const nature of ["restricted", "private"] as const) {
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
  assert.notEqual(SHARED_POT_GROUP, SHARED_CRED_GROUP);
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
