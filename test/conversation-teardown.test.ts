import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { conversationUnit } from "../src/isolation-unit.js";
import {
  conversationHeld,
  normalizeExternalUsers,
  teardownConversationUser,
  liveUidsOfProcStatus,
  withRetiring,
  TEARDOWN_ATTEMPTS,
  type ConversationTeardownDeps,
  type ExternalUserRow,
} from "../src/external-users.js";

// Deleting the last agent of an EXTERNAL conversation erases the conversation:
// the person who writes again must start from nothing. What is locked here is
// the order of the erasure and every way it must refuse or retry rather than
// leave files behind under a name — or a uid — someone else will be given.

const USER = "sk-x" + "a".repeat(27);
const OTHER = "sk-x" + "b".repeat(27);
const NOW = 1_700_000_000_000;

/** A host that records what was done to it, in order. */
function host(over: Partial<ConversationTeardownDeps> = {}) {
  const calls: string[] = [];
  const deps: ConversationTeardownDeps = {
    uidOf: () => 2001,
    selfUid: 0,
    killProcesses: async (uid) => (calls.push(`kill ${uid}`), 0),
    sweepStray: async (uid) => void calls.push(`sweep ${uid}`),
    removeMedia: () => void calls.push("media"),
    userdel: async (user) => void calls.push(`userdel ${user}`),
    removeHome: async (user) => void calls.push(`rm-home ${user}`),
    wait: async () => {},
    ...over,
  };
  return { calls, deps };
}

test("the erasure runs in the order that leaves nothing to inherit", async () => {
  const { calls, deps } = host();
  const r = await teardownConversationUser(USER, deps);
  assert.deepEqual(r, { ok: true, warnings: [] });
  // Processes before files (a live process would rewrite them), the uid's
  // stray files before the account (afterwards nothing names that uid), the
  // account last (a failure before it leaves an account its row still names).
  assert.deepEqual(calls, ["media", "kill 2001", "sweep 2001", `userdel ${USER}`]);
});

test("a name that is not a conversation's account is never torn down", async () => {
  for (const name of ["root", "main", "sk-team", "sk-x", USER + "0", USER.toUpperCase(), ""]) {
    const { calls, deps } = host();
    const r = await teardownConversationUser(name, deps);
    assert.equal(r.ok, false, name);
    assert.deepEqual(calls, [], `${name}: nothing may run`);
  }
});

test("a row that resolves to root or to the server's own uid is refused", async () => {
  for (const [uid, selfUid] of [[0, 1000], [1000, 1000]] as const) {
    const { calls, deps } = host({ uidOf: () => uid, selfUid });
    const r = await teardownConversationUser(USER, deps);
    assert.equal(r.ok, false);
    assert.ok(!calls.some((c) => /^(kill|sweep|userdel)/.test(c)), "no kill, no sweep, no userdel");
  }
});

test("a process that survives the kill blocks the sweep and the userdel", async () => {
  const { calls, deps } = host({ killProcesses: async () => 1 });
  const r = await teardownConversationUser(USER, deps);
  assert.equal(r.ok, false);
  assert.match(r.warnings.join(" "), /survived the kill/);
  assert.ok(!calls.some((c) => /^(sweep|userdel)/.test(c)));
});

test("a process still dying is waited for, then the account goes", async () => {
  let left = 2;
  const { calls, deps } = host({ killProcesses: async () => (left > 0 ? left-- : 0) });
  const r = await teardownConversationUser(USER, deps);
  assert.equal(r.ok, true);
  assert.equal(calls.at(-1), `userdel ${USER}`);
});

test("a userdel that fails once is retried; one that keeps failing is reported", async () => {
  let n = 0;
  const once = host({ userdel: async () => { if (n++ === 0) throw new Error("user is currently used by process 42"); } });
  assert.equal((await teardownConversationUser(USER, once.deps)).ok, true);

  let tries = 0;
  const never = host({ userdel: async () => { tries++; throw new Error("nope"); } });
  const r = await teardownConversationUser(USER, never.deps);
  assert.equal(r.ok, false);
  assert.equal(tries, TEARDOWN_ATTEMPTS);
  assert.match(r.warnings.join(" "), /userdel --remove .* failed: nope/);
});

