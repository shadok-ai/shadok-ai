# Direct messages belong to one person only

*2026-07-29*

## The problem

A group is already bounded: `handleMessage` refuses any group that is not the one
bound by `/setup`. **DMs had no bound at all.** The only filter is
`allowedChats`, and it only applies when configured:

```ts
if (allowed.length && !allowed.includes(String(chat.id))) { … }
```

Checked on the installation in service: **no allowlist configured**. So anyone
who discovered the bot obtained, by writing one message, a Claude Code session on
the machine — with the user's rights.

## The intended behaviour

The first to write in private claims the DMs. Everyone else gets "⛔ This bot is
private." and nothing else happens: no session, no channel created.

An explicit `allowedChats` still wins — it filters upstream. This guard is the
**default**, for the installation that configures none.

## Architecture

### The decision, pure (`src/telegram.ts`)

```ts
export function dmGate(owner: number | null, from: number | undefined): "claim" | "allow" | "deny";
```

A sender **with no id** is refused even when nobody has claimed yet: there is
nothing to store, so accepting them would leave the door open for the next one.

### The owner (`src/channels.ts`)

`…-telegram-owner.json`, like the bound group: one id, per launch directory. To
start from scratch, delete the file.

### Closing the deployment window

"First to write wins" has a flaw on an installation **already in service**:
between the update and the user's first message, a stranger can lock them out. So
`adoptOwnerFromBindings`, at startup, names the owner without waiting:

1. **an existing DM binding** (a positive chat id, with no topic — groups are
   negative);
2. otherwise **the bound group's creator** (`getChatAdministrators`, `status:
   "creator"`, bots excluded): that is whoever set this board up;
3. only otherwise does the first message claim it.

Case 2 is not theoretical: the installation in service has **no** DM binding
(everything goes through the group), so without it the window would have stayed
open. Verified by reproduction — startup logs
`DM owner adopted from the board group's creator`.

### The buttons too

`handleCallback` applies the same verdict in private. A keyboard can only appear
after an accepted message, so in principle this path is unreachable — we close it
rather than depend on that assumption. Never a `claim` from a click: DMs are
claimed by writing.

## What stays exposed (the user's decision)

In the bound group, **any member** can drive the agents. That is consistent with
the model (a shared board), and the protection there is group membership. To be
restricted to the owner only if the group ever hosts third parties.

## Tests

`dmGate` carries the tests: claiming, the owner recognised, a third party
refused, a sender with no id refused in both states. Adoption at startup is
verified by reproduction (both sources).

Refusing a real third-party DM cannot be automated: a bot cannot write to another
bot, it would take a second user account.
