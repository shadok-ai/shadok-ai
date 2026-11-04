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

test("every skill seeder is gated by SEED_SKILLS, so a side-by-side build cannot clobber them", () => {
  // The seeders write OUTSIDE the running tree (the server HOME's
  // ~/.claude/skills, plus /etc in multi-tenant) at every boot, so a build
  // started side by side to verify a change rewrites the shared scripts under
  // the RUNNING server — and the agents on that host then call routes their
  // server may not serve (invariant 57). `SHADOK_SEED_SKILLS=0` is the opt-out,
  // and it only works if EVERY call site is behind it. Scanned rather than
  // imported for the same reason as SKILL_SOURCES above.
  const seeders = [...SERVER.matchAll(/^(.*)\bseed([A-Z]\w*)Skills?\(\);$/gm)]
    .map((m) => ({ prefix: m[1], name: `seed${m[2]}Skill` }));
  assert.ok(seeders.length >= 6, `expected the skill seeders to be called, found ${seeders.length}`);
  const ungated = seeders.filter((c) => !c.prefix.includes("SEED_SKILLS"));
  assert.deepEqual(
    ungated.map((c) => c.name),
    [],
    `these seeders run unconditionally — SHADOK_SEED_SKILLS=0 would not stop them: ${ungated.map((c) => c.name).join(", ")}`,
  );
  // And the gate itself: default ON (an ordinary boot must keep refreshing).
  assert.match(SERVER, /const SEED_SKILLS = \(process\.env\.SHADOK_SEED_SKILLS \?\? ""\)\.trim\(\) !== "0";/);
});
