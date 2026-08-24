import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnHelperPaths, ensureSpawnHelperExecutable } from "../src/node-pty-fix.js";

test("spawnHelperPaths: un chemin par prebuild + le fallback build/Release", () => {
  const paths = spawnHelperPaths("/x/node-pty", () => ["darwin-arm64", "linux-x64"]);
  assert.ok(paths.includes(path.join("/x/node-pty", "prebuilds", "darwin-arm64", "spawn-helper")));
  assert.ok(paths.includes(path.join("/x/node-pty", "prebuilds", "linux-x64", "spawn-helper")));
  assert.ok(paths.includes(path.join("/x/node-pty", "build", "Release", "spawn-helper")));
});

test("spawnHelperPaths: prebuilds absent → juste le fallback, ne jette pas", () => {
  const paths = spawnHelperPaths("/x/node-pty", () => []);
  assert.deepEqual(paths, [path.join("/x/node-pty", "build", "Release", "spawn-helper")]);
});

test("ensureSpawnHelperExecutable: rend un spawn-helper RÉEL exécutable (regression posix_spawnp)", { skip: process.platform === "win32" }, () => {
  const require = createRequire(import.meta.url);
  const root = path.resolve(path.dirname(require.resolve("node-pty")), "..");
  const prebuilds = path.join(root, "prebuilds");
  const dir = fs.readdirSync(prebuilds).find((d) => fs.existsSync(path.join(prebuilds, d, "spawn-helper")));
  assert.ok(dir, "aucun prebuild spawn-helper trouvé dans node-pty");
  const helper = path.join(prebuilds, dir!, "spawn-helper");
  const original = fs.statSync(helper).mode;
  try {
    fs.chmodSync(helper, 0o644); // enlève le bit exécutable (l'état cassé d'une install hoistée)
    assert.equal((fs.statSync(helper).mode & 0o111) !== 0, false);
    ensureSpawnHelperExecutable();
    assert.equal((fs.statSync(helper).mode & 0o111) !== 0, true, "le spawn-helper doit être exécutable après le fix");
  } finally {
    fs.chmodSync(helper, original);
  }
});
