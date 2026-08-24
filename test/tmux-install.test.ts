import test from "node:test";
import assert from "node:assert/strict";
import { tmuxInstallCommand, ensureTmux } from "../src/tmux-install.js";

test("tmuxInstallCommand: macOS + brew → brew install tmux (sans root)", () => {
  assert.deepEqual(tmuxInstallCommand("darwin", (b) => b === "brew"), {
    cmd: "brew",
    args: ["install", "tmux"],
    needsRoot: false,
  });
});

test("tmuxInstallCommand: macOS sans brew → null", () => {
  assert.equal(tmuxInstallCommand("darwin", () => false), null);
});

test("tmuxInstallCommand: linux + apt-get → apt-get install (root requis)", () => {
  assert.deepEqual(tmuxInstallCommand("linux", (b) => b === "apt-get"), {
    cmd: "apt-get",
    args: ["install", "-y", "tmux"],
    needsRoot: true,
  });
});

test("tmuxInstallCommand: linux choisit apk quand c'est le seul manager", () => {
  assert.deepEqual(tmuxInstallCommand("linux", (b) => b === "apk"), {
    cmd: "apk",
    args: ["add", "tmux"],
    needsRoot: true,
  });
});

test("tmuxInstallCommand: aucun manager / plateforme non gérée → null", () => {
  assert.equal(tmuxInstallCommand("linux", () => false), null);
  assert.equal(tmuxInstallCommand("win32", () => true), null);
});

test("ensureTmux: déjà présent → pas d'install", async () => {
  let installed = false;
  const r = await ensureTmux({
    resolve: () => "/usr/bin/tmux",
    plan: () => ({ cmd: "brew", args: ["install", "tmux"], needsRoot: false }),
    install: async () => { installed = true; },
    notify: () => {},
  });
  assert.deepEqual(r, { installed: false, present: true });
  assert.equal(installed, false);
});

test("ensureTmux: absent + plan → install → présent", async () => {
  let calls = 0;
  const r = await ensureTmux({
    resolve: () => (calls++ === 0 ? null : "/opt/homebrew/bin/tmux"),
    plan: () => ({ cmd: "brew", args: ["install", "tmux"], needsRoot: false }),
    install: async () => {},
    notify: () => {},
  });
  assert.equal(r.present, true);
  assert.equal(r.installed, true);
});

test("ensureTmux: absent + aucun manager → non bloquant (note)", async () => {
  const r = await ensureTmux({ resolve: () => null, plan: () => null, install: async () => {}, notify: () => {} });
  assert.equal(r.present, false);
  assert.equal(r.note, "no-manager");
});

test("ensureTmux: install échoue (sudo/droits) → non bloquant (note)", async () => {
  const r = await ensureTmux({
    resolve: () => null,
    plan: () => ({ cmd: "apt-get", args: ["install", "-y", "tmux"], needsRoot: true }),
    install: async () => { throw new Error("sudo: a password is required"); },
    notify: () => {},
  });
  assert.equal(r.present, false);
  assert.equal(r.note, "install-failed");
});
