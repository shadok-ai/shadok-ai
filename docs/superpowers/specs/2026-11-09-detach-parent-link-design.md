# Detaching an agent from its parent — design

**Date:** 2026-11-09

## Intent

An agent that spawns another is registered as its **parent**, and hears every
time the child finishes a turn, blocks or dies (`notifyParent`, `src/kinship.ts`).
That link is the right default — delegation is the product's central action —
but there was no simple way to **cut** it once a side task is done. A lead that
spawned a one-off agent kept receiving its reports in its own transcript,
including a business report landing in a dev lead's thread.

The `set-parent` WS message with `parent: null` already existed and already
detached. The gap was reach:

- the only UI control was buried in the **child's** tab menu ("Detach from…"),
  while the human reasons from the **parent** ("get this agent off my back");
- nothing on a tab signalled that a link existed at all;
- an agent driving the tree over `pilotctl` had no command for it — the link
  could only be set at spawn (`--parent`).

## Goals

- Cut a parent/child link from **either** side in the cockpit, in one click.
- Make the link **visible** on the tab, so it can be found without opening a menu.
- Give agents a `pilotctl set-parent` command (re-link or detach a running agent).

## Non-goals

- No change to the link rules (cycle / depth / fan-out). The server remains the
  sole authority (`linkRefusal`); detaching to `null` is always legal.
- No new link semantics, no multi-parent, no persistence changes — `parent` stays
  server-owned on the channel and flows through the existing `set-parent` message.

## Design

Everything rides the existing `{type:"set-parent", parent}` message, which acts
on the session attached to the sending socket and persists via `upsertChannel` +
a `parent` broadcast. Nothing new server-side.

### Web client (`public/index.html`)

- **Parent-side detach.** `openTabMenu` gains a "Children reporting here (N)…"
  entry when the agent has children (`childTabsOf`, tabs whose `parent` is this
  session). It opens `openChildrenDetacher`, the symmetric twin of
  `openParentPicker`: a list of children, each cut with
  `sendTo(child, {set-parent, parent:null})` on the **child's** socket (where the
  message belongs), plus a "Detach all" when there is more than one.
- **🔗 tab indicator.** A `link` icon in `tab-row1`, shown by `refreshLinkBadge`
  when the agent has a parent **or** any children, tooltip naming which. Clicking
  it opens the tab menu at the icon. A parent change moves the badge on both ends,
  so callers use `refreshAllLinkBadges` (cheap, never leaves one side stale),
  invoked from the `parent` WS handler and after each `syncChannels` pass.

### CLI (`context/agents-skill/pilotctl.mjs`)

- `pilotctl set-parent <id> <parent-id|none>` → `cmdSetParent`: attach to the
  session by id, send `set-parent`, wait for the `parent` echo (or a
  `link-refused` error). `parseParentArg` (pure, tested) maps `none`/`null`/empty
  to detach. cwd may be unknown — the server resolves the target from its registry
  (invariant 1).

## Tests

- `test/pilotctl-setparent.test.ts` — `parseParentArg` and the arg routing.
- The UI follows the untested-menu convention; the inline script is syntax-checked
  and every index.html-scanning invariant test (CSP, ESM bridge, ws-url…) stays
  green. No new bridged ESM module, so invariant 10's surface is unchanged.

## Docs

README (the "Agents that report back" bullet), the skill's `SKILL.md` (command
table + the report-back section). No new module or invariant, so `CLAUDE.md`
and `architecture.md` are untouched; the `set-parent` protocol row already exists.
