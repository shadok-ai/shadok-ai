import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Le garde tourne 288 fois par jour et par PR ouverte. Ce qui compte n'est pas
// qu'il détecte un changement — c'est qu'il se TAISE le reste du temps :
// la moindre ligne sur stdout réveille l'agent et coûte un tour (invariant 16).
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "context", "tweak-pr-check.sh",
);

/** Lance le garde avec un faux `gh` en tête de PATH et un HOME jetable. */
function runGuard(ghBody: string, home: string, args: string[] = ["7"]) {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\n" + ghBody, { mode: 0o755 });
  const res = execFileSync("sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: bin + ":" + process.env.PATH },
  });
  return res;
}
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "tweakcheck-"));

test("garde: première observation → silence (l'agent vient d'ouvrir la PR)", () => {
  assert.equal(runGuard('echo "OPEN|MERGEABLE||verify=SUCCESS "', tmpHome()), "");
});

test("garde: état inchangé → silence", () => {
  const home = tmpHome();
  const gh = 'echo "OPEN|MERGEABLE||verify=SUCCESS "';
  runGuard(gh, home);
  assert.equal(runGuard(gh, home), "", "un second passage identique doit rester muet");
  assert.equal(runGuard(gh, home), "");
});

test("garde: la CI passe au rouge → une ligne, une seule fois", () => {
  const home = tmpHome();
  runGuard('echo "OPEN|MERGEABLE||verify=SUCCESS "', home);
  const out = runGuard('echo "OPEN|MERGEABLE||verify=FAILURE "', home);
  assert.match(out, /changed/);
  assert.match(out, /FAILURE/);
  assert.match(out, /was:.*SUCCESS/, "le message doit dire d'où l'on vient");
  // Le nouvel état est mémorisé : on ne réalerte pas au créneau suivant.
  assert.equal(runGuard('echo "OPEN|MERGEABLE||verify=FAILURE "', home), "");
});

test("garde: gh en échec → silence et sortie 0, jamais de stderr", () => {
  // Un réseau qui tousse ne doit pas réveiller l'agent toutes les 5 minutes.
  const home = tmpHome();
  runGuard('echo "OPEN|MERGEABLE||verify=SUCCESS "', home);
  assert.equal(runGuard('echo "boom" >&2; exit 1', home), "");
});

test("garde: gh qui répond vide → silence (pas « tout a disparu »)", () => {
  const home = tmpHome();
  runGuard('echo "OPEN|MERGEABLE||verify=SUCCESS "', home);
  assert.equal(runGuard("exit 0", home), "");
});

test("garde: sans argument → silence", () => {
  assert.equal(runGuard('echo "x"', tmpHome(), []), "");
});

test("garde: deux PR ne partagent pas leur état", () => {
  const home = tmpHome();
  runGuard('echo "OPEN|MERGEABLE||a=SUCCESS "', home, ["7"]);
  // La PR 8 n'a jamais été vue : première observation, donc silence — et elle
  // ne doit pas hériter de l'état de la 7.
  assert.equal(runGuard('echo "OPEN|MERGEABLE||a=FAILURE "', home, ["8"]), "");
  assert.equal(runGuard('echo "OPEN|MERGEABLE||a=FAILURE "', home, ["8"]), "");
});
