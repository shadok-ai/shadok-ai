import test from "node:test";
import assert from "node:assert/strict";
import {
  GUEST_SECRET_LIMITS,
  externalGroupSliceRefusal,
  guestSecretQuotaRefusal,
  guestSliceWriteRefusal,
  isGuestSlice,
} from "../src/guest-vault.js";
import { conversationUnit, groupUnit } from "../src/isolation-unit.js";

const G = "ext-group";
const UNIT = conversationUnit(G, "tg-1234");
const OTHER = conversationUnit(G, "tg-9999");

test("isGuestSlice: only a conversation's unit is one, never a group's", () => {
  assert.equal(isGuestSlice(UNIT), true);
  assert.equal(isGuestSlice(groupUnit(G)), false);
  assert.equal(isGuestSlice("main"), false);
});

// ── Quotas ───────────────────────────────────────────────────────────────

test("quota: a credential-sized value under the caps is stored", () => {
  assert.equal(guestSecretQuotaRefusal({ names: ["A", "B"], value: "sk-abc123", creating: true }), null);
});

test("quota: a value over the byte cap is refused, saying both numbers", () => {
  const r = guestSecretQuotaRefusal({ names: [], value: "x".repeat(GUEST_SECRET_LIMITS.valueBytes + 1), creating: true });
  assert.match(String(r), new RegExp(String(GUEST_SECRET_LIMITS.valueBytes + 1)));
  assert.match(String(r), new RegExp(String(GUEST_SECRET_LIMITS.valueBytes)));
});

test("quota: the cap counts UTF-8 BYTES, not code units — an emoji value cannot double it", () => {
  // "漢" is ONE UTF-16 code unit and THREE bytes, which is exactly the hole a
  // `.length` check leaves: well under the cap by characters, well over it by
  // what actually lands on the operator's disk.
  const value = "漢".repeat(2000);
  assert.ok(value.length < GUEST_SECRET_LIMITS.valueBytes);
  assert.notEqual(guestSecretQuotaRefusal({ names: [], value, creating: true }), null);
});

test("quota: a NEW name is refused at the entry cap; an OVERWRITE of an existing one is not", () => {
  const names = Array.from({ length: GUEST_SECRET_LIMITS.entries }, (_, i) => `N${i}`);
  assert.notEqual(guestSecretQuotaRefusal({ names, value: "v", creating: true }), null);
  // A full slice must stay ROTATABLE: refusing the overwrite too would leave a
  // guest unable to refresh an expired token without deleting something first.
  assert.equal(guestSecretQuotaRefusal({ names, value: "v", creating: false }), null);
});

test("quota: the limits can be overridden, so the cap is a value and not a constant in the logic", () => {
  assert.notEqual(guestSecretQuotaRefusal({ names: ["A"], value: "v", creating: true, limits: { entries: 1, valueBytes: 99 } }), null);
});

// ── Who may write a guest's slice ────────────────────────────────────────

test("write: a unit that is not a guest slice is never the business of this rule", () => {
  for (const op of ["create", "overwrite", "delete", "share", "bind"] as const)
    assert.equal(guestSliceWriteRefusal({ unit: groupUnit(G), op, callerUnit: null }), null);
});

test("write: sharing and binding are refused BEFORE the own-slice allowance — a guest cannot lend its secret to Main", () => {
  // The order matters more than the rule: `sharedWith` is read from the sharing
  // side, so an own-slice allowance checked first would let a stranger's agent
  // hand the operator's own agents a value of its choosing, under a name of its
  // choosing. Asserted here and not only in the "by anyone" test below, because
  // this is the case a reordering would silently re-open.
  assert.notEqual(guestSliceWriteRefusal({ unit: UNIT, op: "share", callerUnit: UNIT }), null);
  assert.notEqual(guestSliceWriteRefusal({ unit: UNIT, op: "bind", callerUnit: UNIT }), null);
});

test("write: a guest's own agent may create, overwrite and delete in its own slice", () => {
  for (const op of ["create", "overwrite", "delete"] as const)
    assert.equal(guestSliceWriteRefusal({ unit: UNIT, op, callerUnit: UNIT }), null);
});

test("write: an agent of ANOTHER conversation is refused, whatever it asks", () => {
  for (const op of ["create", "overwrite", "delete", "share", "bind"] as const)
    assert.notEqual(guestSliceWriteRefusal({ unit: UNIT, op, callerUnit: OTHER }), null);
});

test("write: an agent of the GROUP is refused too — the group is not the conversation", () => {
  assert.notEqual(guestSliceWriteRefusal({ unit: UNIT, op: "overwrite", callerUnit: groupUnit(G) }), null);
});

test("write: a person may rotate and delete a guest's secret, but not add one", () => {
  assert.equal(guestSliceWriteRefusal({ unit: UNIT, op: "overwrite", callerUnit: null }), null);
  assert.equal(guestSliceWriteRefusal({ unit: UNIT, op: "delete", callerUnit: null }), null);
  const r = guestSliceWriteRefusal({ unit: UNIT, op: "create", callerUnit: null });
  // The refusal names the DECISION rather than pretending the capability is
  // impossible: it is the design's one open point, and whoever reads the message
  // is the person who can settle it.
  assert.match(String(r), /not decided yet/);
});

test("write: a guest's slice is never shared out and never bound to a profile, by anyone", () => {
  for (const caller of [null, UNIT])
    for (const op of ["share", "bind"] as const)
      assert.notEqual(guestSliceWriteRefusal({ unit: UNIT, op, callerUnit: caller }), null);
});

// ── An external group has no slice of its own ────────────────────────────

test("external group: its own id is refused as a vault target; a conversation of it is not", () => {
  assert.notEqual(externalGroupSliceRefusal({ unit: groupUnit(G), external: true }), null);
  assert.equal(externalGroupSliceRefusal({ unit: UNIT, external: true }), null);
});

test("external group: a NON-external group's own slice is untouched by the rule", () => {
  assert.equal(externalGroupSliceRefusal({ unit: groupUnit("comex"), external: false }), null);
  assert.equal(externalGroupSliceRefusal({ unit: "main", external: false }), null);
});
