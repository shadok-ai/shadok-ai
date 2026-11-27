# Plan — a guest's own secret slice (external groups, step 4)

Design: `docs/superpowers/specs/2026-11-26-external-groups-per-conversation-isolation-design.md`,
decision 6 (and decision 4 for the resolution chain, decision 7 for the lifetime).

Steps 1–3 are merged: the guest conversation box on the API (#587), the
admission ceiling (#596), and the `external` nature with one Unix account, HOME
and media directory per conversation (#597). Step 4 gives the conversation the
last store it was still missing: a slice of the vault.

## What this builds

A guest's agent can store a credential of its own, so the person does not have
to hand it over again on their next message — and no other conversation can
reach it.

1. **The vault is keyed by the ISOLATION UNIT, not the group.** `Vault` is
   already `{ [owner]: GroupVault }`, and `src/isolation-unit.ts` already
   produces one string for both shapes (`"<group>"` / `"<group>/<conversation>"`).
   A non-external group's key is its group id, byte for byte as today, so an
   existing instance's `secrets.json` is untouched.
2. **A conversation slice resolves to ITSELF and nothing else** (decision 4):
   no shared-in, no public commons, no Main. The refusal is in the resolver, so
   every caller inherits it.
3. **Injection needs no profile binding inside a conversation slice.** The
   slice is already exactly one guest's, and an external door already refuses a
   profile that carries secrets (#597), so every own name is injected.
4. **Quotas**, because a stranger can now write to the operator's disk through
   a route: a cap on the number of entries and on value size, enforced
   server-side, with the refusal returned to the agent rather than swallowed.
5. **Members see the NAMES**, never the values — the vault's existing rule —
   tagged as a guest conversation's, and may rotate and delete them.
6. **The slice dies with the agent** (decision 7): the Unix user and the HOME
   survive a deletion on purpose, the slice does not.
7. **The guest is told**, once, in guest words (`guestNotice`).

## The open point, and what this assumes

The design leaves **[OPEN]** whether a member may *write into* a guest's slice
— hand a credential to a stranger's agent. This builds the half the design
already decided ("can rotate and delete") and keeps the open half closed:

- a person may **overwrite** an existing name and **delete** one;
- a person may **not create** a name in a guest's slice. The refusal names the
  decision instead of pretending the capability does not exist.

Reversing that later is one branch in `guestSliceWriteRefusal`.

## Shape of the work

| What | Where |
|---|---|
| Quotas + the guest-slice write rules (pure) | `src/guest-vault.ts` (new) |
| Vault keyed by unit; boxed resolution; names visible to members | `src/secrets.ts` |
| The caller's unit; the quota gate; the slice's death; the notice | `src/server.ts` |
| The guest's own words | `src/tg-guests.ts` (`GuestNotice`) |
| The panel's guest rows | `public/index.html` |

## Verification

Unit tests for every pure core, a source scan for the server wiring (the house
pattern for `server.ts`, which is not importable), plus a side instance on a
free port for the routes that can run without root.

**What cannot be verified here:** this host has no `sudo` and runs as uid 1001,
so no external conversation can actually be provisioned — the same wall #597
reported. The vault layer itself is reachable without root and is exercised
end to end on the side instance.
