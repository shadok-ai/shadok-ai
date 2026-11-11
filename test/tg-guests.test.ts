import assert from "node:assert/strict";
import test from "node:test";

import { BOOTSTRAP_ADMIN } from "../src/accounts.js";
import { applyGuestSetup, guestSetupForCwd, type Config } from "../src/config.js";
import type { Group } from "../src/groups.js";
import {
  dmOnly,
  groupChatRefusal,
  guestCallbackAllowed,
  guestCommandCarriesSecret,
  guestCommandRefusal,
  guestEnableRefusal,
  guestNotice,
  guestOpeningPrompt,
  guestGroupChoices,
  guestPatchFlow,
  guestSpawnPlan,
  guestsOpen,
  normalizeGuestSetup,
  normalizeTgMode,
  ownerAdoptionCandidate,
  withInstanceMember,
} from "../src/tg-guests.js";

const CWD = "/srv/one";
const group = (over: Partial<Group> & Pick<Group, "id" | "nature">): Group => ({
  name: over.id,
  members: [],
  osUser: null,
  createdAt: 0,
  ...over,
});

const GUESTS = group({ id: "g1", nature: "restricted", name: "Guests", members: ["ada"], osUser: "sk-g1" });
const MAIN = group({ id: "main", nature: "public", name: "main" });
const PERSONAL = group({ id: "p1", nature: "private", name: "Ada", owner: "ada", members: ["ada"], osUser: "sk-p1" });
const GROUPS = [MAIN, GUESTS, PERSONAL];

const refusal = (over: Partial<Parameters<typeof guestEnableRefusal>[0]> = {}) =>
  guestEnableRefusal({
    mode: "multi-tenant",
    want: { mode: "group+dm", group: "g1", profile: "Support" },
    groups: GROUPS,
    profileExists: (n) => n === "Support",
    hasOwner: true,
    ...over,
  });

test("guestEnableRefusal: a restricted group and a known profile is allowed", () => {
  assert.equal(refusal(), null);
});

test("guestEnableRefusal: going back to the classic mode is always allowed, even with nothing named", () => {
  // The way out must never be blocked by the same checks as the way in — an
  // operator closing their bot cannot be asked to fix a stale group first.
  assert.equal(refusal({ want: { mode: "group", group: null, profile: null } }), null);
  assert.equal(refusal({ want: { mode: "group", group: null, profile: null }, mode: "mono-tenant" }), null);
});

test("guestEnableRefusal: both fields are required by either open mode", () => {
  assert.match(String(refusal({ want: { mode: "dm-only", group: null, profile: "Support" } })), /group/i);
  assert.match(String(refusal({ want: { mode: "dm-only", group: "g1", profile: null } })), /profile/i);
  assert.match(String(refusal({ want: { mode: "group+dm", group: null, profile: "Support" } })), /group/i);
  assert.match(String(refusal({ want: { mode: "group+dm", group: "g1", profile: null } })), /profile/i);
  assert.match(String(refusal({ want: { mode: "group+dm", group: "g1", profile: "   " } })), /profile/i);
});

test("guestEnableRefusal: outside multi-tenant there is no group that could hold guests", () => {
  const r = refusal({ mode: "mono-tenant" });
  assert.equal(r, "isolation requires the privileged deployment");
});

test("guestEnableRefusal: an unknown group, a public one and a personal one are all refused", () => {
  assert.match(String(refusal({ want: { mode: "group+dm", group: "nope", profile: "Support" } })), /no such group/i);
  assert.match(String(refusal({ want: { mode: "group+dm", group: "main", profile: "Support" } })), /restricted/i);
  // A personal group is sealed and the bridge could never be a member of it.
  assert.match(String(refusal({ want: { mode: "group+dm", group: "p1", profile: "Support" } })), /personal/i);
});

