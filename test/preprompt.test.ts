import assert from "node:assert/strict";
import test from "node:test";
import { prepromptParts } from "../src/preprompt.js";

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
