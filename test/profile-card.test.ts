import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { READONLY_DENY } from "../src/profiles.js";
import {
  profileBlurb,
  profileBadges,
  defaultAgentName,
  secretUsers,
  profileSaveBody,
  isManagedProfile,
  hasReadonlyPreset,
  applyReadonlyPreset,
} from "../public/profile-card.js";

test("blurb: keeps the 1st sentence and drops the 'You are <name>,' opener", () => {
  const p = {
    name: "Shadok-Marketing",
    systemPrompt:
      "You are Shadok-Marketing, the paid-marketing & growth agent. Read the product's code, docs and site to understand exactly what it does.",
  };
  assert.equal(profileBlurb(p), "the paid-marketing & growth agent.");
});

test("blurb: a hyphenated name is not cut in two", () => {
  const p = {
    name: "Shadok-dev",
    systemPrompt:
      "You are Shadok-dev, a senior software engineer on this project. Make small, well-tested changes.",
  };
  assert.equal(profileBlurb(p), "a senior software engineer on this project.");
});

test("blurb: no systemPrompt → empty string", () => {
  assert.equal(profileBlurb({ name: "x" }), "");
  assert.equal(profileBlurb({ name: "x", systemPrompt: "   " }), "");
  assert.equal(profileBlurb(null), "");
});

test("blurb: a prompt with no full stop → the whole text, truncated if needed", () => {
  assert.equal(profileBlurb({ name: "x", systemPrompt: "just a role" }), "just a role");
});

test("blurb: too long a sentence → truncation on a word boundary", () => {
  const long = "You are Bob, " + "alpha ".repeat(30).trim() + ".";
  const out = profileBlurb({ name: "Bob", systemPrompt: long });
  assert.ok(out.endsWith("…"), "must end with an ellipsis");
  assert.ok(out.length <= 91, "90 characters + the ellipsis");
  assert.ok(!out.slice(0, -1).endsWith(" "), "pas d'espace avant l'ellipse");
  assert.ok(out.startsWith("alpha alpha"), "the opener is dropped");
});

test("badges: access — full access (✏️) vs read-only (🔒), each with an explanation", () => {
  const full = profileBadges({ name: "x" });
  assert.equal(full[0].label, "full access");
  assert.equal(full[0].icon, "✏️");
  assert.match(full[0].title, /commit|change/i);
  assert.deepEqual(profileBadges({ name: "x", deny: [] })[0].label, "full access");
  const ro = profileBadges({ name: "x", deny: ["Bash(git commit:*)"] });
  assert.equal(ro[0].label, "read-only");
  assert.equal(ro[0].icon, "🔒");
  assert.match(ro[0].title, /blocked/i);
});

test("badges: a source-write guardrail is not a git guardrail", () => {
  // Shadok-QA is the first shipped role whose deny blocks FILES and not git:
  // it may commit, and its whole point is that it writes tests. The badge used
  // to light up "read-only — git writes blocked" on any deny at all, which
  // would have described that card with two falsehoods at once.
  const qa = profileBadges({ name: "x", deny: ["Write(src/**)", "Edit(src/**)"] });
  assert.notEqual(qa[0].label, "read-only");
  assert.match(qa[0].label, /source/i);
  assert.doesNotMatch(qa[0].title, /git writes blocked/i);
});

test("badges: blocking both the files and git reads as read-only, and says so", () => {
  // Shadok-Release: it runs the deployment path and changes nothing. "Git
  // writes blocked" alone would undersell it — the file tools are blocked too.
  const rel = profileBadges({ name: "x", deny: ["Bash(git push:*)", "Write", "Edit"] });
  assert.equal(rel[0].label, "read-only");
  assert.match(rel[0].title, /cannot edit|file edits|edit files/i);
  assert.match(rel[0].title, /commit/i);
});

test("badges: blocking the SOURCE and git is not blocking everything", () => {
  // Shadok-Product: git blocked like Shadok-Content, plus the source. Its
  // document IS the deliverable, so a card reading "changes nothing" would
  // describe the one thing this role exists to produce as impossible — the
  // same wording trap Shadok-Content's prompt documents.
  const prod = profileBadges({ name: "x", deny: ["Bash(git commit:*)", "Write(src/**)", "Edit(src/**)"] });
  assert.notEqual(prod[0].label, "read-only");
  assert.match(prod[0].title, /write/i);
  assert.match(prod[0].title, /commit/i, "the other half of its guardrails must still be said");
});

