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
  processBacklog,
  type ProcessBacklogProgress,
} from "@context-manager/core";
import { startIdleMonitor } from "./idle";

let mainWindow: BrowserWindow | null = null;
let writeStream: fs.WriteStream | null = null;
let stopIdleMonitor: (() => void) | null = null;

type ProcessingTrigger = "idle" | "manual" | null;
type ProcessingStatus = {
  isProcessing: boolean;
  currentChunk: number;
  totalChunks: number;
  pendingChunks: number;
  trigger: ProcessingTrigger;
};

const processingState: ProcessingStatus = {
  isProcessing: false,
  currentChunk: 0,
  totalChunks: 0,
  pendingChunks: 0,
  trigger: null,
};

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

function countPendingChunks(): number {
  return getUnprocessedFiles().length;
}

function emitProcessingStatus(): void {
  processingState.pendingChunks = countPendingChunks();
  if (mainWindow) {
    mainWindow.webContents.send("processing-status", { ...processingState });
  }
}

function updateProgress(progress: ProcessBacklogProgress): void {
  switch (progress.phase) {
    case "start":
      processingState.currentChunk = 0;
      processingState.totalChunks = progress.total;
      break;
    case "chunk-start":
      processingState.currentChunk = progress.completed + 1;
      processingState.totalChunks = progress.total;
      break;
    case "chunk-complete":
      processingState.currentChunk = progress.completed;
      processingState.totalChunks = progress.total;
      break;
    case "paused":
    case "done":
      processingState.currentChunk = progress.completed;
      processingState.totalChunks = progress.total;
      break;
  }
  emitProcessingStatus();
}

async function runBacklog(trigger: ProcessingTrigger, shouldContinue: () => boolean): Promise<boolean> {
  if (processingState.isProcessing) {
    return false;
  }

  const pending = countPendingChunks();
  if (pending === 0) {
    processingState.currentChunk = 0;
    processingState.totalChunks = 0;
    processingState.trigger = null;
    emitProcessingStatus();
    return false;
  }

  processingState.isProcessing = true;
  processingState.trigger = trigger;
  processingState.currentChunk = 0;
  processingState.totalChunks = pending;
  emitProcessingStatus();

  try {
    await processBacklog(getCurrentFile, shouldContinue, {
      onProgress: (progress) => {
        updateProgress(progress);
      },
    });
  } finally {
    processingState.isProcessing = false;
    processingState.trigger = null;
    processingState.currentChunk = 0;
    processingState.totalChunks = 0;
    emitProcessingStatus();
  }

  return true;
}

function closeCurrentFile(): void {
  if (writeStream) {
    writeStream.end();
    writeStream = null;
  }
  setCurrentFile(null);
  emitProcessingStatus();
}

function openNewFile(): string {
  closeCurrentFile();
  ensureTmpDir();
  const filePath = getNextRecordingPath();
  writeStream = fs.createWriteStream(filePath);
  setCurrentFile(filePath);
  emitProcessingStatus();
  return filePath;
}

function coerceChunkToBuffer(input: unknown): Buffer | null {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(input));
  }
  return null;
}

export function setupIpc(): void {
  if (!stopIdleMonitor) {
    stopIdleMonitor = startIdleMonitor({
      hasUnprocessedFiles: () => countPendingChunks() > 0,
      isProcessing: () => processingState.isProcessing,
      processWhileIdle: async (shouldContinue) => {
        await runBacklog("idle", shouldContinue);
      },
    });
  }

  ipcMain.handle("start-recording", async () => {
    const filePath = openNewFile();
    return { success: true, filePath };
  });

  ipcMain.on("recording-chunk", (_event, chunkPayload: unknown) => {
    const chunk = coerceChunkToBuffer(chunkPayload);
    if (!chunk || !writeStream) {
      return;
    }
    writeStream.write(chunk);
  });

  ipcMain.handle("rotate-recording", async () => {
    const filePath = openNewFile();
    emitProcessingStatus();
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

  ipcMain.handle("get-processing-status", () => {
    processingState.pendingChunks = countPendingChunks();
    return { ...processingState };
  });

  ipcMain.handle("process-now", async () => {
    const started = await runBacklog("manual", () => true);
    return { started };
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