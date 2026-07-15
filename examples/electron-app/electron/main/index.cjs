const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { NOTES_LIST_CHANNEL, isNotesListRequest } = require("../../src/shared/ipc.cjs");
const { windowOptions } = require("./window-options.cjs");

function registerNotesIpc() {
  ipcMain.removeHandler(NOTES_LIST_CHANNEL);
  ipcMain.handle(NOTES_LIST_CHANNEL, (_event, request) => {
    if (!isNotesListRequest(request)) throw new Error("invalid notes:list request");
    return [{ id: "welcome", title: `Inbox note (${request.workspaceId})` }];
  });
}

function createMainWindow() {
  const window = new BrowserWindow(windowOptions());
  void window.loadFile(path.join(__dirname, "../../src/renderer/index.html"));
  return window;
}

app.whenReady().then(() => {
  registerNotesIpc();
  createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

module.exports = { createMainWindow, registerNotesIpc };
