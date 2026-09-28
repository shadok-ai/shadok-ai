# Cross-instance agent collaboration — remote pilot over an authenticated WS

**Date:** 2026-09-26
**Status:** design

## Goal

Today agents collaborate only **within** one instance: `kinship` links a parent
and child, `pilotctl` spawns/drives siblings over the **loopback** WS, the ledger
is per instance. We want an agent on instance **A** to drive and collaborate with
an agent on instance **B** — another shadok first, and eventually other harnesses
(openclaw / hermes). Access is by a credential, like the web accounts; the
interface is the existing agent skill/CLI.

Decided in brainstorming:

- **Both messaging and delegation on one link.** Messaging is the primitive;
  delegation = send a task and await the correlated result. Remote piloting gives
  both for free (drive a turn, follow its stream, read the diff).
- **Remote `pilotctl` over the native WS, full fidelity** (streaming, dialogs,
  diff) — chosen over a thin open protocol, on purpose. Interop with non-shadok
  harnesses is a **documented follow-up** (an HTTP `/inbox` adapter), because B is
  native-fidelity and not open by nature.
- **Named, revocable peer credentials** — the accounts model, for machines.

## The one load-bearing fact this builds on

The WS is gated by `verifyClient: (info) => requestOriginOk(info.req) &&
requestAuthed(info.req)` (`server.ts`). `requestAuthed` already accepts **two**
credentials: the GUI-password **cookie**, or `x-shadok-session-key` (an HMAC of a
local session id, stateless, **non-expiring** — `readSessionKey`, invariant 33).
A **peer token is a third credential in the same place**: nothing about the
transport or the WS handlers changes, only what proves the caller.

## Auth — peer credentials (mirrors invariant 33)

A peer token identifies a **named remote principal**, is **non-expiring**, and is
**revocable by a registry entry** — the exact shape of the session key.

- **Format** `<name>.<hmac>`, signed with the instance's `signingSecret()`:
  `signPeerToken(name, secret) = \`${name}.${hmac("peer:"+name)}\``, verified by
  `readPeerToken` (twin of `signSessionKey`/`readSessionKey` in `accounts.ts`).
  Presented as header **`x-shadok-peer`**.
- **Non-expiring is deliberate.** A cross-instance link is persistent; it must not
  hit the 7-day cookie cliff that left agents `401`-ing on day eight (invariant
  33). An HMAC with no issue time survives restarts and auto-updates.
- **Revocable, because bound to a registry.** The token embeds `name`; verifying
  requires `name` to still be present in B's peer registry
  (`~/.shadok-ai/peers/<launch-dir-key>.json`, 600, per instance like accounts
  and channels). **Delete the entry ⇒ every token for that name is dead.** This
  is the twin of "a session key is bounded by the channel list" (invariant 33) —
  an unforgeable, non-expiring credential still needs something on disk to revoke
  it.
- **A peer is a distinct principal, scoped to its own agents.** Passing
  `requestAuthed` today grants member-level access to *everything*. A peer is an
  **external party**, so it must NOT see or drive B's other agents — only the
  agents **it created**. So `requestAuthed` must resolve the *principal*
  (`admin` / `member` / `peer:<name>` / local `session`), and the session-listing
  and session-driving paths **filter to the caller's own agents when the caller is
  a peer**. This is stricter than "member-level" and is part of the MVP, not a
  follow-up: it is the difference between "collaborate" and "take over B's fleet".

Admin routes (`/users`, etc.) keep their separate admin check, so a peer can never
reach them.

## Components

### Receiving side (instance B)

- **Peer registry** `src/peers.ts` + `~/.shadok-ai/peers/<key>.json`: one row per
  peer `{ name, createdAt, note? }` (no secret stored — the token is derived, like
  the session key). Pure `signPeerToken` / `readPeerToken` / `peerFromToken`
  (validate mac AND registry membership) — unit-tested like `accounts.ts`.
- **Admin API** `/peers` (GET list, POST create → returns the token **once**,
  DELETE revoke), **admin-only** (same gate as `/users`). CLI-drivable for the
  MVP; a GUI **Peers** panel (twin of **Users**) is a follow-up.
- **`requestAuthed` returns a principal**, not a bool at the call sites that need
  it: a new `requestPrincipal(req)` → `{kind, name?}`; `requestAuthed` stays a
  thin `!!requestPrincipal(...)` for `verifyClient`. The WS `connection` handler
  and `/live` / `/diff` / the `stop` path read the principal and, for
  `kind==="peer"`, **restrict to channels whose `createdByPeer === name`**.
- **Ownership tag.** A channel spawned by a peer records `createdByPeer: <name>`
  (asserted at `start`, invariant 24 — a field accepted is not a field stored;
  prove it came out the other side). Shown in B's cockpit ("spawned by peer A"),
  so B's admin always sees who is driving what and can kill it.
