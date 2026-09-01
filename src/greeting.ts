import type { Ground } from "./ground.js";
import { BOSS_PROFILE_NAME, TWEAK_PROFILE_NAME, effectiveProfile, type Profile } from "./profiles.js";

/**
 * What the home agent says the first time a cockpit opens.
 *
 * The greeting itself is written by the model — what this module produces is
 * the BRIEF it writes from: the ground `readGround` recognised, the profiles
 * this cockpit actually holds, the single offer that fits, and the copy rules.
 *
 * Why a brief rather than the finished sentence. The introduction has to
 * describe the roles that exist HERE, including ones the user minted after this
 * file was written, so it cannot be prose in a prompt: hardcoding the list
 * reproduces the drift `CLAUDE.md` documents half a dozen times — a description
 * that outlives the thing it describes. Reading the vault means a profile added
 * later appears with nobody editing any text, and a role this cockpit does not
 * have can never be promised.
 *
 * Why the facts are handed over rather than looked up. The agent could read the
 * directory itself, but then the first message costs a fistful of tool calls
 * and can disagree with what shadok saw. `ground.ts` already answered the
 * question deterministically, for free — so the brief states the answer and
 * forbids contradicting it. Reading the project properly is what the greeting
 * OFFERS; doing it before offering would spend the user's quota on a question
 * nobody asked.
 *
 * The register is the whole design. A greeting that misreads the project costs
 * trust at the exact moment there is none in reserve, so only the register
 * built on evidence is allowed to be specific, and the one built on nothing
 * offers the single thing that is true everywhere (`UNIVERSAL_OFFER`) instead of
 * inventing a stack.
 */

export type GreetingRegister = "specific" | "informed" | "honest";

export interface GreetingOffer {
  /** The one thing offered, phrased as the outcome the person gets. */
  offer: string;
  /** The evidence it rests on — always a marker that was actually seen. */
  because: string;
}

/**
 * The offer that needs no detection at all. It works in a Rails app, an Xcode
 * project, a folder of marketing copy and a repository cloned five minutes ago;
 * it delivers something in two minutes; and it is already the lead's stated
 * KNOW job, so it promises nothing new. That is what makes it the honest
 * register's answer: the alternative there is guessing.
 */
export const UNIVERSAL_OFFER: GreetingOffer = {
  offer:
    "read this project and tell them what it is — its shape, the conventions it carries, and what someone appears to be working on",
  because: "it needs no detection at all, and it is true in every directory",
};

/**
 * The one offer that fits what was found, or null when nothing does.
 *
 * Deliberately short, and deliberately not a table of one entry per stack: an
 * offer earns its place on a shadok MECHANISM that the ground makes applicable,
 * never on the stack being nameable. A `Gemfile` on its own tells us what the
 * project builds with and nothing at all about what would help — that is
 * precisely the case the informed register exists for.
 */
export function fittingOffer(g: Ground): GreetingOffer | null {
  // Nothing recognised means nothing to fit. Checked first so no later branch
  // can accidentally speak with confidence about a directory we cannot read.
  if (g.empty || g.unrecognised) return null;

  const ci = g.ci[0];
  if (ci) {
    return {
      offer:
        "watch this project's CI for them — say which runs broke and what changed, and stay quiet on a day when everything passed",
      because:
        `${ci.marker} configures a pipeline, and a shadok schedule runs a deterministic check BEFORE it wakes a model, ` +
        "so a green day costs no tokens at all",
    };
  }

  const stack = g.stacks[0];
  if (stack && g.vcs === "git") {
    return {
      offer:
        "take the next piece of work here off their hands — one agent on its own branch, in its own checkout, and a diff for them to review at the end",
      because:
        `${stack.marker} says what this project is built with, and git means an agent can work in a worktree of its own ` +
        "without their checkout ever moving",
    };
  }

  return null;
}

