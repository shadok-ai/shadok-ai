# Design — An interactive TUI terminal in the web UI (experimental)

Date: 2026-07-28
Status: agreed (brainstorming)

## Idea

Today the engine room shows the TUI screen **read-only** (`#screen`, a polled
`capture-pane` snapshot) + a few key buttons. We want a **real interactive
terminal**: the TUI's complete ANSI stream rendered by xterm.js, and the ability
to **type into it** (full keyboard passthrough: arrows, Ctrl, Escape,
everything). An **experimental** feature, behind a **global toggle**.

## Target

The **tmux** transport (the default, survives restarts) — so it is usable in the
real cockpit. The data plane was de-risked in the shell: `pipe-pane` streams the
raw output fine, `send-keys -H` injects the input.

## Architecture

### Server — `TmuxPilot` (new methods)

- `seed(): string` — `tmux capture-pane -e -p`: the current screen WITH escape
  sequences (colours), to prime the terminal on attach (pipe-pane only captures
  the **new** stream).
- `sendRaw(data: Buffer)` — `tmux send-keys -H <hex…>`: injects raw bytes.
- `attachRaw(onData): () => void` — `tmux pipe-pane -O -t <name> 'cat >> <tmpfile>'`
  then tails the file (poll ~40 ms, offset) → `onData(chunk)`. Returns a detach
  (closes the pipe, removes the file). One consumer per pilot; the server fans
  out to the WS clients.
- **No tmux resize**: the control plane scrapes that screen (dialogs, end of
  turn) — resizing it would break the detection. xterm displays the pane's native
  size.

Reserved to `TmuxPilot` (the live transport). `PtyPilot`: not covered by the MVP.

### Server — `server.ts` (WS)

- `term-attach` → when not already attached: `broadcast(term-data seed)` then
  `attachRaw`, which does `broadcast(term-data, base64(chunk))`. Refcounted per
  session.
- `term-input {data:base64}` → `sendRaw(Buffer.from(data,'base64'))`.
- `term-detach` → stops `attachRaw` once no client remains attached.
- `term-data {data:base64}` (server→client).
- base64 throughout: control bytes do not survive raw JSON.

### Client — `public/index.html`

- **Vendoring** `@xterm/xterm` (JS + CSS) served as `/vendor/xterm.js` /
  `/vendor/xterm.css` (the same mechanism as `/vendor/marked.js`).
- **A global experimental toggle**: a checkbox in the ⋯ menu ("⚡ Interactive
  terminal (exp.)"), persisted as `localStorage["cp.expTerminal"]`.
- When the toggle is ON and the engine room is open: we instantiate an xterm.js
  `Terminal` in a container (in place of / above the read-only `#screen`), send
  `term-attach`, `term.write(atob(data))` on `term-data`, and
  `term.onData(d => ws.send(term-input, btoa(d)))`. On close / toggle OFF →
  `term-detach` + `term.dispose()`.
- Toggle OFF → the current behaviour unchanged (read-only `#screen`).

## Security / risks

- Writing raw into the pane interferes with the cockpit's control plane (turn
  detection) — accepted, that is what the experimental mode is.
- pipe-pane into a temp file (40 ms poll): ~40 ms output latency, acceptable for
  typing. The file is removed on detach.
- The seed (capture-pane -e) can put the cursor slightly out of step with the
  stream; acceptable for a prototype.

## Verification

- **Headless (no browser)**: on a test server at **port 3899**, prove the data
  plane end to end — attach through a test WS client, check the seed + the stream
  arrive and that `term-input` writes into the pane (read back with
  `capture-pane`). The xterm.js rendering itself: to be checked by eye (the MCP
  browser is disconnected).
- `npm run build` (TS touched: tmux.ts, server.ts).

## Success criteria

1. Toggle ON → the engine room shows a live, coloured xterm.js terminal.
2. The TUI's output (typing, dialogs) streams continuously.
3. Typing in the terminal (arrows, letters, Enter, Ctrl-C, Escape) acts on the
   TUI.
4. Toggle OFF → the current read-only screen, with no residual stream (a clean
   detach).
5. No regression of the cockpit with the toggle OFF.

## Out of the MVP (YAGNI)

tmux↔xterm resize, scrollback, mouse, PtyPilot support, several tabs streaming
raw at once.
