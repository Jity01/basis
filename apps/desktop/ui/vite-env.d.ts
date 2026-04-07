/// <reference types="vite/client" />

interface TailscalePeer {
  hostname: string;
  tailscaleIp: string;
  os: string;
  online: boolean;
}

interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  hostname: string | null;
  tailscaleIp: string | null;
  peers: TailscalePeer[];
}

interface ContextManagerAPI {
  startRecording: () => Promise<{ success: boolean; filePath: string }>;
  stopRecording: () => Promise<{ success: boolean }>;
  rotateRecording: () => Promise<{ filePath: string }>;
  processNow: () => Promise<{ started: boolean }>;
  sendRecordingChunk: (chunk: ArrayBuffer) => Promise<void>;
  getCurrentFile: () => Promise<string | null>;
  getUnprocessedFiles: () => Promise<string[]>;
  getProcessingStatus: () => Promise<{
    isProcessing: boolean;
    currentChunk: number;
    totalChunks: number;
    pendingChunks: number;
    visiblePendingChunks: number;
    activeRecordingChunk: boolean;
    trigger: "idle" | "manual" | "live" | null;
  }>;
  onProcessingStatus: (callback: (status: {
    isProcessing: boolean;
    currentChunk: number;
    totalChunks: number;
    pendingChunks: number;
    visiblePendingChunks: number;
    activeRecordingChunk: boolean;
    trigger: "idle" | "manual" | "live" | null;
  }) => void) => () => void;
  getChunkDurationMs: () => Promise<number>;
  getChunkSettings: () => Promise<{
    chunkDurationMinutes: number;
  }>;
  updateChunkSettings: (settings: {
    chunkDurationMinutes?: number;
  }) => Promise<{
    chunkDurationMinutes: number;
  }>;
  getDesktopSources: (opts: { types: ("screen" | "window")[] }) => Promise<
    Array<{ id: string; name: string }>
  >;
  getAISettings: () => Promise<{
    provider: "fireworks" | "local";
    localBaseUrl: string;
    localTaggingModel: string;
    fireworksApiKey?: string;
  }>;
  updateAISettings: (settings: {
    provider?: "fireworks" | "local";
    localBaseUrl?: string;
    localTaggingModel?: string;
    fireworksApiKey?: string;
  }) => Promise<{
    provider: "fireworks" | "local";
    localBaseUrl: string;
    localTaggingModel: string;
    fireworksApiKey?: string;
  }>;
  getTailscaleStatus: () => Promise<TailscaleStatus>;
  onTailscaleStatus: (callback: (status: TailscaleStatus) => void) => () => void;
}

declare global {
  interface Window {
    contextManager: ContextManagerAPI;
  }
}

export {};
