const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("reslibDesktop", {
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke("reslib:version"),
  retry: () => ipcRenderer.invoke("reslib:retry"),
  pickFolder: () => ipcRenderer.invoke("reslib:pick-folder"),
  setReaderActive: (active) => ipcRenderer.send("reslib:reader-active", active === true),
  onReaderAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("reslib:reader-action", listener);
    return () => ipcRenderer.removeListener("reslib:reader-action", listener);
  },
  onReaderShortcutStatus: (callback) => {
    const listener = (_event, failed) => callback(failed);
    ipcRenderer.on("reslib:reader-shortcut-status", listener);
    return () => ipcRenderer.removeListener("reslib:reader-shortcut-status", listener);
  },
});
