import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALL_TIMEOUT_MS,
  SHIP_FILES,
  WA_LIB_SHIP_DIR,
  installFailureReason,
  libFingerprint,
  makeWaLibrary,
  spawnRunner,
  type RunCommand,
} from "../src/wa-library.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A shipped directory of our own: two made-up packages, pinned. */
function fakeShip(deps: Record<string, string> = { "pkg-a": "1.2.3", "pkg-b": "4.5.6" }): string {
  const d = tmp("wa-ship-");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x", private: true, dependencies: deps }));
  fs.writeFileSync(path.join(d, "npm-shrinkwrap.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  fs.writeFileSync(path.join(d, "load.mjs"), "export const load = (n) => import(n);\n");
  return d;
}

/** A stand-in for npm: installs the pinned versions (or `wrong` ones). */
function fakeNpm(o: { wrong?: boolean; fail?: unknown; delayMs?: number } = {}) {
  const calls: { cmd: string; args: string[]; cwd: string; files: string[] }[] = [];
  const run: RunCommand = async (cmd, args, { cwd }) => {
    calls.push({ cmd, args, cwd, files: fs.readdirSync(cwd).sort() });
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    if (o.fail) throw o.fail;
    const deps = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).dependencies as Record<string, string>;
    for (const [name, v] of Object.entries(deps)) {
      fs.mkdirSync(path.join(cwd, "node_modules", name), { recursive: true });
      fs.writeFileSync(path.join(cwd, "node_modules", name, "package.json"), JSON.stringify({ name, version: o.wrong ? "0.0.0" : v }));
    }
  };
  return { run, calls };
}

test("absent on an empty data directory; ready after an install; the entry is the shipped loader in it", async () => {
  const root = path.join(tmp("wa-lib-"), "lib");
  const ship = fakeShip();
  const npm = fakeNpm();
  const lib = makeWaLibrary({ root, shipDir: ship, run: npm.run });
  assert.equal(lib.status(), "absent");
  assert.throws(() => lib.entryUrl());
  await lib.install();
  assert.equal(lib.status(), "ready");
  const entry = fileURLToPath(lib.entryUrl());
  assert.equal(entry, path.join(root, libFingerprint(ship), "load.mjs"));
  assert.ok(fs.existsSync(entry));
});

test("npm ci runs with scripts OFF, peers left out, in a staging copy of exactly the shipped files", async () => {
  const root = path.join(tmp("wa-lib-"), "lib");
  const npm = fakeNpm();
  await makeWaLibrary({ root, shipDir: fakeShip(), run: npm.run }).install();
  assert.equal(npm.calls.length, 1);
  const c = npm.calls[0];
  assert.equal(c.cmd, "npm");
  assert.equal(c.args[0], "ci", "the lockfile decides the tree: never `npm install`");
  for (const flag of ["--ignore-scripts", "--legacy-peer-deps", "--omit=dev", "--no-audit", "--no-fund"]) assert.ok(c.args.includes(flag), flag);
  assert.deepEqual(c.files, [...SHIP_FILES].sort());
  assert.ok(path.basename(c.cwd).startsWith(".staging-"), "never installed in place");
  // Nothing but the result is left behind.
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith(".staging-")), []);
});

test("single-flight: two clicks while installing run ONE npm, and both see its outcome", async () => {
  const root = path.join(tmp("wa-lib-"), "lib");
  const npm = fakeNpm({ delayMs: 30 });
  const lib = makeWaLibrary({ root, shipDir: fakeShip(), run: npm.run });
  await Promise.all([lib.install(), lib.install(), lib.install()]);
  assert.equal(npm.calls.length, 1);
  assert.equal(lib.status(), "ready");
});