/**
 * Which register the greeting speaks in.
 *
 * `empty` and `unrecognised` are kept apart by `ground.ts` and collapse here on
 * purpose: they are different facts about the directory, but they lead to the
 * same claim — we cannot say what this is. What must never collapse is either of
 * them with `informed`, which names real evidence.
 */
export function greetingRegister(g: Ground): GreetingRegister {
  if (g.empty || g.unrecognised) return "honest";
  return fittingOffer(g) ? "specific" : "informed";
}

/** One role this cockpit can put to work, as the brief hands it over. */
export interface ProfileBrief {
  name: string;
  /** The role in the profile's own words — what the outcome line is derived from. */
  role: string;
}

/**
 * Roles this cockpit can be asked for, from the vault it really has.
 *
 * Two exclusions, and neither is cosmetic. A MANAGED profile (`Shadok-Tweak`)
 * has its prompt rewritten from the build at every boot and has its own CTA —
 * `isManagedProfile` (public/profile-card.js) exists precisely to keep it out of
 * lists where one PICKS a role, and a greeting enumerating roles is such a list.
 * And the lead itself is the one SPEAKING: offering to delegate to the agent
 * writing the sentence reads as a bug, and its own job is the offer, not a
 * breadth line.
 *
 * The list is duplicated from `MANAGED_PROFILES` rather than imported, because
 * `src` cannot import from `public` (tsc `rootDir`). `test/greeting.test.ts`
 * imports both and asserts they agree, so the copy cannot drift in silence.
 */
export function greetingProfiles(stored: readonly Profile[]): ProfileBrief[] {
  const excluded = new Set([TWEAK_PROFILE_NAME, BOSS_PROFILE_NAME]);
  return stored
    .filter((p) => !excluded.has(String(p.name ?? "").trim()))
    .map((p) => ({ name: p.name, role: roleLine(effectiveProfile(p)?.systemPrompt ?? "") }));
}

/**
 * The profile's role in one line — its first sentence, minus the "You are X,"
 * opener that every role starts with and that says nothing.
 *
 * Same intent as `profileBlurb` (public/profile-card.js) and, again, a copy
 * rather than an import for the `rootDir` reason above. It stays deliberately
 * crude: this line is not shown to anyone, it is raw material the model turns
 * into an outcome, so being approximately right is enough and being empty is
 * survivable — an unlabelled role is better than an invented one.
 */
function roleLine(prompt: string): string {
  const body = prompt.trim().replace(/^You are [^,.]+,\s*/i, "");
  // A sentence or two, not one: "the paid-marketing agent." is a label, and a
  // label is precisely what the copy rule forbids the model from echoing back.
  // The sentence after it is usually the one that says what the role DOES,
  // which is what an outcome line has to be built out of.
  let out = "";
  for (const sentence of body.split(/(?<=\.)\s+/)) {
    if (out && out.length + sentence.length > 240) break;
    out = out ? `${out} ${sentence}` : sentence;
  }
  return out.length > 240 ? `${out.slice(0, 237)}…` : out;
}

/** The facts `readGround` established, as the brief states them. */
export function groundFacts(g: Ground, dirName: string): string[] {
  const lines = [`- directory: ${dirName}`];
  lines.push(`- version control: ${g.vcs ?? "none"}`);
  lines.push(
    `- stack markers: ${g.stacks.length ? g.stacks.map((s) => s.marker).join(", ") : "none recognised"}`,
  );
  lines.push(`- CI configuration: ${g.ci.length ? g.ci.map((c) => c.marker).join(", ") : "none"}`);
  lines.push(`- convention files: ${g.conventions.length ? g.conventions.join(", ") : "none"}`);
  if (g.empty) lines.push("- the directory holds no entries at all");
  if (g.unrecognised) {
    // Spelled out because it is the fact the model is most likely to argue
    // with, and `ground.ts` is deliberate about it: a README is prose, it says
    // nothing about what the project IS, and letting one count as recognition
    // would make this register unreachable for a folder of documents.
    lines.push(
      "- nothing here was recognised: no version control, no stack marker, no CI. A README, if there is one, is not recognition.",
    );
  }
  return lines;
}

