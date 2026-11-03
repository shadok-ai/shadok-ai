# A logged-out tab returns to the login screen

Status: built. `public/index.html` (one inline `window.fetch` wrapper).

## Problem

The cockpit's own session (the account cookie, a week by default — or the GUI
password changing under a running tab) can lapse **while the page is open**.
From that moment the server answers every request `401 {"error":"unauthorized"}`
and refuses the WebSocket upgrade (`verifyClient`). The page kept running and
failed piecemeal: a paste came back "⚠️ not sent (HTTP 401)", the agent list
froze (`syncChannels` silently 401s), the socket looped "reconnecting" — with
nothing anywhere saying *you are logged out*.

Reported the hard way: the admin tried to send a PDF, it "bugged", and they
worked around it by zipping the file several times. The file was fine and
shadok's transport served it fine; the session had simply expired, and every
attempt 401'd with no hint why. Their ask: **bring the user back to the login
screen when they are no longer authenticated.**

## Decision

**On the first `401` any `fetch` sees, reload to the login screen.** One wrapper
around `window.fetch`, installed in the very first inline `<script>` so it is in
place before the opening `/defaults` and `/channels` fetches.

Three facts make a bare "status === 401 → reload" correct and safe:

- **In the cockpit, 401 can only mean logged out.** Every *authorization*
  failure (a member hitting an admin route, a cross-origin caller) is `403`.
  `401` is reserved for *authentication*: the gate's `{"error":"unauthorized"}`,
  and `/me`. Wrong-password `401`s exist only on the login page, which does not
  load this script. So there is no in-cockpit 401 that is not "session gone".
- **A reload IS the redirect.** `GET /` while logged out already returns the
  login page (the gate answers a `text/html` GET with `sendLogin`, status 401).
  So `location.reload()` renders the login screen — no new route, no client copy
  of the login markup. Signing back in returns to the cockpit as it always did.
- **An idle tab is still caught.** Detection rides on ordinary fetches, and the
  client already polls without user action — `syncChannels` every few seconds,
  `refreshUsage`/`refreshAuthRows` on their timers — so a tab left open gets
  sent to login within seconds of the session lapsing, not only on the next
  click.

A one-shot guard (`goneToLogin`) means a burst of concurrent 401s triggers one
reload, not N.

## Why not the WebSocket

The WS upgrade is also refused when logged out, and it is tempting to key off
its close. But a browser `WebSocket` exposes no HTTP status on a failed upgrade,
so "logged out" is indistinguishable from "server restarting / briefly down"
(an auto-update) — and the reconnect loop must stay quiet for the latter. The
fetch signal is unambiguous (`401` vs a network *rejection*), so the redirect
hangs off fetch and the WS keeps its existing reconnect behaviour untouched.

## Why not false-trigger on an auto-update

While the server is respawning, fetches **reject** (network error) — they do not
resolve `401`. Sessions are stateless (an HMAC-signed cookie, invariant 33), so
they survive the restart: once the server is back, the same cookie validates and
fetches are `200` again. A `401` therefore never comes from a restart, only from
a genuinely invalid/expired session.

## No lost work

A half-typed prompt is already written to `localStorage` on every `input`
(the draft), so the reload loses nothing; the cockpit restores the draft once
the user signs back in.

## Verification

- Build clean, full test suite green (no module surface changed; the existing
  `csp` test still locks the nonce on the new inline block).
- Browser (Playwright, real server on a free port): load the cockpit signed in;
  make the server start returning `401` (session expired); the next poll reloads
  the tab and the **login screen** renders. A `403` (an admin-only route for a
  member) does **not** trigger it. Zero console errors. Prod on 3789 untouched.
