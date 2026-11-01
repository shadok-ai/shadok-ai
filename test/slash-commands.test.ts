import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listCommands } from "../src/slash-commands.js";

test("listCommands: skills, commands, factory skills and built-ins, project before home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "slash-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slash-cwd-"));
  try {
    fs.mkdirSync(path.join(home, ".claude/skills/ledger"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/skills/ledger/SKILL.md"), "---\nname: shadok-ledger\ndescription: Shared state\n---\nbody");
    fs.mkdirSync(path.join(home, ".claude/commands"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/commands/standup.md"), "Write my standup\n");
    fs.mkdirSync(path.join(cwd, ".claude/commands"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude/commands/standup.md"), "---\ndescription: The project's own\n---\n");
    const out = listCommands({ home, cwd, factory: [{ name: "slack-digest", description: "Daily digest" }] });
    const by = (n: string) => out.find((c) => c.name === n);
    assert.equal(by("shadok-ledger")?.description, "Shared state");
    assert.equal(by("standup")?.description, "The project's own");
    assert.equal(by("slack-digest:slack-digest")?.source, "factory");
    assert.equal(by("compact")?.source, "built-in");
    assert.equal(out.filter((c) => c.name === "standup").length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
