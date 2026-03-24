/// <reference types="vite/client" />

interface ContextManagerAPI {
  startRecording: () => Promise<{ success: boolean; filePath: string }>;
  stopRecording: () => Promise<{ success: boolean }>;
  rotateRecording: () => Promise<{ filePath: string }>;
  sendRecordingChunk: (chunk: ArrayBuffer) => void;
  getCurrentFile: () => Promise<string | null>;
  getUnprocessedFiles: () => Promise<string[]>;
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
