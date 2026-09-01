import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Scans index.html the way csp.test.ts and ws-url.test.ts do: this is a
// property of the page that no unit test can reach, and that a refactor can
// silently undo.
const html = fs.readFileSync("public/index.html", "utf8");

test("createTab takes a focus option, defaulting to the user-asked-for case", () => {
  assert.match(
    html,
    /function createTab\(groupId, \{ focus = true \} = \{\}\)/,
    "createTab must accept an explicit focus option",
  );
  assert.match(html, /if \(focus\) activate\(tab\);/, "activation must be conditional");
  assert.doesNotMatch(
    html,
    /tabs\.push\(tab\);\s*\n\s*activate\(tab\);/,
    "createTab must not activate unconditionally — that is the focus steal",
  );
});

test("a channel DISCOVERED on the server never steals the view", () => {
  // syncChannels runs every 4s and creates a tab for any channel it finds. An
  // agent spawned by another agent, from Telegram, from a cron or on another
  // machine must not move the user mid-sentence.
  assert.match(
    html,
    /const nt = createTab\(c\.group, \{ focus: !active \}\)/,
    "syncChannels must pass an explicit focus, tied to there being nothing active",
  );
});

test("the callers that ARE the user asking still take the view", () => {
  // Start-agent, the phone's "new agent" entry and the Tweak CTA call createTab
  // with no options, so they keep the default. If one of them ever passes
  // focus:false the button would silently do nothing visible.
  const bare = html.match(/createTab\(\)/g) ?? [];
  assert.ok(bare.length >= 3, `expected the user-driven callers to keep the default, saw ${bare.length}`);
});
