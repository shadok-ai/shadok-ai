import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "..", "public", "index.html");

/**
 * Le regroupement des labels du transcript est du CSS pur, donc invérifiable
 * ici — la vraie preuve est une vérif navigateur (style calculé). Ce test tient
 * la seule chose qu'un fichier texte permette de tenir : que la règle n'oublie
 * pas d'exclure les tours SANS label.
 *
 * Pourquoi ça mérite un test : la règle masque le label d'un `.turn.claude` qui
 * en suit un autre, pour n'afficher qu'un « claude · 21:57 » par prise de
 * parole. Mais un bloc d'activité et l'aperçu provisoire sont eux aussi des
 * `.turn.claude`, et n'affichent aucun label. Les compter fait absorber le label
 * de la réponse par un tour qui n'en montre pas — et comme l'agent utilise
 * presque toujours un outil avant d'écrire, sa réponse perdait son heure dans le
 * cas le plus courant. Régression déjà vécue une fois.
 */
const LABEL_RULE = /([^{}]*)>\s*\.label,[\s\S]*?\{\s*display:\s*none/;

test("la règle de regroupement n'est ouverte que par des tours qui affichent un label", () => {
  const css = fs.readFileSync(INDEX, "utf8");
  const m = LABEL_RULE.exec(css);
  assert.ok(m, "règle de masquage des labels introuvable — a-t-elle été renommée ?");
  const selector = m[1];
  for (const labelless of ["activity", "live-preview"])
    assert.match(
      selector,
      new RegExp(`:not\\(\\.${labelless}\\)`),
      `un .turn.claude.${labelless} n'affiche aucun label : il ne doit pas masquer celui du tour suivant`,
    );
});
