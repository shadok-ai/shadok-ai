import assert from "node:assert/strict";
import test from "node:test";
import { readGround, type GroundEntry, type ListDir } from "../src/ground.js";
import {
  UNIVERSAL_OFFER,
  fittingOffer,
  greetingProfiles,
  greetingRegister,
  groundFacts,
  homeGreetingBrief,
} from "../src/greeting.js";
import { BOSS_PROFILE_NAME, DEFAULT_PROFILES, TWEAK_PROFILE_NAME, type Profile } from "../src/profiles.js";
import { MANAGED_PROFILES } from "../public/profile-card.js";

/** Same fixture idea as test/ground.test.ts: a directory SHAPE, never a disk. */
function shape(dirs: Record<string, string[]>): ListDir {
  return (rel) =>
    (dirs[rel] ?? []).map((n): GroundEntry => ({ name: n.replace(/\/$/, ""), dir: n.endsWith("/") }));
}

const NODE_CI = readGround(
  shape({
    "": ["package.json", "src/", "CLAUDE.md", "README.md", ".git", ".github/"],
    ".github/workflows": ["ci.yml"],
  }),
);
const XCODE_REPO = readGround(shape({ "": ["Shadok.xcodeproj/", "Shadok/", ".git/"] }));
const STACK_NO_VCS = readGround(shape({ "": ["Gemfile", "app/", "README.md"] }));
const PROSE_REPO = readGround(shape({ "": [".git/", "notes.md", "README.md"] }));
const NOTHING = readGround(shape({ "": ["draft.txt", "README.md"] }));
const EMPTY = readGround(shape({ "": [] }));

// --- The register ------------------------------------------------------------

test("a stack plus a mechanism that fits earns the specific register", () => {
  assert.equal(greetingRegister(NODE_CI), "specific");
  assert.equal(greetingRegister(XCODE_REPO), "specific");
});

test("something recognised but nothing that fits asks instead — an INFORMED question", () => {
  // A Gemfile says what the project builds with and nothing at all about what
  // would help: no version control, so no worktree; no CI, so nothing to watch.
  assert.equal(greetingRegister(STACK_NO_VCS), "informed");
  // A repo of prose is recognised (it has git) while its stack stays honestly
  // unknown — ground.ts keeps those two answers apart precisely for this.
  assert.equal(greetingRegister(PROSE_REPO), "informed");
  assert.equal(fittingOffer(STACK_NO_VCS), null);
  assert.equal(fittingOffer(PROSE_REPO), null);
});

test("nothing recognisable, and an empty directory, both speak honestly", () => {
  assert.equal(greetingRegister(NOTHING), "honest");
  assert.equal(greetingRegister(EMPTY), "honest");
  // A README is prose, not recognition: it must never buy its way into an offer.
  assert.deepEqual(NOTHING.conventions, ["README.md"]);
  assert.equal(fittingOffer(NOTHING), null);
  assert.equal(fittingOffer(EMPTY), null);
});

test("an offer never rests on anything but a marker that was really seen", () => {
  const ci = fittingOffer(NODE_CI);
  assert.ok(ci);
  assert.ok(ci.because.includes(".github/workflows"), ci.because);
  const xc = fittingOffer(XCODE_REPO);
  assert.ok(xc);
  assert.ok(xc.because.includes("Shadok.xcodeproj"), xc.because);
});

// --- The facts ---------------------------------------------------------------

test("the facts name the marker the directory spells, not a category word", () => {
  const facts = groundFacts(XCODE_REPO, "Shadok").join("\n");
  assert.ok(facts.includes("Shadok.xcodeproj"), facts);
  assert.ok(!facts.includes("xcode\n"), "the category word must not stand in for the file");
});

test("an unrecognised directory says so, and says a README does not count", () => {
  const facts = groundFacts(NOTHING, "notes").join("\n");
  assert.ok(/nothing here was recognised/i.test(facts), facts);
  assert.ok(/README.*not recognition/i.test(facts), facts);
});

// --- The profile list --------------------------------------------------------

const MINTED: Profile = {
  name: "Ops-Runbook",
  systemPrompt: "You are Ops-Runbook, the on-call agent. Read the runbooks and answer incidents.",
};

test("the greeting enumerates the profiles this cockpit really holds", () => {
  const brief = homeGreetingBrief({
    ground: NODE_CI,
    profiles: [...DEFAULT_PROFILES, MINTED],
    dirName: "shadok-ai",
  });
  // A role minted after this file was written appears with nobody editing text.
  assert.ok(brief.includes("Ops-Runbook"), "a user-minted profile must be listed");
  for (const p of DEFAULT_PROFILES) {
    if (p.name === BOSS_PROFILE_NAME) continue;
    assert.ok(brief.includes(p.name), `${p.name} must be listed`);
  }
});

