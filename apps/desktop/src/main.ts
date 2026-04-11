import "./bundledBinPaths";
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import { BASIS_ROOT } from "@context-manager/config";
import { setupIpc, setMainWindow } from "./ipcHandlers";
import { clearExclusionsRequiresRestart, loadExclusions, stopHotBuffer } from "@context-manager/core";
import { initializeSckitExclusions } from "./sckitExclusions";

console.log("[Electron] Main process starting...");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// ── Background mode ──────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(BASIS_ROOT, "settings.json");

function readRunInBackground(): boolean {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { runInBackground?: boolean };
    return parsed.runInBackground === true;
  } catch {
    return false;
  }
}

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
    mainWindow!.show();
    mainWindow!.focus();
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting && readRunInBackground()) {
      event.preventDefault();
      mainWindow?.hide();
      ensureTray();
    }
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
  }
}

// ── System tray ──────────────────────────────────────────────────────────────

function ensureTray(): void {
  if (tray) return;

  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Basis — Running in background");

  const contextMenu = Menu.buildFromTemplate([
    { label: "Open Basis", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ── IPC for background mode toggle ───────────────────────────────────────────

ipcMain.handle("get-run-in-background", () => readRunInBackground());

ipcMain.handle("set-run-in-background", (_event, enabled: boolean) => {
  try {
    const current = (() => {
      try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); } catch { return {}; }
    })();
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ ...current, runInBackground: enabled }, null, 2) + "\n", "utf8");
  } catch {
    // Non-critical
  }
  return enabled;
});

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

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  stopHotBuffer();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (!readRunInBackground()) {
      app.quit();
    }
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