test("a failed install leaves nothing usable and nothing half-made, says why, and can be tried again", async () => {
  const root = path.join(tmp("wa-lib-"), "lib");
  const ship = fakeShip();
  const failing = fakeNpm({ fail: Object.assign(new Error("npm ci exited with code 1"), { stderr: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/x failed" }) });
  const lib = makeWaLibrary({ root, shipDir: ship, run: failing.run });
  await assert.rejects(lib.install(), /registry could not be reached/);
  assert.equal(lib.status(), "absent");
  assert.deepEqual(fs.readdirSync(root), []);
  // Not memoised: the next click runs npm again.
  await assert.rejects(lib.install());
  assert.equal(failing.calls.length, 2);
});

test("an installed tree that does not carry the pinned versions is refused, not used", async () => {
  const root = path.join(tmp("wa-lib-"), "lib");
  const lib = makeWaLibrary({ root, shipDir: fakeShip(), run: fakeNpm({ wrong: true }).run });
  await assert.rejects(lib.install(), /pkg-a.*0\.0\.0.*1\.2\.3/);
  assert.equal(lib.status(), "absent");
});

test("a release that pins something else finds the old copy STALE — never uses it — and the install replaces it", async () => {
  const root = path.join(tmp("wa-lib-"), "lib");
  const oldShip = fakeShip({ "pkg-a": "1.2.3" });
  await makeWaLibrary({ root, shipDir: oldShip, run: fakeNpm().run }).install();
  const newShip = fakeShip({ "pkg-a": "1.2.4" });
  const lib = makeWaLibrary({ root, shipDir: newShip, run: fakeNpm().run });
  assert.equal(lib.status(), "stale");
  assert.throws(() => lib.entryUrl(), /out of date|not installed/);
  await lib.install();
  assert.equal(lib.status(), "ready");
  // The old copy is pruned: one version on disk.
  assert.deepEqual(fs.readdirSync(root), [libFingerprint(newShip)]);
});

test("force reinstalls over a ready copy (a copy that installed but would not load)", async () => {
  const root = path.join(tmp("wa-lib-"), "lib");
  const ship = fakeShip();
  const npm = fakeNpm();
  const lib = makeWaLibrary({ root, shipDir: ship, run: npm.run });
  await lib.install();
  const marker = path.join(root, libFingerprint(ship), "broken-by-hand");
  fs.writeFileSync(marker, "x");
  await lib.install(); // ready and not forced: nothing to do
  assert.equal(npm.calls.length, 1);
  await lib.install({ force: true });
  assert.equal(npm.calls.length, 2);
  assert.ok(!fs.existsSync(marker), "the forced install replaced the directory");
  assert.equal(lib.status(), "ready");
});

test("a staging directory left by a server that died mid-install is swept, a fresh one is not", async () => {
  const root = path.join(tmp("wa-lib-"), "lib");
  fs.mkdirSync(root, { recursive: true });
  const old = path.join(root, ".staging-dead");
  const fresh = path.join(root, ".staging-busy");
  fs.mkdirSync(old);
  fs.mkdirSync(fresh);
  const past = (Date.now() - INSTALL_TIMEOUT_MS - 60_000) / 1000;
  fs.utimesSync(old, past, past);
  await makeWaLibrary({ root, shipDir: fakeShip(), run: fakeNpm().run }).install();
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh), "may be another server's install in progress");
});

test("the fingerprint follows every shipped file", () => {
  const a = fakeShip();
  const before = libFingerprint(a);
  assert.equal(libFingerprint(a), before);
  fs.appendFileSync(path.join(a, "npm-shrinkwrap.json"), " ");
  assert.notEqual(libFingerprint(a), before);
});

test("installFailureReason names the cause a person can act on", () => {
  const e = (stderr: string, extra: Record<string, unknown> = {}) => Object.assign(new Error("npm ci exited with code 1"), { stderr, ...extra });
  assert.match(installFailureReason(Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" })), /npm is not installed/);
  assert.match(installFailureReason(e("npm error code EAI_AGAIN")), /registry could not be reached/);
  assert.match(installFailureReason(e("npm error code ENOSPC\nno space left on device")), /disk is full/);
  assert.match(installFailureReason(e("npm error code EACCES")), /permission/);
  assert.match(installFailureReason(e("npm error code EINTEGRITY")), /checksum/);
  assert.match(installFailureReason(Object.assign(new Error("timed out"), { timedOut: true })), /did not finish within 10 min/);
  assert.match(installFailureReason(e("npm error something odd happened\nnpm error A complete log of this run can be found in: /x")), /something odd happened/);
});

test("spawnRunner captures stderr, kills on timeout, and reports a missing command by its code", async () => {
  const run = spawnRunner();
  await run(process.execPath, ["-e", "0"], { cwd: os.tmpdir(), timeoutMs: 10_000 });
  await assert.rejects(run(process.execPath, ["-e", "console.error('boom');process.exit(3)"], { cwd: os.tmpdir(), timeoutMs: 10_000 }), (err: any) => /boom/.test(err.stderr) && /code 3/.test(err.message));
  await assert.rejects(run(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { cwd: os.tmpdir(), timeoutMs: 200 }), (err: any) => err.timedOut === true);
  await assert.rejects(run("shadok-no-such-command-xyz", [], { cwd: os.tmpdir(), timeoutMs: 10_000 }), (err: any) => err.code === "ENOENT");
});

// ── the directory that ships ────────────────────────────────────────────────

const SHIP_PKG = JSON.parse(fs.readFileSync(path.join(WA_LIB_SHIP_DIR, "package.json"), "utf8"));
const SHIP_LOCK = JSON.parse(fs.readFileSync(path.join(WA_LIB_SHIP_DIR, "npm-shrinkwrap.json"), "utf8"));

test("the shipped directory pins the library EXACTLY, in one place", () => {
  assert.equal(SHIP_PKG.dependencies.baileys, "7.0.0-rc14");
  for (const [name, v] of Object.entries(SHIP_PKG.dependencies as Record<string, string>)) assert.match(v, /^\d+\.\d+\.\d+(-[\w.]+)?$/, `${name} must be an exact version`);
  for (const f of SHIP_FILES) assert.ok(fs.existsSync(path.join(WA_LIB_SHIP_DIR, f)), f);
});

test("its lockfile matches that manifest, and pins every package of the tree by integrity", () => {
  assert.deepEqual(SHIP_LOCK.packages[""].dependencies, SHIP_PKG.dependencies);
  for (const [name, v] of Object.entries(SHIP_PKG.dependencies as Record<string, string>)) assert.equal(SHIP_LOCK.packages[`node_modules/${name}`].version, v);
  for (const [k, p] of Object.entries(SHIP_LOCK.packages as Record<string, { integrity?: string; resolved?: string }>)) {
    if (!k) continue;
    assert.match(p.integrity ?? "", /^sha512-/, `${k} has no integrity`);
    assert.match(p.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${k} is not from the registry`);
  }
});

test("sharp (a native image library) is left out of the tree: text, QR and media download do not need it", () => {
  const names = Object.keys(SHIP_LOCK.packages);
  assert.deepEqual(names.filter((k) => /(^|\/)(sharp|@img\/[^/]+)$/.test(k)), []);
});

