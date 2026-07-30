import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NONCE_PLACEHOLDER, cspHeader, injectNonce } from "../src/csp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "..", "public", "index.html");

/** Les directives d'une politique, en map, pour interroger l'une d'elles. */
const directives = (policy: string): Record<string, string> =>
  Object.fromEntries(
    policy.split(";").map((d) => {
      const [name, ...rest] = d.trim().split(/\s+/);
      return [name, rest.join(" ")];
    }),
  );

test("script-src porte le nonce et JAMAIS unsafe-inline", () => {
  // C'est LA directive qui neutralise un `<img onerror>` : `unsafe-inline` la
  // viderait entièrement de son sens.
  const d = directives(cspHeader("abc123"));
  assert.equal(d["script-src"], "'self' 'nonce-abc123'");
  assert.doesNotMatch(d["script-src"], /unsafe-inline/);
});

test("style-src garde unsafe-inline, assumé (attributs style= partout)", () => {
  const d = directives(cspHeader("n"));
  assert.match(d["style-src"], /unsafe-inline/);
});

test("le favicon data-URI reste autorisé", () => {
  // Le pip de notification réécrit le favicon en SVG data-URI : sans `data:`
  // dans img-src, plus aucune notification visuelle.
  assert.match(directives(cspHeader("n"))["img-src"], /data:/);
});

test("le WebSocket passe par connect-src 'self' (même hôte, même port)", () => {
  assert.equal(directives(cspHeader("n"))["connect-src"], "'self'");
});

test("rien à embarquer, rien à réécrire, pas de clickjacking", () => {
  const d = directives(cspHeader("n"));
  assert.equal(d["object-src"], "'none'");
  assert.equal(d["base-uri"], "'none'");
  assert.equal(d["frame-ancestors"], "'none'");
});

test("le nonce est injecté partout où le marqueur apparaît", () => {
  const html = `<script nonce="${NONCE_PLACEHOLDER}">a</script><script nonce="${NONCE_PLACEHOLDER}">b</script>`;
  const out = injectNonce(html, "XYZ");
  assert.equal(out, '<script nonce="XYZ">a</script><script nonce="XYZ">b</script>');
  assert.ok(!out.includes(NONCE_PLACEHOLDER));
});

test("une page sans marqueur traverse intacte", () => {
  assert.equal(injectNonce("<p>rien</p>", "XYZ"), "<p>rien</p>");
});

test("CHAQUE bloc <script> inline de index.html porte le marqueur", () => {
  // Le vrai piège de cette CSP : ajouter un bloc inline en oubliant le nonce le
  // rend silencieusement mort. Ce test échoue alors au lieu de laisser passer.
  const html = fs.readFileSync(INDEX, "utf8");
  const opens = html.match(/<script\b[^>]*>/g) ?? [];
  const inline = opens.filter((t) => !/\ssrc=/.test(t));
  assert.ok(inline.length > 0, "index.html doit avoir au moins un bloc inline");
  for (const tag of inline)
    assert.ok(
      tag.includes(NONCE_PLACEHOLDER),
      `bloc <script> inline sans ${NONCE_PLACEHOLDER} : ${tag}`,
    );
});

test("index.html n'a aucun gestionnaire d'événement inline", () => {
  // La CSP les bloque : un `onclick=` oublié ne lèverait aucune erreur de build
  // mais rendrait le bouton inerte dans le navigateur.
  //
  // On ne regarde que le BALISAGE : le JavaScript des blocs <script> parle
  // forcément d'`onerror` et consorts (ne serait-ce qu'en commentant cette
  // protection), et le faire échouer là-dessus rendrait le test ininterprétable.
  const markup = fs
    .readFileSync(INDEX, "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(markup.match(/\son(?:click|submit|change|input|error|load|keydown)\s*=/gi), null);
});