test("guestEnableRefusal: the bot's DMs must be PAIRED first for group+dm", () => {
  // `dmGate` answers `pair` while the bot has no owner, so a stranger would get
  // the pairing refusal instead of an agent — and that ordering is what stops
  // the first person through an open door from claiming the bot. Enabling
  // before pairing would save a door that cannot open.
  const r = String(refusal({ hasOwner: false }));
  assert.match(r, /pair/i);
  // Switching off is still allowed with no owner: the way out is never gated.
  assert.equal(refusal({ hasOwner: false, want: { mode: "group", group: "g1", profile: "Support" } }), null);
  // And the way the message points is a real way out, not a dead end.
  assert.match(r, /DMs only/);
});

test("guestEnableRefusal: dm-only needs NO pairing — it is the mode without an owner", () => {
  // Nobody pairs in that mode, so there is no claim left to lose: requiring a
  // pairing would be exactly the prerequisite it exists to delete.
  assert.equal(refusal({ hasOwner: false, want: { mode: "dm-only", group: "g1", profile: "Support" } }), null);
  // Everything else still holds: the group must be one that can hold people.
  assert.match(
    String(refusal({ hasOwner: false, want: { mode: "dm-only", group: "main", profile: "Support" } })),
    /restricted/i,
  );
  assert.equal(
    refusal({ hasOwner: false, mode: "mono-tenant", want: { mode: "dm-only", group: "g1", profile: "Support" } }),
    "isolation requires the privileged deployment",
  );
});

test("guestPatchFlow: enabling with no owner writes nothing", () => {
  const r = flow({ hasOwner: false });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 400);
  assert.match(r.error, /pair/i);
});

test("guestEnableRefusal: an unknown profile is refused by name", () => {
  const r = String(refusal({ want: { mode: "group+dm", group: "g1", profile: "Ghost" } }));
  assert.match(r, /Ghost/);
});

test("guestGroupChoices: restricted groups the viewer belongs to, and nothing else", () => {
  const ada = guestGroupChoices(GROUPS, { name: "ada", role: "member" });
  assert.deepEqual(ada.map((g) => g.id), ["g1"]);
  // Not a member: the group is not offered (and a public/personal one never is).
  assert.deepEqual(guestGroupChoices(GROUPS, { name: "bob", role: "admin" }).map((g) => g.id), []);
  assert.deepEqual(guestGroupChoices(GROUPS, null).map((g) => g.id), []);
  // An AGENT principal is judged on its own channel's group, never by name.
  assert.deepEqual(guestGroupChoices(GROUPS, { name: "ada", role: "admin", agentGroup: "g1" }).map((g) => g.id), ["g1"]);
});

test("withInstanceMember: adds the instance once, removes it, and leaves every other group alone", () => {
  const added = withInstanceMember(GROUPS, "g1", true);
  assert.deepEqual(added.find((g) => g.id === "g1")!.members, ["ada", BOOTSTRAP_ADMIN]);
  // Idempotent: enabling twice must not duplicate the member.
  assert.deepEqual(withInstanceMember(added, "g1", true).find((g) => g.id === "g1")!.members, ["ada", BOOTSTRAP_ADMIN]);
  const removed = withInstanceMember(added, "g1", false);
  assert.deepEqual(removed.find((g) => g.id === "g1")!.members, ["ada"]);
  // Other rows are untouched, and the input array is not mutated.
  assert.deepEqual(added.find((g) => g.id === "main")!.members, []);
  assert.deepEqual(GUESTS.members, ["ada"]);
});

test("withInstanceMember: an unknown group id changes nothing", () => {
  assert.deepEqual(withInstanceMember(GROUPS, "nope", true), GROUPS);
});

test("guest setup: stored per launch dir, two directories independent", () => {
  let cfg: Config = {};
  assert.deepEqual(guestSetupForCwd(cfg, CWD), { mode: "group", group: null, profile: null });
  cfg = applyGuestSetup(cfg, CWD, { mode: "group+dm", group: "g1", profile: "Support" });
  cfg = applyGuestSetup(cfg, "/srv/two", { mode: "group+dm", group: "g9", profile: "Other" });
  assert.deepEqual(guestSetupForCwd(cfg, CWD), { mode: "group+dm", group: "g1", profile: "Support" });
  assert.deepEqual(guestSetupForCwd(cfg, "/srv/two"), { mode: "group+dm", group: "g9", profile: "Other" });
});

