import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sshPaths,
  inContainer,
  planDotSshWiring,
  ensureSshIdentity,
  volumeKeyPaths,
  groupKeyRows,
} from "../src/ssh.js";
import type { Group } from "../src/groups.js";

const G = (id: string, name: string, nature: Group["nature"]): Group =>
  ({ id, name, nature, members: [], createdAt: 0 }) as Group;

test("sshPaths: derives everything under <home>/.shadok-ai/ssh and <home>/.ssh", () => {
  const p = sshPaths("/home/x");
  assert.equal(p.dir, "/home/x/.shadok-ai/ssh");
  assert.equal(p.key, "/home/x/.shadok-ai/ssh/id_ed25519");
  assert.equal(p.pub, "/home/x/.shadok-ai/ssh/id_ed25519.pub");
  assert.equal(p.config, "/home/x/.shadok-ai/ssh/config");
  assert.equal(p.knownHosts, "/home/x/.shadok-ai/ssh/known_hosts");
  assert.equal(p.dotSsh, "/home/x/.ssh");
});

test("inContainer: env overrides win over /.dockerenv probe", () => {
  const yes = () => true;
  const no = () => false;
  // disabled explicitly
  assert.equal(inContainer({ SHADOK_SSH_IDENTITY: "0" }, yes), false);
  // forced on even without /.dockerenv
  assert.equal(inContainer({ SHADOK_FORCE_SSH_IDENTITY: "1" }, no), true);
  // falls back to the probe
  assert.equal(inContainer({}, yes), true);
  assert.equal(inContainer({}, no), false);
});

test("planDotSshWiring: absent→symlink, ours→leave, foreign/real→migrate", () => {
  assert.equal(planDotSshWiring("absent"), "symlink");
  assert.equal(planDotSshWiring("our-symlink"), "leave");
  assert.equal(planDotSshWiring("foreign-symlink"), "migrate-then-symlink");
  assert.equal(planDotSshWiring("real-dir"), "migrate-then-symlink");
  assert.equal(planDotSshWiring("other"), "leave");
});

test("ensureSshIdentity: no-op off-container (never touches ~/.ssh)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sshtest-"));
  const out = ensureSshIdentity({ home, isContainer: false, log: () => {} });
  assert.deepEqual(out, {});
  assert.equal(fs.existsSync(path.join(home, ".ssh")), false);
  assert.equal(fs.existsSync(path.join(home, ".shadok-ai", "ssh")), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("ensureSshIdentity: in-container creates key, config, ~/.ssh symlink; idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sshtest-"));
  // Fake keygen so the test doesn't depend on the ssh-keygen binary.
  const fakeKeygen = (p: ReturnType<typeof sshPaths>) => {
    fs.writeFileSync(p.key, "PRIVATE", { mode: 0o600 });
    fs.writeFileSync(p.pub, "ssh-ed25519 AAAAFAKE shadok-test\n", { mode: 0o644 });
  };
  const logs: string[] = [];
  const out = ensureSshIdentity({
    home,
    isContainer: true,
    keygen: fakeKeygen,
    log: (m) => logs.push(m),
  });

  const p = sshPaths(home);
  assert.ok(fs.existsSync(p.key), "private key created");
  assert.equal(fs.statSync(p.key).mode & 0o777, 0o600, "private key is 600");
  assert.ok(fs.existsSync(p.config), "config written");
  assert.ok(fs.existsSync(p.knownHosts), "known_hosts written");
  // ~/.ssh is a symlink to the persistent dir
  assert.ok(fs.lstatSync(p.dotSsh).isSymbolicLink(), "~/.ssh is a symlink");
  assert.equal(fs.realpathSync(p.dotSsh), fs.realpathSync(p.dir));
  // GIT_SSH_COMMAND fallback returned
  assert.match(out.GIT_SSH_COMMAND ?? "", /ssh -F .*\/config$/);
  // public key logged
  assert.ok(logs.some((l) => l.startsWith("ssh identity:")));

  // Second call is a no-op that preserves the key and symlink.
  const before = fs.readFileSync(p.key, "utf8");
  ensureSshIdentity({ home, isContainer: true, keygen: fakeKeygen, log: () => {} });
  assert.equal(fs.readFileSync(p.key, "utf8"), before, "key untouched on 2nd run");
  assert.ok(fs.lstatSync(p.dotSsh).isSymbolicLink());

  fs.rmSync(home, { recursive: true, force: true });
});

