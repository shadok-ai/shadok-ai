import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AGENT_CREDENTIAL_VARS,
  agentAccount,
  headerPresent,
  isBrowserPerson,
  resolveAgentPrincipal,
  withoutAgentCredentials,
} from "../src/agent-principal.js";
import {
  canAdministerGroup,
  canSeeGroup,
  canSeeSession,
  canWriteSecretGroup,
  listableGroups,
  memberGroupIds,
  membershipVerdict,
  spawnGroupFor,
  viewerFor,
  type Group,
} from "../src/groups.js";
import { userWriteVerdict } from "../src/accounts.js";
import { spawnEnv } from "../src/session.js";
import { launcherScript } from "../src/tmux.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const g = (id: string, nature: Group["nature"], members: string[] = [], owner?: string): Group =>
  ({ id, name: id, nature, members, createdAt: 0, ...(owner ? { owner } : {}) }) as Group;
const GROUPS: Group[] = [
  g("main", "public"),
  g("comex", "restricted", ["alice", "admin-bob"]),
  g("rnd", "restricted", ["carol"]),
  g("p-alice", "private", [], "alice"),
];
const CHANNELS = [
  { sessionId: "s-comex", group: "comex", profile: "Shadok-dev", createdBy: "alice" },
  { sessionId: "s-commons", group: null, profile: null, createdBy: "bob" },
  { sessionId: "s-peer", group: null, createdByPeer: "remote" },
  { sessionId: "s-member-peer", group: null, createdByPeer: "friend" },
  { sessionId: "s-private", group: "p-alice", createdBy: "alice" },
];
const scope = (name: string) => (name === "remote" ? "restricted" : name === "friend" ? "member" : null);
const agentViewer = (id: string) => viewerFor(agentAccount(resolveAgentPrincipal(id, CHANNELS, scope)));

test("a session key resolves to THE AGENT — a member, never the bootstrap admin", () => {
  const p = resolveAgentPrincipal("s-comex", CHANNELS, scope);
  assert.deepEqual(p, { sessionId: "s-comex", group: "comex", profile: "Shadok-dev", createdBy: "alice", peer: null });
  const a = agentAccount(p);
  assert.equal(a.role, "member");
  assert.equal(a.name, "agent:s-comex");
  assert.notEqual(a.name, "admin");
});

test("the live process's profile beats the stored one, as callerOf reads it", () => {
  assert.equal(resolveAgentPrincipal("s-comex", CHANNELS, scope, "Shadok-QA").profile, "Shadok-QA");
});

test("an agent a RESTRICTED peer spawned inherits the peer's box; a member peer's does not", () => {
  assert.equal(resolveAgentPrincipal("s-peer", CHANNELS, scope).peer, "remote");
  assert.equal(resolveAgentPrincipal("s-member-peer", CHANNELS, scope).peer, null);
});

test("a REVOKED peer's agent stays boxed (an unknown peer is never proven a member)", () => {
  assert.equal(resolveAgentPrincipal("s-peer", CHANNELS, () => null).peer, "remote");
});

test("an agent sees its OWN group and the public ones — never another restricted group", () => {
  const v = agentViewer("s-comex");
  assert.equal(canSeeGroup(GROUPS[1], v), true); // comex: its own
  assert.equal(canSeeGroup(GROUPS[0], v), true); // main: public
  assert.equal(canSeeGroup(GROUPS[2], v), false); // rnd: foreign
  assert.equal(canSeeGroup(GROUPS[3], v), false); // alice's private: foreign
  assert.deepEqual(listableGroups(GROUPS, v).map((x) => x.id), ["main", "comex"]);
  assert.deepEqual([...memberGroupIds(GROUPS, v)], ["comex"]);
});

test("an agent's membership is its channel's group, never borrowed from its creator", () => {
  // alice belongs to comex AND owns p-alice; her commons agent belongs to neither.
  const ch = [{ sessionId: "s-a", group: null, createdBy: "alice" }];
  const v = viewerFor(agentAccount(resolveAgentPrincipal("s-a", ch, scope)));
  assert.equal(canSeeGroup(GROUPS[1], v), false);
  assert.equal(canSeeGroup(GROUPS[3], v), false);
  assert.equal(spawnGroupFor(v, GROUPS)?.id, "main");
});

test("an agent is never a member by NAME, even if a roster lists its principal name", () => {
  const gs = [...GROUPS, g("trap", "restricted", ["agent:s-comex"])];
  assert.equal(canSeeGroup(gs[4], agentViewer("s-comex")), false);
});

test("a private group's own agent sees it and writes its secrets; nobody else's agent does", () => {
  assert.equal(canSeeGroup(GROUPS[3], agentViewer("s-private")), true);
  assert.equal(canWriteSecretGroup(GROUPS[3], agentViewer("s-private")), true);
  assert.equal(canWriteSecretGroup(GROUPS[3], agentViewer("s-comex")), false);
});

test("a child an agent spawns lands in the agent's own group", () => {
  assert.equal(spawnGroupFor(agentViewer("s-comex"), GROUPS)?.id, "comex");
  assert.equal(spawnGroupFor(agentViewer("s-commons"), GROUPS)?.id, "main");
});

test("an agent never administers a group nor changes a roster — its own included", () => {
  const v = agentViewer("s-comex");
  assert.equal(canAdministerGroup(GROUPS[1], v), false);
  assert.equal(membershipVerdict(v, GROUPS[1], "invite", "mallory").ok, false);
  assert.equal(membershipVerdict(v, GROUPS[1], "leave", v!.name).ok, false);
  // The Main commons' secrets are an ADMIN's write for a person — and an agent is no admin.
  assert.equal(canWriteSecretGroup(GROUPS[0], v), false);
});

