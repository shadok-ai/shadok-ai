import { unitConversation, type UnitId } from "./isolation-unit.js";

/**
 * What a STRANGER may put in the operator's vault, and who may touch it.
 *
 * Step 3 gave an external group's conversation a Unix account, a HOME and a
 * media directory of its own (`src/isolation-unit.ts`). This file carries the
 * last store it was missing: a slice of the central vault, so a guest's agent
 * can keep a credential it obtained and the person does not have to hand it
 * over again on their next message.
 *
 * The vault itself does not change shape — it is already keyed by owner
 * (`Vault = { [owner]: GroupVault }`), and an isolation unit is a string it can
 * take. What changes is the POLICY, and it lives here because it is the first
 * vault policy whose subject is not a tenant of this instance:
 *
 * - a stranger can now write to the operator's disk through a route, which was
 *   never true before — hence the quotas;
 * - a stranger's slice must not be reachable from any other slice, in either
 *   direction — hence the boxed resolution in `src/secrets.ts`;
 * - and a stranger is not a member, so the usual "your group's secrets are
 *   yours" rule does not say who may touch the slice — hence the write rules
 *   below.
 *
 * Pure and dependency-free, like `isolation-unit.ts`: the whole policy is
 * testable with no server, no root and no vault on disk.
 *
 * See docs/superpowers/specs/2026-11-26-external-groups-per-conversation-isolation-design.md,
 * decisions 4, 6 and 7.
 */

export interface GuestSecretLimits {
  /** How many names one conversation may hold. */
  entries: number;
  /** How large one value may be, in bytes of UTF-8. */
  valueBytes: number;
}

/**
 * The ceiling on a guest's slice. Not a guess at what a credential needs: it is
 * what a conversation can cost the operator before it is abuse. A handful of
 * tokens is a real need (an API key, a refresh token, a webhook URL); a hundred
 * is someone using the vault as storage, and 4 KiB is already far past any
 * credential format — a PEM private key fits in it.
 *
 * Deliberately NOT adjustable per door, unlike the admission ceiling
 * (`GUEST_LIMITS`): that one caps a cost the operator feels (Unix accounts,
 * homes, concurrent agents) and an operator legitimately wants it wider. This
 * one caps what a stranger writes to disk, and an operator has no reason to want
 * that wider — if one ever does, it is a per-door `limits` field like the other.
 */
export const GUEST_SECRET_LIMITS: GuestSecretLimits = { entries: 10, valueBytes: 4096 };

/** Is this unit ONE CONVERSATION's slice (as opposed to a whole group's)? */
export function isGuestSlice(unit: UnitId): boolean {
  return unitConversation(unit) !== null;
}

/** UTF-8 byte length — a value is stored and injected as bytes, and a quota
 *  counted in UTF-16 code units would let an emoji-heavy value double it. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Why this write into a guest's slice is over quota, or null when it fits.
 *
 * Returned to the agent rather than swallowed: an agent told "stored" while
 * nothing was stored asks the person for the credential again on the next
 * message and gets the same answer for ever. The refusal says which ceiling and
 * what the number is, because an agent that knows the cap can split a value or
 * drop a stale name on its own.
 *
 * `names` is the slice's CURRENT names; `creating` distinguishes a new name
 * (which consumes an entry) from an overwrite (which does not).
 */
export function guestSecretQuotaRefusal(input: {
  names: readonly string[];
  value: string;
  creating: boolean;
  limits?: GuestSecretLimits;
}): string | null {
  const limits = input.limits ?? GUEST_SECRET_LIMITS;
  const size = byteLength(input.value);
  if (size > limits.valueBytes)
    return `that value is ${size} bytes and the limit for one secret in this conversation is ${limits.valueBytes}`;
  if (input.creating && input.names.length >= limits.entries)
    return `this conversation already holds ${input.names.length} secrets, which is the limit (${limits.entries}) — delete one before storing another`;
  return null;
}

/** The vault mutations a guest slice can be the target of. */
export type GuestSliceOp = "create" | "overwrite" | "delete" | "share" | "bind";

/**
 * Why a mutation of a GUEST's slice is refused, or null when it may go ahead.
 * Returns null immediately for a unit that is not a guest slice, so a caller can
 * apply it to every vault write without asking whether it is relevant.
 *
 * `callerUnit` is the AGENT's own unit, derived server-side from its session —
 * never a value a client sent. `null` means a person, from the web UI.
 *
 * Three rules, and the ORDER is load-bearing:
 *
 * 1. **A guest's slice is never shared out and never bound to a profile — by
 *    ANYONE, its own agent included.** Both are how a credential reaches agents
 *    OTHER than the owner's, and the whole point of the slice is that nothing
 *    else reaches it. This is checked FIRST, ahead of the own-slice allowance
 *    below, and that is not a style choice: `sharedWith` is read from the SHARING
 *    side (`resolveSecretEntry` scans every slice for one lent to the caller), so
 *    a guest's agent allowed to share its own entry could lend the operator's
 *    own agents a value of its choosing under a name of its choosing — and for
 *    a name Main does not already hold, those agents would receive the
 *    stranger's value. Injection inside the conversation needs neither route:
 *    the slice is already exactly one guest's (`secretNamesForProfile`).
 * 2. **An agent otherwise touches only its OWN slice.** The server-side
 *    derivation already makes another slice unnameable, so this is a fail-closed
 *    restatement rather than a wall — but it is what would catch a future caller
 *    resolving the unit from something a client can influence.
 * 3. **A person may rotate and delete, not create.** The design decided that
 *    members see the names and "can rotate and delete" — the operator is
 *    accountable for what their instance holds, and a slice nobody can empty is
 *    that accountability removed. Whether a member may *hand a credential in*
 *    is a different act and is still **[OPEN]** in the design, so creating a
 *    name in someone else's slice is refused, with the reason said out loud.
 */
export function guestSliceWriteRefusal(input: {
  unit: UnitId;
  op: GuestSliceOp;
  callerUnit: UnitId | null;
}): string | null {
  if (!isGuestSlice(input.unit)) return null;
  if (input.op === "share")
    return "a guest conversation's secret is never shared with another group — it belongs to that conversation alone";
  if (input.op === "bind")
    return "a guest conversation's secrets are injected into that conversation's own agents and nowhere else, so there is no profile to bind them to";
  if (input.callerUnit !== null)
    return input.callerUnit === input.unit
      ? null
      : "an agent can only reach its own conversation's secrets";
  if (input.op === "create")
    return "you can rotate or delete a secret a guest stored, but not add one to their conversation: handing a credential to a guest is not decided yet";
  return null;
}

/**
 * Why this mutation of a whole EXTERNAL GROUP's own slice is refused, or null.
 *
 * That slice is the door's GROUP SECRETS: what a member stores there reaches
 * every conversation's agents (`resolveSecretEntry`, `secretNamesForProfile`)
 * — the operator's way to give every guest's agent a service key, decided
 * 2026-11-28. It used to be refused outright, because nothing read it.
 *
 * Every agent of the door receives all of it, so binding one to a profile
 * would be a setting that changes nothing: refused, with the reason. Writing,
 * rotating, deleting and lending it to another group stay ordinary member
 * acts. A guest's agent cannot reach it at all — it writes its own
 * conversation (`secretOwnerGroup`).
 */
export function externalGroupSecretRefusal(input: { unit: UnitId; external: boolean; op: GuestSliceOp }): string | null {
  if (!input.external || isGuestSlice(input.unit)) return null;
  if (input.op === "bind")
    return "an external group's secrets reach every guest conversation's agents, whatever their profile — there is no profile to choose";
  return null;
}
