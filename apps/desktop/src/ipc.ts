import { app, ipcMain, desktopCapturer } from "electron";
import * as fs from "fs";
import type { BrowserWindow } from "electron";
import * as path from "path";
import {
  ensureTmpDir,
  getNextRecordingPath,
  getUnprocessedFiles,
  getCurrentFile,
  setCurrentFile,
  getChunkDurationMs,
  processBacklog,
  type ProcessBacklogProgress,
  readAISettings,
  writeAISettings,
  type AISettings,
  readChunkSettings,
  writeChunkSettings,
  writeChunkDurationMsForFile,
  type ChunkSettings,
  startHotBuffer,
  stopHotBuffer,
} from "@context-manager/core";
import { startIdleMonitor } from "./idle";
import { getTailscaleStatus, startTailscaleMonitor } from "./tailscale";
import { CONTEXT_ROOT, HOT_BUFFER_CONFIG, hotBufferDir } from "@context-manager/config";


function resolveOcrBinaryPath(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "ocr-bin", "ocr-helper");
  }
  return path.join(__dirname, "..", "resources", "ocr-bin", "ocr-helper");
}

let mainWindow: BrowserWindow | null = null;
let writeStream: fs.WriteStream | null = null;
let pendingWriteChain: Promise<void> = Promise.resolve();
let stopIdleMonitor: (() => void) | null = null;
let stopTailscaleMonitor: (() => void) | null = null;
let activeRecordingChunkDurationMs: number | null = null;

type AISettingsUpdate = Partial<AISettings>;
type ChunkSettingsUpdate = Partial<ChunkSettings>;

type ProcessingTrigger = "idle" | "manual" | "live" | null;
type ProcessingStatus = {
  isProcessing: boolean;
  currentChunk: number;
  totalChunks: number;
  pendingChunks: number;
  visiblePendingChunks: number;
  activeRecordingChunk: boolean;
  trigger: ProcessingTrigger;
};

const processingState: ProcessingStatus = {
  isProcessing: false,
  currentChunk: 0,
  totalChunks: 0,
  pendingChunks: 0,
  visiblePendingChunks: 0,
  activeRecordingChunk: false,
  trigger: null,
};

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

function countPendingChunks(): number {
  return getUnprocessedFiles().length;
}

function getActiveRecordingChunk(): boolean {
  return getCurrentFile() !== null;
}

function countVisiblePendingChunks(): number {
  return countPendingChunks() + (getActiveRecordingChunk() ? 1 : 0);
}

