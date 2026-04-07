import "./bundledBinPaths";
import { app, BrowserWindow } from "electron";
import * as path from "path";
import { setupIpc, setMainWindow } from "./ipc";

// Log to terminal so we can see main process is running
console.log("[Electron] Main process starting...");

function createWindow(): void {
  const isDev = process.env.VITE_DEV_SERVER_URL != null;

  const mainWindow = new BrowserWindow({
    width: 640,
    height: 480,
    show: true,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  setMainWindow(mainWindow);

  mainWindow.once("ready-to-show", () => {
    console.log("[Electron] Window ready, showing and focusing");
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, desc) => {
    console.error("[Electron] Failed to load:", code, desc);
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
  }
}

app.whenReady().then(() => {
  setupIpc();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
