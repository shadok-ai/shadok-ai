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
} from "../src/ssh.js";

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
