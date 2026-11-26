# Plan: step 1 — the guest conversation box on the API

Design:
[`specs/2026-11-26-external-groups-per-conversation-isolation-design.md`](../specs/2026-11-26-external-groups-per-conversation-isolation-design.md),
decision 4. **Implemented.**

Step 1 of five, and the one that ships alone: it closes a hole that exists
today, needs no `external` group, no multi-tenant, no provisioning and no
migration. The filesystem half (a Unix user per conversation) is step 3.

## What was wrong

Every guest of an open DM door lands in the same group. An agent's membership of
a group is its channel's group (`viewerInGroup` keys on `agentGroup`) and every
visibility question delegates to it (`canSeeSession` → `canSeeGroup`), so one
guest's agent was entitled to a sibling guest's session, transcript and diff —
and to any connected account the operator had shared with that group, which
`POST /github/token` turns into a real provider token. A guest carries
`SHADOK_SESSION_KEY` in its own environment, so none of that needed privilege or
a file: it needed a prompt.

## The shape of the fix

A box on the **principal**, not a rule on the group, so it cannot be widened by
a group edit:

1. **`src/agent-principal.ts`** — `guestConversationOf(ch, dmOwner)` reads the
   registry (`telegram` / `whatsapp`, both SERVER_OWNED): a WhatsApp binding is
   always a guest's (that transport has no owner side), a Telegram binding is a
   guest's when it is a DM (`threadId` absent, positive `chatId`) and not the DM
   owner's, an unknown owner boxes every DM (fail closed). Deliberately NOT
   derived from the door's configuration: re-pointing a door must not un-box the
   conversations already running. `AgentPrincipal` carries the result.
2. **`src/groups.ts`** — `Viewer.onlySession` and `viewerBox`. `viewerFor` sets
   it from the principal, so every caller inherits the box without knowing it
   exists. A boxed viewer: belongs to no group (`viewerInGroup`), sees no group
   (`canSeeGroup`, **before** the public clause), sees exactly one session
   (`canSeeSession`, `visibleChannels`), owns no secret and no ledger scope
   (`memberGroupIds`, `secretOwnGroupIds`, `ledgerGroupsFor`).
3. **`src/group-exec.ts`** — `mayReachGroup`/`mayActOnSession` take `boxed` on
   the agent: no sibling, no group-level resource (a media subdirectory
   included), **`self` still allowed**, and the box is asked before the
   mono-tenant short-circuit.
4. **`src/connected-accounts.ts`** — `accountVisible` refuses a boxed viewer
   outright, like a restricted peer's box. Belt and braces: a share naming a
   group id that no longer resolves would otherwise fall through to the generic
   branch.
5. **`src/server.ts`** — `requestAgent` carries `boxed`; `principalForSession`
   passes `loadTgOwner()`; the box is checked before the mono-tenant escape in
   `httpMayDrive`, the WS `mayDriveSession`, `GET /live`, `GET /sessions`,
   `GET /recover`, `GET /diff` and `factoryMayDrive` — every
   `DEPLOYMENT_MODE !== "multi-tenant"` escape that guards a visibility
   decision, found by auditing all 34 of them. WS `start` refuses a boxed caller
   anything but a reattach to itself (resolved through `resolveResumeId`, since a
   prefix is a legal resume id — invariant 17), and `PUT /channels` refuses it
   outright: the merge already protected every server-owned field, so the reach
   was cosmetic (renaming and reordering the operator's tabs), but it is not a
   guest's to have.

## What a guest's agent can still do

Answer its own turns, hand a file to the person it is talking to
(`POST /files`, self-scoped), act on itself (`self` in `mayActOnSession`, so its
own crons and its own state are unaffected). What it loses is every reach it
should never have had.

## Tests

Pure: `test/agent-principal.test.ts` (the derivation, all four shapes + the
fail-closed owner), `test/groups.test.ts` (the boxed viewer against groups,
sessions, channels, secrets, ledger, resume), `test/group-exec.test.ts` (self
yes / sibling no / mono-tenant no escape / no group resource),
`test/connected-accounts.test.ts` (the provider-token case, including
`agentsUnwalled` and a dangling share). Source scans in
`test/server-acl.test.ts` and `test/server-acl-leaks.test.ts` lock the ORDER —
the box before every mono-tenant short-circuit — and the `start` guard.

## Not in this step

The Unix user per conversation, the admission cap and rate, the guest's own
secret slice, per-conversation media, the `external` nature itself. Media is
reached through `mayReachGroup`, so a boxed agent is already out of the group's
media directory; moving the directory itself is step 3.
