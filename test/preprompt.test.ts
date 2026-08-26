import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillMeta, prepromptParts } from "../src/preprompt.js";

test("an agent with nothing added shows nothing", () => {
  // A bare spawn has no role, no guardrails and no cockpit prompt: the panel
  // must not invent empty sections to look busy.
  assert.deepEqual(prepromptParts({}), []);
});

test("sections come in reading order and carry where to change them", () => {
  const parts = prepromptParts({
    profileName: "Shadok-dev",
    role: "You are the dev agent.",
    model: "opus",
    deny: ["Bash(git push:*)"],
    permissionMode: "auto",
    secretNames: ["GITHUB_TOKEN"],
    pilotPrompt: "You run under the cockpit.",
    ledgerReflex: "Check the ledger first.",
  });
  assert.deepEqual(
    parts.map((p) => p.label),
    ["Role — Shadok-dev", "Guardrails", "Injected variables", "Cockpit context", "Ledger reflex"],
  );
  assert.equal(parts[0].source, "Profiles panel");
  assert.match(parts[3].source, /pilot-prompt\.md/);
});

test("only the NAMES of injected variables appear", () => {
  // The signature takes names, so a value cannot reach the panel even by
  // mistake — this pins the intent as well as the behaviour.
  const parts = prepromptParts({ secretNames: ["GITHUB_TOKEN", "OPENAI_API_KEY"] });
  const text = parts.map((p) => p.text).join("\n");
  assert.match(text, /GITHUB_TOKEN/);
  assert.match(text, /OPENAI_API_KEY/);
  assert.match(text, /values are never shown/i);
});

test("a role with no profile name is still labelled", () => {
  const parts = prepromptParts({ role: "Ad-hoc role." });
  assert.equal(parts[0].label, "Role");
});

test("guardrails collapse into one section, and vanish when there are none", () => {
  assert.equal(prepromptParts({ permissionMode: "auto" })[0].label, "Guardrails");
  assert.equal(prepromptParts({ role: "x" }).length, 1);
});

test("blank strings count as absent", () => {
  // A profile whose prompt is "   " must not open an empty section.
  assert.deepEqual(prepromptParts({ role: "   ", pilotPrompt: "\n\n", ledgerReflex: "" }), []);
});

test("capabilities list descriptions, never whole skills", () => {
  // Claude Code loads a skill's DESCRIPTION into context and reads its body only
  // when it decides to use it. Pasting five whole skills would be wrong as well
  // as unreadable.
  const parts = prepromptParts({
    capabilities: [
      { name: "shadok-scheduler", description: "Schedule recurring prompts." },
      { name: "shadok-secrets", description: "Store a credential it obtained." },
    ],
  });
  assert.equal(parts[0].label, "Capabilities installed");
  assert.match(parts[0].text, /shadok-scheduler — Schedule recurring prompts\./);
  assert.match(parts[0].text, /read on demand/i);
  // Global, not per-agent, and rewritten at boot: both are surprising enough to
  // belong on screen rather than in someone's memory.
  assert.match(parts[0].text, /whole machine/i);
});

test("no capabilities means no section", () => {
  assert.deepEqual(prepromptParts({ capabilities: [] }), []);
});

test("parseSkillMeta reads the frontmatter, and tolerates a broken one", () => {
  const md = ['---', 'name: shadok-reload', 'description: Reload your own session.', '---', '# body'].join("\n");
  assert.deepEqual(parseSkillMeta(md), { name: "shadok-reload", description: "Reload your own session." });
  // A skill we cannot parse is still installed: better listed bare than hidden.
  assert.deepEqual(parseSkillMeta("# no frontmatter"), {});
});
