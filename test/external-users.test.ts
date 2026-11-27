import assert from "node:assert/strict";
import test from "node:test";

import { conversationUnit } from "../src/isolation-unit.js";
import {
  externalUserRow,
  externalUserVerdict,
  externalUsersOfGroup,
  normalizeExternalUsers,
  withExternalUser,
  withoutExternalUsers,
  type ExternalUserRow,
} from "../src/external-users.js";

// The registry that binds a conversation's Unix account to the conversation —
// needed because the NAME is a hash, and fail-closed because two strangers
// sharing one account is the leak the external nature exists to prevent
// (design decision 2).

const NOW = 1_700_000_000_000;
const unitA = conversationUnit("door", "wa-33111");
const unitB = conversationUnit("door", "wa-33222");
const rows: ExternalUserRow[] = [{ user: "sk-xaaa", unit: unitA, createdAt: NOW - 1000 }];

test("a conversation that comes back is KNOWN: nothing is written", () => {
  const v = externalUserVerdict(rows, { user: "sk-xaaa", unit: unitA }, NOW);
  assert.equal(v.kind, "known");
});

test("a new conversation gets a row to append", () => {
  const v = externalUserVerdict(rows, { user: "sk-xbbb", unit: unitB }, NOW);
  assert.equal(v.kind, "new");
  assert.deepEqual(v.kind === "new" ? v.row : null, { user: "sk-xbbb", unit: unitB, createdAt: NOW });
  assert.equal(withExternalUser(rows, { user: "sk-xbbb", unit: unitB, createdAt: NOW }).length, 2);
  assert.equal(rows.length, 1, "the input is untouched");
});

test("the name already bound to ANOTHER conversation is a collision, and refused", () => {
  // The whole reason the registry exists in this direction: a hash collision —
  // or any future change to the naming — must never let two people share one
  // Unix account, so it fails loudly instead of reusing or renaming.
  const v = externalUserVerdict(rows, { user: "sk-xaaa", unit: unitB }, NOW);
  assert.equal(v.kind, "collision");
  assert.match(v.kind === "collision" ? v.why : "", /already bound to another conversation/);
  assert.match(v.kind === "collision" ? v.why : "", /refusing rather than letting two people share it/);
});

test("the same conversation under a DIFFERENT name is also a collision", () => {
  // The harder direction: this person already has a home, a media directory
  // and (later) a vault slice under the stored name. Minting a second account
  // would silently abandon all of it.
  const v = externalUserVerdict(rows, { user: "sk-xzzz", unit: unitA }, NOW);
  assert.equal(v.kind, "collision");
  assert.match(v.kind === "collision" ? v.why : "", /already bound to the Unix account "sk-xaaa"/);
});

test("rows are grouped and dropped by group, which is what a deletion needs", () => {
  const all: ExternalUserRow[] = [
    ...rows,
    { user: "sk-xbbb", unit: unitB, createdAt: NOW },
    { user: "sk-xccc", unit: conversationUnit("other", "wa-1"), createdAt: NOW },
  ];
  assert.deepEqual(externalUsersOfGroup(all, "door").map((r) => r.user), ["sk-xaaa", "sk-xbbb"]);
  assert.deepEqual(withoutExternalUsers(all, ["sk-xaaa", "sk-xbbb"]).map((r) => r.user), ["sk-xccc"]);
  assert.equal(all.length, 3, "the input is untouched");
});

test("externalUserRow finds the account minted for one conversation", () => {
  assert.equal(externalUserRow(rows, "door", "wa-33111")?.user, "sk-xaaa");
  assert.equal(externalUserRow(rows, "door", "wa-99999"), null);
  assert.equal(externalUserRow(rows, "other", "wa-33111"), null);
});

test("a malformed row is DROPPED, never repaired", () => {
  // A row is a claim that an account belongs to one conversation; a half-read
  // claim is worse than none, because the collision refusal would then compare
  // against nonsense. Dropping rows one by one (rather than giving up on the
  // file) is what keeps the rest of the registry guarding.
  const cleaned = normalizeExternalUsers([
    { user: "sk-xaaa", unit: unitA, createdAt: NOW },
    { user: "", unit: unitB },
    { user: "sk-xbbb", unit: "" },
    { user: "sk-xccc", unit: "door" }, // a GROUP unit: not minted here
    { user: "sk-xaaa", unit: unitB }, // duplicate name: first wins
    "nonsense",
    null,
  ]);
  assert.deepEqual(cleaned.map((r) => r.user), ["sk-xaaa"]);
  assert.equal(cleaned[0].unit, unitA);
  assert.deepEqual(normalizeExternalUsers(null), []);
  assert.deepEqual(normalizeExternalUsers({}), []);
});

test("a row with no createdAt still counts", () => {
  const [r] = normalizeExternalUsers([{ user: "sk-xaaa", unit: unitA }]);
  assert.equal(r.createdAt, 0);
});
