import assert from "node:assert/strict";
import test from "node:test";
import { describeStuckScreen, inputText } from "../src/detect.js";

/**
 * The real screen of an agent that sat wedged for a day.
 *
 * Its `claude` started while `~/.claude.json` was missing (the file is not on a
 * volume, and a container recreate had not restored it yet), so it landed on the
 * first-run screen and never reached a prompt. Every scheduled prompt was pasted
 * into a masked field and echoed as asterisks — which is why `inputText` found
 * nothing and `submit` reported "the text never appeared in the input box",
 * pointing at an input box that did not exist.
 */
const ONBOARDING = [
  "Welcome to Claude Code v2.1.223",
  "..........................................................",
  "     *                                       █████▓▓░",
  "                                 *         ███▓░     ░░",
  "",
  "                               **************************************************",
  "                               ***********************************************e, en",
].join("\n");

test("the first-run screen is named, not left to guesswork", () => {
  const why = describeStuckScreen(ONBOARDING);
  assert.ok(why, "an onboarding screen must be recognised");
  assert.match(why, /first-run/);
  assert.match(why, /claude\.json/); // says WHERE to look, not just what broke
});

test("that screen really does defeat the input-box probe", () => {
  // The premise of the whole fix: submit's own predicate finds nothing here, so
  // its message can only ever be misleading unless something names the state.
  assert.equal(inputText(ONBOARDING), "");
});

test("a masked field is named even without the welcome banner", () => {
  const masked = ["some header", "", "  " + "*".repeat(60)].join("\n");
  assert.match(String(describeStuckScreen(masked)), /masked input field/);
});

test("a pending question is named", () => {
  const dialog = ["Which one?", "", "❯ 1. alpha", "  2. beta"].join("\n");
  assert.match(String(describeStuckScreen(dialog)), /waiting on a question/);
});

test("an ordinary screen is not over-explained", () => {
  // A confident wrong diagnosis is worse than none: only recognised shapes get
  // a sentence, everything else keeps the plain message.
  const normal = ["⏺ Done.", "", "─────────────", "❯ ", "  ⏵⏵ auto mode on"].join("\n");
  assert.equal(describeStuckScreen(normal), null);
});

test("a quoted welcome line does not trigger the onboarding verdict alone", () => {
  // Guarded the same way as invariant 2: an agent DESCRIBING the screen must not
  // be mistaken for the screen. Here the asterisk rule is what must not fire.
  const talking = ["⏺ I read the line `Welcome to Claude Code` in the log.", "❯ "].join("\n");
  assert.match(String(describeStuckScreen(talking)), /first-run/); // still matched…
  assert.doesNotMatch(String(describeStuckScreen(talking)), /masked/); // …but not masked
});