test("a failed temp sweep keeps the account: its uid must not be freed over leftovers", async () => {
  const { calls, deps } = host({ sweepStray: async () => { throw new Error("find exited with code 1"); } });
  const r = await teardownConversationUser(USER, deps);
  assert.equal(r.ok, false);
  assert.ok(!calls.some((c) => c.startsWith("userdel")), "userdel would hand the uid on");
  assert.match(r.warnings.join(" "), /sweeping .* temp files failed/);
});

test("an account already gone still loses its home — the container-recreate case", async () => {
  const { calls, deps } = host({ uidOf: () => null });
  const r = await teardownConversationUser(USER, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["media", `rm-home ${USER}`]);

  const stuck = host({ uidOf: () => null, removeHome: async () => { throw new Error("busy"); } });
  assert.equal((await teardownConversationUser(USER, stuck.deps)).ok, false);
});

test("media that cannot be removed makes the whole erasure incomplete", async () => {
  const { calls, deps } = host({ removeMedia: () => { throw new Error("EACCES"); } });
  const r = await teardownConversationUser(USER, deps);
  assert.equal(r.ok, false);
  // The account still goes: one failure must not keep the rest on disk.
  assert.equal(calls.at(-1), `userdel ${USER}`);
});

test("the retiring mark is written once and survives a reload of the registry", () => {
  const rows: ExternalUserRow[] = [
    { user: USER, unit: conversationUnit("door", "wa-33600000000"), createdAt: 1 },
    { user: OTHER, unit: conversationUnit("door", "wa-33600000001"), createdAt: 2 },
  ];
  const marked = withRetiring(rows, USER, NOW);
  assert.equal(marked[0].retiring, NOW);
  assert.equal(marked[1].retiring, undefined);
  assert.equal(rows[0].retiring, undefined, "input untouched");
  // A retry must not make an old interrupted erasure look recent.
  assert.equal(withRetiring(marked, USER, NOW + 5000)[0].retiring, NOW);
  assert.equal(normalizeExternalUsers(JSON.parse(JSON.stringify(marked)))[0].retiring, NOW);
  // A mangled mark is still a mark: the row must never read as live again.
  const mangled = normalizeExternalUsers([{ ...rows[0], retiring: "yes" }]);
  assert.equal(mangled[0].retiring, 0);
  assert.equal(normalizeExternalUsers(rows)[0].retiring, undefined);
});

test("a conversation is erased with its LAST agent only", () => {
  const keyOf = (c: { key: string | null }) => c.key;
  const closed = { sessionId: "a", group: "door", conversation: "wa-33600000000" };
  const self = { sessionId: "a", group: "door", key: "wa-33600000000" };
  assert.equal(conversationHeld([self], closed, keyOf), false);
  assert.equal(conversationHeld([self, { sessionId: "b", group: "door", key: "wa-33600000000" }], closed, keyOf), true);
  // Another person, another group, or an agent that is nobody's conversation.
  assert.equal(conversationHeld([{ sessionId: "b", group: "door", key: "wa-33600000001" }], closed, keyOf), false);
  assert.equal(conversationHeld([{ sessionId: "b", group: "other", key: "wa-33600000000" }], closed, keyOf), false);
  assert.equal(conversationHeld([{ sessionId: "b", group: "door", key: null }], closed, keyOf), false);
});

test("liveUidsOfProcStatus reads all four ids, and nothing from a text without them", () => {
  assert.deepEqual(liveUidsOfProcStatus("Name:\tbash\nState:\tS (sleeping)\nUid:\t2001\t2001\t2001\t2001\nGid:\t7\t7\t7\t7\n"), [2001, 2001, 2001, 2001]);
  assert.deepEqual(liveUidsOfProcStatus("Name:\tx\nUid:\t0\t2001\t0\t0\n"), [0, 2001, 0, 0]);
  assert.deepEqual(liveUidsOfProcStatus("Name:\tUid: 5\n"), []);
  assert.deepEqual(liveUidsOfProcStatus(""), []);
});

test("a zombie is not a live process: unreaped under pid 1, it would block every erasure", () => {
  assert.deepEqual(liveUidsOfProcStatus("Name:\tsleep\nState:\tZ (zombie)\nUid:\t2001\t2001\t2001\t2001\n"), []);
  assert.deepEqual(liveUidsOfProcStatus("Name:\tsleep\nState:\tX (dead)\nUid:\t2001\t2001\t2001\t2001\n"), []);
  // A process NAMED like a state line is still alive.
  assert.deepEqual(liveUidsOfProcStatus("Name:\tZ\nState:\tR (running)\nUid:\t7\t7\t7\t7\n"), [7, 7, 7, 7]);
});

