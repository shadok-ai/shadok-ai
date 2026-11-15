# The secret vault's chip rows write as they are ticked (no Save)

Status: built. Operator ask, 2026-11-15: *"dans la nouvelle boîte de secret
j'aimerai que le change des profils soit fait « sans sauver » — c'est possible ?
ça a des implications ?"* — asked as a question, answered, then scoped to **both
rows** (the Save disappears) **plus the audit row** the binding never had.

## Intent

An own secret's card carried two chip rows — *Shared with* (which groups may
read it) and *Injected into* (which profiles receive it as an environment
variable at spawn) — and **one Save**, enabled only once something changed. The
operator wants the tick itself to be the write.

The cockpit already does this one card further down the same panel: a
**Connected account** has the same chip rows, the same CSS, and no Save — tick,
`PUT`, and on a refusal the chip goes back. So the ask is also a consistency
fix: two adjacent cards in one panel were answering a click differently.

## What it changes

`secretControls` (`public/index.html`) loses its Save button and its dirty
tracking. Each checkbox now writes on `change`.

The new pure core is `secretChipPick(current, key, on, exclusive)`
(`public/secrets-panel.js`, tested in `test/secrets-panel.test.ts`): the set a
row holds after ONE click, computed from **the set the server last confirmed**
and not from the checkboxes. Two reasons it takes the confirmed set:
`PUT /secrets/profiles` and `PUT /secrets/share` replace the whole list (a delta
would be meaningless), and while a write is in flight the DOM is not yet a
statement anyone has agreed to. `exclusive` carries the vault's `ANY_PROFILE`
rule: *Any profile* and a named profile are different statements about where a
credential goes, so a row showing both would be lying about one of them.

## The three rules that make a Save-less row honest

1. **A refusal repaints the row from the last confirmed set.** PR #410 fixed the
   opposite bug — a 403 left the ticks on screen as if saved — by *keeping* the
   user's ticks so they could retry from the Save. That is right only while a
   Save exists. With none, keeping them leaves the card asserting an access that
   does not exist, which is the original bug wearing the fix's clothes.
2. **The row is disabled while its write is in flight.** Each PUT carries the
   whole set, so two quick clicks would race: the vault keeps whichever landed
   last, which need not be the one on screen. Disabling the row makes the second
   click impossible rather than queued — the same answer the connected-account
   card already gives.
3. **Nothing re-renders the panel.** The old Save ended on
   `loadVault(); renderSecrets()`, which rebuilds the whole list; per tick that
   would yank the card out from under the cursor. The row patches the card's own
   model (`sec.profiles` / `sec.sharedWith`, objects of `vaultSecrets`, so a
   later render agrees) and reports on the card's status line.

A value with **no chip** stays in the set. The profiles row hides managed roles
(`isManagedProfile`), and a secret can be bound to one — an agent on that role
attaching a secret it created. The old Save dropped such a binding on any save;
a row that writes on every tick would drop it by accident, so the confirmed set
keeps what the row does not show. A row may only state what it displays.

The *Any profile* confirm still runs **before** the write, not after — a
cancelled confirm now repaints from the confirmed set instead of unticking one
box, which also covers a click aborted mid-exclusivity.

## Why the creation form keeps waiting

It cannot do otherwise: a secret must exist before it can be bound, so
`PUT /secrets/profiles` on an unwritten name answers `404 no such secret in your
group`. The form's ticks therefore still travel at *Add* (they already did,
#456). The panel ends up with a form that waits and cards that do not — which
reads correctly, since the form's button says *Add* and is about a secret that
is not there yet.

## The audit row that was missing

With no Save, a binding changes on single clicks, and
`PUT /secrets/profiles` wrote **nothing** to the secret audit — `recordSecretAudit`
was only called from `PUT /secrets` (created/updated/deleted) and from the
profile side (`auditProfileSecrets`). So the one thing the log exists to answer —
*which agents can receive this credential* — had a door with no trace through it.

`auditSecretProfiles` (server.ts) is the mirror of `auditProfileSecrets`: the
diff is over PROFILE names instead of secret names, and it writes one
`attached` / `detached` row per profile gained or lost, with the secret in
`secrets: [name]` and the profile in `profile`. The previous binding is read
from the vault **before** `setSecretProfiles` — read it after and every diff is
empty while the code still looks wired, so `test/route-guards.test.ts` locks the
order by scanning the handler, the way the other route wirings are locked
(the express app cannot be imported without starting a server).

`PUT /secrets/share` stays unaudited. The log has no verb for a share, and
adding one touches `SECRET_AUDIT_ACTIONS`, the filters and the panel — a
separate change, not a rider on this one.

## Implications accepted, in the operator's own framing

- **A tick becomes an act**, with no commit point to change your mind at. The
  blast radius is bounded by *when* a secret travels: it is injected as an
  environment variable **at spawn**, so a running agent is unaffected until its
  next start, and unticking is just as immediate. `ANY_PROFILE` — the only
  tick that can reach every agent on the instance — is still confirm-gated.
- **No reload is offered** on a profile tick, as none was offered by the old
  Save either (rotating a *value* still offers one, `offerReload`). A prompt per
  tick would be noise.
- The card's **value** editor is untouched: a value is one deliberate Update,
  never written per keystroke.
