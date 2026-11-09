import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSkillMeta, prepromptParts, prepromptFingerprint, stalenessReasons, LEGACY_FINGERPRINT,
} from "../src/preprompt.js";

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

test("prepromptFingerprint changes iff any section's content changes", () => {
  const a = prepromptParts({ role: "dev", pilotPrompt: "cockpit" });
  const b = prepromptParts({ role: "dev", pilotPrompt: "cockpit" });
  assert.equal(prepromptFingerprint(a), prepromptFingerprint(b), "same content → same fingerprint");
  const c = prepromptParts({ role: "dev", pilotPrompt: "cockpit v2" });
  assert.notEqual(prepromptFingerprint(a), prepromptFingerprint(c), "changed pilot prompt → different");
  const d = prepromptParts({ role: "dev", deny: ["Bash(git push:*)"], pilotPrompt: "cockpit" });
  assert.notEqual(prepromptFingerprint(a), prepromptFingerprint(d), "added guardrail → different");
});

const baseInput = {
  spawnFp: "aaa",
  currentFp: "aaa",
  hasPassword: true,
  spawnedAt: 1000,
  now: 1000,
  authTtlMs: 7 * 24 * 3600 * 1000,
  spawnClaudeVersion: "2.1.250",
  currentClaudeVersion: "2.1.250",
};

test("a fresh, up-to-date agent has no stale reasons", () => {
  assert.deepEqual(stalenessReasons(baseInput), []);
});

test("a changed preprompt fingerprint is a reload reason", () => {
  const r = stalenessReasons({ ...baseInput, currentFp: "bbb" });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "preprompt");
});

test("a legacy (pre-feature) agent reads as stale with its own wording", () => {
  const r = stalenessReasons({ ...baseInput, spawnFp: LEGACY_FINGERPRINT, currentFp: "bbb" });
  assert.equal(r[0].kind, "preprompt");
  assert.match(r[0].label, /before this cockpit version/);
});

test("no anchor yet (null fingerprint) never flags — a brand-new agent isn't stale", () => {
  assert.deepEqual(stalenessReasons({ ...baseInput, spawnFp: null, currentFp: "bbb" }), []);
});

test("an auth cookie past its TTL flags, but only when a password is set", () => {
  const past = { ...baseInput, now: baseInput.spawnedAt + baseInput.authTtlMs + 1 };
  assert.ok(stalenessReasons(past).some((r) => r.kind === "auth"));
  assert.ok(!stalenessReasons({ ...past, hasPassword: false }).some((r) => r.kind === "auth"));
});

test("an unknown spawn time never flags auth (we don't guess it's expired)", () => {
  assert.ok(!stalenessReasons({ ...baseInput, spawnedAt: null }).some((r) => r.kind === "auth"));
});

test("a moved claude binary flags, but an unknown version never does", () => {
  assert.ok(stalenessReasons({ ...baseInput, currentClaudeVersion: "2.1.260" }).some((r) => r.kind === "claude"));
  // A failed probe (null) must not read as a change — no false reload hint.
  assert.ok(!stalenessReasons({ ...baseInput, currentClaudeVersion: null }).some((r) => r.kind === "claude"));
  assert.ok(!stalenessReasons({ ...baseInput, spawnClaudeVersion: null, currentClaudeVersion: "2.1.260" }).some((r) => r.kind === "claude"));
});

test("reasons stack: everything stale at once lists all three", () => {
  const r = stalenessReasons({
    ...baseInput,
    currentFp: "bbb",
    now: baseInput.spawnedAt + baseInput.authTtlMs + 1,
    currentClaudeVersion: "2.1.260",
  });
  assert.deepEqual(r.map((x) => x.kind).sort(), ["auth", "claude", "preprompt"]);
});
