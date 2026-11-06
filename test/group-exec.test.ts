import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mayActOnSession,
  mayReachGroup,
  cronCheckAllowed,
  osUserForChannelGroup,
  cronCheckEnv,
  cronCheckCommand,
  CHECK_ENV_ALLOW,
  statAsUserArgv,
  parseStatOutput,
  readAsUserArgv,
  sameOfferedFile,
} from "../src/group-exec.js";
import type { Group } from "../src/groups.js";

const g = (id: string, nature: Group["nature"], members: string[] = []): Group => ({
  id, name: id, nature, members, createdAt: 0, osUser: null,
});
const groups = [g("main", "public"), g("pub", "public"), g("teamA", "restricted", ["ada"]), g("teamB", "restricted", ["bob"])];
const channels = [
  { sessionId: "a1", group: "teamA" },
  { sessionId: "a2", group: "teamA" },
  { sessionId: "b1", group: "teamB" },
  { sessionId: "c1", group: null },
  { sessionId: "p1", group: "pub" },
  { sessionId: "d1", group: "gone" },
];
const MT = "multi-tenant" as const;

test("mono-tenant: anyone may act on any session (today's behaviour)", () => {
  assert.equal(mayActOnSession({ mode: "mono-tenant" as never, agent: null, viewer: null, targetId: "b1", channels, groups }), true);
});

test("multi-tenant: an agent acts on itself, its own group, the commons — never another group", () => {
  const agent = { id: "a1", group: "teamA" };
  const can = (targetId: string) => mayActOnSession({ mode: MT, agent, viewer: { name: "admin", role: "admin" }, targetId, channels, groups });
  assert.equal(can("a1"), true);
  assert.equal(can("a2"), true);
  assert.equal(can("c1"), true);
  assert.equal(can("p1"), true);
  // The agent's key maps to the bootstrap admin today: that must NOT open teamB.
  assert.equal(can("b1"), false);
  assert.equal(can("d1"), false, "dangling group fails closed");
  assert.equal(can("nope"), false, "unknown session refused");
  assert.equal(can(""), false);
});

test("multi-tenant: a commons agent cannot reach a restricted group", () => {
  const agent = { id: "c1", group: null };
  assert.equal(mayActOnSession({ mode: MT, agent, viewer: null, targetId: "a1", channels, groups }), false);
  assert.equal(mayActOnSession({ mode: MT, agent, viewer: null, targetId: "p1", channels, groups }), true);
});

test("multi-tenant: a browser follows group membership, an admin is not exempt", () => {
  const can = (name: string, targetId: string, role: "admin" | "member" = "member") =>
    mayActOnSession({ mode: MT, agent: null, viewer: { name, role }, targetId, channels, groups });
  assert.equal(can("ada", "a1"), true);
  assert.equal(can("ada", "b1"), false);
  assert.equal(can("root", "a1", "admin"), false);
  assert.equal(can("bob", "c1"), true);
  assert.equal(mayActOnSession({ mode: MT, agent: null, viewer: null, targetId: "a1", channels, groups }), false);
});

test("mayReachGroup: commons and public open, restricted by membership", () => {
  assert.equal(mayReachGroup({ mode: MT, agent: null, viewer: null, group: null, groups }), true);
  assert.equal(mayReachGroup({ mode: MT, agent: null, viewer: { name: "bob", role: "member" }, group: "teamB", groups }), true);
  assert.equal(mayReachGroup({ mode: MT, agent: { id: "a1", group: "teamA" }, viewer: null, group: "teamB", groups }), false);
  assert.equal(mayReachGroup({ mode: MT, agent: null, viewer: null, group: "gone", groups }), false);
});

