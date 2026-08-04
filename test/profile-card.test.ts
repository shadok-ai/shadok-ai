import assert from "node:assert/strict";
import test from "node:test";
import { profileBlurb, profileBadges, defaultAgentName } from "../public/profile-card.js";

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
