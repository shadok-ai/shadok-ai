# Plan: step 3 — the `external` nature, and one Unix user per conversation

Design:
[`specs/2026-11-26-external-groups-per-conversation-isolation-design.md`](../specs/2026-11-26-external-groups-per-conversation-isolation-design.md),
decisions 1, 2, 5, 8 and 9. **Implemented.**

Step 3 of five, and the one that makes the nature real. Step 1 boxed a guest's
agent on the API; step 2 capped what a door admits. This is the filesystem half:
the wall between the guests themselves.

## The shape

**One new string, not one new concept per store.** Until now "group id" and
"isolation unit" were the same thing, and every per-group store keyed on it: the
OS user (`sk-<id>`), the HOME, the media subdirectory (`g-<id>`), the vault
slice. `src/isolation-unit.ts` makes the unit its own string — `"<group>"` as
before, or `"<group>/<conversation>"` — so those stores keep their shape and
nothing about an existing instance moves. The `/` is illegal in a username and
in a media directory name, so every name built from a conversation unit takes
the hashed path and can never be mistaken for a group's.

1. **`src/isolation-unit.ts`** (new, pure) — the unit algebra, `unitFor` (the
   REFUSAL when an external group names no conversation) and `osUserForUnit`
   (`sk-<group id>` byte for byte; `sk-x<27 hex>` for a conversation, because a
   username is capped at 32 and neither a UUID nor a phone number fits beside
   the other).
2. **`src/external-users.ts`** (new) — the root-owned registry the hash makes
   necessary, and `externalUserVerdict`: `known` / `new` / `collision`, colliding
   in BOTH directions. Pure decisions, thin store.
3. **`src/osusers.ts`** — `osUserFor(g): string | null` is **gone**, replaced by
   `osUserOf(g, conversation)` / `groupOsUser(g)` returning
   `{ok,user} | {ok:false,why}`. That is the load-bearing change: `null` already
   meant *the commons*, so an external group reaching that path would have run a
   stranger as the shared user while every one of the ten call sites still
   compiled. The compiler then walked each of them (see invariant 84 for what
   each now answers). `provisionPlan` / `provisionGroupUser` learn the
   conversation and THROW rather than return the "nothing to provision" null.
4. **`src/groups.ts`** — `Nature` gains `external`; `isRoster` replaces the six
   `nature === "restricted"` checks that are about the ROSTER rather than about
   what is isolated (a predicate, because a second `||` in six places is how one
   gets missed — and a missed one is an external group whose last member can
   walk out of it). The nature is never converted (`mergeGroupsPut` ignores it on
   an existing row). An external group is in no ledger scope for ANYONE
   (decision 9), is never anyone's home group, and is never a spawn target
   except for the door's own guest spawn.
5. **`src/media-scope.ts`** — keyed per unit (`mediaUnitKey` /
   `mediaDirForUnit` / `unitForMediaKey`), so a stranger's attachments land where
   only their own agent can read them. `/media` maps a hashed key back through
   the units that EXIST (groups + live external conversations) and authorises by
   the GROUP: its members see every conversation, which is the product.
6. **`src/server.ts`** — `ensureExternalUser` mints the account at ADMISSION
   (after the ceiling, so a flood never reaches `/etc/passwd`) and refuses the
   whole admission on any failure; the conversation is threaded through
   `resolveSpawnIsolation` → `createSession` → `makePilot`;
   `teardownGroupOrConversations` removes every conversation's account when the
   group is deleted (agents killed first — `userdel` cannot remove an account a
   process holds); `reconcileExternalUsers` heals a recreated container at boot
   and drops rows whose group is gone.
7. **`src/tg-guests.ts`** — a door may point at an external group, and an
   external door REFUSES a profile carrying secrets (decision 5): every guest
   runs the same profile, so a secret on it is a credential handed to every
   stranger.
8. **`public/index.html`** — the **External** card in the create form, one line
   saying what it means (the nature is chosen once and never converted, so that
   is the only moment to say it), the roster panel shared with Private, and a
   deletion warning that names what actually goes.

## Deviation from the design, stated

The design wanted provisioning "when the door admits, not at the agent's spawn,
so a spawn never waits on a privileged command". Server-side those are the SAME
moment: the bridge is not trusted to decide anything, so the only place that can
admit is the `start` handler. It holds per conversation instead of per message —
the first message from a stranger waits for one `useradd`, every later one finds
the account there.

## Tests

Pure: `test/isolation-unit.test.ts` (the algebra, the refusal, the hashed name's
shape and stability, and that a conversation unit can never read as a group id),
`test/external-users.test.ts` (both collision directions, the `known` reuse, the
malformed-row drop), `test/osusers.test.ts` (rewritten around `osUserOf` /
`groupOsUser`: a group's name unchanged, an external group's group-level refusal,
one account per conversation, `provisionPlan`'s throw), `test/groups.test.ts`
(the roster rules, the ledger exclusion, the spawn exclusion, the conversion
refusal), `test/media-scope.test.ts` (the always-hashed conversation key and the
map back), `test/tg-guests.test.ts` (an external door, and its refusal of a
profile with secrets), `test/group-nature-ui.test.ts` (the create form, the
panel line, the deletion warning).
Source scans: `test/external-nature-wiring.test.ts` locks the ORDER (the account
is minted after the ceiling and before the working directory, the isolation
resolution and any process), every refusal branch of `ensureExternalUser`, the
teardown's kill-then-`userdel` and its row bookkeeping, the boot reconciler, and
that no group-level user is ever invented for an external group.

**Not verified against a live server, and this is the gap a reviewer should
weigh.** Every line of this step ends in a `useradd` on a host that can
provision. This one cannot: there is no `sudo` and the server runs as an
unprivileged uid, so `SHADOK_FORCE_MULTITENANT=1` produces
`spawn sudo ENOENT` on the first provisioning step and the WhatsApp door never
opens (`whatsapp: unavailable (the instance's groups are not migrated yet)`).
So: no `useradd` ran, no `/etc/passwd` row was created, no registry file was
written by the server, no conversation account was torn down, and the media
directory was never created with a conversation's gid. What ran is the whole
decision layer, in unit tests, plus `tsc` and the scans above.

## Not in this step

The guest's own secret slice (step 4) — the vault is already keyed by owner, and
the unit is now a string it can take. The lifetime gestures (step 5): deleting
ONE conversation, and the retention sweep. The Claude credential stays shared,
as the design states.
