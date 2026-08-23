# Design — The Escape key sends esc to the session (like the terminal's button)

Date: 2026-07-28
Status: agreed (brainstorming)

## Problem

The engine room's "Esc" button sends the escape to the Claude TUI
(`active.ws.send({type:"key", key:"escape"})`, `public/index.html`), which
interrupts the running turn. But reaching it means opening the engine room.

We want the **keyboard's Escape key**, while in the chat, to send esc to the
active session — without going through the engine room. Today Escape in the
composer does nothing.

## Scope

- **Frontend only** (`public/index.html`): one document-level
  `addEventListener("keydown")` + a small precedence function.
- **No server change.** The `{type:"key", key:"escape"}` message already exists
  (emitted by the `.keys button[data-key]` buttons, line ~2487) and is mapped
  server-side to the escape byte.

Out of scope: the WS protocol, the server, the engine room, the other keys.

## Behaviour (precedence)

On a document-level `keydown` of `Escape`, in order:

1. **An open overlay/panel → close it, do not send esc.**
   - `#secretsOverlay` not `hidden` → close it.
   - else `#profilesOverlay` not `hidden` → close it.
   - else `#diffpanel` has the `.open` class → close it.
   - In those cases: `preventDefault()`, and we stop (no esc).
   - *Note:* this adds the "Escape closes the panel" behaviour, which did not
     exist (closing was ✕ / backdrop-click only). Intended behaviour.
2. **The engine room (`#machine.open`) is NOT treated as a panel to close**: it
   is the live terminal. So we fall through to the esc case (point 4) even when
   it is open — Escape sends esc there, consistent with the Esc button right next
   to it.
3. **A clickable TUI dialog awaiting an answer** (`active.dialogBubble` present)
   → **do nothing** (let the dialog be answered; do not interrupt). No
   `preventDefault`.
4. **Otherwise, an active session** (`active` exists, `active.ws` open,
   `readyState === OPEN`, session not in `setup`) → send
   `active.ws.send(JSON.stringify({type:"key", key:"escape"}))` then
   `preventDefault()`.
5. **Otherwise** (no active session) → do nothing.

## Interactions & guardrails

- **Inline edit (renaming a channel/tab)**: its input already calls
  `e.stopPropagation()` on `keydown` (with its own Escape = cancel). The document
  handler therefore does not fire while editing. No conflict.
- **Input fields inside an overlay** (e.g. `#secretKey` in the secrets overlay):
  they do not call `stopPropagation`. Pressing Escape there → point 1 closes the
  overlay. Desirable behaviour.
- **The composer (`#promptInput`)**: no Escape handler today; pressing Escape
  while typing there → esc is sent (point 4). The draft is not cleared.
- Point 4 depends on nothing new: it reuses `active.ws` exactly like the engine
  room's buttons.

## Components touched

| Element | Change |
|---|---|
| the JS in `public/index.html` | adds a `document.addEventListener("keydown", …)` handling `Escape` per the precedence above. Placed near the other global handlers (after the `.keys button` block). |

## Success criteria

1. Active session, no panel open, focus in the composer → Escape interrupts the
   turn (identical to the terminal's Esc button).
2. Active session, engine room open → Escape sends esc (does not disturb the
   display, does not close the engine room).
3. Secrets / profiles / diff open → Escape closes the panel, sends no esc.
4. A clickable dialog awaiting an answer → Escape does nothing.
5. An inline rename in progress → Escape cancels the rename (existing behaviour
   unchanged), sends no esc.
6. No active session → Escape does nothing disruptive.
7. `npm run build` OK (no `.ts` touched), verified in the browser.