export interface GreetingBriefInput {
  ground: Ground;
  /** The profiles this cockpit holds, straight from the vault. */
  profiles: readonly Profile[];
  /** The launch directory's own name — what the person calls this place. */
  dirName: string;
}

/**
 * The hidden prompt that produces the greeting.
 *
 * It is delivered like a cron fire or a parent notification (marked, so it
 * drives a turn without ever showing as a chat bubble), which is what makes the
 * greeting arrive unprompted rather than as an answer to something the user can
 * see themselves not having typed.
 */
export function homeGreetingBrief(input: GreetingBriefInput): string {
  const register = greetingRegister(input.ground);
  const chosen = fittingOffer(input.ground) ?? UNIVERSAL_OFFER;
  const profiles = greetingProfiles(input.profiles);

  const parts: string[] = [];

  parts.push(
    "FIRST MESSAGE. This cockpit has just been opened, nobody has spoken yet, and you are the first thing the person " +
      "will read. Write ONE short chat message: introduce yourself in a line, then make the single offer below. " +
      "Then stop and wait. This is an offer, not a form — if they ignore it entirely, the cockpit must still be " +
      "perfectly usable, so never ask a question they have to answer before anything works.",
  );

  parts.push(
    "WHAT I ALREADY READ FOR YOU. This came from a deterministic pass over the directory (no model, no guessing). " +
      "Do not contradict it, and do NOT go and read the project now — reading it properly is what you are about to " +
      "OFFER, and doing it first spends their quota on a question nobody asked.\n" +
      groundFacts(input.ground, input.dirName).join("\n"),
  );

  parts.push(
    `THE ONE OFFER (register: ${register}). Offer exactly this, and nothing else:\n` +
      `  ${chosen.offer}\n` +
      `It fits because ${chosen.because}.\n` +
      "This is the only thing in the message that gets more than a line: say what you would do and what they would " +
      "get out of it, in two sentences at most, and end it as a question they can answer with one word.",
  );

  if (register === "specific") {
    parts.push(
      "You may name what you saw — the markers above are files that really exist here, so quoting them is a fact, " +
        "not a guess. Name nothing else.",
    );
  } else if (register === "informed") {
    parts.push(
      "Say what you saw, then ASK. The markers above are real, so naming them is honest; what would help them is " +
        "not something the directory told us, so ask instead of assuming. Do not dress the question up as an offer.",
    );
  } else {
    parts.push(
      "Be plain about this one: nothing here was recognisable, so say so in one line rather than guessing what this " +
        "project is. Do NOT name a stack, a framework, a language or a tool — none was found, and inventing one is " +
        "the single failure this greeting cannot recover from. One honest line about what a cockpit like this is for, " +
        "the offer above, and a question.",
    );
  }

  parts.push(
    profiles.length
      ? "WHAT ELSE THIS COCKPIT CAN DO. These are the roles that exist here right now — each gets ONE line, after " +
          "the offer, and never more:\n" +
          profiles.map((p) => `- ${p.name}: ${p.role}`).join("\n") +
          "\nPhrase each as an outcome they get, never as a feature name: \"run your ads and tell you each morning " +
          "what moved\", not \"paid campaign management\". Mention no role that is not in this list: this cockpit " +
          "cannot do what it has no profile for, and promising it is a debt someone else pays."
      : "WHAT ELSE THIS COCKPIT CAN DO. Nothing to list: this cockpit currently holds no other role. Say nothing " +
          "about roles rather than naming one that does not exist.",
  );

  parts.push(
    "SHAPE. Plain chat prose, no headings, no wall of text. A dozen lines is already too long for a first message.",
  );

  return parts.join("\n\n");
}
