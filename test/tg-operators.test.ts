import assert from "node:assert/strict";
import test from "node:test";
import {
  callbackChatAllowed,
  commandRequiresOperator,
  cronsInScope,
  isOperator,
  operatorRefusal,
  parseSecretArg,
  spawnArgs,
  withOperator,
} from "../src/tg-operators.js";
import { resolveCronId } from "../src/crons.js";

const profiles = new Set(["Shadok-Boss", "Shadok-dev"]);
const isProfile = (n: string) => profiles.has(n);

test("commandRequiresOperator: host-wide commands are operator-only", () => {
  for (const c of ["secret", "unsecret", "login", "code", "mttoken", "mtcode", "update"]) {
    assert.equal(commandRequiresOperator(c, "", isProfile), true, c);
  }
});

test("commandRequiresOperator: chat-driving commands stay open to members", () => {
  for (const c of ["help", "start", "stop", "esc", "new", "end", "list", "tools", "cron", "secrets", "profiles", "restart"]) {
    assert.equal(commandRequiresOperator(c, "", isProfile), false, c);
  }
});

test("commandRequiresOperator: /spawn needs an operator only with an explicit profile", () => {
  assert.equal(commandRequiresOperator("spawn", "", isProfile), false);
  assert.equal(commandRequiresOperator("spawn", "my agent", isProfile), false);
  assert.equal(commandRequiresOperator("spawn", "Shadok-Boss", isProfile), true);
  assert.equal(commandRequiresOperator("spawn", "Shadok-dev fixer", isProfile), true);
});

test("spawnArgs: profile first word, name the rest (or the profile)", () => {
  assert.deepEqual(spawnArgs("", isProfile), { name: "agent" });
  assert.deepEqual(spawnArgs("bug hunter", isProfile), { name: "bug hunter" });
  assert.deepEqual(spawnArgs("Shadok-dev", isProfile), { profile: "Shadok-dev", name: "Shadok-dev" });
  assert.deepEqual(spawnArgs("Shadok-dev fixer one", isProfile), { profile: "Shadok-dev", name: "fixer one" });
});

test("isOperator: recorded operators and the DM owner; fail closed otherwise", () => {
  assert.equal(isOperator(1, [1, 2], null), true);
  assert.equal(isOperator(3, [1, 2], null), false);
  // Legacy group: no recorded operator, the DM owner counts.
  assert.equal(isOperator(7, [], 7), true);
  assert.equal(isOperator(8, [], 7), false);
  // Nobody recorded and no owner = nobody.
  assert.equal(isOperator(1, [], null), false);
  assert.equal(isOperator(undefined, [1], 1), false);
  assert.equal(isOperator(1, [1], 1, true), false, "a bot is never an operator");
});

test("withOperator: adds once", () => {
  assert.deepEqual(withOperator([], 5), [5]);
  assert.deepEqual(withOperator([5], 5), [5]);
  assert.deepEqual(withOperator([5], 6), [5, 6]);
});

test("operatorRefusal names the command and the way in", () => {
  const s = operatorRefusal("secret");
  assert.match(s, /\/secret/);
  assert.match(s, /\/setup <code>/);
  assert.match(s, /Pair Telegram/);
});

test("parseSecretArg: name, value with spaces, trailing --overwrite", () => {
  assert.deepEqual(parseSecretArg("TOKEN abc"), { name: "TOKEN", value: "abc", overwrite: false });
  assert.deepEqual(parseSecretArg("TOKEN a b c"), { name: "TOKEN", value: "a b c", overwrite: false });
  assert.deepEqual(parseSecretArg("TOKEN abc --overwrite"), { name: "TOKEN", value: "abc", overwrite: true });
  assert.equal(parseSecretArg("TOKEN"), null);
  assert.equal(parseSecretArg(""), null);
  assert.equal(parseSecretArg("TOKEN --overwrite"), null, "the flag is not a value");
});

test("callbackChatAllowed: same chat gate as messages", () => {
  const board = { id: -100, type: "supergroup" };
  assert.equal(callbackChatAllowed(board, [], -100), true);
  assert.equal(callbackChatAllowed(board, [], -200), false, "another group");
  assert.equal(callbackChatAllowed(board, [], null), false, "no board bound");
  assert.equal(callbackChatAllowed(board, ["-999"], -100), false, "allowlist wins");
  assert.equal(callbackChatAllowed({ id: 5, type: "private" }, [], null), true, "DMs go through dmGate");
  assert.equal(callbackChatAllowed({ id: 5, type: "private" }, ["6"], null), false);
  assert.equal(callbackChatAllowed({ id: -1, type: "channel" }, [], -1), false);
});

test("cronsInScope: a topic resolves prefixes against ITS crons only", () => {
  const all = [
    { id: "aaaa1111-0000", sessionId: "s1" },
    { id: "aaaa2222-0000", sessionId: "s2" },
  ];
  assert.deepEqual(cronsInScope(all, "s1").map((c) => c.id), ["aaaa1111-0000"]);
  assert.deepEqual(cronsInScope(all, undefined), []);
  // Across topics "aaaa" is ambiguous and "aaaa2" reaches s2's cron; scoped to
  // s1, "aaaa2" is not found and "aaaa" is s1's own.
  const r1 = resolveCronId(cronsInScope(all, "s1") as any, "aaaa2");
  assert.equal(r1.ok, false);
  const r2 = resolveCronId(cronsInScope(all, "s1") as any, "aaaa");
  assert.equal(r2.ok && r2.id, "aaaa1111-0000");
});