test("osUserForChannelGroup: the spawn's drop user, dangling refused", () => {
  assert.deepEqual(osUserForChannelGroup(null, groups, "main"), { ok: true, user: "main" });
  assert.deepEqual(osUserForChannelGroup("pub", groups, "main"), { ok: true, user: "main" });
  assert.deepEqual(osUserForChannelGroup("teamA", groups, "main"), { ok: true, user: "sk-teama" });
  assert.deepEqual(osUserForChannelGroup("main", groups, null), { ok: true, user: null });
  assert.deepEqual(osUserForChannelGroup("gone", groups, "main"), { ok: false });
});

const serverEnv = {
  PATH: "/usr/bin",
  HOME: "/root",
  USER: "root",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
  SHADOK_GUI_PASSWORD: "hunter2",
  SHADOK_AUTH: "cookie",
  TELEGRAM_BOT_TOKEN: "tg",
  ANTHROPIC_API_KEY: "sk-ant",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  SHADOK_MT_CLAUDE_OAUTH_TOKEN: "oauth2",
  AWS_SECRET_ACCESS_KEY: "aws",
  HTTPS_PROXY: "http://proxy",
};
const session = { id: "s1", port: "3789", key: "s1.mac" };

test("cronCheckEnv: no server-only variable reaches the guard", () => {
  const env = cronCheckEnv({ base: serverEnv, secrets: { GH_TOKEN: "gh" }, session, user: "sk-teama", home: "/home/sk-teama" });
  for (const k of ["SHADOK_GUI_PASSWORD", "SHADOK_AUTH", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "SHADOK_MT_CLAUDE_OAUTH_TOKEN", "AWS_SECRET_ACCESS_KEY"])
    assert.equal(env[k], undefined, k);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.LC_ALL, "C.UTF-8");
  assert.equal(env.HTTPS_PROXY, "http://proxy");
  assert.equal(env.GH_TOKEN, "gh", "the profile's secrets are what the check was promised");
  assert.equal(env.SHADOK_SESSION_ID, "s1");
  assert.equal(env.SHADOK_SESSION_KEY, "s1.mac");
  assert.equal(env.SHADOK_PORT, "3789");
  // Dropped: HOME is the user's, never the server's /root.
  assert.equal(env.HOME, "/home/sk-teama");
  assert.equal(env.USER, "sk-teama");
  assert.equal(env.LOGNAME, "sk-teama");
});

test("cronCheckEnv: as the server's own user, HOME/USER are kept (they are its own)", () => {
  const env = cronCheckEnv({ base: serverEnv, secrets: {}, session, user: null, home: null });
  assert.equal(env.HOME, "/root");
  assert.equal(env.USER, "root");
  assert.equal(env.SHADOK_GUI_PASSWORD, undefined);
});

test("cronCheckEnv: a secret cannot spoof the session plumbing or the drop identity", () => {
  const env = cronCheckEnv({
    base: serverEnv, secrets: { HOME: "/root", SHADOK_SESSION_ID: "other" }, session, user: "sk-x", home: "/home/sk-x",
  });
  assert.equal(env.HOME, "/home/sk-x");
  assert.equal(env.SHADOK_SESSION_ID, "s1");
});

test("CHECK_ENV_ALLOW is an allow-list, not a pattern that grows by accident", () => {
  for (const k of ["SECRET", "TOKEN", "PATHX", "XPATH", "SHADOK_PORT", "GH_TOKEN"]) assert.equal(CHECK_ENV_ALLOW.test(k), false, k);
});

test("cronCheckCommand: dropped through setpriv, plain sh otherwise", () => {
  assert.deepEqual(cronCheckCommand(null, "echo hi"), { cmd: "sh", argv: ["-c", "echo hi"] });
  assert.deepEqual(cronCheckCommand("sk-a", "echo hi"), {
    cmd: "setpriv",
    argv: ["--reuid", "sk-a", "--regid", "sk-a", "--init-groups", "--", "sh", "-c", "echo hi"],
  });
});