test("badges: a deny we cannot read is neither full access nor a git claim", () => {
  // A custom pattern the user wrote. Announcing "full access" over a guardrail
  // is one mistake; naming a restriction we never read is the other.
  const b = profileBadges({ name: "x", deny: ["Bash(rm:*)"] });
  assert.equal(b[0].label, "guarded");
  assert.doesNotMatch(b[0].title, /git/i);
});

test("badges: model and secrets, in the order access → model → secrets", () => {
  const b = profileBadges({ name: "x", deny: ["Bash(git push:*)"], model: "opus", secrets: ["A", "B"] });
  assert.deepEqual(b.map((x) => x.label), ["read-only", "opus", "2 secrets"]);
  assert.equal(b[2].icon, "🔑");
  assert.match(b[2].title, /secret/i);
});

test("badges: a single secret is singular", () => {
  assert.deepEqual(profileBadges({ name: "x", secrets: ["A"] }).map((x) => x.label), ["full access", "1 secret"]);
});

test("badges: profil vide ne casse pas", () => {
  assert.equal(profileBadges(null)[0].label, "full access");
});

test("defaultAgentName: a chosen profile gives the agent its name", () => {
  assert.equal(defaultAgentName("Shadok-dev", "/Users/a/projects/shadok-ai"), "Shadok-dev");
  assert.equal(defaultAgentName("Shadok-Boss", ""), "Shadok-Boss");
});

test("defaultAgentName: with no profile, we fall back to the directory", () => {
  assert.equal(defaultAgentName("", "/Users/a/projects/shadok-ai"), "shadok-ai");
  assert.equal(defaultAgentName(null, "/Users/a/projects/storefront/"), "storefront"); // trailing slash
});

test("defaultAgentName: neither profile nor directory → a name all the same", () => {
  // An unnamed tab is unreadable in the column: never an empty string.
  assert.equal(defaultAgentName("", ""), "agent");
  assert.equal(defaultAgentName(null, null), "agent");
  assert.equal(defaultAgentName(undefined, undefined), "agent");
});

test("defaultAgentName: surrounding whitespace does not count", () => {
  assert.equal(defaultAgentName("  Shadok-dev  ", "/x/y"), "Shadok-dev");
  assert.equal(defaultAgentName("   ", "/x/y"), "y");
});

// ── The profile form's "read-only" checkbox ──────────────────────────────
const PRESET = [
  "Bash(git commit:*)", "Bash(git push:*)", "Bash(git add:*)", "Bash(git reset:*)",
  "Bash(git rebase:*)", "Bash(git merge:*)", "Bash(git checkout:*)",
];

test("hasReadonlyPreset: ticked only when the WHOLE preset is there", () => {
  assert.equal(hasReadonlyPreset(PRESET, PRESET), true);
  assert.equal(hasReadonlyPreset([...PRESET, "Bash(rm:*)"], PRESET), true, "an extra custom pattern does not untick it");
  assert.equal(hasReadonlyPreset(PRESET.slice(0, 3), PRESET), false, "preset partiel");
  assert.equal(hasReadonlyPreset([], PRESET), false);
  assert.equal(hasReadonlyPreset(["Bash(rm:*)"], PRESET), false, "guardrails, but not THIS preset");
});

test("applyReadonlyPreset: unticking removes the preset only, never custom patterns", () => {
  const before = [...PRESET, "Bash(rm:*)", "Read(/etc/**)"];
  assert.deepEqual(applyReadonlyPreset(before, false, PRESET), ["Bash(rm:*)", "Read(/etc/**)"]);
});

test("applyReadonlyPreset: ticking adds what is missing and keeps the existing order", () => {
  const before = ["Bash(rm:*)", "Bash(git commit:*)"];
  const after = applyReadonlyPreset(before, true, PRESET);
  assert.equal(after[0], "Bash(rm:*)", "the custom pattern stays first");
  for (const p of PRESET) assert.ok(after.includes(p), `${p} must be present`);
  assert.equal(after.filter((x) => x === "Bash(git commit:*)").length, 1, "pas de doublon");
});

test("applyReadonlyPreset: ticking twice changes nothing the second time", () => {
  const once = applyReadonlyPreset(["Bash(rm:*)"], true, PRESET);
  assert.deepEqual(applyReadonlyPreset(once, true, PRESET), once);
});

test("applyReadonlyPreset: unticking a profile with no preset breaks nothing", () => {
  assert.deepEqual(applyReadonlyPreset([], false, PRESET), []);
  assert.deepEqual(applyReadonlyPreset(["Bash(rm:*)"], false, PRESET), ["Bash(rm:*)"]);
});

