import assert from "node:assert/strict";
import test from "node:test";
import {
  profileArgs,
  READONLY_DENY,
  envVarsNote,
  DEFAULT_PROFILES,
  permissionModeArgs,
  isPermissionMode,
} from "../src/profiles.js";
import { normalizeVault, secretsFor } from "../src/secrets.js";

test("profileArgs: empty/undefined profile → no extra args", () => {
  assert.deepEqual(profileArgs(null), []);
  assert.deepEqual(profileArgs({ name: "x" }), []);
});

test("permissionModeArgs: a real mode → --permission-mode flag", () => {
  assert.deepEqual(permissionModeArgs("auto"), ["--permission-mode", "auto"]);
  assert.deepEqual(permissionModeArgs("acceptEdits"), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(permissionModeArgs("bypassPermissions"), ["--permission-mode", "bypassPermissions"]);
});

test("permissionModeArgs: default / empty / invalid → no flag", () => {
  assert.deepEqual(permissionModeArgs("default"), []);
  assert.deepEqual(permissionModeArgs(""), []);
  assert.deepEqual(permissionModeArgs(undefined), []);
  assert.deepEqual(permissionModeArgs("garbage"), []);
});

test("isPermissionMode: recognizes the real claude modes + the default sentinel", () => {
  assert.equal(isPermissionMode("auto"), true);
  assert.equal(isPermissionMode("acceptEdits"), true);
  assert.equal(isPermissionMode("manual"), true);
  assert.equal(isPermissionMode("dontAsk"), true);
  assert.equal(isPermissionMode("default"), true);
  assert.equal(isPermissionMode("nope"), false);
});

test("profileArgs: role → --append-system-prompt", () => {
  assert.deepEqual(profileArgs({ name: "m", systemPrompt: "You are marketing." }), [
    "--append-system-prompt",
    "You are marketing.",
  ]);
});

test("profileArgs: deny/allow → valid inline --settings JSON", () => {
  const args = profileArgs({ name: "ro", deny: ["Bash(git commit:*)"], allow: ["Bash(git log:*)"] });
  assert.equal(args[0], "--settings");
  assert.deepEqual(JSON.parse(args[1]), {
    permissions: { deny: ["Bash(git commit:*)"], allow: ["Bash(git log:*)"] },
  });
});

test("profileArgs: model → --model, and order role→settings→model", () => {
  const args = profileArgs({
    name: "p",
    systemPrompt: "role",
    deny: ["Bash(git push:*)"],
    model: "claude-opus-4-8",
  });
  assert.deepEqual(args.slice(0, 1), ["--append-system-prompt"]);
  assert.equal(args[2], "--settings");
  assert.equal(args[args.length - 2], "--model");
  assert.equal(args[args.length - 1], "claude-opus-4-8");
});

test("profileArgs: profile.secrets are references (names), not CLI args", () => {
  // secrets never leak into the argv — they're resolved to env elsewhere.
  const args = profileArgs({ name: "p", secrets: ["META_TOKEN", "DB_URL"] });
  assert.deepEqual(args, []);
});

test("normalizeVault: flattens the old per-repo shape into one map", () => {
  const old = { "/repo/a": { A: "1", B: "2" }, "/repo/b": { C: "3" } };
  assert.deepEqual(normalizeVault(old), { A: "1", B: "2", C: "3" });
});

test("normalizeVault: a flat vault is kept as-is; junk → {}", () => {
  assert.deepEqual(normalizeVault({ A: "1", B: "2" }), { A: "1", B: "2" });
  assert.deepEqual(normalizeVault(null), {});
  assert.deepEqual(normalizeVault([1, 2]), {});
});

test("secretsFor: no names → empty", () => {
  assert.deepEqual(secretsFor(undefined), {});
  assert.deepEqual(secretsFor([]), {});
});

test("READONLY_DENY blocks git writes but not reads", () => {
  assert.ok(READONLY_DENY.includes("Bash(git commit:*)"));
  assert.ok(READONLY_DENY.includes("Bash(git push:*)"));
  assert.ok(!READONLY_DENY.some((d) => d.includes("git log")));
});

test("envVarsNote: lists names, empty for none", () => {
  assert.equal(envVarsNote([]), "");
  const n = envVarsNote(["GOOGLE_ADWORDS", "META_TOKEN"]);
  assert.match(n, /GOOGLE_ADWORDS, META_TOKEN/);
  assert.match(n, /never print or commit/i);
});

test("DEFAULT_PROFILES: dev is unguarded, marketing/support are read-only", () => {
  const by = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.name, p]));
  assert.ok(!by["Shadok-dev"].deny);
  assert.deepEqual(by["Shadok-Marketing"].deny, READONLY_DENY);
  assert.deepEqual(by["Shadok-Support"].deny, READONLY_DENY);
  for (const p of DEFAULT_PROFILES) assert.ok(p.systemPrompt && p.systemPrompt.length > 40);
});
