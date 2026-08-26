import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Le pont ESM est DIFFÉRÉ : le <script type="module"> s'exécute APRÈS le parsing,
// alors que le <script> classique — qui câble tous les boutons — tourne PENDANT.
// Un clic dans cet intervalle appelle un window.<fn> qui n'existe pas encore.
// C'est l'invariant 10, et il s'est reproduit : `profileBadges` a planté sur un
// clic Secrets, à cinq lignes d'un appel voisin correctement gardé.
//
// La parade est un bouchon neutre par nom ponté, posé avant tout câblage. Ce
// test verrouille la correspondance : ajouter une fonction au pont sans son
// bouchon casse la CI, pas le navigateur de l'utilisateur.
const HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  "utf8",
);

/** Les noms que le bloc module pose sur window. */
function bridgedNames(html: string): string[] {
  const mod = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(mod, "le bloc <script type=\"module\"> est introuvable");
  return [...mod[1].matchAll(/window\.(\w+)\s*=/g)].map((m) => m[1]).sort();
}

/** Les noms bouchonnés dans le prologue du script classique. */
function stubbedNames(html: string): string[] {
  const table = html.match(/BRIDGE_STUBS = \{([\s\S]*?)\n  \};/);
  assert.ok(table, "la table BRIDGE_STUBS est introuvable dans le script classique");
  return [...table[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
}

test("pont ESM : chaque fonction pontée a un bouchon", () => {
  const bridged = bridgedNames(HTML).filter((n) => /^[a-z]/.test(n));   // les CONSTANTES ne sont pas appelées
  const stubbed = stubbedNames(HTML);
  const missing = bridged.filter((n) => !stubbed.includes(n));
  assert.deepEqual(missing, [], `sans bouchon, un clic avant le chargement du module lève : ${missing.join(", ")}`);
});

test("pont ESM : pas de bouchon orphelin", () => {
  // Un bouchon qui ne correspond à rien masquerait une faute de frappe.
  const bridged = bridgedNames(HTML);
  const orphans = stubbedNames(HTML).filter((n) => !bridged.includes(n));
  assert.deepEqual(orphans, []);
});

test("pont ESM : le module signale son arrivée pour faire repeindre", () => {
  // Un écran peint avec des bouchons est incomplet : il doit être repeint.
  assert.match(HTML, /shadok-bridge-ready/);
});
