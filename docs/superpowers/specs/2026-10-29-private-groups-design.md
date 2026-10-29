# Private groups

Status: **built** — 2026-10-29. This is the first slice of
`2026-10-29-multi-tenant-scoped-isolation-design.md`: its "Visibility / access
control (the Slack-channel layer)", without the per-scope OS isolation.

## What it is

A group in the left column can be made **private**. A private group has
**members** (web accounts). Only members see the agents inside it and what they
say. Everyone else, admins included, sees that the group **exists**: its name,
its members and how many agents it holds, locked (🔒). No agent names (they
often give the topic away), no history, no diff, no files, no schedules.

Decided with the user, against the multi-tenant spec's recommendation: privacy
goes on the **existing** tab group rather than on a separate "team" concept. The
cosmetic fields (name, icon, order, collapsed) stay client-owned; the access
fields (`private`, `members`, `owner`) become **server-owned** and are only
written by `POST /groups/private` and `POST /groups/members`.

## Who is who (`Viewer`)

Every request resolves to one viewer, in this order (`viewerOf`, `server.ts`):

| Credential | Viewer | Sees |
|---|---|---|
| no GUI password | `all` | everything — no accounts, no privacy (the door is off) |
| `x-shadok-session-key` | `agent(id)` | public agents + the agents of ITS OWN private group |
| the server's own cookie (`isInternalClient`: Telegram bridge, cron driver, loopbacks) | `all` | everything — it is the server |
| a person's cookie, a member peer | `person(name)` | public agents + the groups where `name` is a member |

The bootstrap admin (`admin`, the instance password) is a person like any other:
it sees a private group's content only if it is a member. Agents present BOTH
`SHADOK_AUTH` (the bootstrap cookie) and their session key; the session key wins,
so an agent is judged as itself and never as the admin.

An agent in a private group can drive its siblings and public agents (pilotctl,
crons); an agent outside cannot reach in. A child spawned by an agent of a
private group lands in that group, so delegating never leaks the work into the
open.

## Enforcement points

All server-side, never trusted to the client:

- `GET /channels` drops hidden agents; `GET /groups` returns a locked stub
  (`locked`, `agentCount`, `members`, `owner`) for a private group the caller is
  not in.
- `PUT /channels` keeps hidden agents untouched (the merge drops what a client
  omits, so a non-member's PUT would otherwise ERASE them), and refuses to move
  an agent into a private group the caller is not in.
- `PUT /groups` keeps private groups the caller is not in exactly as stored, and
  keeps the server-owned fields of every group. A client cannot create a group
  private: that goes through `POST /groups/private`.
- `GET /live`, `GET /sessions`, `GET /crons` filter; `GET /diff`,
  `GET /download`, `DELETE /channel`, `POST`/`DELETE /crons` refuse (403).
- WebSocket `start`: a resume or a `continue` onto a hidden agent is refused
  (`code: "private"`); `group` on a NEW agent is written at spawn so it is never
  public, not even for the few seconds before the client's next PUT; `parent`
  and `set-parent` must name a visible agent; `stop` with a hidden `sessionId`
  is refused.
- Telegram: a board group is shared with everyone in it, so an agent of a
  private group is never mirrored, and an agent bound to Telegram cannot be moved
  into a private group (un-mirror it first).

## Rules for membership

- Making a group private, changing its members, or making it public again needs
  a **person** who is (or becomes, as creator) a member — never an agent, never
  the server itself. An admin who is not a member cannot do any of it.
- Members must be existing accounts. A private group always keeps at least one
  member.
- Deleting an account removes it from every private group's members. Without
  this, an admin could delete a member and re-invite the same name to walk in.
- Making a group public again exposes its agents to everyone; the UI says so.
- Deleting a private group needs a member; its agents then become public, so the
  UI asks first.

## What it does NOT protect (soft isolation, stated plainly)

Every agent runs as the same OS user as the server. Anything with a shell on the
machine — the operator, any agent — can read the transcripts under
`~/.claude/projects` and the registry under `~/.shadok-ai`. Restarting the
server without a password disables accounts and with them all privacy. The
shared ledger is instance-wide: what a private agent records there, everyone's
agents read. Uploaded media (`/media/:name`) is not tied to a group. A socket
already attached to an agent keeps it if its owner is removed from the group,
until it reconnects. Real isolation is the OS-user tier of the multi-tenant
spec.