- **Revocation cuts live connections too.** Deleting a peer must not only fail
  *future* auth — it must drop the peer's **open** WS connections and stop its
  agents from being driven. `DELETE /peers/<name>` terminates any live WS whose
  principal is that peer (and leaves the spawned agents for B's admin to keep or
  stop — killing another party's in-flight work silently is worse than orphaning
  it under B's control).

### Emitting side (instance A)

- **Outbound peers**: an alias → URL map (`~/.shadok-ai/peers-out/<key>.json` or a
  config field), with the **token kept in the vault** (a secret per peer,
  never in plaintext config — same discipline as `secrets.ts`). Managed by CLI
  for the MVP.
- **`pilotctl` gains `--peer <alias>`** (or `--server <wss-url> --peer-token …` for
  a one-off): it resolves `wsUrl()` to `<peer-url>/ws` and adds the
  `x-shadok-peer` header on the WS connection (Node's global `WebSocket` honours
  `{ headers }`, already used for the cookie). **Every existing subcommand
  (`spawn`, `prompt`, `diff`, `logs`) works unchanged against the remote** — that
  is the whole point of choosing the native WS: no new client semantics.
- **The `shadok-ai-agents` skill** documents `--peer`, the header, and that a
  `401`/refused link means a missing/revoked peer token (parallel to the
  session-key `401` doc, invariant 33).

## Data flow (delegation = messaging + await)

1. A-agent: `pilotctl --peer B spawn --profile research --cwd /workspace` →
   pilotctl opens `wss://B/ws` with `x-shadok-peer: <token>` → B authenticates the
   peer, spawns a real `Live` on B, tags the channel `createdByPeer: "A"`, returns
   the new session id.
2. A-agent: `pilotctl --peer B prompt <id> "do X"` → drives the remote agent; the
   turn streams back over the same WS → the A-agent reads the result (this IS the
   "await the reply" of delegation).
3. A-agent: `pilotctl --peer B diff <id>` → the remote agent's git diff.

Pure conversation is the same minus the "await": fire a `prompt`, let the remote
agent work, poll or follow. No separate messaging endpoint is needed — the WS
carries both.

## Security — the crux (state it in bold in every doc)

**A peer that can `spawn` on B runs arbitrary code on B's machine, as a third
party.** This is a **deliberate, named, revocable** grant an admin makes on
purpose — never a shared password. Three things keep it honest:

- **A container per instance is the real boundary** (agents run as the same OS
  user — not a sandbox; invariant 26). Cross-instance collaboration makes that
  boundary matter *more*, not less: the SaaS/self-host isolation story is the
  prerequisite, not an afterthought.
- **Ownership scoping** (a peer only sees/drives its own agents) keeps one peer
  from touching B's fleet or another peer's.
- **Revocation is immediate and total** (registry delete kills future auth AND
  live connections).

MVP grants a peer exactly "spawn + drive my own agents." **Finer capability
scoping** — which cwd a peer may use, which roles, a read-only peer, rate limits —
is a **documented follow-up**, not in the first cut.

## Testing

- **Pure** (`test/peers.test.ts`, like `accounts`): `signPeerToken`/`readPeerToken`
  round-trip; a valid mac for a **name absent from the registry** is refused
  (revocation); a tampered mac is refused; `requestPrincipal` classifies
  cookie / session-key / peer / none.
- **Ownership filter** (pure): given a channel list and a peer principal, the
  visible/drivable set is exactly the `createdByPeer===name` subset.
- **End to end** (two instances on free ports, the invariant-24 lesson: only a
  real run proves a `start` field was stored): A's `pilotctl --peer B` spawns,
  prompts and diffs an agent on B; a `DELETE /peers/B` then makes the next call
  `401` **and** drops the live WS; B's other agents were never visible to the peer.

## Out of scope / follow-ups (kept explicit so they are not lost)

- **HTTP `/inbox` adapter** — the open, one-endpoint protocol so openclaw / hermes
  (and any harness) can message a shadok agent without the WS. This is the
  original interop goal, deferred by choosing native-fidelity first.
- **Fine-grained peer scoping** — allowed cwd/role/caps, read-only peers, quotas.
- **GUI Peers panel** (twin of Users) — CLI first.
- **Peer discovery** beyond a manual exchange (B mints a token, hands A the
  URL+token) — a registry/handshake later.
- **A shared multi-party "room"** (brainstorming approach C) — only if a concrete
  many-to-many need appears.

## Open questions to settle in the plan

- Exact home of the outbound alias→URL map (its own file vs a config field vs a
  `peers-out` twin of the inbound registry) — a small call, made in the plan.
- Whether a peer may set `parent` on a remotely-spawned agent (cross-instance
  kinship) — likely yes, but the notification path (`notifyParent`) is loopback
  today; deferred unless needed.
