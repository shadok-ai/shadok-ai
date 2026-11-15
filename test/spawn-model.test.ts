import assert from "node:assert/strict";
import test from "node:test";
import { resolveSpawnModel } from "../src/profiles.js";

// The bug this locks: a multi-tenant DROPPED agent (its own OS user, its own
// HOME) reads the default model from its own `~/.claude/settings.json`, which
// shadok never seeds with a model — so it fell back to the CLI's built-in
// default (Sonnet) instead of the instance default a root agent gets from the
// server's settings.json. The spawn must backfill the instance default as an
// explicit `--model` for a dropped agent, but ONLY as the last resort: the
// agent's own choice and the profile's pinned model still win, and a root /
// mono-tenant agent must stay byte-for-byte as before (no forced flag — it
// reads the server settings.json itself).

test("resolveSpawnModel: the agent's explicit choice wins over everything", () => {
  assert.equal(
    resolveSpawnModel({ requested: "sonnet", profileModel: "opus", instanceDefault: "haiku", dropped: true }),
    "sonnet",
  );
});

test("resolveSpawnModel: the profile's pinned model beats the instance default", () => {
  assert.equal(
    resolveSpawnModel({ requested: null, profileModel: "opus", instanceDefault: "haiku", dropped: true }),
    "opus",
  );
});

test("resolveSpawnModel: a dropped agent falls back to the instance default", () => {
  // The fix: no explicit choice, no profile model, but it is dropped → the
  // instance default is passed explicitly so it reaches the agent's own HOME.
  assert.equal(
    resolveSpawnModel({ requested: null, profileModel: null, instanceDefault: "opus", dropped: true }),
    "opus",
  );
});

test("resolveSpawnModel: a root/mono agent is NEVER forced a flag", () => {
  // A non-dropped agent reads the server's settings.json itself, so forcing a
  // flag here would change today's behaviour. Stay null → no --model emitted.
  assert.equal(
    resolveSpawnModel({ requested: null, profileModel: null, instanceDefault: "opus", dropped: false }),
    null,
  );
});

test("resolveSpawnModel: dropped but no instance default → null (CLI default)", () => {
  assert.equal(
    resolveSpawnModel({ requested: null, profileModel: null, instanceDefault: null, dropped: true }),
    null,
  );
});

test("resolveSpawnModel: blank/whitespace values are ignored at each level", () => {
  assert.equal(
    resolveSpawnModel({ requested: "  ", profileModel: "  ", instanceDefault: "opus", dropped: true }),
    "opus",
  );
});