test("the session-level gate follows the agent's group", () => {
  const chans = [...CHANNELS, { sessionId: "s-rnd", group: "rnd" }];
  assert.equal(canSeeSession("s-rnd", chans as never, GROUPS, agentViewer("s-comex")), false);
  assert.equal(canSeeSession("s-comex", chans as never, GROUPS, agentViewer("s-comex")), true);
  assert.equal(canSeeSession("s-commons", chans as never, GROUPS, agentViewer("s-comex")), true);
});

test("a person keeps the name-based rules (no agentGroup on a person's viewer)", () => {
  const v = viewerFor({ name: "alice", role: "member" });
  assert.equal(v!.agentGroup, undefined);
  assert.equal(canSeeGroup(GROUPS[1], v), true);
  assert.equal(canSeeGroup(GROUPS[3], v), true);
  assert.equal(canAdministerGroup(GROUPS[1], v), true);
});

test("browser-only = a person: an agent key or a peer token never passes, forged Origin or not", () => {
  const base = { hasAgentKey: false, hasPeerToken: false, passwordSet: true, personCookie: true, sameOrigin: true };
  assert.equal(isBrowserPerson(base), true);
  assert.equal(isBrowserPerson({ ...base, hasAgentKey: true }), false);
  assert.equal(isBrowserPerson({ ...base, hasPeerToken: true }), false);
  // A forged Origin with no person's cookie, on a password-protected instance.
  assert.equal(isBrowserPerson({ ...base, personCookie: false }), false);
  assert.equal(isBrowserPerson({ ...base, sameOrigin: false }), false);
  // No password: no cookie to ask for — the Origin check and the machine-header
  // refusal are what remain.
  assert.equal(isBrowserPerson({ ...base, passwordSet: false, personCookie: false }), true);
  assert.equal(isBrowserPerson({ ...base, passwordSet: false, personCookie: false, hasAgentKey: true }), false);
});

test("headerPresent: any non-empty value counts, valid or not", () => {
  assert.equal(headerPresent("x"), true);
  assert.equal(headerPresent(""), false);
  assert.equal(headerPresent(undefined), false);
  assert.equal(headerPresent(["", "y"]), true);
});

test("no person account may be named like an agent principal", () => {
  const v = userWriteVerdict({ actorRole: "admin", action: "create", target: "agent:123", exists: false });
  assert.equal(v.ok, false);
  assert.equal(userWriteVerdict({ actorRole: "admin", action: "create", target: "agentx", exists: false }).ok, true);
});

test("the credential vars are exactly the admin cookie and the instance password", () => {
  assert.deepEqual([...AGENT_CREDENTIAL_VARS].sort(), ["SHADOK_AUTH", "SHADOK_GUI_PASSWORD"]);
  assert.deepEqual(withoutAgentCredentials({ A: "1", SHADOK_AUTH: "c", SHADOK_GUI_PASSWORD: "p" }), { A: "1" });
});

test("a PTY spawn carries neither credential — inherited or passed by the caller", () => {
  const env = spawnEnv(
    { env: { SHADOK_AUTH: "sk_auth=x", SHADOK_SESSION_KEY: "k" } },
    { PATH: "/bin", SHADOK_GUI_PASSWORD: "hunter2", SHADOK_AUTH: "sk_auth=y" },
  );
  assert.equal(env.SHADOK_AUTH, undefined);
  assert.equal(env.SHADOK_GUI_PASSWORD, undefined);
  assert.equal(env.SHADOK_SESSION_KEY, "k");
  assert.equal(env.PATH, "/bin");
});

test("a tmux launcher unsets both credentials even when the pane inherits them, and never exports one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadok-cred-"));
  try {
    const file = path.join(dir, "launch.sh");
    const { script } = launcherScript({
      unset: [],
      env: { SHADOK_AUTH: "sk_auth=x", KEEP: "yes" },
      forced: {},
      bin: "sh",
      args: ["-c", 'printf "%s|%s|%s" "${SHADOK_AUTH-unset}" "${SHADOK_GUI_PASSWORD-unset}" "$KEEP"'],
    });
    assert.ok(!script.includes("sk_auth=x"));
    fs.writeFileSync(file, script, { mode: 0o600 });
    // The pane's inherited environment (the tmux server's global env) carries both.
    const out = execFileSync("sh", [file], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SHADOK_GUI_PASSWORD: "hunter2", SHADOK_AUTH: "sk_auth=old" },
    });
    assert.equal(out, "unset|unset|yes");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source: the server injects no SHADOK_AUTH and drops the credentials from its own env at boot", () => {
  const src = fs.readFileSync(path.join(here, "..", "src", "server.ts"), "utf8");
  assert.ok(!/env\.SHADOK_AUTH\s*=/.test(src), "makePilot must not inject SHADOK_AUTH");
  assert.match(src, /for \(const k of AGENT_CREDENTIAL_VARS\) delete process\.env\[k\];/);
  // The drop must come right after the password is read — before anything spawns.
  const read = src.indexOf('const GUI_PASSWORD = (process.env.SHADOK_GUI_PASSWORD ?? "").trim();');
  const drop = src.indexOf("for (const k of AGENT_CREDENTIAL_VARS) delete process.env[k];");
  assert.ok(read > 0 && drop > read && drop - read < 1200);
});

test("source: a session key resolves to the agent principal, not the bootstrap admin", () => {
  const src = fs.readFileSync(path.join(here, "..", "src", "server.ts"), "utf8");
  const start = src.indexOf("function currentAccount(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /const agent = agentPrincipal\(req\);\s*if \(agent\) return agentAccount\(agent\);/);
  // …and that check comes before the no-password shortcut.
  assert.ok(body.indexOf("agentPrincipal(req)") < body.indexOf("if (!GUI_PASSWORD)"));
});
