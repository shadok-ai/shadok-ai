// Shadok-AI desktop: one window, a sidebar of cockpit instances, and each
// instance's own web page beside it. The cockpit is loaded AS IS — nothing on
// the server knows or cares that this is not a browser tab.
//
// Layout: the window loads `shell/` (the sidebar, a local page with a narrow
// preload bridge). Each instance is a WebContentsView laid over the content
// area, in its own persistent session partition. Views are created on first
// open and then kept alive while hidden, so switching instances reloads
// nothing and drops no WebSocket.

import { app, BaseWindow, WebContentsView, ipcMain, shell, session, Menu, Notification } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseInstances,
  addInstance,
  renameInstance,
  removeInstance,
  moveInstance,
  partitionFor,
  titleWantsAttention,
  cleanTitle,
  attentionCount,
  staysInView,
  externalAllowed,
} from "./lib/instances.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDEBAR_W = 232;

// One app instance: a second launch focuses the first. Two processes would
// race on instances.json and open every cockpit twice.
if (!app.requestSingleInstanceLock()) app.quit();

// ---------------------------------------------------------------- storage --

const storeFile = () => join(app.getPath("userData"), "instances.json");

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(storeFile(), "utf8"));
    const instances = parseInstances(raw);
    const active = instances.some((i) => i.id === raw.active) ? raw.active : instances[0]?.id ?? null;
    return { instances, active };
  } catch {
    return { instances: [], active: null };
  }
}

function saveState() {
  // Atomic: a crash mid-write must not leave a truncated list behind.
  const file = storeFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({ instances: state.instances, active: state.active }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

let state = { instances: [], active: null };

// ------------------------------------------------------------------ views --

/** @type {BaseWindow | null} */
let win = null;
/** @type {WebContentsView | null} */
let shellView = null;
/** @type {Map<string, WebContentsView>} */
const views = new Map();
/** Per-instance live status: { title, attention, loading, error }. */
const status = {};

function contentBounds() {
  const [w, h] = win.getContentSize();
  return { x: SIDEBAR_W, y: 0, width: Math.max(0, w - SIDEBAR_W), height: h };
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  // The shell spans the whole window: when the active instance failed to load
  // its view is hidden, and the shell's own content area shows the error.
  shellView.setBounds({ x: 0, y: 0, width: w, height: h });
  for (const v of views.values()) v.setBounds(contentBounds());
}

function pushState() {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send("state", {
    instances: state.instances,
    active: state.active,
    status,
  });
  const n = attentionCount(status);
  // setBadgeCount works on macOS and some Linux docks; Windows has no numeric
  // badge, so it falls back to flashing the taskbar entry (see setAttention).
  if (process.platform !== "win32") app.setBadgeCount(n);
}

function setStatus(id, patch) {
  status[id] = { ...(status[id] || {}), ...patch };
  pushState();
}

function instance(id) {
  return state.instances.find((i) => i.id === id);
}

/** Configure a partition once: permissions, and nothing else. */
const configured = new Set();
function configureSession(id) {
  const part = partitionFor(id);
  const ses = session.fromPartition(part);
  if (configured.has(part)) return ses;
  configured.add(part);
  // What the cockpit actually uses: the microphone (dictation), the clipboard
  // (copy buttons), notifications and fullscreen. Everything else — camera,
  // geolocation, MIDI, HID… — is refused: a page in this view may be showing
  // Markdown an agent wrote.
  const ALLOWED = new Set(["media", "clipboard-sanitized-write", "clipboard-read", "notifications", "fullscreen"]);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const inst = instance(id);
    const fromInstance = inst && staysInView(inst.url, details.requestingUrl || wc.getURL());
    if (!fromInstance || !ALLOWED.has(permission)) return callback(false);
    if (permission === "media") {
      // Audio only: nothing in the cockpit uses the camera.
      const types = details.mediaTypes || [];
      return callback(types.length > 0 && types.every((t) => t === "audio"));
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const inst = instance(id);
    return !!inst && staysInView(inst.url, requestingOrigin) && ALLOWED.has(permission);
  });
  return ses;
}

function openExternal(url) {
  if (externalAllowed(url)) shell.openExternal(url);
}

function createView(inst) {
  configureSession(inst.id);
  const view = new WebContentsView({
    webPreferences: {
      partition: partitionFor(inst.id),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A hidden instance must keep its socket alive and keep updating its
      // title, or the sidebar would never learn that an agent is waiting.
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  const wc = view.webContents;

  // Links: same origin stays here, everything else goes to the system browser.
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    const cur = instance(inst.id);
    if (!cur || !staysInView(cur.url, url)) {
      e.preventDefault();
      openExternal(url);
    }
  });

  wc.on("page-title-updated", (_e, title) => {
    const attention = titleWantsAttention(title);
    const was = !!status[inst.id]?.attention;
    setStatus(inst.id, { title: cleanTitle(title), attention });
    if (attention && !was) announce(inst.id);
  });
  // Chromium commits its own error page after a failed load and reports THAT
  // as a finished load — so "finished" only clears the error when nothing
  // failed since the load began, or an unreachable cockpit would show blank.
  let failed = false;
  wc.on("did-start-loading", () => {
    failed = false;
    setStatus(inst.id, { loading: true });
  });
  wc.on("did-stop-loading", () => setStatus(inst.id, { loading: false }));
  wc.on("did-finish-load", () => {
    if (failed) return;
    setStatus(inst.id, { error: null });
    showActive();
  });
  wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation replaced by another, not a failure.
    if (!isMainFrame || code === -3) return;
    failed = true;
    setStatus(inst.id, { error: `${desc} (${code})`, loading: false });
    showActive();
  });
  wc.on("render-process-gone", (_e, details) => {
    setStatus(inst.id, { error: `The page crashed (${details.reason}).` });
    showActive();
  });

  view.setBounds(contentBounds());
  view.setVisible(false);
  win.contentView.addChildView(view);
  views.set(inst.id, view);
  wc.loadURL(inst.url);
  return view;
}

