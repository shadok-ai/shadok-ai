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
  promptOrigin,
  promptEditVerdict,
  BOSS_PROFILE_NAME,
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

test("envVarsNote: says they are ALREADY set, and that there is no .env", () => {
  // What blocked agents: they went hunting for a file to source. The note has
  // to head that off, otherwise it serves no purpose.
  const n = envVarsNote(["GITHUB_TOKEN"]);
  assert.match(n, /already set/i);
  assert.match(n, /Bash/);
  assert.match(n, /\.env/);
  // And give a way to check presence WITHOUT revealing the value.
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

test("DEFAULT_PROFILES: the boss comes first and knows how to delegate with a profile", () => {
  // First because it is the way in: the first card in the box.
  assert.equal(DEFAULT_PROFILES[0].name, "Shadok-Boss");
  const boss = DEFAULT_PROFILES[0].systemPrompt!;
  // A boss that cannot name the delegation tool ends up doing it all itself.
  assert.match(boss, /shadok-ai-agents/);
  assert.match(boss, /--profile/);
  // The roles it can hand work to must exist in the list.
  const names = DEFAULT_PROFILES.map((p) => p.name);
  for (const role of ["Shadok-dev", "Shadok-Marketing", "Shadok-Content", "Shadok-Support"]) {
    assert.ok(boss.includes(role), `the boss must mention ${role}`);
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

test("Shadok-Content: knows it MAY write files, and is distinct from Marketing", () => {
  const c = DEFAULT_PROFILES.find((p) => p.name === "Shadok-Content")!.systemPrompt!;
  // READONLY_DENY blocks git only: without this sentence, an agent whose
  // deliverable is a file refuses to create it (see Marketing's wording).
  assert.match(c, /may write and edit files/i);
  assert.match(c, /git writes are blocked/i);
  // The boundary with Marketing must be written down, or the boss picks at random.
  assert.match(c, /Shadok-Marketing owns paid/i);
  // The deliverable is a Markdown file with what it takes to publish it.
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

// ── Who may rewrite which profile's prompt ───────────────────────────────
const edit = (o: Parameters<typeof promptEditVerdict>[0]) => promptEditVerdict(o);

test("promptEdit: an agent rewrites ITS prompt, and only its own", () => {
  assert.deepEqual(
    edit({ caller: "Shadok-Content", target: "Shadok-Content", targetExists: true, managed: false }),
    { ok: true, create: false },
  );
  const other = edit({ caller: "Shadok-Content", target: "Shadok-dev", targetExists: true, managed: false });
  assert.equal(other.ok, false);
  assert.match((other as { error: string }).error, /own profile/i);
});

test("promptEdit: the boss rewrites any prompt and may create one", () => {
  assert.deepEqual(
    edit({ caller: BOSS_PROFILE_NAME, target: "Shadok-dev", targetExists: true, managed: false }),
    { ok: true, create: false },
  );
  assert.deepEqual(
    edit({ caller: BOSS_PROFILE_NAME, target: "Shadok-SEO", targetExists: false, managed: false }),
    { ok: true, create: true },
  );
});

test("promptEdit: creating is reserved to the boss", () => {
  const v = edit({ caller: "Shadok-dev", target: "Shadok-Nouveau", targetExists: false, managed: false });
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /own profile/i);
});

test("promptEdit: an agent with no profile has nothing to edit", () => {
  const v = edit({ caller: null, target: "Shadok-dev", targetExists: true, managed: false });
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /no profile/i);
});

test("promptEdit: a server-managed prompt is refused, not swallowed", () => {
  // Shadok-Tweak is refreshed from context/tweak-prompt.md at every boot:
  // accepting the edit would make it vanish at the next restart, without a word.
  for (const caller of [BOSS_PROFILE_NAME, TWEAK_PROFILE_NAME]) {
    const v = edit({ caller, target: TWEAK_PROFILE_NAME, targetExists: true, managed: true });
    assert.equal(v.ok, false, `${caller} must not be able to edit a managed prompt`);
    assert.match((v as { error: string }).error, /tweak-prompt\.md/);
  }
});

test("promptEdit: an empty profile name is refused", () => {
  const v = edit({ caller: BOSS_PROFILE_NAME, target: "  ", targetExists: false, managed: false });
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /name required/i);
});

// ── Dérive d'un profil livré par rapport au build ────────────────────────
test("promptOrigin: un profil livré et intact", () => {
  assert.equal(promptOrigin({ name: "Shadok-dev", systemPrompt: "A" }, { name: "Shadok-dev", systemPrompt: "A" }), "stock");
});

test("promptOrigin: les espaces de bord ne comptent pas pour une dérive", () => {
  // Sinon un simple retour à la ligne ajouté par un éditeur crierait « modifié ».
  assert.equal(promptOrigin({ name: "d", systemPrompt: "  A\n" }, { name: "d", systemPrompt: "A" }), "stock");
});

test("promptOrigin: un profil livré dont le prompt a été réécrit", () => {
  assert.equal(promptOrigin({ name: "d", systemPrompt: "mien" }, { name: "d", systemPrompt: "livré" }), "edited");
});

test("promptOrigin: un profil que le build ne connaît pas est le tien", () => {
  // Aucun « restaurer » possible : il n'y a pas d'original.
  assert.equal(promptOrigin({ name: "ZZ", systemPrompt: "x" }, undefined), "custom");
});

test("promptOrigin: un profil livré vidé de son prompt reste une édition", () => {
  assert.equal(promptOrigin({ name: "d" }, { name: "d", systemPrompt: "livré" }), "edited");
});

test("restauration: seul le prompt revient, les garde-fous restent", () => {
  // Le champ deny/secrets/model appartient à l'utilisateur — restaurer le texte
  // ne doit pas lui reprendre ce qu'il a attaché. Même règle que Shadok-Tweak.
  const mine = { name: "d", systemPrompt: "mien", deny: ["Bash(git push:*)"], secrets: ["K"], model: "opus" };
  const shipped = { name: "d", systemPrompt: "livré" };
  const out = withManagedPrompt(mine, "d", shipped.systemPrompt!);
  assert.equal(out.systemPrompt, "livré");
  assert.deepEqual(out.deny, ["Bash(git push:*)"]);
  assert.deepEqual(out.secrets, ["K"]);
  assert.equal(out.model, "opus");
});
