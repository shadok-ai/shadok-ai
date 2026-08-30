import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Prose, locked the way `test/tweak-role.test.ts` locks the tweak role's.
 *
 * The scripts authenticate correctly on their own, so nothing here would ever
 * go red from a code change — which is exactly why it needs a test. An agent
 * that writes its own `curl` against the local API instead of using a script is
 * doing something completely ordinary, and if no document tells it which header
 * to send it gets a bare `401` with nothing to act on. That is not theoretical:
 * a production agent reported "authentication is broken" and stopped there,
 * because there was no sentence anywhere telling it what to do next.
 */

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

/** Every document an agent reads that also tells it to call the cockpit. */
const SKILLS = [
  "context/agents-skill/SKILL.md",
  "context/scheduler-skill/SKILL.md",
  "context/secrets-skill/SKILL.md",
  "context/reload-skill/SKILL.md",
];

test("every skill that talks to the cockpit names the auth header", () => {
  for (const f of SKILLS) {
    const md = read(f);
    assert.match(md, /x-shadok-session-key/, `${f} never names the header`);
    assert.match(md, /\$SHADOK_SESSION_KEY/, `${f} never names the variable to put in it`);
  }
});

test("they say what a 401 means, and that only a human can clear the old case", () => {
  // The half that matters most on the day it happens. An agent spawned before
  // the header existed holds a random key no derivation recognises plus an
  // expired cookie — nothing in its environment can authenticate, so telling it
  // to retry, or to find another credential, sends it in circles.
  for (const f of SKILLS) {
    const md = read(f);
    assert.match(md, /401/, `${f} never mentions the refusal an agent will actually see`);
    assert.match(md, /Reload agent/i, `${f} does not say who can fix the unrecoverable case`);
  }
});

test("the cookie is documented as the half that expires, never as the way in", () => {
  // `SHADOK_AUTH` still works and will keep working; the point is that an agent
  // must not build on it, because it is dated and frozen into an environment
  // that cannot be refreshed. See invariant 33.
  for (const f of SKILLS) {
    assert.match(read(f), /expires after a week|does not expire/i, `${f} presents both as equivalent`);
  }
});

test("the pilot prompt carries it too, for an agent that loaded no skill", () => {
  // The skills are read when the agent decides to use one. Improvising a curl
  // is precisely the case where it did not, so the one line lives here as well.
  const prompt = read("context/pilot-prompt.md");
  assert.match(prompt, /x-shadok-session-key/);
  assert.match(prompt, /SHADOK_PORT/);
});