test("ensureSshIdentity: migrates a pre-existing real ~/.ssh without clobbering managed files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sshtest-"));
  // Simulate a ~/.ssh baked into the image with a known_hosts and a stray file.
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".ssh", "known_hosts"), "PRE-EXISTING\n");
  fs.writeFileSync(path.join(home, ".ssh", "extra"), "keep me\n");

  const fakeKeygen = (p: ReturnType<typeof sshPaths>) => {
    fs.writeFileSync(p.key, "PRIVATE", { mode: 0o600 });
    fs.writeFileSync(p.pub, "ssh-ed25519 AAAAFAKE shadok-test\n", { mode: 0o644 });
  };
  ensureSshIdentity({ home, isContainer: true, keygen: fakeKeygen, log: () => {} });

  const p = sshPaths(home);
  assert.ok(fs.lstatSync(p.dotSsh).isSymbolicLink(), "~/.ssh replaced by symlink");
  // our managed known_hosts (empty) must NOT be overwritten by the pre-existing one
  assert.equal(fs.readFileSync(p.knownHosts, "utf8"), "", "managed known_hosts preserved");
  // the stray file survived the migration
  assert.equal(fs.readFileSync(path.join(p.dir, "extra"), "utf8"), "keep me\n");

  fs.rmSync(home, { recursive: true, force: true });
});

test("volumeKeyPaths: the commons reuses the historical key, an isolated group gets its own", () => {
  // The operator's split (2026-11-03): one already-registered identity for the
  // shared space, one key per walled group.
  const commons = volumeKeyPaths("/root", "main", "main");
  assert.equal(commons.dir, "/root/.shadok-ai/ssh");
  assert.equal(commons.key, "/root/.shadok-ai/ssh/id_ed25519");
  assert.equal(commons.shared, true);

  const walled = volumeKeyPaths("/root", "sk-abc", "main");
  assert.equal(walled.dir, "/root/.shadok-ai/ssh/groups/sk-abc");
  assert.equal(walled.pub, "/root/.shadok-ai/ssh/groups/sk-abc/id_ed25519.pub");
  assert.equal(walled.shared, false);
});

test("volumeKeyPaths: no drop user at all is the mono-tenant case — the shared key", () => {
  // A mono-tenant cockpit has ONE identity; `commonsUser` is null there, and a
  // group with no OS user of its own must not resolve to `groups/null/`.
  const p = volumeKeyPaths("/root", null, null);
  assert.equal(p.dir, "/root/.shadok-ai/ssh");
  assert.equal(p.shared, true);
});

test("volumeKeyPaths: every path stays inside the key store", () => {
  // OS user names are sanitised upstream (`osUserFor`), but this is the function
  // a chown/keygen is aimed at: a path escaping the store would write elsewhere.
  for (const user of ["sk-abc", "main", "sk-0000-1111"]) {
    const p = volumeKeyPaths("/root", user, "main");
    assert.ok(p.key.startsWith("/root/.shadok-ai/ssh/"), p.key);
    assert.ok(p.pub.startsWith("/root/.shadok-ai/ssh/"), p.pub);
  }
});

