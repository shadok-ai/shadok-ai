# Desktop client: several cockpits in one window

**Status:** built (first version), in `desktop/`.

## Problem

A cockpit lives in a browser tab. Someone who runs several instances (a local
one, a couple of remote ones) ends up with several tabs, lost among everything
else they have open. A tab gives the cockpit no Dock or taskbar presence, and
no way to tell, without looking at the tab, that an agent on another instance
is waiting for an answer.

## Decision: an Electron wrapper around the unchanged web cockpit

The desktop client is a **window with a sidebar of instances**. Each instance
is the cockpit's own web page, loaded from its URL. The server knows nothing
about it, and nothing in `src/` or `public/` changed to support it.

### Why Electron and not Tauri or a native app

- **One engine on every OS.** Tauri renders with the system webview: WebKit on
  macOS, WebView2 on Windows. The cockpit already carries engine-specific traps
  (invariant 28 is Safari-only). Electron ships Chromium, which is the engine
  the cockpit is developed and verified against.
- **Several pages in one window is a stable API.** `WebContentsView` with its
  own session partition. Tauri's multi-webview support was still behind an
  unstable flag.
- **The cost we accept is the download size** (~100 MB against ~10 MB). For a
  wrapper whose whole point is to show a web page faithfully, that trade is
  worth it.
- A native app (Swift, then something else for Windows) would mean two code
  bases, both still embedding a webview.

The zero-code alternative stays valid and is documented: Chrome or Edge can
"install" a cockpit page as an app. That gives one window per instance and no
sidebar.

## Design

### Layout

`BaseWindow` → one `WebContentsView` for the **shell** (the sidebar, a local
page) that spans the whole window, plus one `WebContentsView` per instance laid
over the content area. A view is created the first time its instance is
opened. After that it **stays alive while hidden**, with
`backgroundThrottling: false`, so switching instances reloads nothing and
closes no WebSocket. That also keeps a hidden cockpit's title updating, which
is what the badge below depends on.

Because the shell sits under the instance views, anything it draws in the
content area is hidden by them. Two cases need the shell visible there:

- the **add dialog**: the shell asks main to hide every view while it is open
  (`overlay`);
- a **failed load**: the failing view is hidden, and the shell's error panel
  ("Could not reach X", Try again) shows through.

### Isolation: a partition per saved entry, not per origin

Each instance gets `persist:instance-<id>`, where `id` is minted when the
entry is added and never changes (a rename keeps the login). It is keyed by
entry and not by origin on purpose. The cockpit caches its channel list in
localStorage, which a browser scopes by origin, and two instances can occupy
the same origin one after the other (CLAUDE.md invariants 34 and 35). Two
entries therefore never share cookies or storage, whatever their URLs.
Removing an entry clears its partition, so no valid session cookie stays on
disk.

### Attention: read the title the cockpit already writes

`public/notify.js` stamps `● ` / `◉ ` at the start of `document.title` when an
agent is blocked or an answer is unread. Electron's `page-title-updated`
reports every change, so the client gets attention state **with no change to
the cockpit**. From that state:

- the sidebar dot turns red;
- the Dock badge (macOS, some Linux docks) shows the number of instances
  waiting;
- the taskbar entry flashes on Windows, which has no numeric badge;
- a native notification appears, unless that instance is the one on screen in
  the focused window. Clicking it opens that instance.

A test pins the glyphs to what `notifyState` really returns, so a change to
the badge cannot silently break the desktop client.

### Security

The shell is the only page with a preload. Every IPC handler checks that the
sender **is the shell**, never an instance view, because those run remote
content (and Markdown an agent wrote).

- Instance views: `contextIsolation`, `sandbox`, no node integration.
- Navigation: same origin stays in the view. Everything else (a GitHub link,
  an OAuth URL in an answer) goes to the system browser, and only `http(s)` and
  `mailto` are handed to the OS.
- Permissions per partition: microphone (audio only, for dictation),
  clipboard, notifications and fullscreen, only for the instance's own origin.
  Everything else is refused.
- Addresses: only `http(s)`, with no credentials in the URL. A bare host gets
  `http` on loopback and `https` elsewhere, so the password is never sent in
  clear by guesswork.

## Verified

`test/desktop-instances.test.ts` covers the pure logic in CI (Electron is not
installed there).

The client was also run end to end: real Electron under Xvfb, driven by
`playwright-core`'s Electron launcher, against two side-by-side cockpits on
free ports. All of these were checked: empty state, dialog hides the views,
`file://` refused, cockpit loads, switching keeps the page alive, storage
isolated between instances, hidden instance's badge lights its dot and the
Dock count (and clears), foreign links go out and the view stays put,
unreachable instance shows the error panel, rename, remove, and list plus
login restored after a relaunch.

Two traps found that way: Chromium reports its own **error page** as a
finished load right after `did-fail-load` (an unreachable cockpit showed
blank), and a `WebContentsView`'s page **outlives its window** unless closed
explicitly.

## Not in this version

- **Signed builds and auto-update.** Unsigned, macOS Gatekeeper refuses the
  app (right-click → Open once) and Windows SmartScreen warns. Signing needs an
  Apple Developer account and ideally a Windows certificate. Auto-update
  (`electron-updater` on GitHub Releases) needs a release workflow. Both are
  the next step if the client is distributed beyond its author.
- A per-instance colour or favicon in the sidebar (the cockpit has a theme per
  launch dir that could be read back).
- Telling "blocked" apart from "unread". The title glyph is the same for both;
  the favicon colour would distinguish them.
