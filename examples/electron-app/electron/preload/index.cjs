const { contextBridge, ipcRenderer } = require("electron");

// Sandboxed preload scripts cannot require arbitrary project modules unless
// they are bundled. This runnable fixture keeps the literal small and protects
// its shared contract with both a unit assertion and the real Electron E2E.
const NOTES_LIST_CHANNEL = "notes:list";

contextBridge.exposeInMainWorld("desktopNotes", {
  list: (request) => ipcRenderer.invoke(NOTES_LIST_CHANNEL, request),
});
