import assert from "node:assert/strict";
import test from "node:test";
import { upsertInto, mergeChannels, findTelegramChannel, isMirrored, setToolKeys, type Channel } from "../src/channels.js";

test("upsertInto: inserts a new channel when the id is unknown", () => {
  const out = upsertInto([], { sessionId: "a", cwd: "/x" });
  assert.deepEqual(out, [{ cwd: "/x", sessionId: "a" }]);
});

test("upsertInto: merges fields into an existing channel, ignoring undefined", () => {
  const list: Channel[] = [{ sessionId: "a", cwd: "/x", name: "old" }];
  const out = upsertInto(list, { sessionId: "a", telegram: { chatId: 7, threadId: 3 }, name: undefined });
  assert.deepEqual(out[0], { sessionId: "a", cwd: "/x", name: "old", telegram: { chatId: 7, threadId: 3 } });
});

test("upsertInto: a resume must not erase the recorded branch", () => {
  // A resume has no `worktree` object, so the start handler used to patch
  // `branch: null` and wipe the branch a worktree channel recorded at creation —
  // and with it the ability to recreate a reclaimed checkout. The call site now
  // OMITS the key, and an omitted key must keep the stored value.
  const list: Channel[] = [{ sessionId: "a", cwd: "/wt", branch: "shadok-ai/wt", repo: "/repo" }];
  const resumed = upsertInto(list, { sessionId: "a", cwd: "/wt", profile: null });
  assert.equal(resumed[0].branch, "shadok-ai/wt");
  assert.equal(resumed[0].repo, "/repo");
  // An explicit null still clears it: the guard is at the call site, not here.
  assert.equal(upsertInto(list, { sessionId: "a", branch: null })[0].branch, null);
});

test("upsertInto: does not mutate the input list", () => {
  const list: Channel[] = [{ sessionId: "a", cwd: "/x" }];
  upsertInto(list, { sessionId: "a", name: "new" });
  assert.equal(list[0].name, undefined);
});

test("findTelegramChannel: matches chat + topic exactly", () => {
  const list: Channel[] = [
    { sessionId: "g", cwd: "", telegram: { chatId: -100 } },
    { sessionId: "t", cwd: "", telegram: { chatId: -100, threadId: 40 } },
  ];
  assert.equal(findTelegramChannel(list, -100)?.sessionId, "g");
  assert.equal(findTelegramChannel(list, -100, 40)?.sessionId, "t");
  assert.equal(findTelegramChannel(list, -100, 99), undefined);
});

test("mergeChannels: client drives name/group; server-owned fields preserved", () => {
  const stored: Channel[] = [
    // A topic channel (threadId set) — not the General, so the client name wins.
    { sessionId: "a", cwd: "/real", branch: "b", telegram: { chatId: 7, threadId: 3 }, name: "srv" },
  ];
  const client: Channel[] = [{ sessionId: "a", cwd: "/wrong", name: "renamed", group: 2 }];
  const out = mergeChannels(stored, client, new Set());
  assert.deepEqual(out, [
    { sessionId: "a", cwd: "/real", name: "renamed", group: 2, branch: "b", telegram: { chatId: 7, threadId: 3 } },
  ]);
});

test("mergeChannels: a client omission of a Telegram session does NOT drop it", () => {
  const stored: Channel[] = [
    { sessionId: "web", cwd: "/w" },
    { sessionId: "tg", cwd: "/t", telegram: { chatId: 7, threadId: 1 } },
  ];
  // client only knows about the web tab
  const out = mergeChannels(stored, [{ sessionId: "web", cwd: "/w", name: "kept" }], new Set());
  assert.deepEqual(out.map((c) => c.sessionId).sort(), ["tg", "web"]);
});

test("mergeChannels: a live session omitted by the client is kept", () => {
  const stored: Channel[] = [{ sessionId: "live", cwd: "/l" }];
  const out = mergeChannels(stored, [], new Set(["live"]));
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, "live");
});

test("mergeChannels: a dead, non-Telegram session the client dropped is removed", () => {
  const stored: Channel[] = [{ sessionId: "gone", cwd: "/g" }];
  const out = mergeChannels(stored, [], new Set());
  assert.deepEqual(out, []);
});

test("mergeChannels: the main channel (General, no threadId) is forced to 'general'", () => {
  const stored = [{ sessionId: "g", cwd: "/x", name: "old", telegram: { chatId: -100 } }];
  const client = [{ sessionId: "g", cwd: "/x", name: "renamed-by-stale-client", telegram: { chatId: -100 } }];
  const out = mergeChannels(stored, client, new Set());
  assert.equal(out.find((c) => c.sessionId === "g")?.name, "general");
});

test("mergeChannels: a DM (positive chatId, no threadId) is NOT forced to 'general'", () => {
  // A DM binding also has no threadId; forcing it to "general" made a bogus
  // second "general". It must keep its own name, and a stale "general" (from
  // the old rule) is cleared.
  const stored = [
    { sessionId: "dm", cwd: "/x", name: "general", telegram: { chatId: 217436150 } }, // wrongly forced before
    { sessionId: "dm2", cwd: "/x", name: "alex", telegram: { chatId: 999 } },
  ];
  const out = mergeChannels(stored, [], new Set());
  assert.equal(out.find((c) => c.sessionId === "dm")?.name, undefined); // un-named
  assert.equal(out.find((c) => c.sessionId === "dm2")?.name, "alex"); // legit name kept
});

test("setToolKeys: turning a channel on adds it, exactly once", () => {
  assert.deepEqual(setToolKeys([], "-100:5", true), ["-100:5"]);
  assert.deepEqual(setToolKeys(["-100:5"], "-100:5", true), ["-100:5"]);
});

test("setToolKeys: turning a channel off removes it, leaving the others alone", () => {
  assert.deepEqual(setToolKeys(["-100:5", "-100:7"], "-100:5", false), ["-100:7"]);
  assert.deepEqual(setToolKeys(["-100:7"], "-100:5", false), ["-100:7"]);
});

test("setToolKeys: does not mutate the input list", () => {
  const keys = ["-100:5"];
  setToolKeys(keys, "-100:9", true);
  assert.deepEqual(keys, ["-100:5"]);
});

test("isMirrored: an explicit intent decides, both ways", () => {
  assert.equal(isMirrored({ sessionId: "a", cwd: "", mirror: true }), true);
  // Intent "no" while a binding is still around: that's the state right after
  // turning it off, before the loop has deleted the topic.
  assert.equal(isMirrored({ sessionId: "a", cwd: "", mirror: false, telegram: { chatId: -100, threadId: 3 } }), false);
});

test("isMirrored: with no intent, an existing binding means mirrored (migration)", () => {
  // A running install must not un-mirror itself on deploy.
  assert.equal(isMirrored({ sessionId: "a", cwd: "", telegram: { chatId: -100, threadId: 3 } }), true);
  assert.equal(isMirrored({ sessionId: "a", cwd: "" }), false);
});
