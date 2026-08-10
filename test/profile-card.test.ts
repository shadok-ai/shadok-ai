import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { READONLY_DENY } from "../src/profiles.js";
import {
  profileBlurb,
  profileBadges,
  defaultAgentName,
  hasReadonlyPreset,
  applyReadonlyPreset,
} from "../public/profile-card.js";

test("blurb: garde la 1re phrase et retire l'amorce « You are <nom>, »", () => {
  const p = {
    name: "Shadok-Marketing",
    systemPrompt:
      "You are Shadok-Marketing, the paid-marketing & growth agent. Read the product's code, docs and site to understand exactly what it does.",
  };
  assert.equal(profileBlurb(p), "the paid-marketing & growth agent.");
});

test("blurb: un nom à tiret n'est pas coupé en deux", () => {
  const p = {
    name: "Shadok-dev",
    systemPrompt:
      "You are Shadok-dev, a senior software engineer on this project. Make small, well-tested changes.",
  };
  assert.equal(profileBlurb(p), "a senior software engineer on this project.");
});

test("blurb: pas de systemPrompt → chaîne vide", () => {
  assert.equal(profileBlurb({ name: "x" }), "");
  assert.equal(profileBlurb({ name: "x", systemPrompt: "   " }), "");
  assert.equal(profileBlurb(null), "");
});

test("blurb: prompt sans point final → tout le texte, tronqué si besoin", () => {
  assert.equal(profileBlurb({ name: "x", systemPrompt: "just a role" }), "just a role");
});

test("blurb: phrase trop longue → troncature sur une frontière de mot", () => {
  const long = "You are Bob, " + "alpha ".repeat(30).trim() + ".";
  const out = profileBlurb({ name: "Bob", systemPrompt: long });
  assert.ok(out.endsWith("…"), "doit finir par une ellipse");
  assert.ok(out.length <= 91, "90 caractères + l'ellipse");
  assert.ok(!out.slice(0, -1).endsWith(" "), "pas d'espace avant l'ellipse");
  assert.ok(out.startsWith("alpha alpha"), "l'amorce est retirée");
});

test("badges: accès — full access (✏️) vs read-only (🔒), chacun avec une explication", () => {
  const full = profileBadges({ name: "x" });
  assert.equal(full[0].label, "full access");
  assert.equal(full[0].icon, "✏️");
  assert.match(full[0].title, /committer|modifier/i);
  assert.deepEqual(profileBadges({ name: "x", deny: [] })[0].label, "full access");
  const ro = profileBadges({ name: "x", deny: ["Bash(git commit:*)"] });
  assert.equal(ro[0].label, "read-only");
  assert.equal(ro[0].icon, "🔒");
  assert.match(ro[0].title, /bloqu/i);
});

test("badges: modèle et secrets, dans l'ordre accès → modèle → secrets", () => {
  const b = profileBadges({ name: "x", deny: ["Bash(git push:*)"], model: "opus", secrets: ["A", "B"] });
  assert.deepEqual(b.map((x) => x.label), ["read-only", "opus", "2 secrets"]);
  assert.equal(b[2].icon, "🔑");
  assert.match(b[2].title, /secret/i);
});

test("badges: un seul secret est au singulier", () => {
  assert.deepEqual(profileBadges({ name: "x", secrets: ["A"] }).map((x) => x.label), ["full access", "1 secret"]);
});

test("badges: profil vide ne casse pas", () => {
  assert.equal(profileBadges(null)[0].label, "full access");
});

test("defaultAgentName: un profil choisi donne son nom à l'agent", () => {
  assert.equal(defaultAgentName("Shadok-dev", "/Users/a/projects/shadok-ai"), "Shadok-dev");
  assert.equal(defaultAgentName("Shadok-Boss", ""), "Shadok-Boss");
});

test("defaultAgentName: sans profil, on retombe sur le dossier", () => {
  assert.equal(defaultAgentName("", "/Users/a/projects/shadok-ai"), "shadok-ai");
  assert.equal(defaultAgentName(null, "/Users/a/projects/biosense/"), "biosense");
});

test("defaultAgentName: ni profil ni dossier → un nom quand même", () => {
  // Un onglet sans nom est illisible dans la colonne : jamais de chaîne vide.
  assert.equal(defaultAgentName("", ""), "agent");
  assert.equal(defaultAgentName(null, null), "agent");
  assert.equal(defaultAgentName(undefined, undefined), "agent");
});

test("defaultAgentName: les espaces autour ne comptent pas", () => {
  assert.equal(defaultAgentName("  Shadok-dev  ", "/x/y"), "Shadok-dev");
  assert.equal(defaultAgentName("   ", "/x/y"), "y");
});

// ── La case « read-only » du formulaire de profil ────────────────────────
const PRESET = [
  "Bash(git commit:*)", "Bash(git push:*)", "Bash(git add:*)", "Bash(git reset:*)",
  "Bash(git rebase:*)", "Bash(git merge:*)", "Bash(git checkout:*)",
];

test("hasReadonlyPreset: cochée seulement si TOUT le preset est là", () => {
  assert.equal(hasReadonlyPreset(PRESET, PRESET), true);
  assert.equal(hasReadonlyPreset([...PRESET, "Bash(rm:*)"], PRESET), true, "un motif perso en plus ne décoche pas");
  assert.equal(hasReadonlyPreset(PRESET.slice(0, 3), PRESET), false, "preset partiel");
  assert.equal(hasReadonlyPreset([], PRESET), false);
  assert.equal(hasReadonlyPreset(["Bash(rm:*)"], PRESET), false, "des garde-fous, mais pas CE preset");
});

test("applyReadonlyPreset: décocher n'enlève que le preset, jamais le perso", () => {
  const before = [...PRESET, "Bash(rm:*)", "Read(/etc/**)"];
  assert.deepEqual(applyReadonlyPreset(before, false, PRESET), ["Bash(rm:*)", "Read(/etc/**)"]);
});

test("applyReadonlyPreset: cocher ajoute ce qui manque et garde l'ordre existant", () => {
  const before = ["Bash(rm:*)", "Bash(git commit:*)"];
  const after = applyReadonlyPreset(before, true, PRESET);
  assert.equal(after[0], "Bash(rm:*)", "le perso reste en tête");
  for (const p of PRESET) assert.ok(after.includes(p), `${p} doit être présent`);
  assert.equal(after.filter((x) => x === "Bash(git commit:*)").length, 1, "pas de doublon");
});

test("applyReadonlyPreset: cocher deux fois ne change rien la seconde", () => {
  const once = applyReadonlyPreset(["Bash(rm:*)"], true, PRESET);
  assert.deepEqual(applyReadonlyPreset(once, true, PRESET), once);
});

test("applyReadonlyPreset: décocher un profil sans preset ne casse rien", () => {
  assert.deepEqual(applyReadonlyPreset([], false, PRESET), []);
  assert.deepEqual(applyReadonlyPreset(["Bash(rm:*)"], false, PRESET), ["Bash(rm:*)"]);
});

test("le preset du client ne doit pas dériver de celui du serveur", () => {
  // Il est dupliqué dans index.html (le navigateur ne peut pas importer le TS).
  // Sans ce garde, une modif de READONLY_DENY côté serveur laisserait la case du
  // formulaire poser des garde-fous périmés, en silence.
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const m = html.match(/const READONLY_DENY = (\[[^\]]*\]);/);
  assert.ok(m, "READONLY_DENY introuvable dans index.html");
  assert.deepEqual(JSON.parse(m![1]), READONLY_DENY);
});