function emitProcessingStatus(): void {
  processingState.pendingChunks = countPendingChunks();
  processingState.visiblePendingChunks = countVisiblePendingChunks();
  processingState.activeRecordingChunk = getActiveRecordingChunk();
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
    const aiSettings = readAISettings();
    await processBacklog(getCurrentFile, shouldContinue, {
      onProgress: (progress) => {
        updateProgress(progress);
      },
      aiSettings,
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

function maybeStartLiveProcessing(): void {
  const aiSettings = readAISettings();
  if (aiSettings.provider !== "fireworks" || processingState.isProcessing || countPendingChunks() === 0) {
    return;
  }

  void runBacklog("live", () => true).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[processing] live backlog failed: ${message}`);
  });
}

function waitForStreamFinish(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      stream.removeListener("finish", onFinish);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onFinish = () => {
      settle(resolve);
    };

    const onClose = () => {
      settle(resolve);
    };

    const onError = (err: Error) => {
      settle(() => reject(err));
    };

    stream.once("finish", onFinish);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

function writeChunkToStream(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    return Promise.reject(new Error("Recording file is already closing"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let callbackDone = false;
    let drainDone = false;
    let needsDrain = false;

    const cleanup = () => {
      stream.removeListener("error", onError);
      stream.removeListener("drain", onDrain);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const maybeResolve = () => {
      if (!callbackDone) return;
      if (!needsDrain || drainDone) {
        settle(resolve);
      }
    };

    const onError = (err: Error) => {
      settle(() => reject(err));
    };

    const onDrain = () => {
      drainDone = true;
      maybeResolve();
    };

    stream.once("error", onError);
    needsDrain = !stream.write(chunk, (err?: Error | null) => {
      if (err) {
        settle(() => reject(err));
        return;
      }
      callbackDone = true;
      maybeResolve();
    });

    if (needsDrain) {
      stream.once("drain", onDrain);
      return;
    }

    drainDone = true;
  });
}

function enqueueChunkWrite(chunk: Buffer): Promise<void> {
  const priorWrites = pendingWriteChain.catch(() => {});
  const nextWrite = priorWrites.then(() => {
    if (!writeStream) {
      throw new Error("No active recording file");
    }
    return writeChunkToStream(writeStream, chunk);
  });
  pendingWriteChain = nextWrite;
  return nextWrite;
}

async function closeCurrentFile(): Promise<void> {
  const stream = writeStream;
  await pendingWriteChain.catch(() => {});
  if (!stream) {
    setCurrentFile(null);
    emitProcessingStatus();
    return;
  }

  writeStream = null;
  stream.end();
  await waitForStreamFinish(stream);
  setCurrentFile(null);
  emitProcessingStatus();
}

async function openNewFile(chunkDurationMs: number): Promise<string> {
  await closeCurrentFile();
  ensureTmpDir();
  const filePath = getNextRecordingPath();
  writeChunkDurationMsForFile(filePath, chunkDurationMs);
  writeStream = fs.createWriteStream(filePath);
  pendingWriteChain = Promise.resolve();
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
  app.once("before-quit", () => {
    stopHotBuffer();
    if (stopTailscaleMonitor) {
      stopTailscaleMonitor();
      stopTailscaleMonitor = null;
    }
  });

  if (!stopTailscaleMonitor) {
    stopTailscaleMonitor = startTailscaleMonitor((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("tailscale-status", status);
      }
    });
  }

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
    const chunkDurationMs = getChunkDurationMs();
    activeRecordingChunkDurationMs = chunkDurationMs;
    const filePath = await openNewFile(chunkDurationMs);
    startHotBuffer({
      captureIntervalMs: HOT_BUFFER_CONFIG.captureIntervalMs,
      maxAgeMs: HOT_BUFFER_CONFIG.maxAgeMs,
      purgeIntervalMs: HOT_BUFFER_CONFIG.purgeIntervalMs,
      resolution: { ...HOT_BUFFER_CONFIG.resolution },
      jpegQuality: HOT_BUFFER_CONFIG.jpegQuality,
      hotbufferDir: hotBufferDir(CONTEXT_ROOT),
      ocrBinaryPath: resolveOcrBinaryPath(),
    });
    return { success: true, filePath };
  });

  ipcMain.handle("recording-chunk", async (_event, chunkPayload: unknown) => {
    const chunk = coerceChunkToBuffer(chunkPayload);
    if (!chunk) {
      throw new Error("Invalid recording chunk payload");
    }
    await enqueueChunkWrite(chunk);
  });

  ipcMain.handle("rotate-recording", async () => {
    const filePath = await openNewFile(activeRecordingChunkDurationMs ?? getChunkDurationMs());
    maybeStartLiveProcessing();
    emitProcessingStatus();
    return { filePath };
  });

  ipcMain.handle("stop-recording", async () => {
    activeRecordingChunkDurationMs = null;
    stopHotBuffer();
    await closeCurrentFile();
    maybeStartLiveProcessing();
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
    processingState.visiblePendingChunks = countVisiblePendingChunks();
    processingState.activeRecordingChunk = getActiveRecordingChunk();
    return { ...processingState };
  });

  ipcMain.handle("process-now", async () => {
    const started = await runBacklog("manual", () => true);
    return { started };
  });

  ipcMain.handle("get-chunk-duration-ms", () => {
    return getChunkDurationMs();
  });

  ipcMain.handle("get-chunk-settings", () => {
    return readChunkSettings();
  });

  ipcMain.handle("update-chunk-settings", (_event, payload: ChunkSettingsUpdate) => {
    return writeChunkSettings(payload || {});
  });

  ipcMain.handle(
    "get-desktop-sources",
    (_event, opts: { types: ("screen" | "window")[] }) =>
      desktopCapturer.getSources(opts)
  );

  ipcMain.handle("get-ai-settings", () => {
    return readAISettings();
  });

  ipcMain.handle("update-ai-settings", (_event, payload: AISettingsUpdate) => {
    return writeAISettings(payload || {});
  });

  ipcMain.handle("get-tailscale-status", () => {
    return getTailscaleStatus();
  });
}