test("a managed role is kept out of a list where one picks a role", () => {
  // `isManagedProfile` exists for exactly this. The names are duplicated in
  // greeting.ts (src cannot import from public), so this asserts they agree —
  // adding a managed role there must not silently leak it into the greeting.
  assert.ok(MANAGED_PROFILES.includes(TWEAK_PROFILE_NAME));
  const names = greetingProfiles([...DEFAULT_PROFILES, { name: TWEAK_PROFILE_NAME }, MINTED]).map(
    (p) => p.name,
  );
  for (const m of MANAGED_PROFILES) assert.ok(!names.includes(m), `${m} must not be offered`);
});

test("the lead does not offer to delegate to itself", () => {
  const names = greetingProfiles(DEFAULT_PROFILES).map((p) => p.name);
  assert.ok(!names.includes(BOSS_PROFILE_NAME));
});

test("a profile's line is its own words, minus the opener that says nothing", () => {
  const [p] = greetingProfiles([MINTED]);
  assert.ok(p.role.startsWith("the on-call agent"), p.role);
});

test("a cockpit with no other role promises none", () => {
  const brief = homeGreetingBrief({ ground: NODE_CI, profiles: [], dirName: "x" });
  assert.ok(/holds no other role/i.test(brief), brief);
});

// --- The copy rules ----------------------------------------------------------
// Prose is the one thing a refactor can quietly undo, so it is locked here the
// way test/tweak-role.test.ts locks the tweak agent's.

test("exactly one offer, and it is the only thing that gets more than a line", () => {
  const brief = homeGreetingBrief({ ground: NODE_CI, profiles: DEFAULT_PROFILES, dirName: "shadok-ai" });
  assert.ok(/THE ONE OFFER/.test(brief), brief);
  assert.ok(/Offer exactly this, and nothing else/.test(brief), brief);
  assert.ok(/only thing in the message that gets more than a line/.test(brief), brief);
  assert.ok(/each gets ONE line/.test(brief), brief);
});

test("the breadth items are outcomes, never feature names", () => {
  const brief = homeGreetingBrief({ ground: NODE_CI, profiles: DEFAULT_PROFILES, dirName: "shadok-ai" });
  assert.ok(/outcome they get, never as a feature name/.test(brief), brief);
  // The spec's own worked example, kept verbatim: it is what makes the rule
  // actionable rather than a word to nod at.
  assert.ok(brief.includes("run your ads and tell you each morning what moved"), brief);
  assert.ok(brief.includes("paid campaign management"), brief);
});

test("the greeting is an offer, never a first-run screen", () => {
  // claude-home.ts exists to delete blocking first-run screens; this must not
  // add one back. Declining has to leave a working cockpit.
  const brief = homeGreetingBrief({ ground: EMPTY, profiles: DEFAULT_PROFILES, dirName: "x" });
  assert.ok(/never ask a question they have to answer before anything works/.test(brief), brief);
  assert.ok(/still be\s+perfectly usable/.test(brief.replace(/\n/g, " ")), brief);
});

test("the honest register invents nothing and offers the universal opener", () => {
  const brief = homeGreetingBrief({ ground: NOTHING, profiles: DEFAULT_PROFILES, dirName: "notes" });
  assert.ok(brief.includes(UNIVERSAL_OFFER.offer), brief);
  assert.ok(/Do NOT name a stack, a framework, a language or a tool/.test(brief), brief);
  // And the brief itself names none: the model cannot quote what it never saw.
  for (const word of ["package.json", "Gemfile", "go.mod", "Cargo.toml", ".xcodeproj", "workflows"]) {
    assert.ok(!brief.includes(word), `the honest brief must not mention ${word}`);
  }
});

test("the informed register asks rather than dressing a guess up as an offer", () => {
  const brief = homeGreetingBrief({ ground: STACK_NO_VCS, profiles: DEFAULT_PROFILES, dirName: "shop" });
  assert.ok(brief.includes(UNIVERSAL_OFFER.offer), brief);
  assert.ok(/Say what you saw, then ASK/.test(brief), brief);
  // What it saw is still fair game — the marker is a file that exists.
  assert.ok(brief.includes("Gemfile"), brief);
});

test("the specific register may quote what it saw, and only that", () => {
  const brief = homeGreetingBrief({ ground: NODE_CI, profiles: DEFAULT_PROFILES, dirName: "shadok-ai" });
  assert.ok(brief.includes(".github/workflows"), brief);
  assert.ok(/Name nothing else/.test(brief), brief);
});

test("the brief forbids reading the project before offering to read it", () => {
  // Otherwise the first message costs a fistful of tool calls, and can disagree
  // with the deterministic pass it was handed.
  const brief = homeGreetingBrief({ ground: NODE_CI, profiles: DEFAULT_PROFILES, dirName: "shadok-ai" });
  assert.ok(/do NOT go and read the project now/i.test(brief), brief);
});
