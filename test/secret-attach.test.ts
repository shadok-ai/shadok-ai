import assert from "node:assert/strict";
import test from "node:test";
import { secretAttachVerdict } from "../src/profiles.js";
import { creatorProfile, createAttachRefusal, secretNamesForProfile, type Vault, type SecretEntry } from "../src/secrets.js";
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

// ── Who created it: read off the vault entry, never a name-keyed sidecar ──

const profiles: Record<string, string> = { a1: "Shadok-Marketing", b1: "Shadok-Content" };
const profileOf = (id: string) => profiles[id] ?? null;

test("creator: an agent-created entry resolves to that agent's profile", () => {
  assert.equal(creatorProfile({ createdBy: "agent:a1" }, profileOf), "Shadok-Marketing");
});

test("creator: a person, a missing entry or a vanished agent is NOT a creator", () => {
  // Absence denies: each of these must make the attach refuse.
  assert.equal(creatorProfile({ createdBy: "alice" }, profileOf), null);
  assert.equal(creatorProfile({ createdBy: "" }, profileOf), null);
  assert.equal(creatorProfile(undefined, profileOf), null);
  assert.equal(creatorProfile({ createdBy: "agent:gone" }, profileOf), null);
  assert.equal(creatorProfile({ createdBy: "agent:x" }, () => "   "), null);
});

test("a person's secret re-created under a name an agent once used stays unattachable", () => {
  // The old sidecar kept the agent as "creator" across a delete + re-create by
  // a person, so the agent could then attach the person's new value.
  const v = secretAttachVerdict({
    caller: "Shadok-Marketing",
    name: "ADS_TOKEN",
    inVault: true,
    origin: creatorProfile({ createdBy: "alice" }, profileOf),
  });
  assert.equal(v.ok, false);
});

// ── Create-and-attach in one write (`PUT /secrets {attach: true}`) ─────────

test("create-and-attach: allowed on a creation by an agent with a profile", () => {
  assert.equal(createAttachRefusal({ verdict: "created", callerProfile: "Shadok-Marketing" }), null);
});

test("create-and-attach: never on an overwrite — that would claim someone else's secret", () => {
  assert.match(createAttachRefusal({ verdict: "updated", callerProfile: "Shadok-Marketing" }) ?? "", /creating/);
  assert.notEqual(createAttachRefusal({ verdict: "refused", callerProfile: "Shadok-Marketing" }), null);
});

test("create-and-attach: a caller with no profile (a person, a bare agent) is refused", () => {
  assert.match(createAttachRefusal({ verdict: "created", callerProfile: null }) ?? "", /no profile/);
});

test("the bind lives on the group's entry, so a same-named secret elsewhere is not reached", () => {
  // Why the attach writes `entry.profiles` and not the global profile.secrets
  // list: a name resolves per group, so a profile-level name would also inject
  // group 2's RESEND_KEY into Shadok-Marketing agents running in group 2.
  const entry = (createdBy: string, p: string[]): SecretEntry => ({
    value: createdBy,
    ownerGroup: "",
    sharedWith: [],
    profiles: p,
    createdBy,
    createdAt: 0,
    updatedAt: 0,
  });
  const vault: Vault = {
    "1": { RESEND_KEY: entry("agent:a1", ["Shadok-Marketing"]) },
    "2": { RESEND_KEY: entry("bob", []) },
  };
  assert.deepEqual(secretNamesForProfile(vault, "1", "Shadok-Marketing"), ["RESEND_KEY"]);
  assert.deepEqual(secretNamesForProfile(vault, "2", "Shadok-Marketing"), []);
});
