import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { HOME_SKILLS_BASE, missingHomeSkillLinks, rewriteSkillsBase } from "../src/skill-paths.js";

// The shipped skill docs/prompts invoke their scripts by the HOME-tier path
// (`~/.claude/skills/<skill>/x.mjs`). That is correct mono-tenant, where skills
// are seeded into the agent's own HOME. In multi-tenant a privilege-dropped
// agent reads the machine-wide Enterprise tier instead (/etc/claude-code/...),
// so following that literal path hits a file that does not exist — the agent
// loads the skill but cannot run its script. `rewriteSkillsBase` retargets the
// base so the path matches where the skills were actually installed.

const ETC = "/etc/claude-code/.claude/skills";

test("HOME_SKILLS_BASE is the literal the shipped docs are written with", () => {
  assert.equal(HOME_SKILLS_BASE, "~/.claude/skills");
});

test("identity when the base is the home tier (mono-tenant: nothing to rewrite)", () => {
  const txt = "run `node ~/.claude/skills/shadok-ledger/ledger.mjs check x`";
  assert.equal(rewriteSkillsBase(txt, HOME_SKILLS_BASE), txt);
});

test("retargets every occurrence to the given base (multi-tenant Enterprise tier)", () => {
  const txt =
    "node ~/.claude/skills/shadok-files/scripts/send.mjs a.pdf\n" +
    "node ~/.claude/skills/shadok-ledger/ledger.mjs list";
  assert.equal(
    rewriteSkillsBase(txt, ETC),
    "node /etc/claude-code/.claude/skills/shadok-files/scripts/send.mjs a.pdf\n" +
      "node /etc/claude-code/.claude/skills/shadok-ledger/ledger.mjs list",
  );
});

test("only the exact base literal is swapped — a longer skills path is preserved below the base", () => {
  // The suffix after the base (skill name + script) must survive untouched.
  assert.equal(
    rewriteSkillsBase("~/.claude/skills/shadok-reload/reload.mjs", ETC),
    "/etc/claude-code/.claude/skills/shadok-reload/reload.mjs",
  );
});

test("an empty/falsy base is a no-op (never blanks the path)", () => {
  const txt = "node ~/.claude/skills/shadok-ledger/ledger.mjs list";
  assert.equal(rewriteSkillsBase(txt, ""), txt);
  assert.equal(rewriteSkillsBase(txt, undefined as unknown as string), txt);
});

test("text with no skills path is returned unchanged", () => {
  assert.equal(rewriteSkillsBase("nothing to see here", ETC), "nothing to see here");
});

// ── and the other half: make the guessed path TRUE ───────────────────────

test("missingHomeSkillLinks: what a group's HOME has no entry for", () => {
  assert.deepEqual(missingHomeSkillLinks(["shadok-files", "shadok-ledger"], []), [
    "shadok-files",
    "shadok-ledger",
  ]);
  assert.deepEqual(missingHomeSkillLinks(["shadok-files", "shadok-ledger"], ["shadok-files"]), [
    "shadok-ledger",
  ]);
  // Idempotent: a second boot has nothing left to do.
  assert.deepEqual(missingHomeSkillLinks(["a", "b"], ["b", "a"]), []);
});

test("missingHomeSkillLinks: an agent's OWN skill of the same name always wins", () => {
  // `~/.claude/skills` is exactly where an agent keeps what it authored, so a
  // name already there is never relinked — and never replaced.
  assert.deepEqual(missingHomeSkillLinks(["shadok-files"], ["shadok-files", "my-own"]), []);
});

test("missingHomeSkillLinks: tolerant of the listing it is handed", () => {
  // It is fed `ls -1` run as the group user: blank lines, stray whitespace.
  assert.deepEqual(missingHomeSkillLinks([" a ", "", "a"], ["", "  "]), ["a"]);
  // Dotfiles are not skills.
  assert.deepEqual(missingHomeSkillLinks([".git", "a"], []), ["a"]);
  assert.deepEqual(missingHomeSkillLinks([], ["a"]), []);
});

// ── what the rewrite cannot save: a path that names no base ──────────────

test("no shipped skill invokes its own script by a relative path", () => {
  // `rewriteSkillsBase` can only retarget a base it can SEE. A command written
  // `node scripts/x.mjs` has none, and the skill directory is not the agent's
  // cwd — so the agent has to invent an absolute path, and it invents the
  // conventional `~/.claude/skills/...`. That exists for the server user and
  // for every mono-tenant install, and NOT in a dropped group agent's HOME.
  // Measured on a real instance: a group agent ran
  // `node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs list` and got
  // MODULE_NOT_FOUND, with nothing in the message naming the right tier.
  // shadok-scheduler was the only one of the ten written that way.
  const dir = new URL("../context/", import.meta.url);
  const offenders: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    let text: string;
    try {
      text = fs.readFileSync(new URL(`${name}/SKILL.md`, dir), "utf8");
    } catch {
      continue; // not a skill directory
    }
    for (const m of text.matchAll(/\b(?:node|python3?|bash|sh)[ \t]+(\S+\.(?:mjs|cjs|js|py|sh))/g)) {
      const p = m[1];
      // Absolute, env-anchored, or the HOME literal the rewrite understands.
      if (p.startsWith("/") || p.startsWith("$") || p.startsWith(HOME_SKILLS_BASE + "/")) continue;
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "write the full ~/.claude/skills/<skill>/... path, which the rewrite retargets");
});
