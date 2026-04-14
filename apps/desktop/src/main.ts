import "./bundledBinPaths";
import { app, BrowserWindow } from "electron";
import * as path from "path";
import { setupIpc, setMainWindow } from "./ipcHandlers";
import { clearExclusionsRequiresRestart, loadExclusions, stopHotBuffer } from "@context-manager/core";
import { initializeSckitExclusions } from "./sckitExclusions";

console.log("[Electron] Main process starting...");

let mainWindow: BrowserWindow | null = null;

// ── Single instance lock ─────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("[Electron] Another instance is running. Exiting.");
  app.quit();
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Window creation ──────────────────────────────────────────────────────────

function createWindow(): void {
  const isDev = process.env.VITE_DEV_SERVER_URL != null;

  mainWindow = new BrowserWindow({
    width: 680,
    height: 560,
    show: true,
    center: true,
    // Match ui/styles.css --bg so the shell isn’t bright white before React paints.
    backgroundColor: "#2c1e14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  setMainWindow(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow!.show();
    mainWindow!.focus();
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
  }
}

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  const exclusions = loadExclusions();
  try {
    initializeSckitExclusions(exclusions);
    clearExclusionsRequiresRestart();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sckit] exclusion init failed: ${message}`);
  }
  setupIpc();
  createWindow();
});

app.on("will-quit", () => {
  stopHotBuffer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
    mainWindow?.focus();
  }
});
