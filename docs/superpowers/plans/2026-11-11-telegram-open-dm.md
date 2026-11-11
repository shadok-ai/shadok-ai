# Open Telegram DMs — Implementation Plan

> **For agentic workers:** implement task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Every task ends green and commits.

**Goal:** An instance can open its bot's DMs. A person who is not the owner writes to it, and gets a dedicated agent — on a configured profile, in a configured **restricted** group — and always lands on the same one. The profile defines the job; shadok provides the plumbing.

**Architecture:** Pure verdicts in a new `src/tg-guests.ts` (enable refusal, the instance-as-member transform); per-launch-dir storage beside the other Telegram fields in `config.json`; one new verdict in `dmGate`; the guest's session opened by the bridge with a marker that only a socket proving `x-shadok-bridge` may use, with the group and the profile read **server-side from the config** and never from the frame; a `guest` flag on the `Bridge` that silences the bridge's own cockpit vocabulary.

**Tech Stack:** TypeScript (NodeNext ESM), Express, `ws`, vanilla JS in `public/index.html`, node:test (`npm test`).

**Spec:** `docs/superpowers/specs/2026-11-11-telegram-open-dm-design.md` (PR #479)

## Global Constraints

- All repo text in English (code, comments, tests, log and error strings, commit messages, PR bodies).
- **Multi-tenant only.** A non-public group cannot exist elsewhere; enabling outside multi-tenant is refused through the existing `capabilityRefusal` primitive.
- **The group and the profile come from the config, never from the wire** (invariant 49). The frame may carry a marker meaning "this is a guest"; it may never carry which group or which profile.
- The guest marker is believed **only** on a socket that proved `x-shadok-bridge` (`isTelegramBridge`, server.ts) — invariant 61's rule, same condition as `from`.
- `allowedChats` keeps filtering before the gate; `pair` keeps priority over `guest` (no owner → a pairing code is still the only way in).
- Nothing in the owner's DM, the board group, the operator list or `isOperator` changes.
- Never take over port 3789. Verify on a free port: `PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js`, and confirm the startup output has **no** `telegram:` line (a bench instance must not steal the live bot's long-poll).
- `npm run build && npm test` green before each commit.

## Review Focus

1. A guest's channel really comes out of the spawn with `group` equal to the configured one and the configured profile — **observed**, not inferred (invariant 24). A fallback to the commons is the one failure that publishes a stranger's conversation to the whole instance.
2. A `start` frame from a NON-bridge socket carrying the guest marker, or carrying `group`/`profile`, changes nothing.
3. `dmGate` over every combination: owner set / unset, sender = owner / not, option on / off, no sender id.
4. A guest can answer their own agent's keyboard, and cannot reach one command — including the ones `commandRequiresOperator` leaves open (`/stop`, `/tools`, `/new`).
5. No cockpit vocabulary reaches a guest: the pace line, `— session ended —`, `⚠️ couldn't send`, the restart notice.
6. Disabling the option removes the instance from the group's members, and re-enabling puts it back — no orphan membership.

---

### Task 1: Pure core — storage and the enable verdict

**Files:** Create `src/tg-guests.ts`, `test/tg-guests.test.ts`; Modify `src/config.ts` (beside `telegramConfig`/`applyTelegramPatch`).

**Interfaces — Produces:**
```ts
// src/tg-guests.ts
export interface GuestSetup { on: boolean; group: string | null; profile: string | null }
/** null = allowed; else the reason, shown as-is to the admin. */
export function guestEnableRefusal(input: {
  mode: string;                 // DEPLOYMENT_MODE
  want: GuestSetup;
  groups: readonly Group[];
  profileExists: (name: string) => boolean;
}): string | null;
/** The groups a picker may offer: restricted, and visible to the caller. */
export function guestGroupChoices(groups: readonly Group[], viewer: Viewer | null): Group[];
/** Add or remove BOOTSTRAP_ADMIN from one group's members. Pure, new array. */
export function withInstanceMember(groups: readonly Group[], groupId: string, member: boolean): Group[];
// src/config.ts
export function guestSetupForCwd(cfg: Config, cwd: string): GuestSetup;   // off/null/null when unset
export function setGuestSetupForCwd(cfg: Config, cwd: string, s: GuestSetup): void;
```
- [ ] Step 1: tests — `off with no group/profile is allowed` (turning it off always works); `on with a missing group → refused`; `on with a missing profile → refused`; `on with a group that does not exist → refused`; `on with a PUBLIC group → refused`; `on with a PRIVATE group → refused, and the message says a personal group cannot host guests`; `on outside multi-tenant → the capability refusal`; `on with a restricted group + known profile → null`; `guestGroupChoices keeps only restricted groups the viewer belongs to`; `withInstanceMember adds once (idempotent), removes, and touches no other group`; config round-trip per cwd, two dirs independent.
- [ ] Step 2: `npm test -- test/tg-guests.test.ts` → FAIL (module missing).
- [ ] Step 3: implement. Step 4: green. Step 5: commit `open DMs: pure core for the guest setup`.

### Task 2: The gate gets a fourth verdict

**Files:** Modify `src/telegram.ts` (`dmGate`); Test `test/telegram.test.ts` (beside the existing `dmGate` tests).

**Interfaces — Produces:** `dmGate(owner: number | null, from: number | undefined, guestsOn = false): "pair" | "allow" | "guest" | "deny"`.
- [ ] Step 1: tests — no sender id → `deny` whatever else is true; no owner → `pair` even with guests on (a stranger must never claim ownership); owner = sender → `allow`; owner ≠ sender, guests off → `deny`; owner ≠ sender, guests on → `guest`. Keep the existing cases passing unchanged (default parameter).
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: green. Step 5: commit `open DMs: dmGate tells a guest from a stranger`.

### Task 3: The configuration route, and the instance as a member

**Files:** Modify `src/server.ts` (`PUT /telegram`, `telegramState`), `src/config.ts` (`TelegramPatch`); Test `test/tg-guests-routes.test.ts`.

**Interfaces — Consumes:** Task 1. **Produces:** `PUT /telegram` accepts `guests: {on, group, profile}`; `GET /telegram` reports it plus `guestGroups` (the choices for the picker). A refusal is a 400 carrying the verdict's reason.
- [ ] Step 1: tests — a patch that would enable with a missing field is refused and **writes nothing**; enabling a valid setup writes the config AND adds `admin` to that group's members; disabling removes it; a second enable on the same group does not duplicate the member; `hasConfigChange` is true for a guests patch (so the bridge restarts); `GET` reports the setup and never a token.
- [ ] Step 2: run → FAIL. Step 3: implement — reuse the existing `accountAdmin(req, res, true, …)` gate, no new door. Step 4: green. Step 5: commit `open DMs: configure the guest group and profile`.

### Task 4: A guest's first message opens a session in the configured group

**Files:** Modify `src/telegram.ts` (`guardDm` → returns the verdict, `handleMessage`, `openBridge`, `bridgeFor`), `src/server.ts` (the WS `start` handler); Test `test/tg-guests.test.ts`, `test/tg-guests-routes.test.ts`.

**Interfaces — Produces:** the `start` frame may carry `guest: true`; the server honours it **only** when `isTelegramBridge`, and then resolves `group`/`profile` from `guestSetupForCwd` — ignoring any `group`/`profile` the frame also carries. With the option off, or the setup invalid, the spawn is **refused** (`fail(...)` with a code), never silently placed in the commons.
- [ ] Step 1: tests — a guest frame on a non-bridge socket is ignored (no group stamped, no profile applied); a guest frame carrying `group: "main"` still lands in the configured group; the option off → refused; the resolved channel row carries `group === <configured>` and `profile === <configured>`.
- [ ] Step 2: run → FAIL. Step 3: implement. **No worktree** for a guest: it runs in its group's own home (`agentStateHome(<group user>)`), per the spec. Step 4: green.
- [ ] Step 5 (live, on a free port): drive the server's own `/ws` with a loopback client presenting the bridge secret, `start {guest:true}`, then read `GET /channels` and assert the stored `group`. This is the Review Focus #1 observation — invariant 24 exists because exactly this was once only inferred.
- [ ] Step 6: commit `open DMs: a guest's agent is born in the configured group`.

### Task 5: What a guest may and may not do

**Files:** Modify `src/telegram.ts` (`handleMessage` command branch, `handleCallback`); Test `test/telegram.test.ts`.

- [ ] Step 1: tests — a `/`-anything from a guest DM never reaches the dispatcher and gets one plain line; `/secret` from a guest is refused AND its message deleted (it carried a value); a callback in a guest's OWN DM is accepted; a callback in a DM that is not the sender's own is refused.
- [ ] Step 2: run → FAIL. Step 3: implement — the command refusal sits **above** `commandRequiresOperator`, which is an allowlist of the privileged ones only. Step 4: green. Step 5: commit `open DMs: a guest talks and answers, nothing else`.

### Task 6: The bridge stops speaking cockpit to a stranger

**Files:** Modify `src/telegram.ts` (`Bridge.guest`, one helper for the bridge's own lines); Test `test/telegram.test.ts`.

**Interfaces — Produces:** `sendOps(b, text)` — used by every line the BRIDGE authors about itself, dropped when `b.guest`. Agent content keeps going through `send`.
- [ ] Step 1: tests — with `guest: true`, the pace-guard line, `— session ended —`, `⚠️ couldn't send …` and the secrets-restart notice produce no outbound call; the same bridge without the flag still sends all four; an agent's own text is unaffected either way.
- [ ] Step 2: run → FAIL. Step 3: implement; enumerate the call sites by reading them once rather than guessing. Note in the code why a dropped line is better than a translated one here: a stranger cannot act on any of them. Step 4: green. Step 5: commit `open DMs: the cockpit's own voice stays out of a guest's DM`.

### Task 7: A guest's bridge survives a restart

**Files:** Modify `src/telegram.ts` (`reconcileWebChannels`, `reconcileOnBoot`); Test `test/telegram.test.ts`.

- [ ] Step 1: tests — with **no board group bound**, a live DM-bound channel is still reattached; a DM channel (no `threadId`) is not skipped by the boot reconciler; a board topic's behaviour is unchanged.
- [ ] Step 2: run → FAIL. Step 3: implement — lift the DM path out of the `loadTgGroup() === null` early return rather than removing the return (the rest of both loops is about the board). Step 4: green. Step 5: commit `open DMs: a DM bridge is rebuilt without a board group`.

### Task 8: The panel

**Files:** Modify `public/index.html` (the Telegram panel); Test `test/csp.test.ts` (no new bare inline script), plus a source scan like the other UI tests.

- [ ] Step 1: the switch, the group picker (fed by `guestGroups`), the profile picker. Disabled with a plain reason outside multi-tenant. One sentence saying exactly what the group buys: its own Unix user, visible only to its members — and that its members can read those conversations.
- [ ] Step 2: invariants 10 and 12 — any new inline script carries `__CSP_NONCE__`, nothing paints before `DOMContentLoaded`, no `onclick=`. Touch fields stay 16px (invariant 28).
- [ ] Step 3: verify in a browser on a free port (Playwright borrowed by absolute path), read the screenshots back, capture the console. Step 4: commit `open DMs: the Telegram panel`.

### Task 9: Docs ship with the change

**Files:** Modify `CLAUDE.md` (the `src/telegram.ts` row + a new invariant thesis if one is earned), `docs/invariants.md` (append with the next sequential `inv-<n>` anchor, never renumbering), `docs/architecture.md` (a section in the Telegram bridge: the guest door, what the group buys, where the group comes from), `README.md` (the user-visible feature + the new `/telegram` fields).

- [ ] Step 1: write them. The invariant worth recording, if the build confirms it: **a door open to strangers must decide, line by line, what the cockpit says to someone who is not its operator** — the pace line was the proof.
- [ ] Step 2: `npm run build && npm test` green. Step 3: commit `open DMs: docs`.

## Verification before the PR

- `npm run build` clean; `npm test` fully green, with the new test files named in the PR body.
- The live assertion from Task 4 Step 5 quoted in the PR (the stored `group`), since that single field is what the feature's safety rests on.
- Stated plainly in the PR, because it cannot be done here: the **real Telegram round trip** is unverified. The bot token is keyed by launch directory and a second instance would steal the long-poll from the live cockpit, so a stranger's DM producing an agent in the group is the operator's own check, on their instance.