test("the client's preset must not drift from the server's", () => {
  // It is duplicated in index.html (the browser cannot import the TS). Without
  // this guard, a change to READONLY_DENY server-side would leave the form's
  // checkbox setting stale guardrails, silently.
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const m = html.match(/const READONLY_DENY = (\[[^\]]*\]);/);
  assert.ok(m, "READONLY_DENY not found in index.html");
  assert.deepEqual(JSON.parse(m![1]), READONLY_DENY);
});

test("isManagedProfile: the server-driven role is recognised", () => {
  // Shadok-Tweak takes its prompt from context/tweak-prompt.md at every boot and
  // has its own CTA: it has no business in a list where one PICKS a role.
  assert.equal(isManagedProfile("Shadok-Tweak"), true);
  assert.equal(isManagedProfile("  Shadok-Tweak  "), true);
});

test("isManagedProfile: everything else is pickable", () => {
  for (const n of ["Shadok-Boss", "Shadok-dev", "shadok-tweak", "", null, undefined])
    assert.equal(isManagedProfile(n), false, String(n));
});

// ── Ce qu'un enregistrement du panneau doit envoyer ──────────────────────
test("saveBody: un profil SUIVI n'envoie pas de prompt", () => {
  // Le champ est rempli avec le texte du build pour qu'on le VOIE. L'envoyer
  // l'épinglerait : le rôle cesserait de suivre les évolutions du dépôt.
  const b = profileSaveBody({ name: "Shadok-dev", prompt: "texte du build", deny: [], model: "" }, { tracked: true, forked: false });
  assert.equal("systemPrompt" in b, false);
  assert.equal(b.name, "Shadok-dev");
});

test("saveBody: suivi mais explicitement bifurqué → le prompt part", () => {
  const b = profileSaveBody({ name: "d", prompt: "le mien", deny: [], model: "" }, { tracked: true, forked: true });
  assert.equal(b.systemPrompt, "le mien");
});

test("saveBody: un profil déjà édité envoie toujours son prompt", () => {
  const b = profileSaveBody({ name: "d", prompt: "le mien", deny: [], model: "" }, { tracked: false, forked: false });
  assert.equal(b.systemPrompt, "le mien");
});

test("saveBody: un champ vidé sur un profil suivi ne vide pas le rôle", () => {
  // Le bug qui a coûté quatre prompts : « Save » sur un formulaire vide
  // enregistrait systemPrompt:"" et l'agent démarrait sans rôle.
  const b = profileSaveBody({ name: "d", prompt: "", deny: [], model: "" }, { tracked: true, forked: false });
  assert.equal("systemPrompt" in b, false);
});

test("saveBody: les autres champs passent toujours", () => {
  const b = profileSaveBody({ name: "d", prompt: "x", deny: ["Bash(git push:*)"], model: "opus", secrets: ["K"] }, { tracked: true, forked: false });
  assert.deepEqual(b.deny, ["Bash(git push:*)"]);
  assert.equal(b.model, "opus");
  assert.deepEqual(b.secrets, ["K"]);
});

// ── Qui utilise un secret du coffre ─────────────────────────────────────
const VAULT_PROFILES = [
  { name: "Shadok-Marketing", secrets: ["GOOGLE_ADWORDS", "GA4"] },
  { name: "Shadok-Content", secrets: ["GA4"] },
  { name: "Shadok-dev" },                                  // pas de clé `secrets`
  { name: "Shadok-Support", secrets: [] },
  { name: "Shadok-Tweak", secrets: ["GH_TOKEN"] },         // masqué du panneau
];

test("secretUsers: les profils qui référencent un secret, triés", () => {
  assert.deepEqual(secretUsers(VAULT_PROFILES, "GA4"), ["Shadok-Content", "Shadok-Marketing"]);
  assert.deepEqual(secretUsers(VAULT_PROFILES, "GOOGLE_ADWORDS"), ["Shadok-Marketing"]);
});

test("secretUsers: un secret que personne ne référence", () => {
  assert.deepEqual(secretUsers(VAULT_PROFILES, "ORPHELIN"), []);
});

test("secretUsers: un rôle MASQUÉ du panneau compte quand même", () => {
  // Shadok-Tweak n'apparaît pas dans la liste des profils, mais il reçoit bien
  // le secret : l'annoncer « inutilisé » serait faux.
  assert.deepEqual(secretUsers(VAULT_PROFILES, "GH_TOKEN"), ["Shadok-Tweak"]);
});

test("secretUsers: entrées bancales ignorées, pas de plantage", () => {
  assert.deepEqual(secretUsers([null, { secrets: ["X"] }, { name: "OK", secrets: ["X"] }], "X"), ["OK"]);
  assert.deepEqual(secretUsers(null, "X"), []);
});
