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

// The shipped skill docs/prompts name the HOME path `~/.claude/skills/...`.
// Multi-tenant installs the skills in the Enterprise tier and drops agents to
// HOMEs with no personal copy, so that literal resolves to nothing and the
// script silently fails to run. `rewriteSkillsBase` retargets the base; these
// pin that it is actually wired at the three injection points. Scanned, not
// imported, for the same reason as SKILL_SOURCES above.
test("SKILLS_BASE is keyed on DEPLOYMENT_MODE (Enterprise tier in MT, HOME tier otherwise)", () => {
  assert.match(
    SERVER,
    /const SKILLS_BASE = DEPLOYMENT_MODE === "multi-tenant" \? SYSTEM_SKILLS_DIR : HOME_SKILLS_BASE;/,
    "SKILLS_BASE must follow the same flag that decides where skills are installed",
  );
});

test("the copied SKILL.md is retargeted to the tier it is installed in (seedSystemSkills)", () => {
  const start = SERVER.indexOf("function seedSystemSkills");
  assert.ok(start >= 0, "seedSystemSkills present");
  const body = SERVER.slice(start, SERVER.indexOf("\n}\n", start));
  assert.match(body, /rewriteSkillsBase\(fs\.readFileSync\(skillMd, "utf8"\), SKILLS_BASE\)/);
});

test("the injected pilot prompt and ledger reflex are retargeted too (server-side injection)", () => {
  // Both are read from context/*.md and appended to --append-system-prompt, so
  // their `~/.claude/skills/...` commands need the same rewrite as SKILL.md.
  assert.match(SERVER, /pilotPromptCache =[\s\S]*?rewriteSkillsBase\([\s\S]*?PILOT_PROMPT_PATH[\s\S]*?SKILLS_BASE\)/);
  assert.match(SERVER, /ledgerReflexCache = rewriteSkillsBase\(fs\.readFileSync\(LEDGER_REFLEX_PATH, "utf8"\)\.trim\(\), SKILLS_BASE\)/);
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

// ── the HOME tier's links ────────────────────────────────────────────────

test("a group HOME gets the machine-wide skills LINKED, as the user, never forced", () => {
  const i = SERVER.indexOf("function linkSystemSkills(");
  assert.ok(i >= 0, "linkSystemSkills present");
  const body = SERVER.slice(i, SERVER.indexOf("\n}\n", i));
  // Multi-tenant only: a mono-tenant HOME already holds the real skills.
  assert.match(body, /if \(DEPLOYMENT_MODE !== "multi-tenant"\) return;/);
  // AS the user, like ensureTierStateDir: root must not write through a 0700
  // HOME it does not own, where an agent could have planted a symlink.
  assert.match(body, /spawnAsUserSync\(user, "mkdir", \["-p", dir\]\)/);
  assert.match(body, /spawnAsUserSync\(user, "ln", \["-s",/);
  // `ln -s` WITHOUT -f: an agent's own skill of the same name is never replaced.
  assert.doesNotMatch(body, /"-sf"|"-f"/);
  // Symlinks, not copies: the skills stay in ONE place and need no refresh.
  assert.doesNotMatch(body, /cpSync|"cp"/);
  assert.match(body, /missingHomeSkillLinks\(system, have\)/);
});

test("the links are (re)made at BOOT, not only at provisioning", () => {
  // A HOME that predates this, or one a docker recreate wiped, would otherwise
  // keep answering MODULE_NOT_FOUND for ever.
  const i = SERVER.indexOf("function preseedGroupHomes(");
  const body = SERVER.slice(i, SERVER.indexOf("\n}\n", i));
  assert.match(body, /linkSystemSkills\(user, home\)/);
  const j = SERVER.indexOf("async function seedGroupHome(");
  assert.match(SERVER.slice(j, SERVER.indexOf("\n}\n", j)), /linkSystemSkills\(user, home\)/);
});
