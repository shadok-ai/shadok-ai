import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// server.ts is un-importable (boot side effects), so lock SKILL_SOURCES by scan,
// the same discipline as test/mt-token-endpoints.test.ts.
//
// The bug this pins: `shadok-files` ships (context/files-skill) and is seeded to
// the SERVER's /root HOME by seedFilesSkill, but was absent from SKILL_SOURCES —
// the list seedSystemSkills copies into the machine-wide tier. A privilege-
// dropped group agent reads ONLY that tier (never /root, mode 700), so it
// silently lost shadok-files on every migrated instance. The guard below is
// drift-proof: ANY shipped context/*-skill that is not machine-wide fails here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "src", "server.ts"), "utf8");

/** The source-dir names listed in the SKILL_SOURCES array. */
function skillSourcesInServer(): string[] {
  const start = SERVER.indexOf("const SKILL_SOURCES");
  assert.ok(start >= 0, "SKILL_SOURCES declaration present");
  const block = SERVER.slice(start, SERVER.indexOf("];", start));
  return [...block.matchAll(/\[\s*"([^"]+-skill)"\s*,\s*"([^"]+)"\s*\]/g)].map((m) => m[1]);
}

/** Every context/*-skill dir that actually ships (has a SKILL.md). */
function shippedSkillDirs(): string[] {
  return fs
    .readdirSync(path.join(ROOT, "context"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith("-skill"))
    .filter((d) => fs.existsSync(path.join(ROOT, "context", d.name, "SKILL.md")))
    .map((d) => d.name);
}

test("every shipped context/*-skill is seeded into the machine-wide tier (SKILL_SOURCES)", () => {
  const listed = new Set(skillSourcesInServer());
  const missing = shippedSkillDirs().filter((d) => !listed.has(d));
  assert.deepEqual(missing, [], `these shipped skills are not machine-wide (dropped agents lose them): ${missing.join(", ")}`);
});

test("shadok-files specifically is machine-wide (the regression)", () => {
  assert.ok(skillSourcesInServer().includes("files-skill"), "files-skill must be in SKILL_SOURCES");
});
