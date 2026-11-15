// The sidebar's only door into the main process. Loaded into the LOCAL shell
// page only — never into an instance's view, which runs remote content.
// CommonJS on purpose: a sandboxed preload cannot be an ES module.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  getState: () => ipcRenderer.invoke("get-state"),
  add: (url, name) => ipcRenderer.invoke("add", { url, name }),
  rename: (id, name) => ipcRenderer.invoke("rename", id, name),
  remove: (id) => ipcRenderer.invoke("remove", id),
  move: (id, toIndex) => ipcRenderer.invoke("move", id, toIndex),
  activate: (id) => ipcRenderer.invoke("activate", id),
  reload: (id) => ipcRenderer.invoke("reload", id),
  setOverlay: (on) => ipcRenderer.invoke("overlay", on),
  onState: (fn) => ipcRenderer.on("state", (_e, s) => fn(s)),
  onCommand: (fn) => ipcRenderer.on("command", (_e, c) => fn(c)),
  platform: process.platform,
});
