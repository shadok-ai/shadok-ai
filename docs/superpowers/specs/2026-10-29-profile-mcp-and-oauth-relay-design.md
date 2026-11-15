# MCP servers on profiles, and an OAuth callback relay

## The problem, as it happened

A marketing agent in a container needed four data sources (Matomo, Search
Console, HubSpot, Bing). Two gaps showed up:

1. **No place for an MCP server.** The only route was the agent running
   `claude mcp add … --header "Authorization: Bearer <token>"` itself, which
   writes the token in clear into `~/.claude.json` — outside the vault, outside
   every guarantee the vault gives (write-only, never in argv, never printed).
2. **OAuth sign-ins cannot finish.** An MCP that signs in by OAuth (HubSpot's
   official server, a Search Console helper) redirects the browser to
   `http://localhost:PORT/…` on the agents' machine. With shadok in a container
   or on a remote box, the browser is elsewhere: the page fails to load and the
   agent waits for a callback that never comes.

## 1. `mcpServers` on a profile

- A profile gains `mcpServers`, the CLI's own `--mcp-config` shape (stdio /
  http / sse). `profileArgs` emits it as `--mcp-config <json>`.
- A credential is written `${NAME}` and `NAME` is ticked under the profile's
  secrets. The CLI expands `${NAME}` from the env those secrets already put
  there. **Measured** (CLI 2.1.312, interactive agent in tmux, and `-p`): stdio
  `args` and `env`, and http `headers`, are all expanded.
- The tmux launcher single-quotes every argument, so `sh` passes `${NAME}`
  through untouched; `test/profile-mcp.test.ts` runs the real launcher script
  and checks the value reaches env and never argv.
- `--mcp-config` is variadic: it is emitted before `--settings` (always present)
  so it can never swallow a following word.
- `mcpServersVerdict` validates the shape and **refuses a vault value pasted
  verbatim** (≥ 8 chars) — the one mistake that would undo the point.
- Caveat documented, not enforced: `${NAME}` in `args` ends up expanded in the
  MCP server's own command line. Use `env` or `headers` for secrets.

Rejected: writing a per-agent `.mcp.json` into the worktree (pollutes the
repo's tree and diff), and `claude mcp add` at spawn (writes the value to
`~/.claude.json`).

## 2. `POST /oauth-relay`

- Web UI only (`requestFromBrowser`): the address carries a one-time code.
- `relayTarget` accepts **only** `http://` + loopback host + explicit port, no
  credentials — it relays a callback and cannot become a general fetch.
- `localhost` is tried as `127.0.0.1` then `[::1]`: on macOS Node resolved
  `localhost` to `::1` only and got ECONNREFUSED from an IPv4 listener.
- The listener's page is returned as ≤ 300 chars of plain text — the only proof
  the sign-in landed.
- UI: a collapsed *Finish a sign-in for an agent (OAuth)* section in the
  Secrets panel.

Not measured: a full sign-in against a real provider (HubSpot) through the
relay, from a container. The mechanics are tested against a real HTTP
listener; whether a given MCP prints its auth URL where the person can see it
(the engine room) depends on that MCP.
