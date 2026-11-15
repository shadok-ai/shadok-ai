import assert from "node:assert/strict";
import test from "node:test";
import { secretAttachVerdict } from "../src/profiles.js";
import { normalizeOrigins } from "../src/secrets.js";
import { parseArgs } from "../context/secrets-skill/scripts/secret.mjs";

// The whole point of this feature, and its whole danger, live in one function:
// the vault is GLOBAL, so "an agent attaches a secret" is one rule away from
// "any agent grants itself every credential in the house".

test("attaching what you created yourself is allowed", () => {
  const v = secretAttachVerdict({
    caller: "Shadok-Marketing",
    name: "ADS_TOKEN",
    inVault: true,
    origin: "Shadok-Marketing",
  });
  assert.equal(v.ok, true);
});

test("a secret someone ELSE created is refused — that is the escalation", () => {
  // Shadok-Content asking for the marketing token is exactly the move this
  // rule exists to stop: it never held that value.
  const v = secretAttachVerdict({
    caller: "Shadok-Content",
    name: "ADS_TOKEN",
    inVault: true,
    origin: "Shadok-Marketing",
  });
  assert.equal(v.ok, false);
  assert.match(v.error!, /created/i);
});

test("a secret a HUMAN typed has no origin, and stays out of reach", () => {
  // No origin recorded = the web UI or Telegram put it there. An agent must
  // never be able to help itself to it; the human attaches it from the panel.
  const v = secretAttachVerdict({
    caller: "Shadok-dev",
    name: "STRIPE_KEY",
    inVault: true,
    origin: null,
  });
  assert.equal(v.ok, false);
  assert.match(v.error!, /Profiles panel|web/i);
});

test("the lead profile gets no exception", () => {
  // promptEditVerdict lets the lead edit any prompt. Secrets are the one
  // capability it does NOT already have (it can spawn a full-access dev, it
  // cannot hand anyone the vault), so the exception must not be copied here.
  const v = secretAttachVerdict({
    caller: "Shadok-Boss",
    name: "ADS_TOKEN",
    inVault: true,
    origin: "Shadok-Marketing",
  });
  assert.equal(v.ok, false);
});

test("a name that is not in the vault is refused, not silently attached", () => {
  const v = secretAttachVerdict({
    caller: "Shadok-dev",
    name: "TYPO_TOKEN",
    inVault: false,
    origin: null,
  });
  assert.equal(v.ok, false);
  assert.match(v.error!, /vault/i);
});

test("an agent with no profile has nothing to attach to", () => {
  const v = secretAttachVerdict({ caller: null, name: "X", inVault: true, origin: null });
  assert.equal(v.ok, false);
  assert.match(v.error!, /profile/i);
});

test("an empty name is refused", () => {
  const v = secretAttachVerdict({ caller: "Shadok-dev", name: "  ", inVault: true, origin: "Shadok-dev" });
  assert.equal(v.ok, false);
});

// ── The skill's command line ─────────────────────────────────────────────

test("set --attach is opt-in, and --stdin stays mandatory with it", () => {
  assert.deepEqual(parseArgs(["set", "TOK", "--stdin"]), { cmd: "set", name: "TOK", attach: false });
  assert.deepEqual(parseArgs(["set", "TOK", "--stdin", "--attach"]), {
    cmd: "set",
    name: "TOK",
    attach: true,
  });
  // Storing a credential for the team and granting it to yourself are two
  // different acts: the second must be asked for.
  assert.throws(() => parseArgs(["set", "TOK", "--attach"]), /--stdin/);
});

// ── Origin ledger ────────────────────────────────────────────────────────

test("origins: a corrupt or foreign file never throws, it yields nothing", () => {
  assert.deepEqual(normalizeOrigins(null), {});
  assert.deepEqual(normalizeOrigins("nope"), {});
  assert.deepEqual(normalizeOrigins([1, 2]), {});
  assert.deepEqual(normalizeOrigins({ A: 42 }), {});
});

test("origins: only a named profile counts as a creator", () => {
  assert.deepEqual(normalizeOrigins({ A: { profile: "Shadok-dev", at: 1 } }), {
    A: { profile: "Shadok-dev", at: 1 },
  });
  // A blank profile is not a creator — it would make the secret attachable by
  // any agent whose own profile is somehow blank.
  assert.deepEqual(normalizeOrigins({ A: { profile: "   ", at: 1 } }), {});
});
