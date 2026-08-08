import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROMPT_MARK,
  MAX_FANOUT,
  MAX_LINK_DEPTH,
  chainDepth,
  childrenOf,
  isAgentPrompt,
  linkRefusal,
  markAgentPrompt,
  notificationText,
  type ChildReport,
} from "../src/kinship.js";
import type { Channel } from "../src/channels.js";

/** Minimal channel: only the two fields kinship reads. */
function ch(sessionId: string, parent?: string | null): Channel {
  return { sessionId, cwd: "/tmp", ...(parent !== undefined ? { parent } : {}) };
}

test("linkRefusal: detaching is always allowed", () => {
  assert.equal(linkRefusal([ch("a")], "a", null), null);
});

test("linkRefusal: a plain link is allowed", () => {
  assert.equal(linkRefusal([ch("boss"), ch("kid")], "kid", "boss"), null);
});

test("linkRefusal: refuses self, unknown parent and a direct cycle", () => {
  const list = [ch("boss"), ch("kid", "boss")];
  assert.equal(linkRefusal(list, "a", "a"), "self");
  // An unknown parent is REFUSED, not silently dropped: the caller would
  // otherwise believe it will be notified and wait forever (invariant 17).
  assert.equal(linkRefusal(list, "kid", "ghost"), "unknown-parent");
  assert.equal(linkRefusal(list, "boss", "kid"), "cycle");
});

test("linkRefusal: refuses an indirect cycle", () => {
  const list = [ch("a"), ch("b", "a"), ch("c", "b")];
  assert.equal(linkRefusal(list, "a", "c"), "cycle");
});

test("linkRefusal: refuses a chain deeper than the cap", () => {
  const list: Channel[] = [ch("root")];
  let prev = "root";
  for (let i = 0; i < MAX_LINK_DEPTH; i++) {
    list.push(ch(`n${i}`, prev));
    prev = `n${i}`;
  }
  list.push(ch("newcomer"));
  assert.equal(linkRefusal(list, "newcomer", prev), "too-deep");
  // ...while attaching near the root stays fine.
  assert.equal(linkRefusal(list, "newcomer", "root"), null);
});

test("linkRefusal: refuses fan-out past the cap, but re-parenting an existing child is a no-op", () => {
  const list: Channel[] = [ch("boss")];
  for (let i = 0; i < MAX_FANOUT; i++) list.push(ch(`kid${i}`, "boss"));
  list.push(ch("extra"));
  assert.equal(linkRefusal(list, "extra", "boss"), "too-many-children");
  // kid0 already counts as one of boss's children — counting it twice would
  // refuse a link that changes nothing.
  assert.equal(linkRefusal(list, "kid0", "boss"), null);
});

test("linkRefusal: terminates on a pre-existing loop in stored data", () => {
  // Hand-edited JSON can contain a↔b. Reading it must not spin forever.
  const list = [ch("a", "b"), ch("b", "a"), ch("fresh")];
  assert.equal(linkRefusal(list, "fresh", "a"), "cycle");
});

test("chainDepth counts ancestors, not nodes", () => {
  const list = [ch("a"), ch("b", "a"), ch("c", "b")];
  assert.equal(chainDepth(list, "a"), 0);
  assert.equal(chainDepth(list, "b"), 1);
  assert.equal(chainDepth(list, "c"), 2);
  assert.equal(chainDepth(list, "ghost"), 0);
});

test("chainDepth terminates on a loop", () => {
  assert.ok(chainDepth([ch("a", "b"), ch("b", "a")], "a") < 10);
});

test("childrenOf returns direct children only", () => {
  const list = [ch("a"), ch("b", "a"), ch("c", "b"), ch("d", "a")];
  assert.deepEqual(childrenOf(list, "a").map((c) => c.sessionId), ["b", "d"]);
  assert.deepEqual(childrenOf(list, "c").map((c) => c.sessionId), []);
});

test("markAgentPrompt is idempotent and detectable", () => {
  const once = markAgentPrompt('Agent "kid" finished its turn.');
  assert.ok(once.startsWith(AGENT_PROMPT_MARK));
  assert.equal(markAgentPrompt(once), once);
  assert.ok(isAgentPrompt(once));
  assert.ok(isAgentPrompt(`  \n${once}`));
  assert.equal(isAgentPrompt("a human typed this"), false);
  assert.equal(isAgentPrompt(""), false);
});

const base: ChildReport = { name: "auth-fix", sessionId: "abcd1234", kind: "done" };

test("notificationText: a finished child carries its own summary and pointers", () => {
  const t = notificationText({ ...base, summary: "Fixed the login bug.", branch: "shadok-ai/abcd1234" }, 3789);
  assert.match(t, /auth-fix/);
  assert.match(t, /Fixed the login bug\./);
  assert.match(t, /abcd1234/);
  assert.match(t, /shadok-ai\/abcd1234/);
  // Pointers, never the payload: the parent is the largest session in the tree,
  // so it fetches the diff only if it decides it needs one.
  assert.match(t, /\/diff\?session=abcd1234/);
  assert.doesNotMatch(t, /^\+\+\+|^---/m);
});

test("notificationText: a pending question lists its options and how to answer", () => {
  const t = notificationText(
    { ...base, kind: "dialog", question: "Allow rm -rf?", options: ["Yes", "No"] },
    3789,
  );
  assert.match(t, /Allow rm -rf\?/);
  assert.match(t, /1\. Yes/);
  assert.match(t, /2\. No/);
  assert.match(t, /pilotctl choose abcd1234/);
});

test("notificationText: a death is announced as such, not as a completion", () => {
  const t = notificationText({ ...base, kind: "exited" }, 3789);
  assert.match(t, /stopped before finishing/i);
  // A failure that says nothing is indistinguishable from a run with nothing to
  // say (invariant 15), so it must still reach the parent with its pointers.
  assert.match(t, /abcd1234/);
});

test("notificationText: no summary still produces a usable message", () => {
  const t = notificationText(base, 3789);
  assert.match(t, /auth-fix/);
  assert.match(t, /abcd1234/);
});

test("notificationText: a blank summary is not rendered as an empty gap", () => {
  assert.doesNotMatch(notificationText({ ...base, summary: "   \n  " }, 3789), /\n\n\n/);
});
