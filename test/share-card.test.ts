import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  accentFor,
  cardSvg,
  cardText,
  escapeXml,
  previewMeta,
  renderCard,
  TAGLINE,
  THEME_ACCENTS,
  titleLayout,
} from "../src/share-card.ts";

test("card: an agent link names the agent, with the instance in the eyebrow", () => {
  assert.deepEqual(cardText({ instance: "Nightly Lab", agent: "release" }), { eyebrow: "Shadok-AI · Nightly Lab", title: "release" });
  assert.deepEqual(cardText({ instance: "", agent: "release" }), { eyebrow: "Shadok-AI", title: "release" });
  assert.deepEqual(cardText({ instance: "Nightly Lab" }), { eyebrow: "Shadok-AI", title: "Nightly Lab" });
  assert.deepEqual(cardText({ instance: "" }), { eyebrow: "Shadok-AI", title: "Shadok-AI" });
});

test("card: a hostile name can never close a tag or an attribute", () => {
  const evil = `"><script>alert(1)</script>&'`;
  const svg = cardSvg({ instance: evil, agent: evil });
  assert.doesNotMatch(svg, /<script/);
  assert.equal(escapeXml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  const meta = previewMeta({ instance: evil, agent: evil }, "https://h/share/card.png", "https://h/a/x");
  assert.doesNotMatch(meta, /<script/);
  for (const line of meta.split("\n")) assert.match(line, /^<meta [a-z]+="[^"]+" content="[^"]*">$/);
});

test("card: the title never needs more than two lines, whatever its length", () => {
  for (const name of ["x", "Shadok-dev", "Data & quality team — a very long agent name indeed", "y".repeat(200), "a b ".repeat(80)]) {
    const { size, lines } = titleLayout(name);
    assert.ok(lines.length >= 1 && lines.length <= 2, name);
    // ~0.6 em per character must fit the 610px column.
    for (const l of lines) assert.ok([...l].length * 0.6 * size <= 610, `${name} → ${l} @${size}`);
  }
  assert.deepEqual(titleLayout("Shadok-dev"), { size: 84, lines: ["Shadok-dev"] });
});

test("card: the accent follows the instance theme, default otherwise", () => {
  assert.equal(accentFor(null), "#7b93ff");
  assert.equal(accentFor("nonsense"), "#7b93ff");
  assert.equal(accentFor("azure"), THEME_ACCENTS.azure);
  // Mirrors index.html's palette, so a re-coloured theme cannot drift silently.
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  for (const [k, c] of Object.entries(THEME_ACCENTS)) assert.match(html, new RegExp(`data-theme="${k}"\\]\\s*\\{ --amber: ${c};`));
});

test("meta: absolute image and url, the tagline, never a message", () => {
  const meta = previewMeta({ instance: "Nightly Lab", agent: "release" }, "https://h/share/card.png?a=1", "https://h/a/1");
  assert.match(meta, /og:title" content="release · Shadok-AI · Nightly Lab"/);
  assert.match(meta, /og:image" content="https:\/\/h\/share\/card\.png\?a=1"/);
  assert.match(meta, /twitter:card" content="summary_large_image"/);
  assert.ok(meta.includes(TAGLINE.join(" ")));
});

test("render: a real PNG at 1200×630", async () => {
  const png = await renderCard({ instance: "Nightly Lab", agent: "release", theme: "violet" });
  assert.ok(png, "resvg loads on this platform");
  assert.deepEqual([...png!.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png!.readUInt32BE(16), 1200);
  assert.equal(png!.readUInt32BE(20), 630);
});

test("server: the share routes sit before the gate, and the login page is themed", () => {
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const gate = src.indexOf("// Gate everything else behind the cookie");
  assert.ok(gate > 0);
  for (const r of ['app.get("/a/:id"', 'app.get("/share/card.png"']) {
    const at = src.indexOf(r);
    assert.ok(at > 0 && at < gate, `${r} must be reachable without a session`);
  }
  assert.match(src, /req\.path\.startsWith\("\/fonts\/"\)/, "the login page's font must load without a session");
  // A preview bot may skip a 401 body: the login page answers 200.
  assert.match(src, /sendAuthPage\(res, loginHtml\(\{ \.\.\.brand, agent, meta \}\), 200\)/);
});
