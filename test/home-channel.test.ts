import assert from "node:assert/strict";
import test from "node:test";
import {
  homeAdoptionTarget,
  homeChannelForGeneral,
  isHomeChannel,
  type Channel,
} from "../src/channels.js";

const ch = (over: Partial<Channel>): Channel => ({ sessionId: "s", cwd: "/w", ...over });

test("the explicit home flag makes a channel the home base", () => {
  assert.equal(isHomeChannel(ch({ home: true })), true);
});

test("a bound board's General is still home, flag or not", () => {
  // The rule that predates the flag, kept verbatim: instances already running
  // with a Telegram board must not lose their home base on upgrade.
  assert.equal(isHomeChannel(ch({ telegram: { chatId: -100 } as any })), true);
});

test("a DM binding is NOT home, even with no topic", () => {
  // A DM also has no threadId but is an ordinary channel that MUST stay
  // closable — forcing it home once made a bogus second "general" appear.
  assert.equal(isHomeChannel(ch({ telegram: { chatId: 4242 } as any })), false);
});

test("a topic in the board is an ordinary agent", () => {
  assert.equal(isHomeChannel(ch({ telegram: { chatId: -100, threadId: 7 } as any })), false);
});

test("an ordinary channel is closable", () => {
  assert.equal(isHomeChannel(ch({ name: "general" })), false);
  assert.equal(isHomeChannel(ch({})), false);
});

test("adoption picks the one general at the launch dir with no worktree", () => {
  const list = [
    ch({ sessionId: "a", cwd: "/w", name: "general" }),
    ch({ sessionId: "b", cwd: "/w", name: "docs" }),
    ch({ sessionId: "c", cwd: "/w/tree", name: "general", branch: "feat/x" }),
  ];
  assert.equal(homeAdoptionTarget(list, "/w"), "a");
});

test("adoption does nothing when a home channel already exists", () => {
  const list = [ch({ sessionId: "a", cwd: "/w", name: "general" }), ch({ sessionId: "h", cwd: "/w", home: true })];
  assert.equal(homeAdoptionTarget(list, "/w"), null);
});

test("adoption REFUSES when it cannot tell — zero or several candidates", () => {
  // A wrong adoption is irreversible from the UI: the channel becomes the one
  // that cannot be closed. Doing nothing is always recoverable.
  assert.equal(homeAdoptionTarget([ch({ sessionId: "a", cwd: "/w", name: "docs" })], "/w"), null);
  const twins = [
    ch({ sessionId: "a", cwd: "/w", name: "general" }),
    ch({ sessionId: "b", cwd: "/w", name: "general" }),
  ];
  assert.equal(homeAdoptionTarget(twins, "/w"), null);
});

test("adoption ignores a general that lives in a worktree or elsewhere", () => {
  const list = [
    ch({ sessionId: "a", cwd: "/w", name: "general", branch: "feat/x" }),
    ch({ sessionId: "b", cwd: "/other", name: "general" }),
  ];
  assert.equal(homeAdoptionTarget(list, "/w"), null);
});

test("General adopts the unbound web home instead of spawning a second general", () => {
  // The bug: the home base has `home: true` but no Telegram binding, so
  // channelForTelegram misses it and a second "general" is created. General
  // must resume THIS session.
  const list = [ch({ sessionId: "home", cwd: "/w", name: "general", home: true })];
  assert.equal(homeChannelForGeneral(list), "home");
});

test("General does NOT re-adopt a home that is already Telegram-bound", () => {
  // Once bound, the home is found by channelForTelegram; re-adopting it here
  // would resume it twice.
  const list = [ch({ sessionId: "home", cwd: "/w", home: true, telegram: { chatId: -100 } as any })];
  assert.equal(homeChannelForGeneral(list), null);
});

test("General adoption returns null when there is no unbound home", () => {
  assert.equal(homeChannelForGeneral([ch({ sessionId: "a", name: "docs" })]), null);
  assert.equal(homeChannelForGeneral([]), null);
});
