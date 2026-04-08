import {
  getUnprocessedFiles,
  getCurrentFile,
  processBacklog,
  readAISettings,
} from "@context-manager/core";
import type { ProcessBacklogProgress, ProcessingTrigger, ProcessingStatus } from "@context-manager/config";
import { sendToRenderer } from "./mainWindowRef";
import { startIdleMonitor } from "./idle";

export const processingState: ProcessingStatus = {
  isProcessing: false,
  currentChunk: 0,
  totalChunks: 0,
  pendingChunks: 0,
  visiblePendingChunks: 0,
  activeRecordingChunk: false,
  trigger: null,
};

let stopIdleMonitor: (() => void) | null = null;

export function countPendingChunks(): number {
  return getUnprocessedFiles().length;
}

export function getActiveRecordingChunk(): boolean {
  return getCurrentFile() !== null;
}

export function countVisiblePendingChunks(): number {
  return countPendingChunks() + (getActiveRecordingChunk() ? 1 : 0);
}

export function emitProcessingStatus(): void {
  processingState.pendingChunks = countPendingChunks();
  processingState.visiblePendingChunks = countVisiblePendingChunks();
  processingState.activeRecordingChunk = getActiveRecordingChunk();
  sendToRenderer("processing-status", { ...processingState });
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

export async function runBacklog(trigger: ProcessingTrigger, shouldContinue: () => boolean): Promise<boolean> {
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

export function maybeStartLiveProcessing(): void {
  const aiSettings = readAISettings();
  if (aiSettings.provider !== "fireworks" || processingState.isProcessing || countPendingChunks() === 0) {
    return;
  }

  void runBacklog("live", () => true).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[processing] live backlog failed: ${message}`);
  });
}

export function setupIdleProcessing(): void {
  if (stopIdleMonitor) {
    return;
  }
  stopIdleMonitor = startIdleMonitor({
    hasUnprocessedFiles: () => countPendingChunks() > 0,
    isProcessing: () => processingState.isProcessing,
    processWhileIdle: async (shouldContinue) => {
      await runBacklog("idle", shouldContinue);
    },
  });
}

export function teardownIdleProcessing(): void {
  if (stopIdleMonitor) {
    stopIdleMonitor();
    stopIdleMonitor = null;
  }
}