test("guest setup: turning it off KEEPS the group and profile, so re-enabling needs no retyping", () => {
  let cfg: Config = applyGuestSetup({}, CWD, { mode: "group+dm", group: "g1", profile: "Support" });
  cfg = applyGuestSetup(cfg, CWD, { mode: "group", group: "g1", profile: "Support" });
  assert.deepEqual(guestSetupForCwd(cfg, CWD), { mode: "group", group: "g1", profile: "Support" });
});

test("guest setup: `joined` survives the round trip, and is absent when false", () => {
  const cfg = applyGuestSetup({}, CWD, { mode: "group+dm", group: "g1", profile: "Support", joined: true });
  assert.equal(guestSetupForCwd(cfg, CWD).joined, true);
  const off = applyGuestSetup({}, CWD, { mode: "group+dm", group: "g1", profile: "Support" });
  assert.equal("joined" in off.telegramGuests![CWD], false);
});

test("guest setup: a malformed stored row reads as OFF rather than throwing", () => {
  // The file is hand-editable; a half-written row must never open the door.
  const cfg = { telegramGuests: { [CWD]: { mode: "group+dm", group: 42, profile: null } } } as unknown as Config;
  assert.deepEqual(guestSetupForCwd(cfg, CWD), { mode: "group", group: null, profile: null });
});

// ── guestPatchFlow: the whole PUT decision, transport-free ────────────────
// Same shape as createGroupFlow/groupsPutFlow: the route is a thin mapper, so
// the behaviour is unit-tested with no server (server.ts is un-importable).

const flow = (over: Partial<Parameters<typeof guestPatchFlow>[0]> = {}) =>
  guestPatchFlow({
    mode: "multi-tenant",
    previous: { mode: "group", group: null, profile: null },
    want: { mode: "group+dm", group: "g1", profile: "Support" },
    groups: GROUPS,
    profileExists: (n) => n === "Support" || n === "Other",
    hasOwner: true,
    ...over,
  });

test("guestPatchFlow: enabling writes the setup and puts the instance in the group", () => {
  const r = flow();
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // `joined`: this flow is what put the instance there, so closing may undo it.
  assert.deepEqual(r.setup, { mode: "group+dm", group: "g1", profile: "Support", joined: true });
  assert.deepEqual(r.groups.find((g) => g.id === "g1")!.members, ["ada", BOOTSTRAP_ADMIN]);
});

