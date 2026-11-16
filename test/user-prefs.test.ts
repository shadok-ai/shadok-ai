import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizePrefs, mergePrefs, prefsFor, savePrefsFor } from "../src/user-prefs.js";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prefs-")), "p.json");

test("sanitizePrefs keeps only known keys with the right type", () => {
  assert.deepEqual(
    sanitizePrefs({ mode: "dark", soundMuted: true, railMini: false, tourSeen: true, drafts: "x", __proto__x: 1 }),
    { mode: "dark", soundMuted: true, railMini: false, tourSeen: true },
  );
});

test("sanitizePrefs drops a wrong type instead of coercing it", () => {
  assert.deepEqual(sanitizePrefs({ mode: "sepia", soundMuted: "false", railMini: 1 }), {});
  assert.deepEqual(sanitizePrefs(null), {});
  assert.deepEqual(sanitizePrefs(["mode"]), {});
});

test("mergePrefs only replaces the keys a patch carries", () => {
  assert.deepEqual(mergePrefs({ mode: "dark", railMini: true }, { railMini: false }), { mode: "dark", railMini: false });
});

test("preferences are stored per account and survive a reload of the file", () => {
  const f = tmpFile();
  assert.deepEqual(prefsFor("ada", f), {});
  savePrefsFor("ada", { mode: "dark" }, f);
  savePrefsFor("bob", { soundMuted: true }, f);
  savePrefsFor("ada", { tourSeen: true, junk: 1 }, f);
  assert.deepEqual(prefsFor("ada", f), { mode: "dark", tourSeen: true });
  assert.deepEqual(prefsFor("bob", f), { soundMuted: true });
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), "600");
});

test("an account named __proto__ is an ordinary row, not the prototype", () => {
  const f = tmpFile();
  assert.deepEqual(prefsFor("__proto__", f), {});
  savePrefsFor("__proto__", { mode: "dark" }, f);
  assert.deepEqual(prefsFor("__proto__", f), { mode: "dark" });
  assert.deepEqual(prefsFor("ada", f), {});
});

test("an unreadable store reads as no preferences", () => {
  const f = tmpFile();
  fs.writeFileSync(f, "{not json");
  assert.deepEqual(prefsFor("ada", f), {});
});
