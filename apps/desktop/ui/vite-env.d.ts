/// <reference types="vite/client" />

interface ContextManagerAPI {
  startRecording: () => Promise<{ success: boolean; filePath: string }>;
  stopRecording: () => Promise<{ success: boolean }>;
  rotateRecording: () => Promise<{ filePath: string }>;
  processNow: () => Promise<{ started: boolean }>;
  sendRecordingChunk: (chunk: ArrayBuffer) => void;
  getCurrentFile: () => Promise<string | null>;
  getUnprocessedFiles: () => Promise<string[]>;
  getProcessingStatus: () => Promise<{
    isProcessing: boolean;
    currentChunk: number;
    totalChunks: number;
    pendingChunks: number;
    trigger: "idle" | "manual" | null;
  }>;
  onProcessingStatus: (callback: (status: {
    isProcessing: boolean;
    currentChunk: number;
    totalChunks: number;
    pendingChunks: number;
    trigger: "idle" | "manual" | null;
  }) => void) => () => void;
  getChunkDurationMs: () => Promise<number>;
  getDesktopSources: (opts: { types: ("screen" | "window")[] }) => Promise<
    Array<{ id: string; name: string }>
  >;
}

declare global {
  interface Window {
    contextManager: ContextManagerAPI;
  }
}

export {};
