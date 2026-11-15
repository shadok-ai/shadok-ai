# Shadok-AI desktop

A desktop app (macOS, Windows, Linux) that shows several shadok-ai cockpits in
one window: a sidebar of instances, and the selected cockpit beside it. It
wraps the web cockpit as it is; nothing has to change on the server.

Design and trade-offs: `docs/superpowers/specs/2026-11-15-desktop-client-design.md`.

## Run it

```bash
cd desktop
npm install      # downloads Electron (~100 MB); needs npm scripts enabled
npm start
```

Add an instance with **+ Add instance** (or `Cmd/Ctrl+N`):
`http://localhost:3789` for the cockpit on this machine, or the HTTPS address
of a remote one. Sign in as you would in a browser; the login is remembered.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+1…9` | switch to instance 1…9 |
| `Cmd/Ctrl+N` | add an instance |
| `Cmd/Ctrl+R` | reload the current instance |
| `Cmd/Ctrl+Shift+R` | reload it, ignoring the cache |

Double-click an instance to rename it, or drag it to reorder. Hovering an
instance shows reload, rename and remove buttons. Removing one only forgets
its address and its login; the cockpit itself is not touched.

When an agent on any instance is waiting for an answer, its dot turns red, the
Dock icon shows a count (the taskbar flashes on Windows), and a notification
appears unless that instance is already on screen.

## Package it

```bash
npm run dist:mac     # .dmg, arm64 + x64 — must run on a Mac
npm run dist:win     # NSIS installer, x64 + arm64
npm run dist:linux   # AppImage
```

Output goes to `desktop/dist/`. Builds are **unsigned**:

- macOS refuses to open the app the first time. Right-click it → **Open** once.
- Windows SmartScreen warns. Choose **More info → Run anyway**.

Signing needs an Apple Developer account and a Windows code-signing
certificate (see the spec's "Not in this version").

## Layout

| File | Role |
|---|---|
| `main.mjs` | Electron main process: window, one view per instance, IPC, menu, notifications |
| `preload.cjs` | The sidebar's only bridge into main (loaded into the shell, never into a cockpit) |
| `shell/` | The sidebar page |
| `lib/instances.mjs` | Pure logic (saved list, URL rules, title badge), tested by `test/desktop-instances.test.ts` at the repo root |

The saved list lives in the app's user-data folder (`instances.json`, mode
600): `~/Library/Application Support/Shadok-AI` on macOS,
`%APPDATA%\Shadok-AI` on Windows, `~/.config/Shadok-AI` on Linux.
