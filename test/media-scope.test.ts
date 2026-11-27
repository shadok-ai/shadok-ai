import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { conversationUnit } from "../src/isolation-unit.js";
import {
  mediaUnitKey,
  mediaDirForUnit,
  mediaFileMode,
  parseMediaRequest,
  unitForMediaKey,
  passwdGid,
  mediaDirSpec,
  mediaDirTrusted,
  mediaServable,
  mediaAddDirArgs,
  MEDIA_GROUP_DIR_RE,
} from "../src/media-scope.js";

test("mediaUnitKey: readable for a safe id, hashed (never sanitised) otherwise", () => {
  assert.equal(mediaUnitKey(null), "g-main");
  assert.equal(mediaUnitKey("main"), "g-main");
  assert.equal(mediaUnitKey("6f1c-AB_9"), "g-6f1c-AB_9");
  const a = mediaUnitKey("a.b");
  const b = mediaUnitKey("ab");
  assert.notEqual(a, b, "two ids never share one directory");
  assert.match(a, MEDIA_GROUP_DIR_RE);
  assert.match(mediaUnitKey("x".repeat(200)), MEDIA_GROUP_DIR_RE);
});

test("mediaDirForUnit: per group in multi-tenant, flat in mono-tenant", () => {
  assert.equal(mediaDirForUnit("/m", "teamA", true), "/m/g-teamA");
  assert.equal(mediaDirForUnit("/m", null, true), "/m/g-main");
  assert.equal(mediaDirForUnit("/m", "teamA", false), "/m");
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

test("unitForMediaKey: maps back to a known group only", () => {
  assert.equal(unitForMediaKey("g-main", []), "main");
  assert.equal(unitForMediaKey("g-teamA", ["teamA"]), "teamA");
  assert.equal(unitForMediaKey(mediaUnitKey("a.b"), ["a.b"]), "a.b");
  assert.equal(unitForMediaKey("g-ghost", ["teamA"]), null);
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

test("attachments: the media directory is granted to the agent with --add-dir", () => {
  assert.deepEqual(mediaAddDirArgs("/srv/media/g-main"), ["--add-dir", "/srv/media/g-main"]);
  // No directory → no flag: --add-dir refuses a missing path, and that must
  // never cost the spawn.
  assert.deepEqual(mediaAddDirArgs(null), []);
  assert.deepEqual(mediaAddDirArgs(""), []);
  // Wired into the agent's argv, early (the flag is variadic: what follows it
  // must be another flag) and best-effort (a vanished group never fails a spawn).
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const at = src.indexOf("...mediaAddDirArgs(mediaDirArg),");
  assert.ok(at > 0, "makePilot passes the media dir");
  assert.ok(at < src.indexOf("...permissionModeArgs(permissionMode),", at), "before the other flags");
  // ...and PRE-TRUSTED, for both the server's HOME and a dropped agent's: an
  // untrusted --add-dir dir blocks the spawn on a trust screen whose default is
  // "No, exit" (verified on a real interactive claude 2.1.331).
  assert.match(src, /if \(mediaDirArg\) ensureProjectTrusted\(mediaDirArg\);/);
  assert.match(src, /seedGroupAgentHome\(user, home, cwd, mediaDirArg \? \[mediaDirArg\] : \[\]\)/);
  // Per ISOLATION UNIT: the group's directory in an ordinary group, the
  // CONVERSATION's in an external one (`mediaDirForUnitOf`).
  assert.match(
    src,
    /mediaDirArg =\n\s*DEPLOYMENT_MODE === "multi-tenant"\n\s*\? mediaDirForUnitOf\(group \?\? null, conversation \?\? null\)\n\s*: mediaDirForSession\(null\);/,
  );
});

test("mediaUnitKey: a conversation's unit always hashes, and never collides with a group", () => {
  // Its `/` is not a legal directory name here, so it takes the hashed path by
  // construction — which is also what keeps a conversation's media out of any
  // group's directory. See src/isolation-unit.ts.
  const unit = conversationUnit("door", "wa-33123");
  const key = mediaUnitKey(unit);
  assert.match(key, /^g-h[0-9a-f]{32}$/);
  assert.notEqual(key, mediaUnitKey("door"));
  // Two conversations of one group are two directories.
  assert.notEqual(key, mediaUnitKey(conversationUnit("door", "wa-33999")));
  // Stable: the same person comes back to their own.
  assert.equal(key, mediaUnitKey(conversationUnit("door", "wa-33123")));
});

test("unitForMediaKey: a conversation's key maps back only when that unit is known", () => {
  const unit = conversationUnit("door", "tg-7");
  assert.equal(unitForMediaKey(mediaUnitKey(unit), ["door", unit]), unit);
  // Not among the known units → unknown, which the route answers as a 404
  // rather than serving a directory on trust.
  assert.equal(unitForMediaKey(mediaUnitKey(unit), ["door"]), null);
});
