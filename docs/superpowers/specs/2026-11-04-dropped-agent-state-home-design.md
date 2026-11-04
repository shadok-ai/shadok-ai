# Dropped-agent state must live in the drop user's home, not the server's `/root`

**Status:** implemented.

## The bug (measured on correctsms 0.17.3)

A multi-tenant instance runs the server as **root** (`HOME=/root`) and drops each
spawned agent to a non-root OS user (the commons user `main`, or a private
group's `sk-*`). The migration chowns the commons tree (`~/.shadok-ai`,
`~/.claude`) to `main` — but `/root` itself stays `drwx------ root:root`, so the
dropped user **cannot even traverse into it**, let alone read what it now owns.

Two code paths put per-agent state under the **server's** home and so under
`/root`:

- `createWorktree` / `pruneWorktree` / `listPastSessions` (`src/worktree.ts`) —
  `path.join(os.homedir(), ".shadok-ai", "worktrees", …)`.
- `selfRepoDir` / `ensureSelfRepo` (`src/selfrepo.ts`) — `path.join(os.homedir(),
  ".shadok-ai", "self", "shadok-ai")`.

The **Tweak-Shadok-AI** agent always runs in a worktree of the self-repo clone,
so after migration it lands on Claude Code's invalid-settings screen ("a
component that could not be examined") and never reaches a prompt. Any dropped
agent given a worktree hits the same wall. There is a **second** half: even if
the path were reachable, the server creates the checkout **as root**, so the
checkout and git's own worktree admin dir (`<repo>/.git/worktrees/<name>`, where
the agent's index / HEAD / logs live) are root-owned — unwritable by the dropped
agent.

`url2ad-boss` and the home agent work only because they run in `/workspace`
(`main`-owned, reachable) with **no** worktree.

## Decision

Mirror what the migration already does for `~/.claude` (which it relocates into
`/home/main/.claude` for exactly this reason): put the self-repo clone and the
worktrees in the **drop user's own home**, and own them to that user. We do NOT
make `/root` traversable (`711`) — that would expose the server's `~/.claude`
(world-readable, `main`-owned) to every other OS user, and it is the opposite of
the "files move into the owner's home" pattern the migration established.

## The fix

One concept: the **agent state home** — the single home holding *all* of an
agent's on-disk state (its transcript under `~/.claude/projects`, its worktrees
and self-clone under `~/.shadok-ai`). It is the drop user's home when the agent
is privilege-dropped, else the server's own home. The server already had this for
transcripts (`agentTranscriptHome`); it is generalised to `agentStateHome` /
`channelStateHome` and now also drives worktrees + self-clone.

- `src/worktree.ts`: a shared pure `worktreeDir(stateHome, repo, tag)` (so
  create / prune / list can never disagree), and a `stateHome` parameter on
  `createWorktree` / `pruneWorktree` / `listPastSessions`, **defaulting to
  `os.homedir()`** — mono-tenant is byte-for-byte unchanged.
- `src/selfrepo.ts`: a `stateHome` parameter on `selfRepoDir` / `ensureSelfRepo`,
  same default.
- `src/server.ts`:
  - the spawn passes `agentStateHome(dropUser)` into `createWorktree`, then
    `chownAgentStateToDropUser` chowns the checkout **and** its external git
    admin dir to the drop user (best-effort, logged — a failure degrades to the
    old symptom, never fails the spawn);
  - `/tweak/prepare` clones into (and chowns to) the **commons** user's home;
  - prune uses the channel's own state home (so it looks exactly where the spawn
    created the checkout);
  - `/recover` lists from the commons home.

## Scope and the known gap

This fixes the **commons** case (the Tweak agent and any commons worktree agent)
and, by deriving the base generically from the drop user, the *location* and
*ownership* for a private `sk-*` agent's worktree too. A private group's
end-to-end worktree/tweak flow is **not** separately validated here and the
`/recover` listing only scans the commons home; a private group's own worktree
recovery is a separate, pre-existing gap, tracked alongside this change.

## Existing data

No live data is migrated. The self-clone is a throwaway anonymous clone of the
public repo (it simply re-clones at the new path), and a wedged Tweak worktree
holds no real work — so an already-migrated box just ends the stranded Tweak
agent and the next one spawns correctly under the drop user's home.

## Tests

`test/worktree-home.test.ts`: `worktreeDir` / `selfRepoDir` land under the given
state home and default to `os.homedir()`; and an end-to-end case proving
`createWorktree` + `listPastSessions` + `pruneWorktree` agree on an explicit
state home that is **not** `os.homedir()` — the exact regression.
