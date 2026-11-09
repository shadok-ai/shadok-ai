import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTANCE_CONTEXT_MAX,
  normalizeInstanceContext,
  firstWriteVerdict,
  instanceContextSection,
} from "../src/instance-context.js";
import { instanceContextForCwd, applyInstanceContext } from "../src/config.js";

test("accepts exactly 2000 chars, trimmed", () => {
  assert.equal(INSTANCE_CONTEXT_MAX, 2000);
  const t = "x".repeat(2000);
  assert.deepEqual(normalizeInstanceContext(`  ${t}\n`), { ok: true, text: t });
});

test("refuses 2001 chars with a message that does not repeat the text", () => {
  const t = "SECRETISH" + "y".repeat(1992);
  const r = normalizeInstanceContext(t);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(!r.error.includes("SECRETISH"));
});

test("whitespace-only normalises to empty; null/undefined too; other types refused", () => {
  assert.deepEqual(normalizeInstanceContext("  \n\t "), { ok: true, text: "" });
  assert.deepEqual(normalizeInstanceContext(undefined), { ok: true, text: "" });
  assert.deepEqual(normalizeInstanceContext(null), { ok: true, text: "" });
  assert.equal(normalizeInstanceContext(42).ok, false);
  assert.equal(normalizeInstanceContext({}).ok, false);
});

test("firstWriteVerdict: only the home agent, only while empty", () => {
  assert.equal(firstWriteVerdict({ isHome: true, current: "" }), null);
  assert.equal(typeof firstWriteVerdict({ isHome: false, current: "" }), "string");
  assert.equal(typeof firstWriteVerdict({ isHome: true, current: "already set" }), "string");
});

test("section is null when empty, a labelled heading otherwise", () => {
  assert.equal(instanceContextSection(""), null);
  const s = instanceContextSection("Side projects with friends.");
  assert.ok(s && s.startsWith("## This instance"));
  assert.ok(s!.includes("Side projects with friends."));
});

test("config: per launch dir, independent, empty removes", () => {
  const cfg: any = {};
  applyInstanceContext(cfg, "/a", "A ctx");
  applyInstanceContext(cfg, "/b", "B ctx");
  assert.equal(instanceContextForCwd(cfg, "/a"), "A ctx");
  assert.equal(instanceContextForCwd(cfg, "/b"), "B ctx");
  assert.equal(instanceContextForCwd(cfg, "/c"), "");
  applyInstanceContext(cfg, "/a", "");
  assert.equal(instanceContextForCwd(cfg, "/a"), "");
  assert.ok(!("/a" in cfg.instanceContext));
});

test("instanceContextArgs: nothing when empty; a hostile text survives byte-for-byte", async () => {
  const { instanceContextArgs } = await import("../src/instance-context.js");
  assert.deepEqual(instanceContextArgs(""), []);
  const hostile = "Quotes \" ' `ticks` $HOME $(rm -rf /)\nnew line\n# Markdown *bold*";
  const a = instanceContextArgs(hostile);
  assert.equal(a[0], "--append-system-prompt");
  assert.ok(a[1].endsWith(hostile));
});

test("pre-prompt panel shows it first, before the role, and the staleness fingerprint ignores it", async () => {
  const { prepromptParts, prepromptFingerprint } = await import("../src/preprompt.js");
  const base = { profileName: "Shadok-dev", role: "You build.", pilotPrompt: "pilot" };
  const without = prepromptParts(base);
  const withCtx = prepromptParts({ ...base, instanceContext: "Side projects with friends." });
  const i = withCtx.findIndex((p) => p.label === "Instance context");
  // General before specific: what the instance is for, THEN the agent's role.
  assert.equal(i, 0, "the instance context comes first");
  assert.equal(withCtx[1].label.startsWith("Role"), true);
  assert.ok(withCtx[i].text.includes("Side projects with friends."));
  assert.equal(prepromptFingerprint(withCtx), prepromptFingerprint(without));
  assert.equal(prepromptParts({ ...base, instanceContext: "  " }).some((p) => p.label === "Instance context"), false);
});
