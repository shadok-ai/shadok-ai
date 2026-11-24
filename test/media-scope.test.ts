import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mediaGroupKey,
  mediaDirForGroup,
  mediaFileMode,
  parseMediaRequest,
  groupForMediaKey,
  passwdGid,
  mediaDirSpec,
  mediaDirTrusted,
  mediaServable,
  MEDIA_GROUP_DIR_RE,
} from "../src/media-scope.js";

test("mediaGroupKey: readable for a safe id, hashed (never sanitised) otherwise", () => {
  assert.equal(mediaGroupKey(null), "g-main");
  assert.equal(mediaGroupKey("main"), "g-main");
  assert.equal(mediaGroupKey("6f1c-AB_9"), "g-6f1c-AB_9");
  const a = mediaGroupKey("a.b");
  const b = mediaGroupKey("ab");
  assert.notEqual(a, b, "two ids never share one directory");
  assert.match(a, MEDIA_GROUP_DIR_RE);
  assert.match(mediaGroupKey("x".repeat(200)), MEDIA_GROUP_DIR_RE);
});

test("mediaDirForGroup: per group in multi-tenant, flat in mono-tenant", () => {
  assert.equal(mediaDirForGroup("/m", "teamA", true), "/m/g-teamA");
  assert.equal(mediaDirForGroup("/m", null, true), "/m/g-main");
  assert.equal(mediaDirForGroup("/m", "teamA", false), "/m");
});

test("mediaFileMode: never world-readable", () => {
  assert.equal(mediaFileMode(true), 0o640);
  assert.equal(mediaFileMode(false), 0o600);
});

test("parseMediaRequest: one or two plain segments, the first a group key", () => {
  assert.deepEqual(parseMediaRequest(["x.png"]), { key: null, name: "x.png" });
  assert.deepEqual(parseMediaRequest(["g-teamA", "x.png"]), { key: "g-teamA", name: "x.png" });
  assert.equal(parseMediaRequest(["..", "x.png"]), null);
  assert.equal(parseMediaRequest(["other", "x.png"]), null);
  assert.equal(parseMediaRequest(["g-a", ".."]), null);
  assert.equal(parseMediaRequest([".."]), null);
  assert.equal(parseMediaRequest(["a", "b", "c"]), null);
  assert.equal(parseMediaRequest([]), null);
  assert.equal(parseMediaRequest(["a\\b"]), null);
});

test("groupForMediaKey: maps back to a known group only", () => {
  assert.equal(groupForMediaKey("g-main", []), "main");
  assert.equal(groupForMediaKey("g-teamA", ["teamA"]), "teamA");
  assert.equal(groupForMediaKey(mediaGroupKey("a.b"), ["a.b"]), "a.b");
  assert.equal(groupForMediaKey("g-ghost", ["teamA"]), null);
});

test("passwdGid", () => {
  const pw = "root:x:0:0:root:/root:/bin/bash\nsk-a:x:1001:1002::/home/sk-a:/bin/sh\nbad:x:1:\n";
  assert.equal(passwdGid(pw, "sk-a"), 1002);
  assert.equal(passwdGid(pw, "root"), 0);
  assert.equal(passwdGid(pw, "sk"), null);
  assert.equal(passwdGid(pw, "bad"), null);
});

test("mediaDirSpec: setgid group-read for a drop user, server-only otherwise", () => {
  assert.deepEqual(mediaDirSpec(1002), { gid: 1002, mode: 0o2750 });
  assert.deepEqual(mediaDirSpec(null), { gid: null, mode: 0o700 });
});

test("mediaDirTrusted: only a real server-owned directory", () => {
  assert.equal(mediaDirTrusted({ isDirectory: true, isSymbolicLink: false, uid: 0 }, 0), true);
  assert.equal(mediaDirTrusted({ isDirectory: true, isSymbolicLink: false, uid: 1001 }, 0), false);
  assert.equal(mediaDirTrusted({ isDirectory: false, isSymbolicLink: true, uid: 0 }, 0), false);
  assert.equal(mediaDirTrusted({ isDirectory: false, isSymbolicLink: false, uid: 0 }, 0), false);
});

test("mediaServable: never a symlink; in multi-tenant only what the server wrote", () => {
  const f = (o: Partial<{ isFile: boolean; isSymbolicLink: boolean; uid: number }>) => ({ isFile: true, isSymbolicLink: false, uid: 0, ...o });
  assert.equal(mediaServable(f({}), true, 0), true);
  assert.equal(mediaServable(f({ isSymbolicLink: true, isFile: false }), false, 0), false);
  assert.equal(mediaServable(f({ isFile: false }), false, 0), false);
  assert.equal(mediaServable(f({ uid: 1001 }), true, 0), false, "planted by an agent");
  assert.equal(mediaServable(f({ uid: 1001 }), false, 0), true, "mono-tenant: one user anyway");
});

test("purgeMedia: old files at the root and in group dirs, links removed not followed", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { purgeMedia } = await import("../src/telegram.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  try {
    const old = Date.now() / 1000 - 3600;
    fs.mkdirSync(path.join(root, "g-a"));
    fs.mkdirSync(path.join(root, "other"));
    for (const p of ["flat-old", "g-a/old", "other/keep"]) {
      fs.writeFileSync(path.join(root, p), "x");
      fs.utimesSync(path.join(root, p), old, old);
    }
    fs.writeFileSync(path.join(root, "g-a/new"), "x");
    const victim = path.join(outside, "victim");
    fs.writeFileSync(victim, "x");
    fs.utimesSync(victim, old, old);
    fs.symlinkSync(victim, path.join(root, "g-a/link"));
    fs.lutimesSync(path.join(root, "g-a/link"), old, old);
    purgeMedia(root, Date.now() - 60_000);
    assert.equal(fs.existsSync(path.join(root, "flat-old")), false);
    assert.equal(fs.existsSync(path.join(root, "g-a/old")), false);
    assert.equal(fs.existsSync(path.join(root, "g-a/new")), true);
    assert.equal(fs.existsSync(path.join(root, "other/keep")), true, "only g-* subdirs are swept");
    assert.equal(fs.existsSync(victim), true, "a link's target is never touched");
    assert.equal(fs.existsSync(path.join(root, "g-a")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