/**
 * True while the shell shows a modal (the add dialog). The shell page sits
 * UNDER the instance views, so a dialog centred in the window would otherwise
 * be drawn behind the cockpit and never seen.
 */
let overlay = false;

/** Show the active instance's view, hide every other one. */
function showActive() {
  for (const [id, v] of views) {
    const show = !overlay && id === state.active && !status[id]?.error;
    v.setVisible(show);
    if (show && win?.isFocused()) v.webContents.focus();
  }
  pushState();
}

function activate(id) {
  const inst = instance(id);
  if (!inst) return;
  state.active = id;
  saveState();
  if (!views.has(id)) createView(inst);
  showActive();
}

function destroyView(id) {
  const v = views.get(id);
  if (!v) return;
  win.contentView.removeChildView(v);
  v.webContents.close();
  views.delete(id);
}

// --------------------------------------------------------------- attention --

/**
 * An instance just started wanting attention. Tell the person — but only if
 * they cannot already see it: a notification for the cockpit you are looking
 * at is noise (the page has its own ding).
 */
function announce(id) {
  const visible = win && win.isFocused() && state.active === id;
  if (visible) return;
  const inst = instance(id);
  if (process.platform === "win32" && win && !win.isFocused()) win.flashFrame(true);
  if (Notification.isSupported() && inst) {
    const n = new Notification({ title: inst.name, body: "An agent is waiting for you.", silent: true });
    n.on("click", () => {
      win?.show();
      win?.focus();
      activate(id);
    });
    n.show();
  }
}

// -------------------------------------------------------------------- IPC --

// Every handler checks that the call comes from the shell page, never from an
// instance's view: those run remote content, and only the shell has a preload.
function fromShell(e) {
  return shellView && e.sender === shellView.webContents;
}

function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromShell(e)) throw new Error("refused");
    return fn(...args);
  });
}

handle("get-state", () => ({ instances: state.instances, active: state.active, status }));

handle("add", (input) => {
  const res = addInstance(state.instances, input, randomUUID());
  if (!res.ok) return res;
  state.instances = res.list;
  activate(res.id);
  return { ok: true };
});

handle("rename", (id, name) => {
  state.instances = renameInstance(state.instances, id, name);
  saveState();
  pushState();
});

handle("remove", async (id) => {
  destroyView(id);
  delete status[id];
  state.instances = removeInstance(state.instances, id);
  if (state.active === id) state.active = state.instances[0]?.id ?? null;
  saveState();
  // Forget the login and the cockpit's cached state with the entry: a removed
  // instance must not leave a valid session cookie on disk.
  await session.fromPartition(partitionFor(id)).clearStorageData().catch(() => {});
  if (state.active) activate(state.active);
  else showActive();
});

handle("move", (id, toIndex) => {
  state.instances = moveInstance(state.instances, id, toIndex);
  saveState();
  pushState();
});

handle("activate", (id) => activate(id));

handle("reload", (id) => {
  const v = views.get(id);
  setStatus(id, { error: null });
  if (v) v.webContents.reload();
  else activate(id);
});

handle("overlay", (on) => {
  overlay = !!on;
  showActive();
});


// ------------------------------------------------------------------- menu --

function reloadActive(hard) {
  const v = state.active && views.get(state.active);
  if (!v) return;
  setStatus(state.active, { error: null });
  hard ? v.webContents.reloadIgnoringCache() : v.webContents.reload();
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const switchItems = Array.from({ length: 9 }, (_, i) => ({
    label: `Instance ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => state.instances[i] && activate(state.instances[i].id),
  }));
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Add instance…",
          accelerator: "CmdOrCtrl+N",
          click: () => shellView?.webContents.send("command", "add"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    // The Edit menu is not decoration: on macOS, copy/paste shortcuts only
    // reach a web page through it.
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Reload instance", accelerator: "CmdOrCtrl+R", click: () => reloadActive(false) },
        { label: "Force reload instance", accelerator: "CmdOrCtrl+Shift+R", click: () => reloadActive(true) },
        {
          label: "Developer tools (instance)",
          accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => state.active && views.get(state.active)?.webContents.toggleDevTools(),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "Instances", submenu: switchItems },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ----------------------------------------------------------------- window --

function createWindow() {
  win = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: "Shadok-AI",
    backgroundColor: "#14161a",
  });
  shellView = new WebContentsView({
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The shell is local and has the bridge: it must never navigate anywhere.
  shellView.webContents.on("will-navigate", (e) => e.preventDefault());
  shellView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.contentView.addChildView(shellView);
  shellView.webContents.loadFile(join(HERE, "shell", "index.html"));

  layout();
  win.on("resize", layout);
  win.on("focus", () => {
    if (process.platform === "win32") win.flashFrame(false);
    const v = state.active && views.get(state.active);
    if (v && v.getVisible()) v.webContents.focus();
  });
  win.on("closed", () => {
    // A WebContentsView's page outlives its window unless closed explicitly:
    // left alone, every cockpit would keep its socket open in the background.
    for (const v of views.values()) if (!v.webContents.isDestroyed()) v.webContents.close();
    if (shellView && !shellView.webContents.isDestroyed()) shellView.webContents.close();
    win = null;
    shellView = null;
    views.clear();
  });

  if (state.active) activate(state.active);
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  state = loadState();
  buildMenu();
  createWindow();
  // macOS: clicking the Dock icon with no window open reopens one.
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
