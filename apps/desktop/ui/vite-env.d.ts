/// <reference types="vite/client" />

import type {
  AISettings,
  ChunkSettings,
  ContextScope,
  ExclusionsConfig,
  InstalledApp,
  ProcessingStatus,
  ScopeGrant,
  SckitExclusionsInitState,
} from "@context-manager/config";

interface ContextManagerAPI {
  startRecording: () => Promise<{ success: boolean; filePath: string }>;
  stopRecording: () => Promise<{ success: boolean }>;
  rotateRecording: () => Promise<{ filePath: string }>;
  processNow: () => Promise<{ started: boolean }>;
  sendRecordingChunk: (chunk: ArrayBuffer) => Promise<void>;
  getCurrentFile: () => Promise<string | null>;
  getUnprocessedFiles: () => Promise<string[]>;
  getProcessingStatus: () => Promise<ProcessingStatus>;
  onProcessingStatus: (callback: (status: ProcessingStatus) => void) => () => void;
  getChunkDurationMs: () => Promise<number>;
  getChunkSettings: () => Promise<ChunkSettings>;
  updateChunkSettings: (settings: Partial<ChunkSettings>) => Promise<ChunkSettings>;
  getExclusions: () => Promise<ExclusionsConfig>;
  updateExclusions: (settings: Partial<ExclusionsConfig>) => Promise<ExclusionsConfig>;
  scanInstalledApps: (opts?: { forceRefresh?: boolean }) => Promise<InstalledApp[]>;
  scanInstalledAppFromPath: (appPath: string) => Promise<InstalledApp | null>;
  getInitializedExclusionBundleIds: () => Promise<string[]>;
  getSckitExclusionsInitState: () => Promise<SckitExclusionsInitState>;
  restartApp: () => Promise<void>;
  getDesktopSources: (opts: { types: ("screen" | "window")[] }) => Promise<
    Array<{ id: string; name: string }>
  >;
  // MCP scope grants
  getLocalGrant: () => Promise<ScopeGrant | null>;
  setLocalScopes: (scopes: ContextScope[]) => Promise<ScopeGrant>;
  revokeLocalGrant: () => Promise<boolean>;
  getMcpServerPath: () => Promise<string>;
  // AI settings
  getAISettings: () => Promise<AISettings>;
  updateAISettings: (settings: Partial<AISettings>) => Promise<AISettings>;
  // Background mode
  getRunInBackground: () => Promise<boolean>;
  setRunInBackground: (enabled: boolean) => Promise<boolean>;
}

declare global {
  interface Window {
    contextManager: ContextManagerAPI;
  }
}

export {};
