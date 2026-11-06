import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installArgs, rebuildArgs, needsNativeRebuild, SCRIPT_ALLOWLIST, installInto,
} from "../src/updater.js";

const ROOT = path.resolve(import.meta.dirname, "..");

test("the auto-update installs an exact version with lifecycle scripts OFF", () => {
  const a = installArgs("0.17.4", "/app");
  assert.deepEqual(a.slice(0, 2), ["install", "shadok-ai@0.17.4"]);
  assert.ok(a.includes("--ignore-scripts"), "a compromised transitive dep must not run code at install");
  assert.deepEqual(a.slice(a.indexOf("--prefix"), a.indexOf("--prefix") + 2), ["--prefix", "/app"]);
});

test("only the allowlisted native package gets its scripts back, explicitly", () => {
  assert.deepEqual(SCRIPT_ALLOWLIST, ["node-pty"]);
  const r = rebuildArgs("/app");
  assert.deepEqual(r.slice(0, 2), ["rebuild", "node-pty"]);
  assert.ok(r.includes("--ignore-scripts=false"), "an npmrc ignore-scripts must not silently skip the build");
});

test("node-pty is rebuilt only when its native module is absent", () => {
  const app = "/app";
  const hoisted = path.join(app, "node_modules", "node-pty");
  const nested = path.join(app, "node_modules", "shadok-ai", "node_modules", "node-pty");
  const has = (files: string[]) => (p: string) => files.includes(p);
  // Not installed at all: nothing to rebuild (and rebuilding would not help).
  assert.equal(needsNativeRebuild(app, "linux", "x64", has([])), false);
  // Installed, no Linux prebuild, no build: rebuild.
  assert.equal(needsNativeRebuild(app, "linux", "x64", has([path.join(hoisted, "package.json")])), true);
  // Already built (an unchanged node-pty survives the update): no rebuild.
  assert.equal(needsNativeRebuild(app, "linux", "x64",
    has([path.join(hoisted, "package.json"), path.join(hoisted, "build", "Release", "pty.node")])), false);
  // macOS ships a prebuild: no compiler needed, exactly as before.
  assert.equal(needsNativeRebuild(app, "darwin", "arm64",
    has([path.join(hoisted, "package.json"), path.join(hoisted, "prebuilds", "darwin-arm64", "pty.node")])), false);
  // A nested copy (shrinkwrap placement) counts too.
  assert.equal(needsNativeRebuild(app, "linux", "x64", has([path.join(nested, "package.json")])), true);
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "updater-install-"));
}

/** A fake npm: `install` writes the package, `rebuild` writes pty.node. */
function fakeNpm(calls: string[][], opts: { buildFails?: boolean; installFails?: boolean } = {}) {
  return async (args: string[]): Promise<void> => {
    calls.push(args);
    const prefix = args[args.indexOf("--prefix") + 1];
    const pty = path.join(prefix, "node_modules", "node-pty");
    if (args[0] === "install") {
      if (opts.installFails) throw new Error("npm install failed");
      const v = args[1].split("@")[1];
      fs.mkdirSync(path.join(prefix, "node_modules", "shadok-ai"), { recursive: true });
      fs.writeFileSync(path.join(prefix, "node_modules", "shadok-ai", "package.json"), JSON.stringify({ version: v }));
      fs.rmSync(pty, { recursive: true, force: true }); // a node-pty bump: fresh, unbuilt
      fs.mkdirSync(pty, { recursive: true });
      fs.writeFileSync(path.join(pty, "package.json"), "{}");
    } else if (args[0] === "rebuild") {
      if (opts.buildFails) throw new Error("node-gyp failed");
      fs.mkdirSync(path.join(pty, "build", "Release"), { recursive: true });
      fs.writeFileSync(path.join(pty, "build", "Release", "pty.node"), "elf");
    }
  };
}

const ver = (app: string) =>
  JSON.parse(fs.readFileSync(path.join(app, "node_modules", "shadok-ai", "package.json"), "utf8")).version;

test("an update is installed in a staging copy and swapped in only once complete", async () => {
  const d = tmp();
  try {
    const app = path.join(d, "app");
    await installInto(app, "0.1.0", { npm: fakeNpm([]), platform: "linux", arch: "x64" });
    const calls: string[][] = [];
    await installInto(app, "0.2.0", { npm: fakeNpm(calls), platform: "linux", arch: "x64" });
    assert.equal(ver(app), "0.2.0");
    assert.ok(fs.existsSync(path.join(app, "node_modules", "node-pty", "build", "Release", "pty.node")));
    assert.deepEqual(calls.map((c) => c[0]), ["install", "rebuild"]);
    assert.ok(calls.every((c) => c[c.indexOf("--prefix") + 1] !== app), "npm never writes the live tree");
    assert.deepEqual(fs.readdirSync(d), ["app"], "no staging or backup dir is left behind");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("a failed native build leaves the running install untouched", async () => {
  // Before this change a failed install script made `npm install` roll back.
  // With scripts off at install, the staging copy is what keeps that property:
  // a half-built tree must never become the one the supervisor respawns.
  const d = tmp();
  try {
    const app = path.join(d, "app");
    await installInto(app, "0.1.0", { npm: fakeNpm([]), platform: "linux", arch: "x64" });
    await assert.rejects(
      installInto(app, "0.2.0", { npm: fakeNpm([], { buildFails: true }), platform: "linux", arch: "x64" }),
      /node-gyp failed/,
    );
    assert.equal(ver(app), "0.1.0");
    assert.ok(fs.existsSync(path.join(app, "node_modules", "node-pty", "build", "Release", "pty.node")));
    assert.deepEqual(fs.readdirSync(d), ["app"]);
    await assert.rejects(
      installInto(app, "0.2.0", { npm: fakeNpm([], { installFails: true }), platform: "linux", arch: "x64" }),
      /npm install failed/,
    );
    assert.equal(ver(app), "0.1.0");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("the published package carries its lockfile as npm-shrinkwrap.json", () => {
  // npm honours a dependency's npm-shrinkwrap.json (never its package-lock),
  // so this is what pins every transitive version + integrity hash on the
  // instances that install us. Two halves, both needed: CI creates it, and
  // `files` lets it into the tarball (npm does not add it on its own).
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("npm-shrinkwrap.json"));
  const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
  const shrink = wf.indexOf("npm shrinkwrap");
  assert.ok(shrink > 0, "publish.yml must run npm shrinkwrap");
  assert.ok(shrink > wf.indexOf("npm version \"$V\""), "after the version bump, so the lock carries it");
  assert.ok(shrink < wf.lastIndexOf("npm publish"), "before publishing");
});