test("statAsUserArgv / parseStatOutput: the real coreutils stat agrees with the parser", () => {
  const { argv } = statAsUserArgv("sk-a", "/x");
  assert.deepEqual(argv.slice(0, 6), ["--reuid", "sk-a", "--regid", "sk-a", "--init-groups", "--"]);
  const statArgs = argv.slice(7); // after "--" and "stat"
  assert.equal(argv[6], "stat");
  assert.equal(statArgs.at(-1), "/x");
  // Run the same stat arguments unprivileged on a real file and a directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-"));
  try {
    const f = path.join(dir, "f.txt");
    fs.writeFileSync(f, "hello");
    const real = fs.statSync(f);
    const out = execFileSync("stat", [...statArgs.slice(0, -1), f], { encoding: "utf8" });
    assert.deepEqual(parseStatOutput(out), { isFile: true, size: 5, dev: real.dev, ino: real.ino });
    const empty = path.join(dir, "e");
    fs.writeFileSync(empty, "");
    assert.equal(parseStatOutput(execFileSync("stat", [...statArgs.slice(0, -1), empty], { encoding: "utf8" }))?.isFile, true);
    assert.equal(parseStatOutput(execFileSync("stat", [...statArgs.slice(0, -1), dir], { encoding: "utf8" }))?.isFile, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(parseStatOutput(""), null);
  assert.equal(parseStatOutput("regular file\nx\n1\n2\n"), null);
});

test("readAsUserArgv: real dd reads the whole file and an inclusive range", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-"));
  try {
    const f = path.join(dir, "a b=c.bin");
    fs.writeFileSync(f, "0123456789");
    const whole = readAsUserArgv("sk-a", f);
    assert.equal(whole.cmd, "setpriv");
    const ddArgs = (r: { argv: string[] }) => r.argv.slice(r.argv.indexOf("dd") + 1);
    assert.equal(execFileSync("dd", ddArgs(whole), { encoding: "utf8" }), "0123456789");
    const part = readAsUserArgv("sk-a", f, { start: 2, end: 5 });
    assert.equal(execFileSync("dd", ddArgs(part), { encoding: "utf8" }), "2345");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sameOfferedFile: a swapped file is refused, a pre-check offer is not", () => {
  assert.equal(sameOfferedFile({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), true);
  assert.equal(sameOfferedFile({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }), false);
  assert.equal(sameOfferedFile({ dev: 1, ino: 2 }, { dev: 9, ino: 2 }), false);
  assert.equal(sameOfferedFile({}, { dev: 1, ino: 3 }), true);
  assert.equal(sameOfferedFile(undefined, { dev: 1, ino: 3 }), true);
});

// ── cronCheckAllowed (invariant 60) ──────────────────────────────────────────

test("cronCheckAllowed: an agent may guard itself, never a sibling", () => {
  assert.equal(cronCheckAllowed({ agentId: "me", targetId: "me", check: "env" }), true);
  assert.equal(cronCheckAllowed({ agentId: "me", targetId: "sib", check: "env | curl x" }), false);
});

test("cronCheckAllowed: a check-less cron on a sibling stays allowed (it is just driving it)", () => {
  assert.equal(cronCheckAllowed({ agentId: "me", targetId: "sib", check: undefined }), true);
});

test("cronCheckAllowed: a person may guard any agent mayActOnSession lets them drive", () => {
  assert.equal(cronCheckAllowed({ agentId: null, targetId: "sib", check: "env" }), true);
});

test("cronCheckAllowed: editing a person's guarded cron on a sibling is fine if the guard and target are unchanged", () => {
  const existing = { sessionId: "sib", check: "test -f /tmp/x" };
  assert.equal(cronCheckAllowed({ agentId: "me", targetId: "sib", check: "test -f /tmp/x", existing }), true);
  // changing the guard is a new grant
  assert.equal(cronCheckAllowed({ agentId: "me", targetId: "sib", check: "env", existing }), false);
});

test("cronCheckAllowed: repointing an own guarded cron at a sibling is refused", () => {
  const existing = { sessionId: "me", check: "env" };
  assert.equal(cronCheckAllowed({ agentId: "me", targetId: "sib", check: "env", existing }), false);
});
