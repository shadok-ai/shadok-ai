# A cron wakes its session in the channel's own directory

*2026-07-30*

## The problem

`driveChannel` — the half of a cron fire that actually talks to the agent —
resumes the session like this:

```ts
ws.send(JSON.stringify({ type: "start", resume: sessionId, cwd: process.cwd(), origin: "cron" }));
```

`process.cwd()` is the directory the *server* was launched from: the repo root.
Invariant nº 1 says `loadHistory` is keyed by the cwd
(`~/.claude/projects/<encoded cwd>/<id>.jsonl`), so a **worktree** session
resumed with the repo root loads **no history** — the agent wakes up amnesic in
the wrong directory. #112 taught the transcript tail to follow a `.jsonl` across
a cwd change; it did not fix the resume itself.

The two halves of the same fire disagree. `runCronCheck`, ten lines above,
already resolves the channel:

```ts
const ch = loadChannels().find((x) => x.sessionId === c.sessionId);
const cwd = ch?.cwd || process.cwd();
```

So the guard runs in the worktree and the session is resumed at the root. Two
places decide the same thing, one of them wrongly.

Not theoretical: on this machine cron `6bbfa33a` targets session `71b1515d`,
whose channel lives in `~/.shadok-ai/worktrees/shadok-ai-71b1515d`. It has never
bitten only because its guard has been silent since it was created (`cron:
6bbfa33a quiet` on repeat in `~/.shadok-ai/local-supervisor.log`) — the fire
never reaches `driveChannel`.

## The fix

### 1. One resolver, shared by both halves — `resolveCronTarget`

A pure function in `src/crons.ts` (where `DriveReason` already lives, precisely
so this kind of decision is testable without the server):

```ts
export interface CronTarget {
  cwd: string;
  profile: string | null;
  branch: string | null;
  repo: string | null;
  known: boolean; // was a channel actually found?
}

export function resolveCronTarget(
  channels: readonly Channel[],
  sessionId: string,
  fallbackCwd: string,
): CronTarget;
```

`known: false` + `cwd: fallbackCwd` when no channel carries that `sessionId` —
the historical behaviour, kept as a fallback rather than a failure: a cron whose
channel record was lost should still fire from the repo root, which is right for
the common case (a channel created at the root). It logs one line when it does,
because firing from the fallback is a guess and "ran somewhere unexpected" must
not be silent:

```
cron: 6bbfa33a no channel for session 71b1515d — falling back to /Users/…/shadok-ai
```

`runCronCheck` and `fireCron` now call it **once per fire** and pass the result
down, so the guard and the resume can no longer diverge. `driveChannel` takes the
target as an argument instead of reaching for `process.cwd()`.

### 2. `branch` / `repo` travel with the resume

The `start` handler can recreate a reclaimed worktree checkout, but only when the
message carries both fields:

```ts
if (resumed && msg.branch && msg.repo && !fs.existsSync(effectiveCwd)) {
  ensureWorktreeCheckout(msg.repo, msg.branch, effectiveCwd);
}
```

`Channel` stores both (`branch`, `repo`, both server-owned), so the cron can
supply them — and a cron on a worktree channel whose checkout was pruned now
repairs itself instead of dying. They are only sent when present: a plain
root-directory channel has no `branch`, and sending `null` would be a protocol
change for nothing (`ClientMessage.branch` is `string | undefined`).

**Forwarding them is useless unless they survive.** Checked against the live
registry: `71b1515d` has `repo` set and `branch: null`, although it *is* a
worktree channel. The start handler patched the channel with

```ts
upsertChannel({ sessionId: id, cwd: effectiveCwd, branch: worktree?.branch ?? null, … });
```

and `worktree` is only built when a checkout is *created* — a resume always has
`null`. Since `upsertInto` writes any non-`undefined` value, the first resume
**erased** the branch recorded at creation. `branch` is now only ever *asserted*
(the key is omitted when we hold no worktree), which is how `repo` already
behaves — it is never rewritten on resume. Without this half, §2 is dead code on
every channel that has been resumed once, i.e. all of them.

The `ready` message still reports `branch: worktree?.branch ?? null`. That is the
live session's own view, and what the web client shows in its branch gauge —
changing it is a UI question, out of scope here.

Note the ordering the handler already has: for a **tmux** session still alive,
`effectiveCwd` comes from the live pane and wins over the message's `cwd`. That
is correct and unchanged — a running pane knows its directory better than we do.
Our `cwd` matters exactly when the session is *not* running, which is the cron
case.

### 3. `gone` becomes its own outcome

`gone` (the channel's directory no longer exists) was folded into `error`. It is
non-transient either way, so no retry loop — but the log line said `error`, which
buries the one diagnosis a human needs. It becomes a `DriveReason` of its own:

```
cron: 6bbfa33a fired -> gone: working directory no longer exists: /…/shadok-ai-71b1515d
```

Excluded from `TRANSIENT`, like `error`: replaying in 10 min would fail
identically. The cron is **not** auto-disabled — a checkout can come back (and
with §2 it usually recreates itself), so silently killing the schedule would trade
a loud failure for a quiet one. It keeps its normal slot and logs each time.
`stopped` (someone ended the session) stays `error`.

## Tests

`test/crons.test.ts`:

- `resolveCronTarget` finds the channel's cwd, profile, branch and repo;
- falls back to `fallbackCwd` with `known: false` for an unknown session, and
  normalizes missing/`undefined` fields to `null`;
- picks the right channel when several share a `cwd` (match is on `sessionId`);
- `isTransient("gone") === false`.

`test/channels.test.ts`: `upsertInto` keeps a recorded `branch`/`repo` when the
patch omits them (the resume case), and still clears `branch` on an explicit
`null` — the guard belongs at the call site, not in the store.