test("guestPatchFlow: disabling takes the instance back out", () => {
  const r = flow({
    previous: { mode: "group+dm", group: "g1", profile: "Support", joined: true },
    want: { mode: "group", group: "g1", profile: "Support" },
    groups: withInstanceMember(GROUPS, "g1", true),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.groups.find((g) => g.id === "g1")!.members, ["ada"]);
  // The group and the profile survive the switch-off: re-enabling needs no retyping.
  assert.deepEqual(r.setup, { mode: "group", group: "g1", profile: "Support" });
});

test("guestPatchFlow: changing group MOVES the membership, leaving none behind", () => {
  const second = group({ id: "g2", nature: "restricted", name: "Clients", members: ["ada"], osUser: "sk-g2" });
  const r = flow({
    previous: { mode: "group+dm", group: "g1", profile: "Support", joined: true },
    want: { mode: "group+dm", group: "g2", profile: "Support" },
    groups: withInstanceMember([...GROUPS, second], "g1", true),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.groups.find((g) => g.id === "g1")!.members, ["ada"]);
  assert.deepEqual(r.groups.find((g) => g.id === "g2")!.members, ["ada", BOOTSTRAP_ADMIN]);
  assert.equal(r.setup.joined, true);
});

// The instance's account IS the human admin's own (BOOTSTRAP_ADMIN). A group they
// already belonged to must keep them when the door closes or moves — removing
// them unconditionally emptied the roster of a group they were alone in, which
// left it invisible to everyone and impossible to delete.
test("guestPatchFlow: a membership the admin already had is never taken away", () => {
  const mine = group({ id: "g3", nature: "restricted", name: "Patients", members: [BOOTSTRAP_ADMIN], osUser: "sk-g3" });
  const opened = flow({ want: { mode: "group+dm", group: "g3", profile: "Support" }, groups: [...GROUPS, mine] });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.setup.joined, undefined, "nothing was added, so nothing is ours to undo");
  for (const want of [
    { mode: "group" as const, group: "g3", profile: "Support" },
    { mode: "group+dm" as const, group: "g1", profile: "Support" },
  ]) {
    const closed = flow({ previous: opened.setup, want, groups: opened.groups });
    assert.equal(closed.ok, true);
    if (!closed.ok) return;
    assert.deepEqual(closed.groups.find((g) => g.id === "g3")!.members, [BOOTSTRAP_ADMIN]);
  }
});

test("guestPatchFlow: a setup saved before `joined` existed removes no one", () => {
  const r = flow({
    previous: { mode: "group+dm", group: "g1", profile: "Support" },
    want: { mode: "group", group: "g1", profile: "Support" },
    groups: withInstanceMember(GROUPS, "g1", true),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.groups.find((g) => g.id === "g1")!.members, ["ada", BOOTSTRAP_ADMIN]);
});

test("withInstanceMember never takes the last member out of a restricted group", () => {
  const alone = group({ id: "g4", nature: "restricted", name: "Solo", members: [BOOTSTRAP_ADMIN], osUser: "sk-g4" });
  assert.deepEqual(withInstanceMember([alone], "g4", false)[0].members, [BOOTSTRAP_ADMIN]);
});

test("guestPatchFlow: a refused patch is a 400 that writes NOTHING", () => {
  const r = flow({ want: { mode: "group+dm", group: "main", profile: "Support" } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 400);
  assert.match(r.error, /restricted/);
  assert.ok(!("groups" in r), "a refusal carries no group list to save");
});

test("guestPatchFlow: whitespace is trimmed, and a blank profile cannot enable", () => {
  const r = flow({ want: { mode: "group+dm", group: " g1 ", profile: " Support " } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.setup, { mode: "group+dm", group: "g1", profile: "Support", joined: true });
  assert.equal(flow({ want: { mode: "group+dm", group: "g1", profile: " " } }).ok, false);
});

// ── guestSpawnPlan: the trust decision behind a guest's spawn ─────────────

const ON: Parameters<typeof guestSpawnPlan>[0]["setup"] = { mode: "group+dm", group: "g1", profile: "Support" };
const plan = (over: Partial<Parameters<typeof guestSpawnPlan>[0]> = {}) =>
  guestSpawnPlan({ marker: true, fromBridge: true, resuming: false, setup: ON, ...over });

test("guestSpawnPlan: the bridge's marker on a new session resolves the configured group and profile", () => {
  assert.deepEqual(plan(), { kind: "guest", group: "g1", profile: "Support" });
});

test("guestSpawnPlan: an UNPROVEN marker is ignored, never refused", () => {
  // Any Origin-less loopback client can send anything (invariant 11). What it
  // sends is simply not a guest's spawn — and an error would tell it something
  // about the instance it has no business learning.
  assert.deepEqual(plan({ fromBridge: false }), { kind: "not-a-guest" });
  // A marker that is not literally `true` is not a marker.
  assert.deepEqual(plan({ marker: "yes" }), { kind: "not-a-guest" });
  assert.deepEqual(plan({ marker: 1 }), { kind: "not-a-guest" });
  assert.deepEqual(plan({ marker: undefined }), { kind: "not-a-guest" });
});

test("guestSpawnPlan: a marker on a RESUME is ignored — the stored group is the authority", () => {
  // Otherwise the frame would be a way to move an existing agent across the
  // people wall (invariant 1, and `canResumeAs` guards the rest).
  assert.deepEqual(plan({ resuming: true }), { kind: "not-a-guest" });
});

test("guestSpawnPlan: the bridge proved itself and the door is shut → a named refusal", () => {
  for (const setup of [
    { mode: "group", group: "g1", profile: "Support" },
    { mode: "group+dm", group: null, profile: "Support" },
    { mode: "group+dm", group: "g1", profile: null },
    { mode: "group+dm", group: "  ", profile: "Support" },
  ]) {
    const r = plan({ setup });
    assert.equal(r.kind, "refused");
    if (r.kind !== "refused") return;
    assert.equal(r.code, "guest-closed");
    // The reason reaches a person, so it must not name internals.
    assert.doesNotMatch(r.message, /group|profile|config/i);
  }
});

// ── what a guest may do ───────────────────────────────────────────────────

test("guestCommandRefusal: every command is refused, with one deliberate exception", () => {
  assert.equal(guestCommandRefusal(null), null);
  // Telegram sends /start on its own when someone opens the bot: refusing it
  // would make the refusal the bot's first words.
  assert.equal(guestCommandRefusal("start"), null);
  for (const c of ["secret", "spawn", "stop", "end", "tools", "new", "login", "setup", "whatever"]) {
    assert.match(String(guestCommandRefusal(c)), /can't run commands/i, c);
  }
});

test("guestOpeningPrompt: Telegram's own /start opens the conversation, in the AGENT's voice", () => {
  const p = guestOpeningPrompt("fr");
  // It is an instruction to the agent, not a line anyone is shown — and the
  // welcome itself comes from the profile, so nothing here writes one.
  assert.match(p, /greet them/i);
  assert.match(p, /ask what they need/i);
  assert.match(p, /do not mention this instruction/i);
  // The language is the only clue there is before a first word is written.
  assert.match(p, /"fr"/);
  // No cockpit vocabulary: this text ends up in a stranger's conversation.
  assert.doesNotMatch(p, /shadok|cockpit|operator|session|profile|command|\/start/i);
});

test("guestOpeningPrompt: no language, no invented one — and nothing unbounded", () => {
  const p = guestOpeningPrompt(undefined);
  assert.doesNotMatch(p, /language/i);
  assert.equal(guestOpeningPrompt(42), p, "a non-string is no language");
  // Telegram's field is short; a hostile one must not become the whole prompt.
  assert.ok(guestOpeningPrompt("x".repeat(500)).includes("x".repeat(16)));
  assert.ok(!guestOpeningPrompt("x".repeat(500)).includes("x".repeat(17)));
});

test("guestCommandRefusal: the line names no cockpit internals", () => {
  const line = String(guestCommandRefusal("spawn"));
  assert.doesNotMatch(line, /operator|owner|agent|shadok|profile|group/i);
});

test("guestCommandCarriesSecret: a refused value-carrying command must be deleted", () => {
  assert.equal(guestCommandCarriesSecret("secret"), true);
  assert.equal(guestCommandCarriesSecret("code"), true);
  assert.equal(guestCommandCarriesSecret("mtcode"), true);
  assert.equal(guestCommandCarriesSecret("spawn"), false);
  assert.equal(guestCommandCarriesSecret(null), false);
});

test("guestCallbackAllowed: a guest answers their OWN agent's question", () => {
  // Without this the first AskUserQuestion wedges the conversation for good.
  assert.equal(guestCallbackAllowed("guest", 4242, 4242), true);
  assert.equal(guestCallbackAllowed("allow", -100, 7), true);
});

test("guestCallbackAllowed: nothing else gets through", () => {
  // Someone else's DM (a shape Telegram does not produce — asserted, not trusted).
  assert.equal(guestCallbackAllowed("guest", 4242, 9999), false);
  assert.equal(guestCallbackAllowed("guest", 4242, undefined), false);
  assert.equal(guestCallbackAllowed("guest", undefined, 4242), false);
  assert.equal(guestCallbackAllowed("deny", 4242, 4242), false);
  assert.equal(guestCallbackAllowed("pair", 4242, 4242), false);
});

// ── the cockpit's own voice, as a guest hears it ──────────────────────────

test("guestNotice: what a guest cannot act on is dropped", () => {
  assert.equal(guestNotice("exited"), null);
  assert.equal(guestNotice("upload-failed"), null);
  assert.equal(guestNotice("tool-activity"), null);
});

test("guestNotice: anything meaning 'your message is lost' is REWRITTEN, never dropped", () => {
  // Silence here is the one outcome we cannot have: the person waits for an
  // answer that is never coming.
  for (const kind of ["pace-blocked", "error", "preempt-failed", "no-keyboard"] as const) {
    const line = guestNotice(kind);
    assert.ok(line, kind);
    assert.match(String(line), /\S/);
  }
});

test("guestNotice: the words a guest hears name nothing of the cockpit", () => {
  for (const kind of ["pace-blocked", "error", "preempt-failed", "no-keyboard"] as const) {
    const line = String(guestNotice(kind));
    assert.doesNotMatch(line, /pace|guard|quota|session|agent|shadok|cockpit|web UI|\/stop|profile|group/i, kind);
  }
});

// ── a guest must never be adopted as the bot's owner ──────────────────────

test("ownerAdoptionCandidate: an ordinary DM binding is adoptable", () => {
  assert.equal(ownerAdoptionCandidate({ telegram: { chatId: 4242 }, group: null }, "g1"), 4242);
  assert.equal(ownerAdoptionCandidate({ telegram: { chatId: 4242 }, group: "main" }, null), 4242);
});

test("ownerAdoptionCandidate: a GUEST's DM is NOT — it has the same shape", () => {
  // Otherwise an instance that lost its owner file would hand the bot to
  // whichever stranger came first in the channel list.
  assert.equal(ownerAdoptionCandidate({ telegram: { chatId: 9999 }, group: "g1" }, "g1"), null);
});

test("ownerAdoptionCandidate: a topic and a group chat are never DMs", () => {
  assert.equal(ownerAdoptionCandidate({ telegram: { chatId: 4242, threadId: 7 } }, "g1"), null);
  assert.equal(ownerAdoptionCandidate({ telegram: { chatId: -100500 } }, "g1"), null);
  assert.equal(ownerAdoptionCandidate({ telegram: null }, "g1"), null);
  assert.equal(ownerAdoptionCandidate({}, "g1"), null);
});

test("guestEnableRefusal: the most fundamental blocker speaks first", () => {
  // On an instance that can never host a guest, "pair your DMs" would be a
  // wasted errand — so the capability is named before the pairing.
  const r = String(refusal({ mode: "mono-tenant", hasOwner: false }));
  assert.equal(r, "isolation requires the privileged deployment");
});

// ── the mode: where this bot works ───────────────────────────────────────
// Three answers, and `group` is the one that changes nothing — so anything
// unrecognised must land there rather than on an open door.

test("normalizeTgMode: the three modes pass through, everything else is the classic one", () => {
  for (const m of ["group", "group+dm", "dm-only"] as const) assert.equal(normalizeTgMode(m), m);
  for (const bad of [undefined, null, "", "dm", "DM-ONLY", true, 1, {}])
    assert.equal(normalizeTgMode(bad), "group", String(bad));
});

test("guestsOpen / dmOnly: a mode with nowhere to put people is not an open door", () => {
  assert.equal(guestsOpen({ mode: "group", group: "g1", profile: "Support" }), false);
  assert.equal(guestsOpen({ mode: "group+dm", group: "g1", profile: "Support" }), true);
  assert.equal(guestsOpen({ mode: "dm-only", group: "g1", profile: "Support" }), true);
  // The three fields are solidary: no group or no profile is no door.
  assert.equal(guestsOpen({ mode: "dm-only", group: null, profile: "Support" }), false);
  assert.equal(guestsOpen({ mode: "group+dm", group: "g1", profile: "  " }), false);
  assert.equal(dmOnly({ mode: "dm-only", group: "g1", profile: "Support" }), true);
  assert.equal(dmOnly({ mode: "group+dm", group: "g1", profile: "Support" }), false);
  assert.equal(dmOnly({ mode: "dm-only", group: null, profile: null }), false);
});

test("normalizeGuestSetup: a half-written open mode falls back to the CLASSIC one", () => {
  // Not to a closed version of itself: a `dm-only` with nowhere to put people
  // would answer neither a group nor a DM — a bot that silently does nothing.
  assert.deepEqual(normalizeGuestSetup({ mode: "dm-only", group: null, profile: "Support" }), {
    mode: "group",
    group: null,
    profile: "Support",
  });
  assert.deepEqual(normalizeGuestSetup({ mode: "nope" as never, group: " g1 ", profile: " S " }), {
    mode: "group",
    group: "g1",
    profile: "S",
  });
});

test("groupChatRefusal: only the DM-only instance turns a group away", () => {
  assert.equal(groupChatRefusal({ mode: "group", group: null, profile: null }), null);
  assert.equal(groupChatRefusal({ mode: "group+dm", group: "g1", profile: "Support" }), null);
  const line = String(groupChatRefusal({ mode: "dm-only", group: "g1", profile: "Support" }));
  assert.match(line, /private messages/i);
  // Whoever added the bot to their group is not an operator: no internals, and
  // no command they are not allowed to run anyway.
  assert.doesNotMatch(line, /setup|shadok|board|agent|profile|group|cockpit/i);
});

test("guest setup: a row written before the mode existed reads as group+dm", () => {
  // `on: true` was exactly that mode. The migration is a READ: nothing rewrites
  // the file until the panel saves.
  const legacy = { telegramGuests: { [CWD]: { on: true, group: "g1", profile: "Support" } } } as Config;
  assert.deepEqual(guestSetupForCwd(legacy, CWD), { mode: "group+dm", group: "g1", profile: "Support" });
  const off = { telegramGuests: { [CWD]: { on: false, group: "g1", profile: "Support" } } } as Config;
  assert.deepEqual(guestSetupForCwd(off, CWD), { mode: "group", group: "g1", profile: "Support" });
  // An explicit mode always wins over the compat field.
  const both = { telegramGuests: { [CWD]: { mode: "dm-only", on: false, group: "g1", profile: "S" } } } as Config;
  assert.equal(guestSetupForCwd(both, CWD).mode, "dm-only");
});

test("guest setup: what is written stays readable by a server that predates the mode", () => {
  const cfg = applyGuestSetup({}, CWD, { mode: "dm-only", group: "g1", profile: "Support" });
  assert.deepEqual(cfg.telegramGuests?.[CWD], { mode: "dm-only", on: true, group: "g1", profile: "Support" });
  const classic = applyGuestSetup({}, CWD, { mode: "group", group: "g1", profile: "Support" });
  assert.equal(classic.telegramGuests?.[CWD]?.on, false);
});

test("guestPatchFlow: switching between the two open modes keeps the membership", () => {
  const r = flow({
    previous: { mode: "group+dm", group: "g1", profile: "Support" },
    want: { mode: "dm-only", group: "g1", profile: "Support" },
    groups: withInstanceMember(GROUPS, "g1", true),
    hasOwner: false,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.setup, { mode: "dm-only", group: "g1", profile: "Support" });
  assert.deepEqual(r.groups.find((g) => g.id === "g1")!.members, ["ada", BOOTSTRAP_ADMIN]);
});

test("guestPatchFlow: coming back to the classic mode takes the instance out", () => {
  const r = flow({
    previous: { mode: "dm-only", group: "g1", profile: "Support", joined: true },
    want: { mode: "group", group: "g1", profile: "Support" },
    groups: withInstanceMember(GROUPS, "g1", true),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.groups.find((g) => g.id === "g1")!.members, ["ada"]);
});

test("guestSpawnPlan: a dm-only instance spawns guests like group+dm does", () => {
  assert.deepEqual(plan({ setup: { mode: "dm-only", group: "g1", profile: "Support" } }), {
    kind: "guest",
    group: "g1",
    profile: "Support",
  });
});
