import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NONCE_PLACEHOLDER, cspHeader, injectNonce, injectAssetVersion } from "../src/csp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "..", "public", "index.html");

/** A policy's directives as a map, so one of them can be queried. */
const directives = (policy: string): Record<string, string> =>
  Object.fromEntries(
    policy.split(";").map((d) => {
      const [name, ...rest] = d.trim().split(/\s+/);
      return [name, rest.join(" ")];
    }),
  );

test("script-src carries the nonce and NEVER unsafe-inline", () => {
  // This is THE directive that neutralises an `<img onerror>`: `unsafe-inline`
  // would empty it of all meaning.
  const d = directives(cspHeader("abc123"));
  assert.equal(d["script-src"], "'self' 'nonce-abc123'");
  assert.doesNotMatch(d["script-src"], /unsafe-inline/);
});

test("style-src keeps unsafe-inline, deliberately (style= attributes all over)", () => {
  const d = directives(cspHeader("n"));
  assert.match(d["style-src"], /unsafe-inline/);
});

test("the data-URI favicon stays allowed", () => {
  // The notification pip rewrites the favicon as an SVG data-URI: without
  // `data:` in img-src, no visual notification at all.
  assert.match(directives(cspHeader("n"))["img-src"], /data:/);
});

test("the WebSocket goes through connect-src 'self' (same host, same port)", () => {
  assert.equal(directives(cspHeader("n"))["connect-src"], "'self'");
});

test("nothing to embed, nothing to rewrite, no clickjacking", () => {
  const d = directives(cspHeader("n"));
  assert.equal(d["object-src"], "'none'");
  assert.equal(d["base-uri"], "'none'");
  assert.equal(d["frame-ancestors"], "'none'");
});

test("the nonce is injected everywhere the marker appears", () => {
  const html = `<script nonce="${NONCE_PLACEHOLDER}">a</script><script nonce="${NONCE_PLACEHOLDER}">b</script>`;
  const out = injectNonce(html, "XYZ");
  assert.equal(out, '<script nonce="XYZ">a</script><script nonce="XYZ">b</script>');
  assert.ok(!out.includes(NONCE_PLACEHOLDER));
});

test("a page with no marker passes through untouched", () => {
  assert.equal(injectNonce("<p>rien</p>", "XYZ"), "<p>rien</p>");
});

test("EVERY inline <script> block in index.html carries the marker", () => {
  // The real trap of this CSP: adding an inline block and forgetting the nonce
  // makes it silently dead. This test fails instead of letting it through.
  const html = fs.readFileSync(INDEX, "utf8");
  const opens = html.match(/<script\b[^>]*>/g) ?? [];
  const inline = opens.filter((t) => !/\ssrc=/.test(t));
  assert.ok(inline.length > 0, "index.html must have at least one inline block");
  for (const tag of inline)
    assert.ok(
      tag.includes(NONCE_PLACEHOLDER),
      `inline <script> block without ${NONCE_PLACEHOLDER}: ${tag}`,
    );
});

test("index.html has no inline event handler", () => {
  // The CSP blocks them: a forgotten `onclick=` would raise no build error but
  // would leave the button inert in the browser.
  //
  // We only look at the MARKUP: the JavaScript inside <script> blocks is bound
  // to mention `onerror` and friends (if only while commenting on this very
  // protection), and failing on that would make the test uninterpretable.
  const markup = fs
    .readFileSync(INDEX, "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(markup.match(/\son(?:click|submit|change|input|error|load|keydown)\s*=/gi), null);
});

// ── Les modules ESM sont versionnés dans leur URL ────────────────────────
// index.html est servi par une route dynamique (jamais mis en cache), alors que
// les modules passent par express.static. Un navigateur a donc pu apparier une
// page NEUVE avec un profile-card.js ANCIEN : l'import de `secretUsers` a échoué
// et les 19 fonctions du pont ont disparu d'un coup. Une URL portant la version
// rend l'appariement impossible — une page neuve demande des URL neuves.
test("injectAssetVersion: remplace le marqueur partout", () => {
  const html = 'import a from "/a.js?v=__ASSET_V__"; import b from "/b.js?v=__ASSET_V__";';
  const out = injectAssetVersion(html, "1.2.3");
  assert.equal(out.includes("__ASSET_V__"), false);
  assert.equal((out.match(/\?v=1\.2\.3/g) || []).length, 2);
});

test("injectAssetVersion: une version douteuse est encodée, jamais injectée telle quelle", () => {
  // La version vient du package.json, mais elle finit dans une URL : si elle
  // contenait un guillemet, elle casserait l'import.
  const out = injectAssetVersion('import a from "/a.js?v=__ASSET_V__";', 'x"y z');
  assert.equal(out.includes('"y'), false);
  assert.match(out, /\?v=x%22y%20z/);
});

test("index.html: chaque module importé porte la version", () => {
  const html = fs.readFileSync(INDEX, "utf8");
  const mod = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(mod, "bloc module introuvable");
  const imports = [...mod[1].matchAll(/from "(\/[^"]+\.js[^"]*)"/g)].map((m) => m[1]);
  assert.ok(imports.length >= 5, "on s'attend à plusieurs imports");
  const nus = imports.filter((u) => !u.includes("?v=__ASSET_V__"));
  assert.deepEqual(nus, [], `sans version, ces modules peuvent être servis périmés : ${nus.join(", ")}`);
});
