import assert from "node:assert/strict";
import test from "node:test";
import { echoAuthor } from "../public/echo-author.js";

test("echoAuthor: a Telegram sender is named", () => {
  assert.equal(echoAuthor({ from: "Alexandre Cognard", origin: "telegram" }), "Alexandre Cognard · telegram");
});

test("echoAuthor: no name → the origin still explains the message", () => {
  // A scheduled run answering on its own is the case that most needs an
  // explanation: nobody asked anything.
  assert.equal(echoAuthor({ origin: "cron" }), "cron");
});

test("echoAuthor: another tab of the same cockpit teaches nothing", () => {
  // "web" as a label would be noise — it's the surface you are already looking
  // at. Fall back to the generic wording.
  assert.equal(echoAuthor({ origin: "web" }), "you");
  assert.equal(echoAuthor({}), "you");
  assert.equal(echoAuthor(undefined), "you");
});

test("echoAuthor: a name without origin is enough on its own", () => {
  assert.equal(echoAuthor({ from: "Alexandre" }), "Alexandre");
});

test("echoAuthor: the pace guard's auto-continue is nobody", () => {
  // It comes from the server, not from a person — even if an origin rode along.
  assert.equal(echoAuthor({ auto: true, from: "Alexandre", origin: "telegram" }), "auto-retry");
});

test("echoAuthor: blank fields never produce a blank author", () => {
  // An empty label above a bubble reads as a bug, not as "unknown".
  assert.equal(echoAuthor({ from: "   ", origin: "  " }), "you");
});
