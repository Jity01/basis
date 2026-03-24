import { ipcMain, desktopCapturer } from "electron";
import * as fs from "fs";
import type { BrowserWindow } from "electron";
import {
  ensureTmpDir,
  getNextRecordingPath,
  getUnprocessedFiles,
  getCurrentFile,
  setCurrentFile,
  CHUNK_DURATION_MS,
} from "@context-manager/core";

let mainWindow: BrowserWindow | null = null;
let writeStream: fs.WriteStream | null = null;

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

function closeCurrentFile(): void {
  if (writeStream) {
    writeStream.end();
    writeStream = null;
  }
  setCurrentFile(null);
}

function openNewFile(): string {
  closeCurrentFile();
  ensureTmpDir();
  const filePath = getNextRecordingPath();
  writeStream = fs.createWriteStream(filePath);
  setCurrentFile(filePath);
  return filePath;
}

export function setupIpc(): void {
  ipcMain.handle("start-recording", async () => {
    const filePath = openNewFile();
    return { success: true, filePath };
  });

  ipcMain.on("recording-chunk", (_event, chunk: Buffer) => {
    if (writeStream) {
      writeStream.write(chunk);
    }
  });

  ipcMain.handle("rotate-recording", async () => {
    closeCurrentFile();
    const filePath = openNewFile();
    return { filePath };
  });

  ipcMain.handle("stop-recording", async () => {
    closeCurrentFile();
    return { success: true };
  });

  ipcMain.handle("get-current-file", () => {
    return getCurrentFile();
  });

  ipcMain.handle("get-unprocessed-files", () => {
    return getUnprocessedFiles();
  });

  ipcMain.handle("get-chunk-duration-ms", () => {
    return CHUNK_DURATION_MS;
  });

  ipcMain.handle(
    "get-desktop-sources",
    (_event, opts: { types: ("screen" | "window")[] }) =>
      desktopCapturer.getSources(opts)
  );
}