test("groupKeyRows: a public group shows the shared key, a walled one its own", () => {
  const rows = groupKeyRows([G("main", "Main", "public"), G("g1", "HR", "restricted")], {
    serverHome: "/root",
    commonsUser: "main",
    osUserFor: (g) => (g.nature === "public" ? null : "sk-" + g.id),
    readPub: (p) => (p.includes("groups/sk-g1") ? "ssh-ed25519 AAAAg1 shadok-sk-g1\n" : "ssh-ed25519 AAAAhist shadok-main\n"),
  });
  assert.deepEqual(rows, [
    { group: "main", name: "Main", osUser: "main", publicKey: "ssh-ed25519 AAAAhist shadok-main", shared: true },
    { group: "g1", name: "HR", osUser: "sk-g1", publicKey: "ssh-ed25519 AAAAg1 shadok-sk-g1", shared: false },
  ]);
});

test("groupKeyRows: a keypair that does not exist yet reads as null, never an empty key", () => {
  // An empty string would render as "a key with no content"; null is the honest
  // "not minted yet" the panel can explain.
  const rows = groupKeyRows([G("g1", "HR", "restricted")], {
    serverHome: "/root",
    commonsUser: "main",
    osUserFor: () => "sk-g1",
    readPub: () => null,
  });
  assert.equal(rows[0].publicKey, null);
  const blank = groupKeyRows([G("g1", "HR", "restricted")], {
    serverHome: "/root",
    commonsUser: "main",
    osUserFor: () => "sk-g1",
    readPub: () => "   \n",
  });
  assert.equal(blank[0].publicKey, null);
});

test("groupKeyRows: only ever reads the PUBLIC half", () => {
  // The private key must be unreachable by construction, not by review: the rows
  // are built from a reader that is only ever handed a `.pub` path.
  const seen: string[] = [];
  groupKeyRows([G("main", "Main", "public"), G("g1", "HR", "restricted")], {
    serverHome: "/root",
    commonsUser: "main",
    osUserFor: (g) => (g.nature === "public" ? null : "sk-g1"),
    readPub: (p) => {
      seen.push(p);
      return null;
    },
  });
  assert.equal(seen.length, 2);
  for (const p of seen) assert.ok(p.endsWith("/id_ed25519.pub"), p);
});

test("groupKeyRows: on a mono-tenant cockpit every group shows the ONE identity", () => {
  // No drop users there: a walled group's agents run as the server's own user,
  // so pointing at `groups/sk-…` would name a key nothing will ever read.
  const rows = groupKeyRows([G("main", "Main", "public"), G("g1", "HR", "restricted")], {
    serverHome: "/root",
    commonsUser: null,
    osUserFor: () => null,
    readPub: () => "ssh-ed25519 AAAAonly the-one\n",
  });
  for (const r of rows) {
    assert.equal(r.osUser, null);
    assert.equal(r.shared, true);
    assert.equal(r.publicKey, "ssh-ed25519 AAAAonly the-one");
  }
});

test("server: the group key store is minted at boot and wired into every drop user's HOME", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "server.ts"),
    "utf8",
  );
  // Minted from the boot provisioning reconciler, BEFORE the HOMEs are filled, so
  // a public key exists to register before the group's first agent spawns.
  assert.match(src, /ensureGroupVolumeKeys\(\);[\s\S]{0,400}preseedGroupHomes\(\);/);
  // Wired into the HOME at boot too, not only at spawn: /home is not on the volume
  // and a resumed agent never runs the spawn path.
  assert.match(src, /ensureTierStateDir\(user, home\);[\s\S]{0,500}ensureAgentSshKey\(user, home\);/);
  // The endpoint and the provisioner share ONE path decision.
  assert.match(src, /volumeKeyPaths\(os\.homedir\(\), user, COMMONS_USER\)/);
  // Mono-tenant collapses to the one identity rather than naming a per-group dir.
  assert.match(src, /DEPLOYMENT_MODE === "multi-tenant" \? osUserFor\(g\) : null/);
  // The endpoint is filtered exactly like GET /groups — a private group stays invisible.
  assert.match(src, /app\.get\("\/groups\/ssh"[\s\S]{0,400}listableGroups\(loadGroups\(\), viewerFor\(currentAccount\(req\)\)\)/);
});
