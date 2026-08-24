import test from "node:test";
import assert from "node:assert/strict";
import { resolveBin, ensureClaude } from "../src/claude-bin.js";

test("resolveBin: trouve un exécutable sur le PATH mocké", () => {
  const exists = (p: string) => p === "/b/claude";
  assert.equal(resolveBin("claude", { PATH: "/a:/b" } as never, exists), "/b/claude");
});

test("resolveBin: absent du PATH → null", () => {
  assert.equal(resolveBin("claude", { PATH: "/a:/b" } as never, () => false), null);
});

test("resolveBin: un chemin explicite est vérifié tel quel", () => {
  assert.equal(
    resolveBin("/usr/local/bin/claude", { PATH: "" } as never, (p) => p === "/usr/local/bin/claude"),
    "/usr/local/bin/claude",
  );
  assert.equal(resolveBin("/nope/claude", { PATH: "" } as never, () => false), null);
});

test("ensureClaude: déjà présent → pas d'install", async () => {
  let installed = false;
  const r = await ensureClaude({
    resolve: () => "/bin/claude",
    install: async () => { installed = true; },
    notify: () => {},
  });
  assert.deepEqual(r, { ok: true, path: "/bin/claude" });
  assert.equal(installed, false);
});

test("ensureClaude: manquant → install → retrouvé → ok", async () => {
  let calls = 0;
  const r = await ensureClaude({
    resolve: () => (calls++ === 0 ? null : "/g/bin/claude"),
    install: async () => {},
    notify: () => {},
  });
  assert.deepEqual(r, { ok: true, path: "/g/bin/claude" });
});

test("ensureClaude: manquant → install → toujours absent → erreur claire", async () => {
  const r = await ensureClaude({ resolve: () => null, install: async () => {}, notify: () => {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /npm i -g @anthropic-ai\/claude-code/);
});

test("ensureClaude: l'install échoue → erreur claire (fallback manuel)", async () => {
  const r = await ensureClaude({
    resolve: () => null,
    install: async () => { throw new Error("EACCES"); },
    notify: () => {},
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /EACCES/);
    assert.match(r.error, /npm i -g @anthropic-ai\/claude-code/);
  }
});
