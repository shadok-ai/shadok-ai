import assert from "node:assert/strict";
import test from "node:test";
import { secretAttachVerdict } from "../src/profiles.js";
import fs from "node:fs";
import { ANY_PROFILE, createAttachRefusal, createProfilesRefusal, creatorProfile, secretNamesForProfile, type SecretEntry, type Vault } from "../src/secrets.js";
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
  assert.deepEqual(parseArgs(["set", "TOK", "--stdin"]), { cmd: "set", name: "TOK", attach: false, profiles: [] });
  assert.deepEqual(parseArgs(["set", "TOK", "--stdin", "--attach"]), {
    cmd: "set",
    name: "TOK",
    attach: true,
    profiles: [],
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

// ── Naming OTHER roles at creation (`--profile`) ───────────────────────────
// The wider half of the same boundary: `createAttachRefusal` binds to the
// caller's own profile, `createProfilesRefusal` to roles it does not run. What
// makes it safe is still provenance plus the MOMENT — a creation, where the
// caller is the only holder of the value.

test("naming roles at CREATION is allowed: the caller is the only one holding the value", () => {
  assert.equal(
    createProfilesRefusal({
      verdict: "created",
      asked: ["Importer", "Reviewer"],
      known: ["Importer", "Reviewer", "Shadok-dev"],
      boxed: false,
      externalDoorProfiles: [],
    }),
    null,
  );
});

test("asking for nothing decides nothing — an ordinary `set` is untouched", () => {
  for (const verdict of ["created", "updated", "refused"] as const)
    assert.equal(
      createProfilesRefusal({ verdict, asked: [], known: [], boxed: true, externalDoorProfiles: ["Guest"] }),
      null,
    );
});

test("re-binding an EXISTING secret is refused — by then it is not only yours to move", () => {
  const r = createProfilesRefusal({
    verdict: "updated",
    asked: ["Importer"],
    known: ["Importer"],
    boxed: false,
    externalDoorProfiles: [],
  });
  assert.match(r ?? "", /created/);
});

test("a GUEST's agent names no role: a stranger does not decide who gets a credential", () => {
  // Its own slice is never bound to a profile either (`guestSliceWriteRefusal`),
  // but this refusal is asked FIRST so the answer is about who asked.
  const r = createProfilesRefusal({
    verdict: "created",
    asked: ["Importer"],
    known: ["Importer"],
    boxed: true,
    externalDoorProfiles: [],
  });
  assert.match(r ?? "", /guest/i);
});

test("an unknown role is refused, and NAMED — a stored binding that reaches nobody is worse", () => {
  const r = createProfilesRefusal({
    verdict: "created",
    asked: ["Importer", "Typo"],
    known: ["Importer"],
    boxed: false,
    externalDoorProfiles: [],
  });
  assert.match(r ?? "", /"Typo"/);
  // Refused in FULL: a list narrowed to the acceptable names would read as
  // "bound" while the role that mattered got nothing.
  assert.doesNotMatch(r ?? "", /^$/);
});

test("the role an EXTERNAL door's guests run on receives nothing — the save-time rule's back door", () => {
  // `guestEnableRefusal` refuses to SAVE an external door onto a profile that
  // carries a secret (every guest runs the same profile). Without this, a
  // creation could park one there afterwards and walk around that check.
  const r = createProfilesRefusal({
    verdict: "created",
    asked: ["Concierge"],
    known: ["Concierge", "Importer"],
    boxed: false,
    externalDoorProfiles: ["Concierge"],
  });
  assert.match(r ?? "", /stranger/i);
  // A door profile among valid ones still sinks the whole call.
  assert.notEqual(
    createProfilesRefusal({
      verdict: "created",
      asked: ["Importer", "Concierge"],
      known: ["Concierge", "Importer"],
      boxed: false,
      externalDoorProfiles: ["Concierge"],
    }),
    null,
  );
});

// A field accepted is not a field USED (invariant 24): `profiles` is a plain
// key on a JSON body, and nothing in the types proves the handler read it.
test("PUT /secrets really wires the named roles: refusal, seal, store and audit", () => {
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const start = src.indexOf('app.put("/secrets", (req, res) => {');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("\n});\n", start));
  // Read off the body, decided by the pure core, with the box read from the key.
  assert.match(body, /const \{ name, value, overwrite, attach, profiles \} = req\.body/);
  assert.match(body, /createProfilesRefusal\(\{/);
  assert.match(body, /boxed: !!requestAgent\(req, loadChannels\(\)\)\?\.boxed/);
  assert.match(body, /externalDoorProfiles: externalDoorProfiles\(\)/);
  // The same two seals the panel's own route applies, with the same `bind` op.
  assert.match(body, /guestSliceWriteRefusal\(\{ unit: ownerGroup, op: "bind"/);
  assert.match(body, /externalGroupSecretRefusal\(\{ unit: ownerGroup[\s\S]*?op: "bind" \}\)/);
  // ONE write, carrying both halves of the binding.
  assert.match(body, /setSecret\(key, value, ownerGroup, secretCreatedBy\(req\), bindTo\)/);
  // One audit row per role: which agents receive a credential is the point of
  // that log, so a second role must not land unrecorded.
  assert.match(body, /for \(const prof of bindTo\)\s*\n\s*recordSecretAudit\(\{ action: "attached"/);
});

test("the external-door profiles are read from BOTH doors, open or shut", () => {
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const start = src.indexOf("function externalDoorProfiles(): string[] {");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /guestSetupForCwd\(cfg, cwd\), waGuestSetupForCwd\(cfg, cwd\)/);
  // EXTERNAL only: that is where the rule comes from, and a restricted door's
  // guests are known people, for whom the panel has always allowed it.
  assert.match(body, /nature === "external"/);
  // No `joined`/open test anywhere in it: a door shut today reopens on the
  // same profile, and a credential parked there would wait for the stranger.
  assert.doesNotMatch(body, /joined|guestsOpen/);
});

test("the skill carries the roles: `--profile` is repeatable, and needs a value", () => {
  assert.deepEqual(parseArgs(["set", "K", "--stdin", "--profile", "Importer", "--profile=Reviewer"]), {
    cmd: "set",
    name: "K",
    attach: false,
    profiles: ["Importer", "Reviewer"],
  });
  // Deduped, so a repeated name is not two audit rows.
  assert.deepEqual(parseArgs(["set", "K", "--stdin", "--profile", "A", "--profile", "A"]).profiles, ["A"]);
  // A flag swallowing the next flag is how `--profile --stdin` would store a
  // role named "--stdin" and drop the required pipe.
  assert.throws(() => parseArgs(["set", "K", "--stdin", "--profile", "--attach"]), /profile name/);
  assert.throws(() => parseArgs(["set", "K", "--stdin", "--profile"]), /profile name/);
  assert.throws(() => parseArgs(["set", "K", "--stdin", "--profile="]), /profile name/);
  // The name is still the one positional, not the first thing after a flag.
  assert.equal(parseArgs(["set", "K", "--stdin", "--profile", "A"]).name, "K");
});

test('"*" is refused BY NAME, not as a typo: it is the one value that reaches everyone', () => {
  // `ANY_PROFILE` injects into every agent the secret resolves for — for a
  // commons secret, every agent on the instance. It is not a profile name, so
  // the existence check would answer "no profile named *", which reads as a
  // misspelling instead of a boundary.
  const r = createProfilesRefusal({
    verdict: "created",
    asked: ["Importer", ANY_PROFILE],
    known: ["Importer"],
    boxed: false,
    externalDoorProfiles: [],
  });
  assert.match(r ?? "", /every profile/i);
  assert.doesNotMatch(r ?? "", /no profile named/);
});
