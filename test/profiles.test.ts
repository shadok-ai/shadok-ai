import assert from "node:assert/strict";
import test from "node:test";
import {
  profileArgs,
  READONLY_DENY,
  envVarsNote,
  DEFAULT_PROFILES,
  permissionModeArgs,
  isPermissionMode,
  TWEAK_PROFILE_NAME,
  withManagedPrompt,
} from "../src/profiles.js";
import { normalizeVault, secretsFor, secretWriteVerdict } from "../src/secrets.js";

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
  assert.match(n, /never print, log or commit/i);
});

test("envVarsNote: dit qu'elles sont DÉJÀ posées, et qu'il n'y a pas de .env", () => {
  // Ce qui bloquait les agents : ils partaient chercher un fichier à sourcer.
  // La note doit couper court, sinon elle ne sert à rien.
  const n = envVarsNote(["GITHUB_TOKEN"]);
  assert.match(n, /already set/i);
  assert.match(n, /Bash/);
  assert.match(n, /\.env/);
  // Et donner de quoi vérifier la présence SANS révéler la valeur.
  assert.match(n, /-n "\$GITHUB_TOKEN"/);
});

test("DEFAULT_PROFILES: dev is unguarded, boss/marketing/content/support are read-only", () => {
  const by = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.name, p]));
  assert.ok(!by["Shadok-dev"].deny);
  assert.deepEqual(by["Shadok-Boss"].deny, READONLY_DENY);
  assert.deepEqual(by["Shadok-Marketing"].deny, READONLY_DENY);
  assert.deepEqual(by["Shadok-Content"].deny, READONLY_DENY);
  assert.deepEqual(by["Shadok-Support"].deny, READONLY_DENY);
  for (const p of DEFAULT_PROFILES) assert.ok(p.systemPrompt && p.systemPrompt.length > 40);
});

test("DEFAULT_PROFILES: le boss est en tête et sait déléguer avec un profil", () => {
  // En tête parce que c'est la porte d'entrée : première carte de la box.
  assert.equal(DEFAULT_PROFILES[0].name, "Shadok-Boss");
  const boss = DEFAULT_PROFILES[0].systemPrompt!;
  // Un boss qui ne sait pas nommer l'outil de délégation bricole tout seul.
  assert.match(boss, /shadok-ai-agents/);
  assert.match(boss, /--profile/);
  // Les rôles qu'il peut confier doivent exister dans la liste.
  const names = DEFAULT_PROFILES.map((p) => p.name);
  for (const role of ["Shadok-dev", "Shadok-Marketing", "Shadok-Content", "Shadok-Support"]) {
    assert.ok(boss.includes(role), `le boss doit citer ${role}`);
    assert.ok(names.includes(role), `${role} doit exister`);
  }
});

test("withManagedPrompt creates the profile when it does not exist yet", () => {
  const p = withManagedPrompt(undefined, TWEAK_PROFILE_NAME, "role text");
  assert.equal(p.name, TWEAK_PROFILE_NAME);
  assert.equal(p.systemPrompt, "role text");
});

test("withManagedPrompt refreshes ONLY the system prompt", () => {
  // The prompt is server-owned and tracks the repo file, but whatever the user
  // attached in the Profiles editor (a vault secret, a model) is theirs and
  // must survive every boot.
  const existing = {
    name: TWEAK_PROFILE_NAME,
    systemPrompt: "stale text",
    secrets: ["GH_TOKEN"],
    model: "opus",
    deny: ["Bash(rm:*)"],
  };
  const p = withManagedPrompt(existing, TWEAK_PROFILE_NAME, "fresh text");
  assert.equal(p.systemPrompt, "fresh text");
  assert.deepEqual(p.secrets, ["GH_TOKEN"]);
  assert.equal(p.model, "opus");
  assert.deepEqual(p.deny, ["Bash(rm:*)"]);
});

test("withManagedPrompt does not mutate the profile it was given", () => {
  const existing = { name: TWEAK_PROFILE_NAME, systemPrompt: "stale" };
  withManagedPrompt(existing, TWEAK_PROFILE_NAME, "fresh");
  assert.equal(existing.systemPrompt, "stale");
});

test("Shadok-Content: sait qu'il PEUT écrire des fichiers, et se distingue de Marketing", () => {
  const c = DEFAULT_PROFILES.find((p) => p.name === "Shadok-Content")!.systemPrompt!;
  // READONLY_DENY ne bloque que git : sans cette phrase, un agent dont le
  // livrable est un fichier refuse de le créer (cf. la formulation de Marketing).
  assert.match(c, /may write and edit files/i);
  assert.match(c, /git writes are blocked/i);
  // La frontière avec Marketing doit être écrite, sinon le boss choisit au hasard.
  assert.match(c, /Shadok-Marketing owns paid/i);
  // Le livrable est un fichier Markdown avec de quoi le publier.
  assert.match(c, /Markdown file/i);
  assert.match(c, /front matter/i);
});

test("only the boss may answer its children's questions", () => {
  const boss = DEFAULT_PROFILES.find((p) => p.name === "Shadok-Boss");
  assert.equal(boss?.canAnswerChildren, true);
  // The others delegate nothing, and an ambient right would let a read-only
  // profile authorise a child to do what it cannot do itself.
  for (const p of DEFAULT_PROFILES.filter((x) => x.name !== "Shadok-Boss")) {
    assert.notEqual(p.canAnswerChildren, true);
  }
});

test("secretWriteVerdict: a fresh name is always created", () => {
  assert.equal(secretWriteVerdict(false, false), "created");
  assert.equal(secretWriteVerdict(false, true), "created");
});

test("secretWriteVerdict: an existing name needs an explicit overwrite", () => {
  // The one destructive move: replacing a real credential with something else,
  // with nothing on screen to show it happened. A machine must not do it alone.
  assert.equal(secretWriteVerdict(true, false), "refused");
  assert.equal(secretWriteVerdict(true, true), "updated");
});