// server.ts is un-importable, so the SHAPE of the wiring is locked by scan
// (like test/external-nature-wiring.test.ts).
const SRC = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const fnBody = (sig: string): string => {
  const i = SRC.indexOf(sig);
  assert.ok(i >= 0, `missing ${sig}`);
  return SRC.slice(i, SRC.indexOf("\n}\n", i));
};

test("endChannel marks the conversation early and erases it once the agent is stopped", () => {
  const body = fnBody("async function endChannel(");
  const mark = body.indexOf("markConversationRetiring(ch)");
  const stop = body.indexOf("s.pilot.stop()");
  const erase = body.indexOf("finishRetiring(retiring)");
  // The mark precedes the slow stop: the person writing again in that window
  // must find it. The erasure follows the stop: `userdel` needs the process gone.
  assert.ok(mark >= 0 && stop > mark && erase > stop);
  // The home base returns before any of it.
  assert.ok(body.indexOf("isHomeChannel(ch)) return false") < mark);
  // Never fatal to the close.
  assert.match(body, /finishRetiring\(retiring\)\.catch\(/);
});

test("only the last agent of an EXTERNAL conversation is marked, multi-tenant only", () => {
  const which = fnBody("function conversationErasedWith(");
  assert.match(which, /DEPLOYMENT_MODE !== "multi-tenant"/);
  assert.match(which, /\?\.nature !== "external"\) return null/);
  assert.match(which, /if \(conversationHeld\(/);
  const body = fnBody("function markConversationRetiring(");
  assert.ok(body.indexOf("conversationErasedWith(") >= 0 && body.indexOf("conversationErasedWith(") < body.indexOf("withRetiring("));
});

test("the close confirmation is told by the SAME rule, and says what is erased", () => {
  const route = SRC.slice(SRC.indexOf('app.get("/channels", (req, res) => {'), SRC.indexOf("// What each visible row shows before its agent is resumed"));
  assert.match(route, /conversationErasedWith\(ch, allGroups, allChannels\) \? \{ conversation: true \}/);
  const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const start = page.indexOf("function confirmEndAgent(");
  const confirmFn = page.slice(start, page.indexOf("function closeTab(", start));
  assert.match(confirmFn, /n\.conversation/);
  assert.match(confirmFn, /erases this person's conversation/);
});

test("the late half erases only an account that is STILL marked", () => {
  // An admission in between has erased it and minted a fresh one under the
  // same name: that one is live and must not be touched.
  assert.match(fnBody("async function finishRetiring("), /r\.user === user && r\.retiring != null/);
});

test("the registry row is marked before the erasure and dropped only on success", () => {
  const body = fnBody("function retireConversationUser(");
  const mark = body.indexOf("withRetiring(");
  const run = body.indexOf("teardownConversationUser(");
  const drop = body.indexOf("withoutExternalUsers(");
  assert.ok(mark >= 0 && run > mark && drop > run);
  assert.ok(body.indexOf("if (done.ok)") < drop && body.indexOf("if (done.ok)") > run);
  // Single flight per account.
  assert.match(body, /conversationTeardowns\.get\(row\.user\)/);
});

test("an admission finishes a pending erasure first, and is refused if it cannot", () => {
  const body = fnBody("async function ensureExternalUser(");
  const retire = body.indexOf("retireConversationUser(retiring)");
  assert.ok(retire >= 0 && retire < body.indexOf("provisionOsUserFor("));
  assert.match(body, /if \(!done\.ok\)\s*\n?\s*return \{ ok: false/);
});

test("the boot reconciler finishes an erasure instead of re-provisioning the account", () => {
  const body = fnBody("async function reconcileExternalUsers(");
  const retiring = body.indexOf("row.retiring != null");
  assert.ok(retiring >= 0 && retiring < body.indexOf("provisionOsUserFor("));
  // …and before the "group is gone" branch, which would forget the account.
  assert.ok(retiring < body.indexOf("stale.push("));
});

test("deleting an external group erases every remaining conversation the same way", () => {
  const body = fnBody("async function teardownGroupOrConversations(");
  assert.match(body, /retireConversationUser\(row\)/);
  assert.doesNotMatch(body, /runPrivileged\("userdel"/);
});
